import { createExecutor, sleep } from "../lib/execute.mjs";
export { JOB_PHASES } from "../lib/execute.mjs";
import { createVerificationFlow } from "../lib/verification-flow.mjs";
export { gitShowBuffer, gitModeAtBase, planProductionRevert, revertToBase, restoreWorkerVersion, blobHash, currentBlobHash } from "../lib/verification-flow.mjs";
import { createOpenClawRunner, makeHeartbeatTick as heartbeatTick, readJson } from "../lib/openclaw-run.mjs";
export { makeAbandonedBackgroundProcessTick, parseUnsupportedThinkingError, parseOpenClawInternalTimeout, salvageFinishedRun, sandboxHashesFromState, withSandboxProvisioningRetry, looksLikeTransientInferenceAbort, shouldRetryTransientAbort, shouldAttemptScoutRecovery } from "../lib/openclaw-run.mjs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createBudgetState, clampInt } from "../lib/budget-state.mjs";
import { createJobBudgets, readsMeasurable, measureReads } from "../lib/job-budgets.mjs";
import { createAgentConfig } from "../lib/agent-config.mjs";
import { createSelection } from "../lib/selection.mjs";
import { createServerContext } from "../lib/server-context.mjs";
import { createProcess, mapLimit } from "../lib/process.mjs";
import { createGitRecord, parseStatusPorcelainZ, isRuntimeJunk, coordinatorCommitMessage } from "../lib/git-record.mjs";
import { checkBrief, assessAdmission, describeBudgets, FRONTIER } from "../lib/budget.mjs";
import { readOpenClawTranscriptTail } from "../lib/transcript.mjs";
import { COORDINATOR_INSTRUCTIONS } from "../lib/coordinator-instructions.mjs";
import { runQuery, formatCitations, OPS as EVIDENCE_OPS } from "../lib/repo-query.mjs";
import { loadConfig, ConfigError } from "../lib/config.mjs";
import { expandArmyRole, describeArmy, globalConfigDir } from "../lib/army.mjs";
import { readClaudeSessionTranscript } from "../lib/claude-transcript.mjs";
import { notify } from "../lib/notify.mjs";
import { checkAndRecordHealth, recentModelRefusal } from "../lib/health.mjs";
import { writeLease, removeLease, liveLeases, liveSlots, acquireSlot } from "../lib/slots.mjs";
import { createRun, loadRun, runTotals, runAdmissionProblems, recordRunJob, finishRun, resolveRunLimits, describeLoweredLimits, detectUsageLimit } from "../lib/runs.mjs";
import { agentDispatchFields, resolveAgentModel, agentProviderId, describeAgent, hostToolsImplementProblem } from "../lib/agents.mjs";
import { OUTCOMES, COORDINATOR_STATUS_BY_OUTCOME } from "../lib/outcomes.mjs";
import { createBuildMetrics, resolveOutcome, finalText, workerMetadata, usageMetrics, policyAdmissionProblems, applyRefactorContract, applyVerificationPolicy, resolveVerifyRegression } from "../lib/outcome.mjs";
import { compactJobRecord, formatResult, formatUnion, testChangeBanner, regressionCheckBanner, decomposeOverlapBanner } from "../lib/job-format.mjs";

export { run, mapLimit };
export { readsMeasurable, measureReads };
export { parseNameStatusZ } from "../lib/git-record.mjs";
export { isRuntimeJunk, coordinatorCommitMessage, createCoordinatorCommit, makeIdleDiffTick };

export { workerPrompt, describeRecoveryChanges, reportRecoveryPrompt } from "../lib/worker-prompt.mjs";
export { REPORT_FIELD_NAMES, parseWorkerReport } from "../lib/report.mjs";
export { OUTCOMES, COORDINATOR_STATUS_BY_OUTCOME };
export { resolveOutcome, finalText, workerMetadata, usageMetrics, policyAdmissionProblems, applyRefactorContract, applyVerificationPolicy, resolveVerifyRegression, buildMetrics };
export { formatResult, formatUnion, testChangeBanner, regressionCheckBanner, decomposeOverlapBanner };
export { TEST_PATH_PATTERNS, isTestPath, testPatternFor, classifyTestChanges, detectScopedTestSelectionRisk, parseAddedLineNumbers, detectUnwiredNewDefinitions, detectMislabeledTestNames, scanTextForSecrets, extractAddedLinesBlob, detectPossibleSecrets, mergeUntrackedIntoNameStatus } from "../lib/diff-checks.mjs";

// Read from package.json rather than a second hardcoded literal -- the two
// drifted apart for real (this constant still said "1.3.0", an internal
// milestone label, after the public package version was reset to 0.x for
// the open-source launch). installMcpCopy (lib/connect.mjs) copies
// package.json to the same relative location next to the installed
// mcp/server.mjs, so this resolves identically in a dev checkout or an
// installed copy.
const VERSION = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).version;
// Sent to every coordinator on connect, so no project needs a copied CLAUDE.md.
const server = new McpServer({ name: "nomarmy-local-worker", version: VERSION }, { instructions: COORDINATOR_INSTRUCTIONS });
const ctx = createServerContext();
const { projectDir, stateRoot, jobsRoot, runsRoot, leasesRoot, slotsRoot } = ctx;
const { run, git, gitRaw } = createProcess(ctx);
const { collectGitRecord, createCoordinatorCommit, makeIdleDiffTick } = createGitRecord({ run, git, gitRaw });
export function currentMaxWorkers() { return budgetState.currentMaxWorkers(); }

// Importing this module (the contract tests do) must not touch the filesystem
// or open a transport. Job state is created lazily; stdio only runs in main.
let jobsRootReady = false;
function ensureJobsRoot() {
  if (!jobsRootReady) { fs.mkdirSync(jobsRoot, { recursive: true }); jobsRootReady = true; }
  return jobsRoot;
}

