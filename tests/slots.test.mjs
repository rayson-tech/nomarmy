import "./helpers/isolate-global-config.mjs";
// Tests for lib/slots.mjs: machine-wide job leases and agent slots, shared
// by every coordinator session's server. Run: node --test tests/slots.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { acquireSlot, liveLeases, liveSlots, pidAlive, removeLease, writeLease } from "../lib/slots.mjs";

const dirs = [];
function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-slots-")); dirs.push(d); return d; }
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// A pid that can't be running: far above any real pid range.
const DEAD_PID = 2 ** 30;

test("pidAlive: this process is alive; a pid that can't exist isn't", () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(DEAD_PID), false);
  assert.equal(pidAlive(0), false);
});

test("leases: counted across the machine by lane and agent, removed when the job ends", () => {
  const dir = tmp();
  writeLease(dir, "job-a", { lane: "local" });
  writeLease(dir, "job-b", { lane: "remote", agent: "codex" });
  writeLease(dir, "job-c", { lane: "remote", agent: "grok" });
  assert.equal(liveLeases(dir).length, 3);
  assert.equal(liveLeases(dir, { lane: "remote" }).length, 2);
  assert.equal(liveLeases(dir, { agent: "codex" }).length, 1);
  removeLease(dir, "job-b");
  assert.equal(liveLeases(dir, { lane: "remote" }).length, 1);
});

test("leases: one left by a session that's gone doesn't count, and is cleaned up", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "ghost.json"), JSON.stringify({ jobId: "ghost", lane: "local", pid: DEAD_PID }));
  writeLease(dir, "real", { lane: "local" });
  assert.deepEqual(liveLeases(dir).map((l) => l.jobId), ["real"]);
  assert.equal(fs.existsSync(path.join(dir, "ghost.json")), false);
});

test("acquireSlot: max_concurrent 1 means one holder, machine-wide; released, the next one gets it", async () => {
  const dir = tmp();
  const first = await acquireSlot(dir, "claude", 1, { jobId: "a" });
  assert.ok(first);
  assert.equal(liveSlots(dir, "claude"), 1);
  assert.equal(await acquireSlot(dir, "claude", 1, { jobId: "b" }), null, "a second session can't take the only slot");
  assert.ok(await acquireSlot(dir, "codex", 1), "another agent's slots are separate");
  first.release();
  assert.equal(liveSlots(dir, "claude"), 0);
  assert.ok(await acquireSlot(dir, "claude", 1, { jobId: "b" }));
});

test("acquireSlot: max_concurrent 2 gives out two slots, then refuses", async () => {
  const dir = tmp();
  assert.ok(await acquireSlot(dir, "grok", 2));
  assert.ok(await acquireSlot(dir, "grok", 2));
  assert.equal(await acquireSlot(dir, "grok", 2), null);
  assert.equal(liveSlots(dir, "grok"), 2);
});

test("acquireSlot: a slot held by a crashed session is reclaimed rather than wedging the agent", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "claude.0.lock"), JSON.stringify({ pid: DEAD_PID, token: "x", jobId: "gone" }));
  assert.equal(liveSlots(dir, "claude"), 0);
  assert.ok(await acquireSlot(dir, "claude", 1, { jobId: "new" }));
});

test("acquireSlot: release only frees its own slot, never one someone else now holds", async () => {
  const dir = tmp();
  const mine = await acquireSlot(dir, "claude", 1);
  fs.writeFileSync(mine.file, JSON.stringify({ pid: process.pid, token: "someone-else" }));
  mine.release();
  assert.equal(fs.existsSync(mine.file), true);
});

test("acquireSlot: with waitMs, a batch job queues for the slot instead of failing", async () => {
  const dir = tmp();
  const held = await acquireSlot(dir, "codex", 1);
  setTimeout(() => held.release(), 150);
  const started = Date.now();
  const next = await acquireSlot(dir, "codex", 1, { waitMs: 3000, pollMs: 50 });
  assert.ok(next, "got the slot once it was released");
  assert.ok(Date.now() - started >= 100, "and actually waited for it");
});
