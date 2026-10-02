import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { pickMutants, runMutants } from "../lib/mutation.mjs";
import { createVerificationFlow, planProductionRevert, restoreWorkerVersion, revertToBase } from "../lib/verification-flow.mjs";

const SENTINEL = "sentinel-untouched\n";

function temp(t, prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
}

async function revertRepo(t, files) {
  const dir = temp(t, "nomarmy-write-");
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "t"]);
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  return { dir, baseSha: git(dir, ["rev-parse", "HEAD"]).trim() };
}

test("mutation restore refuses a symlink swapped in during verify and leaves the sentinel untouched", async (t) => {
  const root = temp(t, "nomarmy-mut-");
  const outside = temp(t, "nomarmy-out-");
  const target = path.join(root, "src", "pay.js");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "if (a < b) pay();\n");
  const sentinel = path.join(outside, "authorized_keys");
  fs.writeFileSync(sentinel, SENTINEL);
  const mutants = pickMutants([{ path: "src/pay.js", full: target, lines: [1] }], 1);
  const result = await runMutants({
    mutants, root, verify: async () => {
      fs.rmSync(target);
      fs.symlinkSync(sentinel, target);
      return { status: "fail" };
    },
  });
  assert.equal(result.status, "restore_failed");
  assert.match(result.reason, /refusing symlink/);
  assert.equal(fs.readFileSync(sentinel, "utf8"), SENTINEL);
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(Object.keys(result).sort(), ["inconclusive", "killed", "reason", "skipped", "status", "survived", "tried"]);
});

test("mutation restore refuses a symlinked parent and leaves the sentinel untouched", async (t) => {
  const root = temp(t, "nomarmy-mut-");
  const outside = temp(t, "nomarmy-out-");
  const src = path.join(root, "src");
  const target = path.join(src, "pay.js");
  fs.mkdirSync(src);
  fs.writeFileSync(target, "if (a < b) pay();\n");
  const sentinel = path.join(outside, "pay.js");
  fs.writeFileSync(sentinel, SENTINEL);
  const mutants = pickMutants([{ path: "src/pay.js", full: target, lines: [1] }], 1);
  const result = await runMutants({
    mutants, root, verify: async () => {
      fs.rmSync(src, { recursive: true });
      fs.symlinkSync(outside, src);
      return { status: "fail" };
    },
  });
  assert.equal(result.status, "restore_failed");
  assert.match(result.reason, /refusing symlinked parent/);
  assert.equal(fs.readFileSync(sentinel, "utf8"), SENTINEL);
  assert.equal(fs.lstatSync(src).isSymbolicLink(), true);
});

test("mutation restore of a regular file still writes the worker bytes back", async (t) => {
  const root = temp(t, "nomarmy-mut-");
  const target = path.join(root, "pay.js");
  fs.writeFileSync(target, "if (a < b) pay();\n");
  const before = fs.readFileSync(target);
  const mutants = pickMutants([{ path: "pay.js", full: target, lines: [1] }], 1);
  const result = await runMutants({ mutants, root, verify: async () => ({ status: "fail" }) });
  assert.equal(result.status, "pass");
  assert.equal(result.killed, 1);
  assert.equal(result.reason, null);
  assert.ok(fs.readFileSync(target).equals(before));
});

test("revert-check restore refuses a symlink swapped in during verify and leaves the sentinel untouched", async (t) => {
  const { dir, baseSha } = await revertRepo(t, { "src/pay.js": "export const pay = (n) => n;\n" });
  const outside = temp(t, "nomarmy-out-");
  const target = path.join(dir, "src", "pay.js");
  const sentinel = path.join(outside, "authorized_keys");
  fs.writeFileSync(sentinel, SENTINEL);
  fs.writeFileSync(target, "export const pay = (n) => n + 1;\n");
  const flow = createVerificationFlow({ collectGitRecord: async () => ({}) });
  flow.registerVerificationRunner(async () => {
    fs.rmSync(target);
    fs.symlinkSync(sentinel, target);
    return { status: "fail" };
  });
  const result = await flow.runRegressionCheck({
    cwd: dir, jobId: "job", productionFiles: ["src/pay.js"], baseSha, branch: null, mode: "implement", profile: "quick",
    nameStatus: [{ status: "M", path: "src/pay.js", oldPath: null }],
  });
  assert.equal(result.status, "restore_failed");
  assert.equal(result.basis, "restore-error");
  assert.match(result.reason, /refusing symlink/);
  assert.equal(result.detail, null);
  assert.equal(fs.readFileSync(sentinel, "utf8"), SENTINEL);
  assert.deepEqual(Object.keys(result).sort(), ["basis", "detail", "rawRerunStatus", "reason", "status"]);
});

test("revert-check restore refuses a symlinked parent and leaves the sentinel untouched", async (t) => {
  const { dir, baseSha } = await revertRepo(t, { "src/pay.js": "export const pay = (n) => n;\n" });
  const outside = temp(t, "nomarmy-out-");
  const src = path.join(dir, "src");
  const sentinel = path.join(outside, "pay.js");
  fs.writeFileSync(sentinel, SENTINEL);
  fs.writeFileSync(path.join(src, "pay.js"), "export const pay = (n) => n + 1;\n");
  const flow = createVerificationFlow({ collectGitRecord: async () => ({}) });
  flow.registerVerificationRunner(async () => {
    fs.rmSync(src, { recursive: true });
    fs.symlinkSync(outside, src);
    return { status: "fail" };
  });
  const result = await flow.runRegressionCheck({
    cwd: dir, jobId: "job", productionFiles: ["src/pay.js"], baseSha, branch: null, mode: "implement", profile: "quick",
    nameStatus: [{ status: "M", path: "src/pay.js", oldPath: null }],
  });
  assert.equal(result.status, "restore_failed");
  assert.match(result.reason, /refusing symlinked parent/);
  assert.equal(fs.readFileSync(sentinel, "utf8"), SENTINEL);
});

test("revert and restore of a regular file still round-trip", async (t) => {
  const { dir, baseSha } = await revertRepo(t, { "src/pay.js": "original\n" });
  const target = path.join(dir, "src", "pay.js");
  fs.writeFileSync(target, "changed\n");
  const [item] = planProductionRevert({ cwd: dir, baseSha, entries: [{ status: "M", path: "src/pay.js", oldPath: null }] });
  assert.equal(item.root, dir);
  revertToBase(item);
  assert.equal(fs.readFileSync(target, "utf8"), "original\n");
  restoreWorkerVersion(item);
  assert.equal(fs.readFileSync(target, "utf8"), "changed\n");
  assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
});
