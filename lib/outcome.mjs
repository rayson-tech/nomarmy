import { vendorOf, recordGeneralVendor, independentVendor, UNKNOWN_VENDOR } from "./vendor.mjs";
import { OUTCOMES } from "./outcomes.mjs";
import { parseWorkerReport } from "./report.mjs";

// ---------------------------------------------------------------------------
// Outcome state machine (plan 4).
// The one rule that must never bend: failing independent verification stays
// failed. Recovery exists so that a mangled REPORT cannot destroy correct WORK.
// It does not exist to launder a failure into a success.
// ---------------------------------------------------------------------------
// A failed verification's own detail (the command, its exit code, the end of
// its output), capped so an issue line stays readable; the full output is in
// the job's verification.log.
const FAILURE_DETAIL_CHARS = 600;
function failureDetail(independentVerification) {
  const detail = String(independentVerification?.detail ?? independentVerification?.reason ?? "").trim();
  if (!detail) return "";
  return `: ${detail.length > FAILURE_DETAIL_CHARS ? `${detail.slice(0, FAILURE_DETAIL_CHARS)}...` : detail}`;
}

export function resolveOutcome({ report, repositoryChanged = false, independentVerification = null, regressionCheck = null, workerFailed = false, workerTimedOut = false, mode = "implement" }) {
  const verification = independentVerification?.status ?? "not_run";
  const parsed = report ?? parseWorkerReport("");
  // nomArmy never removes a worktree on its own; local_worker_cleanup is an
  // explicit, reviewed action. Retention is asserted here so that the
  // guarantee is testable rather than incidental.
  const base = { outcome: null, recovered: false, recoveryAttempted: false, commitAllowed: false, commitBlockedReason: null,
    reviewRequired: false, retainWorktree: true, verification, reasons: [] };

  if (workerTimedOut) {
    return { ...base, outcome: OUTCOMES.WORKER_TIMEOUT, reviewRequired: true,
      commitBlockedReason: "worker timed out; a timed-out worker's partial work is never auto-committed",
      reasons: ["worker timed out"] };
  }
  if (workerFailed) {
    return { ...base, outcome: OUTCOMES.WORKER_FAILED, reviewRequired: repositoryChanged,
      commitBlockedReason: "worker process failed", reasons: ["worker process failed"] };
  }

  if (parsed.valid) {
    if (parsed.status === "partial") return { ...base, outcome: OUTCOMES.WORKER_PARTIAL, reviewRequired: true, commitBlockedReason: "worker reported STATUS: partial", claimBlocked: true, reasons: ["worker reported partial"] };
    if (parsed.status === "blocked") return { ...base, outcome: OUTCOMES.WORKER_BLOCKED, reviewRequired: true, commitBlockedReason: "worker reported STATUS: blocked", claimBlocked: true, reasons: ["worker reported blocked"] };
    // STATUS done + TESTS pass. Independent verification may still veto, never
    // rubber-stamp: a `fail` blocks the commit the v1.2 gate would have made.
    if (verification === "fail") {
      return { ...base, outcome: OUTCOMES.NEEDS_REVIEW, reviewRequired: true,
        commitBlockedReason: "independent verification failed despite a clean done/pass report",
        // Structured, so a General can act on it without parsing prose.
        reportMismatch: { report: "STATUS done, TESTS pass", verification: "fail", failingTests: independentVerification?.failingTests ?? null },
        reasons: [`worker claimed done/pass but independent verification failed${failureDetail(independentVerification)}`] };
    }
    // verify_regression: reverting just the production files and re-running
    // the SAME verification profile still passed (or came back genuinely
    // inconclusive after actually being attempted) -- independent proof that
    // no test in this run would catch the change being undone. That is a
    // distinct finding from independent verification itself failing: the
    // diff is not shown to be broken, its test coverage is shown not to
    // prove it correct. `basis !== "not-applicable"` is what keeps "not
    // requested" and "no production files changed" (both legitimately
    // status: "not_run") from ever landing here -- only an attempted check
    // that came back anything other than a clean "pass" (coverage proven)
    // does.
    if (regressionCheck && regressionCheck.basis !== "not-applicable" && regressionCheck.status !== "pass") {
      return { ...base, outcome: OUTCOMES.NEEDS_REVIEW, reviewRequired: true,
        commitBlockedReason: regressionCheck.status === "fail"
          ? "reverting the production change did not fail verification; no test demonstrably covers this change"
          : `regression check was inconclusive: ${regressionCheck.reason}`,
        reasons: [`regression check: ${regressionCheck.status} (${regressionCheck.reason})`] };
    }
    // A valid done/pass report on an implement job that left the repository
    // byte-for-byte unchanged is indistinguishable from a worker that simply
    // failed to act -- the claim is internally consistent but nothing here
    // checks it against reality. The invalid-report path below already
    // refuses to recover without a real repository change; a well-formed
    // report deserves the same scrutiny, not less.
    if (mode === "implement" && !repositoryChanged) {
      return { ...base, outcome: OUTCOMES.NEEDS_REVIEW, reviewRequired: true, commitAllowed: false,
        commitBlockedReason: "worker reported done/pass but the repository has no changes from the base commit",
        reasons: ["worker claimed done/pass but the repository is unchanged from the base commit"] };
    }
    // A clean done/pass report with no independent verification evidence
    // still commits (the v1.2 acceptance gate, preserved on purpose -- see
    // the test guarding it) but must not say a human need not look: the
    // record is honest that nothing here checked the claim against reality,
    // and reviewRequired: false was letting a coordinator read WORKER_DONE
    // and stop there. This does not change what commits; only what gets
    // flagged for a human to see.
    return { ...base, outcome: OUTCOMES.WORKER_DONE, commitAllowed: mode === "implement",
      reviewRequired: verification === "not_run" || independentVerification?.baseComparison?.classification === "preexisting",
      commitBlockedReason: mode === "implement" ? null : `${mode} mode does not create commits` };
  }

  // --- the report is not a valid claim -----------------------------------
  if (!repositoryChanged) {
    return { ...base, outcome: OUTCOMES.WORKER_REPORT_INVALID,
      commitBlockedReason: `invalid report and no repository change: ${parsed.reason}`,
      reasons: [`worker report invalid: ${parsed.reason}`, "no repository change to recover"] };
  }

  // Repository state changed. Run/consume independent verification anyway: a
  // truncated report must not by itself invalidate correct work.
  const recovery = { ...base, recoveryAttempted: true, reviewRequired: true,
    reasons: [`worker report invalid: ${parsed.reason}`, "repository changed; independent verification consulted"] };

  if (verification === "fail") {
    return { ...recovery, outcome: OUTCOMES.WORKER_REPORT_INVALID,
      commitBlockedReason: "independent verification failed; recovery cannot promote a failure",
      reasons: [...recovery.reasons, `independent verification FAILED${failureDetail(independentVerification)}`] };
  }
  if (verification === "pass") {
    // A leniently recovered `done` plus a passing independent check is the
    // only route to RECOVERED_SUCCESS, and it stays marked as weaker evidence.
    if (parsed.status === "done" && parsed.tests !== "fail") {
      return { ...recovery, outcome: OUTCOMES.RECOVERED_SUCCESS, recovered: true, commitAllowed: mode === "implement",
        commitBlockedReason: mode === "implement" ? null : `${mode} mode does not create commits`,
        reasons: [...recovery.reasons, "independent verification PASSED; recovered from an invalid report"] };
    }
    return { ...recovery, outcome: OUTCOMES.NEEDS_REVIEW, recovered: true,
      commitBlockedReason: "independent verification passed but no recoverable done claim; a human or the coordinator decides", claimBlocked: true,
      reasons: [...recovery.reasons, "independent verification PASSED but the worker's claim is unrecoverable"] };
  }
  return { ...recovery, outcome: OUTCOMES.NEEDS_REVIEW,
    commitBlockedReason: "no independent verification evidence; a recovered job is never committed on the worker's claim alone",
    reasons: [...recovery.reasons, "independent verification did not run"] };
}

