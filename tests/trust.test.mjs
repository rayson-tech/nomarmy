import "./helpers/isolate-global-config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { validateConfig } from "../lib/config.mjs";
import { parseCodeowners, codeownersPaths, evaluateTrust } from "../lib/trust.mjs";
import { createExecutor } from "../lib/execute.mjs";
import { createVerificationFlow } from "../lib/verification-flow.mjs";
import { classifyTestChanges } from "../lib/diff-checks.mjs";
import { createProcess } from "../lib/process.mjs";
import { HIGH_STAKES_NOTE } from "../lib/outcome.mjs";

const withJudgment = (trust) => ({ ...trust, judgment: { status: "unavailable", validator: null, answers: {}, error: "No trust validator configured." }, checks: [] });
const normal = { level: "normal", reasons: [] };
const sensitive = (file, rule = 0, reason = "access control and tenant data") => ({
  rule, reason: `changes ${file}, which the repo marks sensitive: ${reason}`, file,
});
const ruleChange = (file) => ({ rule: "trust", reason: "changes the repository's trust rules", file });
const snapshot = (file, before, after) => ({ file, before: before.join("\n"), after: after.join("\n") });

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
  const before = [...Array(9).fill("padding"), "DROP TABLE context;", "TRUNCATE old;", "select 1;"];
  const after = [...Array(19).fill("padding"), "DROP TABLE context;", "DROP TABLE new;", "select 1;"];
  assert.deepEqual(evaluateTrust({ rules, fileChanges: [{ file: "query.sql", before: before.join("\n"), after: after.join("\n") }] }), { level: "human", reasons: [
    { rule: 0, reason: "removes sensitive content at query.sql:11, which the repo marks sensitive: destructive SQL", file: "query.sql", line: 11 },
    { rule: 0, reason: "adds sensitive content at query.sql:21, which the repo marks sensitive: destructive SQL", file: "query.sql", line: 21 },
  ] });
  assert.deepEqual(evaluateTrust({ rules, fileChanges: [snapshot("DROP TABLE.sql", ["TRUNCATE unchanged;", "select old;"], ["TRUNCATE unchanged;", "select new;"])] }), normal);
  assert.deepEqual(evaluateTrust({ rules, fileChanges: [snapshot("query.sql", ["drop table lower;"], ["truncate lower;"])] }), normal);
  assert.deepEqual(evaluateTrust({ rules: [{ content: ["++TRUNCATE"], reason: "destructive SQL" }], fileChanges: [snapshot("query.sql", [], ["++TRUNCATE"])] }), {
    level: "human", reasons: [{ rule: 0, reason: "adds sensitive content at query.sql:1, which the repo marks sensitive: destructive SQL", file: "query.sql", line: 1 }],
  });
});

test("changing the trust contract or any CODEOWNERS file is itself human-level", () => {
  const before = ["trust:", "  sensitive:", "    - paths: ['auth/**']", "      reason: tenant data", "policy:", "  require_verification: false"];
  const after = ["policy:", "  require_verification: false"];
  assert.deepEqual(evaluateTrust({ fileChanges: [snapshot(".nomarmy.yml", before, after)] }), {
    level: "human", reasons: [ruleChange(".nomarmy.yml")],
  });
  assert.deepEqual(evaluateTrust({ fileChanges: [snapshot(".nomarmy.yml", before, before.map((line) => line.replace("false", "true")))] }), normal);
  assert.deepEqual(evaluateTrust({ fileChanges: [snapshot(".nomarmy.yml", before, before.map((line) => line.replace("trust:", "trust: # same rules")))] }), normal);
  for (const file of [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]) {
    assert.deepEqual(evaluateTrust({ changedFiles: [file] }), { level: "human", reasons: [ruleChange(file)] });
  }
  // Full snapshots settle a partial hunk whose header does not include trust:.
  assert.deepEqual(evaluateTrust({ changedFiles: [".nomarmy.yml"], diffText: "",
    fileChanges: [{ file: ".nomarmy.yml", before: before.join("\n"), after: after.join("\n") }] }), {
    level: "human", reasons: [ruleChange(".nomarmy.yml")],
  });
});

