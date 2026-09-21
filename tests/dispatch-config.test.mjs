// Tests for config/providers.yml's schema, loader, and weighted picker.
// Run: node --test tests/dispatch-config.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  DispatchConfigError,
  availableEntries,
  dispatchConfigPath,
  loadDispatchConfig,
  pickProvider,
  resolvePool,
  stringifyDispatchConfig,
} from "../lib/dispatch-config.mjs";
import { dispatchConfigSchema, formatDispatchIssues, findReservedPoolName } from "../lib/dispatch-schema.mjs";

const tempDirs = [];

function tempNomarmyRoot(yamlText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-dispatch-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "config"), { recursive: true });
  if (yamlText !== undefined) fs.writeFileSync(path.join(dir, "config", "providers.yml"), yamlText, "utf8");
  return dir;
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// --------------------------------------------------------------------------
// schema
// --------------------------------------------------------------------------

test("dispatchConfigSchema: accepts a mixed pool of every provider type", () => {
  const result = dispatchConfigSchema.safeParse({
    pools: {
      cheap: [
        { id: "local", provider: "llama-cpp", weight: 10 },
        { id: "bedrock-nova", provider: "bedrock", model: "amazon.nova-micro-v1:0", weight: 3, auth_env: "NOMARMY_BEDROCK_API_KEY", base_url: "https://bedrock.example.com" },
        { id: "deepinfra-llama70b", provider: "deepinfra", model: "meta-llama/Llama-3.3-70B-Instruct-Turbo", weight: 3, auth_env: "NOMARMY_DEEPINFRA_API_KEY" },
      ],
      capable: [
        { id: "anthropic-sonnet", provider: "anthropic", model: "claude-sonnet-4-6", weight: 2, auth_env: "NOMARMY_ANTHROPIC_API_KEY" },
        { id: "openai-terra", provider: "openai", model: "gpt-5.6-terra", weight: 1, auth_env: "NOMARMY_OPENAI_API_KEY" },
        { id: "grok-coding", provider: "xai", model: "grok-build-0.1", weight: 1, auth_env: "NOMARMY_XAI_API_KEY" },
        { id: "azure-mini", provider: "azure-openai", model: "gpt-4o-mini", weight: 1, auth_env: "NOMARMY_AZURE_OPENAI_API_KEY", base_url: "https://my-resource.openai.azure.com" },
        { id: "custom-endpoint", provider: "openai-compatible", model: "some-model", weight: 1, auth_env: "NOMARMY_CUSTOM_API_KEY", base_url: "https://example.com/v1" },
      ],
    },
  });
  assert.equal(result.success, true);
  assert.equal(result.data.pools.cheap[0].max_concurrent, 2, "max_concurrent defaults to 2");
  assert.equal(result.data.pools.capable[0].thinking, true, "thinking defaults to true for hosted providers");
});

test("dispatchConfigSchema: llama-cpp needs no auth_env or model", () => {
  const result = dispatchConfigSchema.safeParse({ pools: { cheap: [{ id: "local", provider: "llama-cpp", weight: 1 }] } });
  assert.equal(result.success, true);
});

test("dispatchConfigSchema: a hosted provider without auth_env is rejected", () => {
  const result = dispatchConfigSchema.safeParse({ pools: { capable: [{ id: "sonnet", provider: "anthropic", model: "claude-sonnet-4-6", weight: 1 }] } });
  assert.equal(result.success, false);
  assert.match(formatDispatchIssues(result.error).join("\n"), /auth_env: is required/);
});

test("dispatchConfigSchema: bedrock/azure-openai/openai-compatible require base_url", () => {
  const result = dispatchConfigSchema.safeParse({ pools: { cheap: [{ id: "x", provider: "azure-openai", model: "gpt-4o-mini", weight: 1, auth_env: "NOMARMY_AZURE_OPENAI_API_KEY" }] } });
  assert.equal(result.success, false);
  assert.match(formatDispatchIssues(result.error).join("\n"), /base_url: is required/);
});

