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

test("a job whose model is missing waits longer for a refresh already running", async () => {
  let finish;
  const config = createAgentConfig({
    projectDir: process.cwd(),
    queryCatalog: () => new Map(),
    queryCatalogAsync: () => new Promise((resolve) => { finish = resolve; }),
    now: () => 11 * 60 * 1000,
    missingModelWaitMs: 2000,
  });
  const ready = config.modelCatalogReady(10, ["openai/gpt-6-astra"]);
  setTimeout(() => finish(new Map([["openai/gpt-6-astra", 872000]])), 100);
  assert.equal((await ready).get("openai/gpt-6-astra"), 872000, "past the 10ms wait, within the missing-model one");
});
