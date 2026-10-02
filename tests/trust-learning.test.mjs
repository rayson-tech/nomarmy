import "./helpers/isolate-global-config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { acknowledgeTrust, operatorIdentity, loadTrustEvidence, trustEvidenceFile, recordReviewEvidence, trustSuggestions, reviewTrustLearning } from "../lib/trust-learning.mjs";
import { loadTrustMap, TRUST_MAP_FILE } from "../lib/trust-map.mjs";
import { reportView } from "../lib/job-format.mjs";
import { computeStats, gatedJobs } from "../lib/stats.mjs";
import { shareMarkdown } from "../lib/share.mjs";
import { computeTrustReach, evaluateReachTrust } from "../lib/trust-reach.mjs";
import { createExecutor } from "../lib/execute.mjs";
import { escRegex } from "../lib/diff-checks.mjs";

const cliFile = fileURLToPath(new URL("../bin/nomarmy.mjs", import.meta.url));
const when = "2026-10-02T00:00:00.000Z";
const reasons = [{ rule: "trust-reach", file: "access.py", reason: "removes a check in `check_scope` (access.py:1), the tenant boundary" }];
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value)); }
function fixture(t) {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".trust-learning-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const operatorDir = path.join(root, "repo"), stateDir = path.join(root, "state"), jobsRoot = path.join(stateDir, "jobs");
  fs.mkdirSync(operatorDir); fs.mkdirSync(jobsRoot, { recursive: true });
  write(path.join(operatorDir, "access.py"), "def check_scope(user):\n    return user.tenant\n");
  const job = (jobId, level = "human") => ({ jobId, projectDir: operatorDir, mode: "implement", outcome: "WORKER_DONE", startedAt: when, finishedAt: when,
    labels: { runId: "run-one" }, worker: { provider: "builder" }, git: { changedFiles: ["access.py"] }, trust: { level, reasons } });
  const save = record => write(path.join(jobsRoot, record.jobId, "metadata.json"), record);
  const read = id => JSON.parse(fs.readFileSync(path.join(jobsRoot, id, "metadata.json"), "utf8"));
  const cli = (...args) => spawnSync(process.execPath, [cliFile, ...args, "--repo", operatorDir], { encoding: "utf8", env: { ...process.env, NOMARMY_AGENT_STATE: stateDir } });
  return { root, operatorDir, stateDir, jobsRoot, job, save, read, cli };
}
function review(f, job, id = "review-one") {
  return { jobId: id, projectDir: f.operatorDir, mode: "scout", outcome: "SCOUT_DONE", reviews: job.jobId, finishedAt: when,
    worker: { provider: "reviewer" }, scout: { findings: [{ text: "`check_scope` has a missing tenant check", supported: true, weak: false,
      citations: [{ path: "access.py", status: "ok", related: true, start: 1, end: 2, excerpt: [{ line: 1, text: "def check_scope(user):" }, { line: 2, text: "    return user.tenant" }] }] }] } };
}
const ack = (f, jobId, decision, reason = "checked") => acknowledgeTrust({ ...f, jobId, decision, reason, who: "operator@example.test", when });

test("trust regex escapes backslash dot parentheses and dollar literally", () => {
  const token = String.raw`a\.($b`;
  const pattern = new RegExp(`^${escRegex(token)}$`);
  assert.equal(pattern.test(token), true);
  for (const other of ["a.($b", String.raw`a\x($b`, String.raw`a\.(xb`, String.raw`a\.($c`]) {
    assert.equal(pattern.test(other), false, other);
  }
});

