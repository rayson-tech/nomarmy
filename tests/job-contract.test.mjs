import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadJobContract, contractAtBaseNote, CONTRACT_FROM_CHECKOUT } from "../lib/job-contract.mjs";
import { loadConfig } from "../lib/config.mjs";
import { createVerificationRunner } from "../lib/verify.mjs";

const profile = (commands) => `verification:\n  unit:\n    environment: none\n    commands:\n${commands.map((c) => `      - ${JSON.stringify(c)}\n`).join("")}`;
const OLD = ["node scripts/test.mjs"];
const NEW = ["node scripts/ci/quiet-test.mjs"];

// BASE-79's shape: the job's base has the old profile and no
// scripts/ci/quiet-test.mjs; the checkout has moved on to both.
function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "job-contract-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const g = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@example.com"); g("config", "user.name", "T"); g("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "README.md"), "x\n");
  g("add", "."); g("commit", "-q", "-m", "no contract yet");
  const bare = g("rev-parse", "HEAD");
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.writeFileSync(path.join(dir, "scripts", "test.mjs"), "");
  fs.writeFileSync(path.join(dir, ".nomarmy.yml"), profile(OLD));
  g("add", "."); g("commit", "-q", "-m", "old profile");
  const old = g("rev-parse", "HEAD");
  fs.mkdirSync(path.join(dir, "scripts", "ci"));
  fs.writeFileSync(path.join(dir, "scripts", "ci", "quiet-test.mjs"), "");
  fs.writeFileSync(path.join(dir, ".nomarmy.yml"), profile(NEW));
  g("add", "."); g("commit", "-q", "-m", "new profile");
  const head = g("rev-parse", "HEAD");
  const git = async (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  return { dir, git, g, bare, old, head };
}
const commandsOf = (picked) => picked.loaded.config.verification.unit.commands;

test("loadJobContract: an older base verifies with its own profile; the checkout's HEAD keeps the checkout's file, uncommitted edits included", async (t) => {
  const r = repo(t);
  const atBase = await loadJobContract({ projectDir: r.dir, baseSha: r.old, profile: "unit", git: r.git });
  assert.equal(atBase.source, "base");
  assert.deepEqual(commandsOf(atBase), OLD);
  assert.equal(atBase.note, null);
  fs.writeFileSync(path.join(r.dir, ".nomarmy.yml"), profile(["node scripts/ci/quiet-test.mjs --edited"]));
  const atHead = await loadJobContract({ projectDir: r.dir, baseSha: r.head, profile: "unit", git: r.git });
  assert.equal(atHead.source, "checkout");
  assert.deepEqual(commandsOf(atHead), ["node scripts/ci/quiet-test.mjs --edited"]);
  // No starting commit: today's behavior.
  assert.equal((await loadJobContract({ projectDir: r.dir, baseSha: null, profile: "unit", git: r.git })).source, "checkout");
});

test("loadJobContract: a base with no contract, or without the profile, falls back to the checkout's and says so", async (t) => {
  const r = repo(t);
  const none = await loadJobContract({ projectDir: r.dir, baseSha: r.bare, profile: "unit", git: r.git });
  assert.equal(none.source, "checkout");
  assert.deepEqual(commandsOf(none), NEW);
  assert.match(none.note, new RegExp(`^${CONTRACT_FROM_CHECKOUT}: base ${r.bare.slice(0, 12)} has no \\.nomarmy\\.yml`));
  const missing = await loadJobContract({ projectDir: r.dir, baseSha: r.old, profile: "e2e", git: r.git });
  assert.equal(missing.source, "checkout");
  assert.match(missing.note, new RegExp(`base ${r.old.slice(0, 12)} has no verification profile e2e`));
});

// Wired the way mcp/server.mjs registers it.
function runnerFor(r, executor) {
  return createVerificationRunner({ executor, loadConfig: async (cwd, context = {}) => {
    const { loaded, note } = await loadJobContract({ projectDir: r.dir, baseSha: context.baseSha ?? null, profile: context.profile ?? null, git: r.git });
    return note ? { ...loaded, contractNote: note } : loaded;
  } });
}
function worktreeAt(t, r, sha) {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "job-contract-wt-"));
  fs.rmSync(wt, { recursive: true });
  r.g("worktree", "add", "-q", "--detach", wt, sha);
  t.after(() => { try { r.g("worktree", "remove", "--force", wt); } catch { fs.rmSync(wt, { recursive: true, force: true }); } });
  return wt;
}
// Fails any command whose script isn't in the worktree, as node would.
function scriptExecutor() {
  const ran = [];
  return { ran, async probe() { return { available: true }; }, async run({ command, cwd }) {
    ran.push(command);
    const script = command.split(" ")[1];
    const ok = fs.existsSync(path.join(cwd, script));
    return { started: true, timedOut: false, exitCode: ok ? 0 : 1, stdout: "", stderr: ok ? "" : `Cannot find module '${script}'`, durationMs: 1 };
  } };
}

