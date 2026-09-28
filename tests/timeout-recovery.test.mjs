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
