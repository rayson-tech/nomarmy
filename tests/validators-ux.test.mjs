import "./helpers/isolate-global-config.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { chooseJudgeAgent, confirmJudgeHostTools, judgeAgentChoices, saveJudge, validatorsPath } from "../lib/validators.mjs";

const agents = {
  local: { kind: "local" },
  claude: { kind: "subscription", provider: "claude-cli", owner: "me", model: "sonnet" },
  codex: { kind: "subscription", provider: "openai-codex", owner: "me", model: "gpt" },
  grok: { kind: "api", provider: "xai", auth_env: "XAI_API_KEY", model: "grok" },
};
const providerOf = (agent) => agent.provider;
const runsOnHost = (agent) => agent.provider === "claude-cli";

test("guided judge agents put independent choices first and re-ask empty and invalid choices", async () => {
  const roles = {
    senior: { phase: "build", agent: "claude" },
    junior: { phase: "build", agent: "claude" },
    reviewer: { phase: "review", agent: "grok" },
  };
  const result = judgeAgentChoices({ agents, roles, providerOf, runsOnHost });
  assert.deepEqual(Object.keys(result).sort(), ["choices", "dominantBuilderVendor"]);
  assert.deepEqual(result.choices.map((choice) => choice.name), ["codex", "grok", "claude"]);
  assert.equal(result.dominantBuilderVendor, "claude-cli");
  const answers = ["", "9", "2"];
  const lines = [];
  const picked = await chooseJudgeAgent({ choices: result.choices, ask: async () => answers.shift(), write: (line) => lines.push(line) });
  assert.deepEqual(Object.keys(picked).sort(), ["agent", "hostTools", "name", "sharesBuilderVendor", "vendor"]);
  assert.equal(picked.name, "grok");
  assert.deepEqual(lines, [
    "Configured judge agents:",
    "  1. codex (independent of your builders)",
    "  2. grok (independent of your builders)",
    "  3. claude (runs tools on this machine) (same vendor as builders; verdicts are not independent)",
    "Choose a number from 1 to 3.",
    "Choose a number from 1 to 3.",
  ]);
});

test("host-tools consent saves on yes and default no writes no validators file", async (t) => {
  const yesDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-consent-yes-"));
  const noDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-consent-no-"));
  t.after(() => { fs.rmSync(yesDir, { recursive: true, force: true }); fs.rmSync(noDir, { recursive: true, force: true }); });
  const lines = [];
  const yes = await confirmJudgeHostTools({ agent: "claude", ask: async () => "yes", write: (line) => lines.push(line) });
  if (yes) saveJudge({ agent: "claude", model: "sonnet", hostTools: true }, { configDir: yesDir });
  assert.equal(yes, true);
  assert.equal(fs.existsSync(validatorsPath(yesDir)), true);
  const no = await confirmJudgeHostTools({ agent: "claude", ask: async () => "", write: () => {} });
  if (no) saveJudge({ agent: "claude", model: "sonnet", hostTools: true }, { configDir: noDir });
  assert.equal(no, false);
  assert.equal(fs.existsSync(validatorsPath(noDir)), false);
  assert.deepEqual(lines, [
    "The judge's model can run commands on this machine as you, outside the sandbox, while reading text a worker wrote.",
    "Alternatively, use a sandboxed agent such as an api key, Codex or Muse.",
  ]);
});

test("non-TTY host-tools refusal includes the exact rerun command", (t) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-refusal-"));
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));
  const agentsFile = path.join(configDir, "agents.yml");
  fs.writeFileSync(agentsFile, "agents:\n  claude:\n    kind: subscription\n    provider: claude-cli\n    owner: me\n    model: sonnet\n", { mode: 0o600 });
  const cli = path.resolve("bin/nomarmy.mjs");
  const result = spawnSync(process.execPath, [cli, "validators", "add", "judge", "--agent", "claude", "--model", "sonnet"], {
    cwd: path.resolve("."), env: { ...process.env, NOMARMY_CONFIG_DIR: configDir, NO_COLOR: "1" }, encoding: "utf8", input: "",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Re-run: nomarmy validators add judge --agent claude --model sonnet --host-tools/);
  assert.equal(fs.existsSync(validatorsPath(configDir)), false);
});
