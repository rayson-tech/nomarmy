import path from "node:path";
import { DECOMPOSE_OUTCOMES } from "./decompose.mjs";
import { OUTCOMES } from "./outcomes.mjs";

const orchestratorTrust = process.env.NOMARMY_ORCHESTRATOR_TRUST || "frontier";

// A degraded orchestrator grades a peer, not a subordinate. Say so on every
// record it produces, so the weakened guarantee cannot be missed in review.
const DEGRADED_BANNER = "!!! DEGRADED ACCEPTANCE: coordinator and worker are the same capability class.\n!!! This record is not an independent check. See policies/reviewer.md.\n\n";
const RECOVERED_BANNER = "!!! RECOVERED RESULT: the worker's report was invalid or truncated. This job was\n!!! accepted on nomArmy's own independent verification, NOT on a worker claim.\n!!! Weaker evidence than a clean report - review the diff before integrating.\n\n";
const REVIEW_BANNER = "!!! NEEDS REVIEW: no accepted outcome. Worktree retained. See outcome and issues.\n\n";
const TAINTED_BANNER = "!!! SCOUT TAINTED: the scout modified its read-only snapshot. Findings below were still\n!!! verified against the base commit through Git, but treat the scout's judgement with suspicion.\n\n";
const DECOMPOSE_TAINTED_BANNER = "!!! DECOMPOSE TAINTED: the decomposer modified its read-only snapshot. Subtasks below were still\n!!! verified against the base commit through Git, but treat the decomposer's judgement with suspicion.\n\n";
export function testChangeBanner(testChanges) {
  if (!testChanges?.reviewRequired) return "";
  return `!!! TEST CHANGES REQUIRE REVIEW:\n${testChanges.reviewFlags.map(f => `!!!   ${f}`).join("\n")}\n!!! nomArmy does not reject test changes. It refuses to let them pass unseen.\n\n`;
}
export function regressionCheckBanner(regressionCheck) {
  if (regressionCheck?.status !== "fail" && regressionCheck?.status !== "restore_failed") return "";
  if (regressionCheck.status === "restore_failed") {
    return `!!! REGRESSION CHECK COULD NOT RESTORE THE WORKTREE: ${regressionCheck.reason}\n!!! Commit blocked unconditionally. Inspect this worktree by hand before doing anything else with it.\n\n`;
  }
  return `!!! REGRESSION CHECK FAILED: reverting the production change and re-running verification\n!!! still PASSED. No test in this run would catch the change being undone -- the fix\n!!! is unproven, not necessarily wrong.\n\n`;
}
export function decomposeOverlapBanner(overlaps) {
  if (!overlaps?.length) return "";
  return `!!! SUBTASK FILE OVERLAP: ${overlaps.map(o => `subtask ${o.a + 1} and ${o.b + 1} both claim ${o.files.join(", ")}`).join("; ")}\n!!! These subtasks are not safe to dispatch as independent jobs as proposed. Reconcile before dispatching.\n\n`;
}
// The scout record deliberately omits the findings: they are already in the
// rendered report above it, and repeating the excerpts would spend the very
// frontier context a scout exists to save.
// Kept small on purpose: every field here lands in the coordinator's context.
// Budgets, execution details and the full metrics stay in metadata.json.
function compactScoutRecord(m) {
  const met = m.metrics ?? {};
  return { jobId: m.jobId, workerId: m.workerId, mode: m.mode, outcome: m.outcome, coordinatorStatus: m.coordinatorStatus, reviewRequired: m.reviewRequired,
    baseSha: m.baseSha ? String(m.baseSha).slice(0, 10) : null,
    findings: { supported: m.scout?.supported ?? null, weak: m.scout?.weak ?? null, unsupported: m.scout?.unsupported ?? null },
    report: m.scout?.reportParse ? { parseMode: m.scout.reportParse.parseMode, truncated: m.scout.reportParse.truncated, dropped: m.scout.reportParse.droppedFindings } : null,
    scoutRead: m.transcript?.filesRead ?? null,
    displacement: m.displacement ? { read: m.displacement.frontier_read_tokens_est, delivered: m.displacement.delivered_tokens_est, displaced: m.displacement.displaced_tokens_est, verdict: m.displacement.verdict } : null,
    elapsedSeconds: Number.isFinite(met.total_elapsed) ? Math.round(met.total_elapsed / 1000) : null,
    modelCalls: met.scout_model_calls ?? null, workerModel: met.worker_model ?? null,
    issues: m.issues ?? [], dirty: m.dirty ?? null, worktreeRetained: m.worktreeRetained ?? null, error: m.error ?? null };
}
// Same convention as compactScoutRecord: small, only what a listing needs.
// Full subtask detail (citations, excerpts) stays in the rendered report and
// metadata.json; repeating it here would spend the context this record
// exists to save.
function compactDecomposeRecord(m) {
  const met = m.metrics ?? {};
  return { jobId: m.jobId, workerId: m.workerId, mode: m.mode, outcome: m.outcome, coordinatorStatus: m.coordinatorStatus, reviewRequired: m.reviewRequired,
    baseSha: m.baseSha ? String(m.baseSha).slice(0, 10) : null,
    subtasks: { proposed: m.decompose?.subtasks?.length ?? null, supported: m.decompose?.supported ?? null, weak: m.decompose?.weak ?? null, unsupported: m.decompose?.unsupported ?? null },
    overlaps: m.decompose?.overlaps?.length ?? 0, notSplittable: m.decompose?.notSplittable ?? null,
    report: m.decompose?.reportParse ? { parseMode: m.decompose.reportParse.parseMode, truncated: m.decompose.reportParse.truncated, dropped: m.decompose.reportParse.droppedSubtasks } : null,
    decomposerRead: m.transcript?.filesRead ?? null,
    displacement: m.displacement ? { read: m.displacement.frontier_read_tokens_est, delivered: m.displacement.delivered_tokens_est, displaced: m.displacement.displaced_tokens_est, verdict: m.displacement.verdict } : null,
    elapsedSeconds: Number.isFinite(met.total_elapsed) ? Math.round(met.total_elapsed / 1000) : null,
    modelCalls: met.decompose_model_calls ?? null, workerModel: met.worker_model ?? null,
    issues: m.issues ?? [], dirty: m.dirty ?? null, worktreeRetained: m.worktreeRetained ?? null, error: m.error ?? null };
}
// Same convention as compactScoutRecord/compactDecomposeRecord: small, only
// what deciding "what to clean up / what needs recovery" actually needs.
// A real incident this fixes: with no compaction at all, an implement
// job's FULL manifest (objective text, budgets, timeBudget, every git
// record, gitBeforeCoordinatorCommit, ...) meant a `limit: 12` listing
// blew the tool-result size cap outright -- exactly the one call an
// operator reaches for first when cleaning up a job backlog.
function compactImplementRecord(m) {
  const met = m.metrics ?? {};
  return { jobId: m.jobId, workerId: m.workerId, mode: m.mode, outcome: m.outcome, coordinatorStatus: m.coordinatorStatus, reviewRequired: m.reviewRequired,
    branch: m.branch ?? null, commit: m.commit?.sha ?? null, worktree: m.worktree ?? null, worktreeRetained: m.worktreeRetained ?? null,
    filesChanged: met.files_changed ?? null,
    elapsedSeconds: Number.isFinite(met.total_elapsed) ? Math.round(met.total_elapsed / 1000) : null,
    workerModel: met.worker_model ?? null,
    startedAt: m.startedAt ?? null, finishedAt: m.finishedAt ?? null,
    issues: m.issues ?? [], error: m.error ?? null };
}
function compactVerifyRecord(m) {
  return { jobId: m.jobId, workerId: m.workerId, mode: m.mode, outcome: m.outcome,
    coordinatorStatus: m.coordinatorStatus, baseRef: m.baseRef, baseSha: m.baseSha,
    verification: m.verification, elapsedSeconds: Math.round(m.metrics.total_elapsed / 1000),
    worktreeRetained: m.worktreeRetained, error: m.error };
}
export function compactJobRecord(meta) {
  if (meta.mode === "verify") return compactVerifyRecord(meta);
  return meta.mode === "scout" ? compactScoutRecord(meta) : meta.mode === "decompose" ? compactDecomposeRecord(meta) : compactImplementRecord(meta);
}

