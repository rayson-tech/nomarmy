import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { continuationProblem, continuationBase, snapshotRetainedWork, applyRetainedWork, continuationNote } from "../lib/continue-from.mjs";

const git = async (args, { cwd, env } = {}) => execFileSync("git", args, { cwd, env: env ?? process.env, stdio: ["ignore", "pipe", "pipe"] }).toString();

function repo(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-continue-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const dir = path.join(root, "repo");
  fs.mkdirSync(dir);
  const g = (...args) => execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  g("init", "-q"); g("config", "user.email", "t@example.com"); g("config", "user.name", "t"); g("config", "gc.auto", "0");
  fs.writeFileSync(path.join(dir, "math.js"), "export const add = (a, b) => a + b;\n");
  fs.writeFileSync(path.join(dir, "old.txt"), "to be deleted\n");
  fs.writeFileSync(path.join(dir, "keep.txt"), "untouched\n");
  g("add", "-A"); g("commit", "-qm", "base");
  return { root, dir, g, baseSha: g("rev-parse", "HEAD") };
}

test("snapshot and apply carry a retained worktree's modified, new and deleted files, and leave junk and the old worktree alone", async (t) => {
  const { root, dir, g, baseSha } = repo(t);
  const oldTree = path.join(root, "old-job"), newTree = path.join(root, "new-job");
  g("worktree", "add", "-q", "-b", "agent/old", oldTree, baseSha);
  fs.writeFileSync(path.join(oldTree, "math.js"), "export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n");
  fs.writeFileSync(path.join(oldTree, "math.test.js"), "// expects mul(2, 3) === 7 (the wrong number)\n");
  fs.rmSync(path.join(oldTree, "old.txt"));
  fs.mkdirSync(path.join(oldTree, ".npm")); fs.writeFileSync(path.join(oldTree, ".npm", "cache"), "junk\n");
  const statusBefore = await git(["status", "--porcelain"], { cwd: oldTree });

  const snapshot = await snapshotRetainedWork({ worktree: oldTree, baseSha, jobId: "old-job", git });
  assert.deepEqual(snapshot.files.sort(), ["math.js", "math.test.js", "old.txt"]);
  assert.equal(await git(["status", "--porcelain"], { cwd: oldTree }), statusBefore, "the retained worktree and its index are untouched");

  g("worktree", "add", "-q", "-b", "agent/new", newTree, baseSha);
  await applyRetainedWork({ worktree: newTree, baseSha, commit: snapshot.commit, git });
  assert.equal(fs.readFileSync(path.join(newTree, "math.js"), "utf8"), fs.readFileSync(path.join(oldTree, "math.js"), "utf8"));
  assert.ok(fs.existsSync(path.join(newTree, "math.test.js")));
  assert.equal(fs.existsSync(path.join(newTree, "old.txt")), false, "a deletion carries over");
  assert.equal(fs.existsSync(path.join(newTree, ".npm")), false, "runtime junk doesn't");
  assert.equal(fs.readFileSync(path.join(newTree, "keep.txt"), "utf8"), "untouched\n");
  // Uncommitted, index at the base: the new job's own record counts it all as its diff.
  assert.equal((await git(["rev-parse", "HEAD"], { cwd: newTree })).trim(), baseSha);
  assert.equal((await git(["diff", "--cached", "--name-only"], { cwd: newTree })).trim(), "");
  const status = (await git(["status", "--porcelain"], { cwd: newTree })).split("\n").filter(Boolean).map((l) => l.trim()).sort();
  assert.deepEqual(status, ["?? math.test.js", "D old.txt", "M math.js"]);
});

function retainedJob(t, overrides = {}) {
  const { root, dir, g, baseSha } = repo(t);
  const jobsRoot = path.join(root, "jobs"), jobDir = path.join(jobsRoot, "worker-old");
  const worktree = path.join(jobDir, "worktree");
  fs.mkdirSync(jobDir, { recursive: true });
  g("worktree", "add", "-q", "-b", "agent/worker-old", worktree, baseSha);
  const record = { mode: "implement", projectDir: dir, worktree, branch: "agent/worker-old", git: { baseSha },
    commit: { created: false, sha: null }, issues: ["worker reported partial"], ...overrides };
  fs.writeFileSync(path.join(jobDir, "metadata.json"), JSON.stringify(record));
  return { jobsRoot, projectDir: dir, baseSha, worktree };
}

test("continuationProblem accepts a retained, uncommitted implement job from this repo", (t) => {
  const job = retainedJob(t);
  const { problem, record } = continuationProblem({ continueFrom: "worker-old", jobsRoot: job.jobsRoot, projectDir: job.projectDir });
  assert.equal(problem, null);
  assert.equal(continuationBase(record), job.baseSha);
  assert.equal(record.worktree, job.worktree);
});

test("continuationProblem refuses what it can't honestly continue", (t) => {
  const job = retainedJob(t);
  const check = (args) => continuationProblem({ continueFrom: "worker-old", jobsRoot: job.jobsRoot, projectDir: job.projectDir, ...args }).problem;
  assert.match(check({ mode: "scout" }), /only an implement job/);
  assert.match(check({ baseRef: "main" }), /leave base_ref out/);
  assert.match(check({ isRunning: () => true }), /still running/);
  assert.match(check({ projectDir: "/elsewhere" }), /another repository/);
  assert.match(continuationProblem({ continueFrom: "nope", jobsRoot: job.jobsRoot, projectDir: job.projectDir }).problem, /no finished job/);
  assert.match(continuationProblem({ continueFrom: "../etc", jobsRoot: job.jobsRoot, projectDir: job.projectDir }).problem, /not a job id/);
  const committed = retainedJob(t, { commit: { created: true, sha: "abc" } });
  assert.match(continuationProblem({ continueFrom: "worker-old", jobsRoot: committed.jobsRoot, projectDir: committed.projectDir }).problem, /already committed on agent\/worker-old; start a new job with base_ref: "agent\/worker-old"/);
  fs.rmSync(job.worktree, { recursive: true, force: true });
  assert.match(check({}), /worktree is gone/);
});

test("continuationNote tells the worker to build on the carried work, and why it stopped", () => {
  const note = continuationNote({ continueFrom: "worker-old", record: { issues: ["worker reported partial"] }, files: ["math.js", "math.test.js"] });
  assert.match(note, /unfinished work of job worker-old \(2 file\(s\): math\.js, math\.test\.js\)/);
  assert.match(note, /Build on it; don't redo it/);
  assert.match(note, /- worker reported partial/);
});
