// nomArmy independent verification runner (v1.3).
//
// The coordinator's verdict must not depend on the worker's claim, so this
// module re-runs the repository's own verification profile and reports what it
// observed. `mcp/server.mjs` consumes the verdict through
// `registerVerificationRunner`.
//
// THE SECURITY RULE THIS FILE EXISTS TO HOLD
// -----------------------------------------
// Verification commands come from `.nomarmy.yml` inside the repository being
// worked on, and repository content is untrusted input in this system's threat
// model. Running those commands on the host would hand coordinator privileges
// to repo-controlled code, the exact privilege the worker itself is denied.
//
// Therefore commands only ever execute inside the Podman sandbox image, as a
// non-root user, with `--network none` or a verification-only internal service network. If Podman is missing, the image is
// absent, or the container fails to start, the verdict is `not_run`. There is
// no host fallback path in this file, deliberately: a missing sandbox is
// absence of evidence, not permission to take a shortcut.
//
// Nothing from configuration ever reaches a host-side shell. Every host process
// is spawned with an argv array and `shell: false`. A command string is handed
// to `/bin/sh -c` *inside* the container, which is inside the sandbox boundary.

import { randomUUID, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { collectVerificationArtifacts } from "./verification-artifacts.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadVerificationNetwork, redactCredentials } from "./verification-network.mjs";

import { loadConfig as defaultLoadConfig } from "./config.mjs";
import { resolveSandboxImage, sandboxHarnesses, nodeDependencyFiles, linkNodePackages, SANDBOX_NPM_ENV } from "./sandbox-images.mjs";

/** Sandbox image used when `NOMARMY_AGENT_IMAGE` is unset. */
export const DEFAULT_AGENT_IMAGE = "openclaw-nomarmy-coder:bookworm";

/** Matches the base image's non-root `node` user (uid 1000) baked into `docker/Dockerfile`. */
export const DEFAULT_CONTAINER_USER = "1000:1000";

/** Mount point for the job worktree inside the container. */
export const DEFAULT_WORKDIR = "/workspace";

/** Only this environment level is executable without provisioned services. */
export const EXECUTABLE_ENVIRONMENT = "none";

export const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_OVERALL_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

/** Marker written into captured output when a cap drops bytes. */
export const TRUNCATION_MARKER = "[nomarmy] output truncated";

/** Length of the stderr excerpt attached to a failure detail. */
const DETAIL_TAIL_CHARS = 400;

// ---------------------------------------------------------------------------
// pure: profile resolution
// ---------------------------------------------------------------------------

/**
 * Pick the verification profile to execute. Performs no I/O.
 *
 * Absence is never an error here. Most repositories have no `.nomarmy.yml`
 * yet, and "there is nothing to run" is a legitimate, reportable state.
 *
 * @param {{ config?: object|null, profile?: string|null }} input
 * @returns {{ found: boolean, name: string|null, commands: string[], environment: string|null, reason: string|null }}
 */
export function resolveProfile({ config = null, profile = null } = {}) {
  const name = typeof profile === "string" && profile.trim() ? profile.trim() : null;
  const miss = (reason) => ({ found: false, name, commands: [], environment: null, reason });

  if (!name) {
    return miss("no verification profile was requested for this job");
  }
  if (!config || typeof config !== "object") {
    return miss(
      `no .nomarmy.yml in the repository, so verification profile '${name}' is not defined`,
    );
  }

  const block = config.verification;
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    return miss(
      `.nomarmy.yml has no 'verification' block, so profile '${name}' is not defined`,
    );
  }

  const available = Object.keys(block);
  const entry = Object.prototype.hasOwnProperty.call(block, name) ? block[name] : null;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    const known = available.length
      ? `known profiles: ${available.join(", ")}`
      : "the 'verification' block is empty";
    return miss(`.nomarmy.yml defines no verification profile '${name}'; ${known}`);
  }

  const environment =
    typeof entry.environment === "string" && entry.environment.trim()
      ? entry.environment.trim()
      : EXECUTABLE_ENVIRONMENT;

  const commands = Array.isArray(entry.commands)
    ? entry.commands.filter((c) => typeof c === "string" && c.trim().length > 0)
    : [];

  return { found: true, name, commands, environment, reason: null };
}

// ---------------------------------------------------------------------------
// pure: result classification
// ---------------------------------------------------------------------------

function tailOf(result) {
  const raw = typeof result?.stderr === "string" && result.stderr.trim()
    ? result.stderr
    : typeof result?.stdout === "string"
      ? result.stdout
      : "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const tail = trimmed.length > DETAIL_TAIL_CHARS
    ? trimmed.slice(trimmed.length - DETAIL_TAIL_CHARS)
    : trimmed;
  return ` (last output: ${tail.replace(/\s+/g, " ")})`;
}

/**
 * Turn per-command results into a verdict. Performs no I/O.
 *
 * A command that ran and failed (or timed out) is evidence of failure. A
 * command that never started is absence of evidence, so if nothing ever ran the
 * verdict is `not_run`, never `fail`.
 *
 * @param {Array<object>} results
 * @returns {{ status: "pass"|"fail"|"not_run", detail: string }}
 */