async function implement(t, { config = null, workerConfig = config, changed = ["auth/check.py"], diffText = "", owners = null, workerOwners = null, untracked = false, workerFails = false, baseFiles = {}, newFiles = {}, entries = null, baseModes = {}, setupWorker = null, conversion = null, validatorDeps = {}, task = "change access check", stakes = null, trustAdmission = null } = {}) {
  const root = fixture(t), projectDir = path.join(root, "checkout"), jobsRoot = path.join(root, "jobs");
  fs.mkdirSync(projectDir);
  if (config !== null) write(projectDir, ".nomarmy.yml", config);
  if (owners !== null) write(projectDir, ".github/CODEOWNERS", owners);
  const nameStatus = entries ?? changed.map((file) => ({ path: file, status: untracked ? "A" : "M", oldPath: null, ...(untracked ? { untracked: true } : {}) }));
  const record = { repoStatusFiles: changed, changedFiles: untracked ? [] : changed, nameStatus,
    testChanges: classifyTestChanges(nameStatus), issues: ["existing issue"], ignoredRuntimeJunk: [], filesChanged: changed.length, additions: 1, deletions: 1 };
  const flow = createVerificationFlow({});
  flow.registerVerificationRunner(async () => ({ status: "pass" }));
  let commitOutcome, setupError;
  const hashCalls = [], blobs = new Map();
  const executor = createExecutor({ ...validatorDeps, VERSION: "test", projectDir, jobsRoot,
    assertRepo: async () => {}, ensureJobsRoot: () => fs.mkdirSync(jobsRoot, { recursive: true }),
    resolveBase: async () => ({ ref: "base", sha: "base-sha" }),
    sweepStaleSandboxContainers: async () => {},
    run: async (command, args, options) => {
      assert.equal(command, "git");
      if (args[0] === "hash-object") {
        const file = args[3].slice("--path=".length);
        assert.deepEqual(args, ["hash-object", "-w", "--stdin", `--path=${file}`]);
        assert.equal(options.cwd, path.join(jobsRoot, "trust-job", "worktree"));
        assert.equal(Buffer.isBuffer(options.input), true);
        hashCalls.push(file);
        let bytes = options.input;
        if (conversion) bytes = conversion(file, bytes);
        else if (file === "query.sql") {
          const attributes = newFiles[".gitattributes"] ?? "";
          if (/working-tree-encoding=UTF-16(?:LE|BE)/.test(attributes)) {
            if (bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) throw new Error("BOM prohibited with UTF-16LE");
            bytes = Buffer.from(/UTF-16BE/.test(attributes) ? Buffer.from(bytes).swap16().toString("utf16le") : bytes.toString("utf16le"));
          }
        }
        const sha = String(blobs.size + 1).padStart(40, "0");
        blobs.set(sha, bytes);
        return { stdout: sha };
      }
      if (args[0] === "cat-file") {
        assert.equal(options.cwd, projectDir);
        assert.equal(options.encoding, null);
        assert.equal(options.trim, false);
        if (blobs.has(args[2])) {
          assert.deepEqual(args, ["cat-file", "blob", args[2]]);
          if (blobs.get(args[2]) === null) throw new Error("blob unavailable");
          return { stdout: blobs.get(args[2]) };
        }
        const file = args[2].slice("base-sha:".length);
        assert.deepEqual(args, ["cat-file", "blob", `base-sha:${file}`]);
        assert.notEqual(baseModes[file], "160000", "gitlinks must not be sent to cat-file blob");
        return { stdout: Buffer.from(file === ".nomarmy.yml" ? config ?? "" : baseFiles[file]) };
      }
      assert.deepEqual(args.slice(0, 3), ["worktree", "add", "-b"]);
      write(args[4], ".git", "gitdir: synthetic-pointer\n");
    },
    gitRaw: async (args) => {
      if (args[0] === "ls-tree") {
        const files = [...Object.keys(baseFiles), ...(config === null ? [] : [".nomarmy.yml"])];
        // Accept the old listing as well so regression checks exercise the
        // unsafe reader, not just a changed command signature.
        if (args.includes("--name-only")) return files.join("\0") + "\0";
        assert.deepEqual(args, ["ls-tree", "-r", "-z", "base-sha"]);
        return files.map((file) => `${baseModes[file] ?? "100644"} ${baseModes[file] === "160000" ? "commit" : "blob"} ${"a".repeat(40)}\t${file}\0`).join("");
      }
      if (args[0] === "show") { assert.equal(args[1], "base-sha:.nomarmy.yml"); return config ?? ""; }
      assert.equal(args[0], "diff");
      return diffText;
    },
    collectGitRecord: async () => record,
    createCoordinatorCommit: async ({ outcome }) => { commitOutcome = outcome; return { created: outcome.commitAllowed, reason: outcome.commitBlockedReason }; },
    runOpenClaw: async ({ cwd }) => {
      if (workerConfig !== null) write(cwd, ".nomarmy.yml", workerConfig);
      if (workerOwners !== null) write(cwd, ".github/CODEOWNERS", workerOwners);
      for (const file of changed.filter((file) => file !== ".nomarmy.yml" && !(file === ".github/CODEOWNERS" && workerOwners !== null))) {
        if (Object.hasOwn(newFiles, file) && newFiles[file] === null) continue;
        write(cwd, file, newFiles[file] ?? "TRUNCATE accounts;\n");
      }
      if (setupWorker) {
        try { await setupWorker(cwd, root); }
        catch (error) { setupError = error; throw error; }
      }
      if (workerFails) throw new Error("synthetic worker failure");
      return { final: "STATUS: done\nTESTS: pass\nNOT_DONE: none\nNOTE: implemented" };
    },
    ...flow, verificationFlow: flow, repoPolicy: () => ({}), buildMetrics: () => ({}), recordedBudgets: () => ({}),
    resolveReasoningApplied: () => "off", execution: {}, budgetState: { budgets: { report: { implement: 256 } } },
  });
  const result = await executor.executeJob({ task, stakes, trustAdmission, jobId: "trust-job" });
  if (setupError) throw setupError;
  assert.equal(result.manifest.error, undefined, result.report);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.jobDir, "metadata.json"), "utf8")), result.manifest);
  return { manifest: result.manifest, commitOutcome, hashCalls };
}

