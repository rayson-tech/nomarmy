// Tests for the pool-entry schema (every api agent in agents.yml is
// validated as one), the picker and context budgeting.
// Run: node --test tests/dispatch-config.test.mjs

import "./helpers/isolate-global-config.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CONTEXT_WINDOW_BUFFER,
  UNKNOWN_MODEL_CONTEXT_FALLBACK,
  availableEntries,
  entryContextPerNom,
  pickProvider,
  poolContextPerNom,
  resolveEntryContext,
  resolvePool,
} from "../lib/dispatch-config.mjs";
import { dispatchConfigSchema, formatDispatchIssues, findReservedPoolName, openclawProviderId } from "../lib/dispatch-schema.mjs";

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

test("dispatchConfigSchema: thinking accepts a boolean (the original shape) or a specific level string", () => {
  const entry = (thinking) => ({ pools: { capable: [{ id: "x", provider: "xai", model: "grok-4.7", weight: 1, auth_env: "X", thinking }] } });
  assert.equal(dispatchConfigSchema.safeParse(entry(true)).success, true);
  assert.equal(dispatchConfigSchema.safeParse(entry(false)).success, true);
  assert.equal(dispatchConfigSchema.safeParse(entry("high")).success, true);
  assert.equal(dispatchConfigSchema.safeParse(entry("medium")).success, true);
  assert.equal(dispatchConfigSchema.safeParse(entry("low")).success, true);
});

test("dispatchConfigSchema: thinking rejects a level string outside low/medium/high", () => {
  const result = dispatchConfigSchema.safeParse({ pools: { capable: [{ id: "x", provider: "xai", model: "grok-4.7", weight: 1, auth_env: "X", thinking: "extreme" }] } });
  assert.equal(result.success, false);
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
  assert.match(formatDispatchIssues(result.error).join("\n"), /must be one of llama-cpp, bedrock, anthropic, openai, xai, deepinfra, openclaw, azure-openai, openai-compatible/);
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
  assert.throws(() => resolvePool(dispatchConfig, "typo"), /unknown api agent "typo" -- your api agents are: cheap/);
});

test("resolvePool: no pools configured at all points at `nomarmy providers add`", () => {
  const dispatchConfig = { found: false, config: null };
  assert.throws(() => resolvePool(dispatchConfig, "cheap"), /run `nomarmy agents add api`/);
});

test("resolvePool: a job requesting pool \"__proto__\" gets the normal unknown-pool error, not a crash", () => {
  const dispatchConfig = { found: true, config: { pools: { cheap: [{ id: "local", provider: "llama-cpp", weight: 1 }] } } };
  assert.throws(() => resolvePool(dispatchConfig, "__proto__"), /unknown api agent "__proto__" -- your api agents are: cheap/);
});

test("resolveEntryContext: a llama-cpp entry returns null -- caller must use the local, live-probed number instead", () => {
  assert.equal(resolveEntryContext({ id: "local", provider: "llama-cpp" }), null);
});

test("resolveEntryContext: an explicit context_window override always wins, even with a catalog present", () => {
  const catalog = new Map([["xai/grok-4.7", 999999]]);
  const result = resolveEntryContext({ id: "grok", provider: "xai", model: "grok-4.7", context_window: 500000 }, { catalog });
  assert.equal(result.raw, 500000);
  assert.match(result.source, /override/);
});

test("resolveEntryContext: falls back to the openclaw catalog lookup when no override is set", () => {
  const catalog = new Map([["xai/grok-4.6", 500000]]);
  const result = resolveEntryContext({ id: "grok", provider: "xai", model: "grok-4.6" }, { catalog });
  assert.equal(result.raw, 500000);
  assert.match(result.source, /openclaw model catalog/);
});

test("resolveEntryContext: a model in neither the override nor the catalog gets the conservative fallback, not a crash or an optimistic guess", () => {
  // The exact real situation this shipped for: grok-4.7 released the same
  // day, not yet in OpenClaw's cached catalog.
  const result = resolveEntryContext({ id: "grok", provider: "xai", model: "grok-4.7" }, { catalog: new Map() });
  assert.equal(result.raw, UNKNOWN_MODEL_CONTEXT_FALLBACK);
  assert.match(result.source, /unknown model "xai\/grok-4\.7"/);
});

