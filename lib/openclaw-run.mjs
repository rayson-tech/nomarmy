import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveExecutable } from "./process.mjs";
import { readOpenClawTranscriptTail } from "./transcript.mjs";
import { loadConfig } from "./config.mjs";
import { resolveSandboxImage, sandboxPathEntries, SANDBOX_NPM_ENV } from "./sandbox-images.mjs";
import { DEFAULT_AGENT_IMAGE } from "./verify.mjs";
import { scoutPrompt, isScoutReportUnusable } from "./scout.mjs";
import { decomposePrompt } from "./decompose.mjs";
import { workerPrompt } from "./worker-prompt.mjs";
import { deriveBudgets } from "./budget.mjs";
import { entryContextPerNom } from "./dispatch-config.mjs";
import { readClaudeSessionUsage } from "./claude-transcript.mjs";
import { modelRejection, modelRejectionLine } from "./openclaw-errors.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A real, confirmed incident (worker-20260922-045250-c6d147): the worker ran
// an unscoped `pytest -q`, which OpenClaw could not finish inline and handed
// back as a backgrounded process ("Command still running (session ...,
// pid ...). Use process (list/poll/log/write/send-key)"). The worker made two
// more quick, unrelated tool calls afterward -- never polling, waiting on, or
// killing that process -- and then the transcript went completely silent for
// the rest of the job: no further tool calls, no further thinking, nothing,
// until nomArmy's own hard deadline killed the run 16+ minutes later. This is
// a different failure shape from idle-diff: the worktree was never the
// signal (there was nothing left to change), the AGENT'S OWN SESSION stalled
// after handing off a process it then abandoned. Unlike idle-diff, which can
// fire on any generic pause, this only arms once the transcript's own last
// known state is that specific hand-off -- a worker legitimately waiting out
// a slow FOREGROUND command never produces this text at all, so it cannot be
// mistaken for one.
const BACKGROUND_PROCESS_RE = /Command still running \(session [\w-]+, pid \d+\)/i;
export function makeAbandonedBackgroundProcessTick(stateDir, { idleMs, minElapsedMs }) {
  let lastEventCount = -1, stillSinceMs = 0, sawAbandonedBackground = false;
  return async elapsedMs => {
    let transcript;
    // Only the count and the latest events matter here: a full parse every
    // tick froze the server (see readOpenClawTranscriptTail).
    try { transcript = await readOpenClawTranscriptTail(stateDir, { limit: 5 }); }
    catch { return { stop: false }; } // a broken read must never itself kill the run
    if (!transcript.available) return { stop: false };
    if (transcript.events !== lastEventCount) {
      lastEventCount = transcript.events;
      stillSinceMs = elapsedMs;
      sawAbandonedBackground = BACKGROUND_PROCESS_RE.test(transcript.lastToolResultText ?? "");
      return { stop: false };
    }
    if (!sawAbandonedBackground || elapsedMs < minElapsedMs) return { stop: false };
    const stillForMs = elapsedMs - stillSinceMs;
    if (stillForMs < idleMs) return { stop: false };
    return { stop: true, reason: "idle_background_process",
      detail: `worker started a backgrounded process and produced no further activity for ${Math.round(stillForMs / 1000)}s` };
  };
}

// Runs each tick in order and stops at the first one asking to stop, so
/**
 * Every tick, write what the worker is doing into status.json: the last
 * tool call and files changed so far (liveProgress), and when. Never asks
 * to stop; a failed read just skips that beat.
 */
export function makeHeartbeatTick(jobDir, liveProgress) {
  // Never two beats at once: a slow beat used to overlap the next.
  let busy = false;
  return async (elapsedMs) => {
    if (busy) return { stop: false };
    busy = true;
    try {
      const live = await liveProgress(jobDir);
      writeStatus(jobDir, { heartbeatAt: new Date().toISOString(), workerElapsedSeconds: Math.round(elapsedMs / 1000), ...live });
    } catch { /* skip this beat */ } finally { busy = false; }
    return { stop: false };
  };
}

