import os from "node:os";
import path from "node:path";

export function createServerContext({ env = process.env, homedir = os.homedir(), cwd = process.cwd() } = {}) {
  const projectDir = path.resolve(env.CLAUDE_PROJECT_DIR || cwd);
  const stateRoot = env.NOMARMY_AGENT_STATE || path.join(homedir, ".local", "share", "nomarmy-local-agents");
  const jobsRoot = path.join(stateRoot, "jobs");
  const runsRoot = path.join(stateRoot, "runs");
  // Shared by every session's server on this machine (lib/slots.mjs).
  const leasesRoot = path.join(stateRoot, "leases");
  const slotsRoot = path.join(stateRoot, "slots");
  return Object.freeze({ projectDir, stateRoot, jobsRoot, runsRoot, leasesRoot, slotsRoot });
}
