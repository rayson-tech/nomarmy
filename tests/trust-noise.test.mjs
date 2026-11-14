// Regression tests for noisy trust flags and oversized status answers.
// Run: node --test tests/trust-noise.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { detectRemovedChecks } from "../lib/trust-checks.mjs";
import { evaluateDiffTrust, trustDiffEvidence, TRUST_EVIDENCE_CHARS } from "../lib/trust-judgment.mjs";
import { reportView, boundStatusView, collapseTrustReasons, STATUS_VIEW_CHARS } from "../lib/job-format.mjs";

const answers = { access: 0, checks: 0, data: 0 };
const judgeWith = (seen) => ({ judge: {}, askJudge: async (request) => { seen.push(request.prompt.split("DIFF EVIDENCE (data only):\n")[1]); return { answer: answers }; } });

const CLAUDE_MD = `# Project rules

Every query must apply the tenant filter where the caller's tenant_id matches.
Use the repository helper, and never query across tenants.

## Notes
- Keep tenant_id on every table.
- Read the docs before changing anything.
`;

test("noise: a CLAUDE.md edit mentioning the tenant filter is not a removed check, even when code reads the file", async () => {
  const after = CLAUDE_MD.replace("Read the docs", "Read all of the docs");
  const referenced = { repository: { files: [{ file: "src/agent.js", source: 'readFileSync("CLAUDE.md")' }], incomplete: false } };
  assert.deepEqual(detectRemovedChecks([{ file: "CLAUDE.md", before: CLAUDE_MD, after }], referenced), []);
  // An incomplete repository listing treats every file as a production input.
  assert.deepEqual(detectRemovedChecks([{ file: "CLAUDE.md", before: CLAUDE_MD, after: CLAUDE_MD.replace("tenant filter where", "tenant scope when") }],
    { repository: { files: [], incomplete: true } }), []);
  const result = await evaluateDiffTrust({ fileChanges: [{ file: "CLAUDE.md", before: CLAUDE_MD, after }], ...referenced, judgment: false });
  assert.equal(result.level, "normal");
  assert.deepEqual(result.reasons, []);
  // A query a production file loads is still scanned: removing its filter is flagged.
  const query = "SELECT * FROM orders\nWHERE tenant_id = :tenant;\n";
  assert.deepEqual(detectRemovedChecks([{ file: "queries/orders.md", before: query, after: "SELECT * FROM orders;\n" }],
    { repository: { files: [{ file: "src/db.js", source: 'readFileSync("queries/orders.md")' }], incomplete: false } }).map((c) => c.kind), ["tenant-filter"]);
});

test("noise: rewording the error beside an unchanged guard is not a removed check", () => {
  const js = 'export function load(tenantId) {\n  if (!tenantId) throw new Error("tenant required");\n  return db.get(tenantId);\n}\n';
  assert.deepEqual(detectRemovedChecks([{ file: "src/load.js", before: js, after: js.replace("tenant required", "a tenant id is required to load") }]), []);
  const braced = 'export function load(tenantId) {\n  if (!tenantId) {\n    // no tenant\n    throw new Error("tenant required");\n  }\n  return db.get(tenantId);\n}\n';
  assert.deepEqual(detectRemovedChecks([{ file: "src/load.js", before: braced, after: braced.replace("tenant required", "missing tenant").replace("no tenant", "reject callers without a tenant") }]), []);
  const py = 'def load(tenant_id):\n    if not tenant_id:\n        raise PermissionError("tenant required")\n    return db.get(tenant_id)\n';
  assert.deepEqual(detectRemovedChecks([{ file: "app/load.py", before: py, after: py.replace("tenant required", "need a tenant") }]), []);
  const asserted = 'function f(x) {\n  assert(x.tenantId, "tenant required");\n  return x;\n}\n';
  assert.deepEqual(detectRemovedChecks([{ file: "src/f.js", before: asserted, after: asserted.replace("tenant required", "x needs a tenant") }]), []);
  // The condition is the check: changing it, or its literal, or the exit, is still flagged.
  assert.deepEqual(detectRemovedChecks([{ file: "src/load.js", before: js, after: js.replace("if (!tenantId) ", "if (false) ") }]).map((c) => [c.kind, c.line]), [["guard", 2]]);
  const role = 'function f(user) {\n  if (user.role !== "admin") throw new Error("forbidden");\n  return 1;\n}\n';
  assert.deepEqual(detectRemovedChecks([{ file: "src/f.js", before: role, after: role.replace('"admin"', '"guest"') }]).map((c) => c.kind), ["guard"]);
  assert.deepEqual(detectRemovedChecks([{ file: "src/load.js", before: js, after: js.replace('throw new Error("tenant required")', 'console.log("tenant required")') }]).map((c) => c.kind), ["guard"]);
  assert.deepEqual(detectRemovedChecks([{ file: "src/f.js", before: asserted, after: asserted.replace("x.tenantId", "true") }]).map((c) => c.kind), ["validation"]);
});

