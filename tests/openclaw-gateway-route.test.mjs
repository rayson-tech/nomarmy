import "./helpers/isolate-global-config.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { gatewayAgentId, gatewayAgentSettings, gatewayResultAsExecResult, runOnGateway, GATEWAY_AGENT_PREFIX, gatewayFailureLine, gatewaySignInMethod, openclawSignInCommand, parseGatewayStatus, leftoverGatewayAgents } from "../lib/openclaw-gateway-route.mjs";
import { loginExpiryIssues } from "../lib/health.mjs";
import { gatewayRouteIssues } from "../lib/health.mjs";
import { agentsFileSchema } from "../lib/agents.mjs";
import { routeForProvider } from "../lib/model-probe.mjs";

const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "gw-route-")); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

// A fake OpenClaw for runOnGateway: an in-memory config and agent list, a
// call log, and switches for the ways a step can fail.
function fakeOpenclaw({ skipBootstrap = true, failSet = false, failWorkspaceSwap = false, turn = null } = {}) {
  const calls = [], config = {}, agents = new Map(), trashed = [];
  if (skipBootstrap !== undefined) config["agents.defaults.skipBootstrap"] = skipBootstrap;
  const fail = (message) => Promise.reject(Object.assign(new Error(message), { stdout: "", stderr: message }));
  const run = async (cmd, args) => {
    calls.push(args.join(" "));
    const [a, b] = args;
    if (a === "config" && b === "get") return args[2] in config ? { stdout: JSON.stringify(config[args[2]]), stderr: "" } : fail("Config path is valid but unset");
    if (a === "agents" && b === "add") { agents.set(args[2], { workspace: args[args.indexOf("--workspace") + 1] }); config[`agents.entries.${args[2]}.workspace`] = args[args.indexOf("--workspace") + 1]; return { stdout: "{}", stderr: "" }; }
    if (a === "config" && b === "set" && args[2] === "--batch-json") { if (failSet) return fail("invalid path"); for (const op of JSON.parse(args[3])) config[op.path] = op.value; return { stdout: "", stderr: "" }; }
    if (a === "config" && b === "set") {
      const key = args[2], expected = args[args.indexOf("--expect-current-json") + 1];
      if (failWorkspaceSwap || JSON.stringify(config[key]) !== expected) return fail("expectation failed");
      config[key] = JSON.parse(args[3]); return { stdout: "", stderr: "" };
    }
    if (a === "agent") return turn ? turn(args) : { stdout: JSON.stringify({ status: "ok", result: { payloads: [{ text: "STATUS: done" }], meta: { finalAssistantVisibleText: "STATUS: done", agentMeta: { provider: "xai", model: "grok-4.7", usage: { input: 10, output: 5, cost: { total: 0.03 } } } } } }), stderr: "" };
    if (a === "sessions" && b === "delete") return { stdout: "{}", stderr: "" };
    if (a === "agents" && b === "list") return { stdout: JSON.stringify([{ id: "main" }, ...[...agents].map(([id, v]) => ({ id, workspace: config[`agents.entries.${id}.workspace`] ?? v.workspace }))]), stderr: "" };
    if (a === "agents" && b === "delete") { trashed.push(config[`agents.entries.${args[2]}.workspace`]); agents.delete(args[2]); return { stdout: "{}", stderr: "" }; }
    return fail(`unexpected: ${args.join(" ")}`);
  };
  const leave = (id, workspace) => { agents.set(id, { workspace }); config[`agents.entries.${id}.workspace`] = workspace; };
  return { run, calls, config, agents, trashed, leave };
}

function job(t, oc, extra = {}) {
  const dir = tmp(t), cwd = path.join(dir, "worktree"), scratch = path.join(dir, "runtime");
  fs.mkdirSync(cwd); fs.mkdirSync(scratch);
  const promptFile = path.join(dir, "brief.txt"); fs.writeFileSync(promptFile, "do it\n");
  const agentId = gatewayAgentId("worker-20261109-000000-abc123");
  return { cwd, agentId, go: () => runOnGateway({ run: oc.run, agentId, cwd, model: "xai/grok-4.7", promptFile, thinking: "high", timeoutSeconds: 600,
    settings: gatewayAgentSettings(agentId, { agents: { defaults: { sandbox: { docker: { image: "nomarmy-go:1", env: { NPM_CONFIG_CACHE: "/x" } } } } }, tools: { exec: { pathPrepend: ["/usr/local/go/bin"] } } }),
    scratchDir: scratch, ...extra }) };
}

