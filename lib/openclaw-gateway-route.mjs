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

/**
 * Runs one job turn through the Gateway on a temporary agent, and always
 * tries to remove the agent after. `run(cmd, args, opts)` resolves
 * { stdout, stderr } and rejects on a nonzero exit (lib/process.mjs's run);
 * `runOpts` go to the turn itself (timeouts, ticks, live logs).
 * @returns {Promise<{ stdout: string, stderr: string, cleanup: { removed: boolean, reason: string|null } }>}
 */
export async function runOnGateway({ run, command = "openclaw", agentId, cwd, model, promptFile, thinking, timeoutSeconds, settings = [], scratchDir, runOpts = {}, log = () => {} }) {
  const quiet = (args) => run(command, args, { cwd, timeoutMs: 60000 }).then((r) => ({ ok: true, ...r }), (error) => ({ ok: false, stdout: error.stdout ?? "", stderr: error.stderr ?? error.message }));
  const skip = await quiet(["config", "get", "agents.defaults.skipBootstrap", "--json"]);
  const problem = gatewayReadinessProblem(skip.ok ? jsonOut({ stdout: `{"v":${String(skip.stdout).trim() || "null"}}` })?.v : null);
  if (problem) throw new Error(problem);
  const added = await quiet(["agents", "add", agentId, "--workspace", cwd, "--model", model, "--non-interactive", "--json"]);
  if (!added.ok) throw new Error(`Adding the Gateway agent ${agentId} failed: ${String(added.stderr || added.stdout).trim().split("\n")[0]}`);
  const sessionKey = `agent:${agentId}:job`;
  try {
    if (settings.length) {
      const set = await quiet(["config", "set", "--batch-json", JSON.stringify(settings)]);
      if (!set.ok) throw new Error(`Setting the job's sandbox on ${agentId} failed: ${String(set.stderr || set.stdout).trim().split("\n")[0]}`);
    }
    return { ...(await run(command, ["agent", "--agent", agentId, "--session-key", sessionKey, "--message-file", promptFile,
      "--thinking", thinking, "--timeout", String(timeoutSeconds), "--json"], { cwd, ...runOpts })), cleanup: null };
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