/**
 * The report and what nomArmy decided about it, without the rest of the
 * record: full=true put the whole execution record in the General's context
 * when it only wanted the worker's answer. Scout findings keep their verified
 * citations, since they are the report.
 */
export function reportView(meta) {
  const iv = meta.independentVerification;
  const base = { jobId: meta.jobId, mode: meta.mode, outcome: meta.outcome, ...(meta.trust ? { trust: meta.trust } : {}), coordinatorStatus: meta.coordinatorStatus, reviewRequired: meta.reviewRequired ?? false, issues: meta.issues ?? [] };
  if (meta.mode === "scout") {
    const s = meta.scout ?? {};
    return { ...base, question: s.question ?? meta.objective ?? null, confidence: s.confidence ?? null, notFound: s.notFound ?? null, findings: s.findings ?? [], unsupported: s.unsupported ?? [] };
  }
  return { ...base,
    ...(meta.criteria ? { criteria: meta.criteria } : {}),
    ...(meta.acceptanceProposals ? { acceptanceProposals: meta.acceptanceProposals } : {}),
    report: meta.reportValidation?.fields ?? null,
    verification: iv ? { status: iv.status, detail: iv.status === "fail" ? String(iv.detail ?? iv.reason ?? "").slice(0, 600) || null : null, ...(iv.failingTests ? { failingTests: iv.failingTests } : {}) } : null,
    ...(meta.reportMismatch ? { reportMismatch: meta.reportMismatch } : {}),
    revertCheck: meta.regressionCheck?.status ?? null,
    commit: meta.commit ? { created: Boolean(meta.commit.created), sha: meta.commit.sha ?? null, branch: meta.branch ?? null, reason: meta.commit.created ? null : meta.commit.reason ?? null } : null,
    changedFiles: meta.git?.changedFiles ?? [], additions: meta.git?.additions ?? null, deletions: meta.git?.deletions ?? null,
    ...(meta.mode === "decompose" ? { proposal: meta.decompose ?? meta.proposal ?? null } : {}) };
}