function slug(prefix = "local") {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  return `${prefix}-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}
async function assertRepo() {
  const root = await git(["rev-parse", "--show-toplevel"]);
  if (path.resolve(root) !== projectDir) throw new Error(`CLAUDE_PROJECT_DIR must be the Git root. Expected ${root}, got ${projectDir}`);
}
async function resolveBase(baseRef) {
  const ref = baseRef || "HEAD";
  return { ref, sha: await git(["rev-parse", "--verify", `${ref}^{commit}`]) };
}

// Worker model identity comes from the active profile, not from this file, so
// a local llama-cpp worker and a Bedrock worker share one code path.
const workerProvider = process.env.NOMARMY_WORKER_PROVIDER || "llama-cpp";
const workerModel = process.env.NOMARMY_WORKER_MODEL || "qwen3-coder-next";
const workerModelFallback = process.env.NOMARMY_WORKER_MODEL_FALLBACK || "gpt-oss-20b";
// The shipped default for this slot, Qwen3-Coder-Next, has no trained
// thinking mode at all -- not a policy choice, a fact about that specific
// checkpoint. Forcing thinking off was previously hardcoded to the "coder"
// PROFILE name rather than tied to the model actually configured there, so
// swapping in a reasoning-capable model under this same slot would still
// have `reasoning` silently ignored. This flag makes it a property of the
// configured model, defaulting to today's shipped behavior (off) and
// overridable by whoever configures a different model into this slot.
const workerModelThinkingSupported = process.env.NOMARMY_WORKER_MODEL_THINKING === "true";
const orchestratorTrust = process.env.NOMARMY_ORCHESTRATOR_TRUST || "frontier";
const contextLimitRaw = process.env.NOMARMY_CONTEXT_LIMIT ?? process.env.NOMARMY_WORKER_CONTEXT_LIMIT ?? "";
const contextLimit = Number.isFinite(Number.parseInt(contextLimitRaw, 10)) ? Number.parseInt(contextLimitRaw, 10) : null;

// A local worker's context window is a shared, finite resource, not a place
// to dump an entire plan. An oversized brief does not make a small model more
// capable; it spends the job's turn on reading instead of editing (observed:
// a ten-file, ~3.5k-character brief produced zero edits before running out of
// output budget). The coordinator enforces a ceiling here so "keep the brief
// small and single-purpose" is a contract, not a habit the orchestrator has
// to remember. Configurable per hardware/model, not hardcoded.
//
// Those numbers were calibrated for the local model. A frontier agent (api
// or subscription) gets far larger ceilings (lib/budget.mjs's FRONTIER), so
// the schema itself allows the largest of the two, and admission
// (checkBrief, per job, against that job's own agent) enforces the real
// limit: a local job is still refused past its calibrated 3000 characters.
export const maxTaskChars = Math.max(Number.parseInt(process.env.NOMARMY_MAX_TASK_CHARS ?? "", 10) || 3000, FRONTIER.taskChars);
export const maxAcceptanceItemChars = Math.max(Number.parseInt(process.env.NOMARMY_MAX_ACCEPTANCE_ITEM_CHARS ?? "", 10) || 300, FRONTIER.acceptanceItemChars);

// A worker offered a cheap lookup tool alongside its normal read/ls tools
// does not reliably reach for the cheap one -- observed directly: a scout
// with repo_evidence in its sandbox still read a whole 1200-line file rather
// than looking up the one function it needed, and overflowed its context
// doing it. Handing over an extra option does not change what the model
// chooses. `evidence` instead lets the coordinator resolve the lookup itself
// (repo_evidence costs the coordinator nothing and is exposed to it
// directly) and hand the worker the answer already in the brief, so there is
// nothing left to explore for that specific fact. This is not a substitute
// for judgment: only put verified, load-bearing facts here, not padding.
export const maxEvidenceChars = Math.max(Number.parseInt(process.env.NOMARMY_MAX_EVIDENCE_CHARS ?? "", 10) || 6000, FRONTIER.evidenceChars);

// Those two are the HARD ceilings the tool schema enforces. The effective
// budget is derived from the context one nom actually has (profile, or the
// running llama-server's own /props) and can only be lower. It is refreshed
// when the server starts and again whenever a job is admitted, so a profile
// change or a restarted llama-server is picked up without restarting Claude.
const budgetState = createBudgetState();
export function currentBudgets() { return budgetState.currentBudgets(); }
// A confirmed real confusion, not just an imprecise name: this is a single
// module-level snapshot, computed once, identical in EVERY manifest
// regardless of job -- it is the server's own global default, never what a
// SPECIFIC job actually used. A pool-routed job's real provider/model is
// worker.model/worker.provider and metrics.worker_model (both resolved from
// OpenClaw's own per-job response) -- prefixed "default" here so a reader
// can no longer mistake this for a per-job result the way `workerModel`
// sitting inside a per-job manifest record read.
const execution = {
  layer: process.env.NOMARMY_EXECUTION || "local",
  defaultWorkerProvider: workerProvider, defaultWorkerModel: workerModel, defaultWorkerModelFallback: workerModelFallback,
  orchestratorTrust,
  orchestratorModel: process.env.NOMARMY_ORCHESTRATOR_MODEL || null
};
const buildMetrics = createBuildMetrics({ execution, contextLimit });

function profileConfig(profile, reasoning) {
  const profiles = {
    coder: { model: `${workerProvider}/${workerModel}`, thinking: workerModelThinkingSupported ? reasoning : "off" },
    gpt: { model: `${workerProvider}/${workerModelFallback}`, thinking: reasoning }
  };
  if (!profiles[profile]) throw new Error(`Unknown worker profile: ${profile}`);
  return profiles[profile];
}

// The manifest's own record of what thinking level a job's worker actually
// ran with. A real, confirmed bug this replaces: the old formula computed
// this from `profile`/`workerModelThinkingSupported` alone, which has no
// way to see a pool-routed job's real value at all -- every pool-routed
// job's manifest reported this field as if it had used the single global
// profile, regardless of what provider/entry actually ran. `result` is
// runOpenClaw's own parsed envelope, which now backfills `thinkingApplied`
// unconditionally (both profile- and pool-routed jobs) -- preferred here
// whenever it's present; the old formula survives only for a `result` that
// predates this fix or never reached runOpenClaw at all (e.g. worker_failed).
export function resolveReasoningApplied({ result, profile, reasoning, workerModelThinkingSupported }) {
  if (typeof result?.thinkingApplied === "string") return result.thinkingApplied;
  return profile === "gpt" || workerModelThinkingSupported ? reasoning : "off";
}

const agentConfig = createAgentConfig({ projectDir });
const { agentsConfig, dispatchConfig, subscriptionConfig, currentArmy, ensureCatalogRefresh, modelCatalog, modelCatalogReady } = agentConfig;
const { budgetsForPool, budgetsForJob, recordedBudgets, budgetsForSubscriptionWorker } = createJobBudgets({ budgetState, dispatchConfig, subscriptionConfig, modelCatalog });
const { resolvePoolSelection, resolveSubscriptionSelection, withPoolEntrySlot, assertNoProviderConflict } = createSelection({ dispatchConfig, subscriptionConfig, profileConfig });
export { resolvePoolSelection, resolveSubscriptionSelection };

const { runOpenClaw, resolveWorkerSandboxOverride, ambientOpenClawConfigPath, reapSandboxContainers, sweepStaleSandboxContainers } = createOpenClawRunner({
  run, projectDir, budgetState, profileConfig, resolvePoolSelection,
  resolveSubscriptionSelection, withPoolEntrySlot, makeIdleDiffTick,
  makeHeartbeatTick, workerProvider, modelCatalog,
});
export { resolveWorkerSandboxOverride, sweepStaleSandboxContainers };
export function makeHeartbeatTick(jobDir) { return heartbeatTick(jobDir, liveProgress); }


/**
 * Resolve every job's agent before admission: `army_role` -> that role's
 * agent -> the internal fields the execution path reads (`profile` for the
 * local model, `pool` for an api agent, `subscription_worker` for a
 * subscription), so budgets, the owner check and everything downstream see
 * an ordinary job. No agent at all means the local model. on_behalf_of is
 * dropped for a non-subscription agent (the General can't know which
 * roles are subscription-backed in every repo). Problems come back as
 * refusal lines, never a fallback to some other agent.
 */
// The /feature run this session started (run_start) or resumed. Every job
// the session dispatches joins it unless it names another run: enforcement
// used to depend on the General tagging each job with run_id, and in a real
// Senti run none were tagged, so a 4-hour run went 8.46 hours unchecked.
let activeRunId = null;

export function expandJobs(jobs, { getArmy = currentArmy, getAgents = () => agentsConfig().agents, getActiveRun = () => activeRunId } = {}) {
  const problems = [];
  let army = null, agents = null;
  const runId = getActiveRun();
  const expanded = jobs.map((job, i) => {
    try {
      let j = runId && !job.run_id ? { ...job, run_id: runId } : job;
      if (j.army_role) { army ??= getArmy().army; j = expandArmyRole(j, army); }
      const { agent, roleModel = null, ...rest } = j;
      if (!agent) {
        if (rest.model) throw new Error(`model "${rest.model}" needs an agent to run on: add agent (or army_role), or drop model to use the local model`);
        return { ...rest, profile: rest.profile ?? "coder" };
      }
      agents ??= getAgents();
      const fields = agentDispatchFields(agents, agent);
      const model = resolveAgentModel(agents, agent, { jobModel: rest.model ?? null, roleModel, roleName: rest.armyRole ?? null });
      const out = { ...rest, ...fields, agentName: agent };
      if (model) out.model = model; else delete out.model;
      if (!fields.subscription_worker) delete out.on_behalf_of;
      out.profile ??= "coder";
      return out;
    } catch (error) {
      problems.push(jobs.length > 1 ? `job ${i + 1}: ${error.message}` : error.message);
      return job;
    }
  });
  return { jobs: expanded, problems };
}

const verificationFlow = createVerificationFlow({
  run, git, projectDir, VERSION, collectGitRecord, ensureJobsRoot,
});
const { registerVerificationRunner, normalizeVerification, runIndependentVerification, runRegressionCheck, selectUnionCandidates, buildUnionBranch } = verificationFlow;
export { registerVerificationRunner, normalizeVerification, runRegressionCheck, selectUnionCandidates, buildUnionBranch };

const { executeJob, executeImplement, executeScout, executeDecompose } = createExecutor({
  VERSION, projectDir, jobsRoot, run, git, gitRaw,
  collectGitRecord, createCoordinatorCommit, ensureJobsRoot, slug, assertRepo,
  resolveBase, workerModelThinkingSupported, budgetState, execution, buildMetrics,
  resolveReasoningApplied, recordedBudgets, runOpenClaw, sweepStaleSandboxContainers,
  verificationFlow, normalizeVerification, runIndependentVerification,
  runRegressionCheck, repoPolicy,
});
export { executeJob };

// Staggers concurrent job starts by `slot * staggerMs` before each runner
// begins pulling work. Verified root cause: two OpenClaw sandbox containers
// created in the same instant reliably hit a podman/crun race ("crun: mount
// `devpts` to `dev/pts`: Invalid argument"), even with ample host and VM
// memory free -- reproduced twice, unrelated to memory pressure. A short
// stagger between concurrent `podman create`/`run` invocations gives crun's
// container-creation critical section enough separation to not collide.
//
// That original fix/measurement was only verified at 2-way concurrency.
// Re-verified at 4-way (this session): the same race still fired with the
// stagger active -- one job failed on this exact error within 5.2s of a
// 4-job concurrent dispatch. 1500ms of separation between ADJACENT slot
// starts is not consistently enough once 4 containers are all competing for
// the same crun critical section under real system load, not 2. Raised to
// 3000ms as a direct response to that reproduction; RETRY_TRANSIENT_SANDBOX_ERRORS
// below is the second, more robust layer -- no fixed stagger value can be
// proven sufficient for every load condition, only likely-sufficient.
const WORKER_START_STAGGER_MS = Number.parseInt(process.env.NOMARMY_WORKER_START_STAGGER_MS ?? "", 10) || 3000;

// ---------------------------------------------------------------------------
// Job registry and admission. Every job, blocking or backgrounded, is tracked
// here so capacity counts all of them. Admission re-reads the budget (a
// restarted llama-server or changed profile is picked up) and refuses under
// memory pressure rather than shrinking the brief and hoping.
// ---------------------------------------------------------------------------
const activeJobs = new Map();
// `lane` is "local" (the local model on llama-server) or "remote" (an api
// or subscription agent: the inference runs at the vendor). The local-slot
// admission check must only ever count the local lane. A subscription job
// used to land in "local" (the lane was decided by `pool` alone), so a
// Claude or Codex job took llama-server's only slot and blocked local work
// it never competed with -- reported from a real Senti run.
export function jobLane(job) {
  return job.pool || job.subscription_worker ? "remote" : "local";
}
// Counted across every session on this machine, not just this server's own
// jobs: each coordinator session runs its own server, and per-process
// counts let six sessions each run their "one" local job at once. Idle
// sessions hold no leases and count for nothing.
export function runningCount(lane = null) {
  return liveLeases(leasesRoot, lane ? { lane } : {}).length;
}

/** An api or subscription agent's max_concurrent (1 for a subscription, 2 for api by default); null for local. */
function agentMaxConcurrent(agentName) {
  try {
    const agent = agentsConfig().agents[agentName];
    return agent && agent.kind !== "local" ? agent.max_concurrent ?? (agent.kind === "subscription" ? 1 : 2) : null;
  } catch { return null; }
}

/**
 * Run a job holding one of its agent's max_concurrent slots, machine-wide
 * (lib/slots.mjs), so `max_concurrent: 1` on a subscription means one job
 * on it across every session -- per-session counting never enforced that,
 * and for subscriptions the count was never checked at all. `waitMs` lets a
 * batch queue for a slot instead of failing.
 */
function withAgentSlot(args, jobId, fn, { waitMs = 0 } = {}) {
  const max = args.agentName ? agentMaxConcurrent(args.agentName) : null;
  if (!max) return fn();
  return (async () => {
    const slot = await acquireSlot(slotsRoot, args.agentName, max, { jobId, waitMs });
    if (!slot) throw new Error(`agent "${args.agentName}" is at its max_concurrent (${max}) across every nomArmy session on this machine; try again when one of its jobs finishes`);
    try { return await fn(); } finally { slot.release(); }
  })();
}
// A static, operator-declared ceiling on how many remote jobs (api and
// subscription agents) may run at once, independent of and additive to
// currentMaxWorkers()'s local ceiling. Each still runs a sandbox and a
// worktree on this machine, which is what this bounds; each agent's own
// max_concurrent bounds its vendor. The env name predates agents.yml
// (remote jobs were all "pool" jobs then) -- exactly the "more real concurrency, not just diversity"
// benefit of spreading load across providers with their own separate rate
// limits. Not rate-limit-aware (see config/providers.yml.example); read
// fresh each call, matching currentMaxWorkers()'s own env-read pattern.
export function currentMaxPoolWorkers() {
  return clampInt(process.env.NOMARMY_MAX_POOL_WORKERS, 1, 32, 4);
}
// Pure partition of a batch's ORIGINAL indices by lane -- pulled out of
// local_workers' handler so this specific invariant (every job lands in
// exactly one lane, indices preserved) is directly testable without also
// exercising the full async dispatch/mapLimit machinery around it. This is
// the exact split that used to not exist at all: every job in a batch
// shared one `parallel` slot count derived only from the local ceiling,
// which let an all-pool batch ignore NOMARMY_MAX_POOL_WORKERS entirely.
export function splitJobsByLane(jobs) {
  const localIndices = [], remoteIndices = [];
  jobs.forEach((j, i) => (jobLane(j) === "remote" ? remoteIndices : localIndices).push(i));
  return { localIndices, remoteIndices };
}
export function track(jobId, meta, promise) {
  const entry = { ...meta, jobId, startedAt: new Date().toISOString(), settled: false, result: null, error: null, promise: null };
  // A machine-wide lease for as long as the job runs, so every session's
  // admission counts it (runningCount); released however the job ends.
  // `repo` lets each session's status line show its own repo's jobs.
  if (meta.lane) writeLease(leasesRoot, jobId, { lane: meta.lane, agent: meta.agent ?? null, runId: meta.runId ?? null, role: meta.role ?? null, model: meta.model ?? null, repo: projectDir });
  const release = () => removeLease(leasesRoot, jobId);
  entry.promise = promise.then(
    r => { entry.settled = true; entry.result = r; release(); notifyJobFinished(entry, r, null); return r; },
    e => { entry.settled = true; entry.error = e; release(); notifyJobFinished(entry, null, e); throw e; });
  entry.promise.catch(() => {});
  activeJobs.set(jobId, entry);
  return entry;
}
/**
 * A desktop notification when a job ends (lib/notify.mjs), so the person
 * watching hears about it from any coordinator without polling.
 */
function notifyJobFinished(entry, result, error) {
  if (!entry.lane) return; // only tracked jobs, never internal helpers
  const m = result?.manifest ?? {};
  const outcome = error ? "failed" : String(m.outcome ?? (result?.ok ? "done" : "finished")).toLowerCase().replace(/_/g, " ");
  const who = entry.agent ? `${entry.agent}${entry.model ? `/${entry.model}` : ""}` : "local model";
  const took = Math.round((Date.now() - Date.parse(entry.startedAt)) / 60000);
  const ok = !error && (result?.ok || m.coordinatorStatus === "complete");
  notify(`nomArmy: ${entry.role ?? entry.mode ?? "job"} ${ok ? "done" : outcome}`, `${entry.workerId ?? entry.jobId} on ${who}: ${outcome} after ${took}m. ${ok ? "Ready for the General's review." : "Needs a look."}`);
}
function toolText(text, isError = false) { return { content: [{ type: "text", text }], isError }; }
function capacitySnapshot() {
  const admission = assessAdmission({ hardware: budgetState.hardwareSnapshot, runningJobs: runningCount("local"), slots: budgetState.contextInfo.slots, maxWorkers: currentMaxWorkers() });
  return {
    // The local model's budget. An api or subscription job's scales with
    // its own model; local_worker_start reports that job's.
    budgets: { ...budgetState.budgets, describe: describeBudgets(budgetState.budgets) },
    context: budgetState.contextInfo,
    admission,
    memory: budgetState.hardwareSnapshot?.memory ?? null,
    running: [...activeJobs.values()].filter(j => !j.settled).map(j => ({ jobId: j.jobId, workerId: j.workerId, mode: j.mode, lane: j.lane, startedAt: j.startedAt, phase: readJson(path.join(jobsRoot, j.jobId, "status.json"))?.phase ?? "starting" })),
    maxWorkers: currentMaxWorkers(),
    remote: { running: runningCount("remote"), maxWorkers: currentMaxPoolWorkers(), note: "api and subscription agents; each agent's own max_concurrent also applies" }
  };
}
async function admit(jobs) {
  await budgetState.refresh();
  if (jobs.some((j) => jobLane(j) === "remote")) await modelCatalogReady();
  const problems = [];
  // A pool-routed job is checked against that pool's OWN (model-dependent)
  // budget, not the local-derived global one -- see budgetsForPool. Which
  // specific entry pickProvider will land on isn't known yet at admission
  // time, so this is the conservative minimum across the pool's currently
  // available entries, not any one entry's precise number. A
  // subscription_worker job budgets against that one named entry directly
  // (see budgetsForSubscriptionWorker) -- there's no "which entry" unknown
  // the way a weighted pool has, since the name given IS the entry.
  jobs.forEach((j, i) => {
    const jobBudgets = budgetsForJob(j);
    for (const p of checkBrief(j, jobBudgets)) problems.push(jobs.length > 1 ? `job ${i + 1}: ${p}` : p);
  });
  // verify_regression re-runs `verification`; with no profile set there is
  // nothing to re-run. Refuse before starting anything, matching every other
  // admission check here, rather than silently no-op at runtime.
  jobs.forEach((j, i) => {
    if (j.verify_regression && !j.verification) {
      problems.push(`${jobs.length > 1 ? `job ${i + 1}: ` : ""}verify_regression requires a verification profile; there is nothing to run twice without one`);
    }
  });
  // subscription_worker/on_behalf_of: the owner-match attestation refusal
  // happens here, before a container is ever provisioned -- matching how a
  // bad `pool` name is already caught before dispatch, not mid-flight. Only
  // attempted once the plain field-presence problems above are already
  // clean, so a missing on_behalf_of is never reported twice in two
  // different shapes.
  jobs.forEach((j, i) => {
    const fieldProblems = subscriptionJobFieldProblems(j);
    for (const p of fieldProblems) problems.push(jobs.length > 1 ? `job ${i + 1}: ${p}` : p);
    if (fieldProblems.length === 0 && j.on_behalf_of) {
      try {
        if (j.subscription_worker) resolveSubscriptionSelection(j.subscription_worker, j.on_behalf_of, j.reasoning, { model: j.model });
      } catch (error) { problems.push(jobs.length > 1 ? `job ${i + 1}: ${error.message}` : error.message); }
    }
  });
  // The repo's own policy: verification required, revert check required.
  const policy = repoPolicy();
  jobs.forEach((j, i) => { for (const p of policyAdmissionProblems(j, policy)) problems.push(`${jobs.length > 1 ? `job ${i + 1}: ` : ""}${p}`); });
  // An implement job on an agent whose own tools run on this machine (the
  // Claude CLI) isn't bounded by the sandbox, so it's refused unless that
  // agent says allow_host_tools (lib/agents.mjs). Scouts and reviews still run.
  jobs.forEach((j, i) => {
    if (!j.agentName || (j.mode ?? "implement") !== "implement") return;
    let problem = null;
    try { problem = hostToolsImplementProblem(j.agentName, agentsConfig().agents[j.agentName]); } catch { return; }
    if (problem) problems.push(`${jobs.length > 1 ? `job ${i + 1}: ` : ""}${problem}`);
  });
  // A model its vendor refused on a job today, with nothing working on it
  // since, isn't sent another job (lib/health.mjs recentModelRefusal).
  jobs.forEach((j, i) => {
    if (!j.agentName || !j.model) return;
    let provider = null;
    try { provider = agentProviderId(agentsConfig().agents[j.agentName]); } catch { return; }
    if (!provider) return;
    const refusal = recentModelRefusal(stateRoot, `${provider}/${j.model}`);
    if (refusal) problems.push(`${jobs.length > 1 ? `job ${i + 1}: ` : ""}model_not_found: ${provider}/${j.model} was refused on an earlier job today and hasn't worked since, so this job wasn't sent. Use another model (the job's \`model\`, or \`nomarmy army assign\`); \`nomarmy army assign <role> ${j.agentName} ${j.model}\` re-tests it, and a passing test clears this.`);
  });
  // An agent's max_concurrent, machine-wide. Batch jobs on the same agent
  // queue for its slot at launch instead (withAgentSlot's waitMs).
  if (jobs.length === 1) {
    const [j] = jobs;
    const max = j.agentName ? agentMaxConcurrent(j.agentName) : null;
    const held = max ? liveSlots(slotsRoot, j.agentName) : 0;
    if (max && held >= max) problems.push(`not admitted (capacity): agent "${j.agentName}" already has ${held} job(s) running across this machine's nomArmy sessions, at its max_concurrent of ${max}`);
  }
  // A job in a /feature run: the run's own limits and paused agents.
  jobs.forEach((j, i) => {
    if (!j.run_id) return;
    try {
      const run = loadRun(runsRoot, j.run_id);
      if (run.repo !== projectDir) problems.push(`${jobs.length > 1 ? `job ${i + 1}: ` : ""}run "${run.id}" belongs to ${run.repo}, not this repository`);
      const running = liveLeases(leasesRoot, { runId: run.id }).length + jobs.slice(0, i).filter((o) => o.run_id === run.id).length;
      for (const p of runAdmissionProblems(run, { agentName: j.agentName ?? "local", running })) problems.push(jobs.length > 1 ? `job ${i + 1}: ${p}` : p);
    } catch (error) { problems.push(jobs.length > 1 ? `job ${i + 1}: ${error.message}` : error.message); }
  });
  // Slot capacity only concerns local jobs: a remote job's inference runs
  // at its vendor and never competes for llama-server's slots. Free memory
  // still applies to every job (each one runs a local sandbox), so a
  // remote-only batch is checked for memory alone. Remote jobs have their
  // own, additive ceiling (currentMaxPoolWorkers).
  const anyLocal = jobs.some((j) => jobLane(j) === "local");
  const admission = anyLocal
    ? assessAdmission({ hardware: budgetState.hardwareSnapshot, runningJobs: runningCount("local"), slots: budgetState.contextInfo.slots, maxWorkers: currentMaxWorkers() })
    : assessAdmission({ hardware: budgetState.hardwareSnapshot, runningJobs: 0, slots: null, maxWorkers: Infinity });
  if (!admission.admit) problems.push(...admission.reasons.map(r => `not admitted (${admission.level}): ${r}`));
  if (jobs.some((j) => jobLane(j) === "remote")) {
    const remoteCeiling = currentMaxPoolWorkers(), runningRemote = runningCount("remote");
    if (runningRemote >= remoteCeiling) {
      problems.push(`not admitted (capacity): ${runningRemote} remote job(s) (api or subscription agents) already running, at NOMARMY_MAX_POOL_WORKERS=${remoteCeiling}`);
    }
  }
  return { problems, admission };
}
// The capacity snapshot only when a problem is about capacity: a
// model_not_found or bad-field refusal came with ~60 lines of local-model
// capacity JSON that had nothing to do with it (a Senti review).
export function refusalText(problems, snapshot) {
  const aboutCapacity = problems.some((p) => /capacity|memory|context|slot|MAX_(POOL_)?WORKERS|max_concurrent/i.test(p));
  return `REFUSED - nothing was started.\n${problems.map(p => `- ${p}`).join("\n")}${aboutCapacity ? `\n\nCapacity right now:\n${JSON.stringify(snapshot(), null, 2)}` : ""}`;
}
function refusal(problems) {
  return toolText(refusalText(problems, capacitySnapshot), true);
}
/** A run's totals and warnings, for a tool response. */
function runBrief(runId) {
  try {
    const run = loadRun(runsRoot, runId);
    const totals = runTotals(run);
    return { id: run.id, status: run.status, limits: run.limits, used: totals.used, warnings: totals.warnings };
  } catch (error) { return { id: runId, error: error.message }; }
}

