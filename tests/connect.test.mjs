import "./helpers/isolate-global-config.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  installMcpCopy, connectClaude, connectCodex, connectCursor, defaultInstallDir, parseClaudeEnv,
  readCursorConfig, cursorAlreadyConnected, deriveWorkerModelEnv, derivePoolAuthEnvPlaceholders,
} from "../lib/connect.mjs";

function fakeRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-connect-root-"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"nomarmy"}');
  fs.mkdirSync(path.join(dir, "mcp"), { recursive: true });
  fs.writeFileSync(path.join(dir, "mcp", "server.mjs"), "// fake server");
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  fs.writeFileSync(path.join(dir, "lib", "verify.mjs"), "// fake lib file");
  return dir;
}

test("defaultInstallDir: honors NOMARMY_AGENT_INSTALL_DIR, otherwise falls back under the home directory", () => {
  const prev = process.env.NOMARMY_AGENT_INSTALL_DIR;
  try {
    process.env.NOMARMY_AGENT_INSTALL_DIR = "/custom/path";
    assert.equal(defaultInstallDir(), "/custom/path");
    delete process.env.NOMARMY_AGENT_INSTALL_DIR;
    assert.match(defaultInstallDir(), /nomarmy-local-worker$/);
  } finally {
    if (prev === undefined) delete process.env.NOMARMY_AGENT_INSTALL_DIR; else process.env.NOMARMY_AGENT_INSTALL_DIR = prev;
  }
});

test("installMcpCopy: copies package.json, mcp/server.mjs and lib/ into installDir, then runs npm install and a syntax check", () => {
  const nomarmyRoot = fakeRoot();
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-connect-install-"));
  const calls = [];
  try {
    installMcpCopy({ nomarmyRoot, installDir, run: (cmd, args, opts) => calls.push({ cmd, args, cwd: opts?.cwd }) });
    assert.equal(fs.readFileSync(path.join(installDir, "package.json"), "utf8"), '{"name":"nomarmy"}');
    assert.equal(fs.readFileSync(path.join(installDir, "mcp", "server.mjs"), "utf8"), "// fake server");
    assert.equal(fs.readFileSync(path.join(installDir, "lib", "verify.mjs"), "utf8"), "// fake lib file");
    assert.deepEqual(calls[0], { cmd: "npm", args: ["install", "--omit=dev"], cwd: installDir });
    assert.equal(calls[1].args[0], "--check");
    assert.equal(calls[1].cwd, installDir);
  } finally {
    fs.rmSync(nomarmyRoot, { recursive: true, force: true });
    fs.rmSync(installDir, { recursive: true, force: true });
  }
});

test("installMcpCopy: removes a stale lockfile before npm install, so updates resolve dependencies fresh", () => {
  const nomarmyRoot = fakeRoot();
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-connect-install-"));
  // An earlier install's lockfile pinned a vulnerable SDK the range still allowed.
  fs.writeFileSync(path.join(installDir, "package-lock.json"), '{"packages":{"node_modules/@modelcontextprotocol/sdk":{"version":"1.30.1"}}}');
  let lockAtInstall = null;
  try {
    installMcpCopy({ nomarmyRoot, installDir, run: (cmd, args, opts) => {
      if (cmd === "npm") lockAtInstall = fs.existsSync(path.join(opts.cwd, "package-lock.json"));
    } });
    assert.equal(lockAtInstall, false, "npm install must not see the old lockfile");
  } finally {
    fs.rmSync(nomarmyRoot, { recursive: true, force: true });
    fs.rmSync(installDir, { recursive: true, force: true });
  }
});

test("installMcpCopy: also copies docker/ so a lazy Go/Rust image build works from the installed copy", () => {
  const nomarmyRoot = fakeRoot();
  fs.mkdirSync(path.join(nomarmyRoot, "docker"), { recursive: true });
  fs.writeFileSync(path.join(nomarmyRoot, "docker", "Dockerfile.go"), "FROM node:24-bookworm-slim\n");
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-connect-install-"));
  try {
    installMcpCopy({ nomarmyRoot, installDir, run: () => {} });
    assert.equal(
      fs.readFileSync(path.join(installDir, "docker", "Dockerfile.go"), "utf8"),
      "FROM node:24-bookworm-slim\n",
    );
  } finally {
    fs.rmSync(nomarmyRoot, { recursive: true, force: true });
    fs.rmSync(installDir, { recursive: true, force: true });
  }
});

test("installMcpCopy: no docker/ in nomarmyRoot is fine, not an error (older checkout, or a test fixture)", () => {
  const nomarmyRoot = fakeRoot();
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-connect-install-"));
  try {
    installMcpCopy({ nomarmyRoot, installDir, run: () => {} });
    assert.equal(fs.existsSync(path.join(installDir, "docker")), false);
  } finally {
    fs.rmSync(nomarmyRoot, { recursive: true, force: true });
    fs.rmSync(installDir, { recursive: true, force: true });
  }
});

test("installMcpCopy: also copies config/ so mcp/server.mjs can find config/providers.yml in the installed copy", () => {
  const nomarmyRoot = fakeRoot();
  fs.mkdirSync(path.join(nomarmyRoot, "config"), { recursive: true });
  fs.writeFileSync(path.join(nomarmyRoot, "config", "providers.yml"), "pools: {}\n");
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-connect-install-"));
  try {
    installMcpCopy({ nomarmyRoot, installDir, run: () => {} });
    assert.equal(fs.readFileSync(path.join(installDir, "config", "providers.yml"), "utf8"), "pools: {}\n");
  } finally {
    fs.rmSync(nomarmyRoot, { recursive: true, force: true });
    fs.rmSync(installDir, { recursive: true, force: true });
  }
});

test("installMcpCopy: a stale config/ directory in installDir is fully replaced, not merged (a removed pool must not survive)", () => {
  const nomarmyRoot = fakeRoot();
  fs.mkdirSync(path.join(nomarmyRoot, "config"), { recursive: true });
  fs.writeFileSync(path.join(nomarmyRoot, "config", "providers.yml"), "pools: {}\n");
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-connect-install-"));
  fs.mkdirSync(path.join(installDir, "config"), { recursive: true });
  fs.writeFileSync(path.join(installDir, "config", "stale-removed-file.env"), "STALE=1\n");
  try {
    installMcpCopy({ nomarmyRoot, installDir, run: () => {} });
    assert.equal(fs.existsSync(path.join(installDir, "config", "stale-removed-file.env")), false);
    assert.equal(fs.existsSync(path.join(installDir, "config", "providers.yml")), true);
  } finally {
    fs.rmSync(nomarmyRoot, { recursive: true, force: true });
    fs.rmSync(installDir, { recursive: true, force: true });
  }
});

