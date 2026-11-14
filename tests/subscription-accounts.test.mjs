import "./helpers/isolate-global-config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateAgents, describeAgent } from "../lib/agents.mjs";
import { newAgentAuthProfile } from "../lib/subscription-setup.mjs";
import { pinnedModelRef } from "../lib/openclaw-run.mjs";
import { resolveWorkerSandboxOverride } from "../mcp/server.mjs";
import { DEFAULT_AGENT_IMAGE } from "../lib/verify.mjs";

// Two companies' plans on one provider: Lee's case. OpenClaw keeps one
// sign-in per account (openai:account-<id> for a Codex import, <provider>:
// <email> or a named profile for its own sign-in); nomArmy has to say which.
const codexA = { kind: "subscription", provider: "openai", owner: "lee@a.example", model: "gpt-6-astra", auth_profile: "openai:account-aaa" };
const codexB = { kind: "subscription", provider: "openai", owner: "lee@b.example", model: "gpt-6-astra", auth_profile: "openai:account-bbb" };

test("two subscription agents on one provider load when each names its own sign-in", () => {
  const ok = validateAgents({ agents: { "codex-a": codexA, "codex-b": codexB } });
  assert.equal(ok.ok, true, ok.errors?.join("\n"));
  assert.match(describeAgent(codexA), /sign-in openai:account-aaa/);
});

test("two accounts on one provider are refused unless each names its sign-in", () => {
  const { auth_profile: _a, ...unpinnedB } = codexB;
  const mixed = validateAgents({ agents: { "codex-a": codexA, "codex-b": unpinnedB } });
  assert.equal(mixed.ok, false);
  assert.match(mixed.errors.join("\n"), /give codex-b an auth_profile too/);
  const { auth_profile: _b, ...unpinnedA } = codexA;
  const owners = validateAgents({ agents: { "codex-a": unpinnedA, "codex-b": unpinnedB } });
  assert.match(owners.errors.join("\n"), /different owners; give each an auth_profile/);
  const same = validateAgents({ agents: { "codex-a": codexA, "codex-b": { ...codexB, auth_profile: codexA.auth_profile } } });
  assert.match(same.errors.join("\n"), /same sign-in openai:account-aaa but different owners/);
});

test("several agents on ONE account stay fine: same owner, different default models", () => {
  const { auth_profile: _a, ...unpinnedA } = codexA;
  assert.equal(validateAgents({ agents: { astra: unpinnedA, sol: { ...unpinnedA, model: "gpt-6-sol" } } }).ok, true);
  assert.equal(validateAgents({ agents: { astra: codexA, sol: { ...codexA, model: "gpt-6-sol" } } }).ok, true);
  const claude = (model, owner = "you@example.com") => ({ kind: "subscription", provider: "claude-cli", model, owner });
  assert.equal(validateAgents({ agents: { opus: claude("claude-opus-5"), sonnet: claude("claude-sonnet-5") } }).ok, true);
});

