import "./helpers/isolate-global-config.mjs";
// Tests for lib/health.mjs. Run: node --test tests/health.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { armyIssues, leftoverIssues, unknownModelIssues, loginExpiryIssues, recordHealth, runHealthChecks, versionIssues, recentModelRefusal, recordProbeSuccess } from "../lib/health.mjs";

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

test("armyIssues warns only in hosted mode when roles use the built-in local agent", () => {
  const summary = { general: { problem: null }, roles: { pm: { agent: "local", problem: null }, reviewer: { agent: "codex", problem: null } } };
  assert.deepEqual(armyIssues(summary, "local"), []);
  assert.deepEqual(armyIssues(summary, "remote"), []);
  assert.deepEqual(armyIssues(summary, "bedrock"), []);
  assert.deepEqual(armyIssues(summary, "hosted"), [{
    id: "army:hosted-local:pm",
    severity: "warn",
    title: "Role pm uses the local agent in hosted mode",
    detail: "Hosted installs have no local model, so jobs for this role will be refused.",
    fix: "nomarmy army assign pm <agent> [model] or nomarmy army init --agent <name>",
    short: "pm uses local",
  }]);
});

test("runHealthChecks accepts hosted mode as an injected parameter for army checks", async () => {
  const run = async () => ({ ok: false, stdout: "" });
  const armySummary = { general: { problem: null }, roles: { "jr-dev": { agent: "local", problem: null } } };
  const hosted = await runHealthChecks({ mode: "hosted", run, armySummary });
  assert.deepEqual(hosted.issues.map((issue) => issue.id), ["army:hosted-local:jr-dev"]);
  const local = await runHealthChecks({ mode: "local", run, armySummary });
  assert.deepEqual(local.issues, []);
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

test("unknownModelIssues: a model that failed \"Unknown model\" on a real job today -- the Muse case", () => {
  const now = Date.parse("2026-09-24T15:00:00Z");
  const records = [
    { finishedAt: "2026-09-24T14:19:16Z", workerError: "Error: openclaw exited 1\nSTDERR:\n[diagnostic] lane task error: error=\"Unknown model: meta/muse-spark-1.3. Run ...\"" },
    { finishedAt: "2026-09-22T10:00:00Z", workerError: "Unknown model: openai/gpt-6-sol" },
    { finishedAt: "2026-09-24T14:50:00Z", workerError: null },
  ];
  const issues = unknownModelIssues(records, { now });
  assert.equal(issues.length, 1, "yesterday's is stale; a clean job is nothing");
  assert.equal(issues[0].id, "unknown-model:meta/muse-spark-1.3");
  assert.equal(issues[0].short, "muse-spark-1.3 not running");
});

test("unknownModelIssues: the Codex ChatGPT-plan refusal (model_not_found), old raw record and new tagged line alike", () => {
  const now = Date.parse("2026-09-24T15:00:00Z");
  const raw = "Error: openclaw exited 1\nSTDERR:\n\u001b[33m[agent/embedded]\u001b[39m embedded run failover decision: runId=c3 stage=prompt decision=surface_error reason=model_not_found attempt=1 from=openai/gpt-6-sol profile=sha256:10 rawError={\"type\":\"error\",\"status\":400,\"error\":{\"message\":\"The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account.\"}}";
  const issues = unknownModelIssues([
    { finishedAt: "2026-09-24T14:17:38Z", workerError: raw },
    { finishedAt: "2026-09-24T14:30:00Z", workerError: "model_not_found: openai/gpt-6-sol: The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account. It may..." },
  ], { now });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].id, "unknown-model:openai/gpt-6-sol");
  assert.match(issues[0].title, /failed as an unknown or unsupported model on 2 jobs today/);
});

test("unknownModelIssues: a failure is cleared by a later successful job or test call, or when no role uses the model", () => {
  const now = Date.parse("2026-09-24T18:00:00Z");
  const fail = { finishedAt: "2026-09-24T14:19:16Z", workerError: "Unknown model: meta/muse-spark-1.3." };
  assert.equal(unknownModelIssues([fail], { now }).length, 1);
  assert.equal(unknownModelIssues([fail, { finishedAt: "2026-09-24T15:00:00Z", worker: { provider: "meta", model: "muse-spark-1.3" } }], { now }).length, 0, "a later job ran on it");
  assert.equal(unknownModelIssues([fail, { finishedAt: "2026-09-24T13:00:00Z", worker: { provider: "meta", model: "muse-spark-1.3" } }], { now }).length, 1, "an earlier success doesn't clear a later failure");
  assert.equal(unknownModelIssues([fail], { now, probedOk: { "meta/muse-spark-1.3": Date.parse("2026-09-24T17:30:00Z") } }).length, 0, "army assign's test call passed since");
  assert.equal(unknownModelIssues([fail], { now, inUse: new Set(["xai/grok-4.7"]) }).length, 0, "no role uses it any more");
});

test("recentModelRefusal: a model refused on a job today is refused at admission until something works on it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-refusal-"));
  try {
    const job = (id, record) => { fs.mkdirSync(path.join(root, "jobs", id), { recursive: true }); fs.writeFileSync(path.join(root, "jobs", id, "metadata.json"), JSON.stringify(record)); };
    const now = Date.now();
    job("a", { finishedAt: new Date(now - 3600000).toISOString(), workerError: "model_not_found: openai/gpt-6-sol: The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account." });
    assert.equal(recentModelRefusal(root, "openai/gpt-6-sol", { now }).id, "unknown-model:openai/gpt-6-sol");
    assert.equal(recentModelRefusal(root, "openai/gpt-6-astra", { now }), null);
    recordProbeSuccess(root, "openai/gpt-6-sol", { now });
    assert.equal(recentModelRefusal(root, "openai/gpt-6-sol", { now }), null, "a passing army assign test clears it");
    assert.equal(recentModelRefusal(path.join(root, "none"), "x/y", { now }), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