test("installMcpCopy: a stale lib/ directory in installDir is fully replaced, not merged", () => {
  const nomarmyRoot = fakeRoot();
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-connect-install-"));
  fs.mkdirSync(path.join(installDir, "lib"), { recursive: true });
  fs.writeFileSync(path.join(installDir, "lib", "stale-removed-file.mjs"), "// should not survive");
  try {
    installMcpCopy({ nomarmyRoot, installDir, run: () => {} });
    assert.equal(fs.existsSync(path.join(installDir, "lib", "stale-removed-file.mjs")), false);
    assert.equal(fs.existsSync(path.join(installDir, "lib", "verify.mjs")), true);
  } finally {
    fs.rmSync(nomarmyRoot, { recursive: true, force: true });
    fs.rmSync(installDir, { recursive: true, force: true });
  }
});

test("connectClaude: installs the copy, best-effort removes old registrations, adds and verifies the new one", () => {
  const nomarmyRoot = fakeRoot();
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-connect-install-"));
  const calls = [];
  try {
    const result = connectClaude({ nomarmyRoot, installDir, run: (cmd, args) => { calls.push([cmd, ...args].join(" ")); return ""; } });
    assert.equal(result.installDir, installDir);
    assert.ok(calls.some((c) => c.startsWith("claude mcp add --scope user nomarmy-local-worker")));
    assert.ok(calls.some((c) => c === "claude mcp get nomarmy-local-worker"));
    assert.equal(fs.readFileSync(path.join(installDir, "package.json"), "utf8"), '{"name":"nomarmy"}');
  } finally {
    fs.rmSync(nomarmyRoot, { recursive: true, force: true });
    fs.rmSync(installDir, { recursive: true, force: true });
  }
});

test("connectClaude: falls back to a scope-less add when --scope user is rejected", () => {
  const nomarmyRoot = fakeRoot();
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-connect-install-"));
  const calls = [];
  try {
    connectClaude({
      nomarmyRoot, installDir,
      run: (cmd, args) => {
        calls.push([cmd, ...args].join(" "));
        if (cmd === "claude" && args[1] === "add" && args.includes("--scope")) throw new Error("--scope not supported");
        return "";
      },
    });
    assert.ok(calls.some((c) => c === `claude mcp add nomarmy-local-worker -- node ${path.join(installDir, "mcp", "server.mjs")}`));
  } finally {
    fs.rmSync(nomarmyRoot, { recursive: true, force: true });
    fs.rmSync(installDir, { recursive: true, force: true });
  }
});

test("parseClaudeEnv: reads KEY=value lines from the Environment: block, stops at the first non-matching line", () => {
  const output = [
    "nomarmy-local-worker:",
    "  Scope: User config (available in all your projects)",
    "  Status: ✔ Connected",
    "  Type: stdio",
    "  Command: node",
    "  Args: /path/to/server.mjs",
    "  Environment:",
    "    NOMARMY_WORKER_MODEL_THINKING=true",
    "    NOMARMY_WORKER_MODEL=qwen3.6-27b",
    "",
    "To remove this server, run: claude mcp remove nomarmy-local-worker -s user",
  ].join("\n");
  assert.deepEqual(parseClaudeEnv(output), { NOMARMY_WORKER_MODEL_THINKING: "true", NOMARMY_WORKER_MODEL: "qwen3.6-27b" });
});

test("parseClaudeEnv: no Environment: block, or nothing registered yet, is an empty object rather than an error", () => {
  assert.deepEqual(parseClaudeEnv(""), {});
  assert.deepEqual(parseClaudeEnv("nomarmy-local-worker:\n  Scope: User config\n  Environment:\n\nTo remove..."), {});
  assert.deepEqual(parseClaudeEnv(undefined), {});
});

test("connectClaude: preserves an existing registration's environment variables across a reinstall", () => {
  // Found live: reinstalling to pick up a code change silently dropped
  // NOMARMY_WORKER_MODEL, reverting every dispatch to the default model
  // with no warning, because the re-add passed no -e flags at all.
  const nomarmyRoot = fakeRoot();
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-connect-install-"));
  const calls = [];
  const existingEnvOutput = [
    "nomarmy-local-worker:",
    "  Environment:",
    "    NOMARMY_WORKER_MODEL_THINKING=true",
    "    NOMARMY_WORKER_MODEL=gpt-oss-20b",
    "",
  ].join("\n");
  try {
    const result = connectClaude({
      nomarmyRoot, installDir,
      run: (cmd, args) => {
        calls.push([cmd, ...args].join(" "));
        if (cmd === "claude" && args[0] === "mcp" && args[1] === "get") return existingEnvOutput;
        return "";
      },
    });
    assert.deepEqual(result.preservedEnv, { NOMARMY_WORKER_MODEL_THINKING: "true", NOMARMY_WORKER_MODEL: "gpt-oss-20b" });
    const addCall = calls.find((c) => c.includes("mcp add"));
    assert.match(addCall, /-e NOMARMY_WORKER_MODEL_THINKING=true/);
    assert.match(addCall, /-e NOMARMY_WORKER_MODEL=gpt-oss-20b/);
  } finally {
    fs.rmSync(nomarmyRoot, { recursive: true, force: true });
    fs.rmSync(installDir, { recursive: true, force: true });
  }
});

test("deriveWorkerModelEnv: reads NOMARMY_WORKER_MODEL/NOMARMY_MODEL_THINKING from config/common.env", () => {
  const nomarmyRoot = fakeRoot();
  fs.mkdirSync(path.join(nomarmyRoot, "config"), { recursive: true });
  fs.writeFileSync(path.join(nomarmyRoot, "config", "common.env"), "NOMARMY_WORKER_MODEL=qwen3.6-27b\nNOMARMY_MODEL_THINKING=true\n");
  try {
    assert.deepEqual(deriveWorkerModelEnv(nomarmyRoot), { NOMARMY_WORKER_MODEL: "qwen3.6-27b", NOMARMY_WORKER_MODEL_THINKING: "true" });
  } finally {
    fs.rmSync(nomarmyRoot, { recursive: true, force: true });
  }
});

