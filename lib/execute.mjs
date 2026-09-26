import { writeStatus, shouldRetryTransientAbort, shouldAttemptScoutRecovery } from "./openclaw-run.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { measureReads } from "./job-budgets.mjs";
import { coordinatorCommitMessage, worktreePointerState } from "./git-record.mjs";
import { parseScoutReport, verifyCitations, resolveScoutOutcome, renderScoutReport, isScoutReportUnusable, scoutReportRecoveryPrompt } from "./scout.mjs";
import { parseDecomposeReport, buildDecomposeFindings, resolveDecomposeOutcome, checkDecompositionOverlap, renderDecomposeReport } from "./decompose.mjs";
import { deriveTimeBudget } from "./budget.mjs";
import { estimateDisplacement } from "./transcript.mjs";
import { outlineFile, findReferences } from "./repo-query.mjs";
import { loadConfig } from "./config.mjs";
import { linkNodePackages, nodeModulesState, repairHostInstalls } from "./sandbox-images.mjs";
import { detectTestSabotage, addedLinesOf, loadDependencyNames } from "./sabotage.mjs";
import { describeRecoveryChanges, reportRecoveryPrompt } from "./worker-prompt.mjs";
import { parseWorkerReport } from "./report.mjs";
import { OUTCOMES, COORDINATOR_STATUS_BY_OUTCOME } from "./outcomes.mjs";
import { resolveOutcome, finalText, workerMetadata, applyRefactorContract, applyVerificationPolicy } from "./outcome.mjs";
import { isTestPath, isDocumentationPath, detectScopedTestSelectionRisk, detectUnwiredNewDefinitions, detectMislabeledTestNames, detectPossibleSecrets } from "./diff-checks.mjs";