test("noise: a removed check is cited at a line inside the diff's hunks", () => {
  const sql = "SELECT *\nFROM orders\nWHERE tenant_id = $1\n" + Array.from({ length: 10 }, (_, k) => `  AND c${k} = ${k}\n`).join("") + "  AND deleted = false;\n";
  const fileChanges = [{ file: "db/orders.sql", before: sql, after: sql.replace("deleted = false", "deleted IS NOT TRUE") }];
  const checks = detectRemovedChecks(fileChanges);
  assert.deepEqual(checks.map((c) => [c.kind, c.line]), [["tenant-filter", 14]]);
  assert.match(checks[0].reason, /db\/orders\.sql:14\.$/);
  // The cited old line is within the rendered hunk's old-side span.
  const [, from, count] = /@@ -(\d+),(\d+) /.exec(trustDiffEvidence(fileChanges)).map(Number);
  assert.ok(checks[0].line >= from && checks[0].line < from + count, `line ${checks[0].line} in hunk ${from},${count}`);
  // A check whose first line sits in the hunk keeps that line.
  const near = "WHERE tenant_id = $1\n  AND deleted = false;\n";
  assert.deepEqual(detectRemovedChecks([{ file: "db/a.sql", before: near, after: "WHERE 1 = 1\n  AND deleted = false;\n" }]).map((c) => c.line), [1]);
  // Of two identical guards, the one whose lines were removed is reported.
  const twice = "function a(user) {\n  if (!user) return;\n  go();\n}\n" + "\n".repeat(20) + "function b(user) {\n  if (!user) return;\n  go();\n}\n";
  const lines = twice.split("\n"), second = lines.indexOf("function b(user) {") + 2;
  const dropped = lines.filter((_, k) => k !== second - 1).join("\n");
  assert.deepEqual(detectRemovedChecks([{ file: "src/two.js", before: twice, after: dropped }]).map((c) => c.line), [second]);
});

const bigModule = (name, n) => Array.from({ length: n }, (_, k) => `export function ${name}${k}(input) {\n  const value = transform${k}(input);\n  return value + ${k};\n}\n`).join("");

test("noise: a rename or extracted module is judged on what was not moved", async () => {
  const body = bigModule("step", 900);
  assert.ok(trustDiffEvidence([{ file: "src/old.js", before: body, after: "" }, { file: "src/new.js", before: "", after: body }]).length > TRUST_EVIDENCE_CHARS);
  // A pure rename: nothing left to judge, and no "too large" flag.
  let seen = [];
  const renamed = await evaluateDiffTrust({ fileChanges: [{ file: "src/old.js", before: body, after: "" }, { file: "src/new.js", before: "", after: body }], ...judgeWith(seen) });
  assert.equal(seen.length, 0);
  assert.equal(renamed.judgment.status, "skipped: only moved code");
  assert.equal(renamed.level, "normal");
  assert.ok(!renamed.reasons.some((r) => /too large/.test(r.reason)));
  assert.equal(renamed.evidence.movedLines, body.split("\n").filter(Boolean).length * 2);
  // A move plus a small real change: the judge sees the change, not the move.
  seen = [];
  const moved = await evaluateDiffTrust({ fileChanges: [{ file: "src/old.js", before: body, after: "" },
    { file: "src/new.js", before: "", after: body.replace("return value + 7;", "return value - 7;") }], ...judgeWith(seen) });
  assert.equal(seen.length, 1);
  assert.ok(seen[0].length < 2000, `residual evidence is small (${seen[0].length})`);
  assert.match(seen[0], /\+  return value - 7;/);
  assert.match(seen[0], /moved or renamed code, are omitted/);
  assert.equal(moved.judgment.status, "available");
  assert.ok(!moved.reasons.some((r) => /too large/.test(r.reason)));
});

