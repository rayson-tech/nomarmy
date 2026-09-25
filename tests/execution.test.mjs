import "./helpers/isolate-global-config.mjs";
// Tests for lib/execution.mjs: where an install's models run.
import assert from "node:assert/strict";
import { test } from "node:test";

import { executionMode, isLoopbackHost, parseLlamaUrl } from "../lib/execution.mjs";

test("executionMode: local by default; a non-loopback llama host is remote; hosted and bedrock have no local model", () => {
  assert.deepEqual(executionMode({}), { mode: "local", hasLocalModel: true, managesModelServer: true, llamaHost: "127.0.0.1", llamaPort: "8080", llamaUrl: "http://127.0.0.1:8080" });
  const remote = executionMode({ NOMARMY_LLAMA_HOST: "dgx.internal", NOMARMY_LLAMA_PORT: "9000" });
  assert.equal(remote.mode, "remote");
  assert.equal(remote.hasLocalModel, true);
  assert.equal(remote.managesModelServer, false, "nomArmy neither starts nor sizes someone else's server");
  assert.equal(remote.llamaUrl, "http://dgx.internal:9000");
  assert.equal(executionMode({ NOMARMY_LLAMA_HOST: "localhost" }).mode, "local");
  // An SSH tunnel to a GPU server is loopback but not nomArmy's to run.
  const tunnel = executionMode({ NOMARMY_EXECUTION: "remote", NOMARMY_LLAMA_HOST: "127.0.0.1", NOMARMY_LLAMA_PORT: "18080" });
  assert.deepEqual([tunnel.mode, tunnel.hasLocalModel, tunnel.managesModelServer, tunnel.llamaUrl], ["remote", true, false, "http://127.0.0.1:18080"]);
  assert.equal(executionMode({ NOMARMY_LLAMA_HOST: "fd00::5" }).llamaUrl, "http://[fd00::5]:8080");
  for (const mode of ["hosted", "bedrock"]) {
    const m = executionMode({ NOMARMY_EXECUTION: mode, NOMARMY_LLAMA_HOST: "dgx.internal" });
    assert.deepEqual([m.mode, m.hasLocalModel, m.managesModelServer, m.llamaUrl], [mode, false, false, null]);
  }
  assert.equal(executionMode({ NOMARMY_EXECUTION: " Hosted " }).mode, "hosted");
});

test("isLoopbackHost: this machine's names and addresses only", () => {
  for (const h of ["127.0.0.1", "127.0.1.1", "localhost", "::1", "", "0.0.0.0"]) assert.equal(isLoopbackHost(h), true, h);
  for (const h of ["10.0.0.5", "dgx.internal", "fd00::5", "192.168.1.20"]) assert.equal(isLoopbackHost(h), false, h);
});

test("parseLlamaUrl: http host and port, defaulting to 8080; refuses anything else with a clear reason", () => {
  assert.deepEqual(parseLlamaUrl("http://dgx.internal:8081"), { host: "dgx.internal", port: "8081" });
  assert.deepEqual(parseLlamaUrl("http://10.0.0.5"), { host: "10.0.0.5", port: "8080" });
  assert.deepEqual(parseLlamaUrl(" http://[fd00::5]:9000/ "), { host: "fd00::5", port: "9000" });
  assert.throws(() => parseLlamaUrl("dgx:8080"), /use an http:\/\/ URL|isn't a URL/);
  assert.throws(() => parseLlamaUrl("https://dgx:8080"), /use an http:\/\/ URL/);
  assert.throws(() => parseLlamaUrl("http://u:p@dgx:8080"), /username or password/);
  assert.throws(() => parseLlamaUrl("http://dgx:8080/v1"), /without a path/);
  assert.throws(() => parseLlamaUrl("not a url"), /isn't a URL/);
});