/**
 * A status answer lands in the coordinator's context on every poll. On a big
 * diff the report and default views ran to tens of thousands of characters:
 * one removed-check reason per file, every changed file, every test-change
 * flag. Over the budget, lists keep their first items ("...and N more"),
 * long text is cut, reasons that differ only in where they point collapse
 * into one, and the view says where the rest is. full=true is never bounded.
 */
export const STATUS_VIEW_CHARS = 6000;
// Never cut away: what was decided, and where to find the rest.
const PINNED = new Set(["jobId", "workerId", "mode", "state", "phase", "outcome", "coordinatorStatus", "reviewRequired", "commit", "branch", "worktree", "jobDir", "hint", "error"]);
const more = (count) => `...and ${count} more`;
const size = (value) => JSON.stringify(value, null, 2)?.length ?? 0;
function shrink(value, items, chars) {
  if (typeof value === "string") return value.length > chars ? `${value.slice(0, chars)}... (${value.length - chars} more characters)` : value;
  if (Array.isArray(value)) {
    const kept = value.slice(0, items).map((item) => shrink(item, items, chars));
    return value.length > items ? [...kept, more(value.length - items)] : kept;
  }
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shrink(item, items, chars)]));
  return value;
}
// "Removes or changes an access guard at a.js:4." for forty files is one
// reason with forty places.
const PLACE = /\s+at\s+(\S+:\d+)\.?$/;
export function collapseTrustReasons(reasons = [], places = 5) {
  const groups = new Map();
  for (const entry of reasons) {
    const text = String(entry?.reason ?? "");
    const at = PLACE.exec(text);
    const key = JSON.stringify([entry?.rule ?? null, at ? text.slice(0, at.index) : text]);
    if (!groups.has(key)) groups.set(key, { entry, template: at ? text.slice(0, at.index) : text, places: [] });
    if (at) groups.get(key).places.push(at[1]);
  }
  return [...groups.values()].map(({ entry, template, places: where }) => {
    if (where.length < 2) return entry;
    const shown = where.slice(0, places).join(", ") + (where.length > places ? `, ${more(where.length - places)}` : "");
    return { rule: entry.rule, reason: `${template} at ${where.length} places: ${shown}.` };
  });
}
function compactTrust(trust) {
  if (!trust || typeof trust !== "object") return trust;
  const { level, reasons, judgment, checks, evidence } = trust;
  return { level, reasons: collapseTrustReasons(reasons ?? []),
    ...(judgment ? { judgment: { status: judgment.status, validator: judgment.validator ?? null, answers: judgment.answers ?? {} } } : {}),
    ...(Array.isArray(checks) ? { checks: checks.length } : {}), ...(evidence ? { evidence } : {}) };
}
export function boundStatusView(view, { budget = STATUS_VIEW_CHARS, jobId = view?.jobId ?? null } = {}) {
  if (!view || typeof view !== "object" || size(view) <= budget) return view;
  const pointer = `Shortened to stay under about ${budget} characters: lists show their first items and long text is cut. full=true returns the complete record${jobId ? `; commit_show with job ${jobId} shows the diff` : ""}.`;
  const base = { ...view, ...(view.trust ? { trust: compactTrust(view.trust) } : {}) };
  let out;
  for (const [items, chars] of [[10, 600], [6, 400], [4, 240], [3, 160], [2, 120], [1, 100]]) {
    out = { truncated: pointer, ...Object.fromEntries(Object.entries(base).map(([key, value]) => [key, PINNED.has(key) ? shrink(value, 10, 600) : shrink(value, items, chars)])) };
    if (size(out) <= budget) return out;
  }
  // Still over: drop whole fields from the end, keeping what was decided and the first issues.
  const omitted = [];
  for (const key of Object.keys(out).reverse()) {
    if (size(out) <= budget) break;
    if (PINNED.has(key) || key === "truncated" || key === "issues") continue;
    omitted.unshift(key);
    delete out[key];
  }
  if (omitted.length) out.omitted = omitted;
  return out;
}