const trustConfig = "trust:\n  sensitive:\n    - paths: ['auth/**']\n      reason: access control and tenant data\n";

test("implement jobs enforce checkout trust, retain normal records, and leave unconfigured repos unchanged", async (t) => {
  const { manifest, commitOutcome } = await implement(t, { config: trustConfig, workerConfig: "{}\n", changed: ["auth/check.py", ".nomarmy.yml"] });
  const trust = { level: "human", reasons: [sensitive("auth/check.py"), ruleChange(".nomarmy.yml")] };
  assert.deepEqual(manifest.trust, withJudgment(trust));
  assert.equal(manifest.reviewRequired, true);
  assert.equal(commitOutcome.reviewRequired, true);
  assert.equal(manifest.issues[0], `HUMAN REVIEW REQUIRED (trust): ${trust.reasons.map((reason) => reason.reason).join("; ")}`);
  assert.equal(manifest.issues.filter((issue) => issue === HIGH_STAKES_NOTE).length, 1);
  assert.equal(manifest.commit.created, true); // Integration is gated, not the worker commit.
  const unmatched = (await implement(t, { config: trustConfig, changed: ["README.md"] })).manifest;
  assert.deepEqual(unmatched.trust, withJudgment(normal));
  assert.equal(unmatched.reviewRequired, false);
  assert.deepEqual(unmatched.issues, ["existing issue"]);
  const ordinary = (await implement(t)).manifest;
  assert.deepEqual(ordinary.trust, withJudgment(normal));
  assert.deepEqual(Object.keys(ordinary).sort(), Object.keys(unmatched).sort());
  assert.equal(ordinary.reviewRequired, false);
  assert.deepEqual(ordinary.issues, ["existing issue"]);
});

test("implement gates owner changes, new-file content, and sensitive diffs from failed workers", async (t) => {
  const owned = (await implement(t, { config: "trust:\n  codeowners: true\n", owners: "/auth/ @security\n", workerOwners: "", changed: ["auth/check.py", ".github/CODEOWNERS"] })).manifest;
  assert.deepEqual(owned.trust, withJudgment({ level: "human", reasons: [
    { rule: "codeowners", reason: "changes auth/check.py, owned in CODEOWNERS by @security", file: "auth/check.py" }, ruleChange(".github/CODEOWNERS"),
  ] }));
  const content = (await implement(t, { config: "trust:\n  sensitive:\n    - content: ['TRUNCATE']\n      reason: destructive SQL\n", changed: ["new.sql"], untracked: true })).manifest;
  assert.deepEqual(content.trust, withJudgment({ level: "human", reasons: [
    { rule: 0, reason: "adds sensitive content at new.sql:1, which the repo marks sensitive: destructive SQL", file: "new.sql", line: 1 },
  ] }));
  const failed = (await implement(t, { config: trustConfig, workerFails: true })).manifest;
  assert.equal(failed.outcome, "WORKER_FAILED");
  assert.equal(failed.reviewRequired, true);
  assert.deepEqual(failed.trust, withJudgment({ level: "human", reasons: [sensitive("auth/check.py")] }));
  assert.equal(failed.issues[0], "HUMAN REVIEW REQUIRED (trust): changes auth/check.py, which the repo marks sensitive: access control and tenant data");
  assert.equal(failed.issues.includes(HIGH_STAKES_NOTE), true);
});

const sqlConfig = "trust:\n  sensitive:\n    - content: ['DROP TABLE']\n      reason: destructive SQL\n";
const sqlReason = (file, verb = "adds", line = 2) => ({
  rule: 0, reason: `${verb} sensitive content at ${file}:${line}, which the repo marks sensitive: destructive SQL`, file, line,
});

for (const attributes of ["* -diff", "* binary", "query.sql working-tree-encoding=UTF-16LE", "query.sql working-tree-encoding=UTF-16BE", "* diff=hidden"]) {
  test(`raw trust content survives attributes ${attributes}`, async (t) => {
    const text = attributes.includes("UTF-16") ? "DROP TABLE accounts;" : "select 1;\nDROP TABLE accounts;\n";
    const bytes = attributes.includes("UTF-16") ? Buffer.from(text, "utf16le") : Buffer.from(text);
    if (attributes.includes("UTF-16BE")) bytes.swap16();
    const { manifest, hashCalls } = await implement(t, {
      config: sqlConfig, changed: ["query.sql", ".gitattributes"],
      baseFiles: { "query.sql": "select 1;\n" },
      newFiles: { "query.sql": bytes, ".gitattributes": `${attributes}\n` },
      diffText: "Binary files a/query.sql and b/query.sql differ\n",
    });
    assert.deepEqual(hashCalls, ["query.sql", ".gitattributes"]);
    assertGated(manifest, { level: "human", reasons: [sqlReason("query.sql", "adds", attributes.includes("UTF-16") ? 1 : 2)] });
  });
}

