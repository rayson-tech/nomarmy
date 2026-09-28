// Windows only lets an account create symlinks with Developer Mode or admin
// rights. A directory can use a junction instead, which needs neither; a
// file cannot, so tests that need file symlinks skip without the right.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function probe() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-symlink-probe-"));
  try {
    fs.writeFileSync(path.join(dir, "target"), "");
    fs.symlinkSync(path.join(dir, "target"), path.join(dir, "link"));
    return true;
  } catch (error) {
    if (error.code === "EPERM") return false;
    throw error;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

export const canSymlink = probe();

// A `test` skip value: false, or the reason the test can't run here.
export const noSymlinks = canSymlink ? false : "this account can't create symlinks (turn on Windows Developer Mode)";

export function linkDir(target, linkPath) {
  fs.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}
