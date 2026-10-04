import "./helpers/isolate-global-config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
let DatabaseSync;
try { ({ DatabaseSync } = await import("node:sqlite")); } catch { /* older Node */ }
const timingTest = DatabaseSync && zlib.zstdCompressSync ? test : (name, fn) => test(name, { skip: "node:sqlite and zstd required" }, fn);
import { readOpenClawTiming, timeoutTimingIssue } from "../lib/transcript.mjs";
import { createExecutor } from "../lib/execute.mjs";
import { plantWorktreePointer } from "./helpers/worktree-fixture.mjs";
import { classifyTestChanges } from "../lib/diff-checks.mjs";
import { createVerificationFlow } from "../lib/verification-flow.mjs";
import { deriveTimeBudget } from "../lib/budget.mjs";

const start = 1_000_000;
const message = (role, content = []) => ({ type: "message", message: { role, content } });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".worker-timing-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function transcript(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "openclaw-agent.sqlite"));
  db.exec("create table transcript_events (seq integer, created_at integer, event_json text, event_zstd blob)");
  let seq = 0;
  const insert = db.prepare("insert into transcript_events values (?, ?, ?, ?)");
  const add = (seconds, event, compressed = false) => {
    const json = JSON.stringify(event);
    insert.run(++seq, start + seconds * 1000, compressed ? null : json, compressed ? zlib.zstdCompressSync(Buffer.from(json)) : null);
  };
  add(-10, message("assistant")); // A prior session is not this run.
  add(0, message("user"));
  for (let i = 0; i < 13; i++) {
    add(207 + i * 20, message("assistant", Array.from({ length: i < 9 ? 2 : 1 }, () => ({ type: "toolCall", name: "read", arguments: { path: "answer.py" } }))), i % 2 === 0);
    add(i === 12 ? 485 : 208 + i * 20, message("toolResult", [{ type: "text", text: "answer = 42" }]), i % 2 !== 0);
  }
  return { db, add };
}
const expected = (overrides = {}) => ({ available: true, reason: null, startedMs: start, cutoffMs: start + 528000,
  idleBreakSeconds: 185, filesChanged: true, lastActivitySeconds: 43, longestGapSeconds: 207,
  longestGapStartSeconds: 0, assistantTurns: 13, toolCalls: 22, ...overrides });
const recent = "still working when time ran out: last activity 43s before the cutoff; 13 turns, 22 tool calls; slowest response 207s (longest event gap, starting 0s into the run); worktree files changed: yes; try a longer timeout_seconds or a lower reasoning level";
const quiet = "quiet for the last 321s before the cutoff: the worker or its model request may have stalled; 13 turns, 22 tool calls; slowest response 207s (longest event gap, starting 0s into the run); worktree files changed: yes; check the provider and retry";

timingTest("sqlite timing counts both encodings, excludes old and recovery rows, and classifies the actual quiet interval", async t => {
  const dir = fixture(t), { db, add } = transcript(dir);
  add(529, message("assistant"));
  db.close();
  const timing = await readOpenClawTiming(dir, { startedMs: start, cutoffMs: start + 528000, idleBreakSeconds: 185, filesChanged: true });
  assert.deepEqual(timing, expected());
  assert.equal(timeoutTimingIssue(timing, { stopReason: "timeout" }), recent);
  assert.equal(timeoutTimingIssue(timing, { stopReason: "openclaw_internal_timeout" }), recent);
  assert.equal(timeoutTimingIssue(timing, { outcome: "WORKER_TIMEOUT" }), recent);
  assert.equal(timeoutTimingIssue(timing), null);
  assert.equal(timeoutTimingIssue(timing, { stopReason: "idle_diff" }), null);
  assert.equal(timeoutTimingIssue({ ...timing, idleBreakSeconds: 43 }, { timedOut: true }), recent);
  assert.equal(timeoutTimingIssue({ ...timing, lastActivitySeconds: 321 }, { timedOut: true }), quiet);
});

