// Windows is a thin front end: run the engine inside WSL while keeping path,
// launch and settings handling injectable for tests on any operating system.
import fsDefault from "node:fs";
import path from "node:path";

export function isNativeWindows({ platform = process.platform, env = process.env } = {}) {
  return platform === "win32" && !env.WSL_DISTRO_NAME && !env.WSL_INTEROP;
}

export function parseWslList(output) {
  let text = Buffer.isBuffer(output)
    ? output.toString(output.includes(0) || (output[0] === 0xff && output[1] === 0xfe) ? "utf16le" : "utf8")
    : String(output);
  // Also accept UTF-16LE accidentally decoded as UTF-8 by a caller.
  text = text.replace(/\0/g, "").replace(/^[\uFEFF\uFFFD]+/, "");
  const distros = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\*)?\s*(.+?)\s{2,}(\S+)\s+(\d+)\s*$/.exec(line);
    if (match) distros.push({ name: match[2], state: match[3], version: Number(match[4]), isDefault: Boolean(match[1]) });
  }
  return distros;
}

// run has the execFileSync contract: return stdout or throw on failure.
export function listDistros({ run }) {
  try { return parseWslList(run("wsl.exe", ["-l", "-v"])); } catch { return null; }
}

export function windowsToWslPath(p) {
  const normalized = p.replace(/\\/g, "/");
  if (normalized.startsWith("//")) {
    const match = /^\/\/(?:wsl\$|wsl\.localhost)\/([^/]+)(\/.*)?$/i.exec(normalized);
    return match ? { path: match[2] || "/", distro: match[1] } : null;
  }
  const drive = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  return { path: drive ? `/mnt/${drive[1].toLowerCase()}/${drive[2]}` : normalized, distro: null };
}

export function wslToWindowsPath(p, { distro } = {}) {
  const drive = /^\/mnt\/([a-z])(?:\/(.*))?$/.exec(p);
  if (drive) return `${drive[1].toUpperCase()}:\\${(drive[2] || "").replace(/\//g, "\\")}`;
  if (!p.startsWith("/")) return null;
  validateDistro(distro);
  return `\\\\wsl.localhost\\${distro}${p.replace(/\//g, "\\")}`;
}

export function shellQuote(arg) {
  const text = String(arg);
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
}

function validateDistro(distro) {
  if (typeof distro !== "string" || !/^[A-Za-z0-9._-]{1,64}$(?![\s\S])/.test(distro)) {
    throw new Error("Invalid WSL distro name");
  }
}

export function wslCommand({ distro, args, cwd = null }) {
  validateDistro(distro);
  return {
    command: "wsl.exe",
    args: ["-d", distro, ...(cwd ? ["--cd", cwd] : []), "--", "bash", "-lc", `exec nomarmy ${args.map(shellQuote).join(" ")}`],
  };
}

function validateWslPath(value, name) {
  if (typeof value !== "string" || !/^\/[A-Za-z0-9_./:@%+ =-]+$(?![\s\S])/.test(value)) {
    throw new Error(`Invalid WSL ${name} path: expected an absolute POSIX path without shell metacharacters or newlines`);
  }
}

export function resolveWslNomarmy({ distro, run }) {
  validateDistro(distro);
  const fix = `nomArmy isn't installed in WSL distro ${distro}: inside it run \`npm install -g nomarmy@alpha\` (Node 24.16+), then run nomarmy connect again`;
  let output;
  try {
    output = run("wsl.exe", ["-d", distro, "--", "bash", "-lic", 'command -v node; readlink -f "$(command -v nomarmy)"'],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch { throw new Error(fix); }
  const paths = String(output ?? "").replace(/\r/g, "").split("\n").filter((line) => line.startsWith("/"));
  if (paths.length !== 2) throw new Error(fix);
  const [node, script] = paths;
  validateWslPath(node, "node");
  validateWslPath(script, "script");
  return { node, script };
}

export function pickDistro({ run, env = process.env, fs = fsDefault }) {
  const distros = listDistros({ run });
  if (distros === null) throw new Error("install WSL: run `wsl --install` in an administrator PowerShell, restart, then run nomarmy setup");
  if (!distros.length) throw new Error("install a Linux distro: `wsl --install -d Ubuntu`");
  const saved = readWindowsSettings({ env, fs }).distro;
  const selected = distros.find((d) => d.name === saved)
    || distros.find((d) => d.isDefault && d.version === 2)
    || (distros.length === 1 ? distros[0] : null);
  if (!selected) throw new Error("choose a default WSL 2 distro: run `wsl --set-default <distro>`, then run nomarmy connect again");
  validateDistro(selected.name);
  return selected.name;
}

export function mcpBridgeLaunch({ distro, node, script }) {
  validateDistro(distro);
  const direct = node !== undefined || script !== undefined;
  if (direct) {
    validateWslPath(node, "node");
    validateWslPath(script, "script");
  }
  return {
    command: "wsl.exe",
    args: direct ? ["-d", distro, "--", node, script, "mcp"] : ["-d", distro, "--", "bash", "-lc", "exec nomarmy mcp"],
    env: { WSLENV: "CLAUDE_PROJECT_DIR/p:NOMARMY_PROJECT_DIR/p" },
  };
}

// Select path semantics from the supplied home, not the CI host platform.
function settingsPaths(env) {
  const home = env.USERPROFILE || env.HOME;
  if (!home) throw new Error("USERPROFILE or HOME is required");
  const paths = /^[A-Za-z]:[\\/]|^[\\/]{2}/.test(home) ? path.win32 : path.posix;
  return { paths, file: paths.join(home, ".config", "nomarmy", "windows.json") };
}

export function windowsSettingsPath({ env = process.env } = {}) {
  return settingsPaths(env).file;
}

export function readWindowsSettings({ env = process.env, fs = fsDefault } = {}) {
  try {
    const settings = JSON.parse(fs.readFileSync(windowsSettingsPath({ env }), "utf8"));
    return { distro: typeof settings?.distro === "string" ? settings.distro : null };
  } catch { return { distro: null }; }
}

export function writeWindowsSettings(settings, { env = process.env, fs = fsDefault } = {}) {
  const { paths, file } = settingsPaths(env);
  fs.mkdirSync(paths.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}
