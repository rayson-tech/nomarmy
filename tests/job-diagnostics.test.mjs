import assert from "node:assert/strict";
import test from "node:test";

import { resolveOutcome } from "../lib/outcome.mjs";
import { parseWorkerReport } from "../lib/report.mjs";
import { jobLabel, jobElapsedSeconds } from "../lib/job-format.mjs";

const donePass = parseWorkerReport("STATUS: done\nTESTS: pass\nNOT_DONE: none\nNOTE: changed the prompt");
const failed = (detail) => ({ status: "fail", profile: "python", basis: "1 command", reason: null, detail });

test("a failed verification's issue names the command, exit code and output tail", () => {
  const detail = "command 1 of 1 (`python3 -m pytest -q`) failed with exit code 1 (last output: test_prompt_rules FAILED)";
  const out = resolveOutcome({ report: donePass, repositoryChanged: true, independentVerification: failed(detail) });
  assert.equal(out.outcome, "NEEDS_REVIEW");
  assert.deepEqual(out.reasons, [`worker claimed done/pass but independent verification failed: ${detail}`]);
  // An invalid report whose recovery hit a failed verification says why too.
  const invalid = resolveOutcome({ report: parseWorkerReport("done!"), repositoryChanged: true, independentVerification: failed(detail) });
  assert.equal(invalid.reasons.at(-1), `independent verification FAILED: ${detail}`);
});

test("a failed verification's issue is capped, and plain when there is no detail", () => {
  const long = `command 1 of 1 failed with exit code 2 (last output: ${"x".repeat(2000)})`;
  const [reason] = resolveOutcome({ report: donePass, repositoryChanged: true, independentVerification: failed(long) }).reasons;
  assert.ok(reason.length < 700, `capped, got ${reason.length}`);
  assert.ok(reason.endsWith("..."));
  const [plain] = resolveOutcome({ report: donePass, repositoryChanged: true, independentVerification: failed(null) }).reasons;
  assert.equal(plain, "worker claimed done/pass but independent verification failed");
});

test("jobElapsedSeconds stops at the job's finish instead of counting to now", () => {
  const startedAt = "2026-09-26T14:36:43.000Z";
  const now = Date.parse("2026-09-26T17:03:36.000Z");
  // The whole job's own measure wins: an implement job's finishedAt is the worker's end.
  assert.equal(jobElapsedSeconds({ status: { startedAt, state: "finished", updatedAt: "2026-09-26T14:46:14.000Z" },
    meta: { finishedAt: "2026-09-26T14:45:58.000Z", metrics: { total_elapsed: 571600 } }, now }), 572);
  assert.equal(jobElapsedSeconds({ status: { startedAt, state: "finished", updatedAt: "2026-09-26T14:46:14.000Z" }, now }), 571);
  assert.equal(jobElapsedSeconds({ meta: { startedAt, finishedAt: "2026-09-26T14:45:58.000Z" }, now }), 555);
  // Still running: now minus start.
  assert.equal(jobElapsedSeconds({ status: { startedAt, state: "running", updatedAt: "2026-09-26T14:40:00.000Z" }, now }), 8813);
  assert.equal(jobElapsedSeconds({ now }), null);
});

test("jobLabel names a job by its commit subject, else the task's first sentence", () => {
  assert.equal(jobLabel({ commit_subject: "Keep held-back tables in the cache", task: "Long task." }), "Keep held-back tables in the cache");
  assert.equal(jobLabel({ task: "Add the settings page. It needs a form and tests.\nMore." }), "Add the settings page.");
  assert.equal(jobLabel({ task: "a".repeat(80) }), `${"a".repeat(57)}...`);
  assert.equal(jobLabel({}), null);
});

import { detectVerificationInputChanges } from "../lib/diff-checks.mjs";

function inputs(commands, changedFiles, base = {}, head = {}) {
  return detectVerificationInputChanges({ commands, changedFiles, readBase: async (f) => base[f] ?? null, readHead: (f) => head[f] ?? null });
}