timingTest("sqlite timing does not guess when missing, empty, undecodable, or timestamp-free", async t => {
  const dir = fixture(t), opts = { startedMs: start, cutoffMs: start + 528000, idleBreakSeconds: 185, filesChanged: false };
  const missing = await readOpenClawTiming(dir, opts);
  assert.deepEqual(missing, expected({ ...opts, available: false, reason: "no transcript database under the state directory", lastActivitySeconds: null, longestGapSeconds: null, longestGapStartSeconds: null, assistantTurns: null, toolCalls: null }));
  assert.equal(timeoutTimingIssue(missing, { timedOut: true }), "timing unavailable: no transcript database under the state directory; timeout activity cannot be classified");
  const { db } = transcript(dir);
  db.exec("delete from transcript_events");
  assert.equal((await readOpenClawTiming(dir, opts)).reason, "no transcript events during the main run");
  db.prepare("insert into transcript_events values (1, ?, '{broken', null)").run(start);
  assert.equal((await readOpenClawTiming(dir, opts)).reason, "one or more transcript events could not be decoded");
  db.exec("drop table transcript_events; create table transcript_events (event_json text)");
  const old = await readOpenClawTiming(dir, opts);
  assert.equal(old.available, false);
  assert.match(timeoutTimingIssue(old, { timedOut: true }), /^timing unavailable: could not read transcript timing: .*created_at/);
  db.close();
});

timingTest("a single event has no invented slowest gap", async t => {
  const dir = fixture(t), { db, add } = transcript(dir);
  db.exec("delete from transcript_events");
  add(485, message("assistant"));
  db.close();
  const timing = await readOpenClawTiming(dir, { startedMs: start, cutoffMs: start + 528000, idleBreakSeconds: 185 });
  assert.deepEqual(timing, expected({ filesChanged: null, longestGapSeconds: null, longestGapStartSeconds: null, assistantTurns: 1, toolCalls: 0 }));
  assert.equal(timeoutTimingIssue(timing, { timedOut: true }), "still working when time ran out: last activity 43s before the cutoff; 1 turns, 0 tool calls; slowest response unavailable (fewer than two events); worktree changes unavailable; try a longer timeout_seconds or a lower reasoning level");
});

timingTest("slowest gap is located relative to job start, not always at the first event", async t => {
  const dir = fixture(t), { db, add } = transcript(dir);
  db.exec("delete from transcript_events");
  add(0, message("user"));
  add(10, message("assistant", [{ type: "tool_use", name: "exec" }]));
  add(217, message("toolResult"), true);
  add(227, message("assistant"));
  db.close();
  const timing = await readOpenClawTiming(dir, { startedMs: start, cutoffMs: start + 528000, idleBreakSeconds: 185, filesChanged: false });
  assert.deepEqual(timing, expected({ filesChanged: false, lastActivitySeconds: 301, longestGapStartSeconds: 10, assistantTurns: 2, toolCalls: 1 }));
  assert.equal(timeoutTimingIssue(timing, { timedOut: true }), "quiet for the last 301s before the cutoff: the worker or its model request may have stalled; 2 turns, 1 tool calls; slowest response 207s (longest event gap, starting 10s into the run); worktree files changed: no; check the provider and retry");
});

