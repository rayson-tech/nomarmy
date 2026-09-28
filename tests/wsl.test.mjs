import assert from "node:assert/strict";
import test from "node:test";
import {
  isNativeWindows, parseWslList, listDistros, windowsToWslPath, wslToWindowsPath,
  shellQuote, wslCommand, mcpBridgeLaunch, windowsSettingsPath,
  readWindowsSettings, writeWindowsSettings,
} from "../lib/wsl.mjs";

const listing = "  NAME                   STATE           VERSION\r\n* Ubuntu-24.04           Running         2\r\n  Debian                 Stopped         2\r\n\r\n";
const expected = [
  { name: "Ubuntu-24.04", state: "Running", version: 2, isDefault: true },
  { name: "Debian", state: "Stopped", version: 2, isDefault: false },
];
const utf16 = Buffer.from(`\uFEFF${listing}`, "utf16le");

test("isNativeWindows distinguishes native Windows from WSL and other platforms", () => {
  assert.equal(isNativeWindows({ platform: "win32", env: {} }), true);
  for (const platform of ["linux", "darwin", "win32"]) {
    assert.equal(isNativeWindows({ platform, env: { WSL_DISTRO_NAME: "Ubuntu" } }), false);
    assert.equal(isNativeWindows({ platform, env: { WSL_INTEROP: "/run/WSL/1_interop" } }), false);
  }
  assert.equal(isNativeWindows({ platform: "win32", env: { NOMARMY_WINDOWS_ENGINE: "native" } }), false);
  assert.equal(isNativeWindows({ platform: "win32", env: { NOMARMY_WINDOWS_ENGINE: "wsl" } }), true);
  assert.equal(isNativeWindows({ platform: "linux", env: {} }), false);
  assert.equal(isNativeWindows({ platform: "darwin", env: {} }), false);
});

test("parseWslList handles BOM, NULs, UTF-8, headers and blank lines", () => {
  for (const input of [utf16, Buffer.from(listing, "utf16le"), Buffer.from(listing), listing, utf16.toString("utf8")]) {
    assert.deepEqual(parseWslList(input), expected);
  }
  assert.deepEqual(parseWslList("\n  NAME    STATE    VERSION\n"), []);
  assert.deepEqual(parseWslList("  My Distro    Stopped    1\n"), [
    { name: "My Distro", state: "Stopped", version: 1, isDefault: false },
  ]);
});

test("listDistros invokes wsl.exe and returns null on missing or failed WSL", () => {
  const calls = [];
  assert.deepEqual(listDistros({ run: (...args) => { calls.push(args); return utf16; } }), expected);
  assert.deepEqual(calls, [["wsl.exe", ["-l", "-v"]]]);
  for (const code of ["ENOENT", "EACCES", 1]) {
    assert.equal(listDistros({ run: () => { throw Object.assign(new Error("failed"), { code }); } }), null);
  }
});

test("windowsToWslPath translates drives and WSL UNC paths but rejects network shares", () => {
  for (const input of ["C:\\Users\\Jason Pugh\\repo", "C:/Users/Jason Pugh/repo"]) {
    assert.deepEqual(windowsToWslPath(input), { path: "/mnt/c/Users/Jason Pugh/repo", distro: null });
  }
  for (const host of ["wsl$", "wsl.localhost"]) {
    assert.deepEqual(windowsToWslPath(`\\\\${host}\\Ubuntu\\home\\j\\x`), { path: "/home/j/x", distro: "Ubuntu" });
    assert.deepEqual(windowsToWslPath(`//${host}/Ubuntu`), { path: "/", distro: "Ubuntu" });
  }
  assert.equal(windowsToWslPath("\\\\server\\share\\repo"), null);
  assert.equal(windowsToWslPath("//server/share/repo"), null);
  assert.deepEqual(windowsToWslPath("/home/j/repo"), { path: "/home/j/repo", distro: null });
  assert.deepEqual(windowsToWslPath("relative/repo"), { path: "relative/repo", distro: null });
});

