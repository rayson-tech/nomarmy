import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { restoreWorktree, snapshotWorktree } from "../lib/worktree-snapshot.mjs";
import { createVerificationRunner } from "../lib/verify.mjs";

function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-snapshot-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "a.txt"), "base a\n");
  fs.writeFileSync(path.join(dir, "b.txt"), "base b\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), "dist/\n");
  git("add", ".");
  git("commit", "-qm", "base");
  return dir;
}
const read = (dir, file) => fs.readFileSync(path.join(dir, file), "utf8");
const status = (dir) => execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: dir, encoding: "utf8" });

test("restoreWorktree undoes verification's writes and keeps the worker's changes", (t) => {
  const dir = repo(t);
  // The worker's changes: one edit, one new file, one deletion.
  fs.writeFileSync(path.join(dir, "a.txt"), "worker a\n");
  fs.writeFileSync(path.join(dir, "new.txt"), "worker new\n");
  fs.rmSync(path.join(dir, "b.txt"));
  const before = status(dir);
  const snapshot = snapshotWorktree(dir);

  // Verification: rewrites worker files, touches a clean file, adds fixtures and ignored output.
  fs.writeFileSync(path.join(dir, "a.txt"), "verification a\n");
  fs.writeFileSync(path.join(dir, "new.txt"), "verification new\n");
  fs.writeFileSync(path.join(dir, "b.txt"), "verification b\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), "changed\n");
  fs.mkdirSync(path.join(dir, ".tsbuild/deep"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".tsbuild/deep/x.tsbuildinfo"), "{}");
  fs.mkdirSync(path.join(dir, "dist"));
  fs.writeFileSync(path.join(dir, "dist/out.js"), "ignored");

  const restored = restoreWorktree(snapshot);
  assert.equal(status(dir), before);
  assert.equal(read(dir, "a.txt"), "worker a\n");
  assert.equal(read(dir, "new.txt"), "worker new\n");
  assert.equal(fs.existsSync(path.join(dir, "b.txt")), false);
  assert.equal(read(dir, ".gitignore"), "dist/\n");
  assert.equal(fs.existsSync(path.join(dir, ".tsbuild/deep/x.tsbuildinfo")), false);
  assert.equal(read(dir, "dist/out.js"), "ignored", "ignored output is never committed, so it stays");
  assert.deepEqual(restored.sort(), [".gitignore", ".tsbuild/deep/x.tsbuildinfo", "a.txt", "b.txt", "new.txt"]);
});

test("restoreWorktree puts back a worker change verification reverted to HEAD", (t) => {
  const dir = repo(t);
  fs.writeFileSync(path.join(dir, "a.txt"), "worker a\n");
  const snapshot = snapshotWorktree(dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "base a\n");
  assert.deepEqual(restoreWorktree(snapshot), ["a.txt"]);
  assert.equal(read(dir, "a.txt"), "worker a\n");
  assert.deepEqual(restoreWorktree(snapshotWorktree(dir)), [], "nothing changed, nothing restored");
});

test("snapshotWorktree is null outside a git work tree, and restoring null does nothing", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-snapshot-plain-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(snapshotWorktree(dir), null);
  assert.deepEqual(restoreWorktree(null), []);
});

test("the verification runner restores the worktree after its commands write in it", async (t) => {
  const dir = repo(t);
  fs.writeFileSync(path.join(dir, "a.txt"), "worker a\n");
  const executor = {
    async probe() { return { available: true, reason: null }; },
    async run({ cwd }) {
      fs.writeFileSync(path.join(cwd, "fixture.json"), "{}");
      fs.writeFileSync(path.join(cwd, "a.txt"), "clobbered\n");
      return { started: true, exitCode: 0, stdout: "ok\n", stderr: "", durationMs: 1, timedOut: false };
    },
  };
  const runner = createVerificationRunner({
    executor, loadVerificationNetwork: () => null, sandboxImageRun: () => "",
    loadConfig: () => ({ found: true, config: { verification: { unit: { commands: ["npm test"] } } } }),
  });
  const result = await runner({ cwd: dir, profile: "unit", jobId: "j1" });
  assert.equal(result.status, "pass", result.reason ?? result.detail);
  assert.equal(fs.existsSync(path.join(dir, "fixture.json")), false);
  assert.equal(read(dir, "a.txt"), "worker a\n");
});