test("gatewayAgentId: a valid OpenClaw id under nomArmy's prefix", () => {
  assert.equal(gatewayAgentId("worker-20261109-185109-24C971"), "nomarmy-job-worker-20261109-185109-24c971");
  assert.equal(gatewayAgentId("scout_x.y"), "nomarmy-job-scout-x-y");
  assert.ok(gatewayAgentId("a".repeat(200)).length <= 64);
  assert.throws(() => gatewayAgentId(""));
});

test("gatewayAgentSettings: the job's image, environment, PATH and privacy on the agent's own entry", () => {
  const id = "nomarmy-job-x";
  assert.deepEqual(gatewayAgentSettings(id, { agents: { defaults: { sandbox: { docker: { image: "img", env: { A: "1" } } } } }, tools: { exec: { pathPrepend: ["/p"] }, fs: { workspaceOnly: false } } }), [
    { path: `agents.entries.${id}.memory.search.enabled`, value: false },
    { path: `agents.entries.${id}.sandbox.docker.image`, value: "img" },
    { path: `agents.entries.${id}.sandbox.docker.env`, value: { A: "1" } },
    { path: `agents.entries.${id}.tools.exec.pathPrepend`, value: ["/p"] },
    { path: `agents.entries.${id}.tools.fs`, value: { workspaceOnly: false } },
  ]);
  assert.deepEqual(gatewayAgentSettings(id, null), [{ path: `agents.entries.${id}.memory.search.enabled`, value: false }]);
});

test("gatewayResultAsExecResult: a Gateway turn in agent exec's shape, without OpenClaw's per-token price", () => {
  const r = gatewayResultAsExecResult({ status: "ok", result: { payloads: [{ text: "x" }], meta: { finalAssistantVisibleText: "STATUS: done", stopReason: "stop", agentMeta: { provider: "xai", model: "grok-4.7", sessionId: "s", usage: { input: 1, cost: { total: 9 } } } } } });
  assert.equal(r.ok, true); assert.equal(r.final, "STATUS: done"); assert.equal(r.provider, "xai"); assert.equal(r.model, "grok-4.7");
  assert.deepEqual(r.usage, { input: 1 }); assert.equal(r.costUsd, undefined); assert.equal(r.route, "gateway");
  assert.equal(gatewayResultAsExecResult({ status: "ok", result: { meta: { aborted: true } } }).ok, false);
});

test("runOnGateway: adds the agent on the worktree, sets its sandbox, runs the turn, then moves the workspace off the worktree before deleting", async (t) => {
  const oc = fakeOpenclaw();
  const j = job(t, oc);
  const result = await j.go();
  assert.match(result.stdout, /STATUS: done/);
  const order = oc.calls.map((c) => c.split(" ").slice(0, 2).join(" "));
  assert.deepEqual(order, ["config get", "agents add", "config set", "agent --agent", "sessions delete", "config set", "config get", "agents delete"]);
  assert.equal(oc.config[`agents.entries.${j.agentId}.sandbox.docker.image`], "nomarmy-go:1");
  assert.deepEqual(oc.config[`agents.entries.${j.agentId}.tools.exec.pathPrepend`], ["/usr/local/go/bin"]);
  assert.equal(oc.trashed.length, 1);
  assert.notEqual(oc.trashed[0], j.cwd, "the worktree is never the workspace OpenClaw trashes");
  assert.equal(fs.existsSync(j.cwd), true);
});

test("runOnGateway: never deletes the agent while its workspace is still the worktree", async (t) => {
  const oc = fakeOpenclaw({ failWorkspaceSwap: true });
  const logged = [];
  const j = job(t, oc, { log: (l) => logged.push(l) });
  await j.go();
  assert.ok(!oc.calls.some((c) => c.startsWith("agents delete")));
  assert.equal(oc.trashed.length, 0);
  assert.match(logged.join("\n"), /NOT removed .*nomarmy health reports it/);
});

test("runOnGateway: refuses before adding anything when OpenClaw would seed starter files (skipBootstrap unset)", async (t) => {
  const oc = fakeOpenclaw({ skipBootstrap: undefined });
  delete oc.config["agents.defaults.skipBootstrap"];
  const j = job(t, oc);
  await assert.rejects(j.go(), /skipBootstrap/);
  assert.ok(!oc.calls.some((c) => c.startsWith("agents add")));
});

