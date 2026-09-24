import "./helpers/isolate-global-config.mjs";
// Tests for lib/health.mjs. Run: node --test tests/health.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { armyIssues, leftoverIssues, loginExpiryIssues, recordHealth, runHealthChecks, versionIssues } from "../lib/health.mjs";

const dirs = [];
function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-health-")); dirs.push(d); return d; }
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// The real `openclaw models auth list --json` shape, ids shortened.
const AUTH = { profiles: [
  { id: "meta:subscription", provider: "meta", type: "api_key" },
  { id: "openai:account-1", provider: "openai", type: "oauth", expiresAt: "2026-10-03T21:10:37.000Z" },
] };

test("loginExpiryIssues: quiet 9 days out, a warning inside 7, an error once expired", () => {
  assert.deepEqual(loginExpiryIssues(AUTH, { now: Date.parse("2026-09-24T12:00:00Z") }), []);
  const soon = loginExpiryIssues(AUTH, { now: Date.parse("2026-09-28T12:00:00Z") });
  assert.equal(soon[0].severity, "warn");
  assert.match(soon[0].title, /Codex \(ChatGPT plan\) login expires in 5 days/);
  assert.equal(soon[0].short, "openai login 5d");
  assert.match(soon[0].fix, /nomarmy agents add subscription codex/);
  assert.equal(loginExpiryIssues(AUTH, { now: Date.parse("2026-10-04T00:00:00Z") })[0].severity, "error");
});

test("versionIssues: OpenClaw behind npm, and a plugin behind OpenClaw -- the real 2026.9.5/2026.9.6 cases", () => {
  const behind = versionIssues({ installed: "OpenClaw 2026.9.5 (ec9c1a1)", latest: "2026.9.6\n" });
  assert.equal(behind[0].id, "openclaw-update:2026.9.6");
  assert.match(behind[0].fix, /npm update -g openclaw && openclaw doctor --fix/);
  assert.deepEqual(versionIssues({ installed: "OpenClaw 2026.9.6", latest: "2026.9.6" }), []);
  const skew = versionIssues({ installed: "OpenClaw 2026.9.6", latest: "2026.9.6", plugins: [{ id: "codex", version: "2026.9.5" }] });
  assert.equal(skew[0].id, "plugin-skew:codex:2026.9.5");
  assert.equal(skew[0].severity, "info");
  assert.deepEqual(versionIssues({ installed: "OpenClaw 2026.9.6", latest: null }), [], "offline: no guess");
});

test("armyIssues and leftoverIssues: unusable roles and piled-up storage", () => {
  const army = armyIssues({ general: { problem: null }, roles: { pm: { problem: 'agent "ghost" is not defined in your agents.yml' }, "sr-dev": { problem: null } } });
  assert.deepEqual(army.map((i) => i.title), ["Role pm can't be dispatched"]);
  const left = leftoverIssues({ retainedWorktrees: 42, jobsBytes: 2.4 * 1024 ** 3, staleRunning: 1 });
  assert.deepEqual(left.map((i) => i.severity), ["info", "warn", "info"]);
  assert.match(left[1].title, /Job storage is 2\.4 GB/);
  assert.deepEqual(leftoverIssues({ retainedWorktrees: 3, jobsBytes: 100e6, staleRunning: 0 }), []);
});

test("runHealthChecks: gathers every check with bounded commands, errors first", async () => {
  const jobsRoot = tmp();
  fs.mkdirSync(path.join(jobsRoot, "old-job"));
  fs.writeFileSync(path.join(jobsRoot, "old-job", "status.json"), JSON.stringify({ state: "running", serverPid: 99999999 }));
  const run = async (cmd, args) => {
    if (cmd === "npm") return { ok: true, stdout: "2026.9.6\n" };
    if (args[0] === "--version") return { ok: true, stdout: "OpenClaw 2026.9.6 (eb377ac)" };
    if (args[0] === "plugins") return { ok: true, stdout: "Codex\nStatus: enabled\nVersion: 2026.9.5\n" };
    if (args[0] === "models") return { ok: true, stdout: `[openclaw] note\n${JSON.stringify(AUTH)}` };
    if (cmd === "du") return { ok: true, stdout: "100\t/x" };
    return { ok: false, stdout: "" };
  };
  const { issues } = await runHealthChecks({ now: Date.parse("2026-10-04T00:00:00Z"), run, agentsError: "agents.yml is writable by other accounts", jobsRoot, pidAlive: () => false });
  assert.deepEqual(issues.map((i) => i.severity), ["error", "error", "info", "info"]);
  assert.ok(issues.some((i) => i.id.startsWith("login-expired:")));
  assert.ok(issues.some((i) => i.id.startsWith("config:agents:")));
  assert.ok(issues.some((i) => i.id === "plugin-skew:codex:2026.9.5"));
  assert.ok(issues.some((i) => i.id === "leftovers:stale:1"));
});

test("recordHealth: notifies a warning once a day across every session's server, never an info", () => {
  const file = path.join(tmp(), "health.json");
  const issues = [{ id: "login-expiring:openai", severity: "warn" }, { id: "plugin-skew:codex", severity: "info" }];
  const t0 = Date.parse("2026-09-28T12:00:00Z");
  assert.deepEqual(recordHealth(file, { checkedAt: new Date(t0).toISOString(), issues }, { now: t0 }).map((i) => i.id), ["login-expiring:openai"]);
  assert.deepEqual(recordHealth(file, { checkedAt: "x", issues }, { now: t0 + 3600000 }), [], "a second session, an hour later: already notified");
  assert.equal(recordHealth(file, { checkedAt: "x", issues }, { now: t0 + 25 * 3600000 }).length, 1, "reminded after a day");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).issues.length, 2, "every issue is saved for the status line and `nomarmy health`");
});
