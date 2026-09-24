import "./helpers/isolate-global-config.mjs";
// Tests for lib/claude-transcript.mjs: what a Claude CLI worker read, from
// Claude Code's own session transcript. Run: node --test tests/claude-transcript.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { claudeProjectDir, readClaudeSessionTranscript, readClaudeSessionUsage, summarizeClaudeEvents } from "../lib/claude-transcript.mjs";

const dirs = [];
function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-claude-tx-")); dirs.push(d); return d; }
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// The real event shapes from a Senti scout's transcript, with repo content replaced.
const EVENTS = [
  { type: "assistant", message: { content: [{ type: "text", text: "I'll map the pipeline." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "grep -rn discover src/" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "src/a.ts:1:discover()\nsrc/b.ts:9:discover()" }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "/w/src/a.ts" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "export function discover() {}" }] }] } },
  { type: "attachment" },
  { type: "assistant", message: { content: [{ type: "text", text: "SCOUT REPORT\nQUESTION: q\nCONFIDENCE: high\nNOT_FOUND: none\nEND" }] } },
];

test("claudeProjectDir: every non-alphanumeric character in the working directory becomes a dash", () => {
  assert.equal(
    claudeProjectDir("/Users/j/.local/share/nomarmy-local-agents/jobs/scout-20260924-035608-f91743/worktree", { home: "/h" }),
    "/h/.claude/projects/-Users-j--local-share-nomarmy-local-agents-jobs-scout-20260924-035608-f91743-worktree",
  );
});

test("summarizeClaudeEvents: tool calls, what they read, and the final report", () => {
  const s = summarizeClaudeEvents(EVENTS);
  assert.equal(s.modelCalls, 3);
  assert.deepEqual(s.toolCalls.map((c) => c.tool), ["Bash", "Read"]);
  assert.deepEqual(s.filesRead, ["/w/src/a.ts"]);
  assert.deepEqual(s.commands, ["grep -rn discover src/"]);
  assert.equal(s.repoReadChars, "src/a.ts:1:discover()\nsrc/b.ts:9:discover()".length + "export function discover() {}".length);
  assert.match(s.lastAssistantText, /^SCOUT REPORT[\s\S]*END$/);
});

test("readClaudeSessionTranscript: finds the job's session by its working directory, newest since the job started", () => {
  const home = tmp();
  const cwd = "/jobs/scout-x/worktree";
  const dir = claudeProjectDir(cwd, { home });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "old.jsonl"), JSON.stringify(EVENTS[0]) + "\n");
  const old = new Date(Date.now() - 3600_000);
  fs.utimesSync(path.join(dir, "old.jsonl"), old, old);
  fs.writeFileSync(path.join(dir, "new.jsonl"), EVENTS.map((e) => JSON.stringify(e)).join("\n") + "\n{torn");
  const t = readClaudeSessionTranscript(cwd, { home, sinceMs: Date.now() - 60_000 });
  assert.equal(t.available, true);
  assert.equal(t.source, "claude-code-session");
  assert.equal(t.toolCalls.length, 2, "the newest session, and a torn last line is skipped");
  assert.equal(readClaudeSessionTranscript("/no/such/job", { home }).available, false);
  assert.equal(readClaudeSessionTranscript(cwd, { home, sinceMs: Date.now() + 60_000 }).available, false, "nothing from after the job started");
});

test("readClaudeSessionUsage: every call in every session file since the start, each message id once", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-cu-"));
  try {
    const cwd = "/work/jobs/claude-x/worktree";
    const dir = claudeProjectDir(cwd, { home });
    fs.mkdirSync(dir, { recursive: true });
    const call = (id, u) => JSON.stringify({ type: "assistant", message: { id, usage: u, content: [{ type: "text", text: "x" }] } });
    const u1 = { input_tokens: 2, output_tokens: 100, cache_read_input_tokens: 50000, cache_creation_input_tokens: 3000 };
    // One call logged twice (a text block and a tool_use block share the id), one more call, and a user line.
    fs.writeFileSync(path.join(dir, "a.jsonl"), [call("m1", u1), call("m1", u1), call("m2", { input_tokens: 1, output_tokens: 20, cache_read_input_tokens: 60000 }), JSON.stringify({ type: "user", message: { content: "hi" } })].join("\n"));
    // The report-recovery call's own session.
    fs.writeFileSync(path.join(dir, "b.jsonl"), call("m3", { input_tokens: 3, output_tokens: 8, cache_read_input_tokens: 70000 }));
    assert.deepEqual(readClaudeSessionUsage(cwd, { home }), { input: 6, output: 128, cacheRead: 180000, cacheWrite: 3000, calls: 3 });
    assert.equal(readClaudeSessionUsage("/somewhere/else", { home }), null);
    assert.equal(readClaudeSessionUsage(cwd, { home, sinceMs: Date.now() + 60000 }), null, "sessions from before the job don't count");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
