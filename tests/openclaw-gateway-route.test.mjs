import "./helpers/isolate-global-config.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { gatewayAgentId, gatewayAgentSettings, gatewayResultAsExecResult, runOnGateway, GATEWAY_AGENT_PREFIX } from "../lib/openclaw-gateway-route.mjs";
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
    if (a === "agents" && b === "delete") { trashed.push(config[`agents.entries.${args[2]}.workspace`]); agents.delete(args[2]); return { stdout: "{}", stderr: "" }; }
    return fail(`unexpected: ${args.join(" ")}`);
  };
  return { run, calls, config, agents, trashed };
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