test("resolveEntryContext: a null catalog (openclaw unreachable) is treated the same as an empty one, not a throw", () => {
  const result = resolveEntryContext({ id: "grok", provider: "xai", model: "grok-4.6" }, { catalog: null });
  assert.equal(result.raw, UNKNOWN_MODEL_CONTEXT_FALLBACK);
});

test("entryContextPerNom: a hosted entry's window is buffered down by CONTEXT_WINDOW_BUFFER, not used raw", () => {
  const result = entryContextPerNom({ id: "grok", provider: "xai", model: "grok-4.6", context_window: 500000 }, {});
  assert.equal(result.contextPerNom, Math.floor(500000 * CONTEXT_WINDOW_BUFFER));
  assert.match(result.source, /buffered to 75%/);
});

test("entryContextPerNom: a llama-cpp entry uses localContextPerNom UNBUFFERED -- it's a live probe, not a rated ceiling", () => {
  const result = entryContextPerNom({ id: "local", provider: "llama-cpp" }, { localContextPerNom: 65536 });
  assert.equal(result.contextPerNom, 65536);
  assert.equal(result.source, "local llama-server");
});

test("entryContextPerNom: a llama-cpp entry with no localContextPerNom known returns null", () => {
  assert.equal(entryContextPerNom({ id: "local", provider: "llama-cpp" }, {}), null);
});

test("poolContextPerNom: takes the MINIMUM buffered window across every available entry, not the first or the max", () => {
  const pool = [
    { id: "big", provider: "xai", model: "grok-4.6", context_window: 1000000, auth_env: "NOMARMY_XAI_API_KEY" },
    { id: "small", provider: "deepinfra", model: "small-model", context_window: 40000, auth_env: "NOMARMY_DEEPINFRA_API_KEY" },
  ];
  const env = { NOMARMY_XAI_API_KEY: "set", NOMARMY_DEEPINFRA_API_KEY: "set" };
  const result = poolContextPerNom(pool, env, {});
  assert.equal(result.contextPerNom, Math.floor(40000 * CONTEXT_WINDOW_BUFFER));
  assert.match(result.source, /pool minimum across 2 available entries/);
});

test("poolContextPerNom: an entry whose auth_env isn't set is excluded from the minimum, same as pickProvider/availableEntries", () => {
  const pool = [
    { id: "unauthed-small", provider: "deepinfra", model: "x", context_window: 1000, auth_env: "NOMARMY_UNSET_KEY" },
    { id: "authed-big", provider: "xai", model: "grok-4.6", context_window: 500000, auth_env: "NOMARMY_XAI_API_KEY" },
  ];
  const env = { NOMARMY_XAI_API_KEY: "set" };
  const result = poolContextPerNom(pool, env, {});
  assert.equal(result.contextPerNom, Math.floor(500000 * CONTEXT_WINDOW_BUFFER));
});

test("poolContextPerNom: a pool with zero available entries returns null (dispatch's own pickProvider raises the real error)", () => {
  const pool = [{ id: "x", provider: "xai", model: "grok-4.6", auth_env: "NOMARMY_UNSET_KEY" }];
  assert.equal(poolContextPerNom(pool, {}, {}), null);
});

test("poolContextPerNom: an all-llama-cpp pool with no localContextPerNom given returns null, letting the caller fall back to the global local budget", () => {
  const pool = [{ id: "local", provider: "llama-cpp" }];
  assert.equal(poolContextPerNom(pool, {}, {}), null);
});

test("poolContextPerNom: a mixed pool correctly weighs a llama-cpp entry's UNBUFFERED local number against a hosted entry's buffered one", () => {
  const pool = [
    { id: "local", provider: "llama-cpp" },
    { id: "grok", provider: "xai", model: "grok-4.6", context_window: 80000, auth_env: "NOMARMY_XAI_API_KEY" },
  ];
  const env = { NOMARMY_XAI_API_KEY: "set" };
  // local: 65536 unbuffered. grok: 80000 * 0.75 = 60000 buffered. grok wins (smaller).
  const result = poolContextPerNom(pool, env, { localContextPerNom: 65536 });
  assert.equal(result.contextPerNom, 60000);
});