/**
 * Record a finished job into its run. A usage-limit message is looked for
 * only in error text (OpenClaw's failure envelope, and the error lines of
 * a thrown run), never in the worker's report or tool output, where "rate
 * limit" may just be the code under review.
 */
function recordJobInRun(args, jobId, result, error = null) {
  if (!args.run_id) return;
  const kind = args.pool ? "api" : args.subscription_worker ? "subscription" : "local";
  const m = result?.manifest ?? {};
  const errorLines = [m.worker?.error, error?.message,
    ...String(m.workerError ?? "").split(/\r?\n/).filter((l) => /error|limit|429/i.test(l))].filter(Boolean).join("\n");
  const usageLimit = kind === "local" ? null : detectUsageLimit(errorLines);
  try {
    const before = runTotals(loadRun(runsRoot, args.run_id)).warnings;
    const updated = recordRunJob(runsRoot, args.run_id, {
      jobId, agent: args.agentName ?? "local", kind, model: args.model ?? null, role: args.armyRole ?? null, mode: args.mode,
      outcome: m.outcome ?? (error ? "ERROR" : null), costUsd: m.metrics?.worker_cost_usd ?? null,
      tokens: m.metrics?.worker_tokens_total ?? null, usageLimit,
    });
    // A limit crossed or an agent paused by this job is worth interrupting for.
    const fresh = runTotals(updated).warnings.filter((w) => !before.includes(w) && /OVER|paused/.test(w));
    if (fresh.length) notify(`nomArmy run ${updated.name}: stopped short`, fresh.join("; "));
  } catch (recordError) {
    fs.appendFileSync(path.join(jobsRoot, jobId, "coordinator.log"), `${new Date().toISOString()} could not record into run ${args.run_id}: ${recordError.message}\n`);
  }
}
function trackInRun(args, entry) {
  if (args.run_id) entry.promise.then((r) => recordJobInRun(args, entry.jobId, r), (e) => recordJobInRun(args, entry.jobId, null, e));
  return entry;
}
function launch(args) {
  const workerId = args.worker_id || null;
  const jobId = slug(workerId || (args.mode === "scout" ? "scout" : "worker"));
  return trackInRun(args, track(jobId, { mode: args.mode, workerId: workerId || jobId, lane: jobLane(args), agent: args.agentName ?? null, runId: args.run_id ?? null, role: args.armyRole ?? null, model: args.model ?? null },
    withAgentSlot(args, jobId, () => executeJob({ ...jobArgs(args, workerId), jobId }))));
}
// Best-effort progress signal for a job still mid-run: a plain "phase: worker,
// elapsed: Ns" told a caller nothing about whether the worker was still
// reading or already editing, short of running `git status` on the worktree
// by hand. Both lookups here are read-only and disposable -- a job's worktree
// mid-write or a transcript sqlite file mid-append can legitimately fail to
// read, and that must never fail the status call, only omit the field.
async function liveProgress(jobDir) {
  const out = {};
  try {
    const worktree = path.join(jobDir, "worktree");
    if (fs.existsSync(worktree)) {
      // --untracked-files=normal, not all: "all" descends into every
      // untracked directory (a virtualenv, a cache) a job creates. Bounded:
      // a live progress read must never hold anything up.
      const statusOut = (await run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=normal"], { cwd: worktree, trim: false, timeoutMs: 10000 })).stdout;
      // Same runtime-junk filter as collectGitRecord/makeIdleDiffTick: .npm/
      // etc. is the sandbox's own churn, not the worker's progress, and
      // counting it made a job that had made zero real edits report
      // filesChangedLive: 1 anyway.
      out.filesChangedLive = parseStatusPorcelainZ(statusOut).map(e => e.file).filter(f => !isRuntimeJunk(f)).length;
    }
  } catch { /* worktree not ready yet, or mutated mid-read; omit */ }
  try {
    const stateDir = path.join(jobDir, "runtime", "state");
    const transcript = await readOpenClawTranscriptTail(stateDir, { limit: 6 });
    if (transcript.available) {
      const last = transcript.toolCalls.at(-1);
      if (last) out.lastTool = { tool: last.tool, target: last.path ?? last.command ?? null };
    }
    // A claude-cli worker's tools only appear in Claude Code's own session
    // transcript, not OpenClaw's.
    if (!out.lastTool) {
      const startedMs = Date.parse(readJson(path.join(jobDir, "status.json"))?.startedAt ?? "") || 0;
      const claude = readClaudeSessionTranscript(path.join(jobDir, "worktree"), { sinceMs: startedMs, tailBytes: 262144 });
      const last = claude.available ? claude.toolCalls.at(-1) : null;
      if (last) { out.lastTool = { tool: last.tool, target: last.path ?? last.command ?? null }; out.toolCallsLive = claude.toolCalls.length; }
    }
  } catch { /* transcript not created yet, or locked mid-write; omit */ }
  return out;
}

async function summarize(entry, files, jobDir = null) {
  const status = files.status, meta = files.meta ?? files.failure;
  const elapsedSeconds = status?.startedAt ? Math.round((Date.now() - Date.parse(status.startedAt)) / 1000) : entry ? Math.round((Date.now() - Date.parse(entry.startedAt)) / 1000) : null;
  const out = { jobId: entry?.jobId ?? status?.jobId ?? meta?.jobId ?? null, workerId: entry?.workerId ?? status?.workerId ?? meta?.workerId ?? null,
    mode: entry?.mode ?? status?.mode ?? meta?.mode ?? null, state: null, phase: status?.phase ?? "starting", elapsedSeconds,
    timeoutSeconds: status?.timeoutSeconds ?? null, coordinatorStatus: meta?.coordinatorStatus ?? null, outcome: meta?.outcome ?? null,
    reviewRequired: meta?.reviewRequired ?? null, issues: (meta?.issues ?? []).slice(0, 6), worktree: meta?.worktree ?? null, branch: meta?.branch ?? null,
    commit: meta?.commit?.sha ?? null, scout: meta?.scout ? { supported: meta.scout.supported, unsupported: meta.scout.unsupported } : null };
  if (entry && !entry.settled) out.state = "running";
  else if (entry?.error) { out.state = "failed"; out.error = String(entry.error.message ?? entry.error).split("\n")[0]; }
  else if (meta) out.state = "finished";
  else if (status?.state === "running") { out.state = status.serverPid === process.pid ? "running" : "orphaned"; if (out.state === "orphaned") out.error = `the MCP server that ran this job (pid ${status.serverPid}) is gone; outcome unknown, see the job directory logs`; }
  else out.state = "unknown";
  if (out.state === "running" && jobDir) Object.assign(out, await liveProgress(jobDir));
  return out;
}

export const jobSchema = z.object({
  task: z.string().min(1).max(maxTaskChars,
    `Objective exceeds the ${maxTaskChars}-character worker context budget. This length limit does not by itself mean the job is too broad: a single-purpose objective that inlines file contents can hit it just from being verbose. If that's the case here, reference exact paths and line ranges instead (the worker can read them, or use \`evidence\` to hand it the answer already resolved) rather than pasting the file into the brief. If the objective genuinely covers multiple files or concerns, split it into separate jobs.`
  ).describe("implement: the OBJECTIVE the worker must achieve, not the edit it should make. scout: the QUESTION to answer from the repository. decompose: the broad OBJECTIVE to propose a split for."),
  acceptance: z.array(z.string().min(1).max(maxAcceptanceItemChars,
    `Acceptance item exceeds ${maxAcceptanceItemChars} characters. Keep each criterion to one concrete, checkable statement.`
  )).max(20).optional().describe("implement: acceptance criteria the worker must satisfy. scout: points a complete answer must cover. decompose: constraints a good split must respect."),
  verification: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).optional().describe("Verification profile NAME (e.g. quick, standard, browser). Semantic; nomArmy owns execution. Ignored by scouts."),
  refactor: z.boolean().optional().describe("implement: declares a behavior-preserving change (moving or restructuring code). nomArmy then requires a passing verification profile and refuses to commit if any test file was added, changed or deleted: the existing tests passing unchanged is the evidence nothing changed. The revert check is skipped, since reverting a refactor restores working code and always passes. A job that changes behavior has to change tests, so it can't pass as a refactor."),
  verify_regression: z.boolean().optional().describe(
    "implement only: after the diff passes `verification` and touches production files, temporarily revert just those production files, re-run the SAME verification profile (expected to fail without the fix), then restore them. A re-run that still PASSES proves no test would catch this regression, and the outcome is downgraded to NEEDS_REVIEW regardless of the worker's report -- never silently committed as done. This is the ONLY mechanism that catches a verification profile that passes for the wrong reason (a test-selection flag that accidentally excludes the changed file's own tests reports a real, honest, green run that never touched the diff -- exit-code checking alone cannot see the difference). Defaults to true whenever `verification` is set, since that gap is exactly what nomArmy's trust boundary claims to close; pass `false` explicitly to skip the doubled wall-clock cost (can matter on repos with thousands of tests) and accept the risk instead. No effect with no `verification` profile -- there is nothing to re-run. Ignored by scouts."
  ),
  mode: z.enum(["scout", "implement", "decompose"]).default("implement").describe("implement: edit in an isolated worktree, coordinator commits on a valid report. scout: read-only research; every finding must cite [path:start-end] and nomArmy attaches the cited lines after verifying them against the base commit. decompose: read-only; proposes 2+ independent, evidence-grounded subtasks for a broad objective instead of doing everything in one worker turn. Never auto-dispatched -- the proposal is reviewed like a scout's findings, and the coordinator makes its own separate dispatch call with whatever subtasks it chooses to use."),
  base_ref: z.string().optional(),
  timeout_seconds: z.number().int().min(30).max(1800).default(600),
  reasoning: z.enum(["low", "medium", "high"]).default("medium").describe("Thinking level passed to the worker model. On the local model it takes effect when that model supports thinking (NOMARMY_MODEL_THINKING); on an api or subscription agent it applies per that agent's own `thinking` setting (false = off, a fixed level = always that level). Default is medium, not high, on real measured evidence: on an identical ticket, gpt-oss-20b at high took 318s with 21 tool calls and 4 failures, and at medium took 62s with 9 calls and 0 failures -- high did not produce a better answer, it thrashed. A separate open-ended task made Qwen3.6-27B time out completely at high (630s, zero output) and succeed at medium. Do not raise this to high by default reasoning that more thinking should help -- it has only ever hurt or timed out in testing so far. Reach for high only after a task has already failed once at medium and the failure looks like an under-thinking problem specifically (wrong root cause, not a formatting or scope issue)."),
  agent: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).optional().describe("Run on this agent from the operator's agents.yml, by name (e.g. \"codex\", \"grok\", \"local\"): the local model, a metered api key, or one person's subscription. Omit agent and army_role to use the local model. Refuses an unknown name, never falls back. Mutually exclusive with army_role. A subscription agent also requires on_behalf_of."),
  model: z.string().regex(/^\S{1,200}$/).optional().describe("The model to run on the job's agent (an api or subscription agent), e.g. \"gpt-6-sol\". Overrides the role's model and the agent's default. Required when the role's model is \"auto\" or the agent has no default. The `army` tool lists each agent's models. Refused on the local agent, whose model `nomarmy model` sets."),
  run_id: z.string().regex(/^run-[a-z0-9-]{1,80}$/).optional().describe("The /feature run this job belongs to (from run_start). Admission then enforces the run's limits (jobs, api spend, hours) and refuses an agent the run has paused after a vendor usage-limit error; the finished job is recorded into the run."),
  report: z.enum(["brief", "standard", "full"]).optional().describe("How much the worker may report back, capped by its agent's tier: brief (today's local-sized report), standard (the default), full (the frontier ceiling: about 2k tokens for implement, 4k for a scout). The report lands in your own context and is re-read every later turn, so ask for full only when the job's findings are the point (a broad review). No effect on the local model, whose caps are calibrated."),
  commit_subject: z.string().max(200).optional().describe("implement: the subject line of the commit nomArmy makes on the worker branch, e.g. \"Keep held-back tables in the list_tables cache\". Defaults to the task's first sentence; the body is the worker's NOTE, and the job id is a trailer."),
  army_role: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).optional().describe("Dispatch by army role (e.g. \"sr-dev\", \"security-analyst\"): nomArmy runs it on the agent this repo assigns to that role and puts the role's description at the top of the brief. Call the `army` tool first to see this repo's roles. Mutually exclusive with agent. Add on_behalf_of in case the role's agent is a subscription; it's ignored otherwise."),
  on_behalf_of: z.string().min(1).max(254).optional().describe("Required when the job's agent is a subscription: must exactly match that agent's owner in agents.yml, or nomArmy refuses the job. A self-reported attestation, not an independently verified identity check -- nomArmy has no caller-identity boundary today, so what this guarantees is explicit, auditable intent and hard refusal on mismatch or omission, not cryptographic proof of who issued the call. Ignored for a local or api agent."),
  evidence: z.string().max(maxEvidenceChars,
    `Evidence exceeds the ${maxEvidenceChars}-character budget. This is for facts already resolved (e.g. with repo_evidence), not more description of the task -- if it needs more than this, resolve less per job or put the pointer (a path and line range) here instead of the material itself.`
  ).optional().describe("implement only: facts YOU already resolved (e.g. via repo_evidence) that the worker should trust and not re-derive -- exact signatures, call sites, line ranges, existing behavior. Cuts exploration that would otherwise burn the worker's own context budget on something you already know. Not a substitute for a clear objective and acceptance criteria."),
  worker_id: z.string().regex(/^[A-Za-z0-9._-]+$/).optional()
});
// A plain function, not jobSchema.superRefine: server.tool(...) registers
// jobSchema.shape directly (see its call sites below), and .superRefine()
// wraps a schema in a ZodEffects that has no .shape at all -- confirmed
// live, this would have silently broken BOTH tool registrations. The MCP
// SDK also validates incoming args against .shape's own per-field schemas,
// never the whole composed object, so a .superRefine() here would never
// even run through that path regardless. Cross-field job validation in this
// codebase already lives in admit() as plain checks instead (see
// verify_regression's own "requires a verification profile" check just
// below) -- this follows that exact, already-established pattern.
// Runs on an already-expanded job (see expandJobs), where the agent has
// become `subscription_worker` for a subscription.
export function subscriptionJobFieldProblems(args) {
  const problems = [];
  if (args.subscription_worker && !args.on_behalf_of) {
    problems.push(`agent "${args.agentName ?? args.subscription_worker}" is a subscription and requires on_behalf_of naming exactly who this job is for -- it was not supplied`);
  }
  return problems;
}
// An explicit true/false always wins. Omitted, this defaults to true
// whenever there's actually a `verification` profile to regression-check
// against (and this is an implement job -- scouts/decomposes ignore it
// regardless) -- see resolveVerifyRegression for why "on by default" is the
// right call, not just a cost/benefit compromise.
/**
 * The repo's own policy from the operator's checkout (.nomarmy.yml
 * `policy:`), never a job's worktree: what every implement job must meet,
 * whatever the General asks for per job. A reviewer's fair point: without
 * it, a job with no verification profile still committed (flagged, not
 * blocked), and the General could switch the revert check off.
 */
