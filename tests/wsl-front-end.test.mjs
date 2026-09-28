import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import * as wsl from "../lib/wsl.mjs";
import { windowsPlan } from "../lib/wsl-cli.mjs";
import { connectViaWsl } from "../lib/connect.mjs";
import { notificationCommand, notify } from "../lib/notify.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const bridgeEnv = {
  WSLENV: "CLAUDE_PROJECT_DIR/pu:NOMARMY_PROJECT_DIR/pu:NOMARMY_COORDINATOR_OS/u",
  NOMARMY_COORDINATOR_OS: "windows",
};
const coordinatorEnv = { NOMARMY_COORDINATOR_OS: "windows", WSL_DISTRO_NAME: "Ubuntu" };

test("Windows routes only engine commands, leaving repository commands native", () => {
  for (const command of ["jobs", "stats", "agents", "army", "validators", "config", "update", "mcp", "install", "start", "stop", "sandbox", "health", "model", "statusline", "uninstall"]) {
    assert.equal(windowsPlan([command]), "FORWARD", command);
  }
  for (const command of ["scan", "init", "validate", "sizing", "help", "connect", "setup", "doctor", "--help", "--version", "unknown"]) {
    assert.equal(windowsPlan([command]), "LOCAL", command);
  }
  assert.equal(windowsPlan([]), "LOCAL");
});

test("NOMARMY_NATIVE disables all Windows front-end decisions and Windows CI opts out", () => {
  for (const [platform, env, expected] of [
    ["win32", {}, true], ["win32", { NOMARMY_NATIVE: "1" }, false],
    ["win32", { NOMARMY_NATIVE: "0" }, true], ["win32", { NOMARMY_NATIVE: "true" }, true],
    ["linux", {}, false], ["darwin", {}, false],
    ["win32", { WSL_DISTRO_NAME: "Ubuntu" }, false], ["win32", { WSL_INTEROP: "/run/WSL/1_interop" }, false],
  ]) assert.equal(wsl.windowsFrontEnd({ platform, env }), expected);
  const cli = fs.readFileSync(path.join(root, "bin/nomarmy.mjs"), "utf8");
  assert.equal(cli.includes("isNativeWindows"), false);
  assert.equal((cli.match(/windowsFrontEnd\(\)/g) ?? []).length, 4);
  const windowsJob = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8").split("  windows:")[1];
  assert.match(windowsJob, /- run: npm test\r?\n        env:\r?\n          NOMARMY_NATIVE: "1"/);
});

for (const target of ["claude", "codex", "cursor"]) {
  test(`Windows ${target} registration carries coordinator OS and translated paths`, t => {
    const dir = fs.mkdtempSync(path.join(root, ".wsl-front-end-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const commandsDir = path.join(dir, "commands"), configPath = path.join(dir, "mcp.json");
    const launch = wsl.mcpBridgeLaunch({ distro: "Ubuntu", node: "/usr/bin/node", script: "/opt/nomarmy/bin/nomarmy.mjs" });
    const calls = [];
    connectViaWsl({ target, distro: "Ubuntu", launch, commandsDir, configPath, nomarmyRoot: root,
      run: (...args) => calls.push(args) });
    if (target === "cursor") {
      assert.deepEqual(calls, []);
      assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), { mcpServers: {
        "nomarmy-local-worker": { command: "wsl.exe", args: launch.args, env: { ...bridgeEnv, NOMARMY_PROJECT_DIR: "${workspaceFolder}" } },
      } });
    } else {
      const flag = target === "claude" ? "-e" : "--env";
      assert.deepEqual(calls, [
        [target, ["mcp", "remove", "nomarmy-local-worker", ...(target === "claude" ? ["--scope", "user"] : [])], {}],
        [target, ["mcp", "add", ...(target === "claude" ? ["--scope", "user"] : []), "nomarmy-local-worker",
          flag, `WSLENV=${bridgeEnv.WSLENV}`, flag, "NOMARMY_COORDINATOR_OS=windows", "--", "wsl.exe", ...launch.args]],
      ]);
    }
  });
}

