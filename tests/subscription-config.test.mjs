// Tests for config/subscriptions.yml's schema and loader.
// Run: node --test tests/subscription-config.test.mjs

import "./helpers/isolate-global-config.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  SubscriptionConfigError,
  loadSubscriptionConfig,
  resolveSubscriptionWorker,
  resolveSubscriptionWorkerByRole,
  findProviderConflicts,
  describeProviderConflict,
  stringifySubscriptionConfig,
  subscriptionConfigPath,
} from "../lib/subscription-config.mjs";
import { subscriptionConfigSchema, formatSubscriptionIssues, findReservedWorkerName } from "../lib/subscription-schema.mjs";

const tempDirs = [];

function tempNomarmyRoot(yamlText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-subscriptions-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "config"), { recursive: true });
  if (yamlText !== undefined) fs.writeFileSync(path.join(dir, "config", "subscriptions.yml"), yamlText, "utf8");
  // The loaders take the config directory itself (normally ~/.config/nomarmy).
  return path.join(dir, "config");
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// --------------------------------------------------------------------------
// schema
// --------------------------------------------------------------------------

test("subscriptionConfigSchema: accepts a minimal real-shaped entry, defaults max_concurrent to 1 and thinking to true", () => {
  const result = subscriptionConfigSchema.safeParse({
    workers: {
      "jason-claude": { provider: "claude-cli", model: "claude-sonnet-5", owner: "jason.pugh@rayson-tech.com" },
    },
  });
  assert.equal(result.success, true);
  assert.equal(result.data.workers["jason-claude"].max_concurrent, 1, "max_concurrent defaults to 1, not providerEntrySchema's 2 -- a personal session isn't rate-provisioned for concurrent automation");
  assert.equal(result.data.workers["jason-claude"].thinking, true);
});

test("subscriptionConfigSchema: has no weight field at all -- a pooled-capacity shape is a type error here, not a discipline problem", () => {
  const result = subscriptionConfigSchema.safeParse({
    workers: { "jason-claude": { provider: "claude-cli", model: "claude-sonnet-5", owner: "jason.pugh@rayson-tech.com", weight: 3 } },
  });
  assert.equal(result.success, false);
});

test("subscriptionConfigSchema: rejects an entry with no owner -- attestation has nothing to check without it", () => {
  const result = subscriptionConfigSchema.safeParse({
    workers: { "jason-claude": { provider: "claude-cli", model: "claude-sonnet-5" } },
  });
  assert.equal(result.success, false);
});

test("subscriptionConfigSchema: carries no auth_env or credential field of any kind -- OpenClaw owns credential storage entirely", () => {
  const result = subscriptionConfigSchema.safeParse({
    workers: { "jason-claude": { provider: "claude-cli", model: "claude-sonnet-5", owner: "j@example.com", auth_env: "SOME_VAR" } },
  });
  assert.equal(result.success, false, "auth_env is not a recognized field on a subscription entry");
});

test("formatSubscriptionIssues: readable path:message lines, one per problem", () => {
  const result = subscriptionConfigSchema.safeParse({ workers: { bad: { provider: "claude-cli" } } });
  assert.equal(result.success, false);
  const lines = formatSubscriptionIssues(result.error);
  assert.ok(lines.some((l) => l.includes("model")));
  assert.ok(lines.some((l) => l.includes("owner")));
});

test("findReservedWorkerName: __proto__ as a worker name is caught before z.record() can silently drop it", () => {
  const candidate = JSON.parse('{"workers": {"__proto__": {"provider": "claude-cli", "model": "x", "owner": "y"}}}');
  assert.equal(findReservedWorkerName(candidate), "__proto__");
});

test("findReservedWorkerName: an ordinary config has nothing reserved", () => {
  assert.equal(findReservedWorkerName({ workers: { "jason-claude": {} } }), null);
  assert.equal(findReservedWorkerName({}), null);
});

// --------------------------------------------------------------------------
// loader
// --------------------------------------------------------------------------

test("loadSubscriptionConfig: a missing file is not an error -- found:false, fully opt-in", () => {
  const dir = tempNomarmyRoot();
  const result = loadSubscriptionConfig(dir);
  assert.deepEqual(result, { found: false, path: null, config: null });
});

test("loadSubscriptionConfig: loads and validates a real file", () => {
  const dir = tempNomarmyRoot(`workers:\n  jason-claude:\n    provider: claude-cli\n    model: claude-sonnet-5\n    owner: jason.pugh@rayson-tech.com\n`);
  const result = loadSubscriptionConfig(dir);
  assert.equal(result.found, true);
  assert.equal(result.path, subscriptionConfigPath(dir));
  assert.equal(result.config.workers["jason-claude"].provider, "claude-cli");
});