// TRUST-18: one sign-off, all operator surfaces, without changing acceptance.
test("trust ack appends human decisions and displays them across report jobs run finish and PR", t => {
  const f = fixture(t), initial = f.job("build-one"); f.save(initial);
  const accepted = { decision: "accept", who: "operator@example.test", when, reason: "checked" };
  assert.deepEqual(ack(f, initial.jobId, "accept"), { status: "acknowledged", jobId: initial.jobId, ack: accepted, trust: { ...initial.trust, ack: [accepted] } });
  const rejected = { decision: "reject", who: "operator@example.test", when, reason: "tenant filter missing" };
  ack(f, initial.jobId, "reject", rejected.reason);
  const expected = { ...initial, trust: { ...initial.trust, ack: [accepted, rejected] } };
  assert.deepEqual(f.read(initial.jobId), expected);
  assert.deepEqual(reportView(f.read(initial.jobId)).trust, expected.trust);
  assert.deepEqual(gatedJobs([expected, f.job("pending"), { ...f.job("other"), labels: { runId: "other" } }], "run-one"), [
    { jobId: initial.jobId, reasons, status: "acknowledged", ack: rejected }, { jobId: "pending", reasons, status: "pending" },
  ]);
  assert.deepEqual(computeStats([expected, f.job("pending")], { runId: "run-one" }).humanReview, { jobs: 1, reasons: [reasons[0].reason] });
  assert.doesNotMatch(shareMarkdown(computeStats([expected], { runId: "run-one" })), /Needs human review/);
  assert.match(shareMarkdown(computeStats([expected, f.job("pending")], { runId: "run-one" })), /Needs human review \| 1 change:/);
  const listing = f.cli("jobs", "--json"); assert.equal(listing.status, 0, listing.stderr);
  assert.deepEqual(JSON.parse(listing.stdout).recent[0].trust, expected.trust);
  const human = f.cli("jobs"); assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /human review acknowledged \(reject\) by operator@example.test at 2026-10-02T00:00:00.000Z: tenant filter missing/);
  assert.deepEqual(loadTrustEvidence(f), [{ id: "reject:build-one:1", type: "reject", jobId: initial.jobId, when, ack: rejected,
    targets: [{ file: "access.py", symbols: ["check_scope"], line: 1 }], reasons }]);
  assert.deepEqual(fs.readdirSync(f.operatorDir), ["access.py"]);
  assert.equal(trustEvidenceFile(f).startsWith(path.join(f.stateDir, "trust-learning") + path.sep), true);
  assert.equal(operatorIdentity(f.operatorDir, () => " repo@example.test \n"), "repo@example.test");
  assert.equal(operatorIdentity(f.operatorDir, () => { throw new Error("not configured"); }), os.userInfo().username);
});

test("trust ack CLI validates human level flags repo and identity without changing outcomes", t => {
  const f = fixture(t); f.save(f.job("human")); f.save(f.job("normal", "normal")); f.save(f.job("review", "review"));
  fs.mkdirSync(path.join(f.operatorDir, ".git", "objects"), { recursive: true });
  fs.mkdirSync(path.join(f.operatorDir, ".git", "refs"));
  write(path.join(f.operatorDir, ".git", "HEAD"), "ref: refs/heads/main\n");
  write(path.join(f.operatorDir, ".git", "config"), "[user]\n\temail = repo@example.test\n");
  const cli = (...args) => spawnSync(process.execPath, [cliFile, "trust", "ack", ...args, "--repo", f.operatorDir, "--json"], {
    encoding: "utf8", env: { ...process.env, NOMARMY_AGENT_STATE: f.stateDir },
  });
  const result = cli("human", "--accept", "--reason", "operator approval"); assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(output).sort(), ["ack", "jobId", "status", "trust"]);
  assert.deepEqual(Object.keys(output.ack).sort(), ["decision", "reason", "when", "who"]);
  assert.equal(output.ack.who, "repo@example.test"); assert.equal(output.ack.reason, "operator approval"); assert.equal(output.ack.decision, "accept");
  assert.equal(new Date(output.ack.when).toISOString(), output.ack.when);
  assert.deepEqual(f.read("human"), { ...f.job("human"), trust: { ...f.job("human").trust, ack: [output.ack] } });
  const rejectResult = cli("human", "--reject"); assert.equal(rejectResult.status, 0, rejectResult.stdout);
  const rejectOutput = JSON.parse(rejectResult.stdout);
  assert.deepEqual(rejectOutput, { status: "acknowledged", jobId: "human", ack: { decision: "reject", who: "repo@example.test", when: rejectOutput.ack.when, reason: "" },
    trust: { ...f.job("human").trust, ack: [output.ack, rejectOutput.ack] } });
  assert.deepEqual(f.read("human"), { ...f.job("human"), trust: rejectOutput.trust });
  for (const id of ["normal", "review"]) {
    const refused = cli(id, "--accept"); assert.equal(refused.status, 1); assert.match(refused.stdout, /not human-level/);
    assert.deepEqual(f.read(id), f.job(id, id));
  }
  for (const flags of [[], ["--accept", "--reject"]]) { const refused = cli("human", ...flags); assert.equal(refused.status, 1); assert.match(refused.stdout, /exactly one/); }
  assert.throws(() => ack(f, "../human", "reject"), /Invalid job id/);
  f.save({ ...f.job("foreign"), projectDir: path.join(f.root, "other") });
  assert.throws(() => ack(f, "foreign", "accept"), /different repository/);
  assert.throws(() => trustEvidenceFile({ ...f, stateDir: path.join(f.operatorDir, "state") }), /outside the repository/);
});

