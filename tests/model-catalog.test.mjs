// Tests for OpenClaw model catalog reads (lib/model-catalog.mjs).
// Run: node --test tests/model-catalog.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

import { queryModelCatalog } from "../lib/model-catalog.mjs";

// A real shape of `openclaw models list --all --json`, trimmed -- captured
// live during this feature's own development (see xai/grok-4.6 in this
// fixture: verified against a real `openclaw models list --all --json` run).
const REAL_SHAPED_OUTPUT = JSON.stringify({
  count: 3,
  models: [
    { key: "xai/grok-4.6", name: "Grok 4.6", input: "text+image", contextWindow: 500000, local: false, available: null, tags: [] },
    { key: "openai/gpt-4o-mini", name: "GPT-4o mini", input: "text+image", contextWindow: 128000, local: false, available: null, tags: [] },
    // A real entry from the same live capture: contextWindow can genuinely
    // be null (not yet cataloged by OpenClaw's own discovery) -- must be
    // skipped, not coerced into 0 or NaN.
    { key: "openai/gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark", input: "text", contextWindow: null, local: false, available: null, tags: [] },
  ],
});

test("queryModelCatalog: parses a real-shaped openclaw response into a key -> contextWindow Map", () => {
  const catalog = queryModelCatalog({ run: () => REAL_SHAPED_OUTPUT });
  assert.equal(catalog.get("xai/grok-4.6"), 500000);
  assert.equal(catalog.get("openai/gpt-4o-mini"), 128000);
});

test("queryModelCatalog: a null contextWindow entry is skipped, not coerced into a false number", () => {
  const catalog = queryModelCatalog({ run: () => REAL_SHAPED_OUTPUT });
  assert.equal(catalog.has("openai/gpt-5.3-codex-spark"), false);
});

test("queryModelCatalog: a model not in the catalog simply isn't a key -- callers must not assume presence", () => {
  const catalog = queryModelCatalog({ run: () => REAL_SHAPED_OUTPUT });
  assert.equal(catalog.has("xai/grok-4.7"), false, "grok-4.7 is newer than this captured fixture, same as OpenClaw's real cache the day this shipped");
});

test("queryModelCatalog: openclaw not installed/on PATH returns null, never throws", () => {
  const catalog = queryModelCatalog({ run: () => { throw new Error("ENOENT"); } });
  assert.equal(catalog, null);
});

test("queryModelCatalog: unparseable stdout (a stray notice line leaking onto stdout, a truncated response) returns null, never throws", () => {
  const catalog = queryModelCatalog({ run: () => "Gateway is not running.\n{not json" });
  assert.equal(catalog, null);
});

test("queryModelCatalog: an empty/malformed models array returns an empty Map, not a crash", () => {
  const catalog = queryModelCatalog({ run: () => JSON.stringify({ count: 0 }) });
  assert.equal(catalog.size, 0);
});

test("queryModelCatalog: passes the real openclaw binary name and the exact expected argv", () => {
  let capturedCmd, capturedArgs;
  queryModelCatalog({ openclawCmd: "openclaw", run: (cmd, args) => { capturedCmd = cmd; capturedArgs = args; return REAL_SHAPED_OUTPUT; } });
  assert.equal(capturedCmd, "openclaw");
  assert.deepEqual(capturedArgs, ["models", "list", "--all", "--json"]);
});
