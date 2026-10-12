import "./helpers/isolate-global-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import { createAgentConfig } from "../lib/agent-config.mjs";

test("a job's model missing from the catalog refreshes it, at most every ten minutes", async () => {
  let clock = 0, refreshes = 0;
  const catalogs = [new Map([["openai/gpt-6-sol", 400000]]), new Map([["openai/gpt-6-sol", 400000], ["openai/gpt-6.1-sol", 872000]])];
  const config = createAgentConfig({
    projectDir: process.cwd(),
    queryCatalog: () => catalogs[0],
    queryCatalogAsync: async () => { refreshes += 1; return catalogs[1]; },
    now: () => clock,
  });
  clock = 11 * 60 * 1000;
  assert.equal((await config.modelCatalogReady(1000, ["openai/gpt-6-sol"])).has("openai/gpt-6.1-sol"), false);
  assert.equal(refreshes, 0, "a known model does not refresh");
  assert.equal((await config.modelCatalogReady(1000, ["openai/gpt-6.1-sol"])).get("openai/gpt-6.1-sol"), 872000);
  assert.equal(refreshes, 1);
  await config.modelCatalogReady(1000, ["openai/not-listed"]);
  assert.equal(refreshes, 1, "a model OpenClaw doesn't list waits out the interval");
  clock += 10 * 60 * 1000;
  await config.modelCatalogReady(1000, ["openai/not-listed"]);
  assert.equal(refreshes, 2);
});