test("trust learning records only independent supported review defects and deduplicates collection", t => {
  const f = fixture(t), job = f.job("build-one"), scout = review(f, job);
  assert.equal(recordReviewEvidence({ ...f, job, review: scout }), true);
  assert.equal(recordReviewEvidence({ ...f, job, review: scout }), false);
  const target = { file: "access.py", symbols: ["check_scope"], line: 1 };
  assert.deepEqual(loadTrustEvidence(f), [{ id: "review:review-one", type: "defect", jobId: job.jobId, reviewJobId: scout.jobId, when,
    targets: [target], findings: [{ text: "`check_scope` has a missing tenant check", targets: [target] }] }]);
  for (const modified of [
    { outcome: "WORKER_TIMEOUT" }, { worker: { provider: "builder" } }, { worker: {} }, { reviews: "another" }, { projectDir: "/other" },
    ...[{ supported: false }, { weak: true }, { unrelated: true }, { text: "No defects found in check_scope" }, { text: "check_scope correctly checks tenant" },
      { citations: [{ path: "unrelated.py", status: "ok" }] }, { citations: [{ path: "../access.py", status: "ok" }] }].map(change => ({ scout: { findings: [{ ...scout.scout.findings[0], ...change }] } })),
  ]) assert.equal(recordReviewEvidence({ ...f, job, review: { ...scout, jobId: "ignored", ...modified } }), false);
  assert.equal(loadTrustEvidence(f).length, 1);
  assert.deepEqual(trustSuggestions(f), []);
  assert.deepEqual(fs.readdirSync(f.operatorDir), ["access.py"]);
});

test("trust review learns at two events with evidence and accepts drops edits only on operator choice", t => {
  const f = fixture(t), job = f.job("build-one"); f.save(job); f.save(review(f, job));
  let result = f.cli("trust", "review", "--json"); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { status: "pending", entries: [], origins: [] });
  assert.equal(loadTrustEvidence(f).length, 1); // CLI collected the persisted review.
  ack(f, job.jobId, "reject");
  const summary = "2 of 2 recorded defects or rejections touched `access.py: check_scope`";
  const entry = { symbol: "check_scope", file: "access.py", category: "access", reason: summary, line: 1 };
  result = f.cli("trust", "review", "--json"); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { status: "pending", entries: [entry], origins: [{ writer: "trust learning", status: "evidence-backed",
    evidence: { summary, jobIds: ["build-one"], eventIds: ["reject:build-one:0", "review:review-one"] } }] });
  assert.deepEqual(loadTrustMap(f.operatorDir), []);
  assert.equal(f.cli("trust", "review", "--accept-all", "--json").status, 1);
  result = f.cli("trust", "review", "--decisions", '[{"action":"drop"}]', "--json"); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(trustSuggestions(f), []);
  result = f.cli("trust", "review", "--json"); assert.deepEqual(JSON.parse(result.stdout), { status: "pending", entries: [], origins: [] });
  // Re-collecting the same scout is not new evidence.
  assert.equal(loadTrustEvidence(f).length, 2);
  const beforeNewEvidence = trustSuggestions(f).map(s => s.entry);
  const next = f.job("build-two"); f.save(next); ack(f, next.jobId, "reject");
  assert.throws(() => reviewTrustLearning({ ...f, decisions: [], expected: beforeNewEvidence }), /proposals changed while being reviewed/);
  assert.deepEqual(loadTrustMap(f.operatorDir), []);
  const suggestions = trustSuggestions(f); assert.equal(suggestions.length, 1);
  assert.deepEqual(suggestions[0].evidence, { summary: "3 of 3 recorded defects or rejections touched `access.py: check_scope`", jobIds: ["build-one", "build-two"],
    eventIds: ["reject:build-one:0", "reject:build-two:0", "review:review-one"] });
  const edited = { symbol: "check_scope", file: "access.py", category: "tenant", reason: "Tenant access guarantee" };
  result = f.cli("trust", "review", "--decisions", JSON.stringify([{ action: "edit", entry: edited }]), "--json"); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { status: "reviewed", map: TRUST_MAP_FILE, entries: [edited], decisions: [{ action: "edit", entry: edited }] });
  assert.deepEqual(loadTrustMap(f.operatorDir), [edited]); assert.deepEqual(trustSuggestions(f), []);
  // An unrelated repo sharing this state directory cannot see these records.
  const other = path.join(f.root, "other"); fs.mkdirSync(other);
  assert.deepEqual(loadTrustEvidence({ ...f, operatorDir: other }), []);
});

