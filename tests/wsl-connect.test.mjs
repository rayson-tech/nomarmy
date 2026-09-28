import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as wsl from "../lib/wsl.mjs";
import * as connect from "../lib/connect.mjs";

const distro = "Ubuntu";
const node = "/home/me/.nvm/versions/node/v24.16.0/bin/node";
const script = "/home/me/.nvm/versions/node/v24.16.0/lib/node_modules/nomarmy/bin/nomarmy.mjs";
const WSLENV = "CLAUDE_PROJECT_DIR/pu:NOMARMY_PROJECT_DIR/pu";
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
    return Buffer.from(`Welcome to Ubuntu!\r\n/a banner/path\r\nNOMARMY_NODE=${node}\r\nNOMARMY_SCRIPT=${script}\r\n`);
  } }), { node, script });
  assert.deepEqual(calls, [["wsl.exe", ["-d", distro, "--", "bash", "-lic", 'printf "NOMARMY_NODE=%s\\n" "$(command -v node)"; printf "NOMARMY_SCRIPT=%s\\n" "$(readlink -f "$(command -v nomarmy)")"'],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }]]);
});

test("resolveWslNomarmy reports the installation fix when either executable is missing", () => {
  for (const output of [
    `${node}\n${script}\n`,
    `NOMARMY_NODE=${node}\n`, `NOMARMY_SCRIPT=${script}\n`,
    `NOMARMY_NODE=\nNOMARMY_SCRIPT=${script}\n`,
    `NOMARMY_NODE=${node}\nNOMARMY_SCRIPT=\n`, "", "Welcome\n",
  ]) {
    assert.throws(() => wsl.resolveWslNomarmy({ distro, run: () => output }), { message: missing });
  }
  assert.throws(() => wsl.resolveWslNomarmy({ distro, run: () => { throw new Error("exit 1"); } }), { message: missing });
});

test("direct MCP bridge has no shell and validates both paths and the distro", () => {
  assert.deepEqual(wsl.mcpBridgeLaunch({ distro, node, script }), { command: "wsl.exe", args, env: { WSLENV } });
  for (const bad of ["/tmp/%PATH%/cli", "/tmp/cli;evil", "/tmp/cli\n", "/tmp/a\nb", "/tmp/$(id)", "relative", "", null]) {
    assert.throws(() => wsl.mcpBridgeLaunch({ distro, node, script: bad }), /Invalid WSL script path/);
    assert.throws(() => wsl.mcpBridgeLaunch({ distro, node: bad, script }), /Invalid WSL node path/);
  }
  assert.throws(() => wsl.mcpBridgeLaunch({ distro, node }), /Invalid WSL script path/);
  for (const bad of ["--exec", ".", "..", "Ubuntu;evil", "Ubuntu\n", ""]) {
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
  assert.throws(() => wsl.pickDistro({ run: () => "* --exec    Running    2\n", env, fs }), /Invalid WSL distro name/);
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
      ["claude", ["mcp", "add", "--scope", "user", "nomarmy-local-worker", "-e", `WSLENV=${WSLENV}:NOMARMY_COORDINATOR_OS/u`, "-e", "NOMARMY_COORDINATOR_OS=windows", "--", "wsl.exe", ...args]],
    ] : target === "codex" ? [
      ["codex", ["mcp", "remove", "nomarmy-local-worker"]],
      ["codex", ["mcp", "add", "nomarmy-local-worker", "--env", `WSLENV=${WSLENV}:NOMARMY_COORDINATOR_OS/u`, "--env", "NOMARMY_COORDINATOR_OS=windows", "--", "wsl.exe", ...args]],
    ] : [];
    assert.deepEqual(calls, expected);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), {
      setting: true, mcpServers: { unrelated, ...(target === "cursor" ? {
        "nomarmy-local-worker": { command: "wsl.exe", args, env: { WSLENV: `${WSLENV}:NOMARMY_COORDINATOR_OS/u`, NOMARMY_COORDINATOR_OS: "windows", NOMARMY_PROJECT_DIR: "${workspaceFolder}" } },
      } : {}) },
    });
    assert.equal(fs.existsSync(path.join(home, ".local")), false);
    assert.throws(() => connect.connectViaWsl({ target, distro, launch: { ...launch, args: ["-d", distro, "--", node, "/tmp/a;evil", "mcp"] }, nomarmyRoot,
      run: () => assert.fail("invalid launch must not register") }), /Invalid WSL script path/);
  });
}


test("probe rejects duplicate markers, newline continuations, and unsafe paths without truncation", () => {
  for (const output of [
    `NOMARMY_NODE=${node}\nNOMARMY_NODE=${node}\nNOMARMY_SCRIPT=${script}\n`,
    `NOMARMY_NODE=${node}\nNOMARMY_SCRIPT=${script}\nNOMARMY_SCRIPT=${script}\n`,
    `NOMARMY_NODE=${node}\nextra\nNOMARMY_SCRIPT=${script}\n`,
    `NOMARMY_NODE=${node}\nNOMARMY_SCRIPT=${script}\nextra\n`,
    `NOMARMY_NODE=${node}\n\nNOMARMY_SCRIPT=${script}\n`,
    `NOMARMY_NODE=${node}\nNOMARMY_SCRIPT=${script}\n\n`,
    // Two unmarked absolute lines must never substitute for a missing marker.
    `NOMARMY_NODE=${node}\n/unmarked/node\n/unmarked/script\n`,
  ]) {
    assert.throws(() => wsl.resolveWslNomarmy({ distro, run: () => output }), { message: missing });
  }
  for (const name of ["node", "script"]) {
    const paths = { node, script, [name]: "/tmp/%PATH%" };
    assert.throws(() => wsl.resolveWslNomarmy({ distro,
      run: () => `NOMARMY_NODE=${paths.node}\nNOMARMY_SCRIPT=${paths.script}\n` }),
    { message: `Invalid WSL ${name} path: expected an absolute POSIX path using only ASCII letters, digits, /, _, ., :, @, +, space, =, and -` });
  }
});

test("Windows connect persists resolved executable paths in windows.json", (t) => {
  const { home, env } = fixture(t);
  const cli = new URL("../bin/nomarmy.mjs", import.meta.url).href;
  const code = `
    import cp from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    Object.defineProperty(process, "platform", { value: "win32" });
    cp.execFileSync = (command, args) => {
      if (command !== "wsl.exe") throw new Error("Unexpected command: " + command);
      if (JSON.stringify(args) === JSON.stringify(["-l", "-v"])) return "* Ubuntu    Running    2\\n";
      if (args[0] === "-d" && args[1] === "Ubuntu" && args[4] === "-lic") {
        return "NOMARMY_NODE=${node}\\nNOMARMY_SCRIPT=${script}\\n";
      }
      throw new Error("Unexpected WSL command: " + JSON.stringify(args));
    };
    syncBuiltinESMExports();
    process.argv = [process.execPath, ${JSON.stringify(new URL("../bin/nomarmy.mjs", import.meta.url).pathname)}, "connect", "cursor", "--json"];
    await import(${JSON.stringify(cli)});
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8", env: { ...process.env, ...env, NOMARMY_NATIVE: "", WSL_DISTRO_NAME: "", WSL_INTEROP: "" },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, ".config", "nomarmy", "windows.json"), "utf8")),
    { distro, node, script });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8")).mcpServers["nomarmy-local-worker"].env,
    { WSLENV: `${WSLENV}:NOMARMY_COORDINATOR_OS/u`, NOMARMY_COORDINATOR_OS: "windows", NOMARMY_PROJECT_DIR: "${workspaceFolder}" });
});