/**
 * Whether the General may commit this job itself (local_worker_commit) after
 * reviewing it. Only a job whose sole obstacle was the worker's own claim
 * qualifies: it said partial or blocked (often because it couldn't run a
 * slow suite or fetch a toolchain offline), or its report couldn't be
 * recovered, while nomArmy's own verification of the change passed. Every
 * mechanical gate the done path enforces still applies here; this replaces
 * the "change nothing, report done" follow-up job, not any check.
 */
export function generalCommitEligibility({ outcome, mode = "implement", repositoryChanged = false, verificationStatus = null,
  regressionCheck = null, possibleSecret = false, blockedInputs = 0, mutationStatus = null, workerStopReason = null }) {
  const no = (reason) => ({ eligible: false, reason });
  if (mode !== "implement") return no(`${mode} mode does not create commits`);
  if (outcome?.commitAllowed) return no("the coordinator commits this job itself");
  if (!outcome?.claimBlocked) return no(outcome?.commitBlockedReason ?? `outcome ${outcome?.outcome} does not permit a commit`);
  if (workerStopReason === "stopped") return no("the job was stopped on request; continue it with continue_from");
  if (!repositoryChanged) return no("the worker changed nothing");
  if (verificationStatus !== "pass") return no(`independent verification was ${verificationStatus ?? "not run"}; only a change nomArmy verified can be committed without a done report`);
  if (regressionCheck && regressionCheck.basis !== "not-applicable" && regressionCheck.status !== "pass") return no(`regression check: ${regressionCheck.status} (${regressionCheck.reason})`);
  if (possibleSecret) return no("a possible secret was detected in the diff");
  if (blockedInputs > 0) return no("the diff changes what verification runs, so its pass can't be trusted");
  if (mutationStatus === "restore_failed") return no("mutation testing could not restore the worker's file");
  return { eligible: true, reason: `the worker reported ${outcome.outcome === OUTCOMES.WORKER_PARTIAL ? "partial" : outcome.outcome === OUTCOMES.WORKER_BLOCKED ? "blocked" : "no usable done claim"}, but independent verification passed: review it, then local_worker_commit can commit it` };
}

