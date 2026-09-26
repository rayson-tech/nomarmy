import assert from "node:assert/strict";
import test from "node:test";

import { resolveOutcome } from "../lib/outcome.mjs";
import { parseWorkerReport } from "../lib/report.mjs";
import { jobLabel, jobElapsedSeconds } from "../lib/job-format.mjs";

const donePass = parseWorkerReport("STATUS: done\nTESTS: pass\nNOT_DONE: none\nNOTE: changed the prompt");
const failed = (detail) => ({ status: "fail", profile: "python", basis: "1 command", reason: null, detail });

test("a failed verification's issue names the command, exit code and output tail", () => {
  const detail = "command 1 of 1 (`python3 -m pytest -q`) failed with exit code 1 (last output: test_prompt_rules FAILED)";
  const out = resolveOutcome({ report: donePass, repositoryChanged: true, independentVerification: failed(detail) });
  assert.equal(out.outcome, "NEEDS_REVIEW");
  assert.deepEqual(out.reasons, [`worker claimed done/pass but independent verification failed: ${detail}`]);
  // An invalid report whose recovery hit a failed verification says why too.
  const invalid = resolveOutcome({ report: parseWorkerReport("done!"), repositoryChanged: true, independentVerification: failed(detail) });
  assert.equal(invalid.reasons.at(-1), `independent verification FAILED: ${detail}`);
});

test("a failed verification's issue is capped, and plain when there is no detail", () => {
  const long = `command 1 of 1 failed with exit code 2 (last output: ${"x".repeat(2000)})`;
  const [reason] = resolveOutcome({ report: donePass, repositoryChanged: true, independentVerification: failed(long) }).reasons;
  assert.ok(reason.length < 700, `capped, got ${reason.length}`);
  assert.ok(reason.endsWith("..."));
  const [plain] = resolveOutcome({ report: donePass, repositoryChanged: true, independentVerification: failed(null) }).reasons;
  assert.equal(plain, "worker claimed done/pass but independent verification failed");
});

test("jobElapsedSeconds stops at the job's finish instead of counting to now", () => {
  const startedAt = "2026-09-26T14:36:43.000Z";
  const now = Date.parse("2026-09-26T17:03:36.000Z");
  // The whole job's own measure wins: an implement job's finishedAt is the worker's end.
  assert.equal(jobElapsedSeconds({ status: { startedAt, state: "finished", updatedAt: "2026-09-26T14:46:14.000Z" },
    meta: { finishedAt: "2026-09-26T14:45:58.000Z", metrics: { total_elapsed: 571600 } }, now }), 572);
  assert.equal(jobElapsedSeconds({ status: { startedAt, state: "finished", updatedAt: "2026-09-26T14:46:14.000Z" }, now }), 571);
  assert.equal(jobElapsedSeconds({ meta: { startedAt, finishedAt: "2026-09-26T14:45:58.000Z" }, now }), 555);
  // Still running: now minus start.
  assert.equal(jobElapsedSeconds({ status: { startedAt, state: "running", updatedAt: "2026-09-26T14:40:00.000Z" }, now }), 8813);
  assert.equal(jobElapsedSeconds({ now }), null);
});

test("jobLabel names a job by its commit subject, else the task's first sentence", () => {
  assert.equal(jobLabel({ commit_subject: "Keep held-back tables in the cache", task: "Long task." }), "Keep held-back tables in the cache");
  assert.equal(jobLabel({ task: "Add the settings page. It needs a form and tests.\nMore." }), "Add the settings page.");
  assert.equal(jobLabel({ task: "a".repeat(80) }), `${"a".repeat(57)}...`);
  assert.equal(jobLabel({}), null);
});
