import assert from "node:assert/strict";
import test from "node:test";
import { windowsPlan, windowsForwardCommand, windowsForward, windowsSetup, windowsDoctorChecks, windowsDoctor } from "../lib/wsl-cli.mjs";

const WSL_FIX = "WSL isn't installed. In an administrator PowerShell run: wsl --install, restart Windows, then run nomarmy setup again.";
const DISTRO_FIX = "Install a Linux distro: wsl --install -d Ubuntu, open it once to create your user, then run nomarmy setup again.";
const NODE_FIX = "Install Node 24 (24.16+) inside Ubuntu:\ncurl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash\nThen reopen the distro shell and run: nvm install 24\nThen run nomarmy setup again.";
const NOMARMY_FIX = "nomArmy isn't installed in WSL distro Ubuntu: inside it run `npm install -g nomarmy@alpha` (Node 24.16+), then run nomarmy connect again";
const NEXT = "Register your coordinators on Windows: nomarmy connect claude (or codex, cursor)";
const RESOLVE = 'printf "NOMARMY_NODE=%s\\n" "$(command -v node)"; printf "NOMARMY_SCRIPT=%s\\n" "$(readlink -f "$(command -v nomarmy)")"';
const driveMessage = "A Windows-drive repository works, but a repo inside WSL (for example ~/src in Ubuntu, opened as \\\\wsl.localhost\\Ubuntu\\src) is much faster for jobs.";

function fixture({ listing = "* Ubuntu    Running    2\n", installed = true, node = "v24.16.0\n", answer = "", status = 0, installStatus = 0, saved = null, shaped = false, engine = { ok: true, checks: [] } } = {}) {
  const calls = [], printed = [], prompts = [], writes = [];
  let settings = saved ? JSON.stringify(typeof saved === "string" ? { distro: saved } : saved) : null;
  const fs = {
    readFileSync(file, encoding) {
      assert.equal(file, "C:\\Users\\me\\.config\\nomarmy\\windows.json");
      assert.equal(encoding, "utf8");
      if (settings === null) throw new Error("ENOENT");
      return settings;
    },
    mkdirSync(...args) { writes.push(["mkdir", ...args]); },
    writeFileSync(file, contents, encoding) { writes.push(["write", file, contents, encoding]); settings = contents; },
  };
  const run = (command, args, opts) => {
    calls.push([command, args, opts]);
    assert.equal(command, "wsl.exe");
    if (opts.stdio === "inherit") {
      const installing = args.at(-1) === "npm install -g nomarmy@alpha";
      const code = installing ? installStatus : status;
      if (installing && code === 0) installed = true;
      return { status: code };
    }
    if (opts.stdio[0] === "inherit" && opts.stdio[1] === "pipe") {
      return { status, stdout: typeof engine === "string" ? engine : JSON.stringify(engine) };
    }
    let stdout;
    if (args[0] === "-l") stdout = listing;
    else if (args.at(-1) === RESOLVE) stdout = installed ? "NOMARMY_NODE=/usr/bin/node\nNOMARMY_SCRIPT=/usr/lib/node_modules/nomarmy/bin/nomarmy.mjs\n" : null;
    else if (args.at(-1) === "node --version") stdout = node;
    else assert.fail(`Unexpected probe: ${JSON.stringify(args)}`);
    if (shaped) return { status: stdout === null ? 1 : 0, stdout };
    if (stdout === null) throw new Error("missing");
    return stdout;
  };
  return { run, env: { USERPROFILE: "C:\\Users\\me" }, fs, cwd: "C:\\src\\repo", print: (line) => printed.push(line),
    ask: async (prompt) => { prompts.push(prompt); return answer; }, calls, printed, prompts, writes };
}

function launch(args, cwd = null, distro = "Ubuntu") {
  return { command: "wsl.exe", args: ["-d", distro, ...(cwd ? ["--cd", cwd] : []), "--", "bash", "-lc", `exec nomarmy ${args}`] };
}
const wslCheck = { id: "wsl", ok: true, message: "WSL is installed.", fix: null };
const distroCheck = { id: "wsl-distro", ok: true, message: "Ubuntu uses WSL 2.", fix: null };
const nomarmyCheck = { id: "wsl-nomarmy", ok: true, message: "nomArmy is installed in Ubuntu.", fix: null };
const driveCheck = { id: "wsl-repo", ok: true, message: driveMessage, fix: null };