// ---------------------------------------------------------------------------
// Job status for polling. `status.json` is written at every phase transition
// so a poller sees where a job is, not a fabricated percentage. The phases are
// the ones nomArmy itself passes through; inside the worker phase the only
// honest signal is elapsed time against the timeout.
// ---------------------------------------------------------------------------
export const JOB_PHASES = Object.freeze(["starting", "worktree", "worker", "verification", "commit", "record", "finished"]);
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createExecutor(deps) {
  const { VERSION, projectDir, jobsRoot, run, git, gitRaw,
    collectGitRecord, createCoordinatorCommit, ensureJobsRoot, slug, assertRepo,
    resolveBase, workerModelThinkingSupported, budgetState, execution, buildMetrics,
    resolveReasoningApplied, recordedBudgets, runOpenClaw, sweepStaleSandboxContainers,
    verificationFlow, normalizeVerification, runIndependentVerification,
    runRegressionCheck, repoPolicy } = deps;

  async function executeJob({ task, acceptance, verification, mode = "implement", baseRef, timeoutSeconds = 600, profile = "coder", reasoning = "high", pool = null, subscriptionWorker = null, onBehalfOf = null, model = null, reportSize = null, workerId, evidence = null, verifyRegression = false, commitSubject = null, refactor = false, jobId: presetJobId = null }) {
    await assertRepo();
    ensureJobsRoot();
    // Fire-and-forget: sweeps whatever this or any other nomArmy install left
    // behind, without adding container-CLI round-trip latency to this job's own start.
    if (mode !== "verify") sweepStaleSandboxContainers().catch(() => {});
    const jobStartedMs = Date.now();
    const base = await resolveBase(baseRef), jobId = presetJobId || slug(workerId || (mode === "scout" ? "scout" : mode === "decompose" ? "decompose" : "worker")), jobDir = path.join(jobsRoot, jobId), runtimeDir = path.join(jobDir, "runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    const progress = (phase, extra = {}) => writeStatus(jobDir, {
      jobId, workerId: workerId || jobId, mode, phase, state: phase === "finished" ? "finished" : "running",
      serverPid: process.pid, baseSha: base.sha, timeoutSeconds, ...extra
    });
    progress("starting", { startedAt: new Date().toISOString(), agent: mode === "verify" ? null : pool ?? subscriptionWorker ?? "local", model: model ?? null });
    const common = { task, acceptance, base, jobId, jobDir, runtimeDir, timeoutSeconds, profile, reasoning, pool, subscriptionWorker, onBehalfOf, model, reportSize, workerId, progress, jobStartedMs };
    if (mode === "verify") return executeVerify({ ...common, verification });
    if (mode === "scout") return executeScout(common);
    if (mode === "decompose") return executeDecompose(common);
    return executeImplement({ ...common, verification, evidence, verifyRegression, commitSubject, refactor });
  }

  async function executeVerify({ task, verification: profile, base, jobId, jobDir, workerId, progress, jobStartedMs }) {
    const worktree = path.join(jobDir, "worktree");
    let verification, record = null, error = null;
    try {
      progress("worktree");
      await run("git", ["worktree", "add", "--detach", worktree, base.sha], { cwd: projectDir });
      record = await collectGitRecord({ cwd: worktree, baseSha: base.sha, baseRef: base.ref, branch: null, jobId });
      progress("verification");
      verification = await runIndependentVerification({ profile, cwd: worktree, jobId, baseSha: base.sha, branch: null, mode: "verify", record, logFile: path.join(jobDir, "verification.log") });
    } catch (err) {
      error = err.message;
      verification = normalizeVerification({ status: "not_run", reason: error }, profile);
    } finally {
      try { await run("git", ["worktree", "remove", "--force", worktree], { cwd: projectDir }); }
      catch (err) { error = [error, err.message].filter(Boolean).join("\n"); }
    }
    const retained = fs.existsSync(worktree);
    const outcome = retained ? OUTCOMES.VERIFICATION_NOT_RUN : {
      pass: OUTCOMES.VERIFIED, fail: OUTCOMES.VERIFICATION_FAILED, not_run: OUTCOMES.VERIFICATION_NOT_RUN
    }[verification.status];
    const manifest = { version: VERSION, jobId, workerId: workerId || jobId, mode: "verify", task,
      baseRef: base.ref, baseSha: base.sha, branch: null, worktree: retained ? worktree : null, worktreeRetained: retained,
      startedAt: new Date(jobStartedMs).toISOString(), finishedAt: new Date().toISOString(),
      outcome, coordinatorStatus: COORDINATOR_STATUS_BY_OUTCOME[outcome], verification, git: record, error,
      metrics: { total_elapsed: Date.now() - jobStartedMs, worker_cost_usd: 0, worker_tokens_total: 0, model_calls: 0 } };
    fs.writeFileSync(path.join(jobDir, "metadata.json"), JSON.stringify(manifest, null, 2));
    progress("finished", { outcome, coordinatorStatus: manifest.coordinatorStatus });
    return { ok: outcome === OUTCOMES.VERIFIED, manifest, jobDir, report: "" };
  }

  async function executeImplement({ task, acceptance, verification, base, jobId, jobDir, runtimeDir, timeoutSeconds, profile, reasoning, pool = null, subscriptionWorker = null, onBehalfOf = null, model = null, reportSize = null, workerId, evidence, verifyRegression = false, commitSubject = null, refactor = false, progress, jobStartedMs }) {
    const mode = "implement";
    let branch = `agent/${jobId}`, worktree = path.join(jobDir, "worktree");
    try {
      progress("worktree");
      await run("git", ["worktree", "add", "-b", branch, worktree, base.sha], { cwd: projectDir });
      const cwd = worktree;
      // Each npm package below the root reaches its install in the sandbox image.
      const nodeConfig = (() => { try { return loadConfig(projectDir)?.config ?? null; } catch { return null; } })();
      try { linkNodePackages(worktree, nodeConfig); } catch { /* verification reports what's missing */ }
      let nodeModulesBefore = {};
      try { nodeModulesBefore = nodeModulesState(worktree, nodeConfig); } catch { /* no Node packages */ }
      const beforePointer = worktreePointerState(worktree), startedAt = new Date().toISOString();

      // The caller's timeout is split up front into a work phase and a
      // reserved report phase (see deriveTimeBudget) rather than letting the
      // work phase spend the whole thing and hoping there is still room for a
      // clean report afterward. The idle-diff breaker ends the work phase even
      // earlier once the worktree stops changing, on the same reasoning: a
      // worker that already has a complete diff and keeps running is spending
      // wall-clock nobody asked it to.
      const timeBudget = deriveTimeBudget({ timeoutSeconds });
      let result = null, attempted = null, workerFailed = false, workerTimedOut = false, workerStopReason = null, workerError = null;
      const workerStartedMs = Date.now();
      progress("worker");
      try {
        result = await runOpenClaw({
          task, acceptance, verification, mode, cwd, baseRef: base.ref, baseSha: base.sha,
          timeoutSeconds: timeBudget.workTimeoutSeconds, runtimeDir, profile, reasoning, pool, subscriptionWorker, onBehalfOf, model, reportSize, jobDir, workerId: workerId || jobId, evidence,
          idleDiff: { idleMs: timeBudget.idleBreakSeconds * 1000, minElapsedMs: timeBudget.idleMinElapsedSeconds * 1000, pollSeconds: timeBudget.idlePollSeconds },
        });
      } catch (error) {
        // A dead or timed-out worker no longer destroys the Git record. Collect
        // the evidence, retain the worktree, let the outcome state say so.
        workerFailed = true;
        // error.timedOut is set only by our own spawn timer or idle-diff ticker
        // (run(), above), never by scanning message text for "timed out" --
        // which means it is ALWAYS a stop nomArmy itself decided to make, with
        // the work phase's own reserved-time deadline still ahead of it. That
        // is what makes a report-recovery attempt below worth trying even
        // though the primary call failed: a plain crash (nonzero exit, no
        // timedOut flag) leaves workerTimedOut false and skips it, same as before.
        workerTimedOut = Boolean(error.timedOut);
        workerStopReason = error.stopReason ?? null;
        workerError = error.stack || error.message;
        attempted = error.partialResult ?? attempted;
      }
      let workerElapsedMs = Date.now() - workerStartedMs;
      if (result && (result.timedOut === true || result.status === "timeout" || result.status === "timed_out")) workerTimedOut = true;

      let report = workerFailed ? "" : finalText(result);
      let reportValidation = parseWorkerReport(report);

      // A syntactically VALID report saying STATUS: blocked, paired with this
      // exact job's own stderr showing the transient dropped-connection
      // signature (see TRANSIENT_INFERENCE_ABORT_PATTERN's comment), gets one
      // fresh retry at the full task -- not the report-recovery path just
      // below, which only resumes an existing session to finish ITS report;
      // an interrupted turn has no useful state left to resume, so this is a
      // genuinely new attempt. Bounded by whatever time actually remains in
      // this job's own overall timeout, so a retry can never make a job run
      // longer than the caller originally asked for.
      let transientAbortRetried = false;
      let stderrText = "";
      try { stderrText = fs.readFileSync(path.join(jobDir, "openclaw.stderr.log"), "utf8"); } catch { /* best effort */ }
      const remainingSeconds = timeBudget.workTimeoutSeconds - Math.round(workerElapsedMs / 1000);
      if (shouldRetryTransientAbort({ workerFailed, reportValidation, stderrText, remainingSeconds })) {
        transientAbortRetried = true;
        fs.appendFileSync(path.join(jobDir, "coordinator.log"),
          `${new Date().toISOString()} transient inference abort detected (dropped connection mid-stream, not a genuine block) -- retrying the work call once, ${remainingSeconds}s remaining\n`);
        try {
          const retryResult = await runOpenClaw({
            task, acceptance, verification, mode, cwd, baseRef: base.ref, baseSha: base.sha,
            timeoutSeconds: remainingSeconds, runtimeDir, profile, reasoning, pool, subscriptionWorker, onBehalfOf, model, reportSize, jobDir, workerId: workerId || jobId, evidence,
            idleDiff: { idleMs: timeBudget.idleBreakSeconds * 1000, minElapsedMs: timeBudget.idleMinElapsedSeconds * 1000, pollSeconds: timeBudget.idlePollSeconds },
            logSuffix: "-transient-retry",
          });
          result = retryResult;
          report = finalText(result);
          reportValidation = parseWorkerReport(report);
        } catch (error) {
          // The retry attempt itself failing is a real result -- fall
          // through with the ORIGINAL blocked report, not this error,
          // since that report is still the best evidence of what
          // actually happened; the coordinator log already has both.
          fs.appendFileSync(path.join(jobDir, "coordinator.log"), `${new Date().toISOString()} transient-abort retry itself failed: ${error.stack || error.message}\n`);
        }
        workerElapsedMs = Date.now() - workerStartedMs;
      }

      const finishedAt = new Date().toISOString();

      // The run left nothing parseable: either it finished (no crash, no
      // timeout) but OpenClaw's own opaque per-turn output budget cut the reply
      // off mid-word before it ever reached the report, or nomArmy itself ended
      // the work phase early (its reserved-time deadline, or the idle-diff
      // breaker) with the reserved report phase still unused. Either way the
      // underlying OpenClaw session in --state-dir is intact and worth resuming
      // for one follow-up call asking for nothing but the four lines. A crash
      // nomArmy did not cause (workerFailed with no timedOut) is the one case
      // left unrescued: an unknown-shape failure is not somewhere the
      // coordinator should assume a resumable session exists. Capped at one
      // attempt regardless of path; the recovered text still goes through the
      // same parseWorkerReport/resolveOutcome gate as a first-try report, so a
      // run that made no edits still cannot come back as "done".
      let reportRecoveryAttempted = false, reportRecovered = false;
      if ((!workerFailed || workerTimedOut) && !reportValidation.valid) {
        reportRecoveryAttempted = true;
        // A quick, independent look at the worktree the resumed session
        // apparently cannot recall on its own -- see reportRecoveryPrompt's own
        // comment for why this exists. Best-effort: a read failure here must
        // never block the recovery attempt itself, just fall back to the
        // no-evidence prompt.
        let changes = null;
        try {
          const preRecoveryRecord = await collectGitRecord({ cwd, baseSha: base.sha, branch, baseRef: base.ref, jobId });
          changes = describeRecoveryChanges(preRecoveryRecord);
        } catch { /* evidence is a bonus, not a precondition for attempting recovery */ }
        try {
          const recoveryResult = await runOpenClaw({
            task, acceptance, verification, mode, cwd, baseRef: base.ref, baseSha: base.sha,
            timeoutSeconds: timeBudget.reportReserveSeconds, runtimeDir, profile, reasoning, pool, subscriptionWorker, onBehalfOf, model, reportSize, jobDir, workerId: workerId || jobId,
            overridePrompt: reportRecoveryPrompt({ report: budgetState.budgets.report.implement, changes }), logSuffix: "-recovery",
          });
          const recoveryText = finalText(recoveryResult);
          const recoveryValidation = parseWorkerReport(recoveryText);
          if (recoveryValidation.valid) {
            report = recoveryText; reportValidation = recoveryValidation; reportRecovered = true;
            // The work itself never actually failed -- nomArmy paused it on
            // purpose to protect room for this exact call. A recovered valid
            // report now goes through resolveOutcome's normal done/partial/
            // blocked path (independent verification still vetoes a false
            // "done" claim), instead of being pinned to WORKER_TIMEOUT
            // regardless of what the recovery call came back with.
            workerFailed = false; workerTimedOut = false;
          }
        } catch (error) {
          fs.appendFileSync(path.join(jobDir, "coordinator.log"), `${new Date().toISOString()} report-recovery call failed: ${error.stack || error.message}\n`);
        }
      }

      const afterPointer = worktreePointerState(worktree);
      if (!afterPointer.exists || afterPointer.kind !== "file") throw new Error(`worktree Git pointer integrity failure after worker: ${JSON.stringify(afterPointer)}`);
      const preCommit = await collectGitRecord({ cwd, baseSha: base.sha, branch, baseRef: base.ref, jobId });
      const repositoryChanged = preCommit.repoStatusFiles.length > 0;

      // A worker whose tools ran outside the sandbox can leave a host-built
      // node_modules behind; verification must not run against it.
      let hostInstalls = [];
      try { hostInstalls = repairHostInstalls(cwd, nodeConfig, nodeModulesBefore); } catch { /* best-effort */ }
      if (hostInstalls.length) fs.appendFileSync(path.join(jobDir, "coordinator.log"), `${new Date().toISOString()} worker left a real ${hostInstalls.join(", ")} (packages installed outside the sandbox); removed and relinked to the dependency image before verification\n`);

      progress("verification");
      let independentVerification = normalizeVerification({ status: "not_run", basis: "not-applicable", reason: "no verification runner registered" }, verification ?? null);
      if (!repositoryChanged) {
        // Verifying an untouched worktree is verifying the base commit: a
        // failed job that changed nothing was recorded "pass" (a Senti run),
        // which reads as evidence about work that never happened.
        independentVerification = normalizeVerification({ status: "not_run", basis: "not-applicable", reason: "the worker changed nothing, so there was none of its work to verify" }, verification ?? null);
      } else if (verificationFlow.verificationRunner || !reportValidation.valid) {
        independentVerification = await runIndependentVerification({ profile: verification ?? null, cwd, jobId, baseSha: base.sha, branch, mode, record: preCommit });
      }

      // verify_regression: on by default whenever there's a verification
      // profile (resolveVerifyRegression). It doubles verification wall-clock,
      // so it runs only when there's something to re-check: a passing
      // first-pass verification on a diff that touched production code.
      // Documentation isn't code a test can prove, so it's neither reverted
      // nor a reason to run the check (isDocumentationPath).
      const codeFilesChanged = preCommit.testChanges.production_files_changed.filter((f) => !isDocumentationPath(f));
      let regressionCheck = null, regressionCheckFatal = false, regressionCheckElapsedMs = null;
      if (verifyRegression && independentVerification.status === "pass" && codeFilesChanged.length > 0) {
        const regressionStartedMs = Date.now();
        try {
          regressionCheck = await runRegressionCheck({
            cwd, jobId, productionFiles: codeFilesChanged,
            nameStatus: preCommit.nameStatus, profile: verification, baseSha: base.sha, branch, mode,
          });
        } catch (error) {
          // runRegressionCheck is designed to never throw (mirrors
          // runIndependentVerification's own try/catch-to-not_run contract);
          // this is strictly a belt-and-suspenders backstop that still treats
          // an unexpected throw as the worst case, not as "nothing happened".
          regressionCheck = { status: "restore_failed", rawRerunStatus: null, basis: "internal-error", reason: `regression check threw: ${error.message}`, detail: null };
        }
        regressionCheckElapsedMs = Date.now() - regressionStartedMs;
        if (regressionCheck.status === "restore_failed") regressionCheckFatal = true;
      }

      // resolveOutcome's own contract only ever sees pass/fail/not_run for
      // regressionCheck -- a restore_failed status is substituted to not_run
      // here so resolveOutcome never needs a fourth value; the hard override
      // below handles the real severity distinction, entirely outside
      // resolveOutcome. The manifest (below) still gets the ORIGINAL,
      // unsubstituted regressionCheck -- full transparency for the caller.
      const outcome = resolveOutcome({
        report: reportValidation, repositoryChanged, independentVerification,
        regressionCheck: regressionCheckFatal ? { ...regressionCheck, status: "not_run" } : regressionCheck,
        workerFailed, workerTimedOut, mode,
      });
      const afterRegression = regressionCheckFatal
        ? { ...outcome, outcome: OUTCOMES.NEEDS_REVIEW, commitAllowed: false,
            commitBlockedReason: `regression-check restore did not verifiably complete: ${regressionCheck.reason}`,
            reviewRequired: true, reasons: [...outcome.reasons, `REGRESSION CHECK RESTORE FAILED: ${regressionCheck.reason}`] }
        : outcome;

      // Cheap, always-on, additive: never changes commitAllowed/commitBlockedReason
      // on its own (unlike the regression-check override above), only flags for
      // review -- see detectScopedTestSelectionRisk's own doc comment for why.
      let selectionRisk = null;
      if (mode === "implement" && verification) {
        try {
          const loaded = loadConfig(projectDir); // the operator's contract; see registerVerificationRunner's call
          const profileCommands = loaded.found ? (loaded.config?.verification?.[verification]?.commands ?? []) : [];
          selectionRisk = detectScopedTestSelectionRisk({ commands: profileCommands, testChanges: preCommit.testChanges });
        } catch { /* a config load failure here is the verification runner's own problem to report, not this check's */ }
      }
      const afterSelectionRisk = selectionRisk
        ? { ...afterRegression, reviewRequired: true, reasons: [...afterRegression.reasons, `SCOPED TEST SELECTION RISK: ${selectionRisk.reason}`] }
        : afterRegression;

      // Real, recurring incident: a worker introduces a new function/class in
      // this diff that nothing outside its own test calls -- caught three
      // times today by a human reading the diff, which is exactly the kind of
      // luck a standing check should replace.
      let unwiredDefinitions = null;
      if (mode === "implement") {
        try {
          unwiredDefinitions = await detectUnwiredNewDefinitions({
            cwd, productionFiles: preCommit.testChanges.production_files_changed,
            gitDiffFn: (file) => gitRaw(["diff", "-U0", base.sha, "--", file], cwd),
            outlineFn: outlineFile, referencesFn: findReferences, isTestPathFn: isTestPath,
          });
        } catch { /* best-effort review flag; never blocks a commit on its own failure */ }
      }
      const afterUnwiredDefinitions = unwiredDefinitions
        ? { ...afterSelectionRisk, reviewRequired: true, reasons: [...afterSelectionRisk.reasons, `UNWIRED NEW DEFINITION: ${unwiredDefinitions.reason}`] }
        : afterSelectionRisk;

      // Real, recurring incident (now its fourth confirmed instance): a
      // worker's new test names a specific route/handler this same diff added,
      // but the test's own body never actually reaches it -- see
      // detectMislabeledTestNames's own doc comment.
      let mislabeledTests = null;
      if (mode === "implement") {
        try {
          mislabeledTests = await detectMislabeledTestNames({
            cwd, productionFiles: preCommit.testChanges.production_files_changed,
            testFiles: [...preCommit.testChanges.new_tests_added, ...preCommit.testChanges.existing_tests_modified],
            gitDiffFn: (file) => gitRaw(["diff", "-U0", base.sha, "--", file], cwd),
            outlineFn: outlineFile, readFileFn: (dir, file) => fs.readFileSync(path.join(dir, file), "utf8"),
          });
        } catch { /* best-effort review flag; never blocks a commit on its own failure */ }
      }
      const afterMislabeledTestsOnly = mislabeledTests
        ? { ...afterUnwiredDefinitions, reviewRequired: true, reasons: [...afterUnwiredDefinitions.reasons, `MISLABELED TEST NAME: ${mislabeledTests.reason}`] }
        : afterUnwiredDefinitions;

      // A worker that made the tests pass instead of the code work: new skip
      // markers, production code carrying on without an import, a file
      // shadowing a dependency, stray backup copies (lib/sabotage.mjs). A real
      // Senti job did all four when its sandbox lacked sqlglot.
      let sabotage = null;
      if (mode === "implement") {
        try {
          const changes = [];
          for (const c of (preCommit.nameStatus ?? []).slice(0, 300)) {
            let addedLines = [];
            if (c.status === "A") {
              try { const text = fs.readFileSync(path.join(cwd, c.path), "utf8"); if (text.length < 2_000_000) addedLines = text.split("\n"); } catch { /* unreadable: status alone still counts */ }
            } else if (c.status !== "D") {
              try { addedLines = addedLinesOf(await gitRaw(["diff", "-U0", base.sha, "--", c.path], cwd)); } catch { /* skip this file */ }
            }
            changes.push({ status: c.status, path: c.path, addedLines });
          }
          sabotage = detectTestSabotage({ changes, isTestPathFn: isTestPath, dependencyNames: loadDependencyNames(cwd) });
        } catch { /* best-effort review flag; never blocks a commit on its own failure */ }
      }
      const afterMislabeledTests = sabotage
        ? { ...afterMislabeledTestsOnly, reviewRequired: true, reasons: [...afterMislabeledTestsOnly.reasons, `POSSIBLE TEST WORKAROUND: ${sabotage.reason}`] }
        : afterMislabeledTestsOnly;

      // A HARD block, unlike every review flag above: SECURITY.md's own
      // documented gap made deterministic where it can be (a fixed set of
      // well-known secret shapes), checked against every changed file's
      // ADDED content plus the worker's own report text -- the diff/report is
      // the one channel that always leaves the sandbox regardless of network
      // isolation. A missed weak test costs a review cycle; a leaked
      // credential that reaches a real commit is often irreversible the
      // moment it's pushed, so this overrides commitAllowed regardless of
      // what verification or the report otherwise say.
      let possibleSecrets = null;
      if (mode === "implement") {
        try {
          possibleSecrets = await detectPossibleSecrets({
            cwd, changedFiles: preCommit.nameStatus,
            gitDiffFn: (file) => gitRaw(["diff", "-U0", base.sha, "--", file], cwd),
            reportText: report,
          });
        } catch { /* best-effort; never blocks a commit on the scan's OWN failure -- the absence of a signal is not evidence of safety, but a hard block on a scanner crash would be a self-inflicted denial of service */ }
      }
      const afterHostInstalls = hostInstalls.length
        ? { ...afterMislabeledTests, reviewRequired: true, reasons: [...afterMislabeledTests.reasons, `TOOLS OUTSIDE THE SANDBOX: the worker left a real ${hostInstalls.join(", ")}, so packages were installed where the sandbox (no network) couldn't have: its tool calls ran on this machine. nomArmy removed them and verified against the sandbox's own dependencies.`] }
        : afterMislabeledTests;
      const afterSecrets = possibleSecrets
        ? { ...afterHostInstalls, reviewRequired: true, commitAllowed: false,
            commitBlockedReason: `possible secret detected: ${possibleSecrets.reason}`,
            reasons: [...afterHostInstalls.reasons, `POSSIBLE SECRET DETECTED: ${possibleSecrets.reason}`] }
        : afterHostInstalls;
      const finalOutcome = applyRefactorContract(applyVerificationPolicy(afterSecrets, independentVerification.status, repoPolicy()),
        { refactor, verificationStatus: independentVerification.status, testChanges: preCommit.testChanges });

      progress("commit");
      const commit = await createCoordinatorCommit({ cwd, jobId, outcome: finalOutcome,
        message: coordinatorCommitMessage({ task, subject: commitSubject, note: reportValidation?.note ?? null, jobId, workerId, recovered: Boolean(finalOutcome.recovered), provider: (result ?? attempted)?.provider ?? null, model: (result ?? attempted)?.model ?? null }) });
      progress("record");
      const record = await collectGitRecord({ cwd, baseSha: base.sha, branch, baseRef: base.ref, jobId }), worker = workerMetadata(result ?? attempted);

      let coordinatorStatus = COORDINATOR_STATUS_BY_OUTCOME[finalOutcome.outcome] ?? "incomplete";
      const issues = [...finalOutcome.reasons];
      if (workerError) issues.push(`worker error: ${String(workerError).split("\n")[0]}`);
      if (repositoryChanged && !commit.created) {
        if (coordinatorStatus === "complete") coordinatorStatus = "incomplete";
        // A timed-out or crashed worker can still leave real, salvageable work
        // behind (observed directly: a timed-out job produced a correct,
        // compiling edit that a nom refuses to auto-commit, and the only way to
        // learn it existed was to read the retained worktree by hand). Stating
        // the diffstat right in the issue a caller actually reads -- not just
        // buried in the full manifest's git record -- is what makes "go look at
        // the worktree" worth doing instead of discarding the job.
        issues.push(`repository changes remain uncommitted (${record.filesChanged} file(s), +${record.additions}/-${record.deletions}): ${commit.reason}`);
      }
      const failures = worker.toolSummary?.failures ?? 0; if (failures > 0) issues.push(`worker recorded ${failures} tool failure(s)`);
      if (record.ignoredRuntimeJunk.length) issues.push(`runtime junk ignored: ${record.ignoredRuntimeJunk.join(", ")}`);
      if (record.testChanges.reviewRequired) issues.push(...record.testChanges.reviewFlags.map(f => `TEST CHANGE REVIEW: ${f}`));
      if (reportRecoveryAttempted) {
        const cause = workerStopReason === "idle_diff" ? "the idle-diff circuit breaker ended the work phase early"
          : workerStopReason === "idle_background_process" ? "the worker abandoned a backgrounded process and the session stalled"
          : workerStopReason === "openclaw_internal_timeout" ? "OpenClaw's own internal turn timeout fired before nomArmy's outer deadline"
          : workerStopReason === "timeout" ? "the work phase reached its reserved-time deadline"
          : "the first reply left no usable report";
        issues.push(reportRecovered
          ? `report recovered via a follow-up call after ${cause}`
          : `report-recovery follow-up call did not produce a usable report either (${cause})`);
      }

      const metrics = buildMetrics({ result: result ?? attempted, record, reportValidation, outcome: finalOutcome, workerElapsedMs, totalElapsedMs: Date.now() - jobStartedMs, regressionCheckElapsedMs, transientAbortRetried });
      const manifest = { version: VERSION, jobId, workerId: workerId || jobId, mode, projectDir, worktree, branch, startedAt, finishedAt,
        objective: task, acceptance: acceptance ?? [], verificationProfile: verification ?? null,
        outcome: finalOutcome.outcome, recovered: finalOutcome.recovered, recoveryAttempted: finalOutcome.recoveryAttempted,
        reportRecoveryAttempted, reportRecovered,
        reviewRequired: finalOutcome.reviewRequired || record.testChanges.reviewRequired,
        coordinatorStatus, issues, reportValidation, independentVerification,
        // Original, unsubstituted regressionCheck (real "restore_failed" status
        // visible here even though resolveOutcome above only ever saw a
        // not_run-substituted view) -- full transparency for the caller.
        regressionCheck,
        testSelectionRisk: selectionRisk,
        unwiredDefinitions,
        testChanges: record.testChanges, metrics,
        worktreePointerBefore: beforePointer, worktreePointerAfterWorker: afterPointer, worktreeRetained: Boolean(worktree),
        commit, gitBeforeCoordinatorCommit: preCommit, git: record, worker, workerError, workerStopReason,
        budgets: recordedBudgets(result ?? attempted, "implement", task),
        timeBudget,
        // requestedReasoning is always what the caller passed, even when it has
        // no effect: profile "coder"'s shipped default (Qwen3-Coder-Next) has no
        // thinking mode and always runs with it off (see jobSchema's `reasoning`
        // description), but NOMARMY_WORKER_MODEL_THINKING lets an operator who
        // configured a different, reasoning-capable model into that slot turn
        // it back on. Coercing this field itself to "off" reads as nomArmy
        // silently discarding the caller's input, which it is not --
        // reasoningApplied is what the field previously conflated it with.
        requestedProfile: profile, requestedReasoning: reasoning, reasoningApplied: resolveReasoningApplied({ result, profile, reasoning, workerModelThinkingSupported }), execution };
      fs.writeFileSync(path.join(jobDir, "metadata.json"), JSON.stringify(manifest, null, 2));
      if (result) fs.writeFileSync(path.join(jobDir, "result.json"), JSON.stringify(result, null, 2));
      progress("finished", { coordinatorStatus, outcome: finalOutcome.outcome });
      return { ok: coordinatorStatus === "complete", report: report || "(worker returned no final report)", manifest, jobDir };
    } catch (error) {
      const failure = { version: VERSION, jobId, workerId: workerId || jobId, mode, branch, worktree, outcome: OUTCOMES.WORKER_FAILED,
        coordinatorStatus: "failed", error: error.stack || error.message, retained: Boolean(worktree), worktreeRetained: Boolean(worktree), execution };
      fs.writeFileSync(path.join(jobDir, "failure.json"), JSON.stringify(failure, null, 2));
      progress("finished", { coordinatorStatus: "failed", outcome: OUTCOMES.WORKER_FAILED });
      return { ok: false, report: `LOCAL WORKER FAILED:\n${error.stack || error.message}`, manifest: failure, jobDir };
    }
  }

  // A scout reads a detached snapshot of the base commit and never commits. Its
  // citations are resolved against that same commit through Git, not against
  // the worktree, so a scout that wrote to its snapshot cannot forge evidence.
  // A clean scout worktree holds no work and is removed; a dirty one is retained
  // because a scout that wrote is a scout that misbehaved, and that is worth a look.
  async function executeScout({ task, acceptance, base, jobId, jobDir, runtimeDir, timeoutSeconds, profile, reasoning, pool = null, subscriptionWorker = null, onBehalfOf = null, model = null, reportSize = null, workerId, progress, jobStartedMs }) {
    const mode = "scout", worktree = path.join(jobDir, "worktree");
    let worktreeRetained = false;
    try {
      progress("worktree");
      await run("git", ["worktree", "add", "--detach", worktree, base.sha], { cwd: projectDir });
      const startedAt = new Date().toISOString();

      // Place the deterministic evidence CLI where the sandbox can run it. It
      // lives under .openclaw/, which the Git record already treats as runtime
      // junk, so its presence does not dirty the snapshot. The sandbox image has
      // Node; the script has no dependencies.
      const evidenceTool = ".openclaw/nomarmy-evidence.mjs";
      try {
        fs.mkdirSync(path.join(worktree, ".openclaw"), { recursive: true });
        fs.copyFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "repo-query.mjs"), path.join(worktree, evidenceTool));
      } catch (error) { fs.appendFileSync(path.join(jobDir, "coordinator.log"), `${new Date().toISOString()} evidence tool not placed: ${error.message}\n`); }
      const evidencePlaced = fs.existsSync(path.join(worktree, evidenceTool));

      let result = null, attempted = null, workerFailed = false, workerTimedOut = false, workerError = null;
      const workerStartedMs = Date.now();
      progress("worker");
      try {
        result = await runOpenClaw({ task, acceptance, verification: null, mode, cwd: worktree, baseRef: base.ref, baseSha: base.sha, timeoutSeconds, runtimeDir, profile, reasoning, pool, subscriptionWorker, onBehalfOf, model, reportSize, jobDir, workerId: workerId || jobId, evidenceTool: evidencePlaced ? evidenceTool : null });
      } catch (error) {
        workerFailed = true;
        // error.timedOut is set only by our own spawn timer (run(), above) --
        // it means the process actually ran past timeoutSeconds and we killed
        // it. A regex over error.message used to also match "timed out"
        // anywhere inside OpenClaw's raw stdout/stderr, which get embedded
        // verbatim in a plain nonzero-exit error; an unrelated internal
        // message (e.g. a sub-tool's own timeout) then mislabeled a fast
        // crash as WORKER_TIMEOUT, which changes downstream handling (a
        // timed-out worker's partial work is never auto-committed).
        workerTimedOut = Boolean(error.timedOut);
        workerError = error.stack || error.message;
        attempted = error.partialResult ?? attempted;
      }
      const workerElapsedMs = Date.now() - workerStartedMs;
      if (result && (result.timedOut === true || result.status === "timeout" || result.status === "timed_out")) workerTimedOut = true;
      const finishedAt = new Date().toISOString(), reportText = workerFailed ? "" : finalText(result);

      progress("verification");
      // Parse and verify against the budget the worker's prompt was built
      // with (its agent's tier), not the server-wide local one. The local
      // limits here cut a frontier scout's 24 findings to 12 and, having
      // dropped some, also knocked a correctly formatted report into lenient
      // mode -- both reported from a real Senti run.
      const used = result?.budgetsUsed ?? budgetState.budgets;
      let report = parseScoutReport(reportText, used.scout);

      // See shouldAttemptScoutRecovery's own doc comment: this only fires when
      // the report is genuinely unusable, gated by whatever time is actually
      // left against the caller's original timeout (scout has no reserved
      // report-phase budget the way implement does).
      let reportRecoveryAttempted = false, reportRecovered = false;
      const remainingSeconds = timeoutSeconds - Math.round(workerElapsedMs / 1000);
      if (shouldAttemptScoutRecovery({ workerFailed, workerTimedOut, report, remainingSeconds })) {
        reportRecoveryAttempted = true;
        try {
          const recoveryResult = await runOpenClaw({
            task, acceptance, verification: null, mode, cwd: worktree, baseRef: base.ref, baseSha: base.sha,
            timeoutSeconds: remainingSeconds, runtimeDir, profile, reasoning, pool, subscriptionWorker, onBehalfOf, model, reportSize, jobDir, workerId: workerId || jobId,
            evidenceTool: evidencePlaced ? evidenceTool : null,
            overridePrompt: scoutReportRecoveryPrompt({ report: used.report.scout }), logSuffix: "-recovery",
          });
          const recoveryReport = parseScoutReport(finalText(recoveryResult), (recoveryResult?.budgetsUsed ?? used).scout);
          if (!isScoutReportUnusable(recoveryReport)) {
            report = recoveryReport; reportRecovered = true;
            // Mirrors executeImplement's identical reset: nomArmy paused the
            // run on purpose to make room for this call, so a recovered report
            // now goes through the normal outcome path instead of staying
            // pinned to whatever workerFailed/workerTimedOut said before it.
            workerFailed = false; workerTimedOut = false;
          }
        } catch (error) {
          fs.appendFileSync(path.join(jobDir, "coordinator.log"), `${new Date().toISOString()} scout report-recovery call failed: ${error.stack || error.message}\n`);
        }
      }

      const record = await collectGitRecord({ cwd: worktree, baseSha: base.sha, branch: null, baseRef: base.ref, jobId });
      const dirty = record.repoStatusFiles.length > 0;
      const readFile = async p => { try { return await gitRaw(["show", `${base.sha}:${p}`], projectDir); } catch { return null; } };
      const verified = await verifyCitations(report.findings, { readFile, limits: used.scout });
      const outcome = resolveScoutOutcome({ report, verified, workerFailed, workerTimedOut, dirty });

      progress("record");
      if (outcome.retainWorktree) worktreeRetained = true;
      else await run("git", ["worktree", "remove", "--force", worktree], { cwd: projectDir }).catch(() => { worktreeRetained = fs.existsSync(worktree); });

      const worker = workerMetadata(result ?? attempted);
      const issues = [...outcome.reasons];
      if (workerError) issues.push(`scout error: ${String(workerError).split("\n")[0]}`);
      const failures = worker.toolSummary?.failures ?? 0; if (failures > 0) issues.push(`scout recorded ${failures} tool failure(s)`);
      if (dirty) issues.push(`snapshot changed: ${record.repoStatusFiles.join(", ")}`);
      if (reportRecoveryAttempted) {
        issues.push(reportRecovered
          ? "scout report recovered via a follow-up call after the first reply was cut off"
          : "scout report-recovery follow-up call did not produce a usable report either");
      }

      // The number this project is for: repository content the scout pulled
      // through its tools (what the coordinator would otherwise have carried)
      // against the size of what the coordinator receives instead.
      const transcript = await measureReads(path.join(runtimeDir, "state"), worker, { cwd: worktree, sinceMs: jobStartedMs });
      let rendered = renderScoutReport({ report, verified, outcome, baseSha: base.sha });
      // Only repository reads count. tool_search, sessions_* and other harness
      // chatter is the agent framework talking to itself, and counting it made
      // a two-file scout look like a 4x saving on the second live run.
      const displacement = estimateDisplacement({ readChars: transcript.available ? transcript.repoReadChars : null, deliveredChars: rendered.length + 400 /* the compact record that travels with it */ });
      if (transcript.available) {
        const harness = transcript.harnessChars ? ` (plus ~${Math.round(transcript.harnessChars / 4)} tokens of harness tool output, not counted)` : "";
        rendered += `\n\nCONTEXT (estimate): scout read ~${displacement.frontier_read_tokens_est} tokens of repository content across ${transcript.filesRead.length} file(s) and ${transcript.toolCalls.length} tool call(s)${harness}; `
          + `this report is ~${displacement.delivered_tokens_est} tokens -> ${displacement.verdict.toUpperCase()}: ${displacement.note}`;
      } else rendered += `\n\nCONTEXT (estimate): unavailable (${transcript.reason})`;
      if (displacement.verdict === "negative") issues.push("negative displacement: this scout cost more coordinator context than reading directly would have");

      const metrics = {
        ...buildMetrics({ result: result ?? attempted, record: null, reportValidation: null, outcome: null, workerElapsedMs, totalElapsedMs: Date.now() - jobStartedMs }),
        report_truncated: report.truncated, report_strict: report.strict, worker_timeout: workerTimedOut,
        scout_findings_supported: verified.supported, scout_findings_unsupported: verified.unsupported,
        scout_findings_weak: verified.weak, scout_excerpt_lines: verified.excerptLinesUsed,
        scout_model_calls: transcript.available ? transcript.modelCalls : null,
        scout_tool_calls: transcript.available ? transcript.toolCalls.length : null,
        scout_files_read: transcript.available ? transcript.filesRead.length : null,
        frontier_read_tokens_est: displacement.frontier_read_tokens_est,
        delivered_tokens_est: displacement.delivered_tokens_est,
        displaced_tokens_est: displacement.displaced_tokens_est,
        displacement_verdict: displacement.verdict
      };
      const manifest = { version: VERSION, jobId, workerId: workerId || jobId, mode, projectDir, worktree: worktreeRetained ? worktree : null, branch: null, baseSha: base.sha, startedAt, finishedAt,
        objective: task, mustCover: acceptance ?? [],
        outcome: outcome.outcome, coordinatorStatus: outcome.coordinatorStatus, reviewRequired: outcome.reviewRequired, issues,
        scout: { question: report.question, confidence: report.confidence, notFound: report.notFound,
          findings: verified.findings, supported: verified.supported, unsupported: verified.unsupported, weak: verified.weak,
          excerptLinesUsed: verified.excerptLinesUsed, excerptTruncated: verified.excerptTruncated,
          reportParse: { present: report.present, strict: report.strict, lenient: report.lenient, truncated: report.truncated, parseMode: report.parseMode, reason: report.reason, droppedFindings: report.droppedFindings, overflowed: Boolean(report.overflowed) } },
        transcript: transcript.available
          ? { modelCalls: transcript.modelCalls, toolCalls: transcript.toolCalls, filesRead: transcript.filesRead, commands: transcript.commands, toolResultChars: transcript.toolResultChars, assistantChars: transcript.assistantChars, dbPath: transcript.dbPath }
          : { available: false, reason: transcript.reason },
        displacement, reportRecoveryAttempted, reportRecovered,
        dirty, snapshotChanges: record.repoStatusFiles, worktreeRetained, metrics, worker, workerError,
        budgets: recordedBudgets(result ?? attempted, "scout", task),
        // requestedReasoning is always what the caller passed, even when it has
        // no effect: profile "coder"'s shipped default (Qwen3-Coder-Next) has no
        // thinking mode and always runs with it off (see jobSchema's `reasoning`
        // description), but NOMARMY_WORKER_MODEL_THINKING lets an operator who
        // configured a different, reasoning-capable model into that slot turn
        // it back on. Coercing this field itself to "off" reads as nomArmy
        // silently discarding the caller's input, which it is not --
        // reasoningApplied is what the field previously conflated it with.
        requestedProfile: profile, requestedReasoning: reasoning, reasoningApplied: resolveReasoningApplied({ result, profile, reasoning, workerModelThinkingSupported }), execution };
      fs.writeFileSync(path.join(jobDir, "metadata.json"), JSON.stringify(manifest, null, 2));
      if (result) fs.writeFileSync(path.join(jobDir, "result.json"), JSON.stringify(result, null, 2));
      progress("finished", { coordinatorStatus: outcome.coordinatorStatus, outcome: outcome.outcome });
      return { ok: outcome.coordinatorStatus === "complete", report: rendered, manifest, jobDir };
    } catch (error) {
      const failure = { version: VERSION, jobId, workerId: workerId || jobId, mode, branch: null, worktree: fs.existsSync(worktree) ? worktree : null, outcome: OUTCOMES.WORKER_FAILED,
        coordinatorStatus: "failed", error: error.stack || error.message, worktreeRetained: fs.existsSync(worktree), execution };
      fs.writeFileSync(path.join(jobDir, "failure.json"), JSON.stringify(failure, null, 2));
      progress("finished", { coordinatorStatus: "failed", outcome: OUTCOMES.WORKER_FAILED });
      return { ok: false, report: `SCOUT FAILED:\n${error.stack || error.message}`, manifest: failure, jobDir };
    }
  }

  // A decompose job is scout's read-only chassis (detached worktree, evidence
  // tool, dirty-check, transcript/displacement accounting) with a different
  // question and a different report shape: it proposes independent subtasks
  // instead of answering a question. Written as its own function rather than
  // factored into a shared chassis with executeScout -- both were near-
  // identical already before this, and this codebase's own convention (see
  // executeImplement/executeScout) is separate top-level functions per mode,
  // not a parameterized one. The proposal is informational, exactly like a
  // scout's findings: nothing here ever calls executeJob/local_workers, and
  // commitAllowed/selectUnionCandidates are both hard-gated on mode ===
  // "implement" elsewhere, so a decompose result can never be auto-dispatched
  // or unioned even by accident.
  async function executeDecompose({ task, acceptance, base, jobId, jobDir, runtimeDir, timeoutSeconds, profile, reasoning, pool = null, subscriptionWorker = null, onBehalfOf = null, model = null, reportSize = null, workerId, progress, jobStartedMs }) {
    const mode = "decompose", worktree = path.join(jobDir, "worktree");
    let worktreeRetained = false;
    try {
      progress("worktree");
      await run("git", ["worktree", "add", "--detach", worktree, base.sha], { cwd: projectDir });
      const startedAt = new Date().toISOString();

      const evidenceTool = ".openclaw/nomarmy-evidence.mjs";
      try {
        fs.mkdirSync(path.join(worktree, ".openclaw"), { recursive: true });
        fs.copyFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "repo-query.mjs"), path.join(worktree, evidenceTool));
      } catch (error) { fs.appendFileSync(path.join(jobDir, "coordinator.log"), `${new Date().toISOString()} evidence tool not placed: ${error.message}\n`); }
      const evidencePlaced = fs.existsSync(path.join(worktree, evidenceTool));

      let result = null, attempted = null, workerFailed = false, workerTimedOut = false, workerError = null;
      const workerStartedMs = Date.now();
      progress("worker");
      try {
        result = await runOpenClaw({ task, acceptance, verification: null, mode, cwd: worktree, baseRef: base.ref, baseSha: base.sha, timeoutSeconds, runtimeDir, profile, reasoning, pool, subscriptionWorker, onBehalfOf, model, reportSize, jobDir, workerId: workerId || jobId, evidenceTool: evidencePlaced ? evidenceTool : null });
      } catch (error) {
        workerFailed = true;
        workerTimedOut = Boolean(error.timedOut);
        workerError = error.stack || error.message;
        attempted = error.partialResult ?? attempted;
      }
      const workerElapsedMs = Date.now() - workerStartedMs;
      if (result && (result.timedOut === true || result.status === "timeout" || result.status === "timed_out")) workerTimedOut = true;
      const finishedAt = new Date().toISOString(), reportText = workerFailed ? "" : finalText(result);

      progress("verification");
      const used = result?.budgetsUsed ?? budgetState.budgets; // see executeScout: the job's own budget, not the local one
      const report = parseDecomposeReport(reportText, used.decompose);
      const record = await collectGitRecord({ cwd: worktree, baseSha: base.sha, branch: null, baseRef: base.ref, jobId });
      const dirty = record.repoStatusFiles.length > 0;
      const readFile = async p => { try { return await gitRaw(["show", `${base.sha}:${p}`], projectDir); } catch { return null; } };
      const verified = await verifyCitations(buildDecomposeFindings(report.subtasks), { readFile, limits: used.decompose });
      const overlaps = checkDecompositionOverlap(report.subtasks, verified);
      const outcome = resolveDecomposeOutcome({ report, verified, workerFailed, workerTimedOut, dirty });

      progress("record");
      if (outcome.retainWorktree) worktreeRetained = true;
      else await run("git", ["worktree", "remove", "--force", worktree], { cwd: projectDir }).catch(() => { worktreeRetained = fs.existsSync(worktree); });

      const worker = workerMetadata(result ?? attempted);
      const issues = [...outcome.reasons];
      if (workerError) issues.push(`decompose error: ${String(workerError).split("\n")[0]}`);
      const failures = worker.toolSummary?.failures ?? 0; if (failures > 0) issues.push(`decomposer recorded ${failures} tool failure(s)`);
      if (dirty) issues.push(`snapshot changed: ${record.repoStatusFiles.join(", ")}`);
      if (overlaps.length) issues.push(`${overlaps.length} subtask pair(s) claim overlapping files; not safe to dispatch as independent jobs as proposed`);

      const transcript = await measureReads(path.join(runtimeDir, "state"), worker, { cwd: worktree, sinceMs: jobStartedMs });
      let rendered = renderDecomposeReport({ report, verified, subtasks: report.subtasks, overlaps, outcome, baseSha: base.sha });
      const displacement = estimateDisplacement({ readChars: transcript.available ? transcript.repoReadChars : null, deliveredChars: rendered.length + 400 });
      if (transcript.available) {
        const harness = transcript.harnessChars ? ` (plus ~${Math.round(transcript.harnessChars / 4)} tokens of harness tool output, not counted)` : "";
        rendered += `\n\nCONTEXT (estimate): decomposer read ~${displacement.frontier_read_tokens_est} tokens of repository content across ${transcript.filesRead.length} file(s) and ${transcript.toolCalls.length} tool call(s)${harness}; `
          + `this report is ~${displacement.delivered_tokens_est} tokens -> ${displacement.verdict.toUpperCase()}: ${displacement.note}`;
      } else rendered += `\n\nCONTEXT (estimate): unavailable (${transcript.reason})`;
      if (displacement.verdict === "negative") issues.push("negative displacement: this decompose job cost more coordinator context than reading directly would have");

      const metrics = {
        ...buildMetrics({ result: result ?? attempted, record: null, reportValidation: null, outcome: null, workerElapsedMs, totalElapsedMs: Date.now() - jobStartedMs }),
        report_truncated: report.truncated, report_strict: report.strict, worker_timeout: workerTimedOut,
        decompose_subtasks_supported: verified.supported, decompose_subtasks_unsupported: verified.unsupported,
        decompose_subtasks_weak: verified.weak, decompose_overlaps: overlaps.length,
        decompose_model_calls: transcript.available ? transcript.modelCalls : null,
        decompose_tool_calls: transcript.available ? transcript.toolCalls.length : null,
        decompose_files_read: transcript.available ? transcript.filesRead.length : null,
        frontier_read_tokens_est: displacement.frontier_read_tokens_est,
        delivered_tokens_est: displacement.delivered_tokens_est,
        displaced_tokens_est: displacement.displaced_tokens_est,
        displacement_verdict: displacement.verdict
      };
      const manifest = { version: VERSION, jobId, workerId: workerId || jobId, mode, projectDir, worktree: worktreeRetained ? worktree : null, branch: null, baseSha: base.sha, startedAt, finishedAt,
        objective: task, constraints: acceptance ?? [],
        outcome: outcome.outcome, coordinatorStatus: outcome.coordinatorStatus, reviewRequired: outcome.reviewRequired, issues,
        decompose: { objective: report.objective, confidence: report.confidence, notSplittable: report.notSplittable,
          subtasks: report.subtasks.map((s, i) => ({ task: s.task, acceptance: s.acceptance, citations: verified.findings[i]?.citations ?? [], supported: verified.findings[i]?.supported ?? false, weak: verified.findings[i]?.weak ?? false })),
          overlaps, supported: verified.supported, unsupported: verified.unsupported, weak: verified.weak,
          reportParse: { present: report.present, strict: report.strict, lenient: report.lenient, truncated: report.truncated, parseMode: report.parseMode, reason: report.reason, droppedSubtasks: report.droppedSubtasks } },
        transcript: transcript.available
          ? { modelCalls: transcript.modelCalls, toolCalls: transcript.toolCalls, filesRead: transcript.filesRead, commands: transcript.commands, toolResultChars: transcript.toolResultChars, assistantChars: transcript.assistantChars, dbPath: transcript.dbPath }
          : { available: false, reason: transcript.reason },
        displacement,
        dirty, snapshotChanges: record.repoStatusFiles, worktreeRetained, metrics, worker, workerError,
        budgets: recordedBudgets(result ?? attempted, "decompose", task),
        requestedProfile: profile, requestedReasoning: reasoning, reasoningApplied: resolveReasoningApplied({ result, profile, reasoning, workerModelThinkingSupported }), execution };
      fs.writeFileSync(path.join(jobDir, "metadata.json"), JSON.stringify(manifest, null, 2));
      if (result) fs.writeFileSync(path.join(jobDir, "result.json"), JSON.stringify(result, null, 2));
      progress("finished", { coordinatorStatus: outcome.coordinatorStatus, outcome: outcome.outcome });
      return { ok: outcome.coordinatorStatus === "complete", report: rendered, manifest, jobDir };
    } catch (error) {
      const failure = { version: VERSION, jobId, workerId: workerId || jobId, mode, branch: null, worktree: fs.existsSync(worktree) ? worktree : null, outcome: OUTCOMES.WORKER_FAILED,
        coordinatorStatus: "failed", error: error.stack || error.message, worktreeRetained: fs.existsSync(worktree), execution };
      fs.writeFileSync(path.join(jobDir, "failure.json"), JSON.stringify(failure, null, 2));
      progress("finished", { coordinatorStatus: "failed", outcome: OUTCOMES.WORKER_FAILED });
      return { ok: false, report: `DECOMPOSE FAILED:\n${error.stack || error.message}`, manifest: failure, jobDir };
    }
  }

  return { executeJob, executeImplement, executeScout, executeDecompose };
}
