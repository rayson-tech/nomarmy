import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as pointer from "../lib/worktree-pointer.mjs";
import { createProcess } from "../lib/process.mjs";
import { createExecutor } from "../lib/execute.mjs";
import { createJobRuntime } from "../lib/admission.mjs";
import { planProductionRevert } from "../lib/verification-flow.mjs";
import { pickMutants, runMutants } from "../lib/mutation.mjs";
import { nodeDependencyFiles, repairHostInstalls } from "../lib/sandbox-images.mjs";
import { snapshotRetainedWork } from "../lib/continue-from.mjs";
import { plantWorktreePointer } from "./helpers/worktree-fixture.mjs";

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-escape-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repoRoot = path.join(root, "repo"), jobsRoot = path.join(root, "jobs");
  const jobDir = path.join(jobsRoot, "job"), worktree = path.join(jobDir, "worktree");
  const { gitdir, bytes } = plantWorktreePointer(worktree, repoRoot);
  const proc = createProcess({ projectDir: repoRoot, jobsRoot });
  return { root, repoRoot, jobsRoot, jobDir, worktree, gitdir, bytes, ...proc };
}
function evil(f) {
  const evilDir = path.join(f.worktree, "evil.git"), marker = path.join(f.root, "marker");
  const monitor = path.join(f.root, "monitor.sh");
  fs.writeFileSync(monitor, `#!/bin/sh\nprintf pwn > '${marker}'\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(evilDir, "objects"), { recursive: true });
  fs.mkdirSync(path.join(evilDir, "refs"));
  fs.writeFileSync(path.join(evilDir, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(evilDir, "config"), `[core]\nrepositoryformatversion = 0\nbare = false\nfsmonitor = ${monitor}\n`);
  return { marker, swap: () => fs.writeFileSync(path.join(f.worktree, ".git"), `gitdir: ${evilDir}\n`) };
}
function patchBuiltin(t, object, name, fn) {
  const original = object[name]; object[name] = fn(original); syncBuiltinESMExports();
  t.after(() => { object[name] = original; syncBuiltinESMExports(); });
}

test("jobs root and unknown descendants fail closed after registry loss", async t => {
  const f = fixture(t);
  const nested = path.join(f.worktree, "src"); fs.mkdirSync(nested);
  for (const cwd of [f.jobsRoot, f.worktree, nested]) {
    await assert.rejects(f.run("git", ["status", "--porcelain"], { cwd }), /worktree Git pointer integrity failure: unregistered worktree/);
  }
  assert.equal(pointer.prepareHostGit(f.repoRoot), null);
});

test("registered descendants pin recorded gitdir and worktree with exact safety flags", t => {
  const f = fixture(t); pointer.sealWorktree(f.worktree, f.repoRoot);
  const nested = path.join(f.worktree, "src"); fs.mkdirSync(nested);
  const prep = pointer.prepareHostGit(nested, ["status"]);
  assert.deepEqual(Object.keys(prep).sort(), ["argsPrefix", "env"]);
  assert.deepEqual(prep.argsPrefix, ["-c", `core.hooksPath=${pointer.gitHooksPath()}`, "-c", "core.fsmonitor=false", `--git-dir=${f.gitdir}`, `--work-tree=${f.worktree}`, "--no-optional-locks"]);
  assert.deepEqual(prep.env({ SAFE: "yes" }), { SAFE: "yes", GIT_CONFIG_NOSYSTEM: "1" });
});

test("pointer swapped at spawn cannot execute planted fsmonitor and next call flags tampering", async t => {
  const f = fixture(t); pointer.sealWorktree(f.worktree, f.repoRoot);
  const attack = evil(f);
  patchBuiltin(t, childProcess, "spawn", original => (...args) => { attack.swap(); return original(...args); });
  await f.run("git", ["status", "--porcelain"], { cwd: f.worktree });
  assert.equal(fs.existsSync(attack.marker), false);
  await assert.rejects(f.run("git", ["status"], { cwd: f.worktree }), /integrity failure: bytes mismatch/);
});

test("lockfile discovery refuses a changed pointer before synchronous Git", t => {
  const f = fixture(t); pointer.sealWorktree(f.worktree, f.repoRoot);
  const attack = evil(f); attack.swap();
  assert.throws(() => nodeDependencyFiles(f.worktree), /integrity failure: bytes mismatch/);
  assert.equal(fs.existsSync(attack.marker), false);
});

test("live progress re-registers stored bytes after restart and flags missing bytes", async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.jobDir, "status.json"), JSON.stringify({ worktreePointerBefore: { bytes: f.bytes } }));
  fs.writeFileSync(path.join(f.jobDir, "metadata.json"), JSON.stringify({ worktree: f.worktree }));
  const runtime = createJobRuntime({ projectDir: f.repoRoot, jobsRoot: f.jobsRoot, run: async (_cmd, args, opts) => {
    const prep = pointer.prepareHostGit(opts.cwd, args);
    assert.equal(prep.argsPrefix.includes(`--git-dir=${f.gitdir}`), true);
    return { stdout: "" };
  } });
  assert.deepEqual(await runtime.liveProgress(f.jobDir), { filesChangedLive: 0 });
  const other = fixture(t);
  const noRecord = createJobRuntime({ projectDir: other.repoRoot, jobsRoot: other.jobsRoot, run: async () => assert.fail("must not run git") });
  assert.deepEqual(await noRecord.liveProgress(other.jobDir), { worktreeIntegrityError: "worktree Git pointer integrity failure: no recorded pointer bytes" });
});

test("continuation restores registration from recorded bytes and pins every injected Git call", async t => {
  const f = fixture(t); const calls = [];
  const result = await snapshotRetainedWork({ worktree: f.worktree, repoRoot: f.repoRoot, expectedPointer: f.bytes, baseSha: "base", jobId: "old", git: async (args, opts) => {
    assert.equal(args.includes(`--git-dir=${f.gitdir}`), true);
    assert.equal(args.includes(`--work-tree=${f.worktree}`), true);
    assert.equal(opts.env.GIT_CONFIG_NOSYSTEM, "1"); calls.push(args);
    if (args.includes("write-tree")) return "tree";
    if (args.includes("commit-tree")) return "commit";
    return "";
  } });
  assert.deepEqual(result, { commit: "commit", files: [] });
  assert.equal(calls.length, 5);
  await assert.rejects(snapshotRetainedWork({ worktree: f.worktree, repoRoot: f.repoRoot, baseSha: "base", git: async () => assert.fail("must not run git") }), /no recorded pointer bytes/);
});

test("operator-cwd remove refuses a tampered registered target and retains it", async t => {
  const f = fixture(t); pointer.sealWorktree(f.worktree, f.repoRoot); evil(f).swap();
  let spawned = false;
  patchBuiltin(t, childProcess, "spawn", original => (...args) => { spawned = true; return original(...args); });
  await assert.rejects(f.run("git", ["worktree", "remove", "--force", f.worktree], { cwd: f.repoRoot }), /integrity failure: bytes mismatch/);
  assert.equal(spawned, false);
  assert.equal(fs.existsSync(f.worktree), true);
});

test("verify removal checks again after sandbox tampering and records retention", async t => {
  const f = fixture(t); const calls = [];
  const executor = createExecutor({ projectDir: f.repoRoot, jobsRoot: f.jobsRoot,
    assertRepo: async () => {}, ensureJobsRoot: () => f.jobsRoot, resolveBase: async () => ({ sha: "base", ref: "HEAD" }),
    collectGitRecord: async () => ({}), normalizeVerification: value => value,
    runIndependentVerification: async ({ cwd }) => { fs.writeFileSync(path.join(cwd, ".git"), "gitdir: evil.git\n"); return { status: "pass" }; },
    run: async (_cmd, args) => { calls.push(args); if (args[1] === "add") plantWorktreePointer(args[3], f.repoRoot); },
  });
  const result = await executor.executeJob({ task: "verify", mode: "verify", jobId: "verify" });
  assert.equal(result.manifest.worktreeRetained, true);
  assert.match(result.manifest.error, /integrity failure: bytes mismatch/);
  assert.deepEqual(calls, [["worktree", "add", "--detach", path.join(f.jobsRoot, "verify", "worktree"), "base"]]);
});

for (const parent of [false, true]) {
  function symlinkTarget(t) {
    const f = fixture(t), outside = path.join(f.root, "outside"); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "pay.js"), "if (secret < 4) leak();\n");
    const target = path.join(f.worktree, "src", "pay.js");
    if (parent) fs.symlinkSync(outside, path.dirname(target));
    else { fs.mkdirSync(path.dirname(target)); fs.symlinkSync(path.join(outside, "pay.js"), target); }
    return { ...f, target, outside };
  }
  test(`revert capture refuses symlink ${parent ? "parent" : "target"} without capturing host bytes`, t => {
    const f = symlinkTarget(t);
    assert.throws(() => planProductionRevert({ cwd: f.worktree, entries: [{ path: "src/pay.js", status: "A" }] }), /refusing symlink/);
    assert.equal(fs.readFileSync(path.join(f.outside, "pay.js"), "utf8"), "if (secret < 4) leak();\n");
  });
  test(`mutation capture refuses symlink ${parent ? "parent" : "target"} before any mutation`, async t => {
    const f = symlinkTarget(t);
    const result = await runMutants({ root: f.worktree, mutants: [{ full: f.target, path: "src/pay.js", mutated: "bad" }], verify: async () => assert.fail("must not verify") });
    assert.deepEqual(result, { killed: 0, survived: [], inconclusive: 0, tried: 0, skipped: 0, status: "restore_failed", reason: parent ? `refusing symlinked parent ${path.dirname(f.target)}` : `refusing symlink at ${f.target}` });
    assert.equal(fs.lstatSync(parent ? path.dirname(f.target) : f.target).isSymbolicLink(), true);
  });
  test(`mutant selection refuses symlink ${parent ? "parent" : "target"} reads`, t => {
    const f = symlinkTarget(t);
    assert.deepEqual(pickMutants([{ full: f.target, path: "src/pay.js", lines: [1] }], 2, f.worktree), []);
  });
}

test("host install repair skips and flags a symlinked package parent without deleting outside files", t => {
  const f = fixture(t), outside = path.join(f.root, "outside");
  fs.mkdirSync(path.join(outside, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(outside, "package.json"), "{}");
  fs.writeFileSync(path.join(outside, "package-lock.json"), "{}");
  fs.writeFileSync(path.join(outside, "node_modules", "sentinel"), "untouched");
  fs.symlinkSync(outside, path.join(f.worktree, "ui"));
  pointer.sealWorktree(f.worktree, f.repoRoot);
  patchBuiltin(t, childProcess, "execFileSync", () => (cmd, args) => {
    assert.equal(cmd, "git"); assert.equal(args.includes("ls-files"), true); return "ui/package-lock.json\0";
  });
  const result = repairHostInstalls(f.worktree, null, { ui: "link" });
  assert.deepEqual(result, [`ui/node_modules (refused: refusing symlinked parent ${f.worktree}/ui)`]);
  assert.equal(fs.readFileSync(path.join(outside, "node_modules", "sentinel"), "utf8"), "untouched");
  assert.equal(fs.lstatSync(path.join(f.worktree, "ui")).isSymbolicLink(), true);
});

test("cleanup after restart registers the job record before status or removal and refuses missing bytes", async t => {
  const f = fixture(t);
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const originalTool = McpServer.prototype.tool, handlers = {};
  McpServer.prototype.tool = function(name, ...args) { handlers[name] = args.at(-1); return originalTool.call(this, name, ...args); };
  const saved = { NOMARMY_PROJECT_DIR: process.env.NOMARMY_PROJECT_DIR, NOMARMY_AGENT_STATE: process.env.NOMARMY_AGENT_STATE };
  process.env.NOMARMY_PROJECT_DIR = f.repoRoot; process.env.NOMARMY_AGENT_STATE = f.root;
  try { await import(`../mcp/server.mjs?cleanup-security=${Date.now()}`); }
  finally {
    McpServer.prototype.tool = originalTool;
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  fs.writeFileSync(path.join(f.jobDir, "metadata.json"), JSON.stringify({ worktree: f.worktree, worktreePointerBefore: { bytes: f.bytes } }));
  const seen = [];
  patchBuiltin(t, childProcess, "spawn", original => (cmd, args, opts) => {
    if (cmd === "git" && args.includes("worktree") && args.includes("remove")) {
      const registered = pointer.registeredWorktree(f.worktree);
      assert.equal(registered?.expectedBytes.toString("base64"), f.bytes);
      seen.push("remove");
      // The process stand-in leaves the fixture intact for the refusal checks.
      return original(process.execPath, ["-e", ""], opts);
    }
    return original(cmd, args, opts);
  });
  await handlers.local_worker_cleanup({ job_id: "job", delete_branch: false, force: false });
  assert.deepEqual(seen, ["remove"]);
  fs.writeFileSync(path.join(f.jobDir, "metadata.json"), JSON.stringify({ worktree: f.worktree }));
  await assert.rejects(handlers.local_worker_cleanup({ job_id: "job", delete_branch: false, force: true }), /no recorded pointer bytes/);
  assert.deepEqual(seen, ["remove"]);
  assert.equal(fs.existsSync(f.worktree), true);
});
