// The Gateway route: an opt-in way to run a job on an agent whose sign-in
// `openclaw agent exec` can't use.
//
// `agent exec` (every other job's route) runs an isolated turn that can't
// reach an OAuth sign-in OpenClaw itself holds (openclaw/openclaw#124768):
// a Grok subscription fails there with "Explicit auth order for xai has no
// usable profiles" while a Gateway turn on the same sign-in answers. So a
// job on an agent set to `route: gateway` adds a temporary OpenClaw agent
// whose workspace is the job's worktree, gives it the job's sandbox settings
// (image, environment, PATH, memory search off), runs the brief through the
// Gateway, and removes the agent.
//
// Removal never uses the worktree as the agent's workspace: `openclaw agents
// delete` moves the agent's workspace to the Trash (found live: it trashed a
// test folder), so the workspace is first repointed, conditionally, at an
// empty folder of the job's own, and the delete only runs once that is read
// back. If anything there fails, the entry is left for `nomarmy health` to
// report, never the worktree to OpenClaw.

import fs from "node:fs";
import path from "node:path";

export const GATEWAY_AGENT_PREFIX = "nomarmy-job-";

// The sign-in method that works while the Gateway runs. OpenClaw 2026.11.3
// does a sign-in through a running Gateway only for a method it declares
// Gateway-compatible: for xAI that's "oauth" (a device-code flow, so it also
// works with no browser on the machine); its "device-code" alias is
// manual-only and refused there ("No Gateway-compatible login matches this
// provider and method").
const GATEWAY_SIGN_IN_METHODS = Object.freeze({ xai: "oauth" });
export function gatewaySignInMethod(provider, requested = null) {
  if (provider === "xai" && (!requested || requested === "device-code")) return "oauth";
  return requested || GATEWAY_SIGN_IN_METHODS[provider] || null;
}

/**
 * The command that signs OpenClaw in to a provider again. It names the main
 * agent: with any other agent configured (a running Gateway job's, or one a
 * crashed job left), OpenClaw refuses a sign-in with no --agent.
 */
export function openclawSignInCommand(provider) {
  const method = gatewaySignInMethod(provider);
  return `openclaw models auth login --provider ${provider}${method ? ` --method ${method}` : ""} --agent main`;
}

/**
 * The Gateway's state from `openclaw gateway status --json --no-probe`:
 * installed (a launchd/systemd/schtasks service exists) and running.
 * @returns {{ installed: boolean, running: boolean } | null} null when unreadable
 */
export function parseGatewayStatus(stdout) {
  const text = String(stdout ?? "");
  const start = text.indexOf("{");
  if (start < 0) return null;
  let parsed;
  try { parsed = JSON.parse(text.slice(start)); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || !("service" in parsed || "port" in parsed)) return null;
  const service = parsed.service ?? {};
  const installed = service.loaded === true || Boolean(service.command);
  // A Gateway started by hand (`openclaw gateway run`) has no service runtime
  // but still holds its port.
  const running = service.runtime?.status === "running" || parsed.port?.status === "busy";
  return { installed, running };
}

/**
 * A plain cause for a Gateway turn that failed before the model answered,
 * or null. OpenClaw's own words name the temporary agent ("No API key found
 * for provider "xai" ... agentDir: .../nomarmy-job-...") when the real cause
 * is the main sign-in, which the temporary agent shares.
 */
export function gatewayFailureLine(text, provider) {
  const s = String(text ?? "");
  if (/missing-provider-auth|No API key found for provider/i.test(s)) {
    // The provider is quoted, and escaped inside OpenClaw's JSON envelope.
    const p = /No API key found for provider \\?"([^"\\]+)/i.exec(s)?.[1] ?? provider;
    if (!p) return "OpenClaw has no usable sign-in for this job's provider: it has expired or was removed (`openclaw models status` shows which). Sign in again with `openclaw models auth login --provider <id> --agent main`.";
    return `OpenClaw has no usable ${p} sign-in: it has expired or was removed (\`openclaw models status\` shows which). Sign in again: ${openclawSignInCommand(p)}`;
  }
  if (/gateway closed \(1006/i.test(s)) return "The OpenClaw Gateway closed the connection during the job (it restarted, was stopped, or crashed). Check `openclaw gateway status`, then run the job again.";
  if (/ECONNREFUSED|gateway (?:is )?not running|connect ECONN/i.test(s)) return "The OpenClaw Gateway isn't running, and Gateway-route jobs run through it. Start it: openclaw gateway start (or `openclaw gateway install` if it was never installed as a service).";
  return null;
}

