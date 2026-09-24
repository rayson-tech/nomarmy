// Transcript summary and displacement estimate. The sqlite reader is thin
// and exercised live; the reduction and the arithmetic are pinned here.
import "./helpers/isolate-global-config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { summarizeTranscriptEvents, estimateDisplacement, findTranscriptDb, readOpenClawTranscript } from "../lib/transcript.mjs";

// Shape observed verbatim in OpenClaw 2026.9.4's transcript_events.
const EVENTS = [
  { type: "session" },
  { type: "message", message: { role: "user", content: [{ type: "text", text: "brief" }] } },
  { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "ls", input: { path: "." } }] } },
  { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "x".repeat(339) }] } },
  { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read", input: { path: "AGENTS.md" } }] } },
  { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "y".repeat(2786) }] } },
  { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read", input: { path: "CLAUDE.md" } }] } },
  { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "z".repeat(5504) }] } },
  { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "exec", input: { command: "grep -n resolveOutcome mcp/server.mjs" } }] } },
  { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "w".repeat(200) }] } },
  { type: "message", message: { role: "assistant", content: [{ type: "text", text: "SCOUT REPORT ...".padEnd(875, ".") }] } },
];

test("summarizeTranscriptEvents: counts model calls, tool calls, files read and repository chars consumed", () => {
  const s = summarizeTranscriptEvents(EVENTS);
  assert.equal(s.modelCalls, 5);
  assert.equal(s.toolCalls.length, 4);
  assert.deepEqual(s.filesRead, ["AGENTS.md", "CLAUDE.md"]);
  assert.deepEqual(s.commands, ["grep -n resolveOutcome mcp/server.mjs"]);
  assert.equal(s.toolResultChars, 339 + 2786 + 5504 + 200);
  assert.equal(s.assistantChars, 875);
});

test("summarizeTranscriptEvents: harness tool output is separated from repository reads", () => {
  // Second live run in shape: two tool_search calls before any file was read.
  const s = summarizeTranscriptEvents([
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "tool_search", input: { query: "read files" } }] } },
    { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "h".repeat(4000) }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read", input: { path: "AGENTS.md" } }] } },
    { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "r".repeat(2786) }] } },
  ]);
  assert.equal(s.toolResultChars, 6786);
  assert.equal(s.repoReadChars, 2786);
  assert.equal(s.harnessChars, 4000);
  assert.equal(s.toolCalls[0].repoRead, false);
  assert.equal(s.toolCalls[1].resultChars, 2786);
  assert.deepEqual(s.filesRead, ["AGENTS.md"]);
});

test("summarizeTranscriptEvents: tolerates junk and alternative tool-call spellings", () => {
  const s = summarizeTranscriptEvents([null, { type: "custom" }, { type: "message", message: { role: "assistant", content: [{ type: "tool_use", name: "read", arguments: { file: "a.js" } }] } },
    { type: "message", message: { role: "tool", content: [{ type: "text", content: "abcd" }] } }]);
  assert.deepEqual(s.filesRead, ["a.js"]);
  assert.equal(s.toolResultChars, 4);
});

test("estimateDisplacement: positive, marginal, negative and unknown, with the sign always honest", () => {
  const first = estimateDisplacement({ readChars: 8829, deliveredChars: 3600 });
  assert.equal(first.frontier_read_tokens_est, 2207);
  assert.equal(first.delivered_tokens_est, 900);
  assert.equal(first.displaced_tokens_est, 1307);
  assert.equal(first.verdict, "positive");
  const marginal = estimateDisplacement({ readChars: 6000, deliveredChars: 4000 });
  assert.equal(marginal.verdict, "marginal");
  const negative = estimateDisplacement({ readChars: 2000, deliveredChars: 3000 });
  assert.equal(negative.verdict, "negative");
  assert.ok(negative.displaced_tokens_est < 0);
  const unknown = estimateDisplacement({ readChars: null, deliveredChars: 1000 });
  assert.equal(unknown.verdict, "unknown");
  assert.equal(unknown.displaced_tokens_est, null);
});

test("estimateDisplacement: deliveredChars of 0 with readChars > 0 returns note without null/NaN", () => {
  const result = estimateDisplacement({ readChars: 400, deliveredChars: 0, charsPerToken: 4 });
  assert.equal(result.verdict, "positive");
  assert.equal(result.ratio, null);
  assert.equal(result.displaced_tokens_est, 100);
  assert.ok(!result.note.includes("null"), "note must not contain 'null'");
  assert.ok(!result.note.includes("NaN"), "note must not contain 'NaN'");
  assert.ok(result.note.includes("read content") || result.note.includes("displaced"), "note must describe the displacement");
});

test("findTranscriptDb / readOpenClawTranscript: absent state is reported, never fabricated", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-transcript-"));
  try {
    assert.equal(findTranscriptDb(dir), null);
    const r = await readOpenClawTranscript(dir);
    assert.equal(r.available, false);
    assert.match(r.reason, /no transcript database/);
    fs.mkdirSync(path.join(dir, "agents", "main", "agent"), { recursive: true });
    fs.writeFileSync(path.join(dir, "agents", "main", "agent", "openclaw-agent.sqlite"), "not a database");
    assert.equal(path.basename(findTranscriptDb(dir)), "openclaw-agent.sqlite");
    const bad = await readOpenClawTranscript(dir);
    assert.equal(bad.available, false, "a corrupt database is unavailable, not a crash");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// readOpenClawTranscriptTail: the cheap read watchers use every few seconds.
const TAIL_SQLITE = await import("node:sqlite").then(() => true, () => false);
test("readOpenClawTranscriptTail: the last N events or everything after event N, always with the total count", { skip: TAIL_SQLITE ? false : "node:sqlite unavailable" }, async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { readOpenClawTranscriptTail } = await import("../lib/transcript.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-tail-"));
  try {
    const dbPath = path.join(dir, "agents", "main", "agent", "openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE transcript_events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (session_id, seq))");
    const insert = db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?, ?)");
    const say = (text) => JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
    ["one", "two", "three", "four"].forEach((t, i) => insert.run("s", i, say(t), Date.now()));
    db.close();
    const tail = await readOpenClawTranscriptTail(dir, { limit: 2 });
    assert.equal(tail.events, 4);
    assert.equal(tail.modelCalls, 2, "only the last two were read");
    assert.equal(tail.lastAssistantText, "four");
    const since = await readOpenClawTranscriptTail(dir, { sinceEvent: 3 });
    assert.equal(since.modelCalls, 1);
    assert.equal(since.lastAssistantText, "four");
    assert.equal((await readOpenClawTranscriptTail(dir, { sinceEvent: 4 })).lastAssistantText, null);
    assert.equal((await readOpenClawTranscriptTail(dir, { limit: 0 })).events, 4, "count only");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