test("deriveWorkerModelEnv: no config/common.env (or missing keys) contributes nothing, not an error", () => {
  const nomarmyRoot = fakeRoot();
  try {
    assert.deepEqual(deriveWorkerModelEnv(nomarmyRoot), {});
  } finally {
    fs.rmSync(nomarmyRoot, { recursive: true, force: true });
  }
});

test("connectClaude: resyncs the worker model from config/common.env, overriding a stale registered value", () => {
  // The actual bug this closes: NOMARMY_WORKER_MODEL in config/common.env
  // was written by `nomarmy setup`/`model` but never read back by anything,
  // so the registration could silently keep pointing at a completely
  // different, previously-configured model.
  const nomarmyRoot = fakeRoot();
  fs.mkdirSync(path.join(nomarmyRoot, "config"), { recursive: true });
  fs.writeFileSync(path.join(nomarmyRoot, "config", "common.env"), "NOMARMY_WORKER_MODEL=qwen3.6-27b\nNOMARMY_MODEL_THINKING=true\n");
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-connect-install-"));
  const staleEnvOutput = [
    "nomarmy-local-worker:",
    "  Environment:",
    "    NOMARMY_WORKER_MODEL=gpt-oss-20b",
    "    NOMARMY_WORKER_MODEL_THINKING=false",
    "",
  ].join("\n");
  try {
    const result = connectClaude({
      nomarmyRoot, installDir,
      run: (cmd, args) => (cmd === "claude" && args[0] === "mcp" && args[1] === "get" ? staleEnvOutput : ""),
    });
    assert.deepEqual(result.preservedEnv, { NOMARMY_WORKER_MODEL: "qwen3.6-27b", NOMARMY_WORKER_MODEL_THINKING: "true" });
  } finally {
    fs.rmSync(nomarmyRoot, { recursive: true, force: true });
    fs.rmSync(installDir, { recursive: true, force: true });
  }
});

test("connectClaude: config/common.env's model keys are added even with no prior registration at all", () => {
  const nomarmyRoot = fakeRoot();
  fs.mkdirSync(path.join(nomarmyRoot, "config"), { recursive: true });
  fs.writeFileSync(path.join(nomarmyRoot, "config", "common.env"), "NOMARMY_WORKER_MODEL=qwen3-coder-next\nNOMARMY_MODEL_THINKING=false\n");
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-connect-install-"));
  const calls = [];
  try {
    const result = connectClaude({ nomarmyRoot, installDir, run: (cmd, args) => { calls.push([cmd, ...args].join(" ")); return ""; } });
    assert.deepEqual(result.preservedEnv, { NOMARMY_WORKER_MODEL: "qwen3-coder-next", NOMARMY_WORKER_MODEL_THINKING: "false" });
    const addCall = calls.find((c) => c.includes("mcp add"));
    assert.match(addCall, /-e NOMARMY_WORKER_MODEL=qwen3-coder-next/);
    assert.match(addCall, /-e NOMARMY_WORKER_MODEL_THINKING=false/);
  } finally {
    fs.rmSync(nomarmyRoot, { recursive: true, force: true });
    fs.rmSync(installDir, { recursive: true, force: true });
  }
});

// extraEnv: the mechanism `nomarmy providers add --update-mcp` uses to bake
// a pool entry's auth_env NAME into the registration as a placeholder --
// the one path guaranteed to reach the MCP server's own process.env
// regardless of shell/launch-method timing (see lib/connect.mjs's own
// comment on this parameter for why "just export it in your shell" isn't
// reliable).
// derivePoolAuthEnvPlaceholders: closes the gap extraEnv alone left open --
// a pool entry added at ANY point in the past (not just "in this same
// connect call") must get its auth_env picked up automatically on every
// later connect (a model swap, `nomarmy update`, a fresh install), not only
// if an operator remembers `--update-mcp` at the moment they added it.
test("derivePoolAuthEnvPlaceholders: collects every api agent's auth_env (and nothing for subscriptions), as placeholders never the real value", () => {
  const nomarmyRoot = fakeRoot();
  fs.mkdirSync(path.join(nomarmyRoot, "config"), { recursive: true });
  fs.writeFileSync(path.join(nomarmyRoot, "config", "agents.yml"), `
agents:
  grok:
    kind: api
    provider: xai
    model: grok-4.6
    auth_env: NOMARMY_XAI_API_KEY
  sonnet:
    kind: api
    provider: anthropic
    model: claude-sonnet-4-6
    auth_env: NOMARMY_ANTHROPIC_API_KEY
  codex:
    kind: subscription
    provider: openai
    model: gpt-6-astra
    owner: you@example.com
`);
  try {
    assert.deepEqual(derivePoolAuthEnvPlaceholders(path.join(nomarmyRoot, "config")), {
      NOMARMY_XAI_API_KEY: "registered",
      NOMARMY_ANTHROPIC_API_KEY: "registered",
    });
  } finally {
    fs.rmSync(nomarmyRoot, { recursive: true, force: true });
  }
});

test("derivePoolAuthEnvPlaceholders: no agents.yml (or an invalid one) contributes nothing, not an error", () => {
  const nomarmyRoot = fakeRoot();
  try {
    assert.deepEqual(derivePoolAuthEnvPlaceholders(path.join(nomarmyRoot, "config")), {});
    fs.mkdirSync(path.join(nomarmyRoot, "config"), { recursive: true });
    fs.writeFileSync(path.join(nomarmyRoot, "config", "agents.yml"), "agents:\n  broken: [this is not: valid: yaml");
    assert.deepEqual(derivePoolAuthEnvPlaceholders(path.join(nomarmyRoot, "config")), {});
  } finally {
    fs.rmSync(nomarmyRoot, { recursive: true, force: true });
  }
});