/** Temporary Gateway agents whose job isn't running: listed rows of `openclaw agents list --json`. */
export function leftoverGatewayAgents(rows, runningJobIds = []) {
  const running = runningJobIds.map((id) => { try { return gatewayAgentId(id); } catch { return null; } }).filter(Boolean);
  return (Array.isArray(rows) ? rows : []).filter((r) => typeof r?.id === "string" && r.id.startsWith(GATEWAY_AGENT_PREFIX) && !running.some((id) => r.id.startsWith(id)));
}

/** The temporary OpenClaw agent id for a job: lowercase letters, digits and hyphens. */
export function gatewayAgentId(jobId) {
  const tail = String(jobId ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!tail) throw new Error("a Gateway job needs a job id");
  return `${GATEWAY_AGENT_PREFIX}${tail}`.slice(0, 64);
}

/**
 * The per-agent settings that carry a job's sandbox override (the config
 * resolveWorkerSandboxOverride writes for `agent exec --config`) onto a
 * Gateway agent: OpenClaw reads an agent's own sandbox.docker over the
 * defaults, and its own tools.exec.pathPrepend before the global one.
 * @returns {{ path: string, value: unknown }[]} `openclaw config set --batch-json` operations
 */
export function gatewayAgentSettings(agentId, override) {
  const at = (key) => `agents.entries.${agentId}.${key}`;
  const docker = override?.agents?.defaults?.sandbox?.docker ?? {};
  const ops = [
    // Privacy, as withJobPrivacy sets for agent exec: no memory search that
    // indexes and embeds the session (the brief and the code it read).
    { path: at("memory.search.enabled"), value: false },
  ];
  if (typeof docker.image === "string" && docker.image) ops.push({ path: at("sandbox.docker.image"), value: docker.image });
  if (docker.env && typeof docker.env === "object" && Object.keys(docker.env).length) ops.push({ path: at("sandbox.docker.env"), value: docker.env });
  const pathPrepend = override?.tools?.exec?.pathPrepend;
  if (Array.isArray(pathPrepend) && pathPrepend.length) ops.push({ path: at("tools.exec.pathPrepend"), value: pathPrepend });
  // The file restriction policy a backend needs (lib/cli-backend-policy.mjs).
  if (override?.tools?.fs && typeof override.tools.fs === "object") ops.push({ path: at("tools.fs"), value: override.tools.fs });
  return ops;
}

/**
 * A Gateway turn's JSON (`openclaw agent --json`) in `agent exec`'s shape, so
 * the rest of a job reads it the same way. Its cost is left out: OpenClaw
 * prices the tokens at API rates, but a subscription isn't billed per token.
 */
export function gatewayResultAsExecResult(parsed) {
  const meta = parsed?.result?.meta ?? {};
  const agentMeta = meta.agentMeta ?? {};
  const payloads = Array.isArray(parsed?.result?.payloads) ? parsed.result.payloads : [];
  const final = typeof meta.finalAssistantVisibleText === "string" ? meta.finalAssistantVisibleText : payloads[0]?.text ?? "";
  const { cost: _cost, ...usage } = agentMeta.usage ?? {};
  return {
    ok: parsed?.status === "ok" && meta.aborted !== true,
    status: parsed?.status ?? "error",
    final,
    payloads,
    usage,
    ...(agentMeta.model ? { model: agentMeta.model } : {}),
    ...(agentMeta.provider ? { provider: agentMeta.provider } : {}),
    ...(agentMeta.sessionId ? { sessionId: agentMeta.sessionId } : {}),
    ...(meta.toolSummary ? { toolSummary: meta.toolSummary } : {}),
    ...(meta.stopReason ? { stopReason: meta.stopReason } : {}),
    route: "gateway",
    ...(meta.terminalReply?.modelRouteChange ? { modelRouteChange: meta.terminalReply.modelRouteChange } : {}),
  };
}

