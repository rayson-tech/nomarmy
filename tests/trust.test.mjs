import "./helpers/isolate-global-config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { validateConfig } from "../lib/config.mjs";
import { parseCodeowners, codeownersPaths, evaluateTrust } from "../lib/trust.mjs";
import { createExecutor } from "../lib/execute.mjs";
import { createVerificationFlow } from "../lib/verification-flow.mjs";
import { classifyTestChanges } from "../lib/diff-checks.mjs";
import { HIGH_STAKES_NOTE } from "../lib/outcome.mjs";

const normal = { level: "normal", reasons: [] };
const sensitive = (file, rule = 0, reason = "access control and tenant data") => ({
  rule, reason: `changes ${file}, which the repo marks sensitive: ${reason}`, file,
});
const ruleChange = (file) => ({ rule: "trust", reason: "changes the repository's trust rules", file });
const patch = (file, before, after) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,${before.length} +1,${after.length} @@\n${before.map((line) => `-${line}`).join("\n")}\n${after.map((line) => `+${line}`).join("\n")}\n`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".trust-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function write(root, file, content) {
  const full = path.join(root, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

test("trust schema accepts the floor and rejects malformed rules with index and reason", () => {
  const trust = { sensitive: [
    { paths: ["lambda/frontend_api/rls/**", "**/auth/**"], reason: "access control and tenant data" },
    { content: ["DROP TABLE", "TRUNCATE"], reason: "destructive SQL" },
    { paths: ["migrations/*"], content: ["DELETE"], reason: "mixed" },
  ], codeowners: true };
  assert.deepEqual(validateConfig({ trust }), { valid: true, config: {
    trust, environment_retention: { success: "destroy", failure: "logs", debug: "retain" },
  }, errors: [], elevated: { shared: [], remote: [] } });
  for (const bad of [
    { reason: "broken" }, { paths: [], reason: "broken" }, { content: [], reason: "broken" },
    { paths: [3], reason: "broken" }, { content: [false], reason: "broken" },
    { paths: ["/absolute"], reason: "broken" }, { paths: ["../escape"], reason: "broken" },
    { paths: ["auth\\**"], reason: "broken" }, { paths: ["**"], reason: "broken", extra: true },
  ]) {
    const result = validateConfig({ trust: { sensitive: [trust.sensitive[0], bad] } });
    assert.equal(result.valid, false);
    assert.deepEqual(Object.keys(result).sort(), ["config", "elevated", "errors", "valid"]);
    assert.equal(result.config, null);
    assert.equal(result.errors.every((error) => error.includes("trust.sensitive.1") && error.includes("broken")), true, result.errors.join("\n"));
  }
  assert.deepEqual(validateConfig({ trust: { sensitive: [{ paths: ["**"] }] } }).errors,
    ["trust.sensitive.0.reason: rule (missing reason): reason: is required"]);
  assert.deepEqual(validateConfig({ trust: { extra: true } }).errors, ['trust: unexpected field(s) "extra"']);
  assert.deepEqual(validateConfig({ trust: { codeowners: "yes" } }).errors,
    ["trust.codeowners: Invalid input: expected boolean, received string"]);
});

test("trust path globs span directories only with ** and normalize changed backslash paths", () => {
  const rules = [{ paths: ["lambda/frontend_api/rls/**", "**/auth/**"], reason: "access control and tenant data" }];
  for (const file of ["lambda/frontend_api/rls/access.py", "auth/check.py", "src/auth/nested/check.py"]) {
    assert.deepEqual(evaluateTrust({ rules, changedFiles: [file.replaceAll("/", "\\")] }), {
      level: "human", reasons: [sensitive(file)],
    });
  }
  const single = [{ paths: ["auth/*"], reason: "access control and tenant data" }];
  assert.deepEqual(evaluateTrust({ rules: single, changedFiles: ["auth/check.py"] }), { level: "human", reasons: [sensitive("auth/check.py")] });
  for (const file of ["auth/nested/check.py", "src/auth/check.py", "author/check.py"]) {
    assert.deepEqual(evaluateTrust({ rules: single, changedFiles: [file] }), normal);
  }
});

test("CODEOWNERS follows root anchoring, bare names, directories, wildcards and last-match ownership", () => {
  const codeowners = parseCodeowners(`\n # comment\n/root.txt @root\nREADME.md @docs\nlib/ @lib\n/docs/ @rootdocs\n**/auth/** @security @tenant # comment\n*.js @js\nprivate/*/key @keys\nREADME.md @last\nlib/public/\n!invalid @ignored\n[abc] @ignored\n\\#invalid @ignored\n{a,b}.txt @literal\n`);
  assert.deepEqual(codeowners.map(({ pattern, owners }) => ({ pattern, owners })), [
    { pattern: "/root.txt", owners: ["@root"] }, { pattern: "README.md", owners: ["@docs"] },
    { pattern: "lib/", owners: ["@lib"] }, { pattern: "/docs/", owners: ["@rootdocs"] },
    { pattern: "**/auth/**", owners: ["@security", "@tenant"] }, { pattern: "*.js", owners: ["@js"] },
    { pattern: "private/*/key", owners: ["@keys"] }, { pattern: "README.md", owners: ["@last"] },
    { pattern: "lib/public/", owners: [] }, { pattern: "{a,b}.txt", owners: ["@literal"] },
  ]);
  for (const rule of codeowners) assert.deepEqual(Object.keys(rule).sort(), ["matcher", "owners", "pattern"]);
  for (const [file, owners] of [
    ["root.txt", "@root"], ["README.md", "@last"], ["deep/README.md", "@last"],
    ["lib/nested/a.py", "@lib"], ["src/lib/a.py", "@lib"], ["docs/nested/a.md", "@rootdocs"],
    ["src/auth/a.py", "@security @tenant"], ["deep/a.js", "@js"], ["private/one/key", "@keys"], ["{a,b}.txt", "@literal"],
  ]) assert.deepEqual(evaluateTrust({ codeowners, changedFiles: [file] }), {
    level: "human", reasons: [{ rule: "codeowners", reason: `changes ${file}, owned in CODEOWNERS by ${owners}`, file }],
  });
  for (const file of ["src/root.txt", "src/docs/a.md", "lib", "private/a/b/key", "src/private/a/key", "lib/public/a.py", "a.txt"]) {
    assert.deepEqual(evaluateTrust({ codeowners, changedFiles: [file] }), normal);
  }
});