// runOpenClaw's single onTick slot can watch the worktree (idle-diff) and the
// transcript (abandoned background process) at once without either watcher
// knowing the other exists.
export function combineTicks(ticks) {
  const fns = ticks.filter(Boolean);
  if (fns.length === 0) return null;
  if (fns.length === 1) return fns[0];
  return async elapsedMs => {
    for (const fn of fns) {
      const verdict = await fn(elapsedMs);
      if (verdict?.stop) return verdict;
    }
    return { stop: false };
  };
}
// A real, confirmed incident: config/providers.yml's grok entry carried
// `thinking: true` (correct for grok-4.6) unchanged across a `providers
// update --model grok-4.7`, and OpenClaw rejects grok-4.7 outright for any
// thinking level except "off" -- exit 1, zero model calls, before the
// scout/implement distinction even matters (both modes hit this identically;
// it only LOOKED scout-specific because the implement job that had
// succeeded predated the model swap to 4.7). OpenClaw's own model catalog
// carries no per-model thinking-support field to check this against in
// advance (verified live: grok-4.7 isn't in the catalog at all yet), so
// this is necessarily reactive -- parse OpenClaw's own error, which already
// names the one level it does accept, and retry once with that instead of
// failing a job an operator has no way to have predicted.
// The model group is non-greedy up to the literal ". Use one of:", not a
// [^.]-excluding class -- a real model id (xai/grok-4.7) contains its own
// period, which a naive [^.\n]+ can never match past, so the whole pattern
// silently never matched a real model name at all (caught by a test using
// the exact real captured error, not a synthesized one).
const UNSUPPORTED_THINKING_RE = /Thinking level "([^"]*)" is not supported for (.+?)\.\s*Use one of:\s*([^.\n]+)\./i;
export function parseUnsupportedThinkingError(errorMessage) {
  const match = UNSUPPORTED_THINKING_RE.exec(String(errorMessage ?? ""));
  if (!match) return null;
  const supported = match[3].split(",").map((s) => s.trim()).filter(Boolean);
  if (supported.length === 0) return null;
  return { requested: match[1], model: match[2].trim(), supported };
}

// A real, confirmed incident: OpenClaw's OWN internal per-turn watchdog can
// fire before nomArmy's outer run() deadline does (nomArmy's own timer waits
// timeoutSeconds+30s specifically to give OpenClaw's shorter internal one
// room to fire first and report cleanly) -- when it does, OpenClaw prints a
// well-formed {"ok":false,"status":"timeout",...} envelope to stdout and
// THEN exits nonzero anyway. run() treats any nonzero exit as an opaque
// crash, so this genuinely graceful, self-identified timeout was being
// mislabeled workerFailed instead of workerTimedOut -- which meant a report-
// recovery attempt never even got a chance to run for the one case (a
// worker that ran out of room, but has valid session state worth resuming)
// it exists for. Checked against the real captured envelope from that
// incident, not a synthesized shape.
export function parseOpenClawInternalTimeout(stdout) {
  let parsed;
  try { parsed = JSON.parse(stdout); } catch { return false; }
  return parsed?.ok === false && (parsed?.status === "timeout" || parsed?.error?.kind === "timeout");
}

/**
 * A run whose work finished but whose exit failed: OpenClaw logged the run
 * ending normally (stopReason=stop) and then errored, e.g. "Codex one-shot
 * client cleanup could not be confirmed" -- seen live on a Senti scout,
 * whose complete report was discarded as WORKER_FAILED. When the run's
 * transcript holds a final assistant message, that is the report. Only for
 * a normal stop: a timeout, abort or crash mid-run is never salvaged.
 */
export async function salvageFinishedRun(error, stateDir, { sinceEvent = 0 } = {}) {
  const stderr = String(error?.stderr ?? "");
  if (!/ended with stopReason=stop\b/.test(stderr)) return null;
  let transcript;
  // Only what THIS call wrote. A report-recovery call resumes the same
  // session, and salvaging the whole transcript's last assistant message
  // picked a stale mid-run message from the earlier work phase (a real
  // Senti job), which then parsed as no report at all.
  try { transcript = await readOpenClawTranscriptTail(stateDir, { sinceEvent }); } catch { return null; }
  const final = transcript?.available ? String(transcript.lastAssistantText ?? "").trim() : "";
  if (!final) return null;
  const why = /cleanup/i.test(stderr) ? "OpenClaw's cleanup failed after the run" : "a nonzero exit after the run";
  // The envelope that carried usage never arrived; the transcript's
  // assistant messages still record it (a Codex job's one terminal message,
  // or every call of a multi-call run).
  return { ok: true, status: "ok", final, salvaged: true, salvagedFrom: why, usage: transcript.usage ?? null, toolSummary: null };
}

// OpenClaw names each job's sandbox container after the hash of its skills
// workspace, which it records under the state directory, and nothing stops the
// container when `agent exec` returns: one leaked per job, observed on every
// failed run. Match on that hash so only this job's container is touched.
// Best-effort: a missing podman or an already-gone container is not an error.
export function sandboxHashesFromState(stateDir) {
  const root = path.join(stateDir, "sandbox", "skills-workspaces");
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter(d => d.isDirectory() && /^workspace-[0-9a-f]{16,}$/.test(d.name))
      .map(d => d.name.replace(/^workspace-/, ""));
  } catch { return []; }
}
export function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
export function writeStatus(jobDir, patch) {
  const file = path.join(jobDir, "status.json");
  const prev = readJson(file) ?? {};
  fs.writeFileSync(file, JSON.stringify({ ...prev, ...patch, updatedAt: new Date().toISOString() }, null, 2));
}

