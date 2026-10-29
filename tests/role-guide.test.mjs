import "./helpers/isolate-global-config.mjs";
// Tests for role guides: a role's committed standing rules, attached to
// every brief for the role and to reviews of that role's work.
// Run: node --test tests/role-guide.test.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { armySchema, expandArmyRole } from "../lib/army.mjs";
import { guideSection, readRoleGuide, ROLE_GUIDE_MAX_CHARS } from "../lib/role-guide.mjs";
import { attachRoleGuides, expandJobs, reviewedJobRole } from "../mcp/server.mjs";

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-guide-"));
after(() => fs.rmSync(repo, { recursive: true, force: true }));
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
git("init", "-q");
git("config", "user.email", "test@example.com");
git("config", "user.name", "Test");
fs.mkdirSync(path.join(repo, ".nomarmy/roles"), { recursive: true });
fs.writeFileSync(path.join(repo, ".nomarmy/roles/ui-ux.md"), "Reuse components from ui/.\n");
git("add", ".");
git("commit", "-qm", "first");
const first = git("rev-parse", "HEAD");
fs.writeFileSync(path.join(repo, ".nomarmy/roles/ui-ux.md"), "Reuse components from ui/. Tokens live in styles.css.\n");
fs.writeFileSync(path.join(repo, ".nomarmy/roles/big.md"), "x".repeat(ROLE_GUIDE_MAX_CHARS + 50));
git("add", ".");
git("commit", "-qm", "second");

test("readRoleGuide reads the file at the given commit, not the working tree", () => {
  fs.writeFileSync(path.join(repo, ".nomarmy/roles/ui-ux.md"), "Edited in the worktree: anything goes.\n");
  assert.deepEqual(readRoleGuide({ projectDir: repo, ref: first, guidePath: ".nomarmy/roles/ui-ux.md" }), { text: "Reuse components from ui/.", truncated: false });
  assert.deepEqual(readRoleGuide({ projectDir: repo, ref: "HEAD", guidePath: ".nomarmy/roles/ui-ux.md" }), { text: "Reuse components from ui/. Tokens live in styles.css.", truncated: false });
  git("checkout", "-q", "--", ".");
});

test("readRoleGuide reports a missing or unsafe path and caps a long guide", () => {
  assert.deepEqual(readRoleGuide({ projectDir: repo, ref: first, guidePath: ".nomarmy/roles/big.md" }), { missing: true });
  assert.deepEqual(readRoleGuide({ projectDir: repo, ref: "HEAD", guidePath: "../outside.md" }), { missing: true });
  const big = readRoleGuide({ projectDir: repo, ref: "HEAD", guidePath: ".nomarmy/roles/big.md" });
  assert.equal(big.truncated, true);
  assert.equal(big.text.length, ROLE_GUIDE_MAX_CHARS);
});

test("guideSection names the file and commit, and says so when the guide is missing or truncated", () => {
  const sha = "a".repeat(40);
  assert.equal(guideSection({ heading: "Role guide", guidePath: "g.md", ref: sha, guide: { text: "Rules.", truncated: false } }), "## Role guide (g.md at aaaaaaaaaaaa; read-only)\nRules.");
  assert.match(guideSection({ heading: "Role guide", guidePath: "g.md", ref: "HEAD", guide: { text: "R", truncated: true } }), /Truncated at 12000 characters; read g\.md for the rest\./);
  assert.equal(guideSection({ heading: "Role guide", guidePath: "g.md", ref: "main", guide: { missing: true } }), "## Role guide\n(g.md was not found at main; follow the repository's existing conventions.)");
});

test("armySchema accepts a repository-relative .md guide and refuses anything else", () => {
  assert.equal(armySchema.safeParse({ roles: { "ui-ux": { agent: "codex", guide: ".nomarmy/roles/ui-ux.md" } } }).success, true);
  for (const guide of ["../ui-ux.md", "/etc/ui-ux.md", "roles/ui-ux.txt", "a/../../b.md", ""]) {
    assert.equal(armySchema.safeParse({ roles: { "ui-ux": { agent: "codex", guide } } }).success, false, guide);
  }
});