test("CODEOWNERS loading uses the first available file, including an empty first file", (t) => {
  const root = fixture(t);
  assert.deepEqual(codeownersPaths(root), []);
  for (const file of ["docs/CODEOWNERS", "CODEOWNERS", ".github/CODEOWNERS"]) {
    write(root, file, `** @${file}\n`);
    assert.deepEqual(codeownersPaths(root).map(({ owners }) => owners), [[`@${file}`]]);
  }
  write(root, ".github/CODEOWNERS", "# intentionally empty\n");
  assert.deepEqual(codeownersPaths(root), []);
});

test("content rules inspect added and removed lines, not context or file headers", () => {
  const rules = [{ content: ["DROP TABLE", "TRUNCATE"], reason: "destructive SQL" }];
  const diffText = "diff --git a/query.sql b/query.sql\n--- a/query.sql\n+++ b/query.sql\n@@ -10,3 +20,3 @@\n DROP TABLE context;\n-TRUNCATE old;\n+DROP TABLE new;\n select 1;\n";
  assert.deepEqual(evaluateTrust({ rules, diffText }), { level: "human", reasons: [
    { rule: 0, reason: "removes sensitive content at query.sql:11, which the repo marks sensitive: destructive SQL", file: "query.sql", line: 11 },
    { rule: 0, reason: "adds sensitive content at query.sql:21, which the repo marks sensitive: destructive SQL", file: "query.sql", line: 21 },
  ] });
  const contextOnly = "--- a/DROP TABLE.sql\n+++ b/DROP TABLE.sql\n@@ -1,2 +1,2 @@\n TRUNCATE unchanged;\n-select old;\n+select new;\n";
  assert.deepEqual(evaluateTrust({ rules, diffText: contextOnly }), normal);
  assert.deepEqual(evaluateTrust({ rules, diffText: patch("query.sql", ["drop table lower;"], ["truncate lower;"]) }), normal);
  assert.deepEqual(evaluateTrust({ rules: [{ content: ["++TRUNCATE"], reason: "destructive SQL" }], diffText: patch("query.sql", [], ["++TRUNCATE"]) }), {
    level: "human", reasons: [{ rule: 0, reason: "adds sensitive content at query.sql:1, which the repo marks sensitive: destructive SQL", file: "query.sql", line: 1 }],
  });
});

