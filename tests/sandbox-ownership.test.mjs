import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { prepareSandboxMounts, reclaimSandboxOwnership, worktreeRemovalHint, SANDBOX_SKILLS_MOUNT } from "../lib/sandbox-ownership.mjs";

const tmp = (t) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-owner-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

test("prepareSandboxMounts creates OpenClaw's skills mount point as this user, and keeps an existing one", (t) => {
  const dir = tmp(t);
  assert.equal(prepareSandboxMounts(dir), null);
  const target = path.join(dir, SANDBOX_SKILLS_MOUNT);
  assert.equal(fs.statSync(target).isDirectory(), true);
  if (process.getuid) assert.equal(fs.statSync(target).uid, process.getuid());
  fs.writeFileSync(path.join(dir, ".openclaw", "nomarmy-evidence.mjs"), "x");
  assert.equal(prepareSandboxMounts(dir), null);
  assert.equal(fs.existsSync(path.join(dir, ".openclaw", "nomarmy-evidence.mjs")), true);
  assert.match(prepareSandboxMounts(path.join(dir, ".openclaw", "nomarmy-evidence.mjs")), /ENOTDIR|EEXIST/);
});

test("reclaimSandboxOwnership hands only the top-most foreign paths to podman unshare, on Linux only", (t) => {
  const dir = tmp(t);
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    return command === "find" ? { status: 0, stdout: `${dir}/.openclaw/sandbox-skills\0` } : { status: 0, stdout: "" };
  };
  assert.deepEqual(reclaimSandboxOwnership(dir, { platform: "linux", uid: 1000, run }), { reclaimed: [`${dir}/.openclaw/sandbox-skills`], error: null });
  assert.deepEqual(calls, [
    ["find", dir, "-xdev", "!", "-user", "1000", "-prune", "-print0"],
    ["podman", "unshare", "chown", "-R", "-h", "0:0", "--", `${dir}/.openclaw/sandbox-skills`],
  ]);
  for (const options of [{ platform: "darwin", uid: 501 }, { platform: "linux", uid: 0 }]) {
    assert.deepEqual(reclaimSandboxOwnership(dir, { ...options, run: () => assert.fail("not on this platform") }), { reclaimed: [], error: null });
  }
  assert.deepEqual(reclaimSandboxOwnership(dir, { platform: "linux", uid: 1000, run: (c) => c === "find" ? { status: 0, stdout: "" } : assert.fail("nothing to reclaim") }), { reclaimed: [], error: null });
  const failed = reclaimSandboxOwnership(dir, { platform: "linux", uid: 1000, run: (c) => c === "find" ? { status: 0, stdout: `${dir}/x\0` } : { status: 125, stderr: "cannot find newuidmap\n" } });
  assert.deepEqual(failed, { reclaimed: [], error: "podman unshare chown failed: cannot find newuidmap" });
});

test("worktreeRemovalHint names the fix for a permission failure, and nothing else", () => {
  assert.match(worktreeRemovalHint("git exited 255: error: failed to delete '/w/.openclaw/sandbox-skills/skills': Permission denied", "/w"), /podman unshare chown -R -h 0:0 \/w/);
  assert.equal(worktreeRemovalHint("fatal: '/w' is not a working tree", "/w"), null);
});

const rootless = process.platform === "linux" && process.getuid?.() !== 0
  && spawnSync("podman", ["unshare", "true"], { stdio: "ignore" }).status === 0;
test("reclaimSandboxOwnership on real rootless Podman: a subordinate-owned 1755 directory becomes the host user's and can be deleted", { skip: !rootless && "needs rootless Podman on Linux" }, (t) => {
  const dir = tmp(t);
  const mount = path.join(dir, SANDBOX_SKILLS_MOUNT);
  // What the container runtime leaves: owned by container root, which is the first subordinate id outside.
  assert.equal(spawnSync("podman", ["unshare", "sh", "-c", `mkdir -p '${mount}' && chown -R 1:1 '${path.join(dir, ".openclaw")}' && chmod 1755 '${mount}'`]).status, 0);
  t.after(() => spawnSync("podman", ["unshare", "rm", "-rf", dir]));
  assert.notEqual(fs.statSync(mount).uid, process.getuid());
  const result = reclaimSandboxOwnership(dir);
  assert.equal(result.error, null);
  assert.deepEqual(result.reclaimed, [path.join(dir, ".openclaw")]);
  assert.equal(spawnSync("find", [dir, "!", "-user", String(process.getuid())], { encoding: "utf8" }).stdout, "");
  fs.rmSync(dir, { recursive: true });
  assert.equal(fs.existsSync(dir), false);
});