test("dispatchConfigSchema: auth_env must look like an env var name, not a raw credential", () => {
  const result = dispatchConfigSchema.safeParse({ pools: { capable: [{ id: "sonnet", provider: "anthropic", model: "claude-sonnet-4-6", weight: 1, auth_env: "sk-ant-not-a-var-name" }] } });
  assert.equal(result.success, false);
});

test("dispatchConfigSchema: an unrecognized field is a hard error, never silently ignored", () => {
  const result = dispatchConfigSchema.safeParse({ pools: { cheap: [{ id: "local", provider: "llama-cpp", weight: 1, typo_field: true }] } });
  assert.equal(result.success, false);
  assert.match(formatDispatchIssues(result.error).join("\n"), /unexpected field/);
});

test("dispatchConfigSchema: an unknown provider type names the real list, not a generic message", () => {
  const result = dispatchConfigSchema.safeParse({ pools: { cheap: [{ id: "x", provider: "made-up-provider", weight: 1 }] } });
  assert.equal(result.success, false);
  assert.match(formatDispatchIssues(result.error).join("\n"), /must be one of llama-cpp, bedrock, anthropic, openai, xai, deepinfra, azure-openai, openai-compatible/);
});

test("dispatchConfigSchema: a duplicate id across pools is a hard error naming both pools", () => {
  const result = dispatchConfigSchema.safeParse({
    pools: {
      cheap: [{ id: "shared-id", provider: "llama-cpp", weight: 1 }],
      capable: [{ id: "shared-id", provider: "anthropic", model: "claude-sonnet-4-6", weight: 1, auth_env: "NOMARMY_ANTHROPIC_API_KEY" }],
    },
  });
  assert.equal(result.success, false);
  assert.match(formatDispatchIssues(result.error).join("\n"), /"shared-id" is already used by pool "cheap"/);
});

// --------------------------------------------------------------------------
// loader
// --------------------------------------------------------------------------

test("loadDispatchConfig: no config/providers.yml is found:false, not an error", () => {
  const root = tempNomarmyRoot(undefined);
  const result = loadDispatchConfig(root);
  assert.deepEqual(result, { found: false, path: null, config: null });
});

test("loadDispatchConfig: a valid file loads and validates", () => {
  const root = tempNomarmyRoot(`
pools:
  cheap:
    - id: local
      provider: llama-cpp
      weight: 10
`);
  const result = loadDispatchConfig(root);
  assert.equal(result.found, true);
  assert.equal(result.path, dispatchConfigPath(root));
  assert.equal(result.config.pools.cheap[0].id, "local");
});

test("loadDispatchConfig: invalid YAML throws DispatchConfigError, not a raw parser exception", () => {
  const root = tempNomarmyRoot("pools:\n  cheap: [this is not: valid: yaml");
  assert.throws(() => loadDispatchConfig(root), DispatchConfigError);
});

test("loadDispatchConfig: a schema violation throws DispatchConfigError with readable lines", () => {
  const root = tempNomarmyRoot(`
pools:
  cheap:
    - id: sonnet
      provider: anthropic
      model: claude-sonnet-4-6
      weight: 1
`); // missing required auth_env
  assert.throws(() => loadDispatchConfig(root), (error) => {
    assert.ok(error instanceof DispatchConfigError);
    assert.ok(error.errors.some((line) => line.includes("auth_env")));
    return true;
  });
});

test("loadDispatchConfig: an empty file is treated as an empty document, not a crash", () => {
  const root = tempNomarmyRoot("");
  assert.throws(() => loadDispatchConfig(root), /pools/);
});

