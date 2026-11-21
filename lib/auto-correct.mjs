// One automatic correction round.
//
// A worker that reports done with passing tests, when nomArmy's own
// verification then fails, usually needs one targeted fix: the failing
// output says what. Instead of handing that back to the General, nomArmy
// runs one continue_from job on the same agent, with the failing output as
// its brief, and returns that job's result. One round only (the correction
// can't start another), and it's a real job: admitted like any other, so it
// counts toward the run's job, spend and hour limits.

import fs from "node:fs";
import path from "node:path";

const OUTPUT_CHARS = 3000;

/** Whether a finished job gets a correction round. */
export function wantsAutoCorrection(manifest, { autoCorrect = true, isCorrection = false } = {}) {
  if (!autoCorrect || isCorrection || !manifest) return false;
  if (manifest.mode !== "implement" || manifest.testsFirst) return false;
  if (manifest.commit?.created) return false;
  return manifest.reportMismatch?.report === "STATUS done, TESTS pass" && manifest.reportMismatch?.verification === "fail";
}

function tail(file, chars) {
  try {
    const text = fs.readFileSync(file, "utf8");
    return text.length > chars ? `[...]\n${text.slice(-chars)}` : text;
  } catch { return null; }
}

/**
 * The correction job's arguments, from the failed job's (already expanded)
 * arguments and its record.
 */
export function correctionArgs(args, jobId, manifest, { maxTaskChars = 3000, maxEvidenceChars = 6000 } = {}) {
  const profile = manifest.verificationProfile ?? args.verification;
  const failing = manifest.reportMismatch?.failingTests ?? manifest.independentVerification?.failingTests ?? null;
  const output = manifest.independentVerification?.log ? tail(manifest.independentVerification.log, Math.min(OUTPUT_CHARS, maxEvidenceChars - 500)) : null;
  const task = `Independent verification failed after the previous worker reported done with passing tests. Make verification profile '${profile}' pass: fix the code, not the tests, unless a test contradicts the objective. The objective and acceptance criteria are unchanged.${failing?.length ? ` Failing: ${failing.slice(0, 10).map(String).join(", ")}.` : ""}\n\nORIGINAL OBJECTIVE\n${manifest.objective ?? args.task ?? ""}`.slice(0, maxTaskChars);
  const evidence = output ? `VERIFICATION OUTPUT (nomArmy's own run of '${profile}' on the previous worker's changes, the tail):\n${output}`.slice(0, maxEvidenceChars) : undefined;
  const {
    base_ref, frozen_tests_from, continue_from, worker_id, detach, task: _task, evidence: _evidence, tests_first, auto_correct, ...rest
  } = args;
  return {
    ...rest,
    task,
    ...(evidence ? { evidence } : {}),
    continue_from: jobId,
    // The frozen set stays frozen through the correction.
    ...(manifest.frozenTests?.length ? { frozen_tests: manifest.frozenTests } : {}),
    auto_correct: false,
    autoCorrectionOf: jobId,
  };
}

/** Update the failed job's record with the correction's state. */
export function recordAutoCorrection(jobDir, value) {
  const file = path.join(jobDir, "metadata.json");
  try {
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    record.autoCorrection = { ...(record.autoCorrection ?? {}), ...value, updatedAt: new Date().toISOString() };
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(record, null, 2));
    fs.renameSync(`${file}.tmp`, file);
    return true;
  } catch { return false; }
}

/** The result the caller gets: the correction's, saying what it corrected. */
export function correctedResult(first, second, firstJobId) {
  if (!second) return first;
  const note = `AUTO-CORRECTED: job ${firstJobId} reported done/pass but failed independent verification; nomArmy ran one correction round (continue_from). This is that job's result.`;
  return { ...second, report: `${note}\n\n${second.report ?? ""}`, manifest: { ...second.manifest, autoCorrectionOf: firstJobId, issues: [note, ...(second.manifest?.issues ?? [])] } };
}
