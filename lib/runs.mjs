// nomArmy runs: one feature, end to end, with limits.
//
// A run groups every job the General dispatches for one feature (`run_id`
// on each job). It carries limits -- jobs, api spend, wall-clock hours --
// that admission enforces, warning at `warn_at` and refusing at the cap. It
// also watches for a vendor's usage-limit error: that agent is paused for
// the rest of the run and the General is told, rather than nomArmy quietly
// sending the role's work to some other vendor (which would change who did
// the work, and could be pooling).
//
// What a run can't see: the General's own seat. No tool reports a Claude
// subscription's remaining usage to the session using it, so the run log
// exists for the other half -- if the General's seat runs out mid-feature,
// a fresh session resumes from the log instead of starting over.
//
// Limits come from the army's `run_limits` (global or local layer only: a
// committed project file must never be able to raise what a run may spend
// of your money). The General may lower them for one run, never raise them.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const DEFAULT_RUN_LIMITS = Object.freeze({ max_jobs: 40, max_api_usd: 10, max_hours: 6, warn_at: 0.8 });
const LIMIT_KEYS = ["max_jobs", "max_api_usd", "max_hours"];

/** A vendor's "you've hit your limit" error, as opposed to any other failure. */
const USAGE_LIMIT_RE = /\b(rate[ _-]?limit(?:ed)?|usage[ _-]limit|quota(?: exceeded)?|insufficient[_ ]quota|too many requests|limit (?:reached|exceeded)|hit your (?:usage |rate )?limit|\b429\b)/i;

/**
 * The usage-limit message in a failed job's error text, or null. Only
 * error text is ever passed here -- never the worker's report or tool
 * output, where "rate limit" could simply be the code under discussion.
 */
export function detectUsageLimit(errorText) {
  const text = String(errorText ?? "");
  const match = USAGE_LIMIT_RE.exec(text);
  if (!match) return null;
  const line = text.split(/\r?\n/).find((l) => USAGE_LIMIT_RE.test(l)) ?? match[0];
  return line.replace(/\u001b\[[0-9;]*m/g, "").trim().slice(0, 300);
}

/** The configured limits, tightened (never loosened) by the General's per-run request. */
export function resolveRunLimits(configured = {}, requested = {}) {
  const base = { ...DEFAULT_RUN_LIMITS, ...Object.fromEntries(Object.entries(configured ?? {}).filter(([, v]) => v !== undefined)) };
  const out = { ...base };
  for (const key of LIMIT_KEYS) {
    const want = requested?.[key];
    if (Number.isFinite(want) && want > 0) out[key] = Math.min(base[key], want);
  }
  return out;
}

function runPath(runsDir, id) {
  if (!/^run-[a-z0-9-]{1,80}$/.test(String(id))) throw new Error(`"${id}" is not a run id`);
  return path.join(runsDir, `${id}.json`);
}

function writeRun(runsDir, run) {
  fs.mkdirSync(runsDir, { recursive: true });
  const file = runPath(runsDir, run.id);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(run, null, 2));
  fs.renameSync(`${file}.tmp`, file);
  return run;
}

export function createRun(runsDir, { name, repo, limits, now = Date.now() }) {
  const slug = String(name ?? "feature").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "feature";
  const id = `run-${slug}-${crypto.randomBytes(3).toString("hex")}`;
  return writeRun(runsDir, {
    id, name: name ?? slug, repo, status: "running", createdAt: new Date(now).toISOString(),
    limits, jobs: [], pausedAgents: {}, logPath: path.join(runsDir, `${id}.md`), finishedAt: null, summary: null,
  });
}

export function loadRun(runsDir, id) {
  const file = runPath(runsDir, id);
  if (!fs.existsSync(file)) throw new Error(`unknown run "${id}"`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Totals so far, each limit's share used, and the warnings to surface. */
export function runTotals(run, { now = Date.now() } = {}) {
  const apiUsd = run.jobs.reduce((sum, j) => sum + (j.kind === "api" && Number.isFinite(j.costUsd) ? j.costUsd : 0), 0);
  const hours = (now - Date.parse(run.createdAt)) / 3600000;
  const used = { max_jobs: run.jobs.length, max_api_usd: +apiUsd.toFixed(4), max_hours: +hours.toFixed(2) };
  const share = Object.fromEntries(LIMIT_KEYS.map((k) => [k, run.limits[k] > 0 ? used[k] / run.limits[k] : 0]));
  const byAgent = {};
  for (const j of run.jobs) {
    const a = (byAgent[j.agent] ??= { jobs: 0, apiUsd: 0, tokens: 0 });
    a.jobs += 1;
    if (j.kind === "api" && Number.isFinite(j.costUsd)) a.apiUsd = +(a.apiUsd + j.costUsd).toFixed(4);
    if (Number.isFinite(j.tokens)) a.tokens += j.tokens;
  }
  const label = { max_jobs: "jobs", max_api_usd: "api spend ($)", max_hours: "hours" };
  const warnings = LIMIT_KEYS.filter((k) => share[k] >= run.limits.warn_at && share[k] < 1)
    .map((k) => `run is at ${Math.round(share[k] * 100)}% of its ${label[k]} limit (${used[k]} of ${run.limits[k]})`);
  for (const [agent, reason] of Object.entries(run.pausedAgents)) warnings.push(`agent "${agent}" is paused for this run: ${reason}`);
  return { used, share, byAgent, warnings };
}

/**
 * Why a job may not start in this run, or []. `agentName` is the job's
 * resolved agent ("local" when it names none).
 */
export function runAdmissionProblems(run, { agentName = "local", now = Date.now() } = {}) {
  if (run.status !== "running") return [`run "${run.id}" is ${run.status}; start a new run (or resume by reading its log) rather than adding jobs to it`];
  const problems = [];
  const { used } = runTotals(run, { now });
  if (used.max_jobs >= run.limits.max_jobs) problems.push(`run "${run.id}" has used all ${run.limits.max_jobs} of its jobs`);
  if (used.max_api_usd >= run.limits.max_api_usd) problems.push(`run "${run.id}" has spent $${used.max_api_usd} of its $${run.limits.max_api_usd} api limit`);
  if (used.max_hours >= run.limits.max_hours) problems.push(`run "${run.id}" has run ${used.max_hours} of its ${run.limits.max_hours} hours`);
  if (run.pausedAgents[agentName]) problems.push(`agent "${agentName}" is paused for run "${run.id}" (${run.pausedAgents[agentName]}); stop and tell the operator rather than moving this role to a different vendor`);
  return problems;
}

/** Add a finished job; pause its agent on a usage-limit error. Returns the updated run. */
export function recordRunJob(runsDir, id, job) {
  const run = loadRun(runsDir, id);
  run.jobs.push({ ...job, recordedAt: new Date().toISOString() });
  if (job.usageLimit) run.pausedAgents[job.agent] = job.usageLimit;
  return writeRun(runsDir, run);
}

export function finishRun(runsDir, id, { status, summary }) {
  const run = loadRun(runsDir, id);
  run.status = status;
  run.summary = summary ?? null;
  run.finishedAt = new Date().toISOString();
  return writeRun(runsDir, run);
}
