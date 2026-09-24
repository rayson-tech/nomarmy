import "./helpers/isolate-global-config.mjs";
// Tests for lib/agents.mjs: one agents.yml for the local model, api keys
// and individual subscriptions, and the adapters that hand it to the
// existing execution path.
// Run: node --test tests/agents.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  agentDispatchFields,
  agentsAsDispatchConfig,
  agentsAsSubscriptionConfig,
  describeAgent,
  loadAgents,
  readAgentsFile,
  validateAgents,
  writeAgentsFile,
} from "../lib/agents.mjs";

const dirs = [];
function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-agents-"));
  dirs.push(dir);
  return dir;
}
after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

// The operator's real shape, with the owner replaced.
const REAL = {
  agents: {
    grok: { kind: "api", provider: "xai", model: "grok-4.7", auth_env: "NOMARMY_XAI_API_KEY", thinking: "high", context_window: 500000 },
    claude: { kind: "subscription", provider: "claude-cli", model: "claude-sonnet-5", owner: "you@example.com" },
    codex: { kind: "subscription", provider: "openai", model: "gpt-6-astra", owner: "you@example.com" },
  },
};

test("validateAgents: the real three-kind shape validates, with each kind's defaults", () => {
  const result = validateAgents(REAL);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.data.agents.grok.max_concurrent, 2);
  assert.equal(result.data.agents.codex.max_concurrent, 1, "a personal subscription defaults to one job at a time");
  assert.equal(result.data.agents.codex.thinking, true);
});

test("validateAgents: a subscription needs an owner and has no field for a key, a weight or a role", () => {
  const sub = { kind: "subscription", provider: "openai", model: "m", owner: "o" };
  assert.match(validateAgents({ agents: { x: { ...sub, owner: undefined } } }).errors.join("\n"), /owner: is required/);
  for (const field of ["auth_env", "weight", "role", "api_key"]) {
    assert.equal(validateAgents({ agents: { x: { ...sub, [field]: "anything" } } }).ok, false, field);
  }
});

test("validateAgents: api agents get the per-provider rules -- auth_env required, base_url for custom endpoints, openclaw_provider for the generic type", () => {
  assert.match(validateAgents({ agents: { g: { kind: "api", provider: "xai", model: "m" } } }).errors.join("\n"), /auth_env: is required/);
  assert.match(validateAgents({ agents: { az: { kind: "api", provider: "azure-openai", model: "m", auth_env: "K" } } }).errors.join("\n"), /base_url/);
  assert.match(validateAgents({ agents: { d: { kind: "api", provider: "openclaw", model: "m", auth_env: "K" } } }).errors.join("\n"), /openclaw_provider/);
  assert.equal(validateAgents({ agents: { d: { kind: "api", provider: "openclaw", openclaw_provider: "deepseek", model: "m", auth_env: "K" } } }).ok, true);
  assert.equal(validateAgents({ agents: { l: { kind: "api", provider: "llama-cpp", model: "m", auth_env: "K" } } }).ok, false, "the local model is kind: local, not an api provider");
});

test("validateAgents: an api agent and a subscription on one OpenClaw provider id are refused", () => {
  const result = validateAgents({ agents: { grok: REAL.agents.grok, "grok-sub": { kind: "subscription", provider: "xai", model: "grok-4.7", owner: "o" } } });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /OpenClaw provider "xai" is used by both api agent grok and subscription agent grok-sub/);
});

test("validateAgents: unknown kinds, bad names and reserved names are refused", () => {
  assert.match(validateAgents({ agents: { x: { kind: "pool" } } }).errors.join("\n"), /kind must be one of local, api, subscription/);
  assert.equal(validateAgents({ agents: { "has space": { kind: "local" } } }).ok, false);
  assert.match(validateAgents(JSON.parse('{"agents":{"__proto__":{"kind":"local"}}}')).errors.join("\n"), /reserved name/);
});

test("loadAgents: no file still gives the built-in local agent", () => {
  const loaded = loadAgents(tmp());
  assert.equal(loaded.found, false);
  assert.deepEqual(loaded.agents, { local: { kind: "local", slot: "coder" } });
});

