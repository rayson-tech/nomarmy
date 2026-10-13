import { execFileSync } from "node:child_process";
import fs from "node:fs";

// A sandbox on rootless Podman writes files as a subordinate uid the operator
// can't delete. `podman unshare` runs as root in Podman's user namespace,
// where those files belong to it.
const defaultUnshare = (dir) => execFileSync("podman", ["unshare", "rm", "-rf", "--", dir],
  { stdio: "ignore", timeout: 30_000 });

/** Best-effort removal of a temporary tree. Never throws; returns why it couldn't, or null. */
export function removeTree(dir, { platform = process.platform, // Retries cover a runtime still writing as the call returns (ENOTEMPTY).
  rm = (target) => fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }), unshare = defaultUnshare } = {}) {
  try { rm(dir); return null; }
  catch (error) {
    if (platform === "linux" && (error.code === "EACCES" || error.code === "EPERM")) {
      try { unshare(dir); rm(dir); return null; } catch { /* report the original error */ }
    }
    return `couldn't remove ${dir}: ${error.message}`;
  }
}