// Evidence before claim, in the display order too: the record is what
// nomArmy verified against Git, the worker's report is prose it wrote about
// itself. Leading with the report buried the record below whatever the
// worker said, including a truncated or garbled reply -- exactly backwards
// for a tool whose whole premise is not trusting that reply.
export function formatResult(r) {
  if (r.manifest?.mode === "verify") return `OUTCOME: ${r.manifest.outcome}\n\n--- VERIFICATION RECORD ---\n${JSON.stringify(compactVerifyRecord(r.manifest), null, 2)}\n\nJob artifacts: ${r.jobDir}`;
  const banner = orchestratorTrust === "degraded" ? DEGRADED_BANNER : "";
  const outcomeLine = r.manifest?.outcome ? `OUTCOME: ${r.manifest.outcome}\n\n` : "";
  const workerReport = `--- WORKER REPORT (a claim, not evidence) ---\n${r.report}`;
  if (r.manifest?.mode === "scout") {
    const tainted = r.manifest?.outcome === OUTCOMES.SCOUT_TAINTED ? TAINTED_BANNER : "";
    return `${banner}${tainted}${outcomeLine}--- SCOUT RECORD ---\n${JSON.stringify(compactScoutRecord(r.manifest), null, 2)}\n\nJob artifacts: ${r.jobDir}${r.manifest.worktree ? `\nWorktree retained for review: ${r.manifest.worktree}` : ""}\n\n${workerReport}`;
  }
  if (r.manifest?.mode === "decompose") {
    const tainted = r.manifest?.outcome === DECOMPOSE_OUTCOMES.DECOMPOSE_TAINTED ? DECOMPOSE_TAINTED_BANNER : "";
    const overlap = decomposeOverlapBanner(r.manifest?.decompose?.overlaps);
    return `${banner}${tainted}${overlap}${outcomeLine}--- DECOMPOSE RECORD ---\n${JSON.stringify(compactDecomposeRecord(r.manifest), null, 2)}\n\nJob artifacts: ${r.jobDir}${r.manifest.worktree ? `\nWorktree retained for review: ${r.manifest.worktree}` : ""}\n\n${workerReport}`;
  }
  const recovered = r.manifest?.outcome === OUTCOMES.RECOVERED_SUCCESS ? RECOVERED_BANNER : "";
  const review = r.manifest?.outcome === OUTCOMES.NEEDS_REVIEW ? REVIEW_BANNER : "";
  const tests = testChangeBanner(r.manifest?.testChanges);
  const regression = regressionCheckBanner(r.manifest?.regressionCheck);
  return `${banner}${recovered}${review}${tests}${regression}${outcomeLine}--- VERIFIED EXECUTION RECORD ---\n${JSON.stringify(r.manifest, null, 2)}\n\nJob artifacts: ${r.jobDir}${r.manifest.worktree ? `\nWorktree retained for review: ${r.manifest.worktree}\nBranch retained for review: ${r.manifest.branch}` : ""}\n\n${workerReport}`;
}
const UNION_BANNER = "!!! UNION: mechanically merged into one new integration branch for review. This is NOT the developer's branch and was not auto-merged into it. Review and integrate explicitly, same as any other branch here.\n\n";
const UNION_VERIFICATION_FAILED_BANNER = "!!! UNION VERIFICATION FAILED: the merged branch did not pass its own verification profile. Merge is retained for review; inspect before integrating.\n\n";
const NO_UNION_BANNER = "!!! NO UNION FORMED: see union.reason below. Per-job branches above are unaffected and still yours to review individually.\n\n";
// Same visual convention as formatResult: a banner naming what happened,
// then a labeled JSON block, then an artifacts trailer -- no new vocabulary.
export function formatUnion(union) {
  const banner = union.status === "union_verification_failed" ? UNION_VERIFICATION_FAILED_BANNER
    : union.status === "no_union" ? NO_UNION_BANNER : UNION_BANNER;
  const artifacts = union.worktree ? `\n\nUnion artifacts: ${path.dirname(union.worktree)}\nWorktree retained for review: ${union.worktree}\nBranch retained for review: ${union.branch}` : "";
  return `${banner}--- UNION RECORD ---\n${JSON.stringify(union, null, 2)}${artifacts}`;
}