/** Why a Gateway job can't run on this OpenClaw config, or null. */
export function gatewayReadinessProblem(skipBootstrap) {
  if (skipBootstrap === true) return null;
  return "OpenClaw would write its starter files (AGENTS.md, SOUL.md, BOOTSTRAP.md, ...) into the job's worktree, since agents.defaults.skipBootstrap isn't set. Set it with `openclaw config set agents.defaults.skipBootstrap true --strict-json`, or run `nomarmy agents update <agent> --route gateway`, which asks to set it.";
}

function jsonOut(result) {
  const text = String(result?.stdout ?? "");
  const start = text.indexOf("{");
  if (start < 0) return null;
  try { return JSON.parse(text.slice(start)); } catch { return null; }
}

// OpenClaw refuses a config write when another process wrote the config
// after this one loaded it (OpenClaw 2026.11: "config changed since last
// load; re-run config.get and retry"). Concurrent jobs each add, configure
// and remove their own temporary agent, so they hit it; the write is safe to
// try again, since it's re-read each time.
const CONFIG_RACE = /config (?:path )?changed since last load|config base hash required|config receipt hash mismatch/i;
export const CONFIG_RETRY_DELAYS_MS = Object.freeze([250, 750, 2000]);

/** `write()` (a `quiet` call), tried again while it loses the config race. */
export async function retryConfigRace(write, { delays = CONFIG_RETRY_DELAYS_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let result = await write();
  for (const ms of delays) {
    if (result.ok || !CONFIG_RACE.test(`${result.stderr ?? ""}\n${result.stdout ?? ""}`)) return result;
    await sleep(ms + Math.floor(Math.random() * ms));
    result = await write();
  }
  return result;
}

/**
 * Runs one job turn through the Gateway on a temporary agent, and always
 * tries to remove the agent after. `run(cmd, args, opts)` resolves
 * { stdout, stderr } and rejects on a nonzero exit (lib/process.mjs's run);
 * `runOpts` go to the turn itself (timeouts, ticks, live logs).
 * @returns {Promise<{ stdout: string, stderr: string, cleanup: { removed: boolean, reason: string|null } }>}
 */
export async function runOnGateway({ run, command = "openclaw", agentId, cwd, model, promptFile, thinking, timeoutSeconds, settings = [], scratchDir, runOpts = {}, log = () => {}, runningJobIds = null, retryDelays = CONFIG_RETRY_DELAYS_MS }) {
  const once = (args) => run(command, args, { cwd, timeoutMs: 60000 }).then((r) => ({ ok: true, ...r }), (error) => ({ ok: false, stdout: error.stdout ?? "", stderr: error.stderr ?? error.message }));
  // Every call that writes OpenClaw's config (agents add/delete, config set)
  // retries the race with another job's write; reads never hit it.
  const quiet = (args) => retryConfigRace(() => once(args), { delays: retryDelays });
  const skip = await quiet(["config", "get", "agents.defaults.skipBootstrap", "--json"]);
  const problem = gatewayReadinessProblem(skip.ok ? jsonOut({ stdout: `{"v":${String(skip.stdout).trim() || "null"}}` })?.v : null);
  if (problem) throw new Error(problem);
  // Agents an earlier job couldn't remove (the Gateway dropped mid-job) make
  // OpenClaw refuse a sign-in with no --agent, so each job retries them.
  if (Array.isArray(runningJobIds)) {
    try {
      for (const line of await sweepLeftoverGatewayAgents({ quiet, runningJobIds: [...runningJobIds, agentId.slice(GATEWAY_AGENT_PREFIX.length)], scratchDir })) log(line);
    } catch { /* best effort: health reports what's left */ }
  }
  const added = await quiet(["agents", "add", agentId, "--workspace", cwd, "--model", model, "--non-interactive", "--json"]);
  if (!added.ok) throw new Error(`Adding the Gateway agent ${agentId} failed: ${String(added.stderr || added.stdout).trim().split("\n")[0]}`);
  const sessionKey = `agent:${agentId}:job`;
  try {
    if (settings.length) {
      const set = await quiet(["config", "set", "--batch-json", JSON.stringify(settings)]);
      if (!set.ok) throw new Error(`Setting the job's sandbox on ${agentId} failed: ${String(set.stderr || set.stdout).trim().split("\n")[0]}`);
    }
    try {
      return { ...(await run(command, ["agent", "--agent", agentId, "--session-key", sessionKey, "--message-file", promptFile,
        "--thinking", thinking, "--timeout", String(timeoutSeconds), "--json"], { cwd, ...runOpts })), cleanup: null };
    } catch (error) {
      const line = gatewayFailureLine(`${error?.stdout ?? ""}\n${error?.stderr ?? ""}\n${error?.message ?? ""}`, String(model ?? "").split("/")[0] || null);
      // The job record's issue is the first line of the stack (lib/execute.mjs).
      if (line && error && typeof error === "object") { error.stack = `${line}\n${error.stack ?? error.message ?? ""}`; error.message = `${line}\n${error.message ?? ""}`; error.gatewayCause = line; }
      throw error;
    }
  } finally {
    const cleanup = await removeGatewayAgent({ quiet, agentId, cwd, sessionKey, scratchDir });
    log(cleanup.removed ? `Gateway agent ${agentId} removed` : `Gateway agent ${agentId} NOT removed (${cleanup.reason}); nomarmy health reports it`);
  }
}

/**
 * Ends the job's session, moves the agent's workspace off the worktree (only
 * if it still is the worktree), confirms that, then deletes the agent.
 */
export async function removeGatewayAgent({ quiet, agentId, cwd, sessionKey, scratchDir }) {
  await quiet(["sessions", "delete", sessionKey, "--agent", agentId, "--yes", "--json"]);
  const decoy = path.join(scratchDir, `${agentId}-workspace`);
  try { fs.mkdirSync(decoy, { recursive: true }); } catch (error) { return { removed: false, reason: `no empty workspace to swap in: ${error.message}` }; }
  const workspaceKey = `agents.entries.${agentId}.workspace`;
  const moved = await quiet(["config", "set", workspaceKey, JSON.stringify(decoy), "--strict-json", "--expect-current-json", JSON.stringify(cwd)]);
  if (!moved.ok) return { removed: false, reason: "its workspace couldn't be moved off the worktree" };
  const now = await quiet(["config", "get", workspaceKey, "--json"]);
  let current = null;
  try { current = JSON.parse(String(now.stdout).trim()); } catch { /* unreadable: don't delete */ }
  if (!now.ok || current !== decoy) return { removed: false, reason: "its workspace couldn't be confirmed off the worktree" };
  const deleted = await quiet(["agents", "delete", agentId, "--force", "--json"]);
  return deleted.ok ? { removed: true, reason: null } : { removed: false, reason: "openclaw agents delete failed" };
}

/**
 * Removes temporary agents earlier Gateway jobs left behind, the same safe
 * way as a job's own cleanup (workspace off the worktree first). Rows whose
 * job is running are kept. Returns log lines.
 */
export async function sweepLeftoverGatewayAgents({ quiet, runningJobIds = [], scratchDir }) {
  const listed = await quiet(["agents", "list", "--json"]);
  if (!listed.ok) return [];
  let rows = [];
  try { const text = String(listed.stdout ?? ""); rows = JSON.parse(text.slice(text.indexOf("["))); } catch { return []; }
  const lines = [];
  for (const row of leftoverGatewayAgents(rows, runningJobIds)) {
    if (typeof row.workspace !== "string" || !row.workspace) { lines.push(`Leftover Gateway agent ${row.id} has no workspace listed; left for nomarmy health`); continue; }
    const result = await removeGatewayAgent({ quiet, agentId: row.id, cwd: row.workspace, sessionKey: `agent:${row.id}:job`, scratchDir });
    lines.push(result.removed ? `Removed leftover Gateway agent ${row.id}` : `Leftover Gateway agent ${row.id} NOT removed (${result.reason}); nomarmy health reports it`);
  }
  return lines;
}