test("Windows job paths decorate response records recursively only for Windows coordinators in WSL", () => {
  const original = {
    jobDir: "/home/you/jobs/job-1", worktree: "/mnt/c/src/my repo",
    jobs: [{ jobDir: "/mnt/c/jobs/1", worktree: "/home/you/src" }],
    report: { worktree: null, jobDir: "relative", detail: "/home/unrelated" },
  };
  const snapshot = structuredClone(original);
  assert.deepEqual(wsl.withWindowsPaths(original, coordinatorEnv), {
    ...original, jobDirWindows: "\\\\wsl.localhost\\Ubuntu\\home\\you\\jobs\\job-1", worktreeWindows: "C:\\src\\my repo",
    jobs: [{ jobDir: "/mnt/c/jobs/1", worktree: "/home/you/src", jobDirWindows: "C:\\jobs\\1", worktreeWindows: "\\\\wsl.localhost\\Ubuntu\\home\\you\\src" }],
  });
  assert.deepEqual(original, snapshot);
  for (const env of [{}, { NOMARMY_COORDINATOR_OS: "windows" }, { WSL_DISTRO_NAME: "Ubuntu" }, { ...coordinatorEnv, NOMARMY_COORDINATOR_OS: "linux" }]) {
    assert.equal(wsl.withWindowsPaths(original, env), original);
    assert.deepEqual(wsl.withWindowsPaths(original, env), snapshot);
  }
});

test("WSL notifier builds an encoded Windows toast with safe literal text", () => {
  const title = "nomArmy: done", message = 'Review <job> & "result" 雪';
  const [command, args] = notificationCommand(title, message, { platform: "linux", env: coordinatorEnv });
  assert.equal(command, "powershell.exe");
  assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  assert.equal(args.length, 4);
  const script = Buffer.from(args[3], "base64").toString("utf16le");
  assert.equal(Buffer.from(script, "utf16le").toString("base64"), args[3]);
  assert.ok(script.includes(`[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Microsoft.Windows.PowerShell').Show($toast)`));
  assert.ok(script.includes(`$text.Item(0).InnerText = '${title}'`));
  assert.ok(script.includes(`$text.Item(1).InnerText = '${message}'`));
  const unsafe = "x'; $(exit 1); 'y";
  const encoded = notificationCommand(unsafe, unsafe, { platform: "linux", env: coordinatorEnv })[1][3];
  const escaped = Buffer.from(encoded, "base64").toString("utf16le");
  assert.ok(escaped.includes("$text.Item(0).InnerText = 'x''; $(exit 1); ''y'"));
  assert.ok(escaped.includes("$text.Item(1).InnerText = 'x''; $(exit 1); ''y'"));
  for (const quote of ["\u2018", "\u2019", "\u201a", "\u201b"]) {
    const text = `x${quote}; $(exit 1); ${quote}y`;
    const script = Buffer.from(notificationCommand(text, text, { platform: "linux", env: coordinatorEnv })[1][3], "base64").toString("utf16le");
    assert.ok(script.includes(`$text.Item(0).InnerText = 'x${quote}${quote}; $(exit 1); ${quote}${quote}y'`));
    assert.ok(script.includes(`$text.Item(1).InnerText = 'x${quote}${quote}; $(exit 1); ${quote}${quote}y'`));
  }
  assert.equal(notificationCommand(title, message, { platform: "linux", env: { ...coordinatorEnv, NOMARMY_NOTIFY: "0" } }), null);
});

test("WSL notifications swallow synchronous and asynchronous failures and fall back once", () => {
  for (const failure of ["throw", "error", "exit", "success"]) {
    const calls = [], child = new EventEmitter();
    let unrefs = 0;
    child.unref = () => { unrefs++; };
    const run = (command, args, options) => {
      calls.push([command, args, options]);
      if (command === "notify-send" || failure === "throw") throw new Error("unavailable");
      return child;
    };
    const expectedCommand = notificationCommand("t", "m", { platform: "linux", env: coordinatorEnv });
    assert.equal(notify("t", "m", { platform: "linux", env: coordinatorEnv, run }), failure !== "throw");
    if (failure === "error") { child.emit("error", new Error("interop disabled")); child.emit("exit", -1, null); }
    if (failure === "exit") child.emit("exit", 1, null);
    if (failure === "success") child.emit("exit", 0, null);
    assert.deepEqual(calls, [
      [...expectedCommand, { stdio: "ignore", detached: true }],
      ...(failure === "success" ? [] : [["notify-send", ["--app-name=nomArmy", "t", "m"], { stdio: "ignore", detached: true }]]),
    ]);
    assert.equal(unrefs, failure === "throw" ? 0 : 1);
  }
  const calls = [];
  assert.equal(notify("t", "m", { platform: "linux", env: { ...coordinatorEnv, NOMARMY_NOTIFY: "0" }, run: (...args) => calls.push(args) }), false);
  assert.deepEqual(calls, []);
});