test("loadSubscriptionConfig: invalid YAML throws SubscriptionConfigError, not a generic parse error", () => {
  const dir = tempNomarmyRoot("workers: [this is not valid: yaml: :::");
  assert.throws(() => loadSubscriptionConfig(dir), (error) => {
    assert.ok(error instanceof SubscriptionConfigError);
    assert.match(error.message, /not valid YAML/);
    return true;
  });
});

test("loadSubscriptionConfig: a schema violation throws with readable per-field errors", () => {
  const dir = tempNomarmyRoot(`workers:\n  bad:\n    provider: claude-cli\n`);
  assert.throws(() => loadSubscriptionConfig(dir), (error) => {
    assert.ok(error instanceof SubscriptionConfigError);
    assert.ok(error.errors.length > 0);
    return true;
  });
});

test("loadSubscriptionConfig: a reserved worker name is refused before schema validation even runs", () => {
  const dir = tempNomarmyRoot(`workers:\n  __proto__:\n    provider: claude-cli\n    model: x\n    owner: y\n`);
  assert.throws(() => loadSubscriptionConfig(dir), /reserved/);
});

test("stringifySubscriptionConfig: round-trips through loadSubscriptionConfig", () => {
  const dir = tempNomarmyRoot();
  const config = { workers: { "jason-claude": { provider: "claude-cli", model: "claude-sonnet-5", owner: "jason.pugh@rayson-tech.com", max_concurrent: 1, thinking: true } } };
  fs.writeFileSync(path.join(dir, "subscriptions.yml"), stringifySubscriptionConfig(config), "utf8");
  const result = loadSubscriptionConfig(dir);
  assert.equal(result.found, true);
  assert.equal(result.config.workers["jason-claude"].model, "claude-sonnet-5");
});

// --------------------------------------------------------------------------
// resolveSubscriptionWorker: exact-name lookup, never a picker
// --------------------------------------------------------------------------

test("resolveSubscriptionWorker: finds a real entry by exact name", () => {
  const dir = tempNomarmyRoot(`workers:\n  jason-claude:\n    provider: claude-cli\n    model: claude-sonnet-5\n    owner: jason.pugh@rayson-tech.com\n`);
  const loaded = loadSubscriptionConfig(dir);
  const entry = resolveSubscriptionWorker(loaded, "jason-claude");
  assert.equal(entry.id, "jason-claude");
  assert.equal(entry.owner, "jason.pugh@rayson-tech.com");
});

test("resolveSubscriptionWorker: an unknown name throws, naming what DOES exist -- never a silent fallback", () => {
  const dir = tempNomarmyRoot(`workers:\n  jason-claude:\n    provider: claude-cli\n    model: claude-sonnet-5\n    owner: jason.pugh@rayson-tech.com\n`);
  const loaded = loadSubscriptionConfig(dir);
  assert.throws(() => resolveSubscriptionWorker(loaded, "typo-name"), (error) => {
    assert.match(error.message, /unknown subscription_worker "typo-name"/);
    assert.match(error.message, /jason-claude/);
    return true;
  });
});

test("resolveSubscriptionWorker: no config loaded at all still throws a clear, specific error", () => {
  assert.throws(() => resolveSubscriptionWorker({ found: false, config: null }, "anything"), /no workers are configured yet/);
});

test("resolveSubscriptionWorker: a literal __proto__ lookup is never treated as a real, truthy entry", () => {
  const dir = tempNomarmyRoot(`workers:\n  jason-claude:\n    provider: claude-cli\n    model: claude-sonnet-5\n    owner: jason.pugh@rayson-tech.com\n`);
  const loaded = loadSubscriptionConfig(dir);
  assert.throws(() => resolveSubscriptionWorker(loaded, "__proto__"), /unknown subscription_worker/);
});

// --------------------------------------------------------------------------
// role: deterministic, unique-per-entry alternative to naming a worker
// directly -- never a weighted pick across several.
// --------------------------------------------------------------------------

test("subscriptionConfigSchema: accepts a role, and different entries may declare different roles", () => {
  const result = subscriptionConfigSchema.safeParse({
    workers: {
      opus: { provider: "claude-cli", model: "claude-opus-5", owner: "j@example.com", role: "architect" },
      sonnet: { provider: "claude-cli", model: "claude-sonnet-5", owner: "j@example.com", role: "senior-dev" },
    },
  });
  assert.equal(result.success, true);
});

test("subscriptionConfigSchema: two entries claiming the same role is a hard error -- ambiguity is caught at load time, not dispatch time", () => {
  const result = subscriptionConfigSchema.safeParse({
    workers: {
      opus: { provider: "claude-cli", model: "claude-opus-5", owner: "j@example.com", role: "architect" },
      "gpt-5": { provider: "codex-cli", model: "gpt-5.6", owner: "j@example.com", role: "architect" },
    },
  });
  assert.equal(result.success, false);
});

