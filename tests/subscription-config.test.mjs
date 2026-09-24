import "./helpers/isolate-global-config.mjs";
// Tests for lib/subscription-config.mjs: exact-name subscription lookup and
// the one-credential-per-provider conflict check. The agents themselves
// (and their schema) are tested in tests/agents.test.mjs.
// Run: node --test tests/subscription-config.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveSubscriptionWorker, findProviderConflicts, describeProviderConflict } from "../lib/subscription-config.mjs";

const CONFIG = { found: true, config: { workers: { codex: { provider: "openai", model: "gpt-6-astra", owner: "you@example.com", max_concurrent: 1, thinking: true } } } };

test("resolveSubscriptionWorker: finds a real entry by exact name, with its name as id", () => {
  assert.deepEqual(resolveSubscriptionWorker(CONFIG, "codex"), { id: "codex", ...CONFIG.config.workers.codex });
});

test("resolveSubscriptionWorker: an unknown name throws, naming what DOES exist -- never a silent fallback", () => {
  assert.throws(() => resolveSubscriptionWorker(CONFIG, "Codex"), /unknown subscription agent "Codex" -- your subscription agents are: codex/);
});

test("resolveSubscriptionWorker: none defined at all still throws a clear, specific error", () => {
  assert.throws(() => resolveSubscriptionWorker({ found: true, config: { workers: {} } }, "anything"), /none are defined yet \(run `nomarmy agents add subscription`\)/);
  assert.throws(() => resolveSubscriptionWorker(null, "anything"), /none are defined yet/);
});

test("resolveSubscriptionWorker: a literal __proto__ lookup is never treated as a real, truthy entry", () => {
  assert.throws(() => resolveSubscriptionWorker(CONFIG, "__proto__"), /unknown subscription agent "__proto__"/);
});

// Pools here are api agents in their one-entry-pool shape (see
// lib/agents.mjs's agentsAsDispatchConfig).
const GROK_POOL = { grok: [{ id: "grok", provider: "xai", model: "grok-4.7", weight: 1 }] };

test("findProviderConflicts: an xai subscription next to an xai api agent is a conflict, described in agent terms", () => {
  const conflicts = findProviderConflicts(GROK_POOL, { "you-grok": { provider: "xai", model: "grok-4.7", owner: "you@example.com" } });
  assert.deepEqual(conflicts, [{ provider: "xai", poolEntries: ["grok/grok"], workers: ["you-grok"] }]);
  assert.match(describeProviderConflict(conflicts[0]), /used by both api agent grok and subscription agent you-grok.*Keep only one of them/);
});

test("findProviderConflicts: claude-cli never collides with an anthropic api agent; a ChatGPT subscription (openai) does collide with an openai one", () => {
  const pools = { a: [{ id: "a", provider: "anthropic", model: "x", weight: 1 }], o: [{ id: "o", provider: "openai", model: "y", weight: 1 }] };
  const workers = { c: { provider: "claude-cli", model: "x", owner: "o" }, x: { provider: "openai", model: "y", owner: "o" } };
  assert.deepEqual(findProviderConflicts(pools, workers), [{ provider: "openai", poolEntries: ["o/o"], workers: ["x"] }]);
});

test("findProviderConflicts: a generic openclaw api agent is matched by its real OpenClaw id, not the literal \"openclaw\"", () => {
  const pools = { "meta-key": [{ id: "meta-key", provider: "openclaw", openclaw_provider: "meta", model: "muse-spark-1.3", weight: 1 }] };
  const conflicts = findProviderConflicts(pools, { muse: { provider: "meta", model: "muse-spark-1.3", owner: "o" } });
  assert.deepEqual(conflicts, [{ provider: "meta", poolEntries: ["meta-key/meta-key"], workers: ["muse"] }]);
});

test("findProviderConflicts: empty or missing inputs are never a conflict", () => {
  assert.deepEqual(findProviderConflicts(undefined, undefined), []);
  assert.deepEqual(findProviderConflicts(GROK_POOL, {}), []);
});