// Regression: z.record() silently drops a key literally named "__proto__"
// (no prototype pollution results, but the pool and every entry in it
// vanish with zero validation error -- the opposite of this schema's own
// "unrecognized field is a hard error" rule). Caught explicitly, before
// schema validation, on the raw parsed object's own keys.
test("findReservedPoolName: detects __proto__/constructor/prototype as pool names", () => {
  // A `{ __proto__: [] }` OBJECT LITERAL sets the prototype instead of
  // creating an own property (JS's own special-cased literal syntax) --
  // JSON.parse (like YAML.parse) does not have that special case, and
  // produces a genuine own property, which is the actual shape this guards
  // against.
  const withProto = JSON.parse('{"pools": {"__proto__": []}}');
  assert.equal(findReservedPoolName(withProto), "__proto__");
  assert.equal(findReservedPoolName({ pools: { cheap: [] } }), null);
  assert.equal(findReservedPoolName({}), null);
  assert.equal(findReservedPoolName(null), null);
});

test("loadDispatchConfig: a pool literally named __proto__ is a clear DispatchConfigError, not a silent empty pools object", () => {
  const root = tempNomarmyRoot("pools:\n  __proto__:\n    - id: x\n      provider: llama-cpp\n      weight: 1\n");
  assert.throws(() => loadDispatchConfig(root), (error) => {
    assert.ok(error instanceof DispatchConfigError);
    assert.ok(error.errors.some((line) => line.includes("reserved")));
    return true;
  });
});

// --------------------------------------------------------------------------
// availableEntries / pickProvider / resolvePool
// --------------------------------------------------------------------------

test("availableEntries: llama-cpp is always available; a hosted entry needs its auth_env set", () => {
  const pool = [
    { id: "local", provider: "llama-cpp", weight: 1 },
    { id: "sonnet", provider: "anthropic", weight: 1, auth_env: "NOMARMY_TEST_UNSET_KEY_XYZ" },
  ];
  const available = availableEntries(pool, {});
  assert.deepEqual(available.map((e) => e.id), ["local"]);
});

test("availableEntries: a set auth_env makes that entry available too", () => {
  const pool = [{ id: "sonnet", provider: "anthropic", weight: 1, auth_env: "NOMARMY_TEST_KEY" }];
  const available = availableEntries(pool, { NOMARMY_TEST_KEY: "sk-fake" });
  assert.deepEqual(available.map((e) => e.id), ["sonnet"]);
});

test("pickProvider: a fixed rng sequence produces the exact expected pick across a known weight distribution", () => {
  const pool = [
    { id: "a", provider: "llama-cpp", weight: 1 },
    { id: "b", provider: "llama-cpp", weight: 3 },
  ];
  // total weight 4: roll < 1 -> a, roll in [1,4) -> b
  assert.equal(pickProvider(pool, { rng: () => 0 }).id, "a");
  assert.equal(pickProvider(pool, { rng: () => 0.1 }).id, "a"); // 0.1*4=0.4 < 1
  assert.equal(pickProvider(pool, { rng: () => 0.3 }).id, "b"); // 0.3*4=1.2 >= 1
  assert.equal(pickProvider(pool, { rng: () => 0.9999 }).id, "b");
});

test("pickProvider: converges on the configured ratio over many draws", () => {
  const pool = [
    { id: "a", provider: "llama-cpp", weight: 1 },
    { id: "b", provider: "llama-cpp", weight: 9 },
  ];
  let bCount = 0;
  const draws = 10000;
  for (let i = 0; i < draws; i++) {
    if (pickProvider(pool, { rng: Math.random }).id === "b") bCount++;
  }
  const ratio = bCount / draws;
  assert.ok(ratio > 0.85 && ratio < 0.95, `expected ~0.9, got ${ratio}`);
});

test("pickProvider: throws a clear, actionable error when nothing in the pool is authenticated", () => {
  const pool = [{ id: "sonnet", provider: "anthropic", weight: 1, auth_env: "NOMARMY_TEST_UNSET_KEY_XYZ" }];
  assert.throws(() => pickProvider(pool, { rng: () => 0 }), /no provider in this pool has its auth_env set/);
});

