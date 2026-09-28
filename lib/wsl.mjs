// Windows is a thin front end: run the engine inside WSL while keeping path,
// launch and settings handling injectable for tests on any operating system.
import fsDefault from "node:fs";
import path from "node:path";

// NOMARMY_WINDOWS_ENGINE=native runs every command in this Windows process
// instead of WSL. The test suite and CI use it to exercise the commands
// themselves; jobs still need the engine in WSL.
export function isNativeWindows({ platform = process.platform, env = process.env } = {}) {
  return platform === "win32" && !env.WSL_DISTRO_NAME && !env.WSL_INTEROP && env.NOMARMY_WINDOWS_ENGINE !== "native";
}

// One switch for all Windows front-end decisions, including local commands.
export function windowsFrontEnd({ platform = process.platform, env = process.env } = {}) {
  // One escape hatch, NOMARMY_WINDOWS_ENGINE=native, which isNativeWindows honors.
  return isNativeWindows({ platform, env });
}

// Decorate response objects only; keep Linux job records and paths intact.
export function withWindowsPaths(obj, env = process.env) {
  if (env.NOMARMY_COORDINATOR_OS !== "windows" || !env.WSL_DISTRO_NAME) return obj;
  if (Array.isArray(obj)) return obj.map(value => withWindowsPaths(value, env));
  if (!obj || typeof obj !== "object") return obj;
  const result = Object.fromEntries(Object.entries(obj).map(([key, value]) => [key, withWindowsPaths(value, env)]));
  for (const key of ["jobDir", "worktree"]) {
    if (typeof obj[key] !== "string") continue;
    const windows = wslToWindowsPath(obj[key], { distro: env.WSL_DISTRO_NAME });
    if (windows !== null) result[`${key}Windows`] = windows;
  }
  return result;
}

// WSL appends the Windows PATH (/mnt/c/...), so inside the distro `openclaw`
// or `nomarmy` can resolve to the Windows npm install: install.sh then skipped
// installing OpenClaw, and every call read its code across the Windows/VM
// boundary (about a minute each). The engine uses only the distro's tools,
// plus the Windows directory itself: powershell.exe (lib/notify.mjs's toasts)
// lives there, and never node or openclaw.
const WINDOWS_MOUNT_RE = /^\/mnt\/[A-Za-z](?:\/|$)/;
const WINDOWS_SYSTEM_RE = /^\/mnt\/[A-Za-z]\/windows(?:\/|$)/i;

export function isWindowsMountPath(p) {
  return WINDOWS_MOUNT_RE.test(String(p));
}

export function dropWindowsPath(env = process.env, { platform = process.platform } = {}) {
  if (platform !== "linux" || !(env.WSL_DISTRO_NAME || env.WSL_INTEROP) || !env.PATH) return;
  env.PATH = env.PATH.split(":").filter((dir) => dir && (!isWindowsMountPath(dir) || WINDOWS_SYSTEM_RE.test(dir))).join(":");
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

// Docker Desktop, Rancher Desktop and Podman machine register their own WSL
// distros. They have no bash or user Node and Docker's is often the default,
// so they are never a place to run the engine.
const UTILITY_DISTRO_RE = /^(?:docker-desktop(?:-data)?|rancher-desktop(?:-data)?|podman-machine-.+)$/i;

export function isUtilityDistro(name) {
  return UTILITY_DISTRO_RE.test(name);
}

// run has the execFileSync contract: return stdout or throw on failure.
export function listDistros({ run }) {
  let distros;
  try { distros = parseWslList(run("wsl.exe", ["-l", "-v"])); } catch { return null; }
  return distros.filter((d) => !isUtilityDistro(d.name));
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
  if (typeof distro !== "string" || distro.startsWith("-") || distro === "." || distro === ".." || !/^[A-Za-z0-9._-]{1,64}$(?![\s\S])/.test(distro)) {
    throw new Error("Invalid WSL distro name");
  }
}

// Always --exec: after `--`, wsl.exe hands the joined arguments to the distro's
// shell, which expands $(...) and splits "a b" before the command sees them.
export function wslCommand({ distro, args, cwd = null, node = null, script = null }) {
  validateDistro(distro);
  if (cwd !== null && (typeof cwd !== "string" || !cwd.startsWith("/") || /[\r\n\0]/.test(cwd))) {
    throw new Error("Invalid WSL cwd: expected an absolute POSIX path without newlines or NUL");
  }
  const direct = node !== null && script !== null;
  if (direct) {
    validateWslPath(node, "node");
    validateWslPath(script, "script");
  }
  return {
    command: "wsl.exe",
    args: ["-d", distro, ...(cwd ? ["--cd", cwd] : []), "--exec", ...(direct ? [node, script, ...args] : ["bash", "-lic", `exec nomarmy ${args.map(shellQuote).join(" ")}`])],
  };
}

function validateWslPath(value, name) {
  if (typeof value !== "string" || !/^\/[A-Za-z0-9_./:@+ =-]+$(?![\s\S])/.test(value)) {
    throw new Error(`Invalid WSL ${name} path: expected an absolute POSIX path using only ASCII letters, digits, /, _, ., :, @, +, space, =, and -`);
  }
}

export function resolveWslNomarmy({ distro, run }) {
  validateDistro(distro);
  const fix = `nomArmy isn't installed in WSL distro ${distro}: inside it run \`npm install -g nomarmy@alpha\` (Node 24.16+), then run nomarmy connect again`;
  let output;
  try {
    output = run("wsl.exe", ["-d", distro, "--exec", "bash", "-lic", 'printf "NOMARMY_NODE=%s\\n" "$(command -v node)"; printf "NOMARMY_SCRIPT=%s\\n" "$(readlink -f "$(command -v nomarmy)")"'],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch { throw new Error(fix); }
  const paths = {};
  let marked = false;
  const lines = String(output ?? "").replace(/\r/g, "").split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    const match = /^(NOMARMY_NODE|NOMARMY_SCRIPT)=(.*)$/.exec(line);
    if (!match) {
      // Login banners may precede the probe, but continuation lines must not
      // silently truncate a path containing an embedded newline.
      if (marked) throw new Error(fix);
      continue;
    }
    marked = true;
    if (!match[2] || Object.hasOwn(paths, match[1])) throw new Error(fix);
    paths[match[1]] = match[2];
  }
  const { NOMARMY_NODE: node, NOMARMY_SCRIPT: script } = paths;
  if (!node || !script) throw new Error(fix);
  // Found through WSL's appended Windows PATH: that's the Windows install.
  if (isWindowsMountPath(node) || isWindowsMountPath(script)) throw new Error(fix);
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
    args: direct ? ["-d", distro, "--exec", node, script, "mcp"] : ["-d", distro, "--exec", "bash", "-lc", "exec nomarmy mcp"],
    env: { WSLENV: "CLAUDE_PROJECT_DIR/pu:NOMARMY_PROJECT_DIR/pu" },
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
    const validPath = (name) => {
      try { validateWslPath(settings?.[name], name); return settings[name]; }
      catch { return null; }
    };
    return { distro: typeof settings?.distro === "string" ? settings.distro : null, node: validPath("node"), script: validPath("script") };
  } catch { return { distro: null, node: null, script: null }; }
}

export function writeWindowsSettings(settings, { env = process.env, fs = fsDefault } = {}) {
  const { paths, file } = settingsPaths(env);
  fs.mkdirSync(paths.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}