const reports = {
  implement: "STATUS: done\nTESTS: pass\nNOT_DONE: none\nNOTE: implemented",
  scout: "SCOUT REPORT\nQUESTION: Inspect answer\nCONFIDENCE: high\nFINDING: answer returns 42 [answer.py:1]\nNOT_FOUND: none\nEND",
  decompose: "DECOMPOSE REPORT\nOBJECTIVE: Improve answer\nCONFIDENCE: high\nSUBTASK: Document answer\nACCEPTANCE: Explain answer\nFILES: [answer.py:1]\nNOT_SPLITTABLE: none\nEND",
};
for (const mode of Object.keys(reports)) {
  for (const scenario of ["recent", "quiet", "missing", "success"]) {
    timingTest(`${mode} ${scenario}: main-run timing persists and recovery cannot change the diagnosis`, async t => {
      const root = fixture(t), projectDir = path.join(root, "repo"), jobsRoot = path.join(root, "jobs");
      fs.mkdirSync(projectDir); fs.mkdirSync(jobsRoot);
      t.mock.method(Date, "now", () => start);
      const record = { repoStatusFiles: ["answer.py"], changedFiles: ["answer.py"], nameStatus: [{ status: "M", path: "answer.py" }],
        testChanges: classifyTestChanges([{ status: "M", path: "answer.py" }]), issues: [], ignoredRuntimeJunk: [], filesChanged: 1, additions: 1, deletions: 1 };
      const flow = createVerificationFlow({});
      flow.registerVerificationRunner(async () => ({ status: "pass" }));
      let recoveryCalls = 0;
      const executor = createExecutor({ VERSION: "test", projectDir, jobsRoot,
        assertRepo: async () => {}, ensureJobsRoot: () => {}, resolveBase: async () => ({ sha: "base", ref: "main" }),
        sweepStaleSandboxContainers: async () => {},
        run: async (_command, args) => { if (args[1] === "add") plantWorktreePointer(args[2] === "-b" ? args[4] : args[3], projectDir); return { stdout: "" }; },
        gitRaw: async args => args[0] === "show" ? "answer = 42\n" : "",
        collectGitRecord: async () => record,
        createCoordinatorCommit: async () => ({ created: false, reason: "test fixture" }),
        budgetState: { budgets: { scout: {}, decompose: {}, report: { implement: {}, scout: { targetTokens: 600, hardCapTokens: 1024 } } } },
        runOpenClaw: async ({ runtimeDir, overridePrompt }) => {
          if (overridePrompt) {
            recoveryCalls++;
            if (scenario !== "missing") {
              const db = new DatabaseSync(path.join(runtimeDir, "state", "openclaw-agent.sqlite"));
              db.prepare("insert into transcript_events values (100, ?, ?, null)").run(start + 900000, JSON.stringify(message("assistant")));
              db.close();
            }
            return { final: reports[mode] };
          }
          if (scenario !== "missing") transcript(path.join(runtimeDir, "state")).db.close();
          const runCutoffMs = start + (scenario === "quiet" ? 806000 : 528000);
          if (scenario === "success") return { final: reports[mode], runCutoffMs };
          throw Object.assign(new Error("cut off"), { timedOut: true, stopReason: "openclaw_internal_timeout", partialResult: { runCutoffMs } });
        },
        ...flow, verificationFlow: flow, repoPolicy: () => ({}), buildMetrics: () => ({}), recordedBudgets: () => ({}), resolveReasoningApplied: () => "high", execution: {},
      });
      const result = await executor.executeJob({ task: "Inspect answer", mode, timeoutSeconds: 600, jobId: "timing-job" });
      assert.equal(result.manifest.error, undefined, result.report);
      const timing = result.manifest.timing;
      const idleBreakSeconds = deriveTimeBudget({ timeoutSeconds: 600 }).idleBreakSeconds;
      assert.equal(idleBreakSeconds, 185);
      assert.deepEqual(timing, expected({ idleBreakSeconds,
        ...(scenario === "quiet" ? { cutoffMs: start + 806000, lastActivitySeconds: 321 } : {}),
        ...(scenario === "missing" ? { available: false, reason: "no transcript database under the state directory", lastActivitySeconds: null, longestGapSeconds: null, longestGapStartSeconds: null, assistantTurns: null, toolCalls: null } : {}),
      }));
      assert.deepEqual(result.manifest.issues.filter(s => /^(still working|quiet for|timing unavailable)/.test(s)), scenario === "success" ? [] : [scenario === "recent" ? recent : scenario === "quiet" ? quiet : "timing unavailable: no transcript database under the state directory; timeout activity cannot be classified"]);
      assert.equal(recoveryCalls, mode !== "decompose" && scenario !== "success" ? 1 : 0);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.jobDir, "metadata.json"), "utf8")).timing, timing);
    });
  }
}
