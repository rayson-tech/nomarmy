import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadJobRecords, computeStats, formatStats, parseSince, jobRole, jobModel, resolveRepo } from "../lib/stats.mjs";

const REPO = "/repos/app";
const at = (day) => `2026-09-${String(day).padStart(2, "0")}T12:00:00.000Z`;
const impl = (over) => ({ mode: "implement", projectDir: REPO, startedAt: at(25), outcome: "WORKER_DONE",
  reportValidation: { status: "done", tests: "pass" }, independentVerification: { status: "pass" }, regressionCheck: { status: "pass" },
  metrics: { worker_elapsed: 300000, total_elapsed: 480000, worker_tokens_total: 1000, worker_tokens_in: 100, worker_tokens_out: 50, worker_tokens_cache_read: 850, worker_provider: "openai", worker_model: "gpt-6-astra" },
  issues: [], ...over });

const records = [
  impl({ labels: { role: "sr-dev" }, commit: { created: true, sha: "a" }, git: { additions: 40, deletions: 5, changedFiles: ["a.js", "a.test.js"] }, testChanges: { new_tests_added: ["a.test.js"] }, issues: ["SCOPED TEST SELECTION RISK: ..."] }),
  impl({ objective: "[nomArmy role: jr-dev, build phase]\nJunior developer.\n\nDo it", outcome: "NEEDS_REVIEW", independentVerification: { status: "fail" } }),
  impl({ objective: "[nomArmy role: jr-dev, build phase]\nx", outcome: "NEEDS_REVIEW", regressionCheck: { status: "fail" } }),
  impl({ labels: { role: "ui-ux" }, commit: { created: true, sha: "b" }, git: { additions: 10, deletions: 1, changedFiles: ["a.js", "b.js"] }, issues: ["MUTANTS SURVIVED: 1 of 3 ...", "runner cleanup failed after the run (x); ..."] }),
  impl({ labels: { role: "sr-dev" }, outcome: "WORKER_TIMEOUT", reportValidation: { status: null }, metrics: { worker_elapsed: 900000, total_elapsed: 950000, worker_provider: "xai", worker_model: "grok-4.7", worker_cost_usd: 1.25 } }),
  { mode: "scout", projectDir: REPO, startedAt: at(26), outcome: "SCOUT_DONE", labels: { role: "security-analyst" }, scout: { findings: [{}, {}] }, metrics: { worker_provider: "xai", worker_model: "grok-4.7", worker_cost_usd: 0.5 }, issues: [] },
  { mode: "scout", projectDir: REPO, startedAt: at(26), outcome: "SCOUT_UNSUPPORTED", labels: { role: "pm" }, scout: { findings: [] }, issues: [] },
  { mode: "verify", projectDir: REPO, startedAt: at(26), outcome: "VERIFIED", issues: [] },
  { mode: "verify", startedAt: at(26), outcome: "VERIFIED", issues: [] },
  impl({ projectDir: "/repos/other", labels: { role: "sr-dev" } }),
  impl({ startedAt: at(20), labels: { role: "sr-dev" } }),
];

test("jobRole reads the stamped label, else the brief's role header", () => {
  assert.equal(jobRole({ labels: { role: "pm" } }), "pm");
  assert.equal(jobRole({ objective: "[nomArmy role: security-analyst, review phase]\n..." }), "security-analyst");
  assert.equal(jobRole({ objective: "plain task" }), null);
  assert.equal(jobModel({ mode: "implement", metrics: { worker_provider: "llama-cpp", worker_model: "gpt-oss-20b" } }), "gpt-oss-20b (local)");
});