// --------------------------------------------------------------------------
// provider: openclaw -- any other OpenClaw provider, by id, without nomArmy
// having to enumerate every vendor OpenClaw supports.
// --------------------------------------------------------------------------

const GENERIC_ENTRY = { id: "ds", provider: "openclaw", openclaw_provider: "deepseek", plugin: "clawhub:@openclaw/deepseek-provider", model: "deepseek-chat", weight: 1, auth_env: "NOMARMY_DEEPSEEK_API_KEY" };

test("provider openclaw: accepts any OpenClaw provider id, with an optional plugin spec", () => {
  const result = dispatchConfigSchema.safeParse({ pools: { cheap: [GENERIC_ENTRY] } });
  assert.equal(result.success, true, JSON.stringify(result.error?.issues));
  const { plugin, ...noPlugin } = GENERIC_ENTRY;
  assert.equal(dispatchConfigSchema.safeParse({ pools: { cheap: [noPlugin] } }).success, true);
});

test("provider openclaw: openclaw_provider is required and must look like a provider id", () => {
  const { openclaw_provider, ...missing } = GENERIC_ENTRY;
  assert.match(formatDispatchIssues(dispatchConfigSchema.safeParse({ pools: { p: [missing] } }).error).join("\n"), /openclaw_provider: is required/);
  assert.equal(dispatchConfigSchema.safeParse({ pools: { p: [{ ...GENERIC_ENTRY, openclaw_provider: "Deep Seek" }] } }).success, false);
  assert.equal(dispatchConfigSchema.safeParse({ pools: { p: [{ ...GENERIC_ENTRY, plugin: "two words" }] } }).success, false);
});

test("provider openclaw: refuses a type that has its own setup (bedrock needs base_url, llama-cpp has no key)", () => {
  for (const id of ["bedrock", "llama-cpp", "openai-compatible", "openclaw"]) {
    assert.equal(dispatchConfigSchema.safeParse({ pools: { p: [{ ...GENERIC_ENTRY, openclaw_provider: id }] } }).success, false, id);
  }
  assert.equal(dispatchConfigSchema.safeParse({ pools: { p: [{ ...GENERIC_ENTRY, openclaw_provider: "xai" }] } }).success, true, "a native id is just a longer way to say it");
});

test("provider openclaw: other types reject openclaw_provider/plugin as unexpected fields", () => {
  const entry = { id: "x", provider: "xai", model: "grok", weight: 1, auth_env: "NOMARMY_XAI_API_KEY", openclaw_provider: "xai" };
  assert.match(formatDispatchIssues(dispatchConfigSchema.safeParse({ pools: { p: [entry] } }).error).join("\n"), /unexpected field/);
});

test("openclawProviderId: the generic type's own id, every other type's provider as-is", () => {
  assert.equal(openclawProviderId(GENERIC_ENTRY), "deepseek");
  assert.equal(openclawProviderId({ provider: "xai" }), "xai");
});

test("resolveEntryContext: a generic entry is looked up in the catalog under its real OpenClaw id", () => {
  const resolved = resolveEntryContext(GENERIC_ENTRY, { catalog: new Map([["deepseek/deepseek-chat", 128000]]) });
  assert.deepEqual(resolved, { raw: 128000, source: "openclaw model catalog (deepseek/deepseek-chat)" });
});

test("resolvePool: a real hit returns that api agent's one-entry pool; a miss names the api agents that exist", () => {
  const config = { found: true, config: { pools: { grok: [{ id: "grok", provider: "xai", model: "grok-4.7", weight: 1, auth_env: "K" }] } } };
  assert.equal(resolvePool(config, "grok")[0].model, "grok-4.7");
  assert.throws(() => resolvePool(config, "nope"), /unknown api agent "nope" -- your api agents are: grok/);
  assert.throws(() => resolvePool(config, "__proto__"), /unknown api agent/);
});
