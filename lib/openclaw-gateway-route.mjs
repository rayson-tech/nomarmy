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
//
// With OpenClaw 2026.11's Gateway holding its state, `openclaw agents add`,
// `agents delete` and `config set` are Gateway calls. The CLI binds each one
// to the Gateway process it found holding the state lock (expectedOwnerId),
// and the Gateway refuses the mutation if, before it commits, that owner
// changed (a Gateway restart) or its runtime config changed (a hot reload
// from any config write, another job's agent setup or removal included).
// OpenClaw's wording (src/cli/local-state-owner.ts and
// src/gateway/server-methods/local-state-owner.ts):
//   "... could not complete agents.create for X: Gateway state owner or
//    requester changed; rerun against the current owner. ... No local
//    mutation was attempted."
//   "Cannot admit agents.create for X ...: Gateway owner changed before
//    dispatch. No local mutation was attempted."
// It killed a continue_from follow-up that started while another job's agent
// was being torn down. OpenClaw awaits a hot-applied config write before
// answering, so one machine-wide lock (lib/slots.mjs) around every nomArmy
// process's Gateway writes, setup and removal, never the turn, closes that.
// A Gateway restart or someone else's write can still land in between, so a
// refused agents.create that OpenClaw says made no change (still before any
// turn, so before any model spend) is retried with backoff and reported.

import fs from "node:fs";
import path from "node:path";
import { acquireSlot } from "./slots.mjs";

export const GATEWAY_AGENT_PREFIX = "nomarmy-job-";

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

// The refused agents.create above. The CLI prints no stable code, so it
// takes that call, either owner wording, and OpenClaw's own statement that
// nothing was changed: an "outcome may be partial" failure is never retried,
// since the agent may already exist.
export const GATEWAY_AGENTS_CREATE_OWNER_CHANGED = /agents\.create\b[^\n]*\bGateway (?:state )?owner (?:or requester )?changed\b[^\n]*No local mutation was attempted/i;

export function gatewayAgentsCreateRaced(text) {
  return GATEWAY_AGENTS_CREATE_OWNER_CHANGED.test(String(text ?? ""));
}

export const MAX_AGENT_CREATE_RETRIES = 3;
// 2s, 4s, 8s: room for a Gateway restart, not just a hot reload.
const AGENT_CREATE_RETRY_DELAY_MS = 2000;
// Setup or removal holds the lock for a few OpenClaw calls (seconds); a job
// waiting longer than this goes ahead without it rather than never starting.
const REGISTRY_LOCK_WAIT_MS = 120000;
export const GATEWAY_REGISTRY_LOCK_KEY = "openclaw-gateway-agents";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn` holding the machine-wide lock on OpenClaw's agent registry (one
 * slot under `lockDir`, shared by every nomArmy server and detached job).
 * With no `lockDir` it runs unlocked; a lock not freed within `waitMs` is
 * logged and `fn` runs anyway.
 */
export async function withGatewayRegistryLock(lockDir, fn, { waitMs = REGISTRY_LOCK_WAIT_MS, jobId = null, log = () => {} } = {}) {
  let slot = null;
  if (lockDir) {
    try {
      slot = await acquireSlot(lockDir, GATEWAY_REGISTRY_LOCK_KEY, 1, { jobId, waitMs, pollMs: 250 });
      if (!slot) log(`Gateway agent registry lock still held after ${Math.round(waitMs / 1000)}s; going ahead without it`);
    } catch (error) { log(`Gateway agent registry lock unavailable (${error.message}); going ahead without it`); }
  }
  try { return await fn(); } finally { slot?.release(); }
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

/**
 * Runs one job turn through the Gateway on a temporary agent, and always
 * tries to remove the agent after. `run(cmd, args, opts)` resolves
 * { stdout, stderr } and rejects on a nonzero exit (lib/process.mjs's run);
 * `runOpts` go to the turn itself (timeouts, ticks, live logs).
 *
 * Setup (the checks, `agents add`, the sandbox settings) and removal each run
 * under the registry lock (`lockDir`, see withGatewayRegistryLock); the turn
 * doesn't. An `agents add` refused as a raced agents.create is retried up to
 * MAX_AGENT_CREATE_RETRIES times with doubling backoff, each reported through
 * `onStartRetry(attempt, detail)`: only there, before any turn has run.
 * @returns {Promise<{ stdout: string, stderr: string, cleanup: null, startRetries: number }>}
 */
export async function runOnGateway({ run, command = "openclaw", agentId, cwd, model, promptFile, thinking, timeoutSeconds, settings = [], scratchDir, runOpts = {}, log = () => {},
  lockDir = null, lockWaitMs = REGISTRY_LOCK_WAIT_MS, sleep = pause, retryDelayMs = AGENT_CREATE_RETRY_DELAY_MS, onStartRetry = () => {} }) {
  const quiet = (args) => run(command, args, { cwd, timeoutMs: 60000 }).then((r) => ({ ok: true, ...r }), (error) => ({ ok: false, stdout: error.stdout ?? "", stderr: error.stderr ?? error.message }));
  const locked = (fn) => withGatewayRegistryLock(lockDir, fn, { waitMs: lockWaitMs, jobId: agentId, log });
  const sessionKey = `agent:${agentId}:job`;
  let startRetries = 0;
  await locked(async () => {
    const skip = await quiet(["config", "get", "agents.defaults.skipBootstrap", "--json"]);
    const problem = gatewayReadinessProblem(skip.ok ? jsonOut({ stdout: `{"v":${String(skip.stdout).trim() || "null"}}` })?.v : null);
    if (problem) throw new Error(problem);
    for (;;) {
      const added = await quiet(["agents", "add", agentId, "--workspace", cwd, "--model", model, "--non-interactive", "--json"]);
      if (added.ok) return;
      const detail = String(added.stderr || added.stdout).trim().split("\n")[0];
      const raced = gatewayAgentsCreateRaced(`${added.stderr ?? ""}\n${added.stdout ?? ""}`);
      if (raced && startRetries < MAX_AGENT_CREATE_RETRIES) {
        startRetries++;
        log(`Gateway refused agents.create for ${agentId} (its owner or runtime config changed mid-call; nothing was changed); the worker hasn't started, retry ${startRetries}/${MAX_AGENT_CREATE_RETRIES}\n${detail}`);
        onStartRetry(startRetries, detail);
        await sleep(retryDelayMs * 2 ** (startRetries - 1));
        continue;
      }
      throw Object.assign(new Error(`Adding the Gateway agent ${agentId} failed: ${detail}${raced ? ` (the Gateway's owner or config changed mid-call, retried ${startRetries} time(s) before the worker started)` : ""}`),
        { gatewayStartRetries: startRetries });
    }
  });
  try {
    if (settings.length) {
      const set = await locked(() => quiet(["config", "set", "--batch-json", JSON.stringify(settings)]));
      if (!set.ok) throw new Error(`Setting the job's sandbox on ${agentId} failed: ${String(set.stderr || set.stdout).trim().split("\n")[0]}`);
    }
    // The turn runs outside the lock: it's the long part and writes no registry.
    return { ...(await run(command, ["agent", "--agent", agentId, "--session-key", sessionKey, "--message-file", promptFile,
      "--thinking", thinking, "--timeout", String(timeoutSeconds), "--json"], { cwd, ...runOpts })), cleanup: null, startRetries };
  } finally {
    const cleanup = await locked(() => removeGatewayAgent({ quiet, agentId, cwd, sessionKey, scratchDir }));
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
