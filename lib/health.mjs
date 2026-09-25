// nomArmy health checks: the mechanical problems that have actually bitten
// a real run, found before they fail one. Deterministic, no model, cheap;
// every external command is async and time-limited, so a check can never
// stall the server that runs it.
//
//   login-expiry     an OAuth login (the ChatGPT plan's Codex import) about
//                    to expire or already expired
//   openclaw-update  OpenClaw older than npm's latest (a stale 2026.9.5
//                    catalog made gpt-6-sol look unavailable)
//   plugin-skew      an OpenClaw plugin older than OpenClaw itself
//   army             a role or the General pointing at something unusable
//   config           agents.yml unloadable or unsafe
//   leftovers        retained worktrees, job storage, stale "running" jobs
//
// Each issue: { id, severity: "error"|"warn"|"info", title, detail, fix,
// short }. `id` is stable across runs, so a notification goes out once per
// issue rather than on every check; `short` is what the status line shows.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { executionMode } from "./execution.mjs";
import { modelRejection } from "./openclaw-errors.mjs";
import { providerConfigured, readOpenclawConfig } from "./openclaw-config.mjs";

const DAY = 86400000;

/** Run a command asynchronously, bounded; resolves { ok, stdout }. Never rejects. */
export function runBounded(cmd, args, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => resolve({ ok: !error, stdout: stdout ?? "" }));
  });
}

const versionOf = (text) => /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ""))?.slice(1, 4).map(Number) ?? null;
const older = (a, b) => { for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] < b[i]; } return false; };

/** OAuth profiles near or past expiry, from `openclaw models auth list --json`. */
export function loginExpiryIssues(authJson, { now = Date.now(), warnDays = 7 } = {}) {
  const issues = [];
  for (const p of authJson?.profiles ?? []) {
    const at = Date.parse(p.expiresAt ?? "");
    if (!Number.isFinite(at)) continue;
    const days = Math.floor((at - now) / DAY);
    const who = p.provider === "openai" ? "Codex (ChatGPT plan)" : p.provider;
    const fix = p.provider === "openai" ? "nomarmy agents add subscription codex  (then replace the existing codex agent)" : `openclaw models auth login --provider ${p.provider}`;
    if (at <= now) issues.push({ id: `login-expired:${p.id}`, severity: "error", title: `${who} login has expired`, detail: `Auth profile ${p.provider} expired ${new Date(at).toISOString().slice(0, 10)}; every job on it will fail.`, fix, short: `${p.provider} login expired` });
    else if (at - now <= warnDays * DAY) issues.push({ id: `login-expiring:${p.id}`, severity: "warn", title: `${who} login expires in ${days} day${days === 1 ? "" : "s"}`, detail: `Auth profile ${p.provider} expires ${new Date(at).toISOString().slice(0, 10)}.`, fix, short: `${p.provider} login ${days}d` });
  }
  return issues;
}

/** OpenClaw behind npm's latest, and plugins behind OpenClaw. */
export function versionIssues({ installed, latest, plugins = [] }) {
  const issues = [];
  const have = versionOf(installed), want = versionOf(latest);
  if (have && want && older(have, want)) {
    issues.push({ id: `openclaw-update:${want.join(".")}`, severity: "info", title: `OpenClaw ${want.join(".")} is out (you have ${have.join(".")})`,
      detail: "Its bundled model catalog lags new models; an old one made a working model look unavailable and budgeted new ones at the 32k fallback.",
      fix: "npm update -g openclaw && openclaw doctor --fix  (when no nomArmy jobs are running)", short: "openclaw update" });
  }
  for (const p of plugins) {
    const pv = versionOf(p.version);
    if (have && pv && older(pv, have)) {
      issues.push({ id: `plugin-skew:${p.id}:${pv.join(".")}`, severity: "info", title: `OpenClaw's ${p.id} plugin (${pv.join(".")}) is older than OpenClaw (${have.join(".")})`,
        detail: "OpenClaw tries to upgrade it on its own and warns while no matching version is published; the installed one keeps working meanwhile.",
        fix: `openclaw update repair  (once @openclaw/${p.id} ${have.join(".")} is published)`, short: null });
    }
  }
  return issues;
}