export function repoPolicy(loadConfigFn = () => loadConfig(projectDir)) {
  try { return loadConfigFn()?.config?.policy ?? {}; } catch { return {}; }
}
// `args` is already expanded (see expandJobs): its agent is now `profile`,
// `pool` or `subscription_worker`.
function jobArgs(args, workerId) {
  const subscriptionWorker = args.subscription_worker;
  return { task: args.task, acceptance: args.acceptance, verification: args.verification, mode: args.mode, baseRef: args.base_ref,
    timeoutSeconds: args.timeout_seconds, profile: args.profile, reasoning: args.reasoning, pool: args.pool,
    subscriptionWorker, onBehalfOf: args.on_behalf_of, model: args.model ?? null, reportSize: args.report ?? null, evidence: args.evidence,
    verifyRegression: resolveVerifyRegression(args), commitSubject: args.commit_subject ?? null, refactor: Boolean(args.refactor), workerId };
}
server.tool("local_worker", "Run one isolated local worker and wait for it. mode=implement edits in its own worktree and the coordinator commits only on a valid done report (or a recovered job that passed independent verification); failed or incomplete worktrees are retained. mode=scout answers a question from a read-only snapshot with mandatory [path:line] citations that nomArmy verifies and expands. mode=decompose (also read-only) proposes 2+ independent subtasks for a broad objective instead of one worker turn trying to do too much; the proposal is never auto-dispatched, review it and make a separate call with the subtasks you choose. Refuses under memory pressure or over capacity; use local_worker_start + local_worker_status to avoid blocking.", jobSchema.shape,
  async rawArgs => {
    const expanded = expandJobs([rawArgs]);
    if (expanded.problems.length) return refusal(expanded.problems);
    const [args] = expanded.jobs;
    const { problems } = await admit([args]);
    if (problems.length) return refusal(problems);
    const r = await launch(args).promise;
    return toolText(formatResult(r), !r.ok);
  });