test("expandArmyRole carries the role's guide path; expandJobs appends it at base_ref and never forwards the field", () => {
  const army = { roles: { "ui-ux": { agent: "codex", phase: "build", guide: ".nomarmy/roles/ui-ux.md" } } };
  assert.equal(expandArmyRole({ task: "t", army_role: "ui-ux" }, army).roleGuide, ".nomarmy/roles/ui-ux.md");
  const reads = [];
  const { jobs, problems } = expandJobs([{ task: "Build the form.", army_role: "ui-ux", base_ref: "feat/x" }], {
    getArmy: () => ({ army }), getAgents: () => ({ codex: { kind: "api", provider: "openai", auth_env: "K", model: "gpt-6.1-sol" } }), getActiveRun: () => null,
    guides: { readGuide: (ref, guidePath) => { reads.push([ref, guidePath]); return { text: "Reuse components.", truncated: false }; }, reviewedJob: () => null },
  });
  assert.deepEqual(problems, []);
  assert.deepEqual(reads, [["feat/x", ".nomarmy/roles/ui-ux.md"]]);
  assert.match(jobs[0].task, /Build the form\.\n\n## Role guide \(\.nomarmy\/roles\/ui-ux\.md at feat\/x; read-only\)\nReuse components\.$/);
  assert.equal("roleGuide" in jobs[0], false);
});

test("a review scout gets the reviewed job's role guide, read at that job's base commit", () => {
  const roles = { "ui-ux": { guide: ".nomarmy/roles/ui-ux.md" }, "code-reviewer": { guide: ".nomarmy/roles/code-reviewer.md" } };
  const base = "b".repeat(40);
  const reads = [];
  const job = attachRoleGuides({ task: "Review it.", mode: "scout", reviews: "worker-1", roleGuide: ".nomarmy/roles/code-reviewer.md" }, () => roles, {
    readGuide: (ref, guidePath) => { reads.push([ref, guidePath]); return { text: `rules of ${guidePath}`, truncated: false }; },
    reviewedJob: (id) => (id === "worker-1" ? { role: "ui-ux", baseSha: base } : null),
  });
  assert.deepEqual(reads, [["HEAD", ".nomarmy/roles/code-reviewer.md"], [base, ".nomarmy/roles/ui-ux.md"]]);
  assert.match(job.task, /## Standards the reviewed work had to follow \(ui-ux guide\) \(\.nomarmy\/roles\/ui-ux\.md at bbbbbbbbbbbb; read-only\)\nrules of \.nomarmy\/roles\/ui-ux\.md$/);
});

test("a job without a guide is untouched, and a review of an unknown job or with no army adds nothing", () => {
  const plain = { task: "t", mode: "implement" };
  assert.equal(attachRoleGuides(plain, () => ({})), plain);
  const scout = { task: "t", mode: "scout", reviews: "gone" };
  assert.equal(attachRoleGuides(scout, () => { throw new Error("no army"); }, { reviewedJob: () => ({ role: "ui-ux", baseSha: "c".repeat(40) }) }), scout);
  assert.equal(attachRoleGuides(scout, () => ({}), { reviewedJob: () => null }), scout);
});

test("reviewedJobRole reads the role label and base commit from the job record", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-guide-jobs-"));
  try {
    fs.mkdirSync(path.join(root, "worker-1"));
    fs.writeFileSync(path.join(root, "worker-1", "metadata.json"), JSON.stringify({ labels: { role: "ui-ux" }, git: { baseSha: "d".repeat(40) } }));
    assert.deepEqual(reviewedJobRole("worker-1", root), { role: "ui-ux", baseSha: "d".repeat(40) });
    assert.equal(reviewedJobRole("missing", root), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