// Regression: pickProvider used to accept `runningById` but never actually
// look at it, so an entry's own max_concurrent was pure documentation with
// zero real enforcement. Verified here against a direct repro of that gap.
test("pickProvider: an entry at its max_concurrent is excluded, even though it's authenticated", () => {
  const pool = [
    { id: "a", provider: "llama-cpp", weight: 1, max_concurrent: 1 },
    { id: "b", provider: "llama-cpp", weight: 1, max_concurrent: 1 },
  ];
  // 'a' is already at its cap of 1; only 'b' may be picked, regardless of rng.
  const picked = pickProvider(pool, { rng: () => 0, runningById: { a: 5, b: 0 } });
  assert.equal(picked.id, "b");
});

test("pickProvider: every authenticated entry at its cap throws a distinct, capacity-specific error", () => {
  const pool = [
    { id: "a", provider: "llama-cpp", weight: 1, max_concurrent: 1 },
    { id: "b", provider: "llama-cpp", weight: 1, max_concurrent: 2 },
  ];
  assert.throws(
    () => pickProvider(pool, { rng: () => 0, runningById: { a: 1, b: 2 } }),
    /already at its max_concurrent limit/,
  );
});

test("pickProvider: an entry with no max_concurrent set is never excluded on capacity grounds", () => {
  const pool = [{ id: "unbounded", provider: "llama-cpp", weight: 1 }];
  const picked = pickProvider(pool, { rng: () => 0, runningById: { unbounded: 999 } });
  assert.equal(picked.id, "unbounded");
});

test("pickProvider: with no runningById supplied at all, capacity never excludes anything (default stays permissive)", () => {
  const pool = [{ id: "a", provider: "llama-cpp", weight: 1, max_concurrent: 1 }];
  assert.equal(pickProvider(pool, { rng: () => 0 }).id, "a");
});

test("resolvePool: an unknown pool name lists the pools that DO exist", () => {
  const dispatchConfig = { found: true, config: { pools: { cheap: [{ id: "local", provider: "llama-cpp", weight: 1 }] } } };
  assert.throws(() => resolvePool(dispatchConfig, "typo"), /unknown pool "typo" -- configured pools are: cheap/);
});

test("resolvePool: no pools configured at all points at `nomarmy providers add`", () => {
  const dispatchConfig = { found: false, config: null };
  assert.throws(() => resolvePool(dispatchConfig, "cheap"), /run `nomarmy providers add` first/);
});

test("resolvePool: a real hit returns the pool's entries", () => {
  const dispatchConfig = { found: true, config: { pools: { cheap: [{ id: "local", provider: "llama-cpp", weight: 1 }] } } };
  assert.deepEqual(resolvePool(dispatchConfig, "cheap"), [{ id: "local", provider: "llama-cpp", weight: 1 }]);
});

// Regression: `pools?.["__proto__"]` on a plain object returns
// Object.prototype itself -- truthy, even though no such pool was ever
// configured (a real config/providers.yml can never legitimately declare
// one; loadDispatchConfig rejects it at load time). A job's `pool` field
// passes jobSchema's own regex fine for this exact string, so this must
// throw the normal "unknown pool" error, not crash downstream in
// pickProvider with "pool.filter is not a function".
test("resolvePool: a job requesting pool \"__proto__\" gets the normal unknown-pool error, not a crash", () => {
  const dispatchConfig = { found: true, config: { pools: { cheap: [{ id: "local", provider: "llama-cpp", weight: 1 }] } } };
  assert.throws(() => resolvePool(dispatchConfig, "__proto__"), /unknown pool "__proto__" -- configured pools are: cheap/);
});

test("stringifyDispatchConfig round-trips through loadDispatchConfig", () => {
  const config = { pools: { cheap: [{ id: "local", provider: "llama-cpp", weight: 10, max_concurrent: 2 }] } };
  const root = tempNomarmyRoot(stringifyDispatchConfig(config));
  const result = loadDispatchConfig(root);
  assert.equal(result.found, true);
  assert.equal(result.config.pools.cheap[0].id, "local");
});