test("computeStats: this repo, this period, every section from the records", () => {
  const s = computeStats(records, { repo: REPO, sinceMs: parseSince("2026-09-25") });
  assert.equal(s.volume.jobs, 8, "other repo and older job excluded");
  assert.equal(s.unplacedVerifyRuns, 1, "a verify run without a repo can't be placed");
  assert.deepEqual(s.volume.byMode, { implement: 5, scout: 2, verify: 1 });
  assert.deepEqual(s.volume.byRole, { "sr-dev": 2, "jr-dev": 2, "ui-ux": 1, "security-analyst": 1, pm: 1 });
  assert.deepEqual(s.code, { committedJobs: 2, linesAdded: 50, linesRemoved: 6, files: 3, newTestFiles: 1 });
  assert.equal(s.workerMinutes.median, 5);
  assert.equal(s.jobMinutes.p90, 950000 / 60000);
  assert.equal(s.spendUsd.total, 1.75);
  assert.deepEqual(s.claimVsEvidence, { claimedDone: 4, verificationFailed: 1, revertStillPassed: 1, passedBoth: 2, changedNothing: 0, flaggedAfterPassing: 1 });
  assert.deepEqual(s.notCompleted, { NEEDS_REVIEW: 2, WORKER_TIMEOUT: 1, SCOUT_UNSUPPORTED: 1 });
  assert.deepEqual(s.reviewers["security-analyst"], { runs: 1, outcomes: { SCOUT_DONE: 1 }, findings: 2 });
  assert.equal(s.signals["scoped test selection risk"], 1);
  assert.equal(s.signals["mutants survived"], 1);
  assert.equal(s.signals["runner cleanup crash (report recovered)"], 1);
  const all = computeStats(records, {});
  assert.equal(all.volume.jobs, records.length);
  assert.equal(all.unplacedVerifyRuns, 0);
});

test("formatStats reads as the report, and says what the records can't show", () => {
  const text = formatStats(computeStats(records, { repo: REPO, sinceMs: parseSince("2026-09-25") }));
  assert.match(text, /nomArmy stats for \/repos\/app, 2026-09-25 to 2026-09-26/);
  assert.match(text, /Independent verification failed\s+1 \(25%\)/);
  assert.match(text, /Passed, but reverting still passed\s+1 \(25%\)/);
  assert.match(text, /Defects the General found at integration aren't in the records/);
  assert.match(text, /API spend\s+\$1\.75 \(grok-4\.7 \$1\.75\)/);
  assert.match(formatStats(computeStats([], {})), /no jobs/);
});

test("parseSince takes a date or an age, and refuses nonsense", () => {
  const now = Date.parse("2026-09-27T00:00:00Z");
  assert.equal(parseSince("7d", now), now - 7 * 86400000);
  assert.equal(parseSince("24h", now), now - 86400000);
  assert.equal(parseSince("2026-09-25"), Date.parse("2026-09-25"));
  assert.equal(parseSince(undefined), null);
  assert.throws(() => parseSince("last tuesday"), /must be a date/);
});

test("loadJobRecords reads finished records and skips the rest", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-stats-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "a")); fs.writeFileSync(path.join(root, "a", "metadata.json"), JSON.stringify({ mode: "scout" }));
  fs.mkdirSync(path.join(root, "b")); // still running: no record
  fs.mkdirSync(path.join(root, "c")); fs.writeFileSync(path.join(root, "c", "metadata.json"), "{broken");
  assert.deepEqual(loadJobRecords(root), [{ mode: "scout" }]);
  assert.deepEqual(loadJobRecords(path.join(root, "missing")), []);
});

test("computeStats filters by role and model", () => {
  const sr = computeStats(records, { role: "sr-dev" });
  assert.equal(sr.volume.jobs, 4);
  assert.deepEqual(sr.volume.byRole, { "sr-dev": 4 });
  const grok = computeStats(records, { model: "grok-4.7" });
  assert.equal(grok.volume.jobs, 2);
  assert.equal(grok.spendUsd.total, 1.75);
  assert.match(formatStats(computeStats(records, { role: "pm", model: "gpt-6-astra" })), /role pm, model gpt-6-astra, no jobs/);
});

test("resolveRepo takes a path or a folder name, preferring an exact or trailing match", () => {
  const recs = ["/src/rayson-senti", "/src/rayson-senti-shared-services", "/src/nomarmy"].map((p) => ({ projectDir: p }));
  assert.equal(resolveRepo(recs, "nomarmy"), "/src/nomarmy");
  assert.equal(resolveRepo(recs, "senti"), "/src/rayson-senti", "ends with -senti beats merely containing it");
  assert.equal(resolveRepo(recs, "shared"), "/src/rayson-senti-shared-services");
  assert.throws(() => resolveRepo(recs, "rayson"), /matches several repositories: rayson-senti, rayson-senti-shared-services/);
  assert.throws(() => resolveRepo(recs, "zzz"), /no repository with jobs matches "zzz"/);
  assert.equal(resolveRepo(recs, os.tmpdir()), path.resolve(os.tmpdir()), "an existing path is taken as is");
});