test("committed trust content gates UTF-16LE BOM conversion failures", async (t) => {
  const { manifest, hashCalls } = await implement(t, {
    config: sqlConfig, changed: ["query.sql", ".gitattributes"],
    newFiles: { "query.sql": Buffer.from("\ufeffDROP TABLE accounts;", "utf16le"),
      ".gitattributes": "query.sql working-tree-encoding=UTF-16LE\n" },
  });
  assert.deepEqual(hashCalls, ["query.sql", ".gitattributes"]);
  assertGated(manifest, unchecked("query.sql", "could not be converted to committed bytes"));
});

test("committed trust content unions raw and clean-filter views and gates failures", async (t) => {
  for (const kind of ["raw", "committed", "hash failure", "blob failure"]) {
    const { manifest, hashCalls } = await implement(t, {
      config: sqlConfig, changed: ["query.sql"],
      newFiles: { "query.sql": kind === "raw" ? "DROP TABLE accounts;" : "select 1;" },
      conversion(file, bytes) {
        assert.equal(file, "query.sql");
        assert.deepEqual(bytes, Buffer.from(kind === "raw" ? "DROP TABLE accounts;" : "select 1;"));
        if (kind === "hash failure") throw new Error("required filter failed");
        if (kind === "blob failure") return null;
        return Buffer.from(kind === "raw" ? "select 1;" : "DROP TABLE accounts;");
      },
    });
    assert.deepEqual(hashCalls, ["query.sql"]);
    assertGated(manifest, kind.endsWith("failure") ? unchecked("query.sql", "could not be converted to committed bytes")
      : { level: "human", reasons: [sqlReason("query.sql", "adds", 1)] });
  }
});

test("trust process input preserves the safely captured bytes", async () => {
  const { run } = createProcess({ projectDir: process.cwd() });
  const bytes = Buffer.from([0xff, 0xfe, 68, 0, 10, 0]);
  assert.deepEqual(await run(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { input: bytes, encoding: null }),
    { stdout: bytes, stderr: "" });
});

test("raw trust content scans NUL and invalid UTF-8 bytes on both sides", async (t) => {
  const { manifest } = await implement(t, {
    config: sqlConfig, changed: ["query.bin"],
    baseFiles: { "query.bin": Buffer.concat([Buffer.from([0xff, 0]), Buffer.from("\nDROP TABLE old;\n")]) },
    newFiles: { "query.bin": Buffer.concat([Buffer.from([0xfe, 0]), Buffer.from("\nDROP TABLE new;\n")]) },
    diffText: "Binary files a/query.bin and b/query.bin differ\n",
  });
  assert.deepEqual(manifest.trust, withJudgment({ level: "human", reasons: [sqlReason("query.bin", "removes"), sqlReason("query.bin")] }));
  // Latin1 fallback is observable, not just an ASCII match after replacement.
  assert.deepEqual(evaluateTrust({ rules: [{ content: ["ÿ"], reason: "binary marker" }],
    fileChanges: [{ file: "query.bin", before: Buffer.alloc(0), after: Buffer.from([0xff]) }] }), {
    level: "human", reasons: [{ rule: 0, reason: "adds sensitive content at query.bin:1, which the repo marks sensitive: binary marker", file: "query.bin", line: 1 }],
  });
});

test("raw process output preserves invalid bytes and whitespace", async () => {
  const { run } = createProcess({ projectDir: process.cwd() });
  const result = await run(process.execPath, ["-e", "process.stdout.write(Buffer.from([32, 255, 0, 10]))"], { encoding: null });
  assert.deepEqual(result, { stdout: Buffer.from([32, 255, 0, 10]), stderr: "" });
});

test("content literals collapse whitespace across added and removed lines as multisets", () => {
  const rules = [{ content: ["DROP\t TABLE"], reason: "destructive SQL" }];
  assert.deepEqual(evaluateTrust({ rules, fileChanges: [snapshot("query.sql",
    ["unchanged", "DROP", "TABLE old;"], ["unchanged", "DROP", "DROP", "TABLE new;"])] }), {
    level: "human", reasons: [sqlReason("query.sql", "adds", 3)],
  });
  for (const verb of ["adds", "removes"]) {
    const lines = ["DROP", "TABLE accounts;"];
    assert.deepEqual(evaluateTrust({ rules: [{ content: ["DROP TABLE"], reason: "destructive SQL" }],
      fileChanges: [snapshot("query.sql", verb === "removes" ? lines : [], verb === "adds" ? lines : [])] }), {
      level: "human", reasons: [sqlReason("query.sql", verb, 1)],
    });
  }
  assert.deepEqual(evaluateTrust({ rules, fileChanges: [snapshot("query.sql", ["DROP", "TABLE"], ["DROP", "TABLE"])] }), normal);
  assert.deepEqual(evaluateTrust({ rules, fileChanges: [snapshot("query.sql", [], ["DROP", "  ", "\tTABLE accounts;"])] }), {
    level: "human", reasons: [sqlReason("query.sql", "adds", 1)],
  });
});

test("trust paths and CODEOWNERS casefold both paths and patterns", () => {
  for (const [file, pattern] of [["Auth/check.py", "auth/**"], ["auth/check.py", "AUTH/**"]]) {
    assert.deepEqual(evaluateTrust({ changedFiles: [file], rules: [{ paths: [pattern], reason: "access control and tenant data" }], codeowners: parseCodeowners(`${pattern} @security`) }), {
      level: "human", reasons: [sensitive(file), { rule: "codeowners", reason: `changes ${file}, owned in CODEOWNERS by @security`, file }],
    });
  }
});

