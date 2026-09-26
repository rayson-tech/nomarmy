import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// The repository jobs run against: NOMARMY_PROJECT_DIR (set by `nomarmy
// connect cursor` to Cursor's ${workspaceFolder}), else Claude Code's
// CLAUDE_PROJECT_DIR, else the folder the server was started in (Claude Code
// and Codex start it in the open project; Cursor starts a global server in
// the home folder). A value still holding an unexpanded ${...} counts as
// unset.
export function createServerContext({ env = process.env, homedir = os.homedir(), cwd = process.cwd() } = {}) {
  const fromEnv = [env.NOMARMY_PROJECT_DIR, env.CLAUDE_PROJECT_DIR].find((v) => v && !v.includes("${"));
  const projectDir = path.resolve(fromEnv || cwd);
  const stateRoot = env.NOMARMY_AGENT_STATE || path.join(homedir, ".local", "share", "nomarmy-local-agents");
  const jobsRoot = path.join(stateRoot, "jobs");
  const runsRoot = path.join(stateRoot, "runs");
  // Shared by every session's server on this machine (lib/slots.mjs).
  const leasesRoot = path.join(stateRoot, "leases");
  const slotsRoot = path.join(stateRoot, "slots");
  return Object.freeze({ projectDir, stateRoot, jobsRoot, runsRoot, leasesRoot, slotsRoot });
}

/**
 * Why jobs can't run against projectDir, or null. Jobs need a git
 * repository (worktrees, nomArmy's commits); anything else, like the home
 * folder a coordinator started the server in, is refused before dispatch.
 */
export function projectDirProblem(projectDir, { run = (args) => spawnSync("git", args, { encoding: "utf8" }) } = {}) {
  const result = run(["-C", projectDir, "rev-parse", "--is-inside-work-tree"]);
  if (result.status === 0 && String(result.stdout).trim() === "true") return null;
  return `nomArmy's project folder is ${projectDir}, which isn't a git repository, so no job was sent. The coordinator started nomArmy's server outside the project: set NOMARMY_PROJECT_DIR to the repository in its MCP settings (\`nomarmy connect cursor\` does this for Cursor), or start the coordinator from inside the repository.`;
}