export function classifyResults(results) {
  const list = Array.isArray(results) ? results.filter(Boolean) : [];
  if (list.length === 0) {
    return { status: "not_run", detail: "no commands were executed" };
  }

  if (list.every((r) => r.started === false)) {
    const first = list[0];
    const why = first.reason || first.error || "the sandbox never started a command";
    return { status: "not_run", detail: `no command was executed: ${why}` };
  }

  const total = list.length;
  for (let index = 0; index < total; index += 1) {
    const result = list[index];
    const label = `command ${index + 1} of ${total} (\`${result.command ?? "?"}\`)`;

    if (result.timedOut) {
      const budget = result.timeoutMs ?? result.durationMs;
      const after = Number.isFinite(budget) ? ` after ${budget}ms` : "";
      return { status: "fail", detail: `${label} timed out${after}${tailOf(result)}` };
    }
    if (result.started === false) {
      const why = result.reason || result.error || "unknown sandbox failure";
      return { status: "fail", detail: `${label} never started: ${why}` };
    }
    const code = Number.isInteger(result.exitCode) ? result.exitCode : null;
    if (code === null) {
      return { status: "fail", detail: `${label} produced no exit code${tailOf(result)}` };
    }
    if (code !== 0) {
      return {
        status: "fail",
        detail: `${label} failed with exit code ${code}${tailOf(result)}`,
      };
    }
  }

  return { status: "pass", detail: `${total} of ${total} commands passed` };
}

// ---------------------------------------------------------------------------
// pure: output capping
// ---------------------------------------------------------------------------

/**
 * Cap captured output at `limit` bytes and say how much was dropped. A runaway
 * test suite must not be able to exhaust the coordinator's memory or context.
 *
 * @param {unknown} value
 * @param {number} limit
 * @returns {{ text: string, dropped: number, truncated: boolean }}
 */
export function capOutput(value, limit = DEFAULT_MAX_OUTPUT_BYTES) {
  const text = value === null || value === undefined ? "" : String(value);
  const max = Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : DEFAULT_MAX_OUTPUT_BYTES;
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= max) {
    return { text, dropped: 0, truncated: false };
  }
  const dropped = buffer.length - max;
  const kept = buffer.subarray(0, max).toString("utf8");
  return {
    text: `${kept}\n${TRUNCATION_MARKER}: ${dropped} of ${buffer.length} bytes dropped`,
    dropped,
    truncated: true,
  };
}

// ---------------------------------------------------------------------------
// pure: podman invocation
// ---------------------------------------------------------------------------

/**
 * Build the argv for one containerised command. Exported so the invocation is
 * assertable in tests without Podman.
 *
 * The repository-controlled `command` is the FINAL argv element, handed to
 * `/bin/sh -c` inside the container. It is never concatenated into a host
 * string and the host process is always spawned with `shell: false`.
 *
 * @param {{ image?: string, cwd: string, command: string, jobId?: string|null,
 *           network?: string, user?: string, workdir?: string,
 *           nodeModulesSource?: string|null }} input
 * @returns {string[]} argv for `podman`
 */
export function buildPodmanArgs({
  image = DEFAULT_AGENT_IMAGE,
  cwd,
  command,
  jobId = null,
  network = "none",
  user = DEFAULT_CONTAINER_USER,
  workdir = DEFAULT_WORKDIR,
  nodeModulesSource = null,
  env = {},
  secretEnv = [],
  shmMb = null,
} = {}) {
  const args = [
    "run",
    "--rm",
    `--network=${network}`,
    `--user=${user}`,
    `--workdir=${workdir}`,
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=512",
    "--env",
    "HOME=/tmp",
    "--env",
    "NOMARMY_VERIFICATION=1",
    ...Object.entries(SANDBOX_NPM_ENV).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
    "--mount",
    `type=bind,source=${cwd},target=${workdir}`,
  ];
  // Extra env vars a caller wants inside the sandbox -- e.g. the diff's own
  // changed-file lists (see createVerificationRunner's NOMARMY_CHANGED_*).
  // Passed as real podman --env args, never spliced into `command` itself:
  // this process is spawned with shell:false, so a value can never break out
  // of its own argv slot on the HOST side the way string-templating the
  // command itself would risk. A verification command that then references
  // the var unquoted inside its OWN `/bin/sh -c` still word-splits on spaces
  // as usual -- that is the operator's shell, not this one, and is worth
  // knowing when a repo's paths might contain spaces.
  for (const [name, value] of Object.entries(env)) args.push("--env", secretEnv.includes(name) ? name : `${name}=${value}`);
  // `git worktree add` never copies node_modules, and this container has
  // --network none, so a Node repo's own verification commands can never
  // install what they need. The coordinator's own already-installed tree is
  // trusted (it was npm-installed on the host by a human, not produced by
  // repo-controlled code), so it is safe to hand the sandbox READ ONLY --
  // resolveNodeModulesMount (below) only supplies this when the worktree's
  // package-lock.json matches the coordinator's, so a job that legitimately
  // changed dependencies never gets silently tested against a stale tree.
  if (nodeModulesSource) {
    args.push("--mount", `type=bind,source=${nodeModulesSource},target=${workdir}/node_modules,readonly`);
  }
  if (shmMb > 0) args.push(`--shm-size=${shmMb}m`);
  if (jobId) args.push("--label", `nomarmy.job=${jobId}`);
  args.push("--entrypoint", "/bin/sh", image, "-c", command);
  return args;
}

