import "./helpers/isolate-global-config.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const expected = (validator, vendor) => `Adding ${validator} also turns on nomArmy's trust judgment in every repository: each implement job's diff, and its brief at dispatch, is sent to ${vendor} to check for security-sensitive changes (access control, removed checks, personal data, secrets, money). It can only raise a job's review level. Turn it off for a repository with trust: { judgment: false } in its .nomarmy.yml.`;
const jevText = expected("Jev", "TypeSafe");
const judgeText = expected("the judge", "Anthropic");
const cli = path.resolve("bin/nomarmy.mjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.resolve(".validator-disclosure-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDir = path.join(root, "config");
  fs.mkdirSync(configDir);
  fs.writeFileSync(path.join(configDir, "agents.yml"), "agents:\n  claude:\n    kind: subscription\n    provider: claude-cli\n    owner: me\n    model: sonnet\n", { mode: 0o600 });
  const preload = path.join(root, "preload.mjs");
  // Stub only external calls and terminal input. Execute the real CLI, config
  // saves and output. Assert disclosure has been shown before ANY saved write.
  fs.writeFileSync(preload, `
import assert from "node:assert/strict";
import fs from "node:fs";
import cp from "node:child_process";
import readline from "node:readline/promises";
import { syncBuiltinESMExports } from "node:module";
let output = "";
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream);
  stream.write = (chunk, ...args) => { output += String(chunk); return write(chunk, ...args); };
}
const before = "Before saving: " + process.env.EXPECTED_DISCLOSURE;
const originalWrite = fs.writeFileSync;
fs.writeFileSync = (file, ...args) => {
  if (/validators\\.yml$|typesafe\\.key$/.test(String(file))) {
    assert.equal(output.includes(before), true, "disclosure must precede saving config or key");
  }
  return originalWrite(file, ...args);
};
Object.defineProperty(process.stdin, "isTTY", { value: process.env.TEST_INTERACTIVE === "1" });
readline.createInterface = () => ({
  question: async (prompt) => {
    assert.equal(output.includes(before), true, "disclosure must precede key or host-tools consent prompt");
    process.stdout.write(prompt + "\\n");
    return prompt.startsWith("TypeSafe") ? "fixture-key" : "yes";
  },
  close() {},
});
cp.spawnSync = (file) => { assert.equal(file, "stty"); return { status: 0 }; };
cp.execFile = (file, args, opts, callback) => {
  assert.equal(file, "fixture-openclaw");
  callback(null, JSON.stringify({ ok: true, status: "ok", final: "ok" }), "");
};
globalThis.fetch = async (url) => {
  assert.equal(url, "https://api.typesafe.ai/v1/systemone");
  return { ok: true, status: 200, json: async () => ({ answers: { passed: { noul: 1 } } }) };
};
syncBuiltinESMExports();
`);
  const run = (args, { interactive = false, disclosure = "" } = {}) => spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, cli, "validators", ...args], {
    cwd: root, encoding: "utf8", input: "fixture-key\n",
    env: { ...process.env, NOMARMY_CONFIG_DIR: configDir, NOMARMY_AGENT_STATE: path.join(root, "state"), NOMARMY_OPENCLAW_CMD: "fixture-openclaw", NO_COLOR: "1", TEST_INTERACTIVE: interactive ? "1" : "0", EXPECTED_DISCLOSURE: disclosure },
  });
  return { configDir, run };
}

for (const validator of ["jev", "judge"]) {
  for (const mode of ["interactive", "non-interactive", "json"]) {
    test(`validators add ${validator} discloses trust before saving and after in ${mode} mode`, (t) => {
      const { configDir, run } = fixture(t);
      const interactive = mode === "interactive", json = mode === "json";
      const disclosure = validator === "jev" ? jevText : judgeText;
      const args = validator === "jev" ? (interactive ? [] : ["--key-stdin"]) : ["--agent", "claude", "--model", "sonnet", ...(interactive ? [] : ["--host-tools"])];
      const result = run(["add", validator, ...args, ...(json ? ["--json"] : [])], { interactive, disclosure });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(fs.existsSync(path.join(configDir, "validators.yml")), true);
      if (json) {
        assert.equal(result.stderr, `Before saving: ${disclosure}\n`);
        assert.deepEqual(JSON.parse(result.stdout), {
          saved: true, configPath: path.join(configDir, "validators.yml"),
          ...(validator === "jev" ? { keyFile: path.join(configDir, "secrets", "typesafe.key") } : {}),
          test: "pass", reason: null, trustJudgment: disclosure,
        });
      } else {
        assert.equal(result.stderr, "");
        assert.equal(result.stdout.split(disclosure).length - 1, 2);
        assert.equal(result.stdout.includes(`Before saving: ${disclosure}\n`), true);
        const success = validator === "jev"
          ? `✓ Saved the key to ${path.join(configDir, "secrets", "typesafe.key")} (readable only by you) and turned Jev on in ${path.join(configDir, "validators.yml")}. ${disclosure}`
          : `✓ The judge is claude/sonnet, in ${path.join(configDir, "validators.yml")}. ${disclosure}`;
        assert.equal(result.stdout.split("\n").includes(success), true);
        if (interactive) assert.equal(result.stdout.includes(validator === "jev" ? "TypeSafe API key (not shown): " : "Allow claude to run as a judge with tools on this machine? [y/N] "), true);
      }
    });
  }
}

for (const json of [false, true]) {
  test(`validators list discloses each validator's trust judgment in ${json ? "JSON" : "text"}`, (t) => {
    const { configDir, run } = fixture(t);
    fs.writeFileSync(path.join(configDir, "validators.yml"), "jev:\n  enabled: true\n  key_env: NOMARMY_DISCLOSURE_MISSING_KEY\njudge:\n  enabled: true\n  agent: claude\n  model: sonnet\n  host_tools: true\n");
    const result = run(["list", ...(json ? ["--json"] : [])]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    if (json) {
      assert.deepEqual(JSON.parse(result.stdout), {
        path: path.join(configDir, "validators.yml"),
        jev: { enabled: true, checks: ["scout-citations", "report-claims"], model: "jev-latest", key: "env NOMARMY_DISCLOSURE_MISSING_KEY", keyReadable: false, trustJudgment: jevText },
        judge: { enabled: true, agent: "claude", model: "sonnet", checks: ["acceptance", "report-claims", "test-weakening"], hostTools: true, trustJudgment: judgeText },
      });
    } else {
      assert.equal(result.stdout, `Jev: on (jev-latest); checks: scout-citations, report-claims; key: env NOMARMY_DISCLOSURE_MISSING_KEY (not readable)\n  Also drives the trust judgment. ${jevText}\nJudge: on (claude/sonnet); checks: acceptance, report-claims, test-weakening; host tools allowed\n  Also drives the trust judgment. ${judgeText}\n`);
    }
  });
}