test("connectClaude: an api agent's auth_env is baked in automatically, with no extraEnv needed at all", () => {
  const nomarmyRoot = fakeRoot();
  fs.mkdirSync(path.join(nomarmyRoot, "config"), { recursive: true });
  fs.writeFileSync(path.join(nomarmyRoot, "config", "agents.yml"), "agents:\n  grok:\n    kind: api\n    provider: xai\n    model: grok-4.6\n    auth_env: NOMARMY_XAI_API_KEY\n");
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-connect-install-"));
  const calls = [];
  try {
    connectClaude({ nomarmyRoot, installDir, configDir: path.join(nomarmyRoot, "config"), run: (cmd, args) => { calls.push([cmd, ...args].join(" ")); return ""; } });
    const addCall = calls.find((c) => c.includes("mcp add"));
    assert.match(addCall, /-e NOMARMY_XAI_API_KEY=registered/, "a pool entry added at any point in the past must be picked up on an ordinary connect, not only via --update-mcp at add-time");
  } finally {
    fs.rmSync(nomarmyRoot, { recursive: true, force: true });
    fs.rmSync(installDir, { recursive: true, force: true });
  }
});

test("connectClaude: an already-registered real value for a pool's auth_env is never clobbered by the derived placeholder", () => {
  const nomarmyRoot = fakeRoot();
  fs.mkdirSync(path.join(nomarmyRoot, "config"), { recursive: true });
  fs.writeFileSync(path.join(nomarmyRoot, "config", "agents.yml"), "agents:\n  grok:\n    kind: api\n    provider: xai\n    model: grok-4.6\n    auth_env: NOMARMY_XAI_API_KEY\n");
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-connect-install-"));
  const calls = [];
  const existingEnvOutput = ["nomarmy-local-worker:", "  Environment:", "    NOMARMY_XAI_API_KEY=some-non-placeholder-value", ""].join("\n");
  try {
    connectClaude({
      nomarmyRoot, installDir,
      run: (cmd, args) => {
        calls.push([cmd, ...args].join(" "));
        if (cmd === "claude" && args[0] === "mcp" && args[1] === "get") return existingEnvOutput;
        return "";
      },
    });
    const addCall = calls.find((c) => c.includes("mcp add"));
    assert.match(addCall, /-e NOMARMY_XAI_API_KEY=some-non-placeholder-value/);
  } finally {
    fs.rmSync(nomarmyRoot, { recursive: true, force: true });
    fs.rmSync(installDir, { recursive: true, force: true });
  }
});

test("connectClaude: extraEnv bakes a new key into the registration alongside everything else", () => {
  const nomarmyRoot = fakeRoot();
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-connect-install-"));
  const calls = [];
  try {
    connectClaude({ nomarmyRoot, installDir, extraEnv: { NOMARMY_XAI_API_KEY: "registered" }, run: (cmd, args) => { calls.push([cmd, ...args].join(" ")); return ""; } });
    const addCall = calls.find((c) => c.includes("mcp add"));
    assert.match(addCall, /-e NOMARMY_XAI_API_KEY=registered/);
  } finally {
    fs.rmSync(nomarmyRoot, { recursive: true, force: true });
    fs.rmSync(installDir, { recursive: true, force: true });
  }
});

test("connectClaude: a key baked in by a PRIOR extraEnv connect survives a later reinstall with no extraEnv at all", () => {
  // Mirrors the existing "preserves an existing registration's environment
  // variables" test's own pattern: a fixed `claude mcp get` response stands
  // in for whatever a prior connect (here, one that used extraEnv) already
  // registered -- extraEnv is a one-time bake-in, not something that must
  // be re-passed on every subsequent connect for it to stick.
  const nomarmyRoot = fakeRoot();
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-connect-install-"));
  const calls = [];
  const existingEnvOutput = ["nomarmy-local-worker:", "  Environment:", "    NOMARMY_XAI_API_KEY=registered", ""].join("\n");
  try {
    connectClaude({
      nomarmyRoot, installDir,
      run: (cmd, args) => {
        calls.push([cmd, ...args].join(" "));
        if (cmd === "claude" && args[0] === "mcp" && args[1] === "get") return existingEnvOutput;
        return "";
      },
    });
    const addCall = calls.find((c) => c.includes("mcp add"));
    assert.match(addCall, /-e NOMARMY_XAI_API_KEY=registered/);
  } finally {
    fs.rmSync(nomarmyRoot, { recursive: true, force: true });
    fs.rmSync(installDir, { recursive: true, force: true });
  }
});

test("connectClaude: config/common.env's derived keys still win over extraEnv on a real collision", () => {
  const nomarmyRoot = fakeRoot();
  fs.mkdirSync(path.join(nomarmyRoot, "config"), { recursive: true });
  fs.writeFileSync(path.join(nomarmyRoot, "config", "common.env"), "NOMARMY_WORKER_MODEL=qwen3-coder-next\n");
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-connect-install-"));
  const calls = [];
  try {
    connectClaude({ nomarmyRoot, installDir, extraEnv: { NOMARMY_WORKER_MODEL: "should-not-win" }, run: (cmd, args) => { calls.push([cmd, ...args].join(" ")); return ""; } });
    const addCall = calls.find((c) => c.includes("mcp add"));
    assert.match(addCall, /-e NOMARMY_WORKER_MODEL=qwen3-coder-next/);
    assert.doesNotMatch(addCall, /should-not-win/);
  } finally {
    fs.rmSync(nomarmyRoot, { recursive: true, force: true });
    fs.rmSync(installDir, { recursive: true, force: true });
  }
});

test("connectCodex: installs the copy, best-effort removes old registrations, adds and lists", () => {
  const nomarmyRoot = fakeRoot();
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-connect-install-"));
  const calls = [];
  try {
    connectCodex({ nomarmyRoot, installDir, run: (cmd, args) => { calls.push([cmd, ...args].join(" ")); return ""; } });
    assert.ok(calls.some((c) => c.startsWith("codex mcp add nomarmy-local-worker")));
    assert.ok(calls.some((c) => c === "codex mcp list"));
  } finally {
    fs.rmSync(nomarmyRoot, { recursive: true, force: true });
    fs.rmSync(installDir, { recursive: true, force: true });
  }
});