// ---------------------------------------------------------------------------
// the real Podman executor (the only place a host process is spawned)
// ---------------------------------------------------------------------------

function spawnCollect(file, args, { timeoutMs, maxOutputBytes, cwd, env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      // shell:false is the whole point: nothing here is ever parsed by a host
      // shell, so a config value cannot break out of its argv slot.
      child = spawn(file, args, { cwd, env, shell: false, windowsHide: true });
    } catch (error) {
      resolve({ spawned: false, code: null, stdout: "", stderr: String(error?.message || error), timedOut: false });
      return;
    }

    const cap = Number.isFinite(maxOutputBytes) ? maxOutputBytes : DEFAULT_MAX_OUTPUT_BYTES;
    const out = [];
    const err = [];
    let outBytes = 0;
    let errBytes = 0;
    let settled = false;
    let timedOut = false;

    const collect = (chunks, chunk, bytes) => {
      const room = cap - bytes;
      if (room > 0) chunks.push(chunk.subarray(0, room));
      return bytes + chunk.length;
    };

    child.stdout?.on("data", (chunk) => { outBytes = collect(out, chunk, outBytes); });
    child.stderr?.on("data", (chunk) => { errBytes = collect(err, chunk, errBytes); });

    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
        }, timeoutMs)
      : null;

    const finish = (code, spawnError) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        spawned: !spawnError,
        code: typeof code === "number" ? code : null,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: spawnError
          ? `${Buffer.concat(err).toString("utf8")}${String(spawnError.message || spawnError)}`
          : Buffer.concat(err).toString("utf8"),
        timedOut,
      });
    };

    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code, null));
  });
}

/**
 * Executor backed by the real Podman CLI. Tests inject a fake in its place.
 * @param {{ podman?: string }} [options]
 */
