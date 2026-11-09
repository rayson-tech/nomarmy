import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliFile = fileURLToPath(new URL("../bin/nomarmy.mjs", import.meta.url));
// The CLI asks for WSL on native Windows, as tests/cli.test.mjs notes.
const posixOnly = { skip: process.platform === "win32" ? "the nomarmy CLI runs under WSL on Windows" : false };

// A fake openclaw that refuses `models auth` the way OpenClaw 2026.11 does
// while its Gateway runs, answers `models status`, and logs every call.
function fakeOpenclaw(dir) {
  const log = path.join(dir, "calls.log");
  const script = path.join(dir, "openclaw");
  fs.writeFileSync(script, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, args.join(" ") + "\\n");
if (args[0] === "models" && args[1] === "auth") {
  process.stdout.write(JSON.stringify({ ok: false, error: { type: "cli_error", message: "Cannot admit models.auth: This operation requires exclusive offline state ownership." } }));
  process.exit(1);
}
if (args[0] === "models" && args[1] === "status") {
  process.stdout.write(JSON.stringify({ auth: { oauth: { profiles: [{ profileId: "xai:nomarmy", provider: "xai", type: "api_key", label: "xai:nomarmy", status: "static" }] } } }));
  process.exit(0);
}
process.exit(1);
`, { mode: 0o755 });
  return { script, calls: () => fs.readFileSync(log, "utf8").trim().split("\n") };
}

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-state-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "agents.yml"), "agents:\n  grok:\n    kind: api\n    provider: xai\n    auth_env: FAKE_XAI_KEY\n  oai:\n    kind: api\n    provider: openai\n    auth_env: FAKE_DEEP_KEY\n", { mode: 0o600 });
  const fake = fakeOpenclaw(dir);
  const run = (...args) => spawnSync(process.execPath, [cliFile, ...args], {
    encoding: "utf8", input: "",
    env: { ...process.env, NOMARMY_CONFIG_DIR: dir, NOMARMY_AGENT_STATE: path.join(dir, "state"), NOMARMY_OPENCLAW_CMD: fake.script, FAKE_DEEP_KEY: "k" },
  });
  return { run, fake };
}

test("agents register: with the Gateway holding OpenClaw's state, saved keys are read from models status, and a new key isn't attempted without stopping it", posixOnly, (t) => {
  const { run, fake } = setup(t);
  const result = run("agents", "register");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /grok: key already saved in OpenClaw/, "read through models status");
  assert.match(result.stderr, /Stop it first: openclaw gateway stop --force, run this again, then openclaw gateway start/);
  const calls = fake.calls();
  assert.ok(calls.includes("models status --json"));
  assert.ok(!calls.some((c) => c.startsWith("models auth paste-api-key")), "no write was attempted");
  assert.ok(!calls.some((c) => c.startsWith("gateway")), "never stops the Gateway without asking");
});

test("agents add --json --register: with the Gateway holding OpenClaw's state, stdout stays JSON and stderr says how to proceed", posixOnly, (t) => {
  const { run, fake } = setup(t);
  const result = run("agents", "add", "api", "--json", "--name", "oai2", "--provider", "openai", "--auth-env", "FAKE_DEEP_KEY", "--register");
  const out = JSON.parse(result.stdout);
  assert.equal(out.registered, false);
  assert.match(result.stderr, /Stop it first: openclaw gateway stop --force/);
  assert.ok(!fake.calls().some((c) => c.startsWith("models auth paste-api-key") || c.startsWith("gateway")));
});