test("wslToWindowsPath translates absolute paths and round trips both path families", () => {
  assert.equal(wslToWindowsPath("/mnt/c/x/y", {}), "C:\\x\\y");
  assert.equal(wslToWindowsPath("/mnt/z/", {}), "Z:\\");
  assert.equal(wslToWindowsPath("/home/j/x", { distro: "Ubuntu" }), "\\\\wsl.localhost\\Ubuntu\\home\\j\\x");
  assert.equal(wslToWindowsPath("/", { distro: "Ubuntu" }), "\\\\wsl.localhost\\Ubuntu\\");
  assert.equal(wslToWindowsPath("relative", { distro: "Ubuntu" }), null);
  for (const original of ["C:\\Users\\Jason Pugh\\repo", "\\\\wsl.localhost\\Ubuntu\\home\\j\\x"]) {
    const translated = windowsToWslPath(original);
    assert.equal(wslToWindowsPath(translated.path, translated), original);
  }
  for (const original of ["/home/j/x", "/mnt/c/Users/Jason Pugh/repo", "/"]) {
    assert.deepEqual(windowsToWslPath(wslToWindowsPath(original, { distro: "Ubuntu" })), {
      path: original, distro: original.startsWith("/mnt/") ? null : "Ubuntu",
    });
  }
});

test("shellQuote protects single quotes, whitespace and bash metacharacters", () => {
  assert.equal(shellQuote("Jason's repo"), "'Jason'\\''s repo'");
  assert.equal(shellQuote(""), "''");
  assert.equal(shellQuote("AZaz09_./:=@%+-"), "AZaz09_./:=@%+-");
  assert.equal(shellQuote("$(touch /tmp/x); `whoami`\n*"), "'$(touch /tmp/x); `whoami`\n*'");
});

const invalidDistros = ["--exec", ".", "..", "Ubuntu; rm -rf /", "", "a".repeat(65), "Ubuntu Linux", "Ubuntu\n", "$(id)", null, 123];

test("wslCommand builds a quoted login-shell launch and refuses invalid distro names", () => {
  assert.deepEqual(wslCommand({ distro: "Ubuntu-24.04", args: ["connect", "Jason's repo"], cwd: "/home/j/my repo" }), {
    command: "wsl.exe",
    args: ["-d", "Ubuntu-24.04", "--cd", "/home/j/my repo", "--exec", "bash", "-lic", "exec nomarmy connect 'Jason'\\''s repo'"],
  });
  assert.deepEqual(wslCommand({ distro: "a".repeat(64), args: [] }), {
    command: "wsl.exe", args: ["-d", "a".repeat(64), "--exec", "bash", "-lic", "exec nomarmy "],
  });
  for (const distro of invalidDistros) assert.throws(() => wslCommand({ distro, args: [] }), /Invalid WSL distro name/);
});

test("mcpBridgeLaunch supplies translated environment paths and validates distro names", () => {
  assert.deepEqual(mcpBridgeLaunch({ distro: "Ubuntu_24.04" }), {
    command: "wsl.exe", args: ["-d", "Ubuntu_24.04", "--exec", "bash", "-lc", "exec nomarmy mcp"],
    env: { WSLENV: "CLAUDE_PROJECT_DIR/pu:NOMARMY_PROJECT_DIR/pu" },
  });
  for (const distro of invalidDistros) assert.throws(() => mcpBridgeLaunch({ distro }), /Invalid WSL distro name/);
});

test("windowsSettingsPath prefers USERPROFILE and falls back to HOME independent of host", () => {
  assert.equal(windowsSettingsPath({ env: { USERPROFILE: "C:\\Users\\Jason Pugh", HOME: "/ignored" } }), "C:\\Users\\Jason Pugh\\.config\\nomarmy\\windows.json");
  assert.equal(windowsSettingsPath({ env: { HOME: "/home/j" } }), "/home/j/.config/nomarmy/windows.json");
  assert.equal(windowsSettingsPath({ env: { USERPROFILE: "", HOME: "/home/j" } }), "/home/j/.config/nomarmy/windows.json");
  assert.throws(() => windowsSettingsPath({ env: {} }), /USERPROFILE or HOME/);
});

