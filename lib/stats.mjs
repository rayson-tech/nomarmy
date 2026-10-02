import { pendingHumanReview, trustAcknowledgment } from "./trust-learning.mjs";
// nomarmy stats: what nomArmy's own job records show, for one repo or all,
// over a period. Every number comes from a job's verified record
// (metadata.json), never from a worker's report. What the records can't
// show (defects the General found at integration) is said, not guessed.

import fs from "node:fs";
import path from "node:path";
import { computeSuggestions, formatSuggestions, reviewOf } from "./suggestions.mjs";

const SUGGESTION_WINDOW_MS = 14 * 86400000;

/** Every readable job record under jobsRoot. */
export function loadJobRecords(jobsRoot) {
  let names = [];
  try { names = fs.readdirSync(jobsRoot); } catch { return []; }
  const records = [];
  for (const name of names) {
    try { records.push(JSON.parse(fs.readFileSync(path.join(jobsRoot, name, "metadata.json"), "utf8"))); } catch { /* unfinished or unreadable */ }
  }
  return records;
}

/** Human-gated jobs in a run, from persisted records rather than worker reports. */
export function gatedJobs(records, runId) {
  return records.filter((r) => r.labels?.runId === runId && r.trust?.level === "human")
    .map((r) => ({ jobId: r.jobId, reasons: r.trust.reasons ?? [], ...(trustAcknowledgment(r.trust) ? { status: "acknowledged", ack: trustAcknowledgment(r.trust) } : { status: "pending" }) }));
}

/** An agent name from agents.yml for a provider id, when exactly one agent uses it. */
export function agentLookup(agents = {}, providerOf) {
  return (provider) => {
    if (!provider) return null;
    const names = Object.entries(agents).filter(([, a]) => { try { return providerOf(a) === provider; } catch { return false; } }).map(([name]) => name);
    return names.length === 1 ? names[0] : null;
  };
}

/** "7d", "24h", or a date; returns epoch ms or null. */
export function parseSince(value, now = Date.now()) {
  if (!value) return null;
  const rel = /^(\d+)\s*([dh])$/i.exec(String(value).trim());
  if (rel) return now - Number(rel[1]) * (rel[2].toLowerCase() === "d" ? 86400000 : 3600000);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`--since must be a date (2026-09-25) or an age (7d, 24h), got "${value}"`);
  return ms;
}

