import "./helpers/isolate-global-config.mjs";
// Tests for lib/openclaw-config.mjs, with a fake OpenClaw home and a fake
// plugin shaped like the Meta plugin's dist/onboard.js.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { ensureProviderConfig, providerConfigured } from "../lib/openclaw-config.mjs";
import { providerConfigIssues } from "../lib/health.mjs";
import { SUBSCRIPTION_VENDORS } from "../lib/subscription-setup.mjs";

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function fakeHome({ config, plugin }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-oc-")); dirs.push(home);
  fs.writeFileSync(path.join(home, "openclaw.json"), JSON.stringify(config));
  if (plugin) { fs.mkdirSync(path.join(home, "extensions", "meta", "dist"), { recursive: true }); fs.writeFileSync(path.join(home, "extensions", "meta", "dist", "onboard.js"), plugin); }
  return home;
}
const META = { provider: "meta", pluginId: "meta", ...SUBSCRIPTION_VENDORS.meta.plugin.providerConfig };
const REAL_SHAPE = `export function applyMetaConfig(c) { return { ...c, models: { ...c.models, providers: { ...(c.models?.providers ?? {}), meta: { baseUrl: "https://api.meta.ai/v1", api: "openai-responses", models: [{ id: "muse-spark-1.3" }] } } } }; }`;

test("ensureProviderConfig: adds the missing Meta entry with the plugin's own step, keeps everything else, backs up first", async () => {
  const before = { models: { providers: { ollama: { baseUrl: "x" } } }, agents: { defaults: {} } };
  const home = fakeHome({ config: before, plugin: REAL_SHAPE });
  const out = await ensureProviderConfig({ ...META, home });
  assert.equal(out.changed, true);
  const after = JSON.parse(fs.readFileSync(path.join(home, "openclaw.json"), "utf8"));
  assert.deepEqual(Object.keys(after.models.providers), ["ollama", "meta"]);
  assert.equal(after.models.providers.meta.baseUrl, "https://api.meta.ai/v1");
  assert.deepEqual(after.agents, before.agents);
  assert.deepEqual(JSON.parse(fs.readFileSync(out.backup, "utf8")), before);
});

test("ensureProviderConfig: an existing entry is left alone, the plugin isn't even loaded", async () => {
  const config = { models: { providers: { meta: { baseUrl: "mine" } } } };
  const home = fakeHome({ config, plugin: "throw new Error('must not load')" });
  assert.deepEqual(await ensureProviderConfig({ ...META, home }), { changed: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "openclaw.json"), "utf8")), config);
});

test("ensureProviderConfig: refuses, and writes nothing, when the step would drop a section or add no entry", async () => {
  const config = { models: { providers: {} }, gateway: { port: 1 } };
  const dropping = fakeHome({ config, plugin: `export const applyMetaConfig = () => ({ models: { providers: { meta: {} } } });` });
  assert.match((await ensureProviderConfig({ ...META, home: dropping })).error, /would remove gateway/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dropping, "openclaw.json"), "utf8")), config);
  const noop = fakeHome({ config, plugin: `export const applyMetaConfig = (c) => c;` });
  assert.match((await ensureProviderConfig({ ...META, home: noop })).error, /didn't add a meta provider entry/);
  const missing = fakeHome({ config });
  assert.match((await ensureProviderConfig({ ...META, home: missing })).error, /couldn't load the meta plugin's config step/);
});

test("providerConfigIssues: a Meta subscription agent with no provider entry is flagged; configured or unused is not", () => {
  const agents = { meta: { kind: "subscription", provider: "meta" }, codex: { kind: "subscription", provider: "openai" } };
  const issues = providerConfigIssues({ agents, openclawConfig: { models: { providers: {} } }, vendors: SUBSCRIPTION_VENDORS });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].id, "provider-config:meta");
  assert.match(issues[0].fix, /nomarmy agents add subscription meta/);
  assert.equal(providerConfigIssues({ agents, openclawConfig: { models: { providers: { meta: {} } } }, vendors: SUBSCRIPTION_VENDORS }).length, 0);
  assert.equal(providerConfigIssues({ agents: { codex: agents.codex }, openclawConfig: {}, vendors: SUBSCRIPTION_VENDORS }).length, 0);
  assert.equal(providerConfigured({ models: { providers: { meta: {} } } }, "meta"), true);
});