test("a changed script a verification command runs blocks, found live as check.js rewritten to exit 0", async () => {
  assert.deepEqual(await inputs(["node check.js"], ["check.js", "greet.js"]),
    { blocked: [{ file: "check.js", command: "node check.js", why: "run by `node check.js`" }], flagged: [] });
  assert.deepEqual((await inputs(["CI=1 bash ./scripts/verify.sh --fast"], ["scripts/verify.sh"])).blocked.map((b) => b.file), ["scripts/verify.sh"]);
  assert.deepEqual((await inputs(["cd api && ./run-tests.sh"], ["api/run-tests.sh"])).blocked.map((b) => b.file), ["api/run-tests.sh"]);
  assert.deepEqual((await inputs(["make test"], ["Makefile"])).blocked.map((b) => b.why), ["read by `make test`"]);
  // Unrelated changes, and commands that only mention a variable: nothing.
  assert.equal(await inputs(["node check.js"], ["greet.js"]), null);
  assert.equal(await inputs(["python3 -m pytest $NOMARMY_CHANGED_TEST_FILES -q"], ["app.py"]), null);
});

test("a test file named by a command is left to test-change review, not blocked", async () => {
  assert.equal(await inputs(["python3 -m pytest tests/test_api.py -q"], ["tests/test_api.py"]), null);
});

test("package.json blocks only when the script the command runs changed", async () => {
  const base = { "package.json": JSON.stringify({ scripts: { test: "node --test", pretest: "tsc", lint: "eslint ." } }) };
  const weakened = { "package.json": JSON.stringify({ scripts: { test: "exit 0", pretest: "tsc", lint: "eslint ." } }) };
  const depsOnly = { "package.json": JSON.stringify({ scripts: { test: "node --test", pretest: "tsc", lint: "eslint ." }, dependencies: { a: "1" } }) };
  assert.deepEqual((await inputs(["npm test"], ["package.json"], base, weakened)).blocked.map((b) => b.why), ["its script \"test\" changed, and `npm test` runs it"]);
  assert.equal(await inputs(["npm test"], ["package.json"], base, depsOnly), null, "a dependency edit isn't a weakened check");
  assert.equal(await inputs(["npm run lint"], ["package.json"], base, weakened), null, "a different script changed");
  const pretest = { "package.json": JSON.stringify({ scripts: { test: "node --test", lint: "eslint ." } }) };
  assert.match((await inputs(["pnpm test"], ["package.json"], base, pretest)).blocked[0].why, /"pretest" changed/);
  const nested = { "web/package.json": base["package.json"] }, nestedWeak = { "web/package.json": weakened["package.json"] };
  assert.deepEqual((await inputs(["cd web && yarn test"], ["web/package.json"], nested, nestedWeak)).blocked.map((b) => b.file), ["web/package.json"]);
  assert.equal(await inputs(["bun test"], ["package.json"], base, weakened), null, "bun test is bun's own runner");
});

test("test-runner configuration is flagged, not blocked", async () => {
  const base = { "pyproject.toml": "[project]\nname = \"x\"\n\n[tool.pytest.ini_options]\naddopts = \"-q\"\n" };
  const narrowed = { "pyproject.toml": "[project]\nname = \"x\"\n\n[tool.pytest.ini_options]\naddopts = \"-q -k 'not slow'\"\n" };
  const versionBump = { "pyproject.toml": "[project]\nname = \"x\"\nversion = \"2\"\n\n[tool.pytest.ini_options]\naddopts = \"-q\"\n" };
  assert.deepEqual(await inputs(["pytest"], ["conftest.py", "vitest.config.ts", "pyproject.toml"], base, narrowed), { blocked: [], flagged: [
    { file: "conftest.py", why: "test-runner configuration" }, { file: "vitest.config.ts", why: "test-runner configuration" },
    { file: "pyproject.toml", why: "its [tool.pytest] settings changed" }] });
  assert.equal(await inputs(["pytest"], ["pyproject.toml"], base, versionBump), null);
});