/** Roles, and the General, pointing at something unusable (from describeArmy's summary). */
export function armyIssues(summary, mode = "local") {
  const issues = [];
  if (summary?.general?.problem) issues.push({ id: "army:general", severity: "warn", title: "The General's agent isn't set up", detail: summary.general.problem, fix: "nomarmy army general <agent>", short: null });
  for (const [role, r] of Object.entries(summary?.roles ?? {})) {
    if (r.problem) issues.push({ id: `army:role:${role}:${r.problem}`, severity: "warn", title: `Role ${role} can't be dispatched`, detail: r.problem, fix: `nomarmy army assign ${role} <agent> [model|auto]`, short: `${role} unusable` });
    else if (mode === "hosted" && r.agent === "local") issues.push({ id: `army:hosted-local:${role}`, severity: "warn",
      title: `Role ${role} uses the local agent in hosted mode`,
      detail: "Hosted installs have no local model, so jobs for this role will be refused.",
      fix: `nomarmy army assign ${role} <agent> [model] or nomarmy army init --agent <name>`, short: `${role} uses local` });
    else if (r.hostTools?.implementRole && !r.hostTools.allowed) issues.push({ id: `army:host-tools:${role}:${r.agent}`, severity: "warn",
      title: `Role ${role} builds on ${r.agent}, whose tools run on this machine`,
      detail: `${r.agent}'s worker runs its own shell on your machine, with your files and the network, outside nomArmy's sandbox, so nomArmy refuses implement jobs on it.`,
      fix: `nomarmy army assign ${role} <a sandboxed agent> [model], or set allow_host_tools: true on ${r.agent} in agents.yml to accept it`, short: `${role} unsandboxed` });
  }
  return issues;
}

/**
 * Models the provider refused (model_not_found, "Unknown model") on a real job in the last day,
 * from job records. A listed model isn't proof it runs: Muse was listed
 * while every job on it failed this way (a real Senti review).
 */
export function unknownModelIssues(jobRecords, { now = Date.now(), inUse = null, probedOk = {} } = {}) {
  const failed = new Map(), lastOk = new Map(Object.entries(probedOk));
  for (const m of jobRecords) {
    const at = Date.parse(m.finishedAt ?? "");
    if (now - at > DAY) continue;
    const text = `${m.workerError ?? ""} ${m.worker?.error ?? ""}`;
    // A job's own model_not_found line first (mcp/server.mjs names the model
    // it attempted), then any raw vendor wording in older records.
    const tagged = /model_not_found: ([\w.-]+\/[\w.:-]+)/.exec(text)?.[1];
    const model = (tagged ?? modelRejection(text)?.model)?.replace(/[.:]+$/, ""); // the sentence's own trailing period isn't part of the name
    if (model) { const f = failed.get(model) ?? { n: 0, last: 0 }; f.n++; f.last = Math.max(f.last, at); failed.set(model, f); }
    else if (m.worker?.provider && m.worker?.model && !m.workerError) {
      const ran = `${m.worker.provider}/${m.worker.model}`;
      lastOk.set(ran, Math.max(lastOk.get(ran) ?? 0, at));
    }
  }
  // Fixed since: a later job on it ran, or no role uses it any more.
  return [...failed].filter(([model, f]) => !(lastOk.get(model) > f.last) && !(inUse && !inUse.has(model))).map(([model, { n }]) => ({ id: `unknown-model:${model}`, severity: "warn",
    title: `${model} failed as an unknown or unsupported model on ${n} job${n === 1 ? "" : "s"} today`,
    detail: "OpenClaw or the provider won't run it (it may still be listed in the catalog), so every role on it fails.",
    fix: "nomarmy agents list (see which roles use it), then nomarmy army assign <role> <another agent> [model]", short: `${model.split("/").pop()} not running` }));
}

