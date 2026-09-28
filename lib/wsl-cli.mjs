// Native Windows CLI decisions. All operating-system boundaries are injectable.
import fsDefault from "node:fs";
import { spawnSync } from "node:child_process";
import { listDistros, pickDistro, readWindowsSettings, writeWindowsSettings, resolveWslNomarmy, windowsToWslPath, wslCommand } from "./wsl.mjs";

const WSL_FIX = "WSL isn't installed. In an administrator PowerShell run: wsl --install, restart Windows, then run nomarmy setup again.";
const DISTRO_FIX = "Install a Linux distro: wsl --install -d Ubuntu, open it once to create your user, then run nomarmy setup again.";

export function windowsPlan(argv) {
  return ["jobs", "stats", "agents", "army", "validators", "config", "update", "mcp", "install", "start", "stop", "sandbox", "health", "model", "statusline", "uninstall"].includes(argv[0]) ? "FORWARD" : "LOCAL";
}

// Adapt either execFileSync (stdout/throw) or spawnSync (result object).
function capture(run) {
  return (command, args, options = {}) => {
    const result = run(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
    if (result && typeof result === "object" && !Buffer.isBuffer(result)) {
      if (result.error || result.status !== 0) throw result.error || new Error(`Command exited ${result.status}`);
      return result.stdout ?? "";
    }
    return result;
  };
}

function execute(run, launch) {
  try {
    const result = run(launch.command, launch.args, { stdio: "inherit" });
    return result && typeof result === "object" && !Buffer.isBuffer(result) ? result.status ?? 1 : 0;
  } catch (error) { return Number.isInteger(error.status) ? error.status : 1; }
}

export function windowsForwardCommand(argv, { run = spawnSync, env = process.env, fs = fsDefault, cwd = process.cwd() } = {}) {
  const { distro: savedDistro, node, script } = readWindowsSettings({ env, fs });
  const distro = savedDistro || pickDistro({ run: capture(run), env, fs });
  const translated = windowsToWslPath(cwd);
  const sameDistro = translated?.distro?.toLowerCase() === distro.toLowerCase();
  const directory = translated && (/^[A-Za-z]:[\\/]/.test(cwd) || sameDistro) ? translated.path : null;
  return wslCommand({ distro, args: argv, cwd: directory, node, script });
}

export function windowsForward(argv, { run = spawnSync, print = console.error, ...options } = {}) {
  let launch;
  try { launch = windowsForwardCommand(argv, { run, ...options }); }
  catch (error) {
    print(`${error.message}; then run nomarmy setup`);
    return 1;
  }
  return execute(run, launch);
}

export async function windowsSetup(argv, { run = spawnSync, env = process.env, fs = fsDefault, print = console.log, ask } = {}) {
  const probe = capture(run);
  const distros = listDistros({ run: probe });
  if (distros === null) { print(WSL_FIX); return 1; }
  if (!distros.length) { print(DISTRO_FIX); return 1; }
  let distro;
  try {
    distro = pickDistro({ run: probe, env, fs });
  } catch (error) { print(error.message); return 1; }
  let resolved;
  try { resolved = resolveWslNomarmy({ distro, run: probe }); }
  catch {
    let version = "";
    try { version = String(probe("wsl.exe", ["-d", distro, "--exec", "bash", "-lic", "node --version"])); } catch { /* Missing Node needs the same fix. */ }
    const match = /^v?(\d+)\.(\d+)\.\d+\s*$/m.exec(version);
    if (!match || Number(match[1]) < 24 || (Number(match[1]) === 24 && Number(match[2]) < 16)) {
      print(`Install Node 24 (24.16+) inside ${distro}:\ncurl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash\nThen reopen the distro shell and run: nvm install 24\nThen run nomarmy setup again.`);
      return 1;
    }
    const answer = await ask?.(`Install nomArmy inside ${distro} now? [Y/n]`);
    if (answer === undefined || !/^(?:y|yes)?$/i.test(String(answer).trim())) return 1;
    const installed = execute(run, { command: "wsl.exe", args: ["-d", distro, "--exec", "bash", "-lic", "npm install -g nomarmy@alpha"] });
    if (installed !== 0) return installed;
    try { resolved = resolveWslNomarmy({ distro, run: probe }); }
    catch (error) { print(error.message); return 1; }
  }
  try { writeWindowsSettings({ distro, ...resolved }, { env, fs }); }
  catch (error) { print(error.message); return 1; }
  const status = execute(run, wslCommand({ distro, ...resolved, args: argv }));
  // With --json the engine's document is the whole of stdout.
  if (status === 0 && !argv.includes("--json")) print("Register your coordinators on Windows: nomarmy connect claude (or codex, cursor)");
  return status;
}

export function windowsDoctorChecks({ run = spawnSync, env = process.env, fs = fsDefault, cwd = process.cwd() } = {}) {
  const probe = capture(run);
  const distros = listDistros({ run: probe });
  const checks = [{ id: "wsl", ok: distros !== null, message: distros === null ? "WSL isn't installed." : "WSL is installed.", fix: distros === null ? WSL_FIX : null }];
  if (distros === null) return checks;
  let distro;
  try { distro = pickDistro({ run: probe, env, fs }); }
  catch (error) {
    checks.push({ id: "wsl-distro", ok: false, message: "No WSL distro chosen.", fix: distros.length ? error.message : DISTRO_FIX });
    return checks;
  }
  const version = distros.find((d) => d.name === distro).version;
  checks.push({ id: "wsl-distro", ok: version === 2, message: `${distro} uses WSL ${version}.`, fix: version === 2 ? null : `wsl --set-version ${distro} 2` });
  try {
    resolveWslNomarmy({ distro, run: probe });
    checks.push({ id: "wsl-nomarmy", ok: true, message: `nomArmy is installed in ${distro}.`, fix: null });
  } catch (error) {
    checks.push({ id: "wsl-nomarmy", ok: false, message: `nomArmy wasn't found in ${distro}.`, fix: error.message });
  }
  const translated = windowsToWslPath(cwd);
  const fast = translated?.distro?.toLowerCase() === distro.toLowerCase();
  const drive = /^[A-Za-z]:[\\/]/.test(cwd);
  checks.push({
    id: "wsl-repo", ok: fast || drive,
    message: fast ? "Repository is inside WSL, the fast location for jobs." : drive
      ? `A Windows-drive repository works, but a repo inside WSL (for example ~/src in ${distro}, opened as \\\\wsl.localhost\\${distro}\\src) is much faster for jobs.`
      : "Repository location cannot be forwarded to the chosen WSL distro.",
    fix: fast || drive ? null : `Open a repo inside ${distro} using \\\\wsl.localhost\\${distro}\\, or use a Windows drive.`,
  });
  return checks;
}

export function windowsDoctor({ run = spawnSync, print = console.log, json = false, argv = ["doctor"], ...options } = {}) {
  const checks = windowsDoctorChecks({ run, ...options });
  const ok = checks.every((check) => check.ok);
  if (!json) {
    print("nomArmy doctor report\n");
    for (const check of checks) {
      print(`  ${check.ok ? "✓" : "✗"} ${check.message}`);
      if (!check.ok && check.fix) print(`    Fix: ${check.fix}`);
    }
    print(ok ? "\nAll checks passed." : "\nSome checks failed.");
  }
  const engineReady = ["wsl", "wsl-distro", "wsl-nomarmy"].every((id) => checks.some((check) => check.id === id && check.ok));
  if (json) {
    let engine = null;
    let status = 0;
    if (engineReady) {
      try {
        const launch = windowsForwardCommand(argv.includes("--json") ? argv : [...argv, "--json"], { run, ...options });
        const result = run(launch.command, launch.args, { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] });
        status = result?.status ?? 1;
        engine = JSON.parse(result?.stdout ?? "");
        if (result?.error || engine === null || engine?.ok === false) status = Math.max(status, 1);
      } catch { status = Math.max(status, 1); }
    }
    const exitStatus = Math.max(ok ? 0 : 1, status);
    print(JSON.stringify({ ok: exitStatus === 0, windows: { checks }, engine }, null, 2));
    return exitStatus;
  }
  return Math.max(ok ? 0 : 1, engineReady ? windowsForward(argv, { run, print, ...options }) : 0);
}
