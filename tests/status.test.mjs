import "./helpers/isolate-global-config.mjs";
// Tests for the status surfaces: desktop notifications (lib/notify.mjs),
// Claude Code's status line (lib/statusline.mjs) and its install.
// Run: node --test tests/status.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { appleScriptString, notificationCommand, notify } from "../lib/notify.mjs";
import { statusLineText } from "../lib/statusline.mjs";
import { installClaudeStatusLine } from "../lib/connect.mjs";
import { writeLease } from "../lib/slots.mjs";
import { createRun, recordRunJob, runAdmissionProblems, loadRun } from "../lib/runs.mjs";

const dirs = [];
function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-status-")); dirs.push(d); return d; }
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

test("notificationCommand: osascript on macOS, notify-send on Linux, nothing elsewhere or when disabled", () => {
  const [cmd, args] = notificationCommand("nomArmy: sr-dev done", 'job "x" \\ ok', { platform: "darwin", env: {} });
  assert.equal(cmd, "osascript");
  assert.equal(args[1], 'display notification "job \\"x\\" \\\\ ok" with title "nomArmy: sr-dev done"', "quotes and backslashes can't break out of the AppleScript string");
  assert.deepEqual(notificationCommand("t", "m", { platform: "linux", env: {} }), ["notify-send", ["--app-name=nomArmy", "t", "m"]]);
  assert.equal(notificationCommand("t", "m", { platform: "win32", env: {} }), null);
  assert.equal(notificationCommand("t", "m", { platform: "darwin", env: { NOMARMY_NOTIFY: "0" } }), null);
  assert.equal(appleScriptString("a\nb"), '"a b"');
});

test("notify: fire-and-forget, and a spawn failure never throws", () => {
  const calls = [];
  assert.equal(notify("t", "m", { platform: "darwin", env: {}, run: (c, a) => { calls.push(c); return { on() {}, unref() {} }; } }), true);
  assert.deepEqual(calls, ["osascript"]);
  assert.equal(notify("t", "m", { platform: "darwin", env: {}, run: () => { throw new Error("no osascript"); } }), false);
});

test("statusLineText: the session, what's running machine-wide, and this repo's open run", () => {
  const root = tmp();
  writeLease(path.join(root, "leases"), "sr-dev-x", { lane: "remote", agent: "codex", model: "gpt-6-astra", role: "sr-dev", runId: "run-r-1" });
  fs.mkdirSync(path.join(root, "jobs", "sr-dev-x"), { recursive: true });
  const now = Date.parse("2026-09-24T14:20:00Z");
  fs.writeFileSync(path.join(root, "jobs", "sr-dev-x", "status.json"), JSON.stringify({ startedAt: "2026-09-24T14:11:00Z", phase: "worker", filesChangedLive: 10 }));
  const run = createRun(path.join(root, "runs"), { name: "safe-rescan", repo: "/r/senti", limits: { max_jobs: 14, max_api_usd: 10, max_hours: 6, warn_at: 0.8 } });
  recordRunJob(path.join(root, "runs"), run.id, { jobId: "a", agent: "grok", kind: "api", costUsd: 0.41 });
  // the lease names the run it belongs to
  fs.writeFileSync(path.join(root, "leases", "sr-dev-x.json"), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(root, "leases", "sr-dev-x.json"), "utf8")), runId: run.id }));
  const line = statusLineText({ session: { model: { display_name: "Opus 5.5" }, workspace: { current_dir: "/r/senti" } }, stateRoot: root, now });
  assert.equal(line, "Opus 5.5 · senti │ 🍪 sr-dev codex/gpt-6-astra 9m 10f │ run 2/14 $0.41");
  assert.equal(statusLineText({ session: {}, stateRoot: tmp() }).endsWith("🍪 idle"), true);
});

