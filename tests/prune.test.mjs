import "./helpers/isolate-global-config.mjs";
// Tests for lib/prune.mjs and the health check's automatic prune.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { autoPruneAgeMs, pruneJobRuntime } from "../lib/prune.mjs";
import { checkAndRecordHealth } from "../lib/health.mjs";

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const HOUR = 3600000;

function stateWith(jobs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-prune-lib-")); dirs.push(root);
  for (const { id, finishedAgoH = null, leased = false } of jobs) {
    const d = path.join(root, "jobs", id);
    fs.mkdirSync(path.join(d, "runtime"), { recursive: true });
    fs.writeFileSync(path.join(d, "runtime", "blob"), "x".repeat(2048));
    fs.writeFileSync(path.join(d, "status.json"), JSON.stringify({ state: finishedAgoH === null ? "running" : "finished", updatedAt: new Date(Date.now() - 60000).toISOString() }));
    if (finishedAgoH !== null) fs.writeFileSync(path.join(d, "metadata.json"), JSON.stringify({ finishedAt: new Date(Date.now() - finishedAgoH * HOUR).toISOString() }));
    if (leased) { fs.mkdirSync(path.join(root, "leases"), { recursive: true }); fs.writeFileSync(path.join(root, "leases", `${id}.json`), "{}"); }
  }
  return root;
}
const has = (root, id) => fs.existsSync(path.join(root, "jobs", id, "runtime"));

test("pruneJobRuntime: finished jobs past the age go; recent, running and leased ones stay, and so does every record", () => {
  const root = stateWith([{ id: "old", finishedAgoH: 30 }, { id: "recent", finishedAgoH: 2 }, { id: "running" }, { id: "leased", finishedAgoH: 30, leased: true }]);
  const out = pruneJobRuntime({ stateRoot: root, olderThanMs: 24 * HOUR });
  assert.equal(out.pruned, 1);
  assert.equal(out.freedBytes, 2048);
  assert.deepEqual(["old", "recent", "running", "leased"].map((id) => has(root, id)), [false, true, true, true]);
  assert.ok(fs.existsSync(path.join(root, "jobs", "old", "metadata.json")));
  assert.equal(pruneJobRuntime({ stateRoot: path.join(root, "nope"), olderThanMs: 0 }).pruned, 0, "no jobs directory is fine");
});

test("autoPruneAgeMs: 24h by default, a number of hours, or off", () => {
  assert.equal(autoPruneAgeMs({}), 24 * HOUR);
  assert.equal(autoPruneAgeMs({ NOMARMY_AUTO_PRUNE_HOURS: "6" }), 6 * HOUR);
  for (const off of ["0", "off", "false"]) assert.equal(autoPruneAgeMs({ NOMARMY_AUTO_PRUNE_HOURS: off }), null, off);
  assert.equal(autoPruneAgeMs({ NOMARMY_AUTO_PRUNE_HOURS: "junk" }), 24 * HOUR);
});

test("checkAndRecordHealth: prunes on its own and says so as an info line, never a notification", async () => {
  const root = stateWith([{ id: "old", finishedAgoH: 30 }, { id: "recent", finishedAgoH: 2 }]);
  const saved = process.env.NOMARMY_OPENCLAW_CMD;
  process.env.NOMARMY_OPENCLAW_CMD = "/nonexistent/openclaw";
  try {
    const { result, toNotify } = await checkAndRecordHealth({ projectDir: root, stateRoot: root, configDir: process.env.NOMARMY_CONFIG_DIR });
    assert.equal(has(root, "old"), false);
    assert.equal(has(root, "recent"), true);
    const line = result.issues.find((i) => i.id.startsWith("auto-prune:"));
    assert.equal(line.severity, "info");
    assert.match(line.title, /runtime data of 1 finished job older than 24h/);
    assert.equal(toNotify.some((i) => i.id.startsWith("auto-prune:")), false);
  } finally {
    if (saved === undefined) delete process.env.NOMARMY_OPENCLAW_CMD; else process.env.NOMARMY_OPENCLAW_CMD = saved;
  }
});

test("pruneJobRuntime: a recent finished job keeps its transcript but loses OpenClaw's scratch files; a running one keeps both", () => {
  const root = stateWith([{ id: "recent", finishedAgoH: 2 }, { id: "running" }]);
  for (const id of ["recent", "running"]) {
    const d = path.join(root, "jobs", id, "runtime", "state");
    fs.mkdirSync(path.join(d, "tmp", "plugin-captures"), { recursive: true });
    fs.writeFileSync(path.join(d, "tmp", "plugin-captures", "codex"), "x".repeat(4096));
    fs.mkdirSync(path.join(d, "agents"), { recursive: true });
    fs.writeFileSync(path.join(d, "agents", "openclaw-agent.sqlite"), "db");
  }
  const out = pruneJobRuntime({ stateRoot: root, olderThanMs: 24 * HOUR });
  assert.deepEqual({ pruned: out.pruned, scratchCleared: out.scratchCleared, freedBytes: out.freedBytes }, { pruned: 0, scratchCleared: 1, freedBytes: 4096 });
  assert.equal(fs.existsSync(path.join(root, "jobs", "recent", "runtime", "state", "tmp")), false);
  assert.equal(fs.existsSync(path.join(root, "jobs", "recent", "runtime", "state", "agents", "openclaw-agent.sqlite")), true, "the transcript stays");
  assert.equal(fs.existsSync(path.join(root, "jobs", "running", "runtime", "state", "tmp", "plugin-captures", "codex")), true, "never a running job");
});