test("readWindowsSettings returns validated executable paths and a distro and tolerates missing or malformed data", () => {
  const env = { HOME: "/home/j" };
  const calls = [];
  assert.deepEqual(readWindowsSettings({ env, fs: { readFileSync: (...args) => { calls.push(args); return '{"distro":"Ubuntu","extra":true}'; } } }), { distro: "Ubuntu", node: null, script: null });
  assert.deepEqual(calls, [["/home/j/.config/nomarmy/windows.json", "utf8"]]);
  for (const settings of [
    { distro: "Ubuntu", node: "/usr/bin/node", script: "/my repo/cli=1.mjs" },
    { distro: "Ubuntu", node: "/tmp/%PATH%/node", script: "/tmp/cli\nmore" },
    { distro: "Ubuntu", node: 123, script: "relative" },
  ]) {
    assert.deepEqual(readWindowsSettings({ env, fs: { readFileSync: () => JSON.stringify({ ...settings, extra: true }) } }),
      settings.node === "/usr/bin/node" ? settings : { distro: "Ubuntu", node: null, script: null });
  }
  for (const text of ["{", "null", "{}", "[]", '{"distro":123}', '{"distro":null}']) {
    assert.deepEqual(readWindowsSettings({ env, fs: { readFileSync: () => text } }), { distro: null, node: null, script: null });
  }
  assert.deepEqual(readWindowsSettings({ env, fs: { readFileSync: () => { throw new Error("ENOENT"); } } }), { distro: null, node: null, script: null });
});

test("writeWindowsSettings creates its directory and writes pretty JSON via injected fs", () => {
  const calls = [];
  const fs = {
    mkdirSync: (...args) => calls.push(["mkdir", ...args]),
    writeFileSync: (...args) => calls.push(["write", ...args]),
  };
  writeWindowsSettings({ distro: "Ubuntu" }, { env: { USERPROFILE: "C:\\Users\\Jason Pugh" }, fs });
  assert.deepEqual(calls, [
    ["mkdir", "C:\\Users\\Jason Pugh\\.config\\nomarmy", { recursive: true }],
    ["write", "C:\\Users\\Jason Pugh\\.config\\nomarmy\\windows.json", '{\n  "distro": "Ubuntu"\n}\n', "utf8"],
  ]);
  assert.throws(() => writeWindowsSettings({ distro: null }, { env: { HOME: "/home/j" }, fs: {
    mkdirSync: () => {}, writeFileSync: () => { throw new Error("disk full"); },
  } }), /disk full/);
});


test("wslCommand validates cwd before creating a WSL option", () => {
  for (const cwd of ["--user", "relative", "", "/tmp/a\nb", "/tmp/a\rb", "/tmp/a\0b", 123]) {
    assert.throws(() => wslCommand({ distro: "Ubuntu", args: [], cwd }),
      { message: "Invalid WSL cwd: expected an absolute POSIX path without newlines or NUL" });
  }
  assert.deepEqual(wslCommand({ distro: "Ubuntu", args: ["jobs"], cwd: "/" }), {
    command: "wsl.exe", args: ["-d", "Ubuntu", "--cd", "/", "--exec", "bash", "-lic", "exec nomarmy jobs"],
  });
});

test("wslCommand uses validated saved executables without a shell or quoting", () => {
  const node = "/my node/bin/node", script = "/my repo/cli=1.mjs";
  const args = ["jobs", "a b", "$(id)", "x'y", "%PATH%", "--user"];
  for (const cwd of [null, "/home/my repo"]) {
    assert.deepEqual(wslCommand({ distro: "Ubuntu", node, script, args, cwd }), {
      command: "wsl.exe", args: ["-d", "Ubuntu", ...(cwd ? ["--cd", cwd] : []), "--exec", node, script, ...args],
    });
  }
  for (const bad of ["/tmp/%PATH%", "/tmp/a\nb", "/tmp/a\0b", "relative", ""]) {
    for (const name of ["node", "script"]) {
      assert.throws(() => wslCommand({ distro: "Ubuntu", node, script, args, [name]: bad }),
        { message: `Invalid WSL ${name} path: expected an absolute POSIX path using only ASCII letters, digits, /, _, ., :, @, +, space, =, and -` });
    }
  }
  assert.deepEqual(wslCommand({ distro: "Ubuntu", node, args: ["jobs"] }), {
    command: "wsl.exe", args: ["-d", "Ubuntu", "--exec", "bash", "-lic", "exec nomarmy jobs"],
  });
});