test("writeAgentsFile + loadAgents: round-trips, writes the file private to this account, and the built-in local comes first", () => {
  const dir = tmp();
  writeAgentsFile(dir, REAL.agents);
  assert.equal(fs.statSync(path.join(dir, "agents.yml")).mode & 0o077, 0);
  const loaded = loadAgents(dir);
  assert.deepEqual(Object.keys(loaded.agents), ["local", "grok", "claude", "codex"]);
  assert.deepEqual(Object.keys(readAgentsFile(dir)), ["grok", "claude", "codex"], "read-modify-write never persists the built-in");
});

test("loadAgents: a file can redefine local, e.g. to the gpt slot", () => {
  const dir = tmp();
  writeAgentsFile(dir, { local: { kind: "local", slot: "gpt" } });
  assert.equal(loadAgents(dir).agents.local.slot, "gpt");
  assert.deepEqual(Object.keys(readAgentsFile(dir)), ["local"]);
});

test("loadAgents: invalid YAML and invalid agents throw with the path and readable lines", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "agents.yml"), "agents: [not: valid: yaml", { mode: 0o600 });
  assert.throws(() => loadAgents(dir), (e) => e.path.endsWith("agents.yml") && /not valid YAML/.test(e.message));
  fs.writeFileSync(path.join(dir, "agents.yml"), "agents:\n  x:\n    kind: api\n", { mode: 0o600 });
  assert.throws(() => loadAgents(dir), (e) => e.errors.some((l) => /provider/.test(l)));
});

test("loadAgents: refuses an agents.yml other accounts can write -- it holds owners and key names", () => {
  if (process.platform === "win32") return;
  const dir = tmp();
  writeAgentsFile(dir, REAL.agents);
  fs.chmodSync(path.join(dir, "agents.yml"), 0o666);
  assert.throws(() => loadAgents(dir), /writable by other accounts/);
});

test("agentsAsDispatchConfig / agentsAsSubscriptionConfig: api agents become one-entry pools, subscriptions become workers", () => {
  const dir = tmp();
  writeAgentsFile(dir, REAL.agents);
  const loaded = loadAgents(dir);
  const dispatch = agentsAsDispatchConfig(loaded);
  assert.deepEqual(Object.keys(dispatch.config.pools), ["grok"]);
  assert.deepEqual(dispatch.config.pools.grok, [{ id: "grok", weight: 1, provider: "xai", model: "grok-4.7", auth_env: "NOMARMY_XAI_API_KEY", thinking: "high", context_window: 500000, max_concurrent: 2 }]);
  const subs = agentsAsSubscriptionConfig(loaded);
  assert.deepEqual(Object.keys(subs.config.workers), ["claude", "codex"]);
  assert.equal(subs.config.workers.codex.kind, undefined, "the worker shape has no kind field");
});

test("agentDispatchFields: each kind maps to the one internal field the execution path reads; an unknown name never falls back", () => {
  const agents = { local: { kind: "local", slot: "coder" }, "local-gpt": { kind: "local", slot: "gpt" }, ...REAL.agents };
  assert.deepEqual(agentDispatchFields(agents, "local"), { profile: "coder" });
  assert.deepEqual(agentDispatchFields(agents, "local-gpt"), { profile: "gpt" });
  assert.deepEqual(agentDispatchFields(agents, "grok"), { pool: "grok" });
  assert.deepEqual(agentDispatchFields(agents, "codex"), { subscription_worker: "codex" });
  assert.throws(() => agentDispatchFields(agents, "gork"), /unknown agent "gork" -- your agents are: local, local-gpt, grok, claude, codex/);
  assert.throws(() => agentDispatchFields(agents, "__proto__"), /unknown agent/);
});

test("describeAgent: one readable line per kind", () => {
  assert.equal(describeAgent({ kind: "local", slot: "coder" }), "local model (coder slot)");
  assert.equal(describeAgent(REAL.agents.grok), "api xai/grok-4.7");
  assert.equal(describeAgent({ kind: "api", provider: "openclaw", openclaw_provider: "deepseek", model: "deepseek-chat" }), "api deepseek/deepseek-chat");
  assert.equal(describeAgent(REAL.agents.codex), "subscription openai/gpt-6-astra (you@example.com)");
});
