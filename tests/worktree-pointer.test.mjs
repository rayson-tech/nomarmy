import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createExecutor } from "../lib/execute.mjs";
import { createProcess } from "../lib/process.mjs";
import { snapshotRetainedWork } from "../lib/continue-from.mjs";
import { captureWorktreePointer, gitHooksPath, registerWorktreePointer, sealWorktree } from "../lib/worktree-pointer.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
}

function repoWithWorktree(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-pointer-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const dir = path.join(root, "repo");
  const worktree = path.join(root, "worktree");
  fs.mkdirSync(dir);
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "t"]);
  git(dir, ["config", "gc.auto", "0"]);
  fs.writeFileSync(path.join(dir, "pay.js"), "export const pay = (n) => n;\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  const baseSha = git(dir, ["rev-parse", "HEAD"]).trim();
  git(dir, ["worktree", "add", "-q", "-b", "agent/job", worktree, baseSha]);
  return { root, dir, worktree, baseSha };
}

// The review's input: `.git` rewritten to `gitdir: ./evil.git`, a clean filter,
// and `* filter=pwn`. The marker is a temp path standing in for /tmp/pwn.
function plantEvilGit(worktree, marker) {
  const evil = path.join(worktree, "evil.git");
  fs.mkdirSync(path.join(evil, "objects"), { recursive: true });
  fs.mkdirSync(path.join(evil, "refs", "heads"), { recursive: true });
  fs.writeFileSync(path.join(evil, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(evil, "config"), `[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n[filter "pwn"]\n\tclean = id > ${marker}\n\tsmudge = cat\n`);
  fs.writeFileSync(path.join(worktree, ".gitattributes"), "* filter=pwn\n");
  fs.writeFileSync(path.join(worktree, "payload.txt"), "pwn\n");
  fs.rmSync(path.join(worktree, ".git"));
  fs.writeFileSync(path.join(worktree, ".git"), "gitdir: ./evil.git\n");
}

test("evil.git filter pointer fails closed and the marker file is never created", async (t) => {
  const { dir, worktree } = repoWithWorktree(t);
  const marker = path.join(dir, "pwn-marker");
  const bytes = captureWorktreePointer(worktree);
  registerWorktreePointer(worktree, { expectedBytes: bytes, repoRoot: dir });
  plantEvilGit(worktree, marker);
  const { run } = createProcess({ projectDir: dir });
  await assert.rejects(() => run("git", ["add", "-A"], { cwd: worktree }), /worktree Git pointer integrity failure: bytes mismatch/);
  assert.equal(fs.existsSync(marker), false);
});

test("a symlinked .git fails closed before git runs", async (t) => {
  const { dir, worktree } = repoWithWorktree(t);
  const bytes = captureWorktreePointer(worktree);
  registerWorktreePointer(worktree, { expectedBytes: bytes, repoRoot: dir });
  const dotGit = path.join(worktree, ".git");
  const copy = path.join(worktree, "pointer-copy");
  fs.copyFileSync(dotGit, copy);
  fs.rmSync(dotGit);
  fs.symlinkSync(copy, dotGit);
  const { run } = createProcess({ projectDir: dir });
  await assert.rejects(() => run("git", ["status", "--porcelain"], { cwd: worktree }), /worktree Git pointer integrity failure: symlink/);
  assert.equal(fs.lstatSync(dotGit).isSymbolicLink(), true);
});

test("an untouched pointer passes and host git runs with hooks disabled", async (t) => {
  const { dir, worktree } = repoWithWorktree(t);
  const sealed = sealWorktree(worktree, dir);
  assert.equal(sealed.kind, "file");
  assert.equal(Buffer.from(sealed.bytes, "base64").equals(fs.readFileSync(path.join(worktree, ".git"))), true);
  const { run } = createProcess({ projectDir: dir });
  const status = await run("git", ["status", "--porcelain"], { cwd: worktree });
  assert.equal(status.stdout, "");
  const hooks = await run("git", ["config", "--get", "core.hooksPath"], { cwd: worktree });
  assert.equal(hooks.stdout, gitHooksPath());
  await run("git", ["config", "alias.showsys", "!printf %s \"$GIT_CONFIG_NOSYSTEM\""], { cwd: worktree });
  const shown = await run("git", ["showsys"], { cwd: worktree });
  assert.equal(shown.stdout, "1");
});

test("continue_from with a tampered pointer fails closed and runs no git", async (t) => {
  const { dir, worktree, baseSha } = repoWithWorktree(t);
  const marker = path.join(dir, "pwn-marker");
  const expected = captureWorktreePointer(worktree);
  plantEvilGit(worktree, marker);
  let gitCalls = 0;
  const injected = async (args, opts = {}) => {
    gitCalls += 1;
    return execFileSync("git", args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] }).toString();
  };
  await assert.rejects(
    () => snapshotRetainedWork({ worktree, baseSha, jobId: "old-job", git: injected, repoRoot: dir, expectedPointer: expected }),
    /worktree Git pointer integrity failure: bytes mismatch/,
  );
  assert.equal(gitCalls, 0);
  assert.equal(fs.existsSync(marker), false);
});