server.tool("local_worker_start", "Start one worker or scout in the background and return immediately with a job_id. Poll it with local_worker_status (optionally long-polling with wait_seconds). Same admission rules as local_worker: refuses under memory pressure or when NOMARMY_MAX_WORKERS jobs are already running.", jobSchema.shape,
  async rawArgs => {
    const expanded = expandJobs([rawArgs]);
    if (expanded.problems.length) return refusal(expanded.problems);
    const [args] = expanded.jobs;
    const { problems, admission } = await admit([args]);
    if (problems.length) return refusal(problems);
    const entry = launch(args);
    return toolText(JSON.stringify({ started: true, jobId: entry.jobId, workerId: entry.workerId, mode: entry.mode, state: "running",
      jobDir: path.join(jobsRoot, entry.jobId), timeoutSeconds: args.timeout_seconds,
      poll: { tool: "local_worker_status", job_id: entry.jobId, wait_seconds: MAX_STATUS_WAIT_SECONDS },
      // This job's own lane and budget: a subscription job used to be
      // reported with the local model's figures.
      lane: jobLane(args), agent: args.agentName ?? "local", model: args.model ?? null,
      ...(args.run_id ? { run: runBrief(args.run_id) } : {}),
      admission: { level: admission.level, notes: admission.reasons }, budgets: describeBudgets(budgetsForJob(args)) }, null, 2));
  });