/** The army role a job ran as: stamped on newer records, read from the brief on older ones. */
export function jobRole(record) {
  if (record.labels?.role) return record.labels.role;
  const m = /^\[nomArmy role: ([a-z][a-z0-9-]*)/.exec(String(record.objective ?? record.task ?? ""));
  return m ? m[1] : null;
}

export function jobModel(record) {
  const provider = record.metrics?.worker_provider ?? record.worker?.provider ?? null;
  const model = record.metrics?.worker_model ?? record.worker?.model ?? null;
  if (record.mode === "verify") return null;
  return model ? (provider && provider !== "llama-cpp" ? `${model}` : `${model} (local)`) : null;
}

const count = (items, key) => items.reduce((m, x) => { const k = key(x) ?? "unassigned"; m[k] = (m[k] ?? 0) + 1; return m; }, {});
const sortDesc = (obj) => Object.fromEntries(Object.entries(obj).sort((a, b) => b[1] - a[1]));
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

// Review flags and harness notes, counted by the issue line nomArmy wrote.
const SIGNALS = [
  ["runner cleanup crash (report recovered)", /runner cleanup failed after the run|OpenClaw's cleanup failed/i],
  ["scoped test selection risk", /^SCOPED TEST SELECTION RISK/],
  ["existing tests modified (review)", /^TEST CHANGE REVIEW/],
  ["code wired to nothing", /^UNWIRED NEW DEFINITION/],
  ["check rewritten to pass", /^VERIFICATION INPUT CHANGED/],
  ["mutants survived", /^MUTANTS SURVIVED/],
  ["report may not match diff (Jev)", /^REPORT MAY NOT MATCH THE DIFF/],
  ["citations may not support findings (Jev)", /^CITATIONS MAY NOT SUPPORT/],
  ["judge flag", /^JUDGE \(/],
  ["possible secret", /^POSSIBLE SECRET/],
  ["tools outside the sandbox", /^TOOLS OUTSIDE THE SANDBOX/],
  ["Podman VM restarted mid-job", /Podman (VM|machine).*(restarted|stopped) during this job/i],
];

/**
 * A repository by path, or by folder name: an exact folder name wins, then
 * one ending in it (senti → rayson-senti, not rayson-senti-shared-services),
 * then one containing it. Throws when it matches none or several.
 */
export function resolveRepo(records, value) {
  if (!value) return null;
  if (fs.existsSync(value)) return path.resolve(value);
  const repos = [...new Set(records.map((r) => r.projectDir).filter(Boolean).map((p) => path.resolve(p)))];
  const exact = repos.filter((p) => path.basename(p) === value);
  const lower = String(value).toLowerCase();
  const ending = repos.filter((p) => path.basename(p).toLowerCase().endsWith(`-${lower}`) || path.basename(p).toLowerCase().endsWith(`_${lower}`));
  const matches = exact.length ? exact : ending.length ? ending : repos.filter((p) => path.basename(p).toLowerCase().includes(lower));
  if (matches.length === 1) return matches[0];
  if (!matches.length) throw new Error(`no repository with jobs matches "${value}"; repositories: ${repos.map((p) => path.basename(p)).join(", ") || "(none)"}`);
  throw new Error(`"${value}" matches several repositories: ${matches.map((p) => path.basename(p)).join(", ")}; use more of the name or a path`);
}

/**
 * @param {object[]} records
 * @param {{ repo?: string|null, sinceMs?: number|null, untilMs?: number|null, role?: string|null, model?: string|null }} filter
 */
export function computeStats(records, { repo = null, sinceMs = null, untilMs = null, role = null, model = null, runId = null, agentFor = () => null, now = Date.now(), allSuggestions = false } = {}) {
  const inRange = records.filter((r) => {
    const at = Date.parse(r.startedAt ?? r.finishedAt ?? "");
    if (sinceMs != null && !(at >= sinceMs)) return false;
    if (untilMs != null && !(at <= untilMs)) return false;
    if (repo && r.projectDir && path.resolve(r.projectDir) !== path.resolve(repo)) return false;
    if (role && jobRole(r) !== role) return false;
    if (model && (r.metrics?.worker_model ?? r.worker?.model) !== model) return false;
    if (runId && r.labels?.runId !== runId) return false;
    return true;
  });
  // Verify runs from before records carried the repo can't be placed in one.
  const unplaced = repo ? inRange.filter((r) => !r.projectDir).length : 0;
  const jobs = repo ? inRange.filter((r) => r.projectDir) : inRange;
  const implement = jobs.filter((r) => r.mode === "implement");
  const scouts = jobs.filter((r) => r.mode === "scout");
  const committed = implement.filter((r) => r.commit?.created || r.commit?.sha);

  const workerMinutes = implement.map((r) => r.metrics?.worker_elapsed).filter(Number.isFinite).map((ms) => ms / 60000);
  const jobMinutes = implement.map((r) => r.metrics?.total_elapsed).filter(Number.isFinite).map((ms) => ms / 60000);
  const tokens = { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, untracked: 0 };
  const spend = {};
  for (const r of jobs) {
    const m = r.metrics ?? {};
    tokens.total += m.worker_tokens_total ?? 0; tokens.input += m.worker_tokens_in ?? 0; tokens.output += m.worker_tokens_out ?? 0;
    tokens.cacheRead += m.worker_tokens_cache_read ?? 0; tokens.cacheWrite += m.worker_tokens_cache_write ?? 0;
    if (r.mode !== "verify" && !(m.worker_tokens_total > 0)) tokens.untracked++;
    if (Number.isFinite(m.worker_cost_usd) && m.worker_cost_usd > 0) spend[jobModel(r) ?? "unknown"] = (spend[jobModel(r) ?? "unknown"] ?? 0) + m.worker_cost_usd;
  }

  // Claim vs evidence: implement jobs whose worker reported done with tests passing.
  const claimedDone = implement.filter((r) => r.reportValidation?.status === "done" && r.reportValidation?.tests === "pass");
  const verificationFailed = claimedDone.filter((r) => r.independentVerification?.status === "fail");
  const revertStillPassed = claimedDone.filter((r) => r.independentVerification?.status === "pass" && r.regressionCheck?.status === "fail");
  // Claimed success with an empty diff: there was nothing to verify.
  const changedNothing = claimedDone.filter((r) => r.independentVerification?.status === "not_run");
  const passedBoth = claimedDone.filter((r) => r.independentVerification?.status === "pass" && r.regressionCheck?.status !== "fail");
  const flaggedAfterPassing = passedBoth.filter((r) => (r.issues ?? []).some((i) => /^(MUTANTS SURVIVED|REPORT MAY NOT MATCH|JUDGE \(|VERIFICATION INPUT CHANGED)/.test(i)));
  // New tests the revert check showed would catch their change going away.
  const provenTestFiles = committed.filter((r) => r.regressionCheck?.status === "pass").reduce((n, r) => n + (r.testChanges?.new_tests_added?.length ?? r.metrics?.new_tests_added ?? 0), 0);

  const signals = {};
  for (const [name, re] of SIGNALS) {
    const n = jobs.filter((r) => [...(r.issues ?? []), ...(r.runnerNotes ?? [])].some((i) => re.test(i))).length;
    if (n) signals[name] = n;
  }

  const reviewers = {};
  for (const r of scouts) {
    const role = jobRole(r) ?? "unassigned";
    const entry = reviewers[role] ??= { runs: 0, outcomes: {}, findings: 0 };
    entry.runs++;
    entry.outcomes[r.outcome ?? "unknown"] = (entry.outcomes[r.outcome ?? "unknown"] ?? 0) + 1;
    entry.findings += r.scout?.findings?.length ?? 0;
  }

  const times = jobs.map((r) => Date.parse(r.startedAt ?? "")).filter(Number.isFinite);
  return {
    period: { from: times.length ? new Date(Math.min(...times)).toISOString() : null, to: times.length ? new Date(Math.max(...times)).toISOString() : null },
    repo, role, model, unplacedVerifyRuns: role || model ? 0 : unplaced,
    volume: {
      jobs: jobs.length,
      byMode: sortDesc(count(jobs, (r) => r.mode)),
      byRole: sortDesc(count(jobs.filter((r) => r.mode !== "verify"), jobRole)),
      byModel: sortDesc(count(jobs.filter((r) => r.mode !== "verify"), jobModel)),
      byOutcome: sortDesc(count(jobs, (r) => r.outcome)),
    },
    code: {
      committedJobs: committed.length,
      linesAdded: committed.reduce((s, r) => s + (r.git?.additions ?? r.metrics?.lines_added ?? 0), 0),
      linesRemoved: committed.reduce((s, r) => s + (r.git?.deletions ?? r.metrics?.lines_removed ?? 0), 0),
      files: new Set(committed.flatMap((r) => r.git?.changedFiles ?? [])).size,
      newTestFiles: committed.reduce((s, r) => s + (r.testChanges?.new_tests_added?.length ?? r.metrics?.new_tests_added ?? 0), 0),
    },
    workerMinutes: { median: percentile(workerMinutes, 50), p90: percentile(workerMinutes, 90), total: workerMinutes.reduce((a, b) => a + b, 0) },
    jobMinutes: { median: percentile(jobMinutes, 50), p90: percentile(jobMinutes, 90), total: jobMinutes.reduce((a, b) => a + b, 0) },
    tokens,
    spendUsd: { total: Object.values(spend).reduce((a, b) => a + b, 0), byModel: sortDesc(spend) },
    claimVsEvidence: {
      claimedDone: claimedDone.length,
      verificationFailed: verificationFailed.length,
      revertStillPassed: revertStillPassed.length,
      passedBoth: passedBoth.length,
      changedNothing: changedNothing.length,
      flaggedAfterPassing: flaggedAfterPassing.length,
      provenTestFiles,
    },
    notCompleted: sortDesc(count(jobs.filter((r) => !/^(WORKER_DONE|RECOVERED_SUCCESS|VERIFIED|SCOUT_DONE|DECOMPOSE_DONE|SCOUT_NOT_FOUND)$/.test(r.outcome ?? "")), (r) => r.outcome)),
    reviewers,
    signals: sortDesc(signals),
    humanReview: { jobs: jobs.filter(pendingHumanReview).length, reasons: [...new Set(jobs.filter(pendingHumanReview).flatMap((r) => (r.trust.reasons ?? []).map((reason) => reason.reason)))] },
    highStakes: (() => {
      // Work that landed: an uncommitted partial isn't accepted work.
      const high = implement.filter((r) => r.stakes === "high" && r.commit?.created);
      return { jobs: high.length, reviewed: high.filter((r) => reviewOf(r, records)).length };
    })(),
    // How you're set up now: the last 14 days unless a period was asked for.
    suggestions: computeSuggestions(sinceMs == null ? jobs.filter((r) => Date.parse(r.startedAt ?? "") >= now - SUGGESTION_WINDOW_MS) : jobs, { agentFor, now, includeStale: allSuggestions }),
    suggestionWindow: sinceMs == null ? "the last 14 days" : "this period",
  };
}

const pct = (n, of) => (of ? ` (${Math.round((100 * n) / of)}%)` : "");
const list = (obj) => Object.entries(obj).map(([k, v]) => `${k} ${v}`).join(" · ") || "none";
const mins = (m) => (m == null ? "n/a" : `${m.toFixed(1)} min`);
const big = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

/** The headline: claims that didn't hold up, and tests shown to catch their change. */
function caughtLines(c) {
  if (!c.claimedDone) return ["  no implement job reported \"done, tests pass\" in this period"];
  const wrong = c.verificationFailed + c.revertStillPassed;
  const parts = [c.verificationFailed && `${c.verificationFailed} failed when nomArmy ran the tests itself`, c.revertStillPassed && `${c.revertStillPassed} had tests that still pass with the change reverted`].filter(Boolean);
  return [
    wrong ? `  ${wrong} of ${c.claimedDone} "done, tests pass" claims didn't hold up: ${parts.join(", ")}` : `  all ${c.claimedDone} "done, tests pass" claims held up when nomArmy checked them`,
    ...(c.flaggedAfterPassing ? [`  ${c.flaggedAfterPassing} more passed both but were flagged (mutants, Jev, judge, a rewritten check)`] : []),
    ...(c.provenTestFiles ? [`  ${c.provenTestFiles} new test file(s) shown to fail without their change`] : []),
  ];
}

/**
 * The default view: one screen. What nomArmy caught, what needs you, the top
 * tips, and the totals. `--details` prints formatStats. `c` paints (the CLI
 * passes its colors, plain when not a terminal); left out, it's plain text.
 */
const PLAIN = { bold: String, dim: String, red: String, green: String, yellow: String, cyan: String };
export function formatStatsSummary(s, { c = PLAIN, width = 28 } = {}) {
  const cv = s.claimVsEvidence;
  const where = s.repo ? path.basename(s.repo) : "all repositories";
  const month = (iso) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const when = s.period.from ? `${month(s.period.from)} to ${month(s.period.to)}` : "no jobs yet";
  const act = (s.suggestions ?? []).filter((x) => x.level === "act");
  // The spend share is on the totals line already.
  const tips = (s.suggestions ?? []).filter((x) => x.level !== "act" && x.key !== "stale" && !x.key.startsWith("spend:"));
  const hidden = (s.suggestions ?? []).find((x) => x.key === "stale");
  const shown = tips.slice(0, 3), more = tips.length - shown.length;
  const label = (t) => c.bold(t.padEnd(9));
  const lines = [`${c.bold("nomArmy stats")}  ${c.dim(`${where} · ${when} · ${s.volume.jobs} jobs · ${s.code.committedJobs} committed`)}`, ""];

  // What the checks caught: the reason to run nomArmy, first.
  if (cv.claimedDone) {
    const wrong = cv.verificationFailed + cv.revertStillPassed, held = cv.claimedDone - wrong;
    const bad = wrong ? Math.max(1, Math.round((width * wrong) / cv.claimedDone)) : 0;
    lines.push(`${label("CAUGHT")}${c.green("█".repeat(width - bad))}${c.red("░".repeat(bad))}  ${held} of ${cv.claimedDone} "done, tests pass" claims held up${wrong ? c.red(` · ${wrong} didn't`) : ""}`);
    const why = [cv.verificationFailed && `${cv.verificationFailed} failed when nomArmy ran the tests itself`, cv.revertStillPassed && `${cv.revertStillPassed} had tests that pass with the change reverted`, cv.flaggedAfterPassing && `${cv.flaggedAfterPassing} passed but were flagged`].filter(Boolean);
    if (why.length) lines.push(`${" ".repeat(9)}${c.dim(why.join(" · "))}`);
  } else lines.push(`${label("CAUGHT")}${c.dim('no job reported "done, tests pass" in this period')}`);
  if (cv.provenTestFiles) lines.push(`${label("PROVEN")}${c.green("✓")} ${cv.provenTestFiles} new test files fail without their change`);

  for (const x of act) {
    const ids = /: (.+)$/.exec(x.title)?.[1]?.split(", ") ?? [];
    const head = x.title.replace(/: .+$/, "");
    lines.push("", `${c.red(c.bold("⚠ REVIEW BEFORE MERGING"))}  ${head}`);
    for (let i = 0; i < ids.length; i += 2) lines.push(`   ${ids.slice(i, i + 2).map((id) => id.padEnd(32)).join("")}`.trimEnd());
    lines.push(`   ${c.cyan("→")} a scout on another vendor with ${c.cyan("reviews: <job id>")} (army_role security-analyst); a failed review doesn't count`);
  }

  if (s.humanReview?.jobs) lines.push(`${label("HUMAN")}${c.red(`${s.humanReview.jobs} job(s) need human review`)}: ${s.humanReview.reasons.join("; ")}`);

  lines.push("");
  if (!shown.length) lines.push(`${label("TIPS")}${c.dim("none: nothing in the records suggests a routing change")}`);
  shown.forEach((t, i) => {
    lines.push(`${i ? " ".repeat(9) : label("TIPS")}${t.level === "warn" ? c.yellow("▲") : c.dim("·")} ${t.title}`);
    if (t.command) lines.push(`${" ".repeat(11)}${c.cyan(`→ ${t.command}`)}`);
  });
  const staleCount = hidden ? Number(/^\d+/.exec(hidden.title)?.[0] ?? 0) : 0;
  const notes = [more > 0 && `${more} more (--details)`, staleCount && `${staleCount} about pairings unused for 3+ days (--all-suggestions)`].filter(Boolean);
  if (notes.length) lines.push(`${" ".repeat(11)}${c.dim(notes.join(" · "))}`);

  const top = Object.entries(s.spendUsd.byModel)[0];
  lines.push("", `${label("SPEND")}$${s.spendUsd.total.toFixed(2)} API${top ? c.dim(` (${top[0]} ${Math.round((100 * top[1]) / (s.spendUsd.total || 1))}%)`) : ""} · ${Math.round(s.jobMinutes.total)} min of jobs · ${big(s.tokens.total)} tokens`);
  lines.push("", c.dim("Everything else (volume, reviewers, flags, what didn't finish): nomarmy stats --details"));
  return lines.join("\n");
}

/** The terminal report. */
export function formatStats(s) {
  const c = s.claimVsEvidence;
  const lines = [
    `nomArmy stats${s.repo ? ` for ${s.repo}` : " (all repositories)"}${s.role ? `, role ${s.role}` : ""}${s.model ? `, model ${s.model}` : ""}, ${s.period.from ? `${s.period.from.slice(0, 10)} to ${s.period.to.slice(0, 10)}` : "no jobs"}`,
    "",
    "WHAT NOMARMY CAUGHT",
    ...caughtLines(c),
    ...(() => { const act = (s.suggestions ?? []).filter((x) => x.level === "act"); return act.length ? ["", "NEEDS YOUR ATTENTION", ...formatSuggestions(act)] : []; })(),
    "",
    `SUGGESTIONS (from ${s.suggestionWindow ?? "this period"}; never applied for you)`,
    ...formatSuggestions((s.suggestions ?? []).filter((x) => x.level !== "act")),
    "",
    "VOLUME",
    `  Jobs          ${s.volume.jobs}: ${list(s.volume.byMode)}${s.unplacedVerifyRuns ? ` (plus ${s.unplacedVerifyRuns} older verify run(s) that don't record their repository)` : ""}`,
    `  By role       ${list(s.volume.byRole)}`,
    `  By model      ${list(s.volume.byModel)}`,
    `  Committed     ${s.code.committedJobs} job(s) · +${s.code.linesAdded} / -${s.code.linesRemoved} lines · ${s.code.files} files · ${s.code.newTestFiles} new test files`,
    `  Worker time   median ${mins(s.workerMinutes.median)} per implement job, p90 ${mins(s.workerMinutes.p90)}, total ${Math.round(s.workerMinutes.total)} min`,
    `  Job time      median ${mins(s.jobMinutes.median)}, p90 ${mins(s.jobMinutes.p90)}, total ${Math.round(s.jobMinutes.total)} min (with verification and checks)`,
    `  Tokens        ${big(s.tokens.total)} total (${big(s.tokens.input)} in, ${big(s.tokens.output)} out, ${big(s.tokens.cacheRead)} cache read)${s.tokens.untracked ? `; ${s.tokens.untracked} job(s) recorded no token counts` : ""}`,
    `  API spend     $${s.spendUsd.total.toFixed(2)}${Object.keys(s.spendUsd.byModel).length ? ` (${Object.entries(s.spendUsd.byModel).map(([k, v]) => `${k} $${v.toFixed(2)}`).join(", ")})` : ""}; subscriptions aren't billed per call`,
    "",
    `CLAIM VS EVIDENCE (implement jobs that reported "done, tests pass": ${c.claimedDone})`,
    `  Independent verification failed       ${c.verificationFailed}${pct(c.verificationFailed, c.claimedDone)}`,
    `  Passed, but reverting still passed    ${c.revertStillPassed}${pct(c.revertStillPassed, c.claimedDone)}`,
    `  Passed both                           ${c.passedBoth}${pct(c.passedBoth, c.claimedDone)}`,
    `    of those, flagged by another check  ${c.flaggedAfterPassing} (mutants, Jev, judge, rewritten checks)`,
    ...(c.changedNothing ? [`  Changed nothing, nothing to verify    ${c.changedNothing}${pct(c.changedNothing, c.claimedDone)}`] : []),
    ...(s.humanReview?.jobs ? [`  Human-gated jobs                     ${s.humanReview.jobs}: ${s.humanReview.reasons.join("; ")}`] : []),
    `  High-stakes jobs committed            ${s.highStakes?.jobs ?? 0}, ${s.highStakes?.reviewed ?? 0} with a finished independent review`,
    "  Defects the General found at integration aren't in the records; count them in your own review.",
    "",
    "DIDN'T COMPLETE",
    ...(Object.keys(s.notCompleted).length ? Object.entries(s.notCompleted).map(([k, v]) => `  ${k.padEnd(28)} ${v}`) : ["  none"]),
    "",
    "REVIEWERS (scouts)",
    ...(Object.keys(s.reviewers).length ? Object.entries(s.reviewers).map(([role, r]) => `  ${role.padEnd(18)} ${r.runs} run(s), ${r.findings} finding(s); ${list(r.outcomes)}`) : ["  none"]),
    "",
    "REVIEW FLAGS AND HARNESS SIGNALS (jobs)",
    ...(Object.keys(s.signals).length ? Object.entries(s.signals).map(([k, v]) => `  ${k.padEnd(42)} ${v}`) : ["  none"]),
  ];
  return lines.join("\n");
}
