import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { acceptanceSummary, shareMarkdown } from "../lib/share.mjs";
import { computeStats } from "../lib/stats.mjs";

const cli = fileURLToPath(new URL("../bin/nomarmy.mjs", import.meta.url));
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
  ["timeout", new Error("timed out after 300000ms"), null, "couldn't run: timed out after 300000ms"],
];
for (const [name, stdout, code, expected] of cases) {
  test(`async acceptance summary: ${name}`, async () => {
    const calls = [];
    const actual = await acceptanceSummary("/repo", { runner: async (...args) => {
      calls.push(args);
      await new Promise(resolve => setImmediate(resolve));
      if (stdout instanceof Error) throw stdout;
      return { stdout, code };
    } });
    assert.deepEqual(calls, [[process.execPath, [cli, "acceptance", "check", "--json"], { cwd: "/repo", timeoutMs: 300_000 }]]);
    assert.equal(actual, expected);
    const md = shareMarkdown(computeStats([]), { acceptance: actual });
    assert.equal(typeof md, "string", "markdown rendering remains synchronous");
    assert.deepEqual(md.split("\n").filter(line => line.startsWith("| Acceptance |")), expected === null ? [] : [`| Acceptance | ${expected} |`]);
    assert.equal(md.includes("\u2014"), false);
  });
}

test("async acceptance summary bounds a real slow child with the configured timeout", async t => {
  const repo = fs.mkdtempSync(path.join(process.cwd(), ".acceptance-timeout-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repo, "acceptance"));
  fs.writeFileSync(path.join(repo, "acceptance/slow.yml"), 'feature: Slow\ncriteria:\n  - id: ACC-1\n    text: slow check\n    status: unproven\n    proven_by: [{file: slow.test.mjs, test: slow}]\n');
  fs.writeFileSync(path.join(repo, "slow.test.mjs"), 'import test from "node:test"; test("slow", async () => { await new Promise(resolve => setTimeout(resolve, 2000)); });');
  assert.equal(await acceptanceSummary(repo, { timeoutMs: 100 }), "couldn't run: timed out after 100ms");
});