test("connectCodex: forwards the install's settings, keeps an operator's own, and moves the skill to ~/.agents/skills", () => {
  const nomarmyRoot = fakeRoot();
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-connect-install-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-connect-home-"));
  const configDir = path.join(home, "config");
  const skillsDir = path.join(home, ".agents", "skills"), legacySkillsDir = path.join(home, ".codex", "skills");
  const calls = [];
  try {
    fs.mkdirSync(path.join(nomarmyRoot, "config"));
    fs.writeFileSync(path.join(nomarmyRoot, "config", "common.env"), "NOMARMY_EXECUTION=hosted\nNOMARMY_WORKER_MODEL=gpt-oss-20b\n");
    fs.mkdirSync(path.join(nomarmyRoot, "playbooks"));
    fs.writeFileSync(path.join(nomarmyRoot, "playbooks", "feature.md"), "# feature\n");
    fs.mkdirSync(path.join(legacySkillsDir, "nomarmy-feature"), { recursive: true });
    fs.writeFileSync(path.join(legacySkillsDir, "nomarmy-feature", "SKILL.md"), "<!-- nomarmy:feature -->\nold");
    fs.mkdirSync(path.join(legacySkillsDir, "mine"), { recursive: true });
    fs.writeFileSync(path.join(legacySkillsDir, "mine", "SKILL.md"), "the operator's own");
    const run = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[0] === "mcp" && args[1] === "get") return JSON.stringify({ transport: { env: { NOMARMY_CUSTOM: "kept", NOMARMY_EXECUTION: "local" } } });
      return "";
    };
    const result = connectCodex({ nomarmyRoot, installDir, run, configDir, skillsDir, legacySkillsDir });
    const add = calls.find((c) => c[1] === "mcp" && c[2] === "add");
    assert.ok(add.includes("--env") && add.includes("NOMARMY_EXECUTION=hosted") && add.includes("NOMARMY_CUSTOM=kept"), add.join(" "));
    assert.ok(!add.includes("NOMARMY_EXECUTION=local"), "the install's own settings win over a stale registration");
    assert.equal(result.preservedEnv.NOMARMY_WORKER_MODEL, "gpt-oss-20b");
    assert.ok(fs.existsSync(path.join(skillsDir, "nomarmy-feature", "SKILL.md")), "installed where Codex's apps look");
    assert.ok(!fs.existsSync(path.join(legacySkillsDir, "nomarmy-feature")), "nomArmy's old copy is removed");
    assert.ok(fs.existsSync(path.join(legacySkillsDir, "mine", "SKILL.md")), "the operator's own skills are untouched");
  } finally {
    for (const dir of [nomarmyRoot, installDir, home]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fakeCursorConfigPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-cursor-")), "mcp.json");
}

test("readCursorConfig: a missing file is an empty object, not an error", () => {
  assert.deepEqual(readCursorConfig(path.join(os.tmpdir(), "does-not-exist-nomarmy", "mcp.json")), {});
});

test("readCursorConfig: invalid JSON is refused, never silently overwritten", () => {
  const configPath = fakeCursorConfigPath();
  fs.writeFileSync(configPath, "{ not valid json");
  try {
    assert.throws(() => readCursorConfig(configPath), /not valid JSON/);
  } finally {
    fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
  }
});

test("readCursorConfig: a JSON array at the top level is refused", () => {
  const configPath = fakeCursorConfigPath();
  fs.writeFileSync(configPath, "[]");
  try {
    assert.throws(() => readCursorConfig(configPath), /not a JSON object/);
  } finally {
    fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
  }
});

test("connectCursor: creates mcp.json with the nomArmy entry when none exists", () => {
  const nomarmyRoot = fakeRoot();
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-connect-install-"));
  const configPath = fakeCursorConfigPath();
  fs.rmSync(configPath, { force: true });
  try {
    const result = connectCursor({ nomarmyRoot, installDir, configPath, run: () => {} });
    const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.deepEqual(written.mcpServers["nomarmy-local-worker"], {
      command: "node", args: [path.join(installDir, "mcp", "server.mjs")], env: { NOMARMY_PROJECT_DIR: "${workspaceFolder}" },
    });
    assert.equal(result.configPath, configPath);
  } finally {
    fs.rmSync(nomarmyRoot, { recursive: true, force: true });
    fs.rmSync(installDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
  }
});

test("connectCursor: preserves this entry's env vars and every other configured server, untouched", () => {
  const nomarmyRoot = fakeRoot();
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-connect-install-"));
  const configPath = fakeCursorConfigPath();
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      "some-other-server": { command: "npx", args: ["-y", "other-mcp"] },
      "nomarmy-local-worker": { command: "node", args: ["/old/stale/path.mjs"], env: { NOMARMY_WORKER_MODEL: "gpt-oss-20b" } },
    },
  }));
  try {
    const result = connectCursor({ nomarmyRoot, installDir, configPath, run: () => {} });
    const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.deepEqual(written.mcpServers["some-other-server"], { command: "npx", args: ["-y", "other-mcp"] });
    assert.deepEqual(written.mcpServers["nomarmy-local-worker"].env, { NOMARMY_WORKER_MODEL: "gpt-oss-20b", NOMARMY_PROJECT_DIR: "${workspaceFolder}" });
    assert.equal(written.mcpServers["nomarmy-local-worker"].args[0], path.join(installDir, "mcp", "server.mjs"));
    assert.deepEqual(result.preservedEnv, { NOMARMY_WORKER_MODEL: "gpt-oss-20b", NOMARMY_PROJECT_DIR: "${workspaceFolder}" });
  } finally {
    fs.rmSync(nomarmyRoot, { recursive: true, force: true });
    fs.rmSync(installDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
  }
});