// The same already-diagnosed, transient crun/devpts race (see
// WORKER_START_STAGGER_MS above) surfaced again even with the stagger
// active. Detected by message pattern (OpenClaw's own error carries
// `errorName=SandboxProvisioningError` and/or the raw crun message) and
// retried a bounded number of times with a short backoff -- this failure
// mode is a container never starting, observed to fail within seconds
// with zero work attempted, so retrying the whole call is safe and cheap
// relative to a 600s job timeout. Never retries anything else: a worker
// that started and then failed on its own is a real result, not a race.
const SANDBOX_PROVISIONING_RETRY_PATTERN = /SandboxProvisioningError|crun:\s*mount\s*`?devpts`?/i;
const MAX_SANDBOX_PROVISIONING_RETRIES = 2;
const SANDBOX_PROVISIONING_RETRY_DELAY_MS = 2000;

// A DIFFERENT failure shape from the sandbox-provisioning race above:
// verified live against a real xai/grok-4.6 job (worker-20260921-122021-
// eb7f67), OpenClaw can absorb a dropped connection mid-stream internally
// -- no thrown error the try/catch around runOpenClaw's call would ever
// see, no nonzero exit -- and still produce a perfectly VALID STATUS:
// blocked report, because the interrupted turn had no tool result left to
// finish the task from. That job's own stderr showed the model's prior 14
// calls all completing normally (200, sub-second each), then one call
// erroring with no HTTP status or error code at all
// (`message=Request was aborted`) -- the signature of a dropped/reset
// connection mid-stream, not a documented provider error, not a genuine
// content/logic failure. Real money was billed for the aborted call's own
// tokens ($0.27, zero files touched). withSandboxProvisioningRetry can't
// catch this at all, since nothing threw -- this pattern is checked
// separately, against the job's own stderr log, after a report comes back
// syntactically valid but says STATUS: blocked (see executeImplement).
// Narrowly scoped to the one pattern actually observed, the same
// "diagnosed-transient case only" discipline SANDBOX_PROVISIONING_RETRY_PATTERN
// already uses -- broadens only as more real failure modes are actually seen.
const TRANSIENT_INFERENCE_ABORT_PATTERN = /\[responses\]\s*error[^\n]*\bmessage=Request was aborted\b/i;
// Retrying a full work call is far more expensive than retrying a quick
// sandbox-provisioning check (a whole task attempt, not a container start)
// -- capped at exactly one retry by construction (executeImplement's own
// single `if`, not a loop), not MAX_SANDBOX_PROVISIONING_RETRIES's two.
//
// Below this much remaining budget, a retry attempt would likely just be
// cut off again by the job's own timeout -- skip it and accept the
// original blocked outcome rather than spend more without a real chance to
// finish.
const MIN_TRANSIENT_INFERENCE_RETRY_SECONDS = 60;

/** True if `stderrText` shows the specific dropped-connection signature
 * TRANSIENT_INFERENCE_ABORT_PATTERN documents. Exported for direct,
 * dependency-free testing. */
export function looksLikeTransientInferenceAbort(stderrText) {
  return TRANSIENT_INFERENCE_ABORT_PATTERN.test(stderrText || "");
}

/**
 * The full retry decision, as pure logic separate from executeImplement's
 * actual side effects (the retried runOpenClaw call, the log write) --
 * exported so this decision is directly testable without needing to mock
 * the whole worker-dispatch flow. True only when ALL of: the worker
 * process itself didn't fail (a genuine crash/timeout is a different,
 * already-handled case), the report it produced is syntactically valid
 * (an invalid/missing report is the existing report-RECOVERY path's job,
 * not this one's), STATUS is specifically "blocked" (not partial or done
 * -- this never second-guesses a report that already claims success or
 * partial progress), this exact call's own stderr shows the transient
 * dropped-connection signature, and there's still enough of the job's own
 * timeout left for a retry to have a real chance to finish.
 */
export function shouldRetryTransientAbort({ workerFailed, reportValidation, stderrText, remainingSeconds }) {
  return !workerFailed
    && Boolean(reportValidation?.valid)
    && reportValidation?.fields?.STATUS === "blocked"
    && looksLikeTransientInferenceAbort(stderrText)
    && remainingSeconds >= MIN_TRANSIENT_INFERENCE_RETRY_SECONDS;
}

// executeImplement's report-recovery gets a call for free because implement
// pre-splits its timeout into a work budget plus a reserved report budget
// (deriveTimeBudget); executeScout spends its ENTIRE caller-given timeout on
// the one call, so there is nothing pre-reserved to spend on a follow-up.
// Gating on whatever time is actually left against the original deadline --
// the same "only worth it if there's a real chance to finish" idea
// MIN_TRANSIENT_INFERENCE_RETRY_SECONDS already uses -- means a scout that
// used its whole budget just skips recovery rather than running over. A
// scout that crashed outright (workerFailed && !workerTimedOut) is excluded
// for the same reason implement excludes it: an unknown-shape failure is not
// somewhere a resumable session can be assumed to exist.
const MIN_SCOUT_RECOVERY_SECONDS = 60;
export function shouldAttemptScoutRecovery({ workerFailed, workerTimedOut, report, remainingSeconds }) {
  return (!workerFailed || workerTimedOut)
    && isScoutReportUnusable(report)
    && remainingSeconds >= MIN_SCOUT_RECOVERY_SECONDS;
}