/**
 * What a person calls a job: its commit subject, else the task's first
 * sentence, capped. Two jobs on one agent and model differ here even with no
 * role, so a notification can tell them apart.
 */
export function jobLabel(args) {
  const text = String(args?.commit_subject || args?.task || "").split("\n")[0].split(/(?<=\.)\s/)[0].trim();
  return text.length > 60 ? `${text.slice(0, 57)}...` : text || null;
}

/**
 * Seconds a job has run: to its finish once it has one, not to whenever it's
 * asked about. The record's total_elapsed covers the whole job; an implement
 * job's finishedAt marks only the worker's end, before verification and commit.
 */
export function jobElapsedSeconds({ status = null, meta = null, entry = null, now = Date.now() } = {}) {
  const total = meta?.metrics?.total_elapsed;
  if (Number.isFinite(total)) return Math.round(total / 1000);
  const startedMs = Date.parse(status?.startedAt ?? entry?.startedAt ?? meta?.startedAt ?? "");
  if (!Number.isFinite(startedMs)) return null;
  const finishedMs = Date.parse((status?.state === "finished" ? status.updatedAt : null) ?? meta?.finishedAt ?? "");
  return Math.round(((Number.isFinite(finishedMs) ? finishedMs : now) - startedMs) / 1000);
}