export function finalText(result) { return result?.final ?? result?.payloads?.[0]?.text ?? ""; }
// `error` is OpenClaw's own failure message when it returned an ok:false
// envelope rather than exiting nonzero (how "Unknown model" and vendor limit
// errors can arrive); without it a run couldn't tell a usage limit apart.
export function workerMetadata(result) { return { model: result?.model ?? null, provider: result?.provider ?? null, sessionId: result?.sessionId ?? null, status: result?.status ?? null, usage: result?.usage ?? null, toolSummary: result?.toolSummary ?? null, error: result?.ok === false ? String(result?.error?.message ?? "").slice(0, 1000) || null : null }; }
export function intOrNull(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
// OpenClaw's envelope reports { input, output, cacheRead, cacheWrite };
// only the older { inputTokens, ... } shape was read, so every job's
// tokens showed 0.
export function usageMetrics(result) {
  const u = result?.usage;
  if (!u || typeof u !== "object") return { worker_tokens_in: null, worker_tokens_out: null, worker_tokens_total: null, worker_tokens_cache_read: null, worker_tokens_cache_write: null };
  const input = intOrNull(u.inputTokens ?? u.input_tokens ?? u.promptTokens ?? u.prompt_tokens ?? u.input);
  const output = intOrNull(u.outputTokens ?? u.output_tokens ?? u.completionTokens ?? u.completion_tokens ?? u.output);
  const cacheRead = intOrNull(u.cacheRead ?? u.cache_read_input_tokens);
  const cacheWrite = intOrNull(u.cacheWrite ?? u.cache_creation_input_tokens);
  // Everything the model processed. Every vendor's `input` here leaves out
  // cached prompt tokens, and an agent's prompt is mostly cache (a Claude
  // job: 58 input, 2.2M cache reads): input + output alone read as 195
  // tokens for three Opus jobs. The parts stay separate for cost.
  const total = input !== null && output !== null ? input + output + (cacheRead ?? 0) + (cacheWrite ?? 0) : intOrNull(u.totalTokens ?? u.total_tokens ?? u.total);
  return { worker_tokens_in: input, worker_tokens_out: output, worker_tokens_total: total, worker_tokens_cache_read: cacheRead, worker_tokens_cache_write: cacheWrite };
}
// Only fields nomArmy can actually observe are populated. Anything it cannot
// see stays null: a fabricated metric is worse than a missing one.
// Elapsed times are milliseconds.
export function createBuildMetrics({ execution, contextLimit }) {
  return function buildMetrics({ result, record, reportValidation, outcome, workerElapsedMs, totalElapsedMs, regressionCheckElapsedMs, transientAbortRetried = false }) {
    const tools = result?.toolSummary ?? null;
    const tests = record?.testChanges ?? null;
    const metrics = usageMetrics(result);
    const workerTokensPerSecond = (metrics.worker_tokens_total !== null && metrics.worker_tokens_total > 0 && workerElapsedMs !== null && workerElapsedMs > 0)
      ? Number((metrics.worker_tokens_total / (workerElapsedMs / 1000)).toFixed(1))
      : null;
    return {
      worker_elapsed: intOrNull(workerElapsedMs),
      total_elapsed: intOrNull(totalElapsedMs),
      regression_check_elapsed: intOrNull(regressionCheckElapsedMs),
      files_changed: record ? record.filesChanged : null,
      lines_added: record ? record.additions : null,
      lines_removed: record ? record.deletions : null,
      production_files_changed: tests ? tests.production_files_changed.length : null,
      new_tests_added: tests ? tests.new_tests_added.length : null,
      existing_tests_modified: tests ? tests.existing_tests_modified.length : null,
      existing_tests_deleted: tests ? tests.existing_tests_deleted.length : null,
      report_truncated: reportValidation ? reportValidation.truncated : null,
      report_strict: reportValidation ? reportValidation.strict : null,
      report_recovered: outcome ? Boolean(outcome.recovered) : null,
      worker_timeout: outcome ? outcome.outcome === OUTCOMES.WORKER_TIMEOUT : null,
      // Real money was spent twice for one useful attempt when this fires --
      // see TRANSIENT_INFERENCE_ABORT_PATTERN's comment for why. Never
      // inferred after the fact; only ever true when executeImplement itself
      // actually triggered the retry.
      worker_transient_abort_retried: transientAbortRetried,
      ...metrics,
      worker_tool_calls: intOrNull(tools?.calls ?? tools?.total ?? tools?.count),
      worker_tool_failures: intOrNull(tools?.failures),
      // The default worker model is the local model's; an api or subscription
      // envelope without a model must not be recorded as running it (its
      // vendor decides whether a review was independent).
      worker_model: result?.model ?? (!result?.provider || result.provider === "llama-cpp" ? execution.defaultWorkerModel ?? null : null),
      // Was already read into workerMetadata() above but discarded before
      // reaching here -- every pool-routed job's actual provider is now
      // visible in job metrics, not just its model name. runOpenClaw already
      // backfills this from the entry it actually selected whenever
      // OpenClaw's own envelope omits it, so this must NOT also fall back to
      // the single global execution.defaultWorkerProvider here -- that would
      // silently misattribute a pool-routed job to the wrong provider.
      worker_provider: result?.provider ?? null,
      // Best-effort: present in `agent exec --json`'s envelope for at least
      // some providers (observed directly during this feature's own live
      // testing), but not confirmed reliable/nonzero across every provider
      // type here -- treat as a hint, not an authoritative bill.
      worker_cost_usd: intOrNull(result?.costUsd),
      worker_tokens_per_second: workerTokensPerSecond,
      context_limit: contextLimit
    };
  };
}

/** Admission problems for one implement job under the repo's policy. */
export function policyAdmissionProblems(job, policy) {
  if ((job.mode ?? "implement") !== "implement") return [];
  const problems = [];
  if (job.refactor && !job.verification) problems.push("a refactor job needs a `verification` profile: its unchanged tests passing is the only evidence it changed nothing");
  else if (policy.require_verification && !job.verification) problems.push("this repo requires verification (policy.require_verification in .nomarmy.yml): give the job a `verification` profile (local_worker_config lists them)");
  // A refactor meets the regression requirement through its own contract
  // (applyRefactorContract), not the revert check.
  if (policy.require_regression_check && job.verify_regression === false && !job.refactor) problems.push("this repo requires the revert check (policy.require_regression_check in .nomarmy.yml): verify_regression can't be false (a behavior-preserving change can declare refactor: true instead)");
  // stakes: high (security, data loss, irreversible): the checks a General
  // could skip on routine work are mandatory, whatever the repo's policy.
  if (job.stakes === "high") {
    if (!job.verification && !job.refactor) problems.push("a stakes: high job needs a `verification` profile: its result is only as good as the tests that prove it");
    if (job.verify_regression === false && !job.refactor) problems.push("a stakes: high job can't turn the revert check off (verify_regression: false): it's the proof a test catches the change");
  }
  return problems;
}

/** The default review line for high-stakes jobs without independent judge evidence. */
export const HIGH_STAKES_NOTE = "HIGH STAKES: accept this only after an independent review: a scout on another vendor (army_role security-analyst or similar) with reviews: <this job id>, or a judge on another vendor. Passing its tests isn't enough on its own; most defects that pass every check are in security, data or deploy-only paths.";

// Shared by the job's issue and aggregate review accounting.
export function independentlyReviewedByJudge(judge, workerProvider, { workerModel = null, record = null, generalVendor = null } = {}) {
  return Boolean(judge?.answer && !judge.error && !judge.skipped && judge.provider
    && independentVendor(vendorOf(judge.provider, judge.model), vendorOf(workerProvider, workerModel), recordGeneralVendor(record, generalVendor)));
}

export function highStakesNote(judge, workerProvider, options = {}) {
  if (independentlyReviewedByJudge(judge, workerProvider, options)) {
    return `HIGH STAKES: independently reviewed by judge ${judge.agent}/${judge.model}. Still needs the General's acceptance.`;
  }
  if (!(judge?.answer && !judge.error && !judge.skipped && judge.provider)) return HIGH_STAKES_NOTE;
  // Say why a judge that ran doesn't count, so the operator knows what to fix.
  const generalVendor = recordGeneralVendor(options.record, options.generalVendor);
  const judgeVendor = vendorOf(judge.provider, judge.model), workerVendor = vendorOf(workerProvider, options.workerModel);
  if (judgeVendor === UNKNOWN_VENDOR || workerVendor === UNKNOWN_VENDOR || generalVendor === UNKNOWN_VENDOR) {
    return `HIGH STAKES: judged by ${judge.agent}/${judge.model}, but the ${judgeVendor === UNKNOWN_VENDOR ? "judge's" : workerVendor === UNKNOWN_VENDOR ? "worker's" : "General's"} vendor can't be told from its provider and model, so independence isn't shown: review with a scout on a known other vendor.`;
  }
  if (judgeVendor !== workerVendor && judgeVendor === generalVendor) {
    return `HIGH STAKES: judged by ${judge.agent}/${judge.model}, the General's own vendor (${generalVendor}), so not independent: review with a scout on another vendor.`;
  }
  return HIGH_STAKES_NOTE;
}

/**
 * A declared refactor commits only when verification passed and no test
 * file was added, changed or deleted. Mechanical, not the General's call:
 * a change that alters behavior has to alter tests to show it, which this
 * refuses. Found splitting server.mjs: the revert check restores the old
 * code, which works, so it flagged every behavior-preserving move.
 *
 * The one exception is a test change shown behavior-neutral by
 * analyzeRefactorTestChanges (lib/refactor-tests.mjs): a test moved with its
 * module, or an edit whose only changed lines re-point module specifiers.
 * Those pass with a non-blocking note naming the files, so a module move
 * doesn't force a mode switch. Without that analysis every test change blocks.
 */
export function applyRefactorContract(outcome, { refactor, verificationStatus, testChanges, neutralTestChanges = null }) {
  if (!refactor) return outcome;
  const touched = [...(testChanges?.new_tests_added ?? []), ...(testChanges?.existing_tests_modified ?? []), ...(testChanges?.existing_tests_deleted ?? [])];
  const neutralFiles = neutralTestChanges?.files ?? [];
  const neutralPaths = new Set(neutralFiles.flatMap(f => [f.path, f.from].filter(Boolean)));
  const notNeutral = new Set((neutralTestChanges?.blocking ?? []).map(b => b.path));
  const blocking = touched.filter(f => !neutralPaths.has(f) || notNeutral.has(f));
  const why = blocking.length
    ? `refactor: test files changed (${blocking.slice(0, 5).join(", ")}${blocking.length > 5 ? ", ..." : ""}); a refactor must pass the existing tests unchanged`
    : verificationStatus !== "pass" ? `refactor: verification was ${verificationStatus ?? "not run"}; a refactor commits only when the unchanged tests pass` : null;
  if (why) return blockedForReview(outcome, why);
  if (!touched.length) return outcome;
  const listed = neutralFiles.map(f => f.from ? `${f.from} -> ${f.path} (${f.kind})` : `${f.path} (${f.kind})`);
  const note = `refactor: test paths/imports changed with no other line changed, glance at them: ${listed.join(", ")}`;
  return { ...outcome, reasons: [...(outcome.reasons ?? []), note] };
}
// A job whose commit a rule blocked reads as needing review, never as done.
export function blockedForReview(outcome, why) {
  const done = outcome.outcome === OUTCOMES.WORKER_DONE || outcome.outcome === OUTCOMES.RECOVERED_SUCCESS;
  // A rule now blocks it too, so the worker's claim is no longer the only
  // obstacle: the General can't commit it either (generalCommitEligibility).
  return { ...outcome, ...(done ? { outcome: OUTCOMES.NEEDS_REVIEW } : {}), reviewRequired: true, commitAllowed: false, claimBlocked: false, commitBlockedReason: why, reasons: [...(outcome.reasons ?? []), why] };
}

/** The outcome with the commit blocked when policy requires verification that didn't pass. */
export function applyVerificationPolicy(outcome, verificationStatus, policy) {
  if (!policy.require_verification || verificationStatus === "pass" || !outcome.commitAllowed) return outcome;
  const why = `policy.require_verification: verification was ${verificationStatus ?? "not run"}, and this repo commits only work whose verification passed`;
  return blockedForReview(outcome, why);
}

export function resolveVerifyRegression(args) {
  // A refactor's evidence is the unchanged tests passing; reverting it
  // restores working code, so the revert check would always "fail".
  if (args.refactor) return false;
  if (typeof args.verify_regression === "boolean") return args.verify_regression;
  return args.mode === "implement" && Boolean(args.verification);
}