test("subscriptionConfigSchema: role is optional -- a worker with no role is still fine, just not role-dispatchable", () => {
  const result = subscriptionConfigSchema.safeParse({
    workers: { opus: { provider: "claude-cli", model: "claude-opus-5", owner: "j@example.com" } },
  });
  assert.equal(result.success, true);
  assert.equal(result.data.workers.opus.role, undefined);
});

test("resolveSubscriptionWorkerByRole: finds the one entry declaring a role", () => {
  const dir = tempNomarmyRoot(`workers:\n  opus:\n    provider: claude-cli\n    model: claude-opus-5\n    owner: j@example.com\n    role: architect\n  muse:\n    provider: muse-code\n    model: muse-spark-1.3\n    owner: j@example.com\n    role: junior-dev\n`);
  const loaded = loadSubscriptionConfig(dir);
  const entry = resolveSubscriptionWorkerByRole(loaded, "architect");
  assert.equal(entry.id, "opus");
  const other = resolveSubscriptionWorkerByRole(loaded, "junior-dev");
  assert.equal(other.id, "muse");
});

test("resolveSubscriptionWorkerByRole: an unknown role throws, naming which roles DO exist -- never a silent fallback", () => {
  const dir = tempNomarmyRoot(`workers:\n  opus:\n    provider: claude-cli\n    model: claude-opus-5\n    owner: j@example.com\n    role: architect\n`);
  const loaded = loadSubscriptionConfig(dir);
  assert.throws(() => resolveSubscriptionWorkerByRole(loaded, "typo-role"), (error) => {
    assert.match(error.message, /unknown role "typo-role"/);
    assert.match(error.message, /architect/);
    return true;
  });
});

test("resolveSubscriptionWorkerByRole: no config loaded, or no worker declares any role, throws a clear specific error", () => {
  assert.throws(() => resolveSubscriptionWorkerByRole({ found: false, config: null }, "architect"), /no worker in config\/subscriptions\.yml declares a role/);
  const dir = tempNomarmyRoot(`workers:\n  opus:\n    provider: claude-cli\n    model: claude-opus-5\n    owner: j@example.com\n`);
  const loaded = loadSubscriptionConfig(dir);
  assert.throws(() => resolveSubscriptionWorkerByRole(loaded, "architect"), /no worker in config\/subscriptions\.yml declares a role/);
});

// --------------------------------------------------------------------------
// findProviderConflicts: one OpenClaw provider id in both a pool and a
// subscription worker -- the silent-pooling path for Meta and xAI.
// --------------------------------------------------------------------------

const REAL_SHAPE_POOLS = {
  capable: [{ id: "grok", provider: "xai", model: "grok-4.6", weight: 1 }],
  cheap: [{ id: "llama-cpp", provider: "llama-cpp", weight: 10 }],
};

test("findProviderConflicts: an xai subscription worker next to the real xai pool entry is a conflict", () => {
  const conflicts = findProviderConflicts(REAL_SHAPE_POOLS, { "you-grok": { provider: "xai", model: "grok-4.6", owner: "you@example.com" } });
  assert.deepEqual(conflicts, [{ provider: "xai", poolEntries: ["capable/grok"], workers: ["you-grok"] }]);
  assert.match(describeProviderConflict(conflicts[0]), /capable\/grok.*you-grok.*Remove one side/s);
});

test("findProviderConflicts: claude-cli never collides with an anthropic pool entry; a ChatGPT worker (openai) does collide with an openai one", () => {
  const pools = { capable: [{ id: "a", provider: "anthropic", model: "x", weight: 1 }, { id: "o", provider: "openai", model: "y", weight: 1 }] };
  const workers = { c: { provider: "claude-cli", model: "x", owner: "o" }, x: { provider: "openai", model: "y", owner: "o" } };
  assert.deepEqual(findProviderConflicts(pools, workers), [{ provider: "openai", poolEntries: ["capable/o"], workers: ["x"] }]);
});

test("findProviderConflicts: empty or missing configs are never a conflict", () => {
  assert.deepEqual(findProviderConflicts(undefined, undefined), []);
  assert.deepEqual(findProviderConflicts(REAL_SHAPE_POOLS, {}), []);
});

test("findProviderConflicts: a generic openclaw pool entry is matched by its real OpenClaw id, not the literal \"openclaw\"", () => {
  const pools = { cheap: [{ id: "meta-key", provider: "openclaw", openclaw_provider: "meta", model: "muse-spark-1.3", weight: 1 }] };
  const conflicts = findProviderConflicts(pools, { "you-meta": { provider: "meta", model: "muse-spark-1.3", owner: "o" } });
  assert.deepEqual(conflicts, [{ provider: "meta", poolEntries: ["cheap/meta-key"], workers: ["you-meta"] }]);
});