export function createPodmanExecutor({ podman = "podman", collect = spawnCollect, healthTimeoutMs = 30_000, healthIntervalMs = 250 } = {}) {
  return {
    /** Own only resources created by this run; cleanup is also used on setup failure. */
    async startServices({ services, image, jobId, allow = [], token }) {
      const network = `nomarmy-${String(jobId || randomUUID()).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
      const containers = [];
      let created = false;
      let externalCreated = false;
      const external = `${network}-external`;
      const proxyName = `${network}-egress`;
      const call = (args, timeoutMs = 20_000) => collect(podman, args, { timeoutMs, maxOutputBytes: 4096, env: { ...process.env, NOMARMY_EGRESS_TOKEN: token } });
      const ok = (result) => result.spawned && !result.timedOut && result.code === 0;
      const requireSuccess = async (args, label, timeoutMs) => {
        if (!ok(await call(args, timeoutMs))) throw new Error(label);
      };
      const cleanup = async () => {
        const failures = [];
        try { await this.cleanupVerification({ jobId }); }
        catch { failures.push("could not remove verification containers"); }
        for (const name of containers.reverse()) {
          try { await requireSuccess(["rm", "--force", "--ignore", name], `could not remove service container ${name}`); }
          catch (error) { failures.push(error.message); }
        }
        if (externalCreated) {
          try { await requireSuccess(["network", "rm", external], "could not remove egress network"); }
          catch (error) { failures.push(error.message); }
        }
        if (created) {
          try { await requireSuccess(["network", "rm", network], `could not remove service network ${network}`); }
          catch (error) { failures.push(error.message); }
        }
        if (failures.length) throw new Error(failures.join("; "));
      };
      try {
        await requireSuccess(["network", "create", "--internal", network], `could not create internal service network ${network}`);
        created = true;
        if (allow.length) {
          await requireSuccess(["network", "create", external], "could not create egress network");
          externalCreated = true;
          containers.push(proxyName);
          await requireSuccess(["run", "--detach", "--name", proxyName,
            "--network", `${network}:alias=egress`, "--network", external,
            `--user=${DEFAULT_CONTAINER_USER}`, "--cap-drop=ALL", "--security-opt=no-new-privileges",
            "--read-only", "--pids-limit=128", "--memory=128m", "--cpus=1",
            "--mount", `type=bind,source=${fileURLToPath(new URL("./egress-proxy.mjs", import.meta.url))},target=/egress-proxy.mjs,readonly`,
            "--env", "NOMARMY_EGRESS_TOKEN",
            "--env", `NOMARMY_EGRESS_ALLOW=${JSON.stringify(allow)}`,
            "--entrypoint", "node", DEFAULT_AGENT_IMAGE, "/egress-proxy.mjs"], "could not start egress proxy");
          const probeName = `${network}-egress-health`;
          containers.push(probeName);
          const script = `const net=await import('node:net');const end=Date.now()+${healthTimeoutMs};while(Date.now()<end){const ok=await new Promise(r=>{const s=net.connect(3128,'egress');s.setTimeout(1000);s.on('connect',()=>{s.destroy();r(true)});s.on('error',()=>r(false));s.on('timeout',()=>{s.destroy();r(false)});});if(ok)process.exit(0);await new Promise(r=>setTimeout(r,${healthIntervalMs}));}process.exit(1);`;
          await requireSuccess(["run", "--rm", "--name", probeName, "--network", network,
            `--user=${DEFAULT_CONTAINER_USER}`, "--cap-drop=ALL", "--security-opt=no-new-privileges",
            "--entrypoint", "node", DEFAULT_AGENT_IMAGE, "--input-type=module", "-e", script], "egress proxy did not become ready", healthTimeoutMs + 5000);
        }
        for (const service of services) {
          if (!ok(await call(["image", "exists", service.image]))) {
            await requireSuccess(["pull", service.image], `could not pull service image ${service.image}`, 120_000);
          }
          const name = `${network}-service-${service.name}`;
          containers.push(name);
          await requireSuccess(["run", "--detach", "--name", name, "--network", network,
            "--network-alias", service.name, "--cap-drop=ALL", "--security-opt=no-new-privileges",
            "--pids-limit=512", ...Object.entries(service.env ?? {}).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
            service.image], `could not start service ${service.name}`);
        }
        for (const service of services.filter((spec) => spec.health)) {
          const probeName = `${network}-health-${service.name}`;
          containers.push(probeName);
          const url = `http://${service.name}:${service.port}${service.health}`;
          // Poll inside the same internal network, never on the host. The base
          // verification image supplies Node, so services need no curl binary.
          const script = `const deadline=Date.now()+${healthTimeoutMs}; while(Date.now()<deadline){try{const r=await fetch(${JSON.stringify(url)},{redirect:'error',signal:AbortSignal.timeout(Math.min(2000,Math.max(1,deadline-Date.now())))});if(r.status>=200&&r.status<300)process.exit(0);}catch{}await new Promise(r=>setTimeout(r,${healthIntervalMs}));}process.exit(1);`;
          await requireSuccess(["run", "--rm", "--name", probeName, "--network", network,
            `--user=${DEFAULT_CONTAINER_USER}`, "--cap-drop=ALL", "--security-opt=no-new-privileges",
            "--entrypoint", "node", image, "--input-type=module", "-e", script],
            `service ${service.name} did not become healthy within ${healthTimeoutMs}ms (${url})`, healthTimeoutMs + 5000);
        }
        return { network, cleanup, ...(allow.length ? { logs: async () => {
          // Freeze the audit trail before reading it; no late DNS completion or
          // service connection may append a verdict after this snapshot.
          await requireSuccess(["stop", "--time", "2", proxyName], "could not stop egress proxy");
          const logLimit = 4 * 1024 * 1024;
          const result = await collect(podman, ["logs", proxyName], { timeoutMs: 20_000, maxOutputBytes: logLimit });
          // Never accept verification with a silently incomplete audit trail.
          if (!ok(result) || Buffer.byteLength(result.stdout) >= logLimit) throw new Error("could not capture complete egress verdict log");
          // Accept only the proxy's fixed verdict format; never relay diagnostics.
          return result.stdout.split("\n").filter(line => /^[a-z0-9.-]+:[0-9]+ (connected|denied)$/.test(line)).join("\n");
        } } : {}) };
      } catch (error) {
        try { await cleanup(); } catch (cleanupError) { throw new Error(`${error.message}; ${cleanupError.message}`); }
        throw error;
      }
    },

    async cleanupVerification({ jobId }) {
      if (!jobId) return;
      const listed = await collect(podman, ["ps", "-aq", "--filter", `label=nomarmy.job=${jobId}`], { timeoutMs: 20_000, maxOutputBytes: 1024 * 1024 });
      if (!listed.spawned || listed.timedOut || listed.code !== 0 || Buffer.byteLength(listed.stdout) >= 1024 * 1024) throw new Error("could not list verification containers");
      const ids = listed.stdout.trim().split(/\s+/).filter(Boolean);
      if (ids.some(id => !/^[a-f0-9]+$/.test(id))) throw new Error("invalid verification container id");
      if (ids.length) {
        const removed = await collect(podman, ["rm", "--force", ...ids], { timeoutMs: 20_000, maxOutputBytes: 4096 });
        if (!removed.spawned || removed.timedOut || removed.code !== 0) throw new Error("could not remove verification containers");
      }
    },

    /** Is a usable sandbox present? Never throws. */
    async probe({ image }) {
      const version = await collect(podman, ["version", "--format", "{{.Server.Version}}"], {
        timeoutMs: 20_000,
        maxOutputBytes: 4096,
      });
      if (!version.spawned) {
        return { available: false, reason: `podman CLI is not available: ${version.stderr.trim() || "spawn failed"}` };
      }
      if (version.timedOut) {
        return { available: false, reason: "podman did not respond within 20s" };
      }
      if (version.code !== 0) {
        return {
          available: false,
          reason: `podman is not usable: ${version.stderr.trim() || `exit ${version.code}`}`,
        };
      }

      const inspect = await collect(podman, ["image", "inspect", image], {
        timeoutMs: 20_000,
        maxOutputBytes: 4096,
      });
      if (!inspect.spawned || inspect.timedOut || inspect.code !== 0) {
        return {
          available: false,
          reason: `sandbox image '${image}' is not present locally; build it with scripts/setup-sandbox.sh`,
        };
      }
      return { available: true, reason: null };
    },

    /** Run one command inside the sandbox. Never throws. */
    async run({ command, cwd, image, jobId, network, user, workdir, timeoutMs, maxOutputBytes, nodeModulesSource, env, secretEnv, shmMb }) {
      const args = buildPodmanArgs({ image, cwd, command, jobId, network, user, workdir, nodeModulesSource, env, secretEnv, shmMb });
      const started = Date.now();
      const outcome = await collect(podman, args, { timeoutMs, maxOutputBytes, env: { ...process.env, ...Object.fromEntries((secretEnv ?? []).filter(name => Object.hasOwn(env ?? {}, name)).map(name => [name, env[name]])) } });
      const durationMs = Date.now() - started;

      if (!outcome.spawned) {
        return {
          started: false,
          reason: `podman could not be executed: ${outcome.stderr.trim() || "spawn failed"}`,
          stdout: "",
          stderr: outcome.stderr,
          durationMs,
        };
      }
      if (outcome.timedOut) {
        return {
          started: true,
          timedOut: true,
          exitCode: null,
          stdout: outcome.stdout,
          stderr: outcome.stderr,
          durationMs,
        };
      }
      // 125 is Podman's own "the run itself failed" code, mirroring Docker's
      // convention: the container never started, so this is absence of
      // evidence rather than a failing test.
      if (outcome.code === 125) {
        return {
          started: false,
          reason: `container failed to start: ${outcome.stderr.trim() || "podman exit 125"}`,
          stdout: outcome.stdout,
          stderr: outcome.stderr,
          durationMs,
        };
      }
      return {
        started: true,
        timedOut: false,
        exitCode: outcome.code,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        durationMs,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// the runner
// ---------------------------------------------------------------------------

function notRun(reason, basis, extra = {}) {
  return { status: "not_run", basis, reason, detail: null, ...extra };
}

/**
 * Decide whether the coordinator's own already-installed node_modules is safe
 * to hand a verification run, read only. Never throws.
 *
 * `hostProjectDir` has no node_modules at all: nothing to offer, no-op (most
 * repos are not Node projects, or the coordinator was never `npm install`ed).
 * Both sides have a package-lock.json and they differ: the worktree changed
 * dependencies, so the host's tree would not reflect what the worktree
 * actually needs -- block rather than risk a false pass or a misleading
 * "module not found" fail that is really an environment gap.
 * Otherwise: match (or the worktree never touched its lockfile) -- mount it.
 *
 * @param {{ hostProjectDir: string, worktreeCwd: string }} input
 * @returns {{ source: string|null, blockedReason: string|null }}
 */
export function resolveNodeModulesMount({ hostProjectDir, worktreeCwd }) {
  const hostNodeModules = path.join(hostProjectDir, "node_modules");
  if (!fs.existsSync(hostNodeModules)) return { source: null, blockedReason: null };

  let hostLock = null, worktreeLock = null;
  try { hostLock = fs.readFileSync(path.join(hostProjectDir, "package-lock.json")); } catch { hostLock = null; }
  try { worktreeLock = fs.readFileSync(path.join(worktreeCwd, "package-lock.json")); } catch { worktreeLock = null; }

  if (hostLock && worktreeLock && !hostLock.equals(worktreeLock)) {
    return {
      source: null,
      blockedReason: "this worktree's package-lock.json differs from the coordinator's own; the coordinator's node_modules would not reflect the worktree's actual dependencies",
    };
  }
  return { source: hostNodeModules, blockedReason: null };
}

function pluralCommands(count, name) {
  return `${count} command${count === 1 ? "" : "s"} in profile '${name}'`;
}

/** Largest matched shared-memory requirement in MiB; zero leaves Podman defaults. */
export function verificationShmMb(cwd, config, selection = sandboxHarnesses(cwd, config)) {
  return Math.max(0, ...selection.matched.map((name) => selection.harnesses[name].requires.shmMb ?? 0));
}

/**
 * Build the verification runner to hand to `registerVerificationRunner`.
 *
 * @param {{
 *   loadConfig?: (repoDir: string) => object,
 *   executor?: { probe: Function, run: Function },
 *   image?: string,
 *   network?: string,
 *   user?: string,
 *   workdir?: string,
 *   commandTimeoutMs?: number,
 *   overallTimeoutMs?: number,
 *   maxOutputBytes?: number,
 *   now?: () => number,
 *   hostProjectDir?: string|null,
 * }} [options]
 * @returns {(context: object) => Promise<{status: string, basis?: string, reason?: string|null, detail?: string|null}>}
 */
export function createVerificationRunner(options = {}) {
  const {
    loadConfig = defaultLoadConfig,
    executor = createPodmanExecutor(),
    image = null,
    network = "none",
    user = DEFAULT_CONTAINER_USER,
    workdir = DEFAULT_WORKDIR,
    commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    overallTimeoutMs = DEFAULT_OVERALL_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    now = () => Date.now(),
    // The coordinator's own checkout, source of a trusted, already-installed
    // node_modules a job's worktree never has (git worktree add does not copy
    // it). Unset by default: existing callers/tests see no behavior change.
    hostProjectDir = null,
    // Shells out for the lazy Go/Rust image build/existence check -- distinct
    // from `executor`, which runs commands INSIDE an already-built sandbox.
    // Injectable so tests never invoke real Podman just by pointing `cwd` at
    // a directory that happens to contain a go.mod/Cargo.toml.
    sandboxImageRun = undefined,
  } = options;

  // Snapshot operator authority before any worker runs. Never load local policy
  // from context.cwd, config objects, or harness definitions.
  let networkPolicy = null, networkPolicyError = null;
  try { networkPolicy = (options.loadVerificationNetwork ?? loadVerificationNetwork)(hostProjectDir); }
  catch (error) { networkPolicyError = error.message; }

  async function runVerification(context = {}) {
    let { profile = null, cwd = null, jobId = randomUUID(), record = null } = context;
    jobId ||= randomUUID();
    let registryNote = null;
    const notRun = (reason, basis, extra = {}) => ({ status: "not_run", basis, reason, detail: registryNote, ...extra });
    const onRegistryNote = (note) => {
      registryNote = note;
      if (record) {
        record.issues ??= [];
        if (!record.issues.includes(note)) record.issues.push(note);
      }
    };

    if (!cwd || typeof cwd !== "string") {
      return notRun("no worktree path was supplied, so nothing could be verified", "no-worktree");
    }

    // Language-agnostic by design: nomArmy already knows exactly which files
    // this diff touched (classifyTestChanges already handles Python/Go/JS/
    // TS/Ruby/JVM naming conventions), and exposes that as plain env vars
    // rather than trying to know every test runner's own CLI convention for
    // "run just these files" (pytest and jest take file paths directly; Go
    // wants package directories; cargo wants test binary names -- nomArmy
    // has no business encoding all of that). A verification command that
    // never references these behaves exactly as before this existed.
    // Deleted test files are never included -- nothing to run.
    const testChanges = record?.testChanges;
    const verificationEnv = {
      NOMARMY_CHANGED_TEST_FILES: [...(testChanges?.new_tests_added ?? []), ...(testChanges?.existing_tests_modified ?? [])].join(" "),
      NOMARMY_CHANGED_PRODUCTION_FILES: (testChanges?.production_files_changed ?? []).join(" "),
    };

    // Loaded before sandbox image resolution, not after: a Python repo's
    // dependency image needs environment.python.requirements from this same
    // config to know what to install (see pythonRequirementsFor).
    let loaded;
    try {
      loaded = loadConfig(cwd);
    } catch (error) {
      // A broken contract is not a failing test suite. Say so and stop.
      return notRun(
        `.nomarmy.yml could not be loaded: ${error.errors?.find(line => line.startsWith("verification_network ")) ?? String(error?.message || error).split("\n")[0]}`,
        "config-error",
      );
    }
    const config = loaded && loaded.found ? loaded.config : null;
    if (config && Object.hasOwn(config, "verification_network")) return notRun("verification_network is operator-local only: use .nomarmy.local.yml", "config-error");
    if (networkPolicyError) return notRun(networkPolicyError, "config-error");
    const credentialEnv = {}, secrets = [];
    const networkRecord = networkPolicy ? { allowlist: networkPolicy.allow, reached: [], credentials: Object.keys(networkPolicy.env) } : null;
    for (const [name, source] of Object.entries(networkPolicy?.env ?? {})) {
      const value = (options.hostEnv ?? process.env)[source];
      if (typeof value !== "string" || !value.length) return notRun(`missing host environment variable ${source}`, "missing-credential", { network: networkRecord });
      credentialEnv[name] = value;
      secrets.push(value);
    }
    const credentialsInUse = secrets.length > 0;
    const withheld = "output withheld: credentials were in use (set verification_network.keep_output: true in .nomarmy.local.yml to keep it, redacted)";
    const hideOutput = credentialsInUse && networkPolicy.keep_output !== true;
    const token = networkPolicy ? randomBytes(32).toString("hex") : null;
    if (token) secrets.push(token);
    const redact = value => redactCredentials(value, secrets);
    const networkInfo = networkRecord ? { network: networkRecord, issues: [`verification had network access to ${networkRecord.allowlist.join(", ")}`] } : {};

    let selection;
    try { selection = sandboxHarnesses(cwd, config); }
    catch (error) { return notRun(error.message, "config-error"); }
    const specs = selection.matched.map((name) => selection.harnesses[name]);
    if (!networkPolicy && specs.some((spec) => spec.network === "allowlist")) return notRun("allowlist harnesses require operator-local provisioning", "environment-not-provisioned");
    const services = specs.flatMap((spec) => spec.services ?? []);
    if (new Set(services.map((service) => service.name)).size !== services.length) return notRun("duplicate harness service names", "config-error");
    if (networkPolicy && services.some(s => s.name === "egress")) return notRun("service alias egress is reserved for the verification proxy", "config-error");
    const harnessEnv = Object.assign({}, ...specs.map((spec) => spec.env ?? {}));
    const shmMb = verificationShmMb(cwd, config, selection);

    const explicitImage = image || process.env.NOMARMY_AGENT_IMAGE || null;
    let sandboxImage;
    try {
      sandboxImage = resolveSandboxImage({
        cwd, explicitImage, defaultImage: DEFAULT_AGENT_IMAGE, config,
        trustedDir: hostProjectDir, onNote: onRegistryNote,
        ...(sandboxImageRun ? { run: sandboxImageRun } : {}),
      });
    } catch (error) {
      // A lazy Go/Rust/Python image build failed (offline, disk full,
      // apt/rustup/pip error). Running the job's real commands against the
      // wrong image would look like a genuine test failure rather than the
      // infrastructure gap it actually is -- not_run is the honest state.
      return notRun(error.message, "sandbox-image-build-failed");
    }

    // --- resolve what to run -------------------------------------------
    const resolved = resolveProfile({ config, profile: profile ?? null });
    if (!resolved.found) {
      const basis = !profile ? "no-profile-requested" : !config ? "no-config" : "unknown-profile";
      return notRun(resolved.reason, basis);
    }

    if (resolved.environment !== EXECUTABLE_ENVIRONMENT) {
      // Running these commands without their services would produce a
      // misleading `fail`. An unmet requirement is a `not_run`.
      return notRun(
        `profile '${resolved.name}' requires environment '${resolved.environment}', which needs provisioned services this component does not create; only 'environment: none' is executable today`,
        "environment-not-provisioned",
      );
    }

    const commands = resolved.commands;
    if (commands.length === 0) {
      return notRun(
        `verification profile '${resolved.name}' lists no commands, so there is nothing to verify`,
        "no-commands",
      );
    }

    const basis = pluralCommands(commands.length, resolved.name);

    // --- require the sandbox -------------------------------------------
    // No host fallback exists below this line, by design.
    let probe;
    try {
      probe = await executor.probe({ image: sandboxImage });
    } catch (error) {
      probe = { available: false, reason: `sandbox probe failed: ${String(error?.message || error)}` };
    }
    if (!probe || probe.available !== true) {
      return notRun(
        `${probe?.reason || "the Podman sandbox is unavailable"}; verification commands come from the repository and are never executed on the host`,
        "sandbox-unavailable",
      );
    }

    // --- offer the coordinator's own node_modules, if it is safe to -----
    // Not when the sandbox image already holds this job's own dependencies
    // (an npm lockfile: lib/sandbox-images.mjs). Those are built on Linux
    // from the worktree's lockfile; the host's tree is built for the host
    // (a Mac's esbuild and rollup binaries don't run in the Linux sandbox)
    // and would shadow them. The mount stays for yarn, pnpm and workspaces.
    let nodeModulesSource = null;
    // A union or recovery worktree nomArmy made itself may not have the
    // package links yet; idempotent.
    try { linkNodePackages(cwd, config); } catch { /* best-effort */ }
    if (hostProjectDir && !nodeDependencyFiles(cwd, config).files.length) {
      const mount = resolveNodeModulesMount({ hostProjectDir, worktreeCwd: cwd });
      if (mount.blockedReason) return notRun(mount.blockedReason, "dependency-drift");
      nodeModulesSource = mount.source;
    }

    let disposable;
    try {
      // Whenever a proxy token or credentials are issued, run on a throwaway
      // copy: anything a command writes (a token in a new file) can't reach
      // the worktree nomArmy commits from.
      if (credentialsInUse || token) {
        disposable = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-verification-"));
        const copy = path.join(disposable, "worktree");
        fs.cpSync(cwd, copy, { recursive: true, dereference: false, verbatimSymlinks: true, filter: source => path.basename(source) !== ".git" });
        cwd = copy;
      }
      // --- execute, sequentially, inside the sandbox ----------------------
      const deadline = now() + overallTimeoutMs;
      const results = [];

      let serviceRun;
      let proxyLog = "";
      const renderOutput = () => (proxyLog ? `${proxyLog}\n\n` : "") + results.map((r) => `$ ${r.command}  (exit ${r.exitCode ?? "none"}${r.timedOut ? ", timed out" : ""}${networkPolicy ? `, ${r.durationMs ?? 0}ms` : ""})\n${r.stdout ?? ""}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}`).join("\n\n");
      try {
        if (services.length || networkPolicy) serviceRun = await executor.startServices({ services, image: sandboxImage, jobId, ...(networkPolicy ? { allow: networkPolicy.allow, token } : {}) });
      } catch (error) {
        return notRun(redact(`service setup failed: ${error.message}`), "services-unavailable");
      }
      const proxyEnv = networkPolicy ? Object.fromEntries([
        ...["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"].map(name => [name, `http://nomarmy:${token}@egress:3128`]),
        ...["NO_PROXY", "no_proxy"].map(name => [name, services.map(s => s.name).join(",")]),
      ]) : {};
      try {
        for (const command of commands) {
          const remaining = deadline - now();
          if (remaining <= 0) {
            results.push({
              command,
              started: false,
              timedOut: true,
              reason: `overall verification budget of ${overallTimeoutMs}ms was exhausted before this command started`,
              timeoutMs: overallTimeoutMs,
            });
            break;
          }

          const timeoutMs = Math.max(1, Math.min(commandTimeoutMs, remaining));
          let raw;
          try {
            raw = await executor.run({
              command,
              cwd,
              image: sandboxImage,
              jobId,
              network: serviceRun?.network ?? network,
              user,
              workdir,
              timeoutMs,
              maxOutputBytes,
              nodeModulesSource,
              env: { ...harnessEnv, ...verificationEnv, ...credentialEnv, ...proxyEnv },
              secretEnv: [...Object.keys(credentialEnv), ...["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]],
              shmMb,
            });
          } catch (error) {
            raw = { started: false, reason: `sandbox execution threw: ${String(error?.message || error)}` };
          }

          const stdout = hideOutput ? { text: withheld, dropped: 0 } : capOutput(redact(raw?.stdout), maxOutputBytes);
          const stderr = capOutput(hideOutput ? "" : redact(raw?.stderr), maxOutputBytes);
          const entry = {
            command: redact(command),
            started: raw?.started !== false,
            timedOut: Boolean(raw?.timedOut),
            exitCode: Number.isInteger(raw?.exitCode) ? raw.exitCode : null,
            reason: raw?.reason == null ? null : hideOutput ? withheld : redact(raw.reason),
            durationMs: Number.isFinite(raw?.durationMs) ? raw.durationMs : null,
            timeoutMs,
            stdout: stdout.text,
            stderr: stderr.text,
            truncated: { stdout: stdout.dropped, stderr: stderr.dropped },
          };
          results.push(entry);

          // Stop at the first command that did not cleanly pass: later commands
          // would run against an already-broken tree and add nothing.
          if (!entry.started || entry.timedOut || entry.exitCode !== 0) break;
        }

      } finally {
        if (serviceRun) {
          let logError;
          try { if (serviceRun.logs) proxyLog = redactCredentials(await serviceRun.logs(), secrets, { truncated: false }); }
          catch { logError = true; }
          if (networkRecord) networkRecord.reached = [...new Set(proxyLog.split("\n").filter(line => line.endsWith(" connected")).map(line => line.split(" ")[0]))];
          try { await serviceRun.cleanup(); }
          catch (error) { return notRun(redact(`service cleanup failed: ${error.message}`), "services-cleanup-failed", { ...networkInfo, output: renderOutput() }); }
          if (logError) return notRun("could not capture egress verdict log", "egress-log-failed", { ...networkInfo, output: renderOutput() });
        } else if (executor.cleanupVerification) {
          await executor.cleanupVerification({ jobId });
        }
      }

      const verdict = classifyResults(results);
      const executed = results.filter((r) => r.started).length;
      const dropped = results.reduce(
        (total, r) => total + (r.truncated?.stdout ?? 0) + (r.truncated?.stderr ?? 0),
        0,
      );

      const detailSuffix = dropped > 0
        ? ` [${dropped} bytes of output dropped by the ${maxOutputBytes}-byte cap]`
        : "";

      if (verdict.status === "not_run") {
        return notRun(verdict.detail, "sandbox-unavailable", { ...networkInfo, output: renderOutput() });
      }

      return {
        ...networkInfo,
        // No evidence files are kept while credentials or a proxy token are in
        // use: a scan can't catch every encoding (UTF-16, wrapped, compressed).
        ...(credentialsInUse || token ? { artifacts: [], artifactsCapped: false, artifactsNote: "artifacts not kept: credentials or a proxy token were in use" } : {}),
        status: verdict.status,
        basis: `${basis}; ${executed} executed in ${sandboxImage}`,
        reason: null,
        detail: `${verdict.detail}${detailSuffix}${registryNote ? "; " + registryNote : ""}`,
        // Each command's full (capped) output, for a caller that keeps a log.
        output: renderOutput(),
      };
    } finally {
      if (disposable) fs.rmSync(disposable, { recursive: true, force: true });
    }
  }
  return async (context = {}) => {
    let result;
    try { result = await runVerification(context); }
    catch (error) {
      if (!networkPolicy) throw error;
      result = notRun("verification could not complete safely", "runner-error");
    }
    if (networkPolicy && !result.network) result.network = { allowlist: networkPolicy.allow, reached: [], credentials: Object.keys(networkPolicy.env) };
    return result;
  };
}

export default createVerificationRunner;
