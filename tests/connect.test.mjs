import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
test("derivePoolAuthEnvPlaceholders: collects auth_env across every pool, as placeholders never the real value", () => {
  const nomarmyRoot = fakeRoot();
  fs.mkdirSync(path.join(nomarmyRoot, "config"), { recursive: true });
  fs.writeFileSync(path.join(nomarmyRoot, "config", "providers.yml"), `
pools:
  cheap:
    - id: local
      provider: llama-cpp
      weight: 1
  capable:
    - id: grok
      provider: xai
      model: grok-4.6
      weight: 1
      auth_env: NOMARMY_XAI_API_KEY
    - id: sonnet
      provider: anthropic
      model: claude-sonnet-4-6
      weight: 1
      auth_env: NOMARMY_ANTHROPIC_API_KEY
`);
  try {
    assert.deepEqual(derivePoolAuthEnvPlaceholders(nomarmyRoot), {
      NOMARMY_XAI_API_KEY: "registered",
      NOMARMY_ANTHROPIC_API_KEY: "registered",
    });
  } finally {
    fs.rmSync(nomarmyRoot, { recursive: true, force: true });
  }
});

test("derivePoolAuthEnvPlaceholders: no config/providers.yml (or an invalid one) contributes nothing, not an error", () => {
  const nomarmyRoot = fakeRoot();
  try {
    assert.deepEqual(derivePoolAuthEnvPlaceholders(nomarmyRoot), {});
    fs.mkdirSync(path.join(nomarmyRoot, "config"), { recursive: true });
    fs.writeFileSync(path.join(nomarmyRoot, "config", "providers.yml"), "pools:\n  broken: [this is not: valid: yaml");
    assert.deepEqual(derivePoolAuthEnvPlaceholders(nomarmyRoot), {});
  } finally {
    fs.rmSync(nomarmyRoot, { recursive: true, force: true });
  }
});

test("connectClaude: a pool entry's auth_env is baked in automatically, with no extraEnv needed at all", () => {
  const nomarmyRoot = fakeRoot();
  fs.mkdirSync(path.join(nomarmyRoot, "config"), { recursive: true });
  fs.writeFileSync(path.join(nomarmyRoot, "config", "providers.yml"), "pools:\n  capable:\n    - id: grok\n      provider: xai\n      model: grok-4.6\n      weight: 1\n      auth_env: NOMARMY_XAI_API_KEY\n");
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-connect-install-"));
  const calls = [];
  try {
    connectClaude({ nomarmyRoot, installDir, run: (cmd, args) => { calls.push([cmd, ...args].join(" ")); return ""; } });
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
  fs.writeFileSync(path.join(nomarmyRoot, "config", "providers.yml"), "pools:\n  capable:\n    - id: grok\n      provider: xai\n      model: grok-4.6\n      weight: 1\n      auth_env: NOMARMY_XAI_API_KEY\n");
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
      command: "node", args: [path.join(installDir, "mcp", "server.mjs")], env: {},
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
    assert.deepEqual(written.mcpServers["nomarmy-local-worker"].env, { NOMARMY_WORKER_MODEL: "gpt-oss-20b" });
    assert.equal(written.mcpServers["nomarmy-local-worker"].args[0], path.join(installDir, "mcp", "server.mjs"));
    assert.deepEqual(result.preservedEnv, { NOMARMY_WORKER_MODEL: "gpt-oss-20b" });
  } finally {
    fs.rmSync(nomarmyRoot, { recursive: true, force: true });
    fs.rmSync(installDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
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