test("installClaudeStatusLine: installs when none is set, refreshes its own, never replaces the operator's", () => {
  const settingsPath = path.join(tmp(), "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ model: "opus", permissions: { allow: ["Bash(ls)"] } }));
  assert.equal(installClaudeStatusLine({ installDir: "/opt/nomarmy", settingsPath }), "installed");
  const s = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.equal(s.statusLine.command, 'node "/opt/nomarmy/lib/statusline.mjs"');
  assert.deepEqual(s.permissions, { allow: ["Bash(ls)"] }, "every other setting is kept");
  assert.equal(installClaudeStatusLine({ installDir: "/opt/nomarmy", settingsPath }), "unchanged");
  assert.equal(installClaudeStatusLine({ installDir: "/new/place", settingsPath }), "updated");
  fs.writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: "command", command: "~/bin/my-line.sh" } }));
  assert.equal(installClaudeStatusLine({ installDir: "/opt/nomarmy", settingsPath }), "kept-yours");
  assert.equal(JSON.parse(fs.readFileSync(settingsPath, "utf8")).statusLine.command, "~/bin/my-line.sh");
  fs.writeFileSync(settingsPath, "{ not json");
  assert.equal(installClaudeStatusLine({ installDir: "/opt/nomarmy", settingsPath }), "skipped", "an unreadable settings file is never rewritten");
});

test("runAdmissionProblems: jobs still running count toward the run's job limit", () => {
  const dir = tmp();
  const { id } = createRun(dir, { name: "f", repo: "/r", limits: { max_jobs: 3, max_api_usd: 10, max_hours: 6, warn_at: 0.8 } });
  recordRunJob(dir, id, { jobId: "a", agent: "local", kind: "local" });
  assert.deepEqual(runAdmissionProblems(loadRun(dir, id), { running: 1 }), []);
  assert.match(runAdmissionProblems(loadRun(dir, id), { running: 2 })[0], /used all 3 of its jobs \(2 still running\)/);
});

test("statusLineText: stays short -- suffixes dropped, models only for one job, jobs collapse to +N before the run is cut", async () => {
  const { shortJobName } = await import("../lib/statusline.mjs");
  assert.equal(shortJobName("scout-20260924-143127-49f447"), "scout");
  assert.equal(shortJobName("sr-dev-action-write-prune"), "sr-dev-action-wri…");
  const root = tmp();
  const now = Date.parse("2026-09-24T14:32:00Z");
  for (const [id, agent] of [["scout-20260924-143127-49f447", "claude"], ["sr-dev-action-write-prune", "codex"], ["jr-dev-pending-joins", "codex"], ["security-review", "grok"]]) {
    writeLease(path.join(root, "leases"), id, { lane: "remote", agent, model: "m" });
    fs.mkdirSync(path.join(root, "jobs", id), { recursive: true });
    fs.writeFileSync(path.join(root, "jobs", id, "status.json"), JSON.stringify({ startedAt: "2026-09-24T14:31:40Z", workerId: id.replace(/-\d{8}-\d{6}-[0-9a-f]+$/, "") }));
  }
  const run = createRun(path.join(root, "runs"), { name: "safe-rescan-removal", repo: "/r/rayson-senti", limits: { max_jobs: 14, max_api_usd: 10, max_hours: 6, warn_at: 0.8 } });
  recordRunJob(path.join(root, "runs"), run.id, { jobId: "a", agent: "grok", kind: "api", costUsd: 2.16 });
  const line = statusLineText({ session: { model: { display_name: "Opus 5.5" }, workspace: { current_dir: "/r/rayson-senti" } }, stateRoot: root, now, maxLength: 90 });
  assert.ok([...line].length <= 90, `${[...line].length}: ${line}`);
  assert.match(line, /│ run 1\/14 \$2\.16$/, "the run summary survives");
  assert.match(line, /🍪 4: .*\+\d/, "jobs that don't fit collapse to +N");
  assert.doesNotMatch(line, /\/m\b/, "no models when several jobs run");
});