test("changing the trust contract or any CODEOWNERS file is itself human-level", () => {
  const before = ["trust:", "  sensitive:", "    - paths: ['auth/**']", "      reason: tenant data", "policy:", "  require_verification: false"];
  const after = ["policy:", "  require_verification: false"];
  assert.deepEqual(evaluateTrust({ diffText: patch(".nomarmy.yml", before, after) }), {
    level: "human", reasons: [ruleChange(".nomarmy.yml")],
  });
  assert.deepEqual(evaluateTrust({ diffText: patch(".nomarmy.yml", before, before.map((line) => line.replace("false", "true"))) }), normal);
  assert.deepEqual(evaluateTrust({ diffText: patch(".nomarmy.yml", before, before.map((line) => line.replace("trust:", "trust: # same rules"))) }), normal);
  for (const file of [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]) {
    assert.deepEqual(evaluateTrust({ changedFiles: [file] }), { level: "human", reasons: [ruleChange(file)] });
  }
  // Full snapshots settle a partial hunk whose header does not include trust:.
  assert.deepEqual(evaluateTrust({ changedFiles: [".nomarmy.yml"], diffText: "",
    configChanges: [{ file: ".nomarmy.yml", before: before.join("\n"), after: after.join("\n") }] }), {
    level: "human", reasons: [ruleChange(".nomarmy.yml")],
  });
});

async function implement(t, { config = null, workerConfig = config, changed = ["auth/check.py"], diffText = "", owners = null, workerOwners = null, untracked = false, workerFails = false } = {}) {
  const root = fixture(t), projectDir = path.join(root, "checkout"), jobsRoot = path.join(root, "jobs");
  fs.mkdirSync(projectDir);
  if (config !== null) write(projectDir, ".nomarmy.yml", config);
  if (owners !== null) write(projectDir, ".github/CODEOWNERS", owners);
  const nameStatus = changed.map((file) => ({ path: file, status: untracked ? "A" : "M", oldPath: null, ...(untracked ? { untracked: true } : {}) }));
  const record = { repoStatusFiles: changed, changedFiles: untracked ? [] : changed, nameStatus,
    testChanges: classifyTestChanges(nameStatus), issues: ["existing issue"], ignoredRuntimeJunk: [], filesChanged: changed.length, additions: 1, deletions: 1 };
  const flow = createVerificationFlow({});
  flow.registerVerificationRunner(async () => ({ status: "pass" }));
  let commitOutcome;
  const executor = createExecutor({ VERSION: "test", projectDir, jobsRoot,
    assertRepo: async () => {}, ensureJobsRoot: () => fs.mkdirSync(jobsRoot, { recursive: true }),
    resolveBase: async () => ({ ref: "base", sha: "base-sha" }),
    sweepStaleSandboxContainers: async () => {},
    run: async (command, args) => {
      assert.equal(command, "git");
      assert.deepEqual(args.slice(0, 3), ["worktree", "add", "-b"]);
      write(args[4], ".git", "gitdir: synthetic-pointer\n");
    },
    gitRaw: async (args) => {
      if (args[0] === "show") { assert.equal(args[1], "base-sha:.nomarmy.yml"); return config ?? ""; }
      assert.equal(args[0], "diff");
      return diffText;
    },
    collectGitRecord: async () => record,
    createCoordinatorCommit: async ({ outcome }) => { commitOutcome = outcome; return { created: outcome.commitAllowed, reason: outcome.commitBlockedReason }; },
    runOpenClaw: async ({ cwd }) => {
      if (workerConfig !== null) write(cwd, ".nomarmy.yml", workerConfig);
      if (workerOwners !== null) write(cwd, ".github/CODEOWNERS", workerOwners);
      for (const file of changed.filter((file) => file !== ".nomarmy.yml" && !(file === ".github/CODEOWNERS" && workerOwners !== null))) write(cwd, file, "TRUNCATE accounts;\n");
      if (workerFails) throw new Error("synthetic worker failure");
      return { final: "STATUS: done\nTESTS: pass\nNOT_DONE: none\nNOTE: implemented" };
    },
    ...flow, verificationFlow: flow, repoPolicy: () => ({}), buildMetrics: () => ({}), recordedBudgets: () => ({}),
    resolveReasoningApplied: () => "off", execution: {}, budgetState: { budgets: { report: { implement: 256 } } },
  });
  const result = await executor.executeJob({ task: "change access check", jobId: "trust-job" });
  assert.equal(result.manifest.error, undefined, result.report);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.jobDir, "metadata.json"), "utf8")), result.manifest);
  return { manifest: result.manifest, commitOutcome };
}

