import "./helpers/isolate-global-config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { openclawErrorLine, openclawStateBusy, serialOpenclawRun } from "../lib/openclaw-busy.mjs";
import { runtimeIssues } from "../lib/health.mjs";
import { withSandboxProvisioningRetry } from "../lib/openclaw-run.mjs";

// The real message, from a user's trace of a health run with no Gateway.
const BUSY = "OpenClaw state at ~/.openclaw/state/openclaw.sqlite is undergoing offline maintenance; retry when it finishes.";
const imported = { id: "openai:account-123", provider: "openai", type: "oauth", label: "(Codex import)", expiresAt: "2099-01-01T00:00:00.000Z" };
const codex = { codex: { kind: "subscription", provider: "openai", model: "gpt-6-astra", owner: "me@example.com" } };

test("openclawStateBusy matches OpenClaw's state-lock refusal and nothing else", () => {
  assert.equal(openclawStateBusy(BUSY), true);
  assert.equal(openclawStateBusy("StateDatabaseOfflineMaintenanceError: ..."), true);
  assert.equal(openclawStateBusy("No API key found for provider openai"), false);
  assert.equal(openclawStateBusy(undefined), false);
});

test("serialOpenclawRun: OpenClaw calls run one at a time, a busy refusal is retried, other commands pass through", async () => {
  let running = 0, most = 0;
  const seen = {};
  const run = async (cmd, args) => {
    if (cmd !== "openclaw") return { ok: true, stdout: "npm" };
    running++; most = Math.max(most, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    const key = args.join(" ");
    seen[key] = (seen[key] ?? 0) + 1;
    return key === "models auth list --json" && seen[key] < 3 ? { ok: false, stdout: "", stderr: `[openclaw] The CLI command failed.\n${BUSY}` } : { ok: true, stdout: key };
  };
  const sleeps = [];
  const serial = serialOpenclawRun(run, "openclaw", { sleep: async (ms) => { sleeps.push(ms); }, delayMs: 10 });
  const results = await Promise.all([serial("openclaw", ["models", "auth", "list", "--json"]), serial("openclaw", ["config", "get", "x"]), serial("npm", ["view"])]);
  assert.equal(most, 1, "never two OpenClaw processes at once");
  assert.deepEqual(results.map((r) => r.ok), [true, true, true]);
  assert.equal(seen["models auth list --json"], 3);
  assert.deepEqual(sleeps, [10, 20]);
  assert.equal(serialOpenclawRun(serial, "openclaw"), serial, "wrapping twice doesn't queue a call behind itself");
  // A real failure is returned at once; a busy one only until the retries run out.
  const fails = serialOpenclawRun(async () => ({ ok: false, stdout: "", stderr: "boom" }), "openclaw", { sleep: async () => {} });
  assert.equal((await fails("openclaw", ["x"])).stderr, "boom");
  let busyCalls = 0;
  const stuck = serialOpenclawRun(async () => { busyCalls++; return { ok: false, out: BUSY }; }, "openclaw", { retries: 2, sleep: async () => {} });
  assert.equal((await stuck("openclaw", ["x"])).ok, false);
  assert.equal(busyCalls, 3);
});

test("health: an unreadable auth list is reported as unreadable, never as a missing Codex import", async () => {
  const run = async (cmd, args) => args[0] === "models"
    ? { ok: false, stdout: "", stderr: `[openclaw] The CLI command failed.\n[openclaw] For help, run \`openclaw doctor\`.\n${BUSY}` }
    : { ok: false, stdout: "", stderr: "" };
  const noRetry = serialOpenclawRun(run, "openclaw", { retries: 0 });
  const issues = await runtimeIssues({ run: noRetry, openclawCmd: "openclaw", agents: codex });
  assert.deepEqual(issues.map((i) => i.id), ["openclaw-auth:unreadable"]);
  assert.equal(issues[0].severity, "warn");
  assert.match(issues[0].detail, /failed: OpenClaw state at .* is undergoing offline maintenance/);
  assert.match(issues[0].detail, /says nothing about whether they're set up/);
  // Once it can be read, the same setup is healthy.
  const ok = async (cmd, args) => args[0] === "models" ? { ok: true, stdout: JSON.stringify({ profiles: [imported] }) } : { ok: false, stdout: "" };
  assert.deepEqual(await runtimeIssues({ run: ok, openclawCmd: "openclaw", agents: codex }), []);
  // With no agent that needs a saved profile there's nothing to warn about.
  assert.deepEqual(await runtimeIssues({ run: noRetry, openclawCmd: "openclaw", agents: {} }), []);
});

test("openclawErrorLine: the JSON envelope's message, else the busy line, else the first line that isn't OpenClaw's boilerplate", () => {
  assert.equal(openclawErrorLine({ stdout: JSON.stringify({ ok: false, error: { message: "No credentials\nmore" } }) }), "No credentials");
  assert.equal(openclawErrorLine({ stderr: `[openclaw] The CLI command failed.\nsomething\n${BUSY}` }), BUSY);
  assert.equal(openclawErrorLine({ stderr: "[openclaw] The CLI command failed.\nreal reason" }), "real reason");
  assert.equal(openclawErrorLine({ stderr: "" }), null);
});

test("a job start refused by OpenClaw's state lock is retried; one that ran first and then hit it is not", async () => {
  let calls = 0;
  const retries = [];
  const result = await withSandboxProvisioningRetry(async () => {
    calls++;
    if (calls < 4) throw new Error(`openclaw exited 1\nSTDERR:\n${BUSY}`);
    return "ok";
  }, { onRetry: (attempt, error, info) => retries.push([attempt, info.reason]), delayMs: 1 });
  assert.equal(result, "ok");
  assert.deepEqual(retries, [[1, "state-busy"], [2, "state-busy"], [3, "state-busy"]]);
  // Busy retries don't use up the crun race's own two.
  calls = 0;
  await withSandboxProvisioningRetry(async () => {
    calls++;
    if (calls === 1) throw new Error(BUSY);
    if (calls < 4) throw new Error("crun: mount `devpts` to `dev/pts`: Invalid argument");
    return "ok";
  }, { delayMs: 1 });
  assert.equal(calls, 4);
  // A call that ran past startup may have done work: never rerun.
  const realNow = Date.now;
  let clock = 0;
  Date.now = () => clock;
  try {
    calls = 0;
    await assert.rejects(withSandboxProvisioningRetry(async () => { calls++; clock += 120000; throw new Error(BUSY); }, { delayMs: 1 }), /offline maintenance/);
    assert.equal(calls, 1);
  } finally { Date.now = realNow; }
});