test("windowsPlan keeps only the Windows front-end commands local", () => {
  for (const argv of [[], ["help"], ["--help"], ["connect", "claude"], ["setup"], ["doctor", "--json"]]) assert.equal(windowsPlan(argv), "LOCAL");
  for (const command of ["mcp", "init", "jobs", "install", "update", "unknown", "--version", "scan"]) assert.equal(windowsPlan([command]), "FORWARD");
  assert.equal(windowsPlan(["jobs", "--help"]), "FORWARD");
});

for (const [name, cwd, expected] of [
  ["drive", "D:\\my repo\\src", "/mnt/d/my repo/src"],
  ["same-distro localhost", "\\\\wsl.localhost\\Ubuntu\\home\\me\\repo", "/home/me/repo"],
  ["same-distro wsl dollar", "\\\\wsl$\\ubuntu\\home\\me", "/home/me"],
  ["unrelated UNC", "\\\\server\\share\\repo", null],
  ["other distro", "\\\\wsl.localhost\\Debian\\home\\me", null],
  ["relative", "repo", null],
]) {
  test(`forwarding translates ${name} cwd`, () => {
    const f = fixture();
    assert.deepEqual(windowsForwardCommand(["jobs", "a b"], { ...f, cwd }), launch("jobs 'a b'", expected));
  });
}

test("forwarding prefers saved distro and inherits stdio with the child exit status", () => {
  const f = fixture({ saved: "Debian", status: 7 });
  assert.equal(windowsForward(["jobs"], f), 7);
  const expected = launch("jobs", "/mnt/c/src/repo", "Debian");
  assert.deepEqual(f.calls, [[expected.command, expected.args, { stdio: "inherit" }]]);
  assert.deepEqual(f.printed, []);
});

test("forwarding reports distro selection failures with setup guidance", () => {
  const f = fixture({ listing: "" });
  assert.equal(windowsForward(["jobs"], f), 1);
  assert.deepEqual(f.printed, ["install a Linux distro: `wsl --install -d Ubuntu`; then run nomarmy setup"]);
  assert.equal(f.calls.some((call) => call[2].stdio === "inherit"), false);
});

test("forwarding treats a failed spawn as exit 1", () => {
  const f = fixture({ saved: "Ubuntu", status: null });
  assert.equal(windowsForward(["jobs"], f), 1);
});

for (const [name, listing, message] of [["WSL missing", null, WSL_FIX], ["no distro", "", DISTRO_FIX]]) {
  test(`setup: ${name} gives the exact fix`, async () => {
    const f = fixture({ listing });
    assert.equal(await windowsSetup(["setup"], f), 1);
    assert.deepEqual(f.printed, [message]);
    assert.deepEqual(f.prompts, []);
    assert.deepEqual(f.writes, []);
  });
}

