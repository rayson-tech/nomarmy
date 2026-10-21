import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitDiff, diffFor, patchText, resolveCommit } from "../lib/commit-diff.mjs";
import { prepareReferences, placeReferences, referenceNote, REFERENCE_DIR } from "../lib/reference-commits.mjs";
import { isRuntimeJunk } from "../lib/git-record.mjs";

function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "refcommits-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const g = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@example.com"); g("config", "user.name", "T"); g("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "a.js"), "export const a = 1;\n");
  g("add", "."); g("commit", "-q", "-m", "root");
  const root = g("rev-parse", "HEAD");
  fs.writeFileSync(path.join(dir, "a.js"), "export const a = 2;\n");
  fs.writeFileSync(path.join(dir, "b.js"), "export const b = 'x'.repeat(10);\n");
  g("add", "."); g("commit", "-q", "-m", "Reviewed change", "-m", "Body line.");
  const head = g("rev-parse", "HEAD");
  const git = async (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  return { dir, git, root, head };
}
const noSecrets = async () => [];

test("commitDiff: one commit against its parent, with its message, file stats and the patch", async (t) => {
  const r = repo(t);
  const shown = await commitDiff({ git: r.git, ref: r.head.slice(0, 9), scan: noSecrets });
  assert.equal(shown.sha, r.head);
  assert.equal(shown.base, r.root);
  assert.match(shown.header, /^commit [0-9a-f]{40}\nAuthor: T\n/);
  assert.match(shown.header, /Reviewed change\n\nBody line\./);
  assert.deepEqual(shown.files.map((f) => [f.path, f.additions, f.deletions]), [["a.js", 1, 1], ["b.js", 1, 0]]);
  assert.match(shown.diff, /-export const a = 1;\n\+export const a = 2;/);
  assert.equal(shown.truncated, false);
  // The root commit is compared with the empty tree.
  const root = await commitDiff({ git: r.git, ref: r.root, scan: noSecrets });
  assert.deepEqual(root.files.map((f) => f.path), ["a.js"]);
});

test("commitDiff: a base gives a range diff, paths narrow it, and the size cap lists what it left out", async (t) => {
  const r = repo(t);
  const ranged = await commitDiff({ git: r.git, ref: "main", base: r.root, paths: ["b.js"], scan: noSecrets });
  assert.equal(ranged.header, null);
  assert.deepEqual(ranged.files.map((f) => f.path), ["b.js"]);
  const capped = await commitDiff({ git: r.git, ref: r.head, maxBytes: 200, scan: noSecrets });
  assert.equal(capped.truncated, true);
  assert.ok(capped.notShown.length >= 1);
  assert.match(patchText(capped), /# not included .*: over the size cap/);
});

test("commitDiff: a file whose diff matches a secret rule is withheld whole and named, never shown", async (t) => {
  const r = repo(t);
  const scan = async (text, file) => file === "b.js" ? ["aws-access-key"] : [];
  const shown = await commitDiff({ git: r.git, ref: r.head, scan });
  assert.deepEqual(shown.withheld, [{ path: "b.js", rules: ["aws-access-key"] }]);
  assert.equal(shown.diff.includes("b.js"), false);
  assert.match(patchText(shown), /# withheld b\.js: it matches a secret rule \(aws-access-key\)/);
});

test("resolveCommit: refuses anything that isn't a commit in this repository", async (t) => {
  const r = repo(t);
  assert.equal(await resolveCommit(r.git, r.head.slice(0, 7)), r.head);
  await assert.rejects(resolveCommit(r.git, "deadbeef"), /"deadbeef" is not a commit in this repository/);
  await assert.rejects(resolveCommit(r.git, "HEAD:a.js"), /is not a commit/);
});

test("reference_commits: patches are made once in the job directory, placed under .openclaw/ (never committed), and named in the brief", async (t) => {
  const r = repo(t);
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "refjob-"));
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "refwt-"));
  t.after(() => { fs.rmSync(jobDir, { recursive: true, force: true }); fs.rmSync(worktree, { recursive: true, force: true }); });
  const written = await prepareReferences({ items: [{ ref: r.head.slice(0, 8) }], jobDir, diff: (ref) => commitDiff({ git: r.git, ref, scan: noSecrets }) });
  assert.deepEqual(written, [{ ref: r.head.slice(0, 8), sha: r.head, file: `${r.head.slice(0, 12)}.patch`, subject: "Reviewed change", files: 2 }]);
  const placed = placeReferences({ jobDir, worktree });
  assert.deepEqual(placed, written);
  const patch = fs.readFileSync(path.join(worktree, REFERENCE_DIR, written[0].file), "utf8");
  assert.match(patch, /^# commit [0-9a-f]{40}/);
  assert.match(patch, /\+export const a = 2;/);
  assert.equal(isRuntimeJunk(`${REFERENCE_DIR}/${written[0].file}`), true, "never part of the job's commit");
  const note = referenceNote(placed);
  assert.match(note, new RegExp(`- \\.openclaw/reference/${written[0].file}: commit ${r.head.slice(0, 12)} "Reviewed change" \\(2 files\\)`));
  assert.match(note, /make the same change to the current files/);
  // A job without references places nothing and adds nothing to the brief.
  assert.deepEqual(placeReferences({ jobDir: worktree, worktree }), []);
  assert.equal(referenceNote([]), "");
});

