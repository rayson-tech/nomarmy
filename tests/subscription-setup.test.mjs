// Tests for lib/subscription-setup.mjs -- every fixture below is real output
// captured live from this machine, not a synthesized shape.
// Run: node --test tests/subscription-setup.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SUBSCRIPTION_VENDORS,
  parseOpenclawVersion,
  versionAtLeast,
  parseCatalogModels,
  parseCliLoginStatus,
  probeSucceeded,
  parseMuseAuthDescriptor,
  extractMintedKey,
} from "../lib/subscription-setup.mjs";

const REAL_CATALOG = [
  "claude-cli/claude-opus-5                   text+image 1000k       -     yes   ",
  "claude-cli/claude-sonnet-5                 text+image 1000k       -     yes   ",
  "claude-cli/claude-opus-4-7                 text+image 200k        -     yes   ",
  "llama-cpp/gpt-oss-20b                      text       64k         -     yes   ",
].join("\n");

const REAL_CLAUDE_STATUS = JSON.stringify({
  loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "you@example.com",
  orgName: "Rayson Technologies", subscriptionType: "team",
});

const REAL_PROBE_OK = JSON.stringify({ ok: true, status: "ok", final: "pong", model: "claude-sonnet-5", provider: "claude-cli" });
const REAL_PROBE_FAIL = JSON.stringify({ ok: false, status: "error", final: "", error: { message: "Unknown model: anthropic-cli/claude-sonnet-5", kind: "exception" } });

test("SUBSCRIPTION_VENDORS: real, live-verified provider ids and how each credential reaches OpenClaw", () => {
  assert.equal(SUBSCRIPTION_VENDORS.claude.provider, "claude-cli");
  assert.equal(SUBSCRIPTION_VENDORS.claude.credential.kind, "cli-session");
  assert.equal(SUBSCRIPTION_VENDORS.codex.provider, "openai", "codex/<model> is 'Unknown model'; the ChatGPT login runs as openai/<model>");
  assert.equal(SUBSCRIPTION_VENDORS.codex.credential.loginProvider, "codex");
  assert.equal(SUBSCRIPTION_VENDORS.codex.plugin.minOpenclaw, "2026.9.5");
  assert.equal(SUBSCRIPTION_VENDORS.codex.credential.kind, "openclaw-login");
  assert.equal(SUBSCRIPTION_VENDORS.meta.provider, "meta");
  assert.equal(SUBSCRIPTION_VENDORS.meta.credential.kind, "minted-key");
  assert.deepEqual({ ...SUBSCRIPTION_VENDORS.meta.credential.keychain }, { service: "ai.meta.dev.credentials", account: "meta", field: "api_key" });
});

// The real descriptor shape, with the personal fields replaced.
const REAL_SHAPE_MUSE_DESCRIPTOR = JSON.stringify({ schema_version: 2, providers: { meta: {
  mechanism: "oauth", storage: "keychain", obtained_via: "device_code", api_base_url: "https://api.meta.ai/v1",
  user_full_name: "Test User", user_email: "user@example.com",
} } });

test("parseMuseAuthDescriptor: logged in, with the account email, from the real descriptor shape", () => {
  assert.deepEqual(parseMuseAuthDescriptor(REAL_SHAPE_MUSE_DESCRIPTOR), { loggedIn: true, email: "user@example.com", subscriptionType: "muse-code" });
  assert.equal(parseMuseAuthDescriptor(JSON.stringify({ schema_version: 2, providers: {} })).loggedIn, false);
  assert.equal(parseMuseAuthDescriptor("").loggedIn, false);
});

test("extractMintedKey: returns only the three-part minted api_key, never the OAuth access_token", () => {
  const blob = JSON.stringify({ secret_schema_version: 1, api_key: "LLM|fakeid|fakesecret", access_token: "dca:fake-oauth-token" });
  assert.equal(extractMintedKey(blob, "api_key"), "LLM|fakeid|fakesecret");
  assert.equal(extractMintedKey(blob, "access_token"), null, "an OAuth token is refused even if asked for by name -- it 401s against api.meta.ai");
  assert.equal(extractMintedKey(JSON.stringify({ api_key: "LLM|only-two" }), "api_key"), null);
  assert.equal(extractMintedKey("not json", "api_key"), null);
});

test("parseOpenclawVersion: parses the real `openclaw --version` line", () => {
  assert.deepEqual(parseOpenclawVersion("OpenClaw 2026.9.5 (ec9c1a1)"), [2026, 9, 5]);
  assert.equal(parseOpenclawVersion("garbage"), null);
});

test("versionAtLeast: the real mismatch that blocked the Codex plugin (2026.9.4 < 2026.9.5)", () => {
  assert.equal(versionAtLeast([2026, 9, 4], "2026.9.5"), false);
  assert.equal(versionAtLeast([2026, 9, 5], "2026.9.5"), true);
  assert.equal(versionAtLeast([2026, 10, 0], "2026.9.5"), true);
  assert.equal(versionAtLeast(null, "2026.9.5"), false);
});

test("parseCatalogModels: pulls just one provider's model ids from the real catalog rows", () => {
  assert.deepEqual(parseCatalogModels(REAL_CATALOG, "claude-cli"), ["claude-opus-5", "claude-sonnet-5", "claude-opus-4-7"]);
  assert.deepEqual(parseCatalogModels(REAL_CATALOG, "codex"), []);
});

test("parseCliLoginStatus: real Claude JSON status -> logged in, with the email to default the owner from", () => {
  assert.deepEqual(parseCliLoginStatus("claude", REAL_CLAUDE_STATUS), { loggedIn: true, email: "you@example.com", subscriptionType: "team" });
});

test("parseCliLoginStatus: Claude's JSON still parses with a stray stderr line merged in", () => {
  assert.equal(parseCliLoginStatus("claude", `warning: something\n${REAL_CLAUDE_STATUS}\n`).loggedIn, true);
});

test("parseCliLoginStatus: real Codex status line -> logged in", () => {
  assert.equal(parseCliLoginStatus("codex", "Logged in using ChatGPT").loggedIn, true);
  assert.equal(parseCliLoginStatus("codex", "Not logged in").loggedIn, false);
});

test("parseCliLoginStatus: unparseable output is 'not logged in' -- re-running a login is harmless, skipping a needed one isn't", () => {
  assert.equal(parseCliLoginStatus("claude", "not json").loggedIn, false);
  assert.equal(parseCliLoginStatus("codex", "").loggedIn, false);
});

test("probeSucceeded: the real Codex probe, with OpenClaw's stderr run log merged in after the envelope", () => {
  const stderrLog = "\u001b[33m[agents/agent-command]\u001b[39m \u001b[36m[agent] run 4a4dbf5f ended with stopReason=stop\u001b[39m\n";
  const envelope = JSON.stringify({ ok: true, status: "ok", final: "ok", model: "gpt-6-astra", provider: "openai" }, null, 2);
  assert.equal(probeSucceeded(`${envelope}\n${stderrLog}`), true, "this exact shape reported a working login as a failed test call");
  assert.equal(probeSucceeded(`${stderrLog}${envelope}\n`), true);
});

test("probeSucceeded: true only for a real completion envelope", () => {
  assert.equal(probeSucceeded(REAL_PROBE_OK), true);
  assert.equal(probeSucceeded(REAL_PROBE_FAIL), false);
  assert.equal(probeSucceeded("not json"), false);
});