test("runOnGateway: a failed sandbox setting stops the job and still removes the agent safely", async (t) => {
  const oc = fakeOpenclaw({ failSet: true });
  const j = job(t, oc);
  await assert.rejects(j.go(), /Setting the job's sandbox/);
  assert.ok(!oc.calls.some((c) => c.startsWith("agent --agent")), "no turn on an agent without the job's sandbox");
  assert.equal(oc.trashed.length, 1); assert.notEqual(oc.trashed[0], j.cwd);
});

test("runOnGateway: a failed turn still cleans up, and the error carries OpenClaw's output", async (t) => {
  const oc = fakeOpenclaw({ turn: () => Promise.reject(Object.assign(new Error("exit 1"), { stdout: "{}", stderr: "boom" })) });
  const j = job(t, oc);
  await assert.rejects(j.go(), (e) => e.stderr === "boom");
  assert.ok(oc.calls.some((c) => c.startsWith("agents delete")));
  assert.notEqual(oc.trashed[0], j.cwd);
});

test("route: gateway is a subscription setting, refused where it doesn't apply", () => {
  const ok = agentsFileSchema.safeParse({ agents: { grok: { kind: "subscription", provider: "xai", owner: "a@b.co", route: "gateway" } } });
  assert.equal(ok.success, true);
  for (const provider of ["claude-cli", "muse-cli", "openai"]) {
    const r = agentsFileSchema.safeParse({ agents: { x: { kind: "subscription", provider, owner: "a@b.co", route: "gateway" } } });
    assert.equal(r.success, false, provider);
  }
  assert.equal(agentsFileSchema.safeParse({ agents: { x: { kind: "subscription", provider: "xai", owner: "a@b.co", route: "bus" } } }).success, false);
  assert.equal(routeForProvider({ grok: { kind: "subscription", provider: "xai", route: "gateway" } }, "xai"), "gateway");
  assert.equal(routeForProvider({ grok: { kind: "subscription", provider: "xai" } }, "xai"), null);
});

test("health: a Gateway-route agent needs skipBootstrap, and leftover temporary agents are reported unless their job is running", async () => {
  const agents = { grok: { kind: "subscription", provider: "xai", owner: "a@b.co", route: "gateway" } };
  const listing = [{ id: "main" }, { id: `${GATEWAY_AGENT_PREFIX}worker-20261109-000000-aaaaaa`, workspace: "/w/a" }, { id: `${GATEWAY_AGENT_PREFIX}worker-20261109-000000-bbbbbb`, workspace: "/w/b" }];
  const run = (skip) => async (cmd, args) => args[0] === "config" ? (skip ? { ok: true, stdout: "true" } : { ok: false, stdout: "" }) : { ok: true, stdout: JSON.stringify(listing) };
  const issues = await gatewayRouteIssues({ run: run(false), openclawCmd: "openclaw", agents, runningJobIds: ["worker-20261109-000000-bbbbbb"] });
  assert.deepEqual(issues.map((i) => i.id.split(":").slice(0, 2).join(":")), ["gateway-route:bootstrap", "gateway-route:leftover"]);
  assert.match(issues[1].title, /aaaaaa/); assert.doesNotMatch(issues[1].title, /bbbbbb/);
  assert.match(issues[1].fix, /workspace .* && openclaw agents delete/);
  assert.deepEqual(await gatewayRouteIssues({ run: run(true), openclawCmd: "openclaw", agents: { grok: { ...agents.grok, route: undefined } } }), []);
});

test("runOnGateway: first removes agents earlier jobs left (safely), keeping a running job's", async (t) => {
  const oc = fakeOpenclaw();
  const dir = tmp(t);
  const goneTree = path.join(dir, "gone-worktree"), liveTree = path.join(dir, "live-worktree");
  fs.mkdirSync(goneTree); fs.mkdirSync(liveTree);
  oc.leave(gatewayAgentId("scout-20261117-051732-03d49c"), goneTree);
  oc.leave(gatewayAgentId("worker-20261118-000000-aaaaaa"), liveTree);
  const logged = [];
  const j = job(t, oc, { runningJobIds: ["worker-20261118-000000-aaaaaa"], log: (l) => logged.push(l) });
  await j.go();
  assert.equal(oc.agents.has(gatewayAgentId("scout-20261117-051732-03d49c")), false);
  assert.equal(oc.agents.has(gatewayAgentId("worker-20261118-000000-aaaaaa")), true, "a running job's agent stays");
  assert.ok(!oc.trashed.includes(goneTree) && !oc.trashed.includes(j.cwd), "no worktree trashed");
  assert.match(logged.join("\n"), /Removed leftover Gateway agent nomarmy-job-scout-20261117-051732-03d49c/);
});

test("runOnGateway: a turn that fails on a lost sign-in says so, not OpenClaw's 'No API key found' on the temporary agent", async (t) => {
  const stdout = JSON.stringify({ ok: false, origin: "gateway", error: { type: "cli_error", message: 'No API key found for provider "xai". Auth store: /x (agentDir: /y/nomarmy-job-z/agent). | missing-provider-auth' } });
  const oc = fakeOpenclaw({ turn: () => Promise.reject(Object.assign(new Error("openclaw exited 1"), { stdout, stderr: "[openclaw] The CLI command failed." })) });
  const j = job(t, oc);
  await assert.rejects(j.go(), (e) => /^OpenClaw has no usable xai sign-in/.test(e.stack) && /--method oauth --agent main/.test(e.message));
});

test("gatewayFailureLine: lost sign-in, a dropped Gateway, a stopped one; null otherwise", () => {
  assert.match(gatewayFailureLine(String.raw`"message": "No API key found for provider \"xai\". x"`), /no usable xai sign-in.*openclaw models auth login --provider xai --method oauth --agent main/);
  assert.match(gatewayFailureLine("gateway closed (1006 abnormal closure (no close frame))"), /closed the connection/);
  assert.match(gatewayFailureLine("connect ECONNREFUSED 127.0.0.1:18789"), /isn't running/);
  assert.equal(gatewayFailureLine("STATUS: done"), null);
});

test("sign-in method: xAI's Gateway-compatible oauth, also for the manual-only device-code alias; others as asked", () => {
  assert.equal(gatewaySignInMethod("xai"), "oauth");
  assert.equal(gatewaySignInMethod("xai", "device-code"), "oauth");
  assert.equal(gatewaySignInMethod("openrouter"), null);
  assert.equal(gatewaySignInMethod("openrouter", "oauth"), "oauth");
  assert.equal(openclawSignInCommand("xai"), "openclaw models auth login --provider xai --method oauth --agent main");
});

test("parseGatewayStatus: installed and running from `openclaw gateway status --json`", () => {
  assert.deepEqual(parseGatewayStatus(`warn line\n${JSON.stringify({ service: { loaded: true, command: {}, runtime: { status: "running" } }, port: { status: "busy" } })}`), { installed: true, running: true });
  assert.deepEqual(parseGatewayStatus(JSON.stringify({ service: { loaded: true, command: {}, runtime: { status: "stopped" } }, port: { status: "free" } })), { installed: true, running: false });
  assert.deepEqual(parseGatewayStatus(JSON.stringify({ service: { loaded: false, command: null }, port: { status: "busy" } })), { installed: false, running: true }, "started by hand");
  assert.equal(parseGatewayStatus("not json"), null);
  assert.equal(parseGatewayStatus("[]"), null);
});

test("leftoverGatewayAgents: only nomArmy's, and not a running job's (or its review rounds')", () => {
  const rows = [{ id: "main" }, { id: "nomarmy-job-a-1" }, { id: "nomarmy-job-b-2" }, { id: "nomarmy-job-b-2-r2" }];
  assert.deepEqual(leftoverGatewayAgents(rows, ["b-2"]).map((r) => r.id), ["nomarmy-job-a-1"]);
});

test("health: an OpenClaw-held sign-in whose refresh failed is an error, with the sign-in that works while the Gateway runs", () => {
  const issues = loginExpiryIssues({ profiles: [{ id: "xai:a@b.co", provider: "xai", type: "oauth", status: "expired" }] });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, "error");
  assert.equal(issues[0].fix, "openclaw models auth login --provider xai --method oauth --agent main");
  assert.deepEqual(loginExpiryIssues({ profiles: [{ id: "xai:a@b.co", provider: "xai", type: "oauth", status: "expiring", expiresAt: new Date(Date.now() + 3600e3).toISOString() }] }), [], "a short-lived token OpenClaw refreshes isn't a warning");
});

test("health: a stopped or uninstalled Gateway fails Gateway-route jobs", async () => {
  const agents = { grok: { kind: "subscription", provider: "xai", owner: "a@b.co", route: "gateway" } };
  const run = (gw) => async (cmd, args) => args[0] === "config" ? { ok: true, stdout: "true" } : args[0] === "gateway" ? { ok: true, stdout: JSON.stringify(gw) } : { ok: true, stdout: "[]" };
  const stopped = await gatewayRouteIssues({ run: run({ service: { loaded: true, command: {}, runtime: { status: "stopped" } }, port: { status: "free" } }), openclawCmd: "openclaw", agents });
  assert.deepEqual(stopped.map((i) => [i.id, i.fix]), [["gateway-route:down:stopped", "openclaw gateway start"]]);
  const missing = await gatewayRouteIssues({ run: run({ service: { loaded: false }, port: { status: "free" } }), openclawCmd: "openclaw", agents });
  assert.deepEqual(missing.map((i) => i.fix), ["openclaw gateway install"]);
  assert.deepEqual(await gatewayRouteIssues({ run: run({ service: { loaded: true, command: {}, runtime: { status: "running" } } }), openclawCmd: "openclaw", agents }), []);
});
