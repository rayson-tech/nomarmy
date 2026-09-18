// lib/doctor.mjs
// Pure logic for the `nomarmy doctor` command.
// Side effects (probing PATH, spawning podman, hitting the worker endpoint)
// are isolated in `collectFacts()`. Everything that decides pass/fail is a
// plain function over a facts object, so the decisions are testable without
// touching the filesystem, a subprocess or the network.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

const MIN_NODE_MAJOR = 18;
const DEFAULT_LLAMA_HOST = "127.0.0.1";
const DEFAULT_LLAMA_PORT = "8080";
const BEDROCK_REGION_RE = /^[a-z]{2}(-gov)?-[a-z]+-[0-9]$/;

/**
 * Parse a Node.js version string (e.g. "v18.12.1") into an object.
 * @param {string} version
 * @returns {{major: number, minor: number, patch: number} | null}
 */
export function parseNodeVersion(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version || "");
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
  };
}

/**
 * Check that the Node.js version satisfies the minimum requirement.
 * @param {string} versionString
 * @returns {{ok: boolean, message: string, fix?: string}}
 */
export function checkNodeVersion(versionString) {
  const parsed = parseNodeVersion(versionString);
  if (!parsed) {
    return {
      ok: false,
      message: `Could not parse Node.js version '${versionString}'.`,
      fix: `Install a supported Node.js version (>= v${MIN_NODE_MAJOR}.0.0).`,
    };
  }
  if (parsed.major < MIN_NODE_MAJOR) {
    return {
      ok: false,
      message: `Node.js v${parsed.major}.${parsed.minor}.${parsed.patch} is too old.`,
      fix: `Upgrade Node.js to v${MIN_NODE_MAJOR}.0.0 or newer.`,
    };
  }
  return { ok: true, message: `Node.js v${parsed.major}.${parsed.minor}.${parsed.patch} is OK.` };
}

/**
 * Locate an executable on PATH. Mirrors resolveExecutable() in mcp/server.mjs:
 * on Windows an executable may carry .exe, .cmd, .bat (or whatever PATHEXT
 * says) or no extension at all, so a shim installed by e.g. npm is missed if
 * only .exe is tried. POSIX executables carry no extension.
 * @param {string} name
 * @param {{pathEnv?: string, pathExt?: string, platform?: string, existsFile?: (candidate: string) => boolean}} [opts]
 * @returns {string | null} absolute path if found, else null
 */