/**
 * Runs `fn`, retrying only on the diagnosed-transient crun/devpts sandbox
 * race (see WORKER_START_STAGGER_MS's comment), up to
 * MAX_SANDBOX_PROVISIONING_RETRIES times with linear backoff. Any other
 * error -- including a worker that started fine and then genuinely failed
 * -- propagates on the first attempt, unretried.
 */
export async function withSandboxProvisioningRetry(fn, { onRetry = () => {}, delayMs = SANDBOX_PROVISIONING_RETRY_DELAY_MS } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt > MAX_SANDBOX_PROVISIONING_RETRIES || !SANDBOX_PROVISIONING_RETRY_PATTERN.test(error.message)) throw error;
      onRetry(attempt, error);
      await sleep(delayMs * attempt);
    }
  }
}

/**
 * A copy of an OpenClaw config with memory search and the session-memory
 * hook off, for any run nomArmy starts (jobs, e2e.sh). OpenClaw's memory
 * search is on by default, indexes session transcripts (the worker's brief
 * and the code it read) and embeds them with OpenAI by default, borrowing
 * the Codex/ChatGPT sign-in when OpenClaw has no key of its own: a tester
 * caught an e2e.sh run on the local model sending its transcript to OpenAI.
 * A job needs no memory across sessions, and local must mean local.
 */
export function withJobPrivacy(config) {
  const out = structuredClone(config ?? {});
  out.memory = { ...(out.memory ?? {}), search: { ...(out.memory?.search ?? {}), enabled: false } };
  out.hooks ??= {};
  out.hooks.internal ??= {};
  out.hooks.internal.entries ??= {};
  out.hooks.internal.entries["session-memory"] = { ...(out.hooks.internal.entries["session-memory"] ?? {}), enabled: false };
  return out;
}

