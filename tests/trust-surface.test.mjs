import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { reportView } from "../lib/job-format.mjs";
import { gatedJobs, computeStats, formatStatsSummary, formatStats } from "../lib/stats.mjs";
import { shareMarkdown } from "../lib/share.mjs";
import { COORDINATOR_INSTRUCTIONS } from "../lib/coordinator-instructions.mjs";

const access = { rule: 0, reason: "changes auth/check.py, which the repo marks sensitive: access control and tenant data", file: "auth/check.py" };
const rules = { rule: "trust", reason: "changes the repository's trust rules", file: ".nomarmy.yml" };
const record = (jobId, runId, trust) => ({ jobId, mode: "implement", outcome: "WORKER_DONE", projectDir: "/r",
  startedAt: "2026-09-30T00:00:00.000Z", labels: { runId }, ...(trust ? { trust } : {}) });
const human = (reasons) => ({ level: "human", reasons });

test("trust report view places exact trust immediately after outcome when present", () => {
  const meta = record("a", "run-x", human([access]));
  const view = reportView(meta);
  assert.deepEqual(Object.keys(view), ["jobId", "mode", "outcome", "trust", "coordinatorStatus", "reviewRequired", "issues", "report", "verification", "revertCheck", "commit", "changedFiles", "additions", "deletions"]);
  assert.deepEqual(view.trust, human([access]));
  assert.deepEqual(Object.keys(reportView(record("b", "run-x"))), Object.keys(view).filter((key) => key !== "trust"));
});

test("trust feature playbook stops before integration and coordinator repeats the hard gate", () => {
  const playbook = fs.readFileSync(new URL("../playbooks/feature.md", import.meta.url), "utf8");
  assert.match(playbook, /trust\.level: human[^\n]*not integrated until the operator explicitly says so/);
  assert.match(playbook, /show the operator every `trust\.reasons` entry on its own line, and wait/);
  assert.match(COORDINATOR_INSTRUCTIONS, /trust\.level: human is a hard stop before integration/);
  assert.match(COORDINATOR_INSTRUCTIONS, /show every trust reason to the operator and wait for explicit approval/);
});

test("trust run_finish lists only its human-gated jobs with exact reasons", () => {
  const records = [record("a", "run-x", human([access, rules])), record("b", "run-y", human([rules])),
    record("c", "run-x", { level: "normal", reasons: [] }), record("d", "run-x")];
  assert.deepEqual(gatedJobs(records, "run-x"), [{ jobId: "a", reasons: [access, rules] }]);
  assert.deepEqual(gatedJobs(records, "run-none"), []);
  const server = fs.readFileSync(new URL("../mcp/server.mjs", import.meta.url), "utf8");
  const finish = server.slice(server.indexOf('server.tool("run_finish"'), server.indexOf('server.tool("army"'));
  assert.match(finish, /gated = gatedJobs\(records, run_id\)/);
  assert.match(finish, /\.\.\.\(gated\.length \? \{ gated \} : \{\}\)/);
});

test("trust PR block shows gated count and short reasons only for scoped jobs", () => {
  const records = [record("a", "run-x", human([access, rules])), record("b", "run-x", human([access])),
    record("c", "run-y", human([{ ...access, reason: "other: hidden" }]))];
  const md = shareMarkdown(computeStats(records, { runId: "run-x" }));
  assert.match(md, /\| Needs human review \| 2 changes: access control and tenant data; the repository's trust rules \|/);
  assert.doesNotMatch(md, /hidden/);
  assert.doesNotMatch(shareMarkdown(computeStats([record("d", "run-x")], { runId: "run-x" })), /Needs human review/);
});

test("trust stats counts human-gated jobs in summary and details", () => {
  const stats = computeStats([record("a", "run-x", human([access])), record("b", "run-x", human([rules])),
    record("c", "run-x", { level: "normal", reasons: [] })], { runId: "run-x" });
  assert.deepEqual(stats.humanReview, { jobs: 2, reasons: [access.reason, rules.reason] });
  assert.match(formatStatsSummary(stats), /HUMAN\s+2 job\(s\) need human review: changes auth\/check\.py/);
  assert.match(formatStats(stats), /Human-gated jobs\s+2: changes auth\/check\.py/);
});