export function findExecutable(name, opts = {}) {
  const platform = opts.platform ?? os.platform();
  const isWin = platform === "win32";
  // `path.join`/`path.delimiter` reflect the OS this process is actually
  // running on, not the `platform` being simulated -- joining a Windows path
  // with POSIX path.join on a Mac does not produce a Windows path (backslash
  // is not a separator to it), and splitting a `C:\a;C:\b` PATH on POSIX's
  // `:` delimiter shreds it at the drive-letter colons. That silently broke
  // every test here that simulated platform: "win32" on a non-Windows host,
  // real Windows was never affected, since there `os.platform()` already
  // matches and the ambient path module was already the right one. Use the
  // platform-specific module explicitly so simulation and reality agree.
  const platformPath = isWin ? path.win32 : path.posix;
  // process.env is case-insensitive for names on Windows (Node normalizes
  // this itself), so plain PATH/PATHEXT reads work on every platform without
  // the '||' vs '?:' precedence trap the original code fell into.
  const dirs = (opts.pathEnv ?? process.env.PATH ?? "").split(platformPath.delimiter).filter(Boolean);
  const exts = isWin
    ? (opts.pathExt ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [];
  const existsFile = opts.existsFile ?? defaultExistsFile;
  for (const dir of dirs) {
    for (const ext of [...exts, ""]) {
      const candidate = platformPath.join(dir, name + ext.toLowerCase());
      if (existsFile(candidate)) return candidate;
    }
  }
  return null;
}

function defaultExistsFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Check that the git executable is available.
 * @param {{gitFound: boolean}} facts
 * @returns {{ok: boolean, message: string, fix?: string}}
 */
export function checkGit(facts) {
  if (facts.gitFound) return { ok: true, message: "git is available." };
  return {
    ok: false,
    message: "git executable not found.",
    fix: "Install Git and ensure 'git' is on your PATH.",
  };
}

/**
 * Windows only: nomArmy creates a worktree per job under the state directory,
 * so every repository path gets longer by that prefix. Without
 * core.longpaths, Git refuses to create anything past 260 characters and the
 * job fails at `git worktree add` with "Filename too long" (observed on a
 * repository whose deepest path was a GitHub workflow fixture).
 * @param {{platform: string, gitFound: boolean, gitLongPaths: boolean|null}} facts
 * @returns {{ok: boolean, message: string, fix?: string}}
 */
export function checkGitLongPaths(facts) {
  if (facts.platform !== "win32") return { ok: true, message: "Git long paths: not needed on this platform." };
  if (!facts.gitFound) return { ok: true, message: "Git long paths: skipped, git not found." };
  if (facts.gitLongPaths === true) return { ok: true, message: "Git core.longpaths is enabled." };
  return {
    ok: false,
    message: "Git core.longpaths is not enabled; worktrees under the job directory can exceed Windows' 260-character path limit.",
    fix: "git config --global core.longpaths true",
  };
}

/**
 * Check that the podman executable is available. This is distinct from
 * Podman actually being usable: the CLI can be installed while the macOS VM
 * (`podman machine`) is uninitialized or stopped, or a Linux install is
 * otherwise broken.
 * @param {{podmanFound: boolean}} facts
 * @returns {{ok: boolean, message: string, fix?: string}}
 */
export function checkPodmanPresent(facts) {
  if (facts.podmanFound) return { ok: true, message: "podman is available." };
  return {
    ok: false,
    message: "podman executable not found.",
    fix: "Install Podman ('brew install podman' on macOS, or your distro's package manager on Linux) and ensure 'podman' is on your PATH.",
  };
}

/**
 * Check that podman actually answers, not just that the CLI exists. Podman in
 * its default rootless mode has no persistent background daemon the way
 * Docker does: on Linux this just works once the package is installed, and on
 * macOS it depends on the `podman machine` VM being initialized and started.
 * @param {{podmanFound: boolean, podmanDaemonReachable: boolean, podmanDaemonError?: string|null}} facts
 * @returns {{ok: boolean, message: string, fix?: string}}
 */
export function checkPodmanDaemon(facts) {
  if (!facts.podmanFound) {
    return {
      ok: false,
      message: "Podman check skipped: podman executable not found.",
      fix: "Install Podman ('brew install podman' on macOS, or your distro's package manager on Linux), then re-run 'nomarmy doctor'.",
    };
  }
  if (facts.podmanDaemonReachable) {
    return { ok: true, message: "Podman is available." };
  }
  return {
    ok: false,
    message: `Podman is not usable${facts.podmanDaemonError ? `: ${facts.podmanDaemonError}` : "."}`,
    fix: "Run 'podman machine init' (if you have not already) and 'podman machine start' if you're on macOS, or check your Podman installation on Linux, then re-run 'nomarmy doctor'.",
  };
}

/**
 * Check the worker model endpoint appropriate to NOMARMY_EXECUTION. A local
 * profile runs llama-server and exposes /health; a bedrock profile has no
 * endpoint to ping, so this validates the region and that credentials are
 * discoverable instead.
 * @param {{execution: string, endpoint: object}} facts
 * @returns {{ok: boolean, message: string, fix?: string}}
 */
export function checkEndpoint(facts) {
  const { execution, endpoint } = facts;
  if (execution === "bedrock") return checkBedrockEndpoint(endpoint);
  if (execution === "local") return checkLocalEndpoint(endpoint);
  return {
    ok: false,
    message: `NOMARMY_EXECUTION '${execution}' is not recognised.`,
    fix: "Set NOMARMY_EXECUTION to 'local' or 'bedrock' (see config/common.env).",
  };
}

function checkLocalEndpoint(endpoint) {
  const { url, healthy, error } = endpoint;
  if (healthy) return { ok: true, message: `llama-server is healthy at ${url}.` };
  return {
    ok: false,
    message: `llama-server health check failed at ${url}${error ? `: ${error}` : "."}`,
    fix: "Start the local worker with './scripts/start-inference.sh' (after 'source scripts/lib.sh && load_profile <profile>'), then re-run 'nomarmy doctor'.",
  };
}

function checkBedrockEndpoint(endpoint) {
  const { region, baseUrl, regionValid, credentialsPresent } = endpoint;
  if (!region) {
    return {
      ok: false,
      message: "NOMARMY_BEDROCK_REGION is not set.",
      fix: "Set NOMARMY_BEDROCK_REGION, e.g. export NOMARMY_BEDROCK_REGION=eu-west-2 (see config/profiles/bedrock.env).",
    };
  }
  if (!regionValid) {
    return {
      ok: false,
      message: `NOMARMY_BEDROCK_REGION '${region}' is not a valid AWS region name.`,
      fix: "Use a region name like eu-west-2 or us-east-1.",
    };
  }
  if (!credentialsPresent) {
    return {
      ok: false,
      message: "No AWS credentials were found for the Bedrock worker endpoint.",
      fix: "Run 'aws configure', or set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/AWS_PROFILE.",
    };
  }
  return { ok: true, message: `Bedrock worker endpoint configured for region '${region}' (${baseUrl}).` };
}

// --- fact collection: every side effect the checks above need lives here ---

/**
 * Probe whether podman actually answers, not just whether the CLI exists.
 * The output of `podman info` is not parsed here, only the exit code matters,
 * so no --format field (Podman's info JSON shape differs from Docker's) is
 * needed.
 * @param {string} podmanPath
 * @returns {Promise<{reachable: boolean, error: string|null}>}
 */
function probePodmanDaemon(podmanPath) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const args = ["info"];
    // Windows cannot execute a .cmd/.bat shim directly (EINVAL) - it needs
    // cmd.exe. shell:true alone re-joins command+args with plain spaces, which
    // breaks on a path like "C:\Program Files\RedHat\Podman\podman.exe";
    // quoting each token into one command string avoids that split.
    const needsShell = os.platform() === "win32" && /\.(cmd|bat)$/i.test(podmanPath);
    let child;
    try {
      child = needsShell
        ? spawn([podmanPath, ...args].map((t) => `"${t}"`).join(" "), [], {
            stdio: ["ignore", "pipe", "pipe"],
            shell: true,
          })
        : spawn(podmanPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      finish({ reachable: false, error: err.message });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      finish({ reachable: false, error: "timed out waiting for podman" });
    }, 3000);
    let stderr = "";
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => { clearTimeout(timer); finish({ reachable: false, error: err.message }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) finish({ reachable: true, error: null });
      else finish({ reachable: false, error: stderr.trim().split("\n")[0] || `podman info exited ${code}` });
    });
  });
}