test("connectCursor: the install's settings win over a stale entry, and other variables are kept", () => {
  const nomarmyRoot = fakeRoot();
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-connect-install-"));
  const configPath = fakeCursorConfigPath();
  fs.mkdirSync(path.join(nomarmyRoot, "config"));
  fs.writeFileSync(path.join(nomarmyRoot, "config", "common.env"), "NOMARMY_EXECUTION=hosted\n");
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { "nomarmy-local-worker": { command: "node", args: ["/old.mjs"], env: { NOMARMY_EXECUTION: "local", NOMARMY_CUSTOM: "kept" } } } }));
  try {
    const { preservedEnv } = connectCursor({ nomarmyRoot, installDir, configPath, run: () => {}, configDir: path.join(installDir, "no-agents") });
    assert.equal(preservedEnv.NOMARMY_EXECUTION, "hosted");
    assert.equal(preservedEnv.NOMARMY_CUSTOM, "kept");
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")).mcpServers["nomarmy-local-worker"].env, preservedEnv);
  } finally {
    for (const dir of [nomarmyRoot, installDir, path.dirname(configPath)]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cursorAlreadyConnected: true only when the file exists and has our entry", () => {
  const configPath = fakeCursorConfigPath();
  fs.rmSync(configPath, { force: true });
  assert.equal(cursorAlreadyConnected(configPath), false);
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { "nomarmy-local-worker": { command: "node", args: [] } } }));
  try {
    assert.equal(cursorAlreadyConnected(configPath), true);
  } finally {
    fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The /feature playbook, rendered into each coordinator's own format.
// ---------------------------------------------------------------------------
import { installPlaybooks, renderPlaybook } from "../lib/connect.mjs";
import { COORDINATOR_INSTRUCTIONS } from "../lib/coordinator-instructions.mjs";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FEATURE_BODY = fs.readFileSync(path.join(REPO_ROOT, "playbooks", "feature.md"), "utf8");

test("renderPlaybook: Claude gets a /feature command, Codex a skill, Cursor a command -- each marked as nomArmy's", () => {
  const claude = renderPlaybook("feature", FEATURE_BODY, "claude");
  assert.equal(claude.relPath, "feature.md");
  assert.match(claude.text, /^---\ndescription: nomArmy/);
  assert.match(claude.text, /argument-hint: <the feature you want>/);
  assert.ok(claude.text.includes("$ARGUMENTS"), "Claude Code substitutes the request");
  const codex = renderPlaybook("feature", FEATURE_BODY, "codex");
  assert.equal(codex.relPath, path.join("nomarmy-feature", "SKILL.md"));
  assert.match(codex.text, /^---\nname: nomarmy-feature\ndescription: .*Use when the user asks nomArmy/);
  const cursor = renderPlaybook("feature", FEATURE_BODY, "cursor");
  assert.match(cursor.text, /^<!-- nomarmy:feature/);
  for (const r of [claude, codex, cursor]) {
    assert.ok(r.text.includes("<!-- nomarmy:feature"), "the marker that protects an operator's own file");
    assert.ok(!r.text.includes("{{REQUEST}}"), "the placeholder is always filled");
    assert.ok(r.text.includes("run_start") && r.text.includes("Never merge"), "the same playbook everywhere");
  }
});

test("acceptance workflow is in the General instructions and rendered /feature playbook", () => {
  const general = COORDINATOR_INSTRUCTIONS;
  assert.match(general, /At feature planning, write acceptance\/<feature>\.yml/);
  assert.match(general, /Assign stable criterion IDs in each job brief before parallel dispatch and pass them as criteria/);
  assert.match(general, /jobs must not pick the next free ID/);
  assert.match(general, /preview nomarmy acceptance fill <run-id> --dry-run/);
  assert.match(general, /A CONTRACT BROKEN: issue means the change is wrong or the contract must intentionally change/);

  for (const target of ["claude", "codex", "cursor"]) {
    const { text } = renderPlaybook("feature", FEATURE_BODY, target);
    assert.match(text, /write `acceptance\/<feature>\.yml`/);
    assert.match(text, /Assign the stable IDs to pieces in the plan and each job brief before dispatch/);
    assert.match(text, /`criteria: \["ACC-8"\]` naming the contract IDs/);
    assert.match(text, /parallel jobs must not choose the next free ID themselves/);
    assert.match(text, /nomarmy acceptance fill <run-id> --dry-run/);
    assert.match(text, /A `CONTRACT BROKEN:` issue means either the change is wrong or the contract must intentionally change/);
  }
});

test("General guidance pins the trust map and acknowledgement workflow", () => {
  for (const guidance of [COORDINATOR_INSTRUCTIONS, FEATURE_BODY]) {
    assert.match(guidance, /nomarmy trust map/);
    assert.match(guidance, /nomarmy trust review/);
    assert.match(guidance, /nomarmy trust ack <job> --accept\|--reject --reason/);
    assert.match(guidance, /trust\.level: review/);
    assert.match(guidance, /trust\.level: human/);
    assert.match(guidance, /independent review/);
  }
});

test("installPlaybooks: installs, refreshes its own copy, and never overwrites the operator's own same-named file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-playbooks-"));
  try {
    assert.deepEqual(installPlaybooks({ nomarmyRoot: REPO_ROOT, target: "claude", dir }).installed, ["feature.md"]);
    fs.writeFileSync(path.join(dir, "feature.md"), fs.readFileSync(path.join(dir, "feature.md"), "utf8") + "stale\n");
    assert.deepEqual(installPlaybooks({ nomarmyRoot: REPO_ROOT, target: "claude", dir }).installed, ["feature.md"]);
    assert.ok(!fs.readFileSync(path.join(dir, "feature.md"), "utf8").includes("stale"), "nomArmy's own copy is refreshed");
    fs.writeFileSync(path.join(dir, "feature.md"), "my own /feature command\n");
    const out = installPlaybooks({ nomarmyRoot: REPO_ROOT, target: "claude", dir });
    assert.deepEqual(out, { installed: [], skipped: ["feature.md"], dir });
    assert.equal(fs.readFileSync(path.join(dir, "feature.md"), "utf8"), "my own /feature command\n");
    const codexDir = path.join(dir, "codex");
    installPlaybooks({ nomarmyRoot: REPO_ROOT, target: "codex", dir: codexDir });
    assert.ok(fs.existsSync(path.join(codexDir, "nomarmy-feature", "SKILL.md")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Namespace access lets the regression checks run against the pre-plugin
// implementation too, without an import-time missing-export failure.
import * as pluginConnect from "../lib/connect.mjs";

function pluginFixture(t) {
  const root = fakeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const claude = path.join(root, "claude");
  const codex = path.join(root, "codex");
  fs.mkdirSync(path.join(claude, "plugins"), { recursive: true });
  fs.mkdirSync(codex);
  const env = { CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex };
  const installedPath = path.join(claude, "plugins", "installed_plugins.json");
  const settingsPath = path.join(claude, "settings.json");
  const codexConfigPath = path.join(codex, "config.toml");
  const writeClaude = (plugins, settings = {}) => {
    fs.writeFileSync(installedPath, JSON.stringify({ version: 2, plugins }));
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
  };
  return { root, env, installedPath, settingsPath, codexConfigPath, writeClaude };
}

test("plugin detection: Claude requires an enabled user install with the exact name", (t) => {
  const f = pluginFixture(t);
  const detect = () => pluginConnect.claudePluginInstalled({ env: f.env });
  assert.equal(detect(), null);
  for (const plugins of [
    {}, { "nomarmy@m": [{ scope: "project" }, { scope: "local" }] },
    { "nomarmy-extra@m": [{ scope: "user" }], "foo@nomarmy": [{ scope: "user" }] },
    { "nomarmy@m": null }, { "nomarmy@m": { scope: "user" } },
  ]) {
    f.writeClaude(plugins);
    assert.equal(detect(), null);
  }
  f.writeClaude({ "nomarmy@market": [{ scope: "local" }, { scope: "user" }] });
  assert.equal(detect(), "nomarmy@market");
  f.writeClaude({ "nomarmy@market": [{ scope: "user" }] }, { enabledPlugins: { "nomarmy@market": false } });
  assert.equal(detect(), null);
  f.writeClaude({
    "nomarmy@disabled": [{ scope: "user" }], "nomarmy@enabled": [{ scope: "user" }],
  }, { enabledPlugins: { "nomarmy@disabled": false, "nomarmy@enabled": true } });
  assert.equal(detect(), "nomarmy@enabled");
  for (const file of [f.installedPath, f.settingsPath]) {
    for (const value of ["garbage", "null", "[]"]) {
      f.writeClaude({ "nomarmy@m": [{ scope: "user" }] });
      fs.writeFileSync(file, value);
      assert.equal(detect(), null);
    }
    f.writeClaude({ "nomarmy@m": [{ scope: "user" }] });
    fs.rmSync(file);
    assert.equal(detect(), null);
  }
});

test("plugin detection: Codex scans exact plugin tables and their own boolean enable flags", (t) => {
  const f = pluginFixture(t);
  const detect = () => pluginConnect.codexPluginInstalled({ env: f.env });
  assert.equal(detect(), null);
  for (const [source, expected] of [
    ['[plugins."nomarmy@m"]\nenabled = true\n', "nomarmy@m"],
    [' [plugins . "nomarmy@market#one"] # comment\r\n enabled = true # yes\r\n[other]\nenabled = false', "nomarmy@market#one"],
    ['[plugins."nomarmy@off"]\nenabled = false\n[plugins."nomarmy@on"]\nenabled = true', "nomarmy@on"],
    ['[plugins."nomarmy@m"]\nenabled = false', null],
    ['[plugins."nomarmy@m"]\n[other]\nenabled = true', null],
    ['[plugins."nomarmy@m"]\n[plugins."nomarmy@m".nested]\nenabled = true', null],
    ['[plugins."nomarmy-extra@m"]\nenabled = true\n[plugins."foo@nomarmy"]\nenabled = true', null],
    ['# [plugins."nomarmy@m"]\nenabled = true', null],
    ['[plugins."nomarmy@m"]\n# enabled = true', null],
    ['[[plugins."nomarmy@m"]]\nenabled = true', null],
    ['[plugins."nomarmy@m"]\nenabled = "true"', null],
    ['[plugins."nomarmy@m"]\nenabled = true-ish', null],
    ['[plugins."nomarmy@m"]\nenabled = true\nenabled = false', null],
    ['[plugins."nomarmy@m"]\nenabled = true\n[plugins."nomarmy@m"]\nenabled = false', null],
    ['[plugins."nomarmy@m"\nenabled = true', null],
    ['[plugins."nomarmy@m"]\nenabled = true\ngarbage', null],
    ['description = """\n[plugins."nomarmy@m"]\nenabled = true\n"""', null],
    ["description = '''\n[plugins.\"nomarmy@m\"]\nenabled = true\n'''", null],
    ['[plugins."nomarmy@m"]\nenabled = true\nnote = """unterminated', null],
    ['garbage', null], ['', null],
  ]) {
    fs.writeFileSync(f.codexConfigPath, source);
    assert.equal(detect(), expected, source);
  }
});

for (const target of ["claude", "codex"]) {
  test(`plugin connect: ${target} keeps the copy, removes only owned playbooks, and preserves other scopes`, (t) => {
    const f = pluginFixture(t);
    f.writeClaude({ "nomarmy@nomarmy": [{ scope: "user" }] });
    fs.writeFileSync(f.codexConfigPath, '[plugins."nomarmy@nomarmy"]\nenabled = true\n');
    fs.mkdirSync(path.join(f.root, "playbooks"));
    fs.writeFileSync(path.join(f.root, "playbooks", "feature.md"), "feature {{REQUEST}}");
    const installDir = path.join(f.root, "installed");
    const commandsDir = path.join(f.root, "commands");
    const skillsDir = path.join(f.root, "skills");
    const legacySkillsDir = path.join(f.root, "legacy-skills");
    const configDir = path.join(f.root, "user-config");
    const calls = [];
    const run = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === "git") throw new Error("fixture has no repository");
      if (args[1] === "remove") throw new Error("nothing registered");
      return "";
    };
    const connect = target === "claude" ? connectClaude : connectCodex;
    const options = { nomarmyRoot: f.root, installDir, commandsDir, skillsDir, legacySkillsDir,
      settingsPath: f.settingsPath, env: f.env, configDir, run };
    const file = target === "claude" ? path.join(commandsDir, "feature.md") : path.join(skillsDir, "nomarmy-feature", "SKILL.md");
    const legacyFile = path.join(legacySkillsDir, "nomarmy-feature", "SKILL.md");
    for (const content of [null, "<!-- nomarmy:feature --> old", "my own feature"]) {
      calls.length = 0;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
      if (content !== null) {
        fs.writeFileSync(file, content);
        fs.writeFileSync(legacyFile, content);
      }
      const result = connect(options);
      assert.deepEqual(Object.keys(result).sort(), [
        "installDir", "serverPath", "preservedEnv", "commands", "notifier", "plugin",
        ...(target === "claude" ? ["statusLine", "scope"] : []),
      ].sort());
      assert.equal(result.plugin, "nomarmy@nomarmy");
      assert.equal(result.installDir, installDir);
      assert.equal(result.serverPath, null);
      assert.deepEqual(result.preservedEnv, {});
      assert.deepEqual(result.commands, { installed: [], skipped: [], dir: target === "claude" ? commandsDir : skillsDir });
      assert.deepEqual(result.notifier, process.platform === "darwin"
        ? { status: "skipped", reason: "notifications are off (NOMARMY_NOTIFY=0)" }
        : { status: "skipped", reason: "not macOS" });
      assert.deepEqual(calls, [
        ["npm", "install", "--omit=dev"],
        [process.execPath, "--check", "mcp/server.mjs"],
        [target, "mcp", "remove", "nomarmy-local-worker", ...(target === "claude" ? ["--scope", "user"] : [])],
      ]);
      assert.equal(fs.readFileSync(path.join(installDir, "mcp", "server.mjs"), "utf8"), "// fake server");
      assert.equal(fs.readFileSync(path.join(installDir, "lib", "verify.mjs"), "utf8"), "// fake lib file");
      if (content === "my own feature") assert.equal(fs.readFileSync(file, "utf8"), content);
      else assert.equal(fs.existsSync(file), false);
      if (target === "codex") {
        if (content === "my own feature") assert.equal(fs.readFileSync(legacyFile, "utf8"), content);
        else {
          assert.equal(fs.existsSync(legacyFile), false);
          assert.equal(fs.existsSync(path.dirname(file)), content === null);
        }
      } else {
        assert.equal(result.scope, "user");
        assert.equal(result.statusLine, content === null ? "installed" : "unchanged");
        assert.deepEqual(JSON.parse(fs.readFileSync(f.settingsPath, "utf8")).statusLine, {
          type: "command", command: `node ${JSON.stringify(path.join(installDir, "lib", "statusline.mjs"))}`,
          padding: 0, refreshInterval: 5,
        });
      }
    }
    // A user-scoped plugin must not intercept the existing repository paths.
    for (const scope of ["local", "project"]) {
      calls.length = 0;
      if (target === "codex") {
        assert.throws(() => connect({ ...options, scope }), /Codex registers MCP servers only for every project/);
        assert.deepEqual(calls, []);
      } else {
        const projectDir = path.join(f.root, scope);
        const result = connect({ ...options, scope, projectDir, warn: () => {} });
        assert.equal(result.scope, scope);
        assert.equal(Object.hasOwn(result, "plugin"), false);
        assert.deepEqual(calls.filter((call) => call[0] === "claude" && call[2] === "add"), [[
          "claude", "mcp", "add", "--scope", scope, "nomarmy-local-worker", "--",
          ...(scope === "local" ? ["node", path.join(installDir, "mcp", "server.mjs")] : ["nomarmy", "mcp"]),
        ]]);
        assert.deepEqual(result.commands.installed, ["feature.md"]);
      }
    }
    // Disabling/removing the plugin restores normal registration + playbooks.
    for (const state of ["disabled", "absent"]) {
      if (state === "disabled") {
        f.writeClaude({ "nomarmy@nomarmy": [{ scope: "user" }] }, { enabledPlugins: { "nomarmy@nomarmy": false } });
        fs.writeFileSync(f.codexConfigPath, '[plugins."nomarmy@nomarmy"]\nenabled = false');
      } else {
        fs.rmSync(f.installedPath);
        fs.rmSync(f.codexConfigPath);
      }
      fs.rmSync(file, { force: true });
      calls.length = 0;
      const result = connect(options);
      assert.equal(Object.hasOwn(result, "plugin"), false);
      assert.equal(result.serverPath, path.join(installDir, "mcp", "server.mjs"));
      assert.deepEqual(calls.filter((call) => call[0] === target && call[2] === "add"), [[
        target, "mcp", "add", ...(target === "claude" ? ["--scope", "user"] : []),
        "nomarmy-local-worker", "--", "node", result.serverPath,
      ]]);
      assert.deepEqual(result.commands.installed, [target === "claude" ? "feature.md" : path.join("nomarmy-feature", "SKILL.md")]);
      assert.equal(fs.readFileSync(file, "utf8"), renderPlaybook("feature", "feature {{REQUEST}}", target).text);
    }
  });
}

test("plugin CLI: connect explains plugin ownership instead of claiming a second registration", {
  skip: process.platform === "win32" ? "uses POSIX executable stubs" : false,
}, async (t) => {
  const { execFileSync } = await import("node:child_process");
  const f = pluginFixture(t);
  f.writeClaude({ "nomarmy@nomarmy": [{ scope: "user" }] });
  fs.writeFileSync(f.codexConfigPath, '[plugins."nomarmy@nomarmy"]\nenabled = true');
  const binDir = path.join(f.root, "bin");
  fs.mkdirSync(binDir);
  for (const cmd of ["claude", "codex", "npm"]) {
    fs.writeFileSync(path.join(binDir, cmd), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  const stdout = execFileSync(process.execPath, [path.join(REPO_ROOT, "bin", "nomarmy.mjs"), "connect", "claude", "codex"], {
    cwd: f.root, encoding: "utf8",
    env: { ...process.env, ...f.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      NO_COLOR: "1", NOMARMY_AGENT_INSTALL_DIR: path.join(f.root, "installed"),
      NOMARMY_CLAUDE_SETTINGS_PATH: f.settingsPath,
      NOMARMY_CLAUDE_COMMANDS_DIR: path.join(f.root, "commands"),
      NOMARMY_CODEX_SKILLS_DIR: path.join(f.root, "skills"),
    },
  });
  assert.deepEqual(stdout.split("\n").filter((line) => line.includes("plugin")), [
    "✓ nomArmy plugin nomarmy@nomarmy is installed: it registers the MCP server and /feature, so connect didn't add a second registration.",
    "✓ nomArmy plugin nomarmy@nomarmy is installed: it registers the MCP server and /feature, so connect didn't add a second registration.",
  ]);
  assert.equal(stdout.includes("Registered nomarmy-local-worker"), false);
  assert.equal(fs.existsSync(path.join(f.root, "commands", "feature.md")), false);
  assert.equal(fs.existsSync(path.join(f.root, "skills", "nomarmy-feature")), false);
});
