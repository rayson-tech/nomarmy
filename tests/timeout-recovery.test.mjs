import assert from "node:assert/strict";
import test from "node:test";
import zlib from "node:zlib";

import { parseOpenClawInternalTimeout, failedRunUsage, timeBudgetNote } from "../lib/openclaw-run.mjs";
import { eventFromRow } from "../lib/transcript.mjs";

// From a real Grok security review, cut off by OpenClaw's own timer mid-read.
const CUT_OFF_STDOUT = JSON.stringify({ ok: false, status: "error", final: "", usage: { input: 331410, output: 38733, cacheRead: 1817344, cacheWrite: 0, total: 2187487 },
  costUsd: 1.80389, toolSummary: { calls: 72, failures: 2 }, sessionId: "122da638", error: { message: "⚠️ Read failed", kind: "error_payload" } });
const CUT_OFF_STDERR = "[agent/embedded] embedded run timeout: runId=122da638 sessionId=122da638 timeoutMs=599973\n[agents/agent-command] run ended with stopReason=toolUse\n";

test("OpenClaw's own timer ending a run mid-tool-call is a timeout, not a crash", () => {
  assert.equal(parseOpenClawInternalTimeout(CUT_OFF_STDOUT, CUT_OFF_STDERR), true);
  assert.equal(parseOpenClawInternalTimeout(CUT_OFF_STDOUT, "some other failure"), false, "an ordinary error envelope stays a failure");
  assert.equal(parseOpenClawInternalTimeout(JSON.stringify({ ok: false, status: "timeout" })), true, "the envelope's own timeout still counts");
});

test("a failed run's envelope still gives its usage and cost for the record", () => {
  assert.deepEqual(failedRunUsage(CUT_OFF_STDOUT), { usage: JSON.parse(CUT_OFF_STDOUT).usage, costUsd: 1.80389, toolSummary: { calls: 72, failures: 2 }, sessionId: "122da638" });
  assert.deepEqual(failedRunUsage("not json"), {});
  assert.deepEqual(failedRunUsage(""), {});
});

test("the worker is told its time and when to write the report", () => {
  assert.match(timeBudgetNote(528, "scout"), /about 9 minute\(s\).*By minute 7, stop exploring and write your report/s);
  assert.match(timeBudgetNote(1200, "implement"), /about 20 minute\(s\).*By minute 16, stop starting new work, finish verification/s);
  assert.match(timeBudgetNote(528, "scout"), /NOT DONE/);
  assert.equal(timeBudgetNote(undefined, "scout"), "");
});

test("transcript rows: plain and zstd-compressed events both read", () => {
  const event = { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read" }] } };
  assert.deepEqual(eventFromRow({ event_json: JSON.stringify(event), event_zstd: null }), event);
  assert.equal(eventFromRow({ event_json: "{torn", event_zstd: null }), null);
  assert.equal(eventFromRow({ event_json: null, event_zstd: null }), null);
  if (typeof zlib.zstdCompressSync !== "function") return; // Node before 22.15: compressed rows are skipped, never thrown on
  assert.deepEqual(eventFromRow({ event_json: null, event_zstd: zlib.zstdCompressSync(Buffer.from(JSON.stringify(event))) }), event);
});

import { defaultTimeoutSeconds } from "../mcp/server.mjs";
import { detectScopedTestSelectionRisk } from "../lib/diff-checks.mjs";
import { reportView } from "../lib/job-format.mjs";

test("review scouts default to 20 minutes, everything else to 10", () => {
  const army = () => ({ roles: { "security-analyst": { phase: "review" }, "sr-dev": { phase: "build" } } });
  assert.equal(defaultTimeoutSeconds({ mode: "scout", reviews: "worker-1" }, army), 1200);
  assert.equal(defaultTimeoutSeconds({ mode: "scout", army_role: "security-analyst" }, army), 1200);
  assert.equal(defaultTimeoutSeconds({ mode: "scout", army_role: "sr-dev" }, army), 600);
  assert.equal(defaultTimeoutSeconds({ mode: "scout" }, army), 600);
  assert.equal(defaultTimeoutSeconds({ mode: "implement", army_role: "security-analyst" }, army), 600);
  assert.equal(defaultTimeoutSeconds({ mode: "scout", army_role: "x" }, () => { throw new Error("bad config"); }), 600);
});

test("scoped selection: no warning when a command runs the changed test files by name", () => {
  const testChanges = { new_tests_added: ["lambda/tests/test_x.py"], existing_tests_modified: [] };
  const byName = 'if [ -n "$NOMARMY_CHANGED_TEST_FILES" ]; then python3 -m pytest $NOMARMY_CHANGED_TEST_FILES -q; fi';
  const scoped = 'python3 -m pytest lambda/tests/ -k "gx or resolver" -q';
  assert.equal(detectScopedTestSelectionRisk({ commands: [byName, scoped], testChanges }), null, "Senti's profile: the touched tests always run");
  assert.ok(detectScopedTestSelectionRisk({ commands: [scoped], testChanges }), "only a filtered run: still a risk");
  assert.ok(detectScopedTestSelectionRisk({ commands: ["pytest ${NOMARMY_CHANGED_TEST_FILES} -k fast"], testChanges }), "the changed files, but filtered: still a risk");
});

test("report view: the report and verdict, not the whole record", () => {
  const meta = { jobId: "w1", mode: "implement", outcome: "WORKER_DONE", coordinatorStatus: "complete", issues: ["TEST CHANGE REVIEW: x"], branch: "nomarmy/w1",
    reportValidation: { fields: { STATUS: "done", TESTS: "pass", NOT_DONE: "none", NOTE: "added it" }, gate: {} },
    independentVerification: { status: "pass", basis: "long", detail: null }, regressionCheck: { status: "pass" },
    commit: { created: true, sha: "abc" }, git: { changedFiles: ["a.py"], additions: 3, deletions: 1 }, metrics: { lots: 1 }, budgets: { lots: 1 }, execution: {} };
  const v = reportView(meta);
  assert.deepEqual(v.report, { STATUS: "done", TESTS: "pass", NOT_DONE: "none", NOTE: "added it" });
  assert.deepEqual(v.commit, { created: true, sha: "abc", branch: "nomarmy/w1", reason: null });
  assert.equal(v.metrics, undefined); assert.equal(v.budgets, undefined);
  const scout = reportView({ jobId: "s1", mode: "scout", outcome: "SCOUT_DONE", scout: { question: "q", confidence: "high", findings: [{ claim: "c", citation: "a.py:1-2" }], unsupported: [] } });
  assert.equal(scout.findings.length, 1); assert.equal(scout.confidence, "high");
});
