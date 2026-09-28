import assert from "node:assert/strict";
import test from "node:test";

import { shareMarkdown, badgeSvg, badgeMarkdown } from "../lib/share.mjs";
import { computeStats } from "../lib/stats.mjs";

const job = (over) => ({ mode: "implement", projectDir: "/r", startedAt: new Date().toISOString(), outcome: "WORKER_DONE", issues: [],
  reportValidation: { status: "done", tests: "pass" }, independentVerification: { status: "pass" }, regressionCheck: { status: "pass" },
  commit: { created: true }, git: { additions: 10, deletions: 2, changedFiles: ["a.js"] },
  testChanges: { new_tests_added: ["a.test.js"], existing_tests_modified: [], existing_tests_deleted: [], production_files_changed: ["a.js"] },
  labels: { runId: "run-x" }, metrics: {}, ...over });

const records = [job({ jobId: "a" }), job({ jobId: "b" }), job({ jobId: "c", independentVerification: { status: "fail" }, commit: { created: false } }),
  job({ jobId: "d", labels: { runId: "run-other" } })];

test("the PR block: claims that held up, what was caught and why, proven tests, scoped to one run", () => {
  const md = shareMarkdown(computeStats(records, { runId: "run-x" }), { scope: "this feature run" });
  assert.match(md, /^### ✓ Verified by nomArmy \(this feature run\)$/m);
  assert.match(md, /\| Worker claims checked \| 2 of 3 "done, tests pass" claims held up; 1 caught \(1 failed when nomArmy ran the tests itself\) \|/);
  assert.match(md, /\| Tests proven \| 2 new test file\(s\) shown to fail without their change \|/);
  assert.match(md, /\| Work committed \| 2 verified job\(s\), \+20 \/ -4 lines \|/);
  assert.match(md, /not the workers' own reports/);
  assert.doesNotMatch(md, /—/, "no em dashes");
});

test("the badge counts what nomArmy checked and caught, in a neutral color; green when everything held up", () => {
  const caught = badgeSvg(computeStats(records, { runId: "run-x" }));
  assert.match(caught, /aria-label="nomArmy: 3 claims checked · 1 caught"/);
  assert.match(caught, /fill="#0969da"/);
  const clean = badgeSvg(computeStats(records.slice(0, 2)));
  assert.match(clean, /2 claims checked, all held up/);
  assert.match(clean, /fill="#2da44e"/);
  assert.match(badgeSvg(computeStats([])), /nomArmy: verified/);
  assert.equal(badgeMarkdown(".github/nomarmy-badge.svg"), "[![nomArmy](.github/nomarmy-badge.svg)](https://github.com/rayson-tech/nomarmy)");
});
