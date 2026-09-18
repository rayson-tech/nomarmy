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
// to repo-controlled code — the exact privilege the worker itself is denied.
//
// Therefore commands only ever execute inside the Podman sandbox image, as a
// non-root user, with `--network none`. If Podman is missing, the image is
// absent, or the container fails to start, the verdict is `not_run`. There is
// no host fallback path in this file, deliberately: a missing sandbox is
// absence of evidence, not permission to take a shortcut.
//
// Nothing from configuration ever reaches a host-side shell. Every host process
// is spawned with an argv array and `shell: false`. A command string is handed
// to `/bin/sh -c` *inside* the container, which is inside the sandbox boundary.

import { spawn } from "node:child_process";

import { loadConfig as defaultLoadConfig } from "./config.mjs";

/** Sandbox image used when `NOMARMY_AGENT_IMAGE` is unset. */
export const DEFAULT_AGENT_IMAGE = "openclaw-rayson-coder:bookworm";

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
  return ` — last output: ${tail.replace(/\s+/g, " ")}`;
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
 *           network?: string, user?: string, workdir?: string }} input
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
    "--mount",
    `type=bind,source=${cwd},target=${workdir}`,
  ];
  if (jobId) args.push("--label", `nomarmy.job=${jobId}`);
  args.push("--entrypoint", "/bin/sh", image, "-c", command);
  return args;
}

// ---------------------------------------------------------------------------
// the real Podman executor (the only place a host process is spawned)
// ---------------------------------------------------------------------------

function spawnCollect(file, args, { timeoutMs, maxOutputBytes, cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      // shell:false is the whole point — nothing here is ever parsed by a host
      // shell, so a config value cannot break out of its argv slot.
      child = spawn(file, args, { cwd, shell: false, windowsHide: true });
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
export function createPodmanExecutor({ podman = "podman" } = {}) {
  return {
    /** Is a usable sandbox present? Never throws. */
    async probe({ image }) {
      const version = await spawnCollect(podman, ["version", "--format", "{{.Server.Version}}"], {
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

      const inspect = await spawnCollect(podman, ["image", "inspect", image], {
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
    async run({ command, cwd, image, jobId, network, user, workdir, timeoutMs, maxOutputBytes }) {
      const args = buildPodmanArgs({ image, cwd, command, jobId, network, user, workdir });
      const started = Date.now();
      const outcome = await spawnCollect(podman, args, { timeoutMs, maxOutputBytes });
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

function pluralCommands(count, name) {
  return `${count} command${count === 1 ? "" : "s"} in profile '${name}'`;
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
  } = options;

  return async function runVerification(context = {}) {
    const { profile = null, cwd = null, jobId = null } = context;
    const sandboxImage = image || process.env.NOMARMY_AGENT_IMAGE || DEFAULT_AGENT_IMAGE;

    if (!cwd || typeof cwd !== "string") {
      return notRun("no worktree path was supplied, so nothing could be verified", "no-worktree");
    }

    // --- resolve what to run -------------------------------------------
    let loaded;
    try {
      loaded = loadConfig(cwd);
    } catch (error) {
      // A broken contract is not a failing test suite. Say so and stop.
      return notRun(
        `.nomarmy.yml could not be loaded: ${String(error?.message || error).split("\n")[0]}`,
        "config-error",
      );
    }

    const config = loaded && loaded.found ? loaded.config : null;
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

    // --- execute, sequentially, inside the sandbox ----------------------
    const deadline = now() + overallTimeoutMs;
    const results = [];

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
          network,
          user,
          workdir,
          timeoutMs,
          maxOutputBytes,
        });
      } catch (error) {
        raw = { started: false, reason: `sandbox execution threw: ${String(error?.message || error)}` };
      }

      const stdout = capOutput(raw?.stdout, maxOutputBytes);
      const stderr = capOutput(raw?.stderr, maxOutputBytes);
      const entry = {
        command,
        started: raw?.started !== false,
        timedOut: Boolean(raw?.timedOut),
        exitCode: Number.isInteger(raw?.exitCode) ? raw.exitCode : null,
        reason: raw?.reason ?? null,
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
      return notRun(verdict.detail, "sandbox-unavailable");
    }

    return {
      status: verdict.status,
      basis: `${basis}; ${executed} executed in ${sandboxImage}`,
      reason: null,
      detail: `${verdict.detail}${detailSuffix}`,
    };
  };
}

export default createVerificationRunner;