/**
 * Probe the local llama-server /health endpoint.
 * @param {string} host
 * @param {string|number} port
 * @returns {Promise<{mode: "local", url: string, healthy: boolean, error: string|null}>}
 */
async function probeLocalEndpoint(host, port) {
  const url = `http://${host}:${port}/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return { mode: "local", url, healthy: res.ok, error: res.ok ? null : `HTTP ${res.status}` };
  } catch (err) {
    return { mode: "local", url, healthy: false, error: err.name === "AbortError" ? "timed out" : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Gather the (non-network-secret) facts a bedrock profile needs: is a region
 * configured and syntactically valid, and are credentials discoverable at
 * all. This deliberately does not call AWS - that belongs to
 * scripts/verify-install.sh, which actually invokes the API.
 * @param {NodeJS.ProcessEnv} env
 * @returns {{mode: "bedrock", region: string|null, baseUrl: string|null, regionValid: boolean, credentialsPresent: boolean}}
 */
function collectBedrockFacts(env) {
  const region = env.NOMARMY_BEDROCK_REGION || null;
  const regionValid = Boolean(region && BEDROCK_REGION_RE.test(region));
  const baseUrl = env.NOMARMY_BEDROCK_BASE_URL || (region ? `https://bedrock-runtime.${region}.amazonaws.com/openai/v1` : null);
  const credentialsPresent = Boolean(
    (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY)
    || env.AWS_PROFILE
    || (() => { try { return fs.statSync(path.join(os.homedir(), ".aws", "credentials")).isFile(); } catch { return false; } })(),
  );
  return { mode: "bedrock", region, baseUrl, regionValid, credentialsPresent };
}