test("trust paths and CODEOWNERS normalize repeated separators and dot prefixes", () => {
  for (const spelling of ["//auth/x", "././auth/x", "auth//x", "auth\\x"]) {
    for (const [file, pattern] of [[spelling, "auth/**"], ["auth/x", spelling.replace(/x$/, "**")]]) {
      assert.deepEqual(evaluateTrust({ changedFiles: [file], rules: [{ paths: [pattern], reason: "access control and tenant data" }], codeowners: parseCodeowners(`${pattern} @security`) }), {
        level: "human", reasons: [sensitive("auth/x"), { rule: "codeowners", reason: "changes auth/x, owned in CODEOWNERS by @security", file: "auth/x" }],
      });
    }
  }
});

test("trust path braces are literal like CODEOWNERS braces", () => {
  const file = "config/{secret}.yml";
  assert.deepEqual(evaluateTrust({ changedFiles: [file], rules: [{ paths: [file], reason: "access control and tenant data" }], codeowners: parseCodeowners(`${file} @security`) }), {
    level: "human", reasons: [sensitive(file), { rule: "codeowners", reason: `changes ${file}, owned in CODEOWNERS by @security`, file }],
  });
});

test("trust and CODEOWNERS stars match newline filenames", () => {
  for (const [file, pattern] of [["auth/a\nb.py", "auth/**"], ["auth/a\nb.py", "auth/*"], ["a\nb/auth/x.py", "**/auth/**"], ["a\nb/auth/x.py", "auth/"]]) {
    const codeowners = parseCodeowners(`${pattern} @security`);
    const rules = pattern === "auth/" ? [] : [{ paths: [pattern], reason: "access control and tenant data" }];
    assert.deepEqual(evaluateTrust({ changedFiles: [file], rules, codeowners }), {
      level: "human", reasons: [...(rules.length ? [sensitive(file)] : []), { rule: "codeowners", reason: `changes ${file}, owned in CODEOWNERS by @security`, file }],
    });
  }
});

test("raw snapshots gate untracked renamed and deleted content and old paths", async (t) => {
  const { manifest } = await implement(t, {
    config: "trust:\n  sensitive:\n    - paths: ['auth/**']\n      content: ['DROP TABLE']\n      reason: destructive SQL\n",
    changed: ["new.sql", "renamed.sql", "deleted.sql"],
    entries: [
      { path: "new.sql", status: "A", untracked: true },
      { path: "renamed.sql", oldPath: "auth/old.sql", status: "R" },
      { path: "deleted.sql", status: "D" },
    ],
    baseFiles: { "auth/old.sql": "select 1;\nDROP TABLE renamed;\n", "deleted.sql": "select 1;\nDROP TABLE deleted;\n" },
    newFiles: { "new.sql": "select 1;\nDROP TABLE untracked;\n", "renamed.sql": "select 1;\nDROP TABLE renamed;\n", "deleted.sql": null },
  });
  assert.deepEqual(manifest.trust, withJudgment({ level: "human", reasons: [
    sensitive("auth/old.sql", 0, "destructive SQL"), sqlReason("new.sql"), sqlReason("renamed.sql"),
    sqlReason("deleted.sql", "removes"), sqlReason("auth/old.sql", "removes"),
  ] }));
});

test("missing and malformed trust snapshots fail closed", () => {
  for (const fileChanges of [[], [snapshot(".nomarmy.yml", ["trust: {}"], ["trust: [broken"])]]) {
    assert.deepEqual(evaluateTrust({ changedFiles: [".nomarmy.yml"], fileChanges }), {
      level: "human", reasons: [ruleChange(".nomarmy.yml")],
    });
  }
});

// Tripwires let regressions fail promptly instead of reading an endless device
// or blocking on a FIFO. The filesystem inputs themselves are real, not mocks.
function forbidContentReads(t, paths) {
  const forbidden = new Set(paths);
  const attempts = [];
  for (const method of ["readFileSync", "openSync"]) {
    const original = fs[method];
    t.mock.method(fs, method, function (file, ...args) {
      if (forbidden.has(String(file))) {
        attempts.push({ method, file: String(file) });
        throw new Error(`unsafe content read: ${file}`);
      }
      return original.call(this, file, ...args);
    });
  }
  return () => assert.deepEqual(attempts, [], "no content read or open of a forbidden path");
}
const unchecked = (file, problem = "is not a regular file or symlink") => ({
  level: "human", reasons: [{ rule: "trust", reason: `changes ${file}, which ${problem}, so its content can't be checked`, file }],
});
function assertGated(manifest, trust) {
  assert.deepEqual(manifest.trust, withJudgment(trust));
  assert.equal(manifest.reviewRequired, true);
  assert.equal(manifest.issues[0], `HUMAN REVIEW REQUIRED (trust): ${trust.reasons.map(({ reason }) => reason).join("; ")}`);
}
const posixOnly = { skip: process.platform === "win32" ? "requires POSIX symlinks or special files" : false };