// A long poll must return inside the MCP client's own idle-timeout: it aborts
// a tool call after N seconds with no response or progress notification,
// independent of how long the underlying work actually takes. The reference
// client's default is well under a minute (observed: a 120-second wait had it
// abandon the request, and with it the server, while the worker ran on) --
// but that default can be raised per-server (a "timeout" (ms) field on this
// server's own entry in the client's MCP config) or globally
// (CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT). This constant must stay comfortably
// under whatever that idle-timeout is actually configured to on the client
// polling this server, with real margin for the response itself to be built
// and sent. Claude Code also moves any tool call still running at 120s to
// the background (reported from a real Senti run), which a 240s default
// always crossed; 110s returns in-line with margin. Raise it only for a
// client that neither backgrounds nor times out that early.
export const MAX_STATUS_WAIT_SECONDS = Number.parseInt(process.env.NOMARMY_MAX_STATUS_WAIT_SECONDS ?? "", 10) || 110;
server.tool("local_worker_status", `Status of one job started by this server: phase (starting, worktree, worker, verification, commit, record, finished), elapsed time against its timeout, and the result once finished. wait_seconds long-polls up to that long for completion (max ${MAX_STATUS_WAIT_SECONDS}, to stay inside MCP client request timeouts; poll again for longer jobs). full=true returns the complete formatted result instead of a summary.`, {
  job_id: z.string().min(1), wait_seconds: z.number().int().min(0).max(MAX_STATUS_WAIT_SECONDS).default(0), full: z.boolean().default(false)
}, async ({ job_id, wait_seconds, full }) => {
  const jobId = path.basename(job_id), entry = activeJobs.get(jobId), jobDir = path.join(ensureJobsRoot(), jobId);
  if (entry && !entry.settled && wait_seconds > 0) await Promise.race([entry.promise.catch(() => {}), sleep(wait_seconds * 1000)]);
  const files = { status: readJson(path.join(jobDir, "status.json")), meta: readJson(path.join(jobDir, "metadata.json")), failure: readJson(path.join(jobDir, "failure.json")) };
  if (!entry && !files.status && !files.meta && !files.failure) return toolText(`Unknown job: ${job_id}`, true);
  // A hard deadline on building the answer: live progress is best-effort,
  // and a status call must never hang (one did, for 35 minutes).
  const summary = await Promise.race([
    summarize(entry, files, jobDir),
    sleep(15000).then(() => summarize(entry, files, null)),
  ]);
  if (summary.state === "running") return toolText(JSON.stringify({ ...summary, jobDir, hint: `poll again with wait_seconds up to ${MAX_STATUS_WAIT_SECONDS}; lastTool/filesChangedLive are best-effort and may be absent early in a run` }, null, 2));
  if (entry?.error) return toolText(JSON.stringify({ ...summary, jobDir }, null, 2), true);
  if (full && entry?.result) return toolText(formatResult(entry.result), !entry.result.ok);
  if (full && files.meta) return toolText(JSON.stringify(files.meta, null, 2), summary.coordinatorStatus !== "complete");
  return toolText(JSON.stringify({ ...summary, jobDir, hint: entry?.result || files.meta ? "call again with full=true for the complete report" : null }, null, 2), summary.state === "orphaned" || summary.state === "failed");
});
server.tool("local_worker_capacity", "What this host can take right now: context per nom and the brief/report budgets derived from it, memory pressure and whether another job would be admitted, and the jobs currently running. Read-only.", {}, async () => {
  await budgetState.refresh();
  return toolText(JSON.stringify(capacitySnapshot(), null, 2));
});
// The only way to know what `verification`/`union_verification`/
// `verify_regression` profile names are actually valid for this repo used to
// be reading .nomarmy.yml by hand -- the same gap for a human landing in an
// unfamiliar repo as for the coordinator itself. Reuses lib/config.mjs's
// loadConfig(), the exact loader lib/verify.mjs's own runner uses (via its
// own default parameter), so what this reports can never drift out of sync
// with what a real job would actually resolve. `loadConfigFn` is injectable
// purely for testing; every real call uses the default (the real loader).
export function buildConfigSummary(repoDir, loadConfigFn = loadConfig) {
  let loaded;
  try { loaded = loadConfigFn(repoDir); }
  catch (error) {
    const detail = error instanceof ConfigError ? { path: error.path, errors: error.errors } : { path: null, errors: [error.message] };
    return { found: true, valid: false, ...detail,
      note: "A .nomarmy.yml exists but is not valid; every verification/union_verification/verify_regression request will report not_run until this is fixed." };
  }
  if (!loaded.found) {
    return { found: false, valid: null, path: null, profiles: [], elevated: loaded.elevated,
      note: "No .nomarmy.yml in this repository. Every verification/union_verification/verify_regression request will report not_run (not fail) until one is added." };
  }
  const profiles = Object.entries(loaded.config?.verification ?? {}).map(([name, p]) => ({ name, environment: p.environment ?? "none", commands: p.commands ?? [] }));
  return { found: true, valid: true, path: loaded.path, profiles, elevated: loaded.elevated,
    pythonRequirements: loaded.config?.environment?.python?.requirements ?? [],
    usedBy: "every job's sandbox image and every verification, whichever branch the job starts from: this checkout's copy, including uncommitted edits, never the job's own worktree copy",
    note: profiles.length ? null : ".nomarmy.yml exists but defines no verification profiles; verification/union_verification/verify_regression will report not_run." };
}
server.tool("run_start", "Start a /feature run (or reattach to one with `resume`): one feature, end to end, with limits. It becomes this session's active run: every job you dispatch from now on joins it automatically (pass run_id only to target a different run). Admission enforces the run's limits -- jobs, api spend in dollars, wall-clock hours -- warning at the configured share and refusing at the cap. A vendor usage-limit error pauses that agent for the rest of the run. Limits come from the operator's army run_limits; you may lower them for this run, never raise them. Returns the run id and a log path: keep the run log (plan, decisions, progress) there so a fresh session can resume if yours hits its own usage limit.", {
  name: z.string().min(1).max(120).optional().describe("A short name for the feature (required unless resuming)."),
  resume: z.string().regex(/^run-[a-z0-9-]{1,80}$/).optional().describe("Reattach this session to an existing, still-running run (e.g. after the previous session hit its own limit) instead of starting a new one."),
  max_jobs: z.number().int().positive().optional(), max_api_usd: z.number().positive().optional(), max_hours: z.number().positive().optional(),
}, async ({ name, resume, max_jobs, max_api_usd, max_hours }) => {
  try {
    if (resume) {
      const run = loadRun(runsRoot, resume);
      if (run.repo !== projectDir) return toolText(`run "${run.id}" belongs to ${run.repo}, not this repository`, true);
      if (run.status !== "running") return toolText(`run "${run.id}" is ${run.status}; start a new run instead`, true);
      activeRunId = run.id;
      return toolText(JSON.stringify({ runId: run.id, resumed: true, limits: run.limits, logPath: run.logPath, ...runTotals(run) }, null, 2));
    }
    if (!name) return toolText("run_start needs a name (or resume: <run-id>)", true);
    const configured = currentArmy().army.runLimits;
    const requested = { max_jobs, max_api_usd, max_hours };
    const limits = resolveRunLimits(configured, requested);
    const run = createRun(runsRoot, { name, repo: projectDir, limits });
    activeRunId = run.id;
    const notes = describeLoweredLimits(configured, requested, limits);
    return toolText(JSON.stringify({ runId: run.id, limits: run.limits, ...(notes.length ? { limitNotes: notes } : {}), logPath: run.logPath, repo: run.repo,
      note: "This is now the session's active run: every job you dispatch joins it automatically." }, null, 2));
  } catch (error) { return toolText(error.message, true); }
});
server.tool("run_status", "A /feature run's limits, what it has used (jobs, api spend, hours), per-agent jobs/spend/tokens, warnings (80% of a limit, paused agents), and its log path. Read-only.", {
  run_id: z.string().regex(/^run-[a-z0-9-]{1,80}$/),
}, async ({ run_id }) => {
  try {
    const run = loadRun(runsRoot, run_id);
    const totals = runTotals(run);
    // In-flight jobs, from the machine-wide leases: finished jobs are all
    // `jobs` shows, so a run with work in progress used to report 0.
    const running = liveLeases(leasesRoot, { runId: run.id }).map((l) => {
      const status = readJson(path.join(jobsRoot, l.jobId, "status.json")) ?? {};
      return { jobId: l.jobId, agent: l.agent, model: l.model, role: l.role, phase: status.phase ?? null, startedAt: l.startedAt,
        lastTool: status.lastTool ?? null, filesChangedLive: status.filesChangedLive ?? null, heartbeatAt: status.heartbeatAt ?? null };
    });
    return toolText(JSON.stringify({ id: run.id, name: run.name, status: run.status, repo: run.repo, createdAt: run.createdAt, limits: run.limits, ...totals, running, pausedAgents: run.pausedAgents, jobs: run.jobs, logPath: run.logPath, summary: run.summary }, null, 2));
  } catch (error) { return toolText(error.message, true); }
});
server.tool("run_finish", "Close a /feature run as complete or stopped, with a one-paragraph summary. A closed run admits no more jobs. Nothing is merged: the run's branch still waits for the operator.", {
  run_id: z.string().regex(/^run-[a-z0-9-]{1,80}$/), status: z.enum(["complete", "stopped"]), summary: z.string().min(1).max(4000),
}, async ({ run_id, status, summary }) => {
  try {
    const run = finishRun(runsRoot, run_id, { status, summary });
    if (activeRunId === run_id) activeRunId = null;
    return toolText(JSON.stringify({ id: run.id, status: run.status, ...runTotals(run) }, null, 2));
  } catch (error) { return toolText(error.message, true); }
});
server.tool("army", "Who you, the General, are and who you call for what in this repository: your fixed charter and the agent you're defined as, the army's workflow, then each role's description, phase (build, review, acceptance), suggested mode, and the agent it runs on, with which config layer set each value (global, project .nomarmy.yml, local .nomarmy.local.yml). Flags roles with no usable agent, and roles that share your model or subscription (not an independent review). Dispatch a role with `army_role`, or an agent directly with `agent`. Read-only, re-read on every call.", {}, async () => {
  try {
    const agents = agentsConfig().agents;
    const summary = describeArmy(currentArmy(), { agents, describeAgent });
    // Each agent's models, from OpenClaw's catalog, so the General can pick
    // one for a role set to "auto". The catalog can lag a brand-new model.
    const catalog = await modelCatalogReady();
    summary.agents = Object.fromEntries(Object.entries(agents).map(([name, agent]) => {
      const provider = agentProviderId(agent);
      const models = provider && catalog ? [...catalog.keys()].filter((k) => k.startsWith(`${provider}/`)).map((k) => k.slice(provider.length + 1)) : [];
      return [name, { runsOn: describeAgent(agent), defaultModel: agent.model ?? null, models }];
    }));
    // A pinned model missing from the catalog isn't necessarily wrong:
    // `army assign` proves an unlisted model with a real test call, and the
    // catalog lags new releases (grok-4.7 works while unlisted). Say which,
    // so a General doesn't conclude it doesn't exist.
    for (const role of Object.values(summary.roles)) {
      const listed = summary.agents[role.agent]?.models ?? [];
      if (role.model && !role.modelIsAuto && listed.length && !listed.includes(role.model)) {
        role.modelNote = `${role.model} isn't in OpenClaw's catalog for ${role.agent}; \`army assign\` checked it with a real test call when it was set, and the catalog can lag new models. Use it as assigned; if a job reports "Unknown model", reassign.`;
      }
    }
    return toolText(JSON.stringify(summary, null, 2));
  } catch (error) {
    return toolText(error.message, true);
  }
});
server.tool("local_worker_config", "What this checkout's .nomarmy.yml defines -- the one file every job's sandbox image and every verification uses, whichever branch the job starts from (never the job worktree's own copy, which a worker could edit): every verification profile name and its commands/environment, and any elevated (shared/remote) services that need explicit policy approval before a job may use them. Pass a profile name to `verification`/`union_verification`/`verify_regression` only if it appears here. Read-only; never writes or proposes a config (see `nomarmy scan` for that).", {}, async () => {
  const summary = buildConfigSummary(projectDir);
  return toolText(JSON.stringify(summary, null, 2), summary.valid === false);
});
server.tool("local_workers", "Run independent jobs (implement or scout) with bounded parallelism and wait for all of them. Every implement job receives its own branch, worktree, sandbox session, logs, validation, and coordinator-owned commit. This tool never merges any branch into the developer's branch. With auto_union: true, implement jobs that reach a valid outcome and touch non-overlapping files are additionally merged (git merge --no-ff) into ONE new integration branch -- a review artifact alongside the untouched per-job branches, still not the developer's branch, still reviewed and integrated explicitly. Jobs that overlap or did not finish validly are excluded from the union and reported individually exactly as without auto_union. For long batches prefer local_worker_start per job and poll.", {
  jobs: z.array(jobSchema).min(1).max(8), max_parallel: z.number().int().min(1).max(8).optional().describe("A cap on how many of this batch run at once. Omit it: local jobs then use the local ceiling and api/subscription jobs theirs (NOMARMY_MAX_POOL_WORKERS), with each agent's own max_concurrent on top. It used to default to the local ceiling, which ran an all-remote batch one job at a time."),
  auto_union: z.boolean().default(false).describe(
    "After all jobs finish, mechanically merge (git merge --no-ff) implement jobs that reached a valid outcome and touched non-overlapping files into ONE new integration branch for review -- never into the developer's branch. Overlapping or invalid-outcome jobs are excluded and still reported individually, unchanged. All jobs must share one base_ref (or omit it); it is resolved once, before any job starts, and forced onto every job so the union is provably rooted at a single base."
  ),
  union_verification: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).optional().describe(
    "Verification profile NAME to run once against the union branch after merging (same semantics as each job's own `verification` field). Only meaningful with auto_union: true. Omitted: union-level verification is explicitly not_run and reported as such, never silently skipped."
  )
}, async ({ jobs: rawJobs, max_parallel, auto_union, union_verification }) => {
  const expanded = expandJobs(rawJobs);
  if (expanded.problems.length) return refusal(expanded.problems);
  const { jobs } = expanded;
  const { problems } = await admit(jobs);
  let forcedBase = null;
  if (auto_union) {
    const refs = [...new Set(jobs.map(j => j.base_ref).filter(Boolean))];
    if (refs.length > 1) {
      problems.push(`auto_union requires every job to share one base_ref (or omit it); got: ${refs.join(", ")}`);
    } else if (!problems.length) {
      try { forcedBase = await resolveBase(refs[0]); }
      catch (error) { problems.push(`auto_union: could not resolve base ref: ${error.message}`); }
    }
  }
  if (problems.length) return refusal(problems);
  const batchId = slug("batch"), startedAt = new Date().toISOString();
  // Local and pool jobs draw from two independent ceilings (currentMaxWorkers
  // vs currentMaxPoolWorkers) for the same reason admit() checks them
  // separately -- a single shared `parallel` slot count derived only from
  // the local ceiling let an all-pool batch ignore NOMARMY_MAX_POOL_WORKERS
  // entirely. Each lane gets its own mapLimit call so its own ceiling is the
  // one actually enforced; results are scattered back into one array in the
  // caller's original order (mapLimit is itself index-preserving, so this is
  // just choosing which lane's mapLimit each original index belongs to).
  const results = new Array(jobs.length);
  const dispatchLane = async (indices, limit) => {
    if (!indices.length) return;
    const laneJobs = indices.map((i) => jobs[i]);
    const laneResults = await mapLimit(laneJobs, limit, (j, laneI) => {
      const i = indices[laneI];
      const workerId = j.worker_id || `${batchId}-w${i + 1}`, jobId = slug(workerId);
      const effectiveJob = auto_union ? { ...j, base_ref: forcedBase.sha } : j;
      // The lane is what admission counts; a batch job used to carry none,
      // so it was invisible to both ceilings while it ran.
      // A batch job waits for its agent's slot (up to its own timeout) rather
      // than failing because an earlier job in the same batch holds it.
      return trackInRun(j, track(jobId, { mode: j.mode, workerId, lane: jobLane(j), agent: j.agentName ?? null, runId: j.run_id ?? null, role: j.armyRole ?? null, model: j.model ?? null },
        withAgentSlot(j, jobId, () => executeJob({ ...jobArgs(effectiveJob, workerId), jobId }), { waitMs: (j.timeout_seconds ?? 600) * 1000 }))).promise;
    }, { staggerMs: WORKER_START_STAGGER_MS });
    indices.forEach((i, laneI) => { results[i] = laneResults[laneI]; });
  };
  const { localIndices, remoteIndices } = splitJobsByLane(jobs);
  const localParallel = Math.max(1, Math.min(max_parallel ?? Infinity, currentMaxWorkers() - runningCount("local")));
  const remoteParallel = Math.max(1, Math.min(max_parallel ?? Infinity, currentMaxPoolWorkers() - runningCount("remote")));
  await Promise.all([dispatchLane(localIndices, localParallel), dispatchLane(remoteIndices, remoteParallel)]);

  // Auto_union is entirely additive and must never suppress or corrupt the
  // real, already-completed per-job results below -- a broken union reports
  // its own error status, it does not throw out of this handler.
  let union = null;
  if (auto_union) {
    try {
      const { accepted, excluded } = selectUnionCandidates(results);
      union = await buildUnionBranch({ batchId, baseSha: forcedBase.sha, baseRef: forcedBase.ref, accepted, unionVerification: union_verification ?? null });
      union.jobsExcluded = excluded;
    } catch (error) {
      union = { version: VERSION, jobId: `${batchId}-union`, mode: "union", batchId, createdAt: new Date().toISOString(),
        status: "union_error", error: error.message, jobsUnioned: [], jobsExcluded: [] };
    }
  }

  const summary = { version: VERSION, batchId, startedAt, finishedAt: new Date().toISOString(), maxParallel: parallel, requestedParallel: max_parallel ?? null,
    total: results.length, complete: results.filter(r => r.ok).length, incomplete: results.filter(r => !r.ok).length,
    recovered: results.filter(r => r.manifest?.recovered).length,
    reviewRequired: results.filter(r => r.manifest?.reviewRequired).length,
    jobs: results.map(r => ({ jobId: r.manifest.jobId, workerId: r.manifest.workerId, mode: r.manifest.mode, outcome: r.manifest.outcome || OUTCOMES.WORKER_FAILED, recovered: Boolean(r.manifest.recovered), status: r.manifest.coordinatorStatus || "failed", branch: r.manifest.branch, commit: r.manifest.commit?.sha || null, worktree: r.manifest.worktree, jobDir: r.jobDir })),
    ...(union ? { union } : {}) };
  const unionSection = union ? `UNION\n\n${formatUnion(union)}\n\n` : "";
  const text = `BATCH EXECUTION RECORD\n${JSON.stringify(summary, null, 2)}\n\n${unionSection}WORKER RESULTS\n\n${results.map((r, i) => `===== WORKER ${i + 1} =====\n${formatResult(r)}`).join("\n\n")}`;
  return toolText(text, results.some(r => !r.ok) || union?.status === "union_verification_failed" || union?.status === "union_error");
});
// No model, no sandbox, no tokens spent on a worker: the coordinator asks the
// repository directly and gets [path:line] on every hit. Use this before a
// scout, and instead of one for anything a grep or an outline can answer.
server.tool("repo_evidence", `Deterministic repository evidence with exact [path:line] citations and no model involved. ops: ${EVIDENCE_OPS.join(", ")}. definitions/references take a symbol in 'query' (heuristic per language family); outline takes 'path'; grep takes a regex in 'query'; files takes a glob. Runs against the project working tree in milliseconds. Prefer this over reading files for where-is / who-calls / what-declares questions, and over a scout for anything it can answer.`, {
  op: z.enum(EVIDENCE_OPS), query: z.string().min(1).max(500).optional(), path: z.string().min(1).max(1024).optional(), glob: z.string().min(1).max(200).optional(),
  max_results: z.number().int().min(1).max(1000).default(100), ignore_case: z.boolean().default(false), whole_word: z.boolean().default(false), json: z.boolean().default(false)
}, async args => {
  try {
    const result = runQuery(projectDir, args.op, args);
    return toolText(args.json ? JSON.stringify(result, null, 2) : formatCitations(result));
  } catch (error) { return toolText(`repo_evidence ${args.op}: ${error.message}`, true); }
});
server.tool("local_worker_jobs", "List recent job records for review/recovery, including jobs still running or orphaned by a server restart. Does not modify repositories. Returns a small PROJECTION per job by default (jobId, outcome, branch/commit, worktreeRetained, filesChanged, timing, issues) -- enough to decide what needs recovery or cleanup without pulling every job's full execution record (objective text, budgets, git records, ...) into context, which can exceed the tool result size past a handful of jobs. Pass full: true only for the specific job(s) you already know need deep inspection.", { limit: z.number().int().min(1).max(50).default(10), full: z.boolean().default(false).describe("Return each job's complete, uncompacted manifest instead of the small default projection. Requesting this across many jobs at once risks exceeding the tool result size cap -- prefer the default projection first, then a targeted look (e.g. local_worker_status) at just the job(s) that need it.") }, async ({ limit, full }) => {
  const dirs = fs.readdirSync(ensureJobsRoot(), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort().reverse().slice(0, limit);
  const rows = await Promise.all(dirs.map(async name => {
    const dir = path.join(jobsRoot, name);
    const meta = readJson(path.join(dir, "metadata.json")) ?? readJson(path.join(dir, "failure.json"));
    if (meta) return full ? meta : compactJobRecord(meta);
    const status = readJson(path.join(dir, "status.json"));
    if (status) return summarize(activeJobs.get(name) ?? null, { status, meta: null, failure: null }, dir);
    return { jobId: name, state: "unknown" };
  }));
  return toolText(JSON.stringify(rows, null, 2));
});
// The sandbox writes skill/guardrail files under .openclaw/ with permissions
// meant to stop the SANDBOXED AGENT from deleting them. On macOS, the
// container engine's bind-mount translation can carry that protection through
// to the host as an ACE (e.g. "deny delete") that also blocks the host-side
// coordinator from removing the worktree during cleanup -- observed with
// Docker Desktop; not yet re-confirmed against Podman specifically, but the
// fix here is generic (it strips whatever lock is present, from either) so it
// costs nothing if Podman never reproduces it. By cleanup time the sandbox
// has already exited, so it is safe to strip here; best-effort and non-fatal,
// since a worktree with no such lock has nothing to clear.
async function releaseSandboxLocks(dir) {
  if (process.platform === "darwin") {
    await run("chmod", ["-R", "-N", dir], { cwd: projectDir }).catch(() => {});
  } else {
    await run("chmod", ["-R", "u+rwX", dir], { cwd: projectDir }).catch(() => {});
    await run("setfacl", ["-R", "-b", dir], { cwd: projectDir }).catch(() => {});
  }
}
// metadata.json/failure.json name a job's worktree/branch explicitly once it
// finishes, but a job interrupted before either was ever written (a server
// restart mid-run is the common case, since activeJobs is in-memory only)
// leaves no such record. Both paths are deterministic functions of jobId --
// the same ones executeImplement/executeScout use -- so cleanup can still
// find them without one.
export function resolveCleanupTarget({ jobDir, jobId, meta, status }) {
  if (meta) return { worktree: meta.worktree ?? path.join(jobDir, "worktree"), branch: meta.branch ?? null };
  if (status) return { worktree: path.join(jobDir, "worktree"), branch: status.mode === "implement" ? `agent/${jobId}` : null };
  return null;
}
// .npm/, .openclaw/ etc. are the sandbox's own runtime junk (isRuntimeJunk),
// never real worker output, but `git worktree remove` refuses on ANY
// untracked file, so a worktree with nothing else left over would otherwise
// need --force just because of this cruft. Clearing it first lets an
// ordinary removal succeed when that really is all that's left; a worktree
// with genuine uncommitted content still requires the caller to pass force.
export async function stripRuntimeJunk(worktree) {
  try {
    const statusOut = await gitRaw(["status", "--porcelain=v1", "-z", "--untracked-files=all"], worktree);
    for (const entry of parseStatusPorcelainZ(statusOut)) {
      if (isRuntimeJunk(entry.file)) fs.rmSync(path.join(worktree, entry.file), { recursive: true, force: true });
    }
  } catch { /* best-effort; falls through to the normal remove attempt */ }
}
// `git branch -d` refuses unless <branch> is an ANCESTOR of HEAD -- true for
// a `git merge`d branch, never true for a cherry-picked one, which is
// nomArmy's own integration model (the coordinator reviews/corrects before
// committing; see CLAUDE.md's "Integration"). A real incident this fixes:
// every genuinely-integrated job cleanup needed `force: true` regardless,
// which makes force routine instead of the "I am discarding something"
// signal it exists to be. `git cherry <upstream> <head>` compares by PATCH
// CONTENT, not commit ancestry -- for each commit unique to <head>, "-"
// means an equivalent patch already exists in <upstream>'s history. A
// branch where every commit shows "-" is content-integrated even though
// git's own ancestry check says otherwise, and is safe to hard-delete
// without the caller having to assert `force` for something that isn't
// actually a discard.
export async function isBranchContentIntegrated(branch, cwd) {
  const out = await git(["cherry", "HEAD", branch], cwd);
  const lines = out.split("\n").filter(Boolean);
  // No commits unique to `branch` at all (already an ancestor, or branch IS
  // HEAD) -- trivially integrated; `git branch -d` itself would have
  // succeeded on this case anyway.
  if (lines.length === 0) return true;
  return lines.every((line) => line.startsWith("-"));
}
// A job's worktree/branch holds NOTHING worth a human decision when its
// branch tip is byte-identical to the base SHA it started from (zero
// commits -- exactly "agent/worker-X tip=c6588ffe already-in-branch", a
// real finding: 4 such worktrees, 8 hours old, ~164MB, holding only an
// ISOLATION_PROBE.txt and a stray .venv) AND the live worktree has no
// uncommitted changes either (a worker that edited files but was never
// committed still deserves a human look -- retaining THAT is correct, not
// clutter). Both facts are checked live against Git, never trusted from a
// stored manifest that could be stale.
export function isProvablyEmptyJob({ branchTipSha, baseSha, workingTreeDirty }) {
  if (!branchTipSha || !baseSha) return false; // nothing to compare -- never guess "safe"
  if (branchTipSha !== baseSha) return false; // real commits exist on this branch
  return !workingTreeDirty;
}
server.tool("local_worker_sweep", "Bulk-reap job worktrees/branches that are PROVABLY EMPTY: the branch's tip is identical to the base SHA it started from (zero commits) AND the worktree has no uncommitted changes left either -- there is nothing here to inspect, recover, or lose. Never removes a worktree holding any real committed or uncommitted work, regardless of age or older_than_hours -- emptiness is what makes it safe, not age. A worktree with real work always stays a deliberate, individual local_worker_cleanup call. Use dry_run first to see what would be reaped.", {
  older_than_hours: z.number().min(0).default(0).describe("Only consider jobs finished (or, if never finished, last touched) at least this many hours ago. 0 (default) considers every job regardless of age."),
  delete_branches: z.boolean().default(true).describe("Also delete each reaped job's branch. Safe unconditionally here (never force) -- a branch identical to its base SHA is trivially git's own definition of already-merged."),
  dry_run: z.boolean().default(false).describe("Report what WOULD be reaped without removing anything."),
  limit: z.number().int().min(1).max(500).default(200).describe("Maximum number of job directories to examine in one call.")
}, async ({ older_than_hours, delete_branches, dry_run, limit }) => {
  await assertRepo();
  const dirs = fs.readdirSync(ensureJobsRoot(), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort().slice(0, limit);
  const cutoffMs = older_than_hours > 0 ? Date.now() - older_than_hours * 3600 * 1000 : null;
  const reaped = [], skipped = [];
  for (const jobId of dirs) {
    const jobDir = path.join(jobsRoot, jobId);
    const metaPath = path.join(jobDir, "metadata.json"), failPath = path.join(jobDir, "failure.json");
    const p = fs.existsSync(metaPath) ? metaPath : (fs.existsSync(failPath) ? failPath : null);
    const meta = p ? readJson(p) : null;
    const target = resolveCleanupTarget({ jobDir, jobId, meta, status: meta ? null : readJson(path.join(jobDir, "status.json")) });
    if (!target?.worktree || !fs.existsSync(target.worktree)) continue; // nothing here to reap at all
    const { worktree, branch } = target;
    let finishedAtMs;
    try { finishedAtMs = meta?.finishedAt ? Date.parse(meta.finishedAt) : fs.statSync(jobDir).mtimeMs; }
    catch { finishedAtMs = Date.now(); }
    if (cutoffMs !== null && finishedAtMs > cutoffMs) { skipped.push({ jobId, reason: "younger than older_than_hours" }); continue; }
    const baseSha = meta?.git?.baseSha ?? meta?.baseSha ?? null;
    let branchTipSha = null;
    if (branch) { try { branchTipSha = (await git(["rev-parse", branch], projectDir)).trim(); } catch { branchTipSha = null; } }
    let workingTreeDirty = true; // never guess "clean" if the check itself failed
    try {
      const statusOut = await gitRaw(["status", "--porcelain=v1", "-z", "--untracked-files=all"], worktree);
      workingTreeDirty = parseStatusPorcelainZ(statusOut).some((e) => !isRuntimeJunk(e.file));
    } catch { workingTreeDirty = true; }
    if (!isProvablyEmptyJob({ branchTipSha, baseSha, workingTreeDirty })) {
      skipped.push({ jobId, reason: !baseSha ? "no recorded base SHA to compare against" : branchTipSha !== baseSha ? "branch has real commits" : "worktree has uncommitted changes" });
      continue;
    }
    if (dry_run) { reaped.push({ jobId, worktree, branch, dryRun: true }); continue; }
    try {
      await releaseSandboxLocks(worktree);
      await stripRuntimeJunk(worktree);
      await run("git", ["worktree", "remove", worktree], { cwd: projectDir });
      let branchDeleted = false;
      if (delete_branches && branch) {
        const current = await git(["branch", "--show-current"]);
        // Identical SHA to its base is trivially git's own ancestor
        // definition -- plain `-d`, no force needed, ever, here.
        if (current !== branch) { await run("git", ["branch", "-d", branch], { cwd: projectDir }); branchDeleted = true; }
      }
      reaped.push({ jobId, worktree, branch, branchDeleted });
    } catch (error) {
      skipped.push({ jobId, reason: `removal failed: ${error.message}` });
    }
  }
  return toolText(JSON.stringify({ examined: dirs.length, reapedCount: reaped.length, skippedCount: skipped.length, dryRun: dry_run, reaped, skipped }, null, 2));
});
server.tool("local_worker_cleanup", "Remove a retained worker worktree and optionally its agent branch after Claude has reviewed/integrated or deliberately discarded it. Refuses to delete the current branch. A branch whose commits were cherry-picked (not merged) into the current branch -- nomArmy's own integration model -- is recognized as integrated by comparing PATCH CONTENT (git cherry), not git's own ancestry-only check, so a genuinely-integrated job's cleanup does not need force: true. Reserve force for a branch you are actually discarding unintegrated work from.", {
  job_id: z.string().min(1), delete_branch: z.boolean().default(false), force: z.boolean().default(false)
}, async ({ job_id, delete_branch, force }) => {
  await assertRepo();
  const jobId = path.basename(job_id), jobDir = path.join(ensureJobsRoot(), jobId);
  const metaPath = path.join(jobDir, "metadata.json"), failPath = path.join(jobDir, "failure.json");
  const p = fs.existsSync(metaPath) ? metaPath : (fs.existsSync(failPath) ? failPath : null);
  const meta = p ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
  const status = meta ? null : readJson(path.join(jobDir, "status.json"));
  const target = resolveCleanupTarget({ jobDir, jobId, meta, status });
  if (!target) throw new Error(`Unknown job: ${job_id}`);
  const { worktree, branch } = target;
  if (worktree && fs.existsSync(worktree)) {
    await releaseSandboxLocks(worktree);
    if (!force) await stripRuntimeJunk(worktree);
    await run("git", ["worktree", "remove", ...(force ? ["--force"] : []), worktree], { cwd: projectDir });
  }
  let branchDeleteMode = null;
  if (delete_branch && branch) {
    const current = await git(["branch", "--show-current"]);
    if (current === branch) throw new Error("Refusing to delete current branch");
    if (force) {
      branchDeleteMode = "forced";
      await run("git", ["branch", "-D", branch], { cwd: projectDir });
    } else {
      try {
        await run("git", ["branch", "-d", branch], { cwd: projectDir });
        branchDeleteMode = "merged";
      } catch (error) {
        if (!(await isBranchContentIntegrated(branch, projectDir))) throw error;
        branchDeleteMode = "content-integrated";
        await run("git", ["branch", "-D", branch], { cwd: projectDir });
      }
    }
  }
  return toolText(JSON.stringify({ jobId: job_id, removedWorktree: worktree || null, deletedBranch: delete_branch ? branch : null, branchDeleteMode }, null, 2));
});

const isMain = (() => { try { return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  ensureJobsRoot();
  // Independent verification runs the repository's own verification profile
  // inside the Podman sandbox. Registered only for the real server: unit tests
  // import this module and inject their own runner, and an unregistered runner
  // yields `not_run`, which can never produce a recovered success.
  const { createVerificationRunner } = await import("../lib/verify.mjs");
  // The environment contract is the operator's checkout's .nomarmy.yml --
  // what local_worker_config shows -- never the job worktree's copy: a
  // job cut from a branch without the file ran with no contract at all (a
  // real Senti run on `refinement`: no Python requirements, so no ruff or
  // sqlglot, so verification could never pass), and a worker could edit its
  // own worktree's copy to weaken the checks that judge it.
  registerVerificationRunner(createVerificationRunner({ hostProjectDir: projectDir, loadConfig: () => loadConfig(projectDir) }));
  // Warm the budget from the profile or the running llama-server. Not awaited:
  // admission refreshes it anyway, and a slow hardware probe must not delay
  // the MCP handshake.
  budgetState.refresh().catch(() => {});
  // Start the model-catalog refresh now, so it's ready by the first
  // `army` call or remote job rather than kicked off by it.
  try { ensureCatalogRefresh(); } catch { /* best-effort */ }
  // Health checks (lib/health.mjs): soon after start, then every 6 hours.
  // New warnings notify once across all sessions; the status line shows
  // them. Unref'd, so they never keep the process alive.
  const runHealth = () => checkAndRecordHealth({ projectDir, stateRoot, configDir: globalConfigDir() })
    .then(({ toNotify }) => { for (const i of toNotify) notify(`nomArmy: ${i.title}`, `${i.detail} Fix: ${i.fix}`); })
    .catch(() => {});
  setTimeout(runHealth, 60000).unref();
  setInterval(runHealth, 6 * 3600000).unref();
  // Catches accumulation from a session that ended without a job ever
  // running again (a crash, a Podman machine restart) rather than waiting
  // for the next job to trigger the per-job sweep in executeJob.
  sweepStaleSandboxContainers().catch(() => {});
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