/**
 * Collect every fact the checks need. Side effects only - no decisions here.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<object>}
 */
/**
 * Read `git config --get core.longpaths`. Only consulted on Windows.
 * @param {string} gitPath
 * @returns {Promise<boolean|null>} true/false, or null if git did not answer
 */
async function probeGitLongPaths(gitPath) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(gitPath, ["config", "--get", "core.longpaths"], { stdio: ["ignore", "pipe", "ignore"] });
    } catch { return resolve(null); }
    const timer = setTimeout(() => { child.kill(); resolve(null); }, 3000);
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.on("error", () => { clearTimeout(timer); resolve(null); });
    child.on("close", (code) => {
      clearTimeout(timer);
      // exit 1 with no output means "unset", which is a definite false.
      if (code === 1 && !out.trim()) return resolve(false);
      if (code !== 0) return resolve(null);
      resolve(/^(true|1|yes|on)$/i.test(out.trim()));
    });
  });
}

export async function collectFacts(env = process.env) {
  const platform = os.platform();
  const gitPath = findExecutable("git", { platform });
  const gitLongPaths = platform === "win32" && gitPath ? await probeGitLongPaths(gitPath) : null;
  const podmanPath = findExecutable("podman", { platform });
  const podmanDaemon = podmanPath
    ? await probePodmanDaemon(podmanPath)
    : { reachable: false, error: "podman not found" };
  const execution = (env.NOMARMY_EXECUTION || "local").trim();
  const endpoint = execution === "bedrock"
    ? collectBedrockFacts(env)
    : await probeLocalEndpoint(env.NOMARMY_LLAMA_HOST || DEFAULT_LLAMA_HOST, env.NOMARMY_LLAMA_PORT || DEFAULT_LLAMA_PORT);
  return {
    nodeVersion: process.version,
    platform,
    gitFound: Boolean(gitPath),
    gitLongPaths,
    podmanFound: Boolean(podmanPath),
    podmanDaemonReachable: podmanDaemon.reachable,
    podmanDaemonError: podmanDaemon.error,
    execution,
    endpoint,
  };
}

/**
 * Run every check against a facts object and report ok/fail plus an id.
 * @param {object} facts
 * @returns {Array<{id: string, ok: boolean, message: string, fix?: string}>}
 */
export function evaluateChecks(facts) {
  return [
    { id: "node", ...checkNodeVersion(facts.nodeVersion) },
    { id: "git", ...checkGit(facts) },
    { id: "git-longpaths", ...checkGitLongPaths(facts) },
    { id: "podman", ...checkPodmanPresent(facts) },
    { id: "podman-daemon", ...checkPodmanDaemon(facts) },
    { id: "endpoint", ...checkEndpoint(facts) },
  ];
}

/**
 * Run the doctor checks and print a report.
 * @param {{json?: boolean, exit?: boolean, facts?: object, env?: NodeJS.ProcessEnv}} opts
 * @returns {Promise<{ok: boolean, checks: Array<object>}>}
 */
export async function runDoctor(opts = {}) {
  const { json = false, exit = false, env = process.env } = opts;
  const facts = opts.facts ?? await collectFacts(env);
  const checks = evaluateChecks(facts);
  const allOk = checks.every((c) => c.ok);
  const result = { ok: allOk, checks };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("nomArmy doctor report\n");
    for (const c of checks) {
      console.log(`  ${c.ok ? "✓" : "✗"} ${c.message}`);
      if (!c.ok && c.fix) console.log(`    Fix: ${c.fix}`);
    }
    console.log(allOk ? "\nAll checks passed." : "\nSome checks failed.");
  }

  if (exit) process.exit(allOk ? 0 : 1);
  return result;
}