test("safe trust snapshots gate an untracked symlink to /dev/zero promptly without reading it", posixOnly, async (t) => {
  let check;
  const started = performance.now();
  const { manifest } = await implement(t, {
    config: "trust:\n  sensitive:\n    - content: ['/dev/zero']\n      reason: device link\n",
    changed: ["zero"], untracked: true, newFiles: { zero: null },
    setupWorker(cwd) {
      const file = path.join(cwd, "zero");
      fs.symlinkSync("/dev/zero", file);
      check = forbidContentReads(t, [file, "/dev/zero"]);
    },
  });
  check();
  assert.ok(performance.now() - started < 5000, "device link check must finish within five seconds");
  assertGated(manifest, { level: "human", reasons: [{ rule: 0,
    reason: "adds sensitive content at zero:1, which the repo marks sensitive: device link", file: "zero", line: 1 }] });
});

test("safe trust snapshots compare an outside symlink target string without reading sensitive target content", posixOnly, async (t) => {
  let check;
  const { manifest } = await implement(t, {
    config: sqlConfig, changed: ["outside-link"], untracked: true, newFiles: { "outside-link": null },
    setupWorker(cwd, root) {
      const outside = path.join(root, "outside.txt"), link = path.join(cwd, "outside-link");
      write(root, "outside.txt", "DROP TABLE private_data;\n");
      fs.symlinkSync(outside, link);
      check = forbidContentReads(t, [link, outside]);
    },
  });
  check();
  assert.deepEqual(manifest.trust, withJudgment(normal));
  assert.equal(manifest.reviewRequired, false);
});

test("safe trust snapshots gate a symlink whose target string contains sensitive content", posixOnly, async (t) => {
  let check;
  const { manifest } = await implement(t, {
    config: sqlConfig, changed: ["literal-link"], newFiles: { "literal-link": null },
    setupWorker(cwd) {
      const file = path.join(cwd, "literal-link");
      fs.symlinkSync("missing/DROP TABLE accounts", file);
      check = forbidContentReads(t, [file]);
    },
  });
  check();
  assertGated(manifest, { level: "human", reasons: [sqlReason("literal-link", "adds", 1)] });
});

test("safe trust snapshots compare base symlink blobs like for like", posixOnly, async (t) => {
  for (const target of ["DROP TABLE old", "DROP TABLE new"]) {
    const { manifest } = await implement(t, {
      config: sqlConfig, changed: ["tracked-link"], baseFiles: { "tracked-link": "DROP TABLE old" },
      baseModes: { "tracked-link": "120000" }, newFiles: { "tracked-link": null },
      setupWorker(cwd) { fs.symlinkSync(target, path.join(cwd, "tracked-link")); },
    });
    assert.deepEqual(manifest.trust, withJudgment(target === "DROP TABLE old" ? normal : {
      level: "human", reasons: [sqlReason("tracked-link", "removes", 1), sqlReason("tracked-link", "adds", 1)],
    }));
  }
});

test("safe trust snapshots gate a FIFO made with mkfifo without opening it", {
  skip: process.platform === "win32" ? "mkfifo is unavailable on Windows" : false,
}, async (t) => {
  let check;
  const denied = new Error("mkfifo denied");
  let result;
  try { result = await implement(t, {
    config: sqlConfig, changed: ["pipe"], untracked: true, newFiles: { pipe: null },
    setupWorker(cwd) {
      const file = path.join(cwd, "pipe");
      const made = spawnSync("mkfifo", [file], { encoding: "utf8" });
      const code = made.error?.code ?? (/Permission denied/i.test(made.stderr ?? "") ? "EACCES"
        : /Operation not permitted/i.test(made.stderr ?? "") ? "EPERM" : null);
      if (made.status !== 0 && ["EACCES", "EPERM"].includes(code)) {
        t.skip(`mkfifo failed: ${code}`);
        throw denied;
      }
      assert.equal(made.status, 0, made.error?.message ?? made.stderr);
      assert.equal(fs.lstatSync(file).isFIFO(), true);
      check = forbidContentReads(t, [file]);
    },
  });
  } catch (error) { if (error === denied) return; throw error; }
  check();
  assertGated(result.manifest, unchecked("pipe"));
});

test("safe trust snapshots gate files under symlinked parent directories", posixOnly, async (t) => {
  let check;
  const { manifest } = await implement(t, {
    config: sqlConfig, changed: ["nested/redirect/private.txt"], newFiles: { "nested/redirect/private.txt": null },
    setupWorker(cwd, root) {
      write(root, "outside/private.txt", "DROP TABLE private_data;\n");
      fs.mkdirSync(path.join(cwd, "nested"));
      fs.symlinkSync(path.join(root, "outside"), path.join(cwd, "nested/redirect"), "dir");
      check = forbidContentReads(t, [path.join(cwd, "nested/redirect/private.txt"), path.join(root, "outside/private.txt")]);
    },
  });
  check();
  assertGated(manifest, unchecked("nested/redirect/private.txt", "has a symlinked parent directory"));
});