export function createOpenClawRunner(deps) {
  const { run, projectDir, budgetState, profileConfig, resolvePoolSelection,
    resolveSubscriptionSelection, withPoolEntrySlot, makeIdleDiffTick,
    makeHeartbeatTick, workerProvider, modelCatalog } = deps;

  let cachedAmbientOpenClawConfigPath;
  function ambientOpenClawConfigPath() {
    if (cachedAmbientOpenClawConfigPath === undefined) {
      // Same shim resolution run() uses for the real job dispatch below --
      // `execFileSync("openclaw", ...)` unresolved hits the identical
      // Windows .cmd-shim ENOENT/EINVAL problem documented at resolveExecutable.
      const exe = resolveExecutable("openclaw");
      try { cachedAmbientOpenClawConfigPath = execFileSync(exe.file, [...exe.prefixArgs, "config", "file"], { encoding: "utf8", timeout: 20000 }).trim(); }
      catch { cachedAmbientOpenClawConfigPath = null; }
    }
    return cachedAmbientOpenClawConfigPath;
  }

  // `openclaw agent exec` has no per-call --image/--sandbox flag (checked: not
  // in its --help), so a job whose target repo needs a non-default sandbox
  // image (Go/Rust/a Python repo with real dependencies -- see
  // lib/sandbox-images.mjs) had no way to get that image into the WORKER's own
  // tool calls; only nomArmy's own separate verification executor
  // (lib/verify.mjs) ever saw it. `agent exec --config <path>` runs against a
  // given config file "instead of the ambient config" (its own --help text),
  // which is the one per-call lever that does reach the sandbox OpenClaw
  // starts for that run. This clones the ambient config, points
  // agents.defaults.sandbox.docker.image at the resolved image, and adds
  // the matched harnesses' extra PATH entries -- verified live: OpenClaw's exec
  // tool does not inherit a sandbox image's own baked ENV PATH on its own (a
  // freshly built Go image's `go` resolved fine under a direct `podman exec`
  // but came back "not found" through `openclaw agent exec` until
  // tools.exec.pathPrepend carried those paths explicitly).
  //
  // The clone necessarily carries whatever the ambient config's `auth` section
  // holds, including a real credential on a cloud profile. That is not a new
  // exposure: the host-side OpenClaw process this function's caller spawns
  // already holds and uses that same credential from its one permanent copy
  // (see CLAUDE.md's Bedrock-credential note). This is a second copy at the
  // same trust level -- written 0600, under this job's own runtimeDir (never
  // bind-mounted into the sandbox, same as agentHome/stateDir), and deleted by
  // the caller immediately after the run. Every job gets one (never throws):
  // it always carries the privacy settings (memory search and the
  // session-memory hook off) and npm's sandbox settings, plus the sandbox
  // image and PATH additions when the repo needs a non-default image.
  function resolveWorkerSandboxOverride(cwd, runtimeDir, {
    // The operator's checkout's .nomarmy.yml, not the job worktree's (see
    // registerVerificationRunner's call): the sandbox image follows the same
    // contract verification does.
    loadConfigFn = () => loadConfig(projectDir),
    resolveSandboxImageFn = resolveSandboxImage,
    sandboxPathEntriesFn = sandboxPathEntries,
    ambientConfigPathFn = ambientOpenClawConfigPath,
    readAmbientConfig = (p) => JSON.parse(fs.readFileSync(p, "utf8")),
  } = {}) {
    let config = null;
    try {
      const loaded = loadConfigFn(cwd);
      config = loaded && loaded.found ? loaded.config : null;
    } catch { /* a broken .nomarmy.yml is verification's problem to report, not this one's */ }

    let image;
    try {
      image = resolveSandboxImageFn({ cwd, trustedDir: projectDir, explicitImage: process.env.NOMARMY_AGENT_IMAGE || null, defaultImage: DEFAULT_AGENT_IMAGE, config });
    } catch {
      // A lazy Go/Rust/Python image build failure here should not fail the
      // worker's turn -- it runs in the default image instead, same as before
      // this existed; independent verification is what surfaces the real gap.
      image = DEFAULT_AGENT_IMAGE;
    }

    // Every job gets its own config now, not only non-default images: the
    // privacy settings below apply to all of them. With no ambient config
    // (or one that doesn't parse), OpenClaw would run on its defaults, so
    // an empty base plus these settings is the same run with them applied.
    const ambientPath = ambientConfigPathFn();
    let ambient = {};
    if (ambientPath) { try { ambient = readAmbientConfig(ambientPath) ?? {}; } catch { ambient = {}; } }

    const overridden = withJobPrivacy(ambient);

    overridden.agents ??= {};
    overridden.agents.defaults ??= {};
    overridden.agents.defaults.sandbox ??= {};
    overridden.agents.defaults.sandbox.docker ??= {};
    if (image !== DEFAULT_AGENT_IMAGE) overridden.agents.defaults.sandbox.docker.image = image;
    // npm's cache and update check inside the sandbox, the same as nomArmy's
    // own verification runs: outside the worktree, and off.
    overridden.agents.defaults.sandbox.docker.env = { ...(overridden.agents.defaults.sandbox.docker.env ?? {}), ...SANDBOX_NPM_ENV };

    const pathPrepend = sandboxPathEntriesFn(cwd, config);
    if (pathPrepend.length) {
      overridden.tools ??= {};
      overridden.tools.exec ??= {};
      const existing = Array.isArray(overridden.tools.exec.pathPrepend) ? overridden.tools.exec.pathPrepend : [];
      overridden.tools.exec.pathPrepend = [...new Set([...pathPrepend, ...existing])];
    }

    const configPath = path.join(runtimeDir, "sandbox-override.openclaw.json");
    fs.writeFileSync(configPath, JSON.stringify(overridden), { mode: 0o600 });
    return configPath;
  }

  async function runOpenClaw({ task, acceptance, verification, mode, cwd, baseRef, baseSha, timeoutSeconds, runtimeDir, profile, reasoning, pool = null, subscriptionWorker = null, onBehalfOf = null, model = null, reportSize = null, jobDir, workerId, evidence = null, evidenceTool = null, overridePrompt = null, logSuffix = "", idleDiff = null }) {
    // `pool` (config/providers.yml) and `subscriptionWorker` (config/subscriptions.yml)
    // both override `profile` (the single global NOMARMY_WORKER_PROVIDER/MODEL
    // pair, which always carries its own default and so is never truly absent) --
    // omitting both is the exact pre-existing behavior, unchanged. jobSchema's
    // own .superRefine refuses a job that sets `pool` and `subscription_worker`
    // together, so at most one of those two ever reaches here.
    const selected = pool ? resolvePoolSelection(pool, reasoning, { model })
      : subscriptionWorker ? resolveSubscriptionSelection(subscriptionWorker, onBehalfOf, reasoning, { model })
      : profileConfig(profile, reasoning);
    // The specific entry is now known (weighted-random selection already
    // happened), so this job gets a PRECISE budget for that one entry's real
    // context window instead of the pool-wide conservative minimum admission
    // used -- generally more generous, since it's no longer worst-casing
    // across every entry in the pool. Falls back to the outer, local-derived
    // `budgets` for a `profile`-routed job (selected.entry is undefined) or a
    // llama-cpp pool entry with no local context resolved.
    const entryContext = selected.entry ? entryContextPerNom(selected.entry, { catalog: modelCatalog(), localContextPerNom: budgetState.contextInfo.contextPerNom }) : null;
    const jobBudgets = entryContext
      ? deriveBudgets({ ...entryContext, env: process.env, tier: selected.entry.provider === "llama-cpp" ? "local" : "frontier", reportSize: reportSize ?? "standard" })
      : budgetState.budgets;
    const agentHome = path.join(runtimeDir, "home");
    const npmCache = path.join(runtimeDir, "npm-cache");
    fs.mkdirSync(agentHome, { recursive: true }); fs.mkdirSync(npmCache, { recursive: true });
    const env = { ...process.env, OPENCLAW_LOCAL_WORKER_RUNTIME: runtimeDir, NOMARMY_AGENT_HOME: agentHome,
      NPM_CONFIG_CACHE: npmCache, npm_config_cache: npmCache, NPM_CONFIG_UPDATE_NOTIFIER: "false", npm_config_update_notifier: "false" };
    const prompt = overridePrompt ?? (mode === "scout"
      ? scoutPrompt({ question: task, mustCover: acceptance, baseRef, baseSha, workerId, limits: jobBudgets.scout, report: jobBudgets.report.scout, evidenceTool })
      : mode === "decompose"
      ? decomposePrompt({ objective: task, constraints: acceptance, baseRef, baseSha, workerId, limits: jobBudgets.decompose, report: jobBudgets.report.decompose, evidenceTool })
      : workerPrompt({ task, acceptance, verification, mode, baseRef, baseSha, workerId, evidence, report: jobBudgets.report.implement }));
    fs.writeFileSync(path.join(jobDir, `brief${logSuffix}.txt`), prompt + "\n");
    // --state-dir keeps OpenClaw's session state (its transcript database among
    // it) inside the job directory instead of a temp dir it deletes on exit.
    // Two reasons: on Windows that deletion hit EBUSY on a still-open sqlite
    // handle and turned a finished run into `ok:false` with an empty final; and
    // a retained transcript is what lets a lost report be recovered on review.
    // A report-recovery call (overridePrompt set) reuses this same directory on
    // purpose, so it resumes the run it is recovering rather than starting cold.
    const stateDir = path.join(runtimeDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const sandboxOverridePath = resolveWorkerSandboxOverride(cwd, runtimeDir);
    const buildArgs = (thinking) => ["agent", "exec", prompt, "--model", selected.model,
      "--cwd", cwd, "--code-mode", "direct", "--local-model-lean", "--thinking", thinking,
      "--timeout", String(timeoutSeconds), "--state-dir", stateDir, "--json",
      ...(sandboxOverridePath ? ["--config", sandboxOverridePath] : []),
      // openclaw agent exec defaults to --auth-env-only ("Use provider
      // credentials from environment variables only"). A subscription
      // worker's credential is deliberately NOT an env var -- OpenClaw
      // discovers it by reading the local CLI's own already-logged-in session
      // instead ("Allow stored and external CLI credential discovery", per
      // this flag's own --help text) -- confirmed live: a real
      // `--model claude-cli/claude-sonnet-5 --no-auth-env-only` call
      // succeeded and returned a real completion. Every existing auth_env-
      // based pool/profile job keeps today's default, unchanged.
      ...(subscriptionWorker ? ["--no-auth-env-only"] : [])];
    // Same idleMs/minElapsedMs budget for both: idle-diff means "the worktree
    // stopped changing", this one means "the transcript stopped advancing after
    // the worker walked away from a process it started" -- same "how long is
    // genuinely too long to be idle" question, no separate knob needed.
    // The heartbeat runs for every job, so a running job is always watchable
    // (status.json used to keep its launch-time updatedAt until the end).
    const onTick = combineTicks([
      makeHeartbeatTick(jobDir),
      ...(idleDiff ? [makeIdleDiffTick(cwd, idleDiff), makeAbandonedBackgroundProcessTick(stateDir, idleDiff)] : []),
    ]);
    const liveLogs = { stdout: path.join(jobDir, `openclaw${logSuffix}.stdout.log`), stderr: path.join(jobDir, `openclaw${logSuffix}.stderr.log`) };
    // Where this call's own transcript events will start (see salvageFinishedRun).
    const eventsBefore = (await readOpenClawTranscriptTail(stateDir, { limit: 0 }).catch(() => ({ events: 0 }))).events ?? 0;
    for (const f of Object.values(liveLogs)) { try { fs.writeFileSync(f, ""); } catch { /* best-effort */ } }
    // A claude-cli run's envelope carries only its final reply's usage; the
    // CLI's own session log has every call (lib/claude-transcript.mjs).
    const callStartedMs = Date.now();
    const withClaudeUsage = (result) => {
      if ((selected.entry?.provider ?? workerProvider) !== "claude-cli") return result;
      try {
        const usage = readClaudeSessionUsage(cwd, { sinceMs: callStartedMs - 5000 });
        if (usage) return { ...result, usage, usageSource: "claude-code-session" };
      } catch { /* keep the envelope's */ }
      return result;
    };
    const execOnce = (thinking) => withSandboxProvisioningRetry(
      () => run("openclaw", buildArgs(thinking), { cwd, env, timeoutMs: (timeoutSeconds + 30) * 1000, onTick, tickMs: (idleDiff?.pollSeconds ?? 15) * 1000, teeTo: liveLogs }),
      { onRetry: (attempt, error) => fs.appendFileSync(path.join(jobDir, "coordinator.log"),
          `${new Date().toISOString()} transient sandbox provisioning error${logSuffix}, retry ${attempt}/${MAX_SANDBOX_PROVISIONING_RETRIES}\n${error.message}\n`) },
    );
    // Held for this whole call (including retries) so max_concurrent counts a
    // real in-flight `agent exec`, not just the time between admission and
    // launch. A `profile`-routed call has no entry id and this is a no-op.
    // Subscription entry ids are namespaced ("subscription:<id>") before
    // sharing this same counting map with pool entries -- config/providers.yml
    // and config/subscriptions.yml are separate files an operator could
    // plausibly give the same id in, and merging their concurrency counts on
    // an accidental collision would be a real, if narrow, correctness bug.
    const poolEntrySlotId = selected.entry?.id ? (subscriptionWorker ? `subscription:${selected.entry.id}` : selected.entry.id) : undefined;
    return withPoolEntrySlot(poolEntrySlotId, async () => {
      try {
        let stdout, stderr;
        try {
          ({ stdout, stderr } = await execOnce(selected.thinking));
        } catch (error) {
          const unsupported = parseUnsupportedThinkingError(error.message);
          // Only retry when OpenClaw itself named a DIFFERENT level as the fix
          // -- never loop on the same level, and never mask a real, unrelated
          // failure as a thinking-level problem it isn't.
          if (unsupported && !unsupported.supported.includes(selected.thinking)) {
            const fallback = unsupported.supported[0];
            fs.appendFileSync(path.join(jobDir, "coordinator.log"),
              `${new Date().toISOString()} "${selected.model}" rejected thinking level "${selected.thinking}" (OpenClaw supports: ${unsupported.supported.join(", ")}) -- retrying once with "${fallback}"\n`);
            selected.thinking = fallback; // the manifest's requestedReasoning field should reflect what was ACTUALLY used, not the level that failed
            ({ stdout, stderr } = await execOnce(fallback));
          } else {
            throw error;
          }
        }
        fs.writeFileSync(path.join(jobDir, `openclaw${logSuffix}.stdout.log`), stdout + "\n");
        fs.writeFileSync(path.join(jobDir, `openclaw${logSuffix}.stderr.log`), stderr + "\n");
        let parsed;
        try { parsed = JSON.parse(stdout); } catch { throw new Error(`OpenClaw returned invalid JSON:\n${stdout}`); }
        // OpenClaw's own envelope does not reliably include `provider` for
        // every backend (observed directly during this feature's own testing).
        // Backfilling it HERE, from what nomArmy itself just selected, is the
        // only place that actually knows the right answer -- buildMetrics
        // falling back to the single global workerProvider would silently
        // misattribute a pool-routed job (e.g. one that really ran on
        // "anthropic") to whatever the ambient default happens to be.
        if (!parsed.provider) parsed.provider = selected.entry?.provider ?? workerProvider;
        // The ACTUALLY-used thinking level (after any unsupported-level retry
        // above) -- `reasoningApplied` in the manifest (see
        // resolveReasoningApplied) prefers this over its own profile-only
        // formula, which had no way to reflect a pool-routed job's real value
        // at all (a real, separate bug this closes alongside the retry).
        parsed.thinkingApplied = selected.thinking;
        // The budget this job's prompt was actually built with (its agent's
        // tier and model), so the job record reports it rather than the
        // server-wide local one.
        parsed.budgetsUsed = jobBudgets;
        return withClaudeUsage(parsed);
      } catch (error) {
        // See parseOpenClawInternalTimeout's own doc comment: a nonzero exit
        // whose stdout is still OpenClaw's own well-formed timeout envelope is
        // a graceful internal timeout, not an opaque crash -- relabel it so
        // executeImplement/executeScout's workerTimedOut check (and therefore
        // report recovery) sees it correctly.
        if (!error.timedOut && parseOpenClawInternalTimeout(error.stdout)) {
          error.timedOut = true;
          error.stopReason = error.stopReason ?? "openclaw_internal_timeout";
        }
        // The logs are written on failure too, so a failed job still has them.
        if (error.stdout !== undefined) fs.writeFileSync(path.join(jobDir, `openclaw${logSuffix}.stdout.log`), `${error.stdout ?? ""}\n`);
        if (error.stderr !== undefined) fs.writeFileSync(path.join(jobDir, `openclaw${logSuffix}.stderr.log`), `${error.stderr ?? ""}\n`);
        const bareModel = selected.model.includes("/") ? selected.model.slice(selected.model.indexOf("/") + 1) : selected.model;
        const salvaged = !error.timedOut ? await salvageFinishedRun(error, stateDir, { sinceEvent: eventsBefore }) : null;
        if (salvaged) {
          fs.appendFileSync(path.join(jobDir, "coordinator.log"), `${new Date().toISOString()} OpenClaw exited with an error after the run finished (${salvaged.salvagedFrom}); using the report from the run's transcript\n${error.message}\n`);
          return withClaudeUsage({ ...salvaged, model: bareModel, provider: selected.entry?.provider ?? workerProvider, thinkingApplied: selected.thinking, budgetsUsed: jobBudgets });
        }
        fs.appendFileSync(path.join(jobDir, "coordinator.log"), `${new Date().toISOString()} OpenClaw failure${logSuffix}\n${error.stack || error.message}\n`);
        // A refused model reads as "openclaw exited 1" unless its reason is
        // lifted out of the run log (lib/openclaw-errors.mjs).
        const rejected = modelRejection(`${error.stderr ?? ""}\n${error.stdout ?? ""}`, selected.model);
        if (rejected) {
          const line = modelRejectionLine(rejected);
          error.modelNotFound = rejected;
          error.stack = `${line}\n${error.stack ?? error.message}`;
          error.message = line;
        }
        // What was attempted, for the job record: a failed job used to be
        // labeled with the local default model, whatever it really ran on.
        error.partialResult = { model: bareModel, provider: selected.entry?.provider ?? workerProvider, budgetsUsed: jobBudgets };
        throw error;
      } finally {
        // A cloned copy of the ambient OpenClaw config (which may carry a real
        // cloud credential -- see resolveWorkerSandboxOverride) has no reason to
        // outlive this one run.
        if (sandboxOverridePath) fs.rmSync(sandboxOverridePath, { force: true });
        await reapSandboxContainers(stateDir, jobDir);
        // OpenClaw's own scratch space: copies of the Codex plugin build,
        // 212 MB binary included, several per call, 1.2 GB for one Codex job,
        // never removed. The transcript lives in agents/, not here, so report
        // recovery and review lose nothing; a later call recreates what it needs.
        fs.rmSync(path.join(stateDir, "tmp"), { recursive: true, force: true });
      }
    });
  }

  async function reapSandboxContainers(stateDir, jobDir) {
    const reaped = [];
    for (const hash of sandboxHashesFromState(stateDir)) {
      // Look the container up by hash rather than reconstructing its name.
      // OpenClaw names it openclaw-sbx-workspace-<hash> under Docker but
      // openclaw-sbx-podman-workspace-<hash> under Podman -- a backend id
      // inserted into the name that a hardcoded template silently missed
      // entirely under Podman, every job leaked its container and volume
      // and this reap ran without ever once matching anything. The hash
      // itself is the reliable, backend-independent identifier.
      try {
        const { stdout } = await run("podman", ["ps", "-a", "--filter", `name=${hash}`, "--format", "{{.Names}}"], { timeoutMs: 30000 });
        const names = stdout.split("\n").map(s => s.trim()).filter(Boolean);
        for (const name of names) {
          // -v also removes the container's anonymous volume. Without it the
          // container was reaped but its volume silently outlived it -- found
          // in the wild as orphaned hash-named volumes with nothing left
          // referencing them.
          await run("podman", ["rm", "-f", "-v", name], { timeoutMs: 30000 });
          reaped.push(name);
        }
      } catch { /* already gone, or no podman */ }
    }
    if (reaped.length) fs.appendFileSync(path.join(jobDir, "coordinator.log"), `${new Date().toISOString()} reaped sandbox container(s): ${reaped.join(", ")}\n`);
    return reaped;
  }

  // A per-job reap (above) only ever sees that job's own container, by design:
  // it matches on the hash recorded in that job's own state dir. Anything left
  // behind by a coordinator process that died before reaching its `finally`, a
  // Podman machine restart (which stops every container but reaps none), or a
  // different nomArmy install on this machine is invisible to it and
  // accumulates forever -- 34 stopped containers and two orphaned anonymous
  // volumes were found from exactly this on one real machine, back when this
  // ran on Docker. This sweep is broader and deliberately conservative: it only
  // ever touches containers Podman already reports as exited, so a container a
  // live job still needs (which would be running, not exited) is never at
  // risk. Best-effort and silent on failure -- no Podman, no permission, or
  // nothing to sweep are all normal outcomes, not errors.
  // Filters on "openclaw-sbx-" only, not the fuller "openclaw-sbx-workspace-"
  // -- OpenClaw inserts a backend id into the name under Podman
  // (openclaw-sbx-podman-workspace-<hash>, not openclaw-sbx-workspace-<hash>),
  // which the narrower filter silently never matched at all.
  async function sweepStaleSandboxContainers() {
    try {
      const { stdout } = await run("podman",
        ["ps", "-a", "--filter", "name=openclaw-sbx-", "--filter", "status=exited", "--format", "{{.ID}}"],
        { timeoutMs: 30000 });
      const ids = stdout.split("\n").map(s => s.trim()).filter(Boolean);
      if (!ids.length) return [];
      await run("podman", ["rm", "-f", "-v", ...ids], { timeoutMs: 30000 });
      return ids;
    } catch { return []; }
  }

  return { runOpenClaw, resolveWorkerSandboxOverride, ambientOpenClawConfigPath, reapSandboxContainers, sweepStaleSandboxContainers };
}