function jobRecord(jobsRoot, record) {
  fs.mkdirSync(path.join(jobsRoot, record.jobId), { recursive: true });
  fs.writeFileSync(path.join(jobsRoot, record.jobId, "metadata.json"), JSON.stringify(record));
}

test("a job id resolves to that job's change against its base: its commit, or its retained worktree's uncommitted work", async (t) => {
  const r = repo(t);
  const jobsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "refjobs-"));
  t.after(() => fs.rmSync(jobsRoot, { recursive: true, force: true }));
  const gitIn = (cwd) => async (args) => execFileSync("git", args, { cwd, encoding: "utf8" });
  // BASE-112: the reviewed job's commit lives only on its local agent/<job> branch.
  jobRecord(jobsRoot, { jobId: "worker-1", outcome: "WORKER_DONE", branch: "agent/worker-1", git: { baseSha: r.root }, commit: { created: true, sha: r.head } });
  const committed = await diffFor({ ref: "worker-1", gitIn, projectDir: r.dir, jobsRoot, scan: noSecrets });
  assert.equal(committed.jobId, "worker-1");
  assert.equal(committed.base, r.root);
  assert.match(committed.header, /^job worker-1 \(WORKER_DONE\), commit [0-9a-f]{40} on agent\/worker-1, against its base/);
  assert.deepEqual(committed.files.map((f) => f.path), ["a.js", "b.js"]);
  // Held for review, never committed: the diff comes from its worktree, new files included, runtime files not.
  const worktree = path.join(jobsRoot, "wt");
  execFileSync("git", ["worktree", "add", "-q", "--detach", worktree, r.root], { cwd: r.dir });
  fs.writeFileSync(path.join(worktree, "a.js"), "export const a = 3;\n");
  fs.writeFileSync(path.join(worktree, "new.js"), "one\ntwo\n");
  fs.mkdirSync(path.join(worktree, ".openclaw")); fs.writeFileSync(path.join(worktree, ".openclaw", "x"), "junk");
  jobRecord(jobsRoot, { jobId: "worker-2", outcome: "NEEDS_REVIEW", worktree, git: { baseSha: r.root }, commit: { created: false, sha: null } });
  // A fresh process registers the job's worktree before running git in it (found live: refused otherwise).
  const registered = [];
  const held = await diffFor({ ref: "worker-2", gitIn, projectDir: r.dir, jobsRoot, scan: noSecrets, registerWorktree: (record) => registered.push(record.jobId) });
  assert.deepEqual(registered, ["worker-2"]);
  assert.equal(held.sha, null);
  assert.match(held.header, /uncommitted changes in its retained worktree/);
  assert.deepEqual(held.files.map((f) => [f.path, f.additions]), [["a.js", 1], ["new.js", 2]]);
  assert.match(held.diff, /\+export const a = 3;/);
  assert.match(held.diff, /\+\+\+ b\/new\.js\n@@ -0,0 \+1,2 @@\n\+one\n\+two/);
  jobRecord(jobsRoot, { jobId: "worker-3", outcome: "WORKER_FAILED", git: { baseSha: r.root }, commit: { created: false } });
  await assert.rejects(diffFor({ ref: "worker-3", gitIn, projectDir: r.dir, jobsRoot, scan: noSecrets }), /made no commit and its worktree is gone/);
  // Anything that isn't a job id is a commit.
  assert.equal((await diffFor({ ref: r.head, gitIn, projectDir: r.dir, jobsRoot, scan: noSecrets })).sha, r.head);
});

test("a review scout's patch is named for the reviewed job and tells it to review against the patch", () => {
  const note = referenceNote([{ ref: "worker-1", sha: "a".repeat(40), jobId: "worker-1", review: true, file: "reviewed-worker-1.patch", subject: null, files: 3, truncated: true }]);
  assert.match(note, /reviewed-worker-1\.patch: the change you are reviewing, job worker-1 \(commit aaaaaaaaaaaa\), against its base \(3 files, TRUNCATED: see the file's header\)/);
  assert.match(note, /Review against the patch/);
  assert.equal(note.includes("rebuild a change"), false);
  assert.match(patchText({ header: "h", base: "b", sha: "s", truncated: true, notShown: ["big.js"], withheld: [], diff: "" }), /# TRUNCATED: 1 file\(s\) over the size cap are not included; pass paths to narrow it/);
});