test("safe trust snapshots gate oversized files before opening and accept the size boundary", async (t) => {
  const limit = 16 * 1024 * 1024;
  for (const size of [limit + 1, limit]) {
    let check = () => {};
    const { manifest } = await implement(t, {
      config: sqlConfig, changed: ["large.txt"], newFiles: { "large.txt": null },
      setupWorker(cwd) {
        const file = path.join(cwd, "large.txt");
        const fd = fs.openSync(file, "w");
        fs.ftruncateSync(fd, size);
        fs.closeSync(fd);
        if (size > limit) check = forbidContentReads(t, [file]);
      },
    });
    check();
    if (size > limit) assertGated(manifest, unchecked("large.txt", "exceeds the 16777216-byte content limit"));
    else assert.deepEqual(manifest.trust, withJudgment(normal));
  }
});

test("safe trust snapshots gate directories and sockets without opening them", posixOnly, async (t) => {
  for (const kind of ["directory", "socket"]) {
    let check;
    const { manifest } = await implement(t, {
      config: sqlConfig, changed: [kind], newFiles: { [kind]: null },
      async setupWorker(cwd) {
        const file = path.join(cwd, kind);
        if (kind === "directory") fs.mkdirSync(file);
        else {
          const server = net.createServer();
          t.after(() => new Promise((resolve) => server.close(resolve)));
          // Unix socket paths are capped near 104 bytes; bind by a relative
          // name so the fixture works however deep the checkout lives.
          const previous = process.cwd();
          process.chdir(cwd);
          try { await new Promise((resolve, reject) => { server.once("error", reject); server.listen(kind, resolve); }); }
          finally { process.chdir(previous); }
          assert.equal(fs.lstatSync(file).isSocket(), true);
        }
        check = forbidContentReads(t, [file]);
      },
    });
    check();
    assertGated(manifest, unchecked(kind));
  }
});

test("safe trust snapshots gate base gitlinks without cat-file blob even when deleted", async (t) => {
  for (const exists of [false, true]) {
    let check = () => {};
    const { manifest } = await implement(t, {
      config: sqlConfig, changed: ["submodule"], baseFiles: { submodule: "a".repeat(40) },
      baseModes: { submodule: "160000" }, newFiles: { submodule: null },
      setupWorker(cwd) {
        if (exists) {
          const file = path.join(cwd, "submodule");
          fs.mkdirSync(file);
          check = forbidContentReads(t, [file]);
        }
      },
    });
    check();
    assertGated(manifest, unchecked("submodule"));
  }
});

for (const [label, before, after, literal] of [
  ["unchanged DROP and blank lines", "DROP\n\n", "DROP\n\nTABLE\n", "DROP TABLE"],
  ["zero-width separator", "", "DROP\u200bTABLE", "DROP TABLE"],
  ["soft hyphen", "", "DR\u00adOP TABLE", "DROP TABLE"],
  ["embedded BOM", "", "DROP TA\ufeffBLE", "DROP TABLE"],
  ["format control in literal", "", "DROP TABLE", "DR\u200dOP TABLE"],
  ["NBSP and Unicode spaces", "DROP\n", "DROP\n\u00a0\u2003TABLE", "DROP TABLE"],
]) {
  test(`content occurrence normalization gates ${label}`, () => {
    const rules = [{ content: [literal], reason: "destructive SQL" }];
    for (const verb of ["adds", "removes"]) {
      const change = { file: "query.sql", before: verb === "adds" ? before : after, after: verb === "adds" ? after : before };
      assert.deepEqual(evaluateTrust({ rules, fileChanges: [change] }), {
        level: "human", reasons: [sqlReason("query.sql", verb, 1)],
      });
    }
    assert.deepEqual(evaluateTrust({ rules, fileChanges: [{ file: "query.sql", before: after, after }] }), normal);
  });
}

test("whole-file occurrence counts locate new matches after unchanged context", () => {
  const before = "DROP TABLE existing;\nDROP\n\n";
  const after = before + "TABLE\n";
  assert.deepEqual(evaluateTrust({ rules: [{ content: ["DROP TABLE"], reason: "destructive SQL" }],
    fileChanges: [{ file: "query.sql", before, after }] }), {
    level: "human", reasons: [sqlReason("query.sql", "adds", 2)],
  });
});