/**
 * Subscription agents whose provider has no entry in OpenClaw's config,
 * for vendors whose plugin writes one (lib/openclaw-config.mjs): every
 * model on them is listed but fails "Unknown model".
 */
export function providerConfigIssues({ agents = {}, openclawConfig = null, vendors = {} }) {
  if (!openclawConfig) return [];
  const issues = [];
  for (const [vendorKey, vendor] of Object.entries(vendors)) {
    if (!vendor.plugin?.providerConfig) continue;
    const users = Object.entries(agents).filter(([, a]) => a?.kind === "subscription" && a.provider === vendor.provider).map(([n]) => n);
    if (!users.length || providerConfigured(openclawConfig, vendor.provider)) continue;
    issues.push({ id: `provider-config:${vendor.provider}`, severity: "warn",
      title: `OpenClaw has no ${vendor.provider} provider entry, so ${users.join(", ")} can't run`,
      detail: `Its models are listed (the catalog asks ${vendor.provider} directly) but every job fails "Unknown model": the key is linked, the provider's config isn't.`,
      fix: `nomarmy agents add subscription ${vendorKey}  (adds it with the plugin's own setup step)`, short: `${vendor.provider} not set up` });
  }
  return issues;
}

/**
 * A real test call that worked (`army assign`, `agents update --probe`), in
 * the shared probe-ok.json: it clears a model's earlier failure warning the
 * same way a later successful job does.
 */
export function recordProbeSuccess(stateRoot, model, { now = Date.now() } = {}) {
  const file = path.join(stateRoot, "probe-ok.json");
  let seen = {};
  try { seen = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* first */ }
  seen[model] = new Date(now).toISOString();
  try { fs.writeFileSync(file, JSON.stringify(seen, null, 2)); } catch { /* best-effort */ }
}
function readProbeSuccesses(stateRoot) {
  try { return Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(stateRoot, "probe-ok.json"), "utf8"))).map(([k, v]) => [k, Date.parse(v)])); } catch { return {}; }
}

/**
 * Whether `model` ("provider/model") was refused on a job in the last day
 * with nothing working on it since -- the admission check that stops a
 * second job going to a model the vendor already rejected (gpt-6-sol on a
 * ChatGPT plan failed job after job before health noticed). The issue, or null.
 */
export function recentModelRefusal(stateRoot, model, { now = Date.now() } = {}) {
  const jobsRoot = path.join(stateRoot, "jobs");
  const records = [];
  let names = [];
  try { names = fs.readdirSync(jobsRoot); } catch { return null; }
  for (const name of names) {
    const file = path.join(jobsRoot, name, "metadata.json");
    try { if (now - fs.statSync(file).mtimeMs < DAY) records.push(JSON.parse(fs.readFileSync(file, "utf8"))); } catch { /* unfinished */ }
  }
  return unknownModelIssues(records, { now, probedOk: readProbeSuccesses(stateRoot) }).find((i) => i.id === `unknown-model:${model}`) ?? null;
}

/** Job storage and leftovers. */
export function leftoverIssues({ retainedWorktrees = 0, jobsBytes = 0, staleRunning = 0 }) {
  const issues = [];
  if (retainedWorktrees >= 15) issues.push({ id: `leftovers:worktrees:${Math.floor(retainedWorktrees / 15)}`, severity: "info", title: `${retainedWorktrees} job worktrees are being kept`, detail: "Failed and incomplete jobs keep their worktree for review; they add up.", fix: "local_worker_sweep (empty ones), local_worker_cleanup (reviewed ones)", short: null });
  if (jobsBytes >= 2 * 1024 ** 3) issues.push({ id: `leftovers:storage:${Math.floor(jobsBytes / 1024 ** 3)}`, severity: "warn", title: `Job storage is ${(jobsBytes / 1024 ** 3).toFixed(1)} GB`, detail: "Mostly per-job runtime directories (npm caches, harness state).", fix: "nomarmy jobs --prune --older-than 0  (removes runtime data from every finished job now; records and reports stay, only saved transcripts go). Finished jobs older than a day are pruned on their own, so what's left is recent jobs and kept worktrees (local_worker_sweep / local_worker_cleanup).", short: `jobs ${(jobsBytes / 1024 ** 3).toFixed(0)}GB` });
  if (staleRunning > 0) issues.push({ id: `leftovers:stale:${staleRunning}`, severity: "info", title: `${staleRunning} job${staleRunning === 1 ? "" : "s"} still marked running by a server that's gone`, detail: "Its outcome is unknown; its worktree may hold work.", fix: "nomarmy jobs (shows them as orphaned), then review or clean up", short: null });
  return issues;
}