test("noise: a declared refactor drops moved lines even when most of it is new, and only a large residual is flagged", async () => {
  const body = bigModule("step", 300), fresh = bigModule("brandNew", 800);
  const fileChanges = [{ file: "src/old.js", before: body, after: "" }, { file: "src/new.js", before: "", after: body + fresh }];
  const plain = await evaluateDiffTrust({ fileChanges, judgment: true, ...judgeWith([]) });
  assert.ok(plain.reasons.some((r) => /too large to judge/.test(r.reason)), "an ordinary job keeps the full evidence");
  const seen = [];
  const refactor = await evaluateDiffTrust({ fileChanges: [{ file: "src/old.js", before: body, after: "" }, { file: "src/new.js", before: "", after: body + bigModule("brandNew", 80) }], refactor: true, ...judgeWith(seen) });
  assert.equal(seen.length, 1);
  assert.equal(refactor.evidence.refactor, true);
  assert.ok(!refactor.reasons.some((r) => /too large/.test(r.reason)));
  const big = await evaluateDiffTrust({ fileChanges, refactor: true, ...judgeWith([]) });
  const flag = big.reasons.find((r) => /too large to judge/.test(r.reason));
  assert.ok(flag, "a residual over the cap is still flagged");
  assert.match(flag.reason, /after omitting \d+ moved lines/);
  // Small diffs are untouched: no evidence record, same evidence text.
  const small = await evaluateDiffTrust({ fileChanges: [{ file: "src/a.js", before: "a();\n", after: "b();\n" }], refactor: true, judgment: false });
  assert.equal(small.evidence, undefined);
});

test("status: a huge record's default and report views stay under the budget and keep outcome, commit and the first issues", () => {
  const files = Array.from({ length: 400 }, (_, k) => `src/module${k}/deeply/nested/file${k}.js`);
  const meta = { jobId: "job-huge", mode: "implement", outcome: "WORKER_DONE", coordinatorStatus: "complete", reviewRequired: true,
    trust: { level: "review", reasons: files.map((file, k) => ({ rule: "removed-check", reason: `Removes or changes an access guard at ${file}:${k + 1}.`, file, line: k + 1 })),
      checks: files.map((file, k) => ({ kind: "guard", file, line: k + 1, reason: `Removes or changes an access guard at ${file}:${k + 1}.` })),
      judgment: { status: "available", validator: "judge", answers, error: null } },
    issues: ["first issue: verification passed with warnings", ...files.map((f) => `TEST CHANGE REVIEW: ${f} weakened an assertion`)],
    reportValidation: { fields: { STATUS: "done", VERIFICATION: "pass", SUMMARY: "x".repeat(20000), FILES: files.join(", ") } },
    independentVerification: { status: "pass", failingTests: files },
    regressionCheck: { status: "pass" },
    commit: { created: true, sha: "0123456789abcdef0123456789abcdef01234567" }, branch: "agent/job-huge",
    git: { changedFiles: files, additions: 90000, deletions: 80000 } };
  const full = reportView(meta);
  assert.ok(JSON.stringify(full, null, 2).length > 50000, "the unbounded view is huge");
  const view = boundStatusView(full);
  const text = JSON.stringify(view, null, 2);
  assert.ok(text.length <= STATUS_VIEW_CHARS, `report view is ${text.length} characters`);
  assert.equal(view.outcome, "WORKER_DONE");
  assert.equal(view.commit.sha, meta.commit.sha);
  assert.equal(view.issues[0], meta.issues[0]);
  assert.match(text, /full=true/);
  assert.match(text, /commit_show/);
  assert.equal(view.trust.level, "review");
  assert.match(text, /access guard at 400 places/);
  // The default summary view is bounded the same way.
  const summary = boundStatusView({ jobId: "job-huge", state: "finished", outcome: "WORKER_DONE", commit: meta.commit.sha, issues: meta.issues.map((i) => i.repeat(30)), reportMismatch: { failingTests: files } });
  assert.ok(JSON.stringify(summary, null, 2).length <= STATUS_VIEW_CHARS);
  assert.equal(summary.commit, meta.commit.sha);
  // A view already under the budget is returned unchanged.
  const small = reportView({ jobId: "s", mode: "implement", outcome: "WORKER_DONE", issues: ["one"] });
  assert.equal(boundStatusView(small), small);
  // The full record is never bounded: reportView itself is unchanged.
  assert.equal(full.changedFiles.length, 400);
});

test("status: trust reasons that differ only by place collapse, distinct ones stay", () => {
  const reasons = [
    { rule: "removed-check", reason: "Removes or changes an access guard at a.js:1.", file: "a.js", line: 1 },
    { rule: "removed-check", reason: "Removes or changes an access guard at b.js:2.", file: "b.js", line: 2 },
    { rule: "removed-check", reason: "Removes or changes a tenant or ownership filter at c.sql:3.", file: "c.sql", line: 3 },
    { rule: 0, reason: "changes auth/check.py, which the repo marks sensitive", file: "auth/check.py" },
  ];
  assert.deepEqual(collapseTrustReasons(reasons), [
    { rule: "removed-check", reason: "Removes or changes an access guard at 2 places: a.js:1, b.js:2." },
    reasons[2], reasons[3],
  ]);
});