test("implement phase two grades raw removed checks and judgments as high stakes with a human-only hard stop", async (t) => {
  const { resetJevBreaker } = await import("../lib/validators.mjs");
  for (const [probability, removed, expected] of [[0, false, "normal"], [0, true, "review"], [0.5, false, "review"], [0.5, true, "review"], [0.8, false, "human"], [0.8, true, "human"]]) {
    resetJevBreaker();
    const validatorDeps = { jevSettings: () => ({ key: "fixture", checks: [] }), askTrustJev: async ({ state }) => {
      assert.deepEqual(Object.keys(state), ["diff"]);
      assert.equal(state.diff.includes("SECRET_BRIEF"), false);
      return { answers: { access: { probabilities: { yes: probability } }, checks: { probabilities: { yes: 0 } }, data: { probabilities: { yes: 0 } } } };
    } };
    const { manifest, commitOutcome } = await implement(t, { validatorDeps, task: "SECRET_BRIEF", changed: ["utils.py", ".gitattributes"],
      baseFiles: { "utils.py": removed ? "if not authorized:\n    raise Denied()" : "value = 1" },
      newFiles: { "utils.py": "# this is safe\nvalue = 2", ".gitattributes": "* -diff" }, diffText: "" });
    const reasons = [
      ...(removed ? [{ rule: "removed-check", reason: "Removes or changes an access guard at utils.py:1.", file: "utils.py", line: 1 }] : []),
      ...(probability >= 0.5 ? [{ rule: "judgment", reason: `The diff may change access control at utils.py:1, .gitattributes:1 (jev, probability ${probability.toFixed(2)}).` }] : []),
    ];
    assert.deepEqual(manifest.trust, { level: expected, reasons,
      judgment: { status: "available", validator: "jev", answers: { access: probability, checks: 0, data: 0 }, error: null },
      checks: removed ? [{ kind: "guard", file: "utils.py", line: 1, reason: "Removes or changes an access guard at utils.py:1." }] : [] });
    assert.equal(manifest.stakes ?? null, expected === "normal" ? null : "high");
    assert.equal(manifest.reviewRequired, expected !== "normal");
    assert.equal(commitOutcome.reviewRequired, expected !== "normal");
    assert.equal(manifest.commit.created, true);
    assert.deepEqual(manifest.issues, [
      ...(expected === "human" ? [`HUMAN REVIEW REQUIRED (trust): ${reasons.map(r => r.reason).join("; ")}`] : []),
      ...(expected !== "normal" ? [HIGH_STAKES_NOTE] : []), "existing issue",
    ]);
  }
  const { manifest } = await implement(t, { stakes: "high", trustAdmission: { notes: ["Brief marks task high."] }, changed: ["utils.py"], newFiles: { "utils.py": "value = 2" } });
  assert.equal(manifest.stakes, "high");
  assert.deepEqual(manifest.trustAdmission, { notes: ["Brief marks task high."] });
  assert.equal(manifest.reviewRequired, true);
});

test("trust judgment schema accepts booleans and rejects other values", () => {
  for (const judgment of [false, true]) {
    assert.deepEqual(validateConfig({ trust: { judgment } }), {
      valid: true, config: { trust: { judgment }, environment_retention: { success: "destroy", failure: "logs", debug: "retain" } },
      errors: [], elevated: { shared: [], remote: [] },
    });
  }
  for (const [judgment, type] of [["false", "string"], [0, "number"], [null, "null"], [[], "array"], [{}, "object"]]) {
    assert.deepEqual(validateConfig({ trust: { judgment } }), {
      valid: false, config: null, errors: [`trust.judgment: Invalid input: expected boolean, received ${type}`], elevated: { shared: [], remote: [] },
    });
  }
});

test("operator judgment opt-out records disabled judgments while defaults and worktree edits keep judgment enabled", async (t) => {
  const { resetJevBreaker } = await import("../lib/validators.mjs");
  const disabled = { status: "disabled", validator: null, answers: {}, error: null };
  const enabled = { status: "available", validator: "jev", answers: { access: 0, checks: 0, data: 0 }, error: null };
  const off = "trust:\n  judgment: false\n";
  for (const config of [null, "trust:\n  judgment: true\n", off]) {
    for (const removed of [false, true]) {
      resetJevBreaker();
      let calls = 0;
      const { manifest } = await implement(t, { config, workerConfig: off, changed: ["utils.py"],
        baseFiles: { "utils.py": removed ? "if not authorized:\n    raise Denied()" : "value = 1" },
        newFiles: { "utils.py": "value = 2" },
        validatorDeps: { jevSettings: () => ({ key: "fixture", checks: [] }), askTrustJev: async () => {
          calls++;
          return { answers: { access: { probabilities: { yes: 0 } }, checks: { probabilities: { yes: 0 } }, data: { probabilities: { yes: 0 } } } };
        }, askTrustJudge: async () => assert.fail("unexpected judge call") },
      });
      assert.equal(calls, config === off ? 0 : 1);
      assert.deepEqual(manifest.trust, { level: removed ? "review" : "normal",
        reasons: removed ? [{ rule: "removed-check", reason: "Removes or changes an access guard at utils.py:1.", file: "utils.py", line: 1 }] : [],
        judgment: config === off ? disabled : enabled,
        checks: removed ? [{ kind: "guard", file: "utils.py", line: 1, reason: "Removes or changes an access guard at utils.py:1." }] : [] });
      assert.equal(manifest.reviewRequired, removed);
    }
  }
  // A tracked policy edit remains human-gated and cannot disable the call.
  resetJevBreaker();
  let judgeCalls = 0;
  const { manifest } = await implement(t, { workerConfig: off, changed: [".nomarmy.yml"],
    validatorDeps: { judgeSettings: () => ({}), askTrustJudge: async () => {
      judgeCalls++;
      return { answer: { access: 0, checks: 0, data: 0 } };
    } } });
  assert.equal(judgeCalls, 1);
  assert.deepEqual(manifest.trust, { level: "human", reasons: [ruleChange(".nomarmy.yml")], checks: [],
    judgment: { ...enabled, validator: "judge" } });
});