const trustConfig = "trust:\n  sensitive:\n    - paths: ['auth/**']\n      reason: access control and tenant data\n";

test("implement jobs enforce checkout trust, retain normal records, and leave unconfigured repos unchanged", async (t) => {
  const { manifest, commitOutcome } = await implement(t, { config: trustConfig, workerConfig: "{}\n", changed: ["auth/check.py", ".nomarmy.yml"] });
  const trust = { level: "human", reasons: [sensitive("auth/check.py"), ruleChange(".nomarmy.yml")] };
  assert.deepEqual(manifest.trust, trust);
  assert.equal(manifest.reviewRequired, true);
  assert.equal(commitOutcome.reviewRequired, true);
  assert.equal(manifest.issues[0], `HUMAN REVIEW REQUIRED (trust): ${trust.reasons.map((reason) => reason.reason).join("; ")}`);
  assert.equal(manifest.issues.filter((issue) => issue === HIGH_STAKES_NOTE).length, 1);
  assert.equal(manifest.commit.created, true); // Integration is gated, not the worker commit.
  const unmatched = (await implement(t, { config: trustConfig, changed: ["README.md"] })).manifest;
  assert.deepEqual(unmatched.trust, normal);
  assert.equal(unmatched.reviewRequired, false);
  assert.deepEqual(unmatched.issues, ["existing issue"]);
  const ordinary = (await implement(t)).manifest;
  assert.equal(Object.hasOwn(ordinary, "trust"), false);
  assert.deepEqual(Object.keys(ordinary).sort(), Object.keys(unmatched).filter((key) => key !== "trust").sort());
  assert.equal(ordinary.reviewRequired, false);
  assert.deepEqual(ordinary.issues, ["existing issue"]);
});

test("implement gates owner changes, new-file content, and sensitive diffs from failed workers", async (t) => {
  const owned = (await implement(t, { config: "trust:\n  codeowners: true\n", owners: "/auth/ @security\n", workerOwners: "", changed: ["auth/check.py", ".github/CODEOWNERS"] })).manifest;
  assert.deepEqual(owned.trust, { level: "human", reasons: [
    { rule: "codeowners", reason: "changes auth/check.py, owned in CODEOWNERS by @security", file: "auth/check.py" }, ruleChange(".github/CODEOWNERS"),
  ] });
  const content = (await implement(t, { config: "trust:\n  sensitive:\n    - content: ['TRUNCATE']\n      reason: destructive SQL\n", changed: ["new.sql"], untracked: true })).manifest;
  assert.deepEqual(content.trust, { level: "human", reasons: [
    { rule: 0, reason: "adds sensitive content at new.sql:1, which the repo marks sensitive: destructive SQL", file: "new.sql", line: 1 },
  ] });
  const failed = (await implement(t, { config: trustConfig, workerFails: true })).manifest;
  assert.equal(failed.outcome, "WORKER_FAILED");
  assert.equal(failed.reviewRequired, true);
  assert.deepEqual(failed.trust, { level: "human", reasons: [sensitive("auth/check.py")] });
  assert.equal(failed.issues[0], "HUMAN REVIEW REQUIRED (trust): changes auth/check.py, which the repo marks sensitive: access control and tenant data");
  assert.equal(failed.issues.includes(HIGH_STAKES_NOTE), true);
});
