import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as wsl from "../lib/wsl.mjs";
import * as connect from "../lib/connect.mjs";

const distro = "Ubuntu";
const node = "/home/me/.nvm/versions/node/v24.16.0/bin/node";
const script = "/home/me/.nvm/versions/node/v24.16.0/lib/node_modules/nomarmy/bin/nomarmy.mjs";
const WSLENV = "CLAUDE_PROJECT_DIR/p:NOMARMY_PROJECT_DIR/p";
const args = ["-d", distro, "--", node, script, "mcp"];
const listing = "* Ubuntu    Running    2\r\n  Debian    Stopped    2\r\n";
const missing = "nomArmy isn't installed in WSL distro Ubuntu: inside it run `npm install -g nomarmy@alpha` (Node 24.16+), then run nomarmy connect again";

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-wsl-connect-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, env: { HOME: home, USERPROFILE: home } };
}

test("resolveWslNomarmy strips banners and CRLF and uses an interactive shell only at connect time", () => {
  const calls = [];
  assert.deepEqual(wsl.resolveWslNomarmy({ distro, run: (...call) => {
    calls.push(call);
    return Buffer.from(`Welcome to Ubuntu!\r\n${node}\r\n${script}\r\n`);
  } }), { node, script });
  assert.deepEqual(calls, [["wsl.exe", ["-d", distro, "--", "bash", "-lic", 'command -v node; readlink -f "$(command -v nomarmy)"'],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }]]);
});

test("resolveWslNomarmy reports the installation fix when either executable is missing", () => {
  for (const output of [`${node}\n`, `${script}\n`, "", "Welcome\n"]) {
    assert.throws(() => wsl.resolveWslNomarmy({ distro, run: () => output }), { message: missing });
  }
  assert.throws(() => wsl.resolveWslNomarmy({ distro, run: () => { throw new Error("exit 1"); } }), { message: missing });
});

test("direct MCP bridge has no shell and validates both paths and the distro", () => {
  assert.deepEqual(wsl.mcpBridgeLaunch({ distro, node, script }), { command: "wsl.exe", args, env: { WSLENV } });
  for (const bad of ["/tmp/cli;evil", "/tmp/cli\n", "/tmp/a\nb", "/tmp/$(id)", "relative", "", null]) {
    assert.throws(() => wsl.mcpBridgeLaunch({ distro, node, script: bad }), /Invalid WSL script path/);
    assert.throws(() => wsl.mcpBridgeLaunch({ distro, node: bad, script }), /Invalid WSL node path/);
  }
  assert.throws(() => wsl.mcpBridgeLaunch({ distro, node }), /Invalid WSL script path/);
  for (const bad of ["Ubuntu;evil", "Ubuntu\n", ""]) {
    assert.throws(() => wsl.mcpBridgeLaunch({ distro: bad, node, script }), /Invalid WSL distro name/);
    assert.throws(() => wsl.resolveWslNomarmy({ distro: bad, run: () => assert.fail("must not run") }), /Invalid WSL distro name/);
  }
});

test("pickDistro prefers saved choice, then default WSL 2, then the only distro", (t) => {
  const { env } = fixture(t);
  wsl.writeWindowsSettings({ distro: "Debian" }, { env });
  const run = (command, argv) => {
    assert.equal(command, "wsl.exe");
    assert.deepEqual(argv, ["-l", "-v"]);
    return listing;
  };
  assert.equal(wsl.pickDistro({ run, env, fs }), "Debian");
  wsl.writeWindowsSettings({ distro: "Removed" }, { env });
  assert.equal(wsl.pickDistro({ run, env, fs }), "Ubuntu");
  assert.equal(wsl.pickDistro({ run: () => "  Debian    Stopped    2\n", env, fs }), "Debian");
});

test("pickDistro gives actionable errors and rejects invalid distro names", (t) => {
  const { env } = fixture(t);
  assert.throws(() => wsl.pickDistro({ run: () => { throw new Error("ENOENT"); }, env, fs }),
    { message: "install WSL: run `wsl --install` in an administrator PowerShell, restart, then run nomarmy setup" });
  assert.throws(() => wsl.pickDistro({ run: () => "NAME    STATE    VERSION\n", env, fs }),
    { message: "install a Linux distro: `wsl --install -d Ubuntu`" });
  assert.throws(() => wsl.pickDistro({ run: () => "* Ubuntu    Running    1\n  Debian    Stopped    2\n", env, fs }),
    { message: "choose a default WSL 2 distro: run `wsl --set-default <distro>`, then run nomarmy connect again" });
  assert.throws(() => wsl.pickDistro({ run: () => "* Ubuntu;evil    Running    2\n", env, fs }), /Invalid WSL distro name/);
});

for (const target of ["claude", "codex", "cursor"]) {
  test(`connectViaWsl registers ${target} and installs only Windows playbooks`, (t) => {
    const { home } = fixture(t);
    const old = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    t.after(() => {
      for (const [key, value] of Object.entries(old)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    });
    const nomarmyRoot = path.join(home, "package");
    fs.mkdirSync(path.join(nomarmyRoot, "playbooks"), { recursive: true });
    fs.writeFileSync(path.join(nomarmyRoot, "playbooks", "feature.md"), "Build {{REQUEST}}\n");
    const commandsDir = connect.defaultCommandDirs()[target];
    const configPath = path.join(home, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const unrelated = { command: "other", args: ["keep"], env: { KEEP: "yes" } };
    fs.writeFileSync(configPath, JSON.stringify({ setting: true, mcpServers: { unrelated } }));
    const calls = [];
    const launch = wsl.mcpBridgeLaunch({ distro, node, script });
    const result = connect.connectViaWsl({ target, distro, launch, nomarmyRoot, run: (command, argv) => {
      calls.push([command, argv]);
      if (argv[1] === "remove") throw new Error("not registered yet");
    } });
    const relPath = target === "codex" ? path.join("nomarmy-feature", "SKILL.md") : "feature.md";
    assert.deepEqual(result, { target, bridge: { distro }, commands: { installed: [relPath], skipped: [], dir: commandsDir } });
    assert.equal(fs.readFileSync(path.join(commandsDir, relPath), "utf8"), connect.renderPlaybook("feature", "Build {{REQUEST}}\n", target).text);
    const expected = target === "claude" ? [
      ["claude", ["mcp", "remove", "nomarmy-local-worker", "--scope", "user"]],
      ["claude", ["mcp", "add", "--scope", "user", "nomarmy-local-worker", "-e", `WSLENV=${WSLENV}`, "--", "wsl.exe", ...args]],
    ] : target === "codex" ? [
      ["codex", ["mcp", "remove", "nomarmy-local-worker"]],
      ["codex", ["mcp", "add", "nomarmy-local-worker", "--env", `WSLENV=${WSLENV}`, "--", "wsl.exe", ...args]],
    ] : [];
    assert.deepEqual(calls, expected);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), {
      setting: true, mcpServers: { unrelated, ...(target === "cursor" ? {
        "nomarmy-local-worker": { command: "wsl.exe", args, env: { WSLENV, NOMARMY_PROJECT_DIR: "${workspaceFolder}" } },
      } : {}) },
    });
    assert.equal(fs.existsSync(path.join(home, ".local")), false);
    assert.throws(() => connect.connectViaWsl({ target, distro, launch: { ...launch, args: ["-d", distro, "--", node, "/tmp/a;evil", "mcp"] }, nomarmyRoot,
      run: () => assert.fail("invalid launch must not register") }), /Invalid WSL script path/);
  });
}