test("trust file-only learning accepts a whole-file map entry that gates subsequent changes", t => {
  const f = fixture(t);
  for (const id of ["a", "b"]) { f.save({ ...f.job(id), trust: { level: "human", reasons: [] } }); ack(f, id, "reject"); }
  const summary = "2 of 2 recorded defects or rejections touched `access.py`";
  const entry = { symbol: "*", file: "access.py", category: "access", reason: summary };
  const result = reviewTrustLearning({ ...f, decisions: [{ action: "accept" }] });
  assert.deepEqual(result, { status: "reviewed", map: TRUST_MAP_FILE, entries: [entry], decisions: [{ action: "accept" }] });
  assert.deepEqual(trustSuggestions(f), []);
  const reach = computeTrustReach({ baseDir: f.operatorDir, entries: loadTrustMap(f.operatorDir) });
  assert.deepEqual(reach.boundaries, [{ entry, nodes: [] }]); assert.deepEqual(reach.caps, []);
  const fileChanges = [{ file: "access.py", before: "old", after: "new" }];
  assert.deepEqual(evaluateReachTrust({ reach, fileChanges }), { level: "review", reasons: [{ rule: "trust-reach", file: "access.py", line: 1, reason: "changes mapped file access.py, the access boundary" }] });
  assert.deepEqual(evaluateReachTrust({ reach, fileChanges, checks: [{ file: "access.py", line: 9 }] }), { level: "human", reasons: [{ rule: "trust-reach", file: "access.py", line: 1, reason: "removes a check in mapped file access.py, the access boundary" }] });
  assert.deepEqual(evaluateReachTrust({ reach, fileChanges: [{ file: "elsewhere.py", before: "old", after: "new" }] }), { level: "normal", reasons: [] });
});

test("trust completed scout execution persists review evidence automatically", async t => {
  const f = fixture(t), job = f.job("build-one"); f.save(job);
  const source = "def check_scope(user):\n    return user.tenant\n";
  const executor = createExecutor({ VERSION: "test", projectDir: f.operatorDir, jobsRoot: f.jobsRoot,
    assertRepo: async () => {}, ensureJobsRoot: () => {}, resolveBase: async () => ({ sha: "base", ref: "main" }),
    sweepStaleSandboxContainers: async () => {},
    run: async (_command, args) => { if (args[1] === "add") fs.mkdirSync(args[3], { recursive: true }); },
    gitRaw: async () => source,
    collectGitRecord: async () => ({ repoStatusFiles: [] }), budgetState: { budgets: { scout: {} } },
    runOpenClaw: async () => ({ final: "SCOUT REPORT\nQUESTION: Find defects\nCONFIDENCE: high\nFINDING: `check_scope` has a missing tenant check [access.py:1-2]\nNOT_FOUND: none\nEND", provider: "reviewer" }),
    buildMetrics: () => ({ worker_provider: "reviewer" }), recordedBudgets: () => ({}), resolveReasoningApplied: () => "high", execution: {},
  });
  const result = await executor.executeJob({ task: "Find defects", mode: "scout", reviews: job.jobId, jobId: "runtime-review" });
  assert.equal(result.manifest.outcome, "SCOUT_DONE", JSON.stringify(result.manifest));
  const evidence = loadTrustEvidence(f);
  assert.equal(evidence.length, 1);
  assert.deepEqual(evidence[0], { id: "review:runtime-review", type: "defect", jobId: job.jobId, reviewJobId: "runtime-review", when: result.manifest.finishedAt,
    targets: [{ file: "access.py", symbols: ["check_scope"], line: 1 }], findings: [{ text: "check_scope has a missing tenant check", targets: [{ file: "access.py", symbols: ["check_scope"], line: 1 }] }] });
});