/**
 * Run every check. `env` supplies what each needs, with real defaults;
 * tests pass their own.
 */
export async function runHealthChecks({ now = Date.now(), mode = "local", openclawCmd = process.env.NOMARMY_OPENCLAW_CMD || "openclaw", run = runBounded, armySummary = null, agentsError = null, jobsRoot = null, pidAlive = () => true, agents = null, openclawConfig = null, vendors = {}, modelsInUse = null, autoPruned = null } = {}) {
  const issues = [];
  if (autoPruned?.freedBytes) issues.push({ id: `auto-prune:${new Date(now).toISOString()}`, severity: "info",
    title: `Freed ${(autoPruned.freedBytes / 1024 ** 3).toFixed(2)} GB: ${[autoPruned.pruned ? `runtime data of ${autoPruned.pruned} finished job${autoPruned.pruned === 1 ? "" : "s"} older than ${autoPruned.olderThanHours}h` : null, autoPruned.scratchCleared ? `OpenClaw scratch files of ${autoPruned.scratchCleared} more` : null].filter(Boolean).join(", ")}`,
    detail: "Automatic; each job's record and report are kept. NOMARMY_AUTO_PRUNE_HOURS sets the age (0 turns it off).", fix: null, short: null });
  if (agents) issues.push(...providerConfigIssues({ agents, openclawConfig, vendors }));
  const [auth, version, latest, plugins] = await Promise.all([
    run(openclawCmd, ["models", "auth", "list", "--json"]),
    run(openclawCmd, ["--version"]),
    run("npm", ["view", "openclaw", "version"], { timeoutMs: 15000 }),
    run(openclawCmd, ["plugins", "inspect", "codex"]),
  ]);
  if (auth.ok) { try { issues.push(...loginExpiryIssues(JSON.parse(auth.stdout.slice(auth.stdout.indexOf("{"))), { now })); } catch { /* unparseable: skip */ } }
  const pluginVersion = /Version:\s*(\S+)/.exec(plugins.stdout ?? "")?.[1];
  if (version.ok) issues.push(...versionIssues({ installed: version.stdout, latest: latest.ok ? latest.stdout : null, plugins: pluginVersion ? [{ id: "codex", version: pluginVersion }] : [] }));
  if (agentsError) issues.push({ id: `config:agents:${agentsError}`, severity: "error", title: "agents.yml can't be loaded", detail: agentsError, fix: "nomarmy agents list (shows the problem)", short: "agents.yml broken" });
  if (armySummary) issues.push(...armyIssues(armySummary, mode));
  if (jobsRoot) {
    let retainedWorktrees = 0, jobsBytes = 0, staleRunning = 0;
    const records = [];
    let names = [];
    try { names = fs.readdirSync(jobsRoot); } catch { /* none */ }
    for (const name of names) {
      const dir = path.join(jobsRoot, name);
      if (fs.existsSync(path.join(dir, "worktree"))) retainedWorktrees++;
      try { const st = fs.statSync(path.join(dir, "metadata.json")); if (now - st.mtimeMs < DAY) records.push(JSON.parse(fs.readFileSync(path.join(dir, "metadata.json"), "utf8"))); } catch { /* not finished */ }
      try {
        const status = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8"));
        if (status.state === "running" && !pidAlive(status.serverPid)) staleRunning++;
      } catch { /* no status */ }
    }
    const du = await run("du", ["-sk", jobsRoot], { timeoutMs: 30000 });
    if (du.ok) jobsBytes = (Number(du.stdout.split(/\s/)[0]) || 0) * 1024;
    issues.push(...unknownModelIssues(records, { now, inUse: modelsInUse, probedOk: readProbeSuccesses(path.dirname(jobsRoot)) }));
    issues.push(...leftoverIssues({ retainedWorktrees, jobsBytes, staleRunning }));
  }
  const rank = { error: 0, warn: 1, info: 2 };
  issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return { checkedAt: new Date(now).toISOString(), issues };
}

