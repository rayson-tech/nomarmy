import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// OpenClaw bind-mounts its skills read-only at
// /workspace/.openclaw/sandbox-skills/skills, inside the worktree's own
// read-write mount. When that directory doesn't exist, the container runtime
// creates it in the worktree as container root, which under rootless
// Podman's keep-id mapping is the first subordinate id (165536 on a typical
// server): mode 1755, and the host user can neither delete nor replace it,
// so every later `git worktree remove` failed "Permission denied". Created
// beforehand by the host user, the runtime mounts onto it and nothing in the
// worktree changes owner.
export const SANDBOX_SKILLS_MOUNT = path.join(".openclaw", "sandbox-skills", "skills");

/** Create the directories OpenClaw mounts into, as the host user, before a run. Never throws. */
export function prepareSandboxMounts(worktree) {
  try { fs.mkdirSync(path.join(worktree, SANDBOX_SKILLS_MOUNT), { recursive: true }); return null; }
  catch (error) { return error.message; }
}

const defaultRun = (command, args) => spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });

/**
 * Hand anything in `dir` the sandbox left under a subordinate id back to the
 * host user: inside `podman unshare`, uid 0 is the host user. Only the
 * top-most foreign-owned paths are changed. Linux only (rootless Podman on
 * macOS and Windows maps the VM's files to the host user already). Never throws.
 * @returns {{ reclaimed: string[], error: string|null }}
 */
export function reclaimSandboxOwnership(dir, { platform = process.platform, uid = process.getuid?.(), run = defaultRun } = {}) {
  if (platform !== "linux" || uid === undefined || uid === 0 || !fs.existsSync(dir)) return { reclaimed: [], error: null };
  const found = run("find", [dir, "-xdev", "!", "-user", String(uid), "-prune", "-print0"]);
  const foreign = String(found.stdout ?? "").split("\0").filter(Boolean);
  if (!foreign.length) return { reclaimed: [], error: found.status === 0 ? null : `find exited ${found.status}` };
  const chown = run("podman", ["unshare", "chown", "-R", "-h", "0:0", "--", ...foreign]);
  return chown.status === 0
    ? { reclaimed: foreign, error: null }
    : { reclaimed: [], error: `podman unshare chown failed: ${String(chown.stderr || chown.error?.message || chown.status).trim().split("\n")[0]}` };
}

/** An actionable message for a worktree git couldn't delete because the sandbox owns some of it. */
export function worktreeRemovalHint(message, worktree) {
  if (!/permission denied|operation not permitted/i.test(String(message ?? ""))) return null;
  return `Files in ${worktree} are owned by the sandbox's user namespace, not you. Fix: podman unshare chown -R -h 0:0 ${worktree}, then remove it again (local_worker_cleanup).`;
}