test("two Claude seats: one on the CLI's own login, the other pinned to a setup-token; Muse Code stays one account", () => {
  const claude = (owner, extra = {}) => ({ kind: "subscription", provider: "claude-cli", owner, ...extra });
  assert.equal(validateAgents({ agents: { a: claude("lee@a.example"), b: claude("lee@b.example", { auth_profile: "anthropic:setup-token-2" }) } }).ok, true,
    "Claude never picks a sign-in itself, so the unpinned agent is the CLI's own login");
  assert.match(validateAgents({ agents: { a: claude("lee@a.example"), b: claude("lee@b.example") } }).errors.join("\n"), /claude CLI's own login, one account, but name different owners/);
  const muse = (owner) => ({ kind: "subscription", provider: "muse-cli", owner });
  assert.match(validateAgents({ agents: { a: muse("a@x"), b: muse("b@x") } }).errors.join("\n"), /CLI's one signed-in session/);
});

test("setup: a second Claude seat's token is found under anthropic, and the first agent can stay on the CLI login", () => {
  const profiles = [
    { id: "anthropic:setup-token", provider: "anthropic", type: "token" },
    { id: "anthropic:api", provider: "anthropic", type: "api_key" },
  ];
  const first = { kind: "subscription", provider: "claude-cli", owner: "lee@a.example" };
  const answer = newAgentAuthProfile({ agents: { claude: first }, provider: "claude-cli", profiles, before: [] });
  assert.equal(answer.profile, "anthropic:setup-token");
  assert.deepEqual(answer.unpinned, [], "the unpinned Claude agent keeps the CLI's own login");
  assert.ok(!answer.signIns.includes("anthropic:api"), "a metered key is never a subscription's sign-in");
});

test("auth_profile ids stay command-line safe", () => {
  assert.equal(validateAgents({ agents: { c: { ...codexA, auth_profile: "openai:x; rm -rf /" } } }).ok, false);
  assert.equal(validateAgents({ agents: { c: { ...codexA, auth_profile: "no-provider-prefix" } } }).ok, false);
  assert.equal(validateAgents({ agents: { c: { ...codexA, auth_profile: "xai:company-b" } } }).ok, true);
});

test("jobs hand OpenClaw the model pinned to the agent's sign-in", () => {
  assert.equal(pinnedModelRef("openai/gpt-6-astra", "openai:account-bbb"), "openai/gpt-6-astra@openai:account-bbb");
  assert.equal(pinnedModelRef("openai/gpt-6-astra", null), "openai/gpt-6-astra");
});

test("a pinned job's config makes the pinned model its configured model, with no fallbacks", () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-pin-"));
  const opts = (pinnedModel) => ({ loadConfigFn: () => ({ found: false }), resolveSandboxImageFn: () => DEFAULT_AGENT_IMAGE,
    ambientConfigPathFn: () => "/fake/openclaw.json", readAmbientConfig: () => ({ agents: { defaults: { model: { primary: "openai/gpt-6-astra", fallbacks: ["xai/grok-4.7"] } } } }),
    modelRef: "openai/gpt-6-astra", pinnedModel });
  const read = (pinned) => JSON.parse(fs.readFileSync(resolveWorkerSandboxOverride("/repo", runtimeDir, opts(pinned)), "utf8"));
  assert.deepEqual(read("openai/gpt-6-astra@openai:account-bbb").agents.defaults.model, { primary: "openai/gpt-6-astra@openai:account-bbb", fallbacks: [] });
  assert.deepEqual(read(null).agents.defaults.model, { primary: "openai/gpt-6-astra", fallbacks: ["xai/grok-4.7"] }, "an unpinned job keeps the ambient model");
});

test("setup: a second account's new sign-in is found, and an existing unpinned agent is flagged", () => {
  const profiles = [
    { id: "openai:account-aaa", provider: "openai", type: "oauth" },
    { id: "openai:account-bbb", provider: "openai", type: "oauth" },
    { id: "openai:key", provider: "openai", type: "api_key" },
  ];
  assert.deepEqual(newAgentAuthProfile({ agents: {}, provider: "openai", profiles }), { needed: false });
  const pinnedA = newAgentAuthProfile({ agents: { "codex-a": codexA }, provider: "openai", profiles, before: ["openai:account-aaa"] });
  assert.equal(pinnedA.profile, "openai:account-bbb");
  assert.deepEqual(pinnedA.unpinned, []);
  const { auth_profile: _a, ...unpinnedA } = codexA;
  const unpinned = newAgentAuthProfile({ agents: { "codex-a": unpinnedA }, provider: "openai", profiles, before: ["openai:account-aaa"] });
  assert.equal(unpinned.profile, "openai:account-bbb", "the sign-in made by this setup is the new agent's");
  assert.deepEqual(unpinned.unpinned, ["codex-a"]);
});

test("setup: a login that replaced the first account's is caught, not saved as a second account", () => {
  const profiles = [{ id: "xai:default", provider: "xai", type: "oauth" }];
  const grokA = { kind: "subscription", provider: "xai", owner: "lee@a.example" };
  const answer = newAgentAuthProfile({ agents: { "grok-a": grokA }, provider: "xai", profiles, before: ["xai:default"] });
  assert.match(answer.problem, /OpenClaw has 1 sign-in for xai .* 2 agents need one each/);
  assert.match(answer.problem, /--profile-id xai:<a name>/);
});

test("setup: when it can't tell which sign-in is new, it asks", () => {
  const profiles = ["a", "b", "c"].map((n) => ({ id: `openai:account-${n}`, provider: "openai", type: "oauth" }));
  const answer = newAgentAuthProfile({ agents: { "codex-a": codexA }, provider: "openai", profiles, before: profiles.map((p) => p.id) });
  assert.deepEqual(answer.choices, ["openai:account-a", "openai:account-b", "openai:account-c"].filter((id) => id !== codexA.auth_profile));
});