for (const node of [null, "v22.20.0\n", "v24.15.9\n", "unrecognized\n"]) {
  test(`setup rejects missing or old Node: ${node}`, async () => {
    const f = fixture({ installed: false, node });
    assert.equal(await windowsSetup(["setup"], f), 1);
    assert.deepEqual(f.printed, [NODE_FIX]);
    assert.deepEqual(f.prompts, []);
    assert.deepEqual(f.calls.at(-1), ["wsl.exe", ["-d", "Ubuntu", "--", "bash", "-lic", "node --version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }]);
  });
}

for (const answer of ["", "y", "Yes"]) {
  test(`setup accepts install prompt: ${JSON.stringify(answer)}`, async () => {
    const f = fixture({ installed: false, answer, shaped: true });
    assert.equal(await windowsSetup(["setup"], f), 0);
    assert.deepEqual(f.prompts, ["Install nomArmy inside Ubuntu now? [Y/n]"]);
    const setup = { command: "wsl.exe", args: ["-d", "Ubuntu", "--", "/usr/bin/node", "/usr/lib/node_modules/nomarmy/bin/nomarmy.mjs", "setup"] };
    assert.deepEqual(f.calls.filter((call) => call[2].stdio === "inherit"), [
      ["wsl.exe", ["-d", "Ubuntu", "--", "bash", "-lic", "npm install -g nomarmy@alpha"], { stdio: "inherit" }],
      [setup.command, setup.args, { stdio: "inherit" }],
    ]);
    assert.deepEqual(f.printed, [NEXT]);
    assert.deepEqual(f.writes, [
      ["mkdir", "C:\\Users\\me\\.config\\nomarmy", { recursive: true }],
      ["write", "C:\\Users\\me\\.config\\nomarmy\\windows.json", '{\n  "distro": "Ubuntu",\n  "node": "/usr/bin/node",\n  "script": "/usr/lib/node_modules/nomarmy/bin/nomarmy.mjs"\n}\n', "utf8"],
    ]);
  });
}

test("setup declining install does not run install or engine setup", async () => {
  const f = fixture({ installed: false, answer: "n" });
  assert.equal(await windowsSetup(["setup"], f), 1);
  assert.deepEqual(f.prompts, ["Install nomArmy inside Ubuntu now? [Y/n]"]);
  assert.deepEqual(f.printed, []);
  assert.deepEqual(f.calls.filter((call) => call[2].stdio === "inherit"), []);
});

test("setup stops on installation failure", async () => {
  const f = fixture({ installed: false, installStatus: 3 });
  assert.equal(await windowsSetup(["setup"], f), 3);
  assert.deepEqual(f.printed, []);
  assert.deepEqual(f.calls.filter((call) => call[2].stdio === "inherit"), [
    ["wsl.exe", ["-d", "Ubuntu", "--", "bash", "-lic", "npm install -g nomarmy@alpha"], { stdio: "inherit" }],
  ]);
});

test("setup already installed skips Node and install and propagates engine failure", async () => {
  const f = fixture({ status: 4 });
  assert.equal(await windowsSetup(["setup"], f), 4);
  assert.deepEqual(f.prompts, []);
  assert.deepEqual(f.printed, []);
  assert.equal(f.calls.length, 4);
  const setup = { command: "wsl.exe", args: ["-d", "Ubuntu", "--", "/usr/bin/node", "/usr/lib/node_modules/nomarmy/bin/nomarmy.mjs", "setup"] };
  assert.deepEqual(f.calls.at(-1), [setup.command, setup.args, { stdio: "inherit" }]);
});

test("setup forwards llama server arguments to the engine", async () => {
  const f = fixture();
  const argv = ["setup", "--llama-url", "http://192.168.1.5:8080"];
  assert.equal(await windowsSetup(argv, f), 0);
  assert.deepEqual(f.calls.at(-1), ["wsl.exe", ["-d", "Ubuntu", "--", "/usr/bin/node", "/usr/lib/node_modules/nomarmy/bin/nomarmy.mjs", ...argv], { stdio: "inherit" }]);
});

test("doctor reports missing WSL with exact check shape", () => {
  assert.deepEqual(windowsDoctorChecks(fixture({ listing: null, shaped: true })), [
    { id: "wsl", ok: false, message: "WSL isn't installed.", fix: WSL_FIX },
  ]);
});

test("doctor reports no distro", () => {
  assert.deepEqual(windowsDoctorChecks(fixture({ listing: "" })), [wslCheck,
    { id: "wsl-distro", ok: false, message: "No WSL distro chosen.", fix: DISTRO_FIX },
  ]);
});

test("doctor fails WSL version 1 with the conversion command", () => {
  assert.deepEqual(windowsDoctorChecks(fixture({ listing: "* Ubuntu    Running    1\n" })), [wslCheck,
    { id: "wsl-distro", ok: false, message: "Ubuntu uses WSL 1.", fix: "wsl --set-version Ubuntu 2" },
    nomarmyCheck, driveCheck,
  ]);
});

test("doctor reports missing nomArmy", () => {
  assert.deepEqual(windowsDoctorChecks(fixture({ installed: false })), [wslCheck, distroCheck,
    { id: "wsl-nomarmy", ok: false, message: "nomArmy wasn't found in Ubuntu.", fix: NOMARMY_FIX }, driveCheck,
  ]);
});

test("doctor accepts a Windows drive with the performance guidance", () => {
  assert.deepEqual(windowsDoctorChecks(fixture({ shaped: true })), [wslCheck, distroCheck, nomarmyCheck, driveCheck]);
});

test("doctor accepts a same-distro localhost repo as fast", () => {
  assert.deepEqual(windowsDoctorChecks({ ...fixture(), cwd: "\\\\wsl.localhost\\Ubuntu\\home\\me\\src" }), [wslCheck, distroCheck, nomarmyCheck,
    { id: "wsl-repo", ok: true, message: "Repository is inside WSL, the fast location for jobs.", fix: null },
  ]);
});

test("doctor rejects unrelated UNC repo locations", () => {
  assert.deepEqual(windowsDoctorChecks({ ...fixture(), cwd: "\\\\server\\repo" }), [wslCheck, distroCheck, nomarmyCheck,
    { id: "wsl-repo", ok: false, message: "Repository location cannot be forwarded to the chosen WSL distro.", fix: "Open a repo inside Ubuntu using \\\\wsl.localhost\\Ubuntu\\, or use a Windows drive." },
  ]);
});

test("doctor emits one combined JSON document and uses worse status", () => {
  const engineReport = { ok: false, checks: [{ id: "engine", ok: false }] };
  const f = fixture({ status: 5, engine: engineReport });
  assert.equal(windowsDoctor({ ...f, json: true, argv: ["doctor", "--json"] }), 5);
  assert.deepEqual(f.printed, [JSON.stringify({ ok: false, windows: { checks: [wslCheck, distroCheck, nomarmyCheck, driveCheck] }, engine: engineReport }, null, 2)]);
  assert.deepEqual(JSON.parse(f.printed.join("\n")), {
    ok: false, windows: { checks: [wslCheck, distroCheck, nomarmyCheck, driveCheck] }, engine: engineReport,
  });
  const engine = launch("doctor --json", "/mnt/c/src/repo");
  assert.deepEqual(f.calls.at(-1), [engine.command, engine.args, { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] }]);
});

test("doctor prints normal formatting and does not forward when prerequisites fail", () => {
  const f = fixture({ listing: null });
  assert.equal(windowsDoctor(f), 1);
  assert.deepEqual(f.printed, ["nomArmy doctor report\n", "  ✗ WSL isn't installed.", `    Fix: ${WSL_FIX}`, "\nSome checks failed."]);
  assert.equal(f.calls.length, 1);
});

test("doctor preserves a local failure even if engine checks pass", () => {
  const f = fixture();
  assert.equal(windowsDoctor({ ...f, cwd: "\\\\server\\repo" }), 1);
  const engine = launch("doctor");
  assert.deepEqual(f.calls.at(-1), [engine.command, engine.args, { stdio: "inherit" }]);
});


test("forwarding uses saved executable argv verbatim without a shell", () => {
  const saved = { distro: "Debian", node: "/my node/bin/node", script: "/my repo/cli=1.mjs" };
  const f = fixture({ saved, status: 7 });
  const argv = ["jobs", "a b", "$(id)", "x'y"];
  assert.deepEqual(windowsForwardCommand(argv, f), {
    command: "wsl.exe", args: ["-d", "Debian", "--cd", "/mnt/c/src/repo", "--", saved.node, saved.script, ...argv],
  });
  assert.equal(windowsForward(argv, f), 7);
  assert.deepEqual(f.calls, [["wsl.exe", ["-d", "Debian", "--cd", "/mnt/c/src/repo", "--", saved.node, saved.script, ...argv], { stdio: "inherit" }]]);
});

test("setup saves resolved executables for subsequent forwarding", async () => {
  const f = fixture();
  assert.equal(await windowsSetup(["setup"], f), 0);
  assert.deepEqual(JSON.parse(f.writes.at(-1)[2]), {
    distro: "Ubuntu", node: "/usr/bin/node", script: "/usr/lib/node_modules/nomarmy/bin/nomarmy.mjs",
  });
  assert.deepEqual(windowsForwardCommand(["jobs"], f), {
    command: "wsl.exe", args: ["-d", "Ubuntu", "--cd", "/mnt/c/src/repo", "--", "/usr/bin/node", "/usr/lib/node_modules/nomarmy/bin/nomarmy.mjs", "jobs"],
  });
});

test("doctor JSON handles success, invalid output and missing prerequisites in one document", () => {
  for (const [engine, status, expectedStatus, expectedEngine] of [
    [{ ok: true, checks: [] }, 0, 0, { ok: true, checks: [] }],
    [{ ok: false, checks: [] }, 0, 1, { ok: false, checks: [] }],
    ["not JSON", 0, 1, null],
    ["{}", null, 1, {}],
    ["null", 0, 1, null],
  ]) {
    const f = fixture({ engine, status });
    assert.equal(windowsDoctor({ ...f, json: true }), expectedStatus);
    assert.equal(f.printed.length, 1);
    assert.deepEqual(JSON.parse(f.printed.join("\n")), {
      ok: expectedStatus === 0, windows: { checks: [wslCheck, distroCheck, nomarmyCheck, driveCheck] }, engine: expectedEngine,
    });
    assert.deepEqual(f.calls.at(-1), ["wsl.exe", launch("doctor --json", "/mnt/c/src/repo").args,
      { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] }]);
  }
  const f = fixture({ listing: null });
  assert.equal(windowsDoctor({ ...f, json: true }), 1);
  assert.equal(f.printed.length, 1);
  assert.deepEqual(JSON.parse(f.printed.join("\n")), {
    ok: false, windows: { checks: [{ id: "wsl", ok: false, message: "WSL isn't installed.", fix: WSL_FIX }] }, engine: null,
  });
  assert.equal(f.calls.length, 1);
});