/**
 * Save results to the shared health.json, returning the issues that are new
 * enough to notify about: warn/error ones not notified in the last day by
 * any session's server (several sessions run checks; one notification each).
 */
export function recordHealth(file, result, { now = Date.now() } = {}) {
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* first run */ }
  const notified = { ...(prev.notified ?? {}) };
  const toNotify = [];
  for (const issue of result.issues) {
    if (issue.severity === "info") continue;
    if (!notified[issue.id] || now - Date.parse(notified[issue.id]) > DAY) { toNotify.push(issue); notified[issue.id] = new Date(now).toISOString(); }
  }
  for (const id of Object.keys(notified)) if (now - Date.parse(notified[id]) > 7 * DAY) delete notified[id];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...result, notified }, null, 2));
  fs.renameSync(`${file}.tmp`, file);
  return toNotify;
}

/**
 * Everything a check run needs, gathered the same way for the server's
 * periodic run and `nomarmy health`, then run and recorded to the shared
 * health.json. Returns { result, toNotify }.
 */
export async function checkAndRecordHealth({ projectDir, stateRoot, configDir, now = Date.now(), env = process.env }) {
  const { loadAgents, describeAgent, agentProviderId } = await import("./agents.mjs");
  const { loadArmy, describeArmy } = await import("./army.mjs");
  const { pidAlive } = await import("./slots.mjs");
  let agents = null, agentsError = null, armySummary = null;
  try { agents = loadAgents(configDir).agents; } catch (error) { agentsError = String(error.message).split("\n")[0]; }
  if (agents) { try { armySummary = describeArmy(loadArmy({ projectDir }), { agents, describeAgent }); } catch (error) { agentsError = agentsError ?? `army: ${String(error.message).split("\n")[0]}`; } }
  const { SUBSCRIPTION_VENDORS } = await import("./subscription-setup.mjs");
  // provider/model each role runs on, so a failure on a model no role uses
  // any more (it was reassigned) stops warning.
  let modelsInUse = null;
  if (agents && armySummary) {
    modelsInUse = new Set();
    for (const r of Object.values(armySummary.roles ?? {})) {
      const a = agents[r.agent];
      if (!a || !r.model || r.modelIsAuto) continue;
      try { modelsInUse.add(`${agentProviderId(a)}/${r.model}`); } catch { /* unknown shape: skip */ }
    }
  }
  // Finished jobs' runtime data goes on its own (lib/prune.mjs): about
  // 100 MB a job, useful for a day at most, and no decision to make. Before
  // the checks, so the storage warning is about what's left.
  const { pruneJobRuntime, autoPruneAgeMs } = await import("./prune.mjs");
  const ageMs = autoPruneAgeMs();
  let autoPruned = null;
  if (ageMs !== null) { try { autoPruned = { ...pruneJobRuntime({ stateRoot, olderThanMs: ageMs, now }), olderThanHours: ageMs / 3600000 }; } catch { /* best-effort */ } }
  const mode = executionMode(env).mode;
  const result = await runHealthChecks({ now, mode, armySummary, agentsError, jobsRoot: path.join(stateRoot, "jobs"), pidAlive,
    agents, openclawConfig: readOpenclawConfig(), vendors: SUBSCRIPTION_VENDORS, modelsInUse, autoPruned });
  const toNotify = recordHealth(path.join(stateRoot, "health.json"), result, { now });
  return { result, toNotify };
}
