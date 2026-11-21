// Frozen acceptance tests and tests-first jobs.
//
// A worker that writes both the code and the tests that judge it can make
// them agree by changing either. Frozen tests come from somewhere else: the
// General names test files (or a tests-first job whose tests become the
// set), the build job must make them pass, and any edit, rename or deletion
// of one refuses the commit. Mechanical, like the refactor contract: not a
// review flag the General might skim past.
//
// A tests-first job writes failing tests from the acceptance criteria and
// nothing else. Its tests must fail against the base (they describe work
// not done yet), and it may not touch production code. Its committed tests
// are the frozen set for the build job, which ideally runs on another vendor.

import { isTestPath } from "./diff-checks.mjs";

/** Validate and normalize frozen paths: repository-relative, no `..`. */
export function normalizeFrozenPaths(paths = []) {
  const out = [], problems = [];
  for (const raw of paths) {
    const p = String(raw ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (!p || p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.split("/").includes("..")) { problems.push(`frozen_tests: "${raw}" must be a path inside the repository`); continue; }
    out.push(p.replace(/\/+$/, (m) => (m ? "/" : "")));
  }
  return { paths: [...new Set(out)], problems };
}

const covers = (frozen, file) => (frozen.endsWith("/") ? file.startsWith(frozen) : file === frozen);

/** Frozen paths that are missing from the base commit's file list. */
export function missingFrozen(frozen, baseFiles) {
  const files = [...baseFiles];
  return frozen.filter((f) => !files.some((file) => covers(f, file)));
}

/**
 * Changes that touch a frozen test.
 * @param {string[]} frozen normalized paths (a trailing / freezes a directory)
 * @param {{ status: string, path: string, oldPath?: string|null }[]} nameStatus
 */
export function frozenViolations(frozen = [], nameStatus = []) {
  if (!frozen.length) return [];
  const out = [];
  for (const entry of nameStatus) {
    const touched = [entry.path, entry.oldPath].filter(Boolean).find((file) => frozen.some((f) => covers(f, file)));
    if (!touched) continue;
    const how = /^D/.test(entry.status) ? "deleted" : /^R/.test(entry.status) ? `renamed to ${entry.path}` : /^A/.test(entry.status) ? "added inside a frozen directory" : "edited";
    out.push({ file: touched, how });
  }
  return out;
}

/** Applies after every other rule: a frozen test changed means no commit. */
export function applyFrozenTests(outcome, { frozen = [], nameStatus = [], verificationStatus = null, done = [] } = {}) {
  if (!frozen.length) return outcome;
  const touched = frozenViolations(frozen, nameStatus);
  const reasons = [...(outcome.reasons ?? [])];
  let why = null;
  if (touched.length) {
    why = `frozen tests changed: ${touched.slice(0, 5).map((t) => `${t.file} (${t.how})`).join(", ")}${touched.length > 5 ? ", ..." : ""}; the worker must make frozen tests pass, not change them`;
    reasons.push(`FROZEN TEST CHANGED: ${why}`);
  } else if (verificationStatus !== "pass") {
    why = `frozen tests: verification was ${verificationStatus ?? "not run"}, so they aren't shown to pass`;
    reasons.push(`FROZEN TESTS NOT SHOWN PASSING: ${why}`);
  }
  if (!why) return outcome;
  const wasDone = done.includes(outcome.outcome);
  return { ...outcome, ...(wasDone ? { outcome: "NEEDS_REVIEW" } : {}), reviewRequired: true, commitAllowed: false, commitBlockedReason: outcome.commitAllowed ? why : outcome.commitBlockedReason ?? why, reasons };
}

/** The worker's instructions for a tests-first job, put before the objective. */
export const TESTS_FIRST_BRIEF = [
  "TESTS-FIRST JOB: write failing tests only.",
  "- Write or extend tests that pin down every acceptance criterion below, as exact as the criteria allow.",
  "- Do not change production code, configuration or fixtures used by other tests. Only test files.",
  "- The tests must FAIL now, because the behavior doesn't exist yet. Run them and confirm each fails for the right reason (an assertion about the missing behavior, not a syntax error or a missing import of a module that should exist).",
  "- Another job builds the code against these tests and can't change them, so test behavior through public interfaces, not internals that the builder should be free to choose.",
  "- Report STATUS done and TESTS fail when the new tests fail as intended; TESTS pass would mean they don't capture the missing behavior.",
].join("\n");

/** A tests-first report is valid with STATUS done and TESTS fail. */
export function testsFirstReport(report) {
  if (!report?.strict || report.status !== "done" || report.tests !== "fail") return report;
  return { ...report, valid: true, gate: { satisfied: true, reason: null }, reason: null };
}

/**
 * The outcome of a tests-first job, replacing resolveOutcome's: success is
 * failing new tests with no production change.
 */
export function testsFirstOutcome({ report, testChanges, verification, workerFailed = false, workerTimedOut = false }) {
  const base = { recovered: false, recoveryAttempted: false, retainWorktree: true, verification: verification?.status ?? "not_run", reasons: [] };
  const block = (outcome, why) => ({ ...base, outcome, reviewRequired: true, commitAllowed: false, commitBlockedReason: why, reasons: [why] });
  if (workerTimedOut) return block("WORKER_TIMEOUT", "worker timed out");
  if (workerFailed) return block("WORKER_FAILED", "worker process failed");
  if (!report?.valid) return block("WORKER_REPORT_INVALID", `tests-first: ${report?.reason ?? "no valid report"}`);
  if (report.status !== "done") return block(report.status === "partial" ? "WORKER_PARTIAL" : "WORKER_BLOCKED", `worker reported STATUS: ${report.status}`);
  const production = (testChanges?.production_files_changed ?? []).filter((f) => !isTestPath(f));
  if (production.length) return block("NEEDS_REVIEW", `tests-first: production files changed (${production.slice(0, 5).join(", ")}); a tests-first job writes tests only`);
  const tests = [...(testChanges?.new_tests_added ?? []), ...(testChanges?.existing_tests_modified ?? [])];
  if (!tests.length) return block("NEEDS_REVIEW", "tests-first: no test file was added or changed");
  if (verification?.status === "pass") return block("NEEDS_REVIEW", "tests-first: the new tests already pass on the base, so they don't capture the missing behavior");
  if (verification?.status !== "fail") return block("NEEDS_REVIEW", `tests-first: verification was ${verification?.status ?? "not run"}, so the tests aren't shown to fail`);
  return { ...base, outcome: "WORKER_DONE", reviewRequired: false, commitAllowed: true, commitBlockedReason: null,
    reasons: [`tests-first: ${tests.length} test file(s) fail as intended; read verification.log to confirm they fail on assertions, not on errors`] };
}

/** The frozen set a tests-first job hands its build job. */
export function frozenFromTestsFirst(record) {
  if (!record) return { problem: "no record for that job" };
  if (!record.testsFirst) return { problem: "it isn't a tests-first job" };
  if (!record.commit?.created || !record.commit?.sha) return { problem: "it has no commit (only a finished tests-first job's tests can be frozen)" };
  const tests = [...(record.testChanges?.new_tests_added ?? []), ...(record.testChanges?.existing_tests_modified ?? [])];
  if (!tests.length) return { problem: "it changed no test files" };
  return { commit: record.commit.sha, tests, vendor: record.worker?.provider ? { provider: record.worker.provider, model: record.worker.model ?? null } : null };
}
