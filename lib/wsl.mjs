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
  if (typeof distro !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(distro)) {
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

export function mcpBridgeLaunch({ distro }) {
  validateDistro(distro);
  return {
    command: "wsl.exe",
    args: ["-d", distro, "--", "bash", "-lc", "exec nomarmy mcp"],
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