test("continue_from through executeJob fails closed on a tampered retained pointer and records why", async (t) => {
  const { root, dir, worktree, baseSha } = repoWithWorktree(t);
  const marker = path.join(dir, "pwn-marker");
  const bytes = captureWorktreePointer(worktree);
  const jobsRoot = path.join(root, "jobs");
  const oldDir = path.join(jobsRoot, "worker-old");
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, "metadata.json"), JSON.stringify({
    mode: "implement", projectDir: dir, worktree, branch: "agent/job", git: { baseSha },
    commit: { created: false, sha: null },
    worktreePointerBefore: { applicable: true, exists: true, kind: "file", bytes: bytes.toString("base64") },
  }));
  plantEvilGit(worktree, marker);
  let workerStarted = false;
  const { run, git: gitFn, gitRaw } = createProcess({ projectDir: dir });
  const executor = createExecutor({
    VERSION: "test", projectDir: dir, jobsRoot, run, git: gitFn, gitRaw,
    collectGitRecord: async () => { throw new Error("git record should not run"); },
    createCoordinatorCommit: async () => { throw new Error("commit should not run"); },
    ensureJobsRoot: () => jobsRoot,
    slug: () => "new-job",
    assertRepo: async () => {},
    resolveBase: async (ref) => ({ ref, sha: ref }),
    sweepStaleSandboxContainers: async () => {},
    runOpenClaw: async () => { workerStarted = true; throw new Error("worker should not start"); },
    verificationFlow: {},
    normalizeVerification: (value) => value,
    runIndependentVerification: async () => { throw new Error("verify should not run"); },
    runRegressionCheck: async () => { throw new Error("regression should not run"); },
    repoPolicy: () => ({}),
    workerModelThinkingSupported: () => false,
    budgetState: { budgets: {} },
    execution: {},
    buildMetrics: () => ({}),
    resolveReasoningApplied: () => null,
    recordedBudgets: () => ({}),
  });
  const result = await executor.executeJob({ task: "fix", mode: "implement", continueFrom: "worker-old", jobId: "new-job" });
  assert.equal(result.ok, false);
  assert.equal(result.manifest.outcome, "WORKER_FAILED");
  assert.equal(result.manifest.coordinatorStatus, "failed");
  assert.match(result.manifest.error, /worktree Git pointer integrity failure: bytes mismatch/);
  assert.equal(workerStarted, false);
  assert.equal(fs.existsSync(marker), false);
  const failure = JSON.parse(fs.readFileSync(path.join(result.jobDir, "failure.json"), "utf8"));
  assert.equal(failure.outcome, "WORKER_FAILED");
  assert.match(failure.error, /worktree Git pointer integrity failure: bytes mismatch/);
  assert.deepEqual(Object.keys(failure).sort(), ["branch", "coordinatorStatus", "error", "execution", "jobId", "mode", "outcome", "retained", "version", "workerId", "worktree", "worktreeRetained"].sort());
});
