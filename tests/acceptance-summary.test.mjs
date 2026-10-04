import "./helpers/isolate-global-config.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { acceptanceSummary, shareMarkdown } from "../lib/share.mjs";
import { computeStats } from "../lib/stats.mjs";
import { assertChecker, fixtureWorktree } from "./helpers/acceptance-sandbox.mjs";

const output = criteria => JSON.stringify({ contracts: [{ criteria }] });
const criterion = (id, status) => ({ id, status });
const cases = [
  ["met", output([criterion("ACC-1", "met")]), 0, "1 met"],
  ["broken exit 1", output([criterion("ACC-1", "broken")]), 1, "1 broken (ACC-1)"],
  ["unproven", output([criterion("ACC-1", "unproven")]), 0, "1 unproven (ACC-1)"],
  ["mixed ordered statuses", output([criterion("ACC-1", "retired"), criterion("ACC-2", "missing"), criterion("ACC-3", "met"), criterion("ACC-4", "unproven"), criterion("ACC-5", "broken"), criterion("ACC-6", "broken")]), 1,
    "1 met, 2 broken (ACC-5, ACC-6), 1 missing (ACC-2), 1 unproven (ACC-4), 1 retired (ACC-1)"],
  ["no contracts", '{"contracts":[]}', 0, null],
  ["empty contract", output([]), 0, "0 met"],
  ["garbage output", "not JSON", 1, "couldn't run: acceptance check returned non-JSON output"],
  ["invalid JSON shape", '{}', 0, "couldn't run: acceptance check returned invalid JSON result"],
  ["invalid criterion", output([criterion("ACC-1", "unknown")]), 0, "couldn't run: acceptance check returned invalid JSON result"],
];
function fixture(t) {
  const repo = fs.mkdtempSync(path.join(process.cwd(), ".acceptance-summary-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  return repo;
}
for (const [name, stdout, code, expected] of cases) {
  test(`async acceptance summary: ${name}`, async t => {
    t.mock.method(Date, "now", () => 1_000);
    const repo = fixture(t), calls = [], gitCalls = [];
    const actual = await acceptanceSummary(repo, { run: fixtureWorktree(repo, gitCalls), executor: {
      probe: async () => ({ available: true }),
      run: async input => {
        calls.push(input); assertChecker(input);
        await new Promise(resolve => setImmediate(resolve));
        return { started: true, stdout, exitCode: code };
      },
    } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "/usr/local/bin/node /nomarmy-acceptance/bin/nomarmy.mjs acceptance check --json");
    assert.equal(calls[0].timeoutMs, 300_000);
    assert.equal(calls[0].cwd, gitCalls[0][1][3]);
    assert.equal(fs.existsSync(calls[0].cwd), false);
    assert.equal(gitCalls.length, 2);
    assert.equal(actual, expected);
    const md = shareMarkdown(computeStats([]), { acceptance: actual });
    assert.equal(typeof md, "string");
    assert.deepEqual(md.split("\n").filter(line => line.startsWith("| Acceptance |")), expected === null ? [] : [`| Acceptance | ${expected} |`]);
    assert.equal(md.includes("\u2014"), false);
  });
}

test("PR acceptance uses a detached HEAD sandbox and never a host test spawner", async t => {
  const repo = fixture(t), calls = [];
  const host = t.mock.method(childProcess, "spawn", () => { throw new Error("host spawn forbidden"); });
  syncBuiltinESMExports();
  t.after(() => { host.mock.restore(); syncBuiltinESMExports(); });
  fs.writeFileSync(path.join(repo, "uncommitted.txt"), "operator changes");
  let cwd;
  const result = await acceptanceSummary(repo, {
    run: async (command, args, options) => {
      calls.push([command, args, options]);
      if (args[1] === "add") { cwd = args[3]; fs.mkdirSync(cwd); fs.writeFileSync(path.join(cwd, "committed.txt"), "HEAD"); }
      else fs.rmSync(args[3], { recursive: true });
    },
    executor: { probe: async () => ({ available: true }), run: async input => {
      assertChecker(input);
      assert.equal(input.cwd, cwd);
      assert.equal(fs.existsSync(path.join(input.cwd, "uncommitted.txt")), false);
      assert.equal(fs.readFileSync(path.join(input.cwd, "committed.txt"), "utf8"), "HEAD");
      assert.equal(input.network, "none");
      // The runner passes the smaller of the command timeout and what's left of
      // the overall budget, so a slow machine sees a few ms under 300000.
      assert.ok(input.timeoutMs <= 300_000 && input.timeoutMs > 290_000, String(input.timeoutMs));
      return { started: true, exitCode: 0, stdout: output([criterion("ACC-1", "met")]) };
    } },
  });
  assert.equal(result, "1 met");
  assert.deepEqual(calls, [
    ["git", ["worktree", "add", "--detach", cwd, "HEAD"], { cwd: repo, timeout: 300_000 }],
    ["git", ["worktree", "remove", "--force", cwd], { cwd: repo, timeout: 300_000 }],
  ]);
  assert.equal(host.mock.callCount(), 0);
  assert.equal(fs.existsSync(path.dirname(cwd)), false);
});

test("PR acceptance without a sandbox reports unavailable and cleans up HEAD", async t => {
  const repo = fixture(t), calls = [];
  const host = t.mock.method(childProcess, "spawn", () => { throw new Error("host spawn forbidden"); });
  syncBuiltinESMExports();
  t.after(() => { host.mock.restore(); syncBuiltinESMExports(); });
  let runs = 0;
  assert.equal(await acceptanceSummary(repo, { run: fixtureWorktree(repo, calls), executor: {
    probe: async () => ({ available: false, reason: "no Podman" }), run: async () => { runs++; },
  } }), "couldn't run: sandbox unavailable");
  assert.equal(runs, 0);
  assert.equal(host.mock.callCount(), 0);
  assert.equal(calls.length, 2);
  assert.equal(fs.existsSync(path.dirname(calls[0][1][3])), false);
});

test("PR acceptance sandbox timeout discards even valid JSON and removes HEAD", async t => {
  const repo = fixture(t), calls = [];
  assert.equal(await acceptanceSummary(repo, { timeoutMs: 100, run: fixtureWorktree(repo, calls), executor: {
    probe: async () => ({ available: true }), run: async input => {
      assertChecker(input); assert.equal(input.timeoutMs, 100);
      return { started: true, timedOut: true, exitCode: 0, stdout: output([criterion("ACC-1", "met")]) };
    },
  } }), "couldn't run: timed out after 100ms");
  assert.equal(calls.length, 2);
  assert.equal(fs.existsSync(path.dirname(calls[0][1][3])), false);
});