test("a continuation whose base lacks a script the current profile calls verifies with its own commit's profile and passes", async (t) => {
  const r = repo(t);
  const wt = worktreeAt(t, r, r.old);
  const executor = scriptExecutor();
  const record = {};
  const verdict = await runnerFor(r, executor)({ profile: "unit", cwd: wt, jobId: "j1", baseSha: r.old, mode: "implement", record });
  assert.equal(verdict.status, "pass", JSON.stringify(verdict));
  assert.deepEqual(executor.ran, OLD);
  assert.equal(record.issues, undefined);
});

test("a worker editing .nomarmy.yml in its diff still doesn't change the commands that run", async (t) => {
  const r = repo(t);
  const wt = worktreeAt(t, r, r.old);
  fs.writeFileSync(path.join(wt, ".nomarmy.yml"), profile(["node README.md"]));
  const executor = scriptExecutor();
  await runnerFor(r, executor)({ profile: "unit", cwd: wt, jobId: "j1", baseSha: r.old, mode: "implement", record: {} });
  assert.deepEqual(executor.ran, OLD);
  // At the checkout's HEAD, the operator's file, never the worktree's.
  const atHead = worktreeAt(t, r, r.head);
  fs.writeFileSync(path.join(atHead, ".nomarmy.yml"), profile(["node README.md"]));
  const second = scriptExecutor();
  await runnerFor(r, second)({ profile: "unit", cwd: atHead, jobId: "j2", baseSha: r.head, mode: "implement", record: {} });
  assert.deepEqual(second.ran, NEW);
});

test("a fallback to the checkout's contract is recorded on the job", async (t) => {
  const r = repo(t);
  const wt = worktreeAt(t, r, r.bare);
  const record = {};
  await runnerFor(r, scriptExecutor())({ profile: "unit", cwd: wt, jobId: "j1", baseSha: r.bare, mode: "implement", record });
  assert.equal(record.issues.length, 1);
  assert.match(record.issues[0], /^VERIFICATION CONTRACT FROM CHECKOUT: base [0-9a-f]{12} has no \.nomarmy\.yml/);
});

test("admission note: an older base whose profile differs from the checkout's, or lacks it", async (t) => {
  const r = repo(t);
  const differs = await contractAtBaseNote({ projectDir: r.dir, baseSha: r.old, profile: "unit", git: r.git, label: "This continuation of worker-1" });
  assert.match(differs, new RegExp(`^This continuation of worker-1 starts at ${r.old.slice(0, 12)}, whose verification profile unit differs from the checkout's: it verifies with ${r.old.slice(0, 12)}'s own commands\\. To verify against the current profile, redo it on the current head with reference_commits$`));
  const predates = await contractAtBaseNote({ projectDir: r.dir, baseSha: r.bare, profile: "unit", git: r.git, label: "This job" });
  assert.match(predates, /predates the current verification profile unit: it will verify with the checkout's commands, which may not match that commit's files\. Redo it on the current head with reference_commits instead$/);
  // Same profile at the base, the checkout's HEAD, or no profile: nothing to say.
  r.g("commit", "-q", "--allow-empty", "-m", "later");
  assert.equal(await contractAtBaseNote({ projectDir: r.dir, baseSha: r.head, profile: "unit", git: r.git, label: "x" }), null);
  assert.equal(await contractAtBaseNote({ projectDir: r.dir, baseSha: r.g("rev-parse", "HEAD"), profile: "unit", git: r.git, label: "x" }), null);
  assert.equal(await contractAtBaseNote({ projectDir: r.dir, baseSha: r.old, profile: null, git: r.git, label: "x" }), null);
  assert.ok(loadConfig(r.dir).found);
});
