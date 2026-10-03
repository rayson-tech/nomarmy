import "./helpers/isolate-global-config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createExecutor } from "../lib/execute.mjs";
import { plantWorktreePointer } from "./helpers/worktree-fixture.mjs";

const prose = "PRIVATE_RAW_REPLY_SENTINEL: the editor's complete rewrite is not a cited finding.";
const scoutReport = (citation = "") => `SCOUT REPORT\nQUESTION: Inspect answer\nCONFIDENCE: high\nFINDING: answer returns 42 ${citation}\nNOT_FOUND: none\nEND`;
const decomposeReport = (citation = "") => `DECOMPOSE REPORT\nOBJECTIVE: Improve answer\nCONFIDENCE: high\nSUBTASK: Document answer\nACCEPTANCE: Explain answer\nFILES: ${citation || "missing.py"}\nNOT_SPLITTABLE: none\nEND`;

for (const mode of ["scout", "decompose"]) {
  test(`${mode}: citation-free results locate the selected reply without leaking raw text`, async t => {
    const root = fs.mkdtempSync(path.join(process.cwd(), ".reply-log-test-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const projectDir = path.join(root, "repo"), jobsRoot = path.join(root, "jobs");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(jobsRoot);
    const report = mode === "scout" ? scoutReport : decomposeReport;
    const scenarios = [
      { id: "uncited", replies: [report()], supported: 0 },
      { id: "unresolved", replies: [report("[missing.py:1]")], supported: 0 },
      { id: "unparsed", replies: [prose, prose], supported: 0 },
      { id: "resolved", replies: [report("[answer.py:1]")], supported: 1 },
      { id: "file-only", replies: [report("[answer.py]")], supported: 1 },
    ];
    if (mode === "scout") scenarios.push(
      { id: "recovered-uncited", replies: [prose, report()], supported: 0, recovered: true },
      { id: "recovered-resolved", replies: [prose, report("[answer.py:1]")], supported: 1, recovered: true },
      { id: "recovery-failed", replies: [prose, new Error("recovery unavailable")], supported: 0 },
      { id: "mixed", replies: [scoutReport().replace("NOT_FOUND:", "FINDING: answer returns 42 [answer.py:1]\nNOT_FOUND:")], supported: 1 },
    );
    for (const scenario of scenarios) {
      const calls = [];
      const executor = createExecutor({ VERSION: "test", projectDir, jobsRoot,
        assertRepo: async () => {}, ensureJobsRoot: () => {}, resolveBase: async () => ({ sha: "base", ref: "main" }),
        sweepStaleSandboxContainers: async () => {},
        run: async (_command, args) => { if (args[1] === "add") plantWorktreePointer(args[3], projectDir); },
        gitRaw: async args => args[1] === "base:answer.py" ? "answer = 42\n" : null,
        collectGitRecord: async () => ({ repoStatusFiles: [] }),
        budgetState: { budgets: { scout: {}, decompose: {}, report: { scout: { targetTokens: 600, hardCapTokens: 1024 } } } },
        runOpenClaw: async ({ jobDir, logSuffix = "" }) => {
          const reply = scenario.replies[calls.length];
          calls.push(logSuffix);
          if (reply instanceof Error) throw reply;
          assert.equal(typeof reply, "string", "unexpected worker call");
          const result = { final: reply };
          fs.writeFileSync(path.join(jobDir, `openclaw${logSuffix}.stdout.log`), JSON.stringify(result) + "\n");
          return result;
        },
        buildMetrics: () => ({}), recordedBudgets: () => ({}), resolveReasoningApplied: () => "high", execution: {},
      });
      const result = await executor.executeJob({ task: "Inspect answer", mode, jobId: scenario.id });
      assert.deepEqual(Object.keys(result).sort(), ["jobDir", "manifest", "ok", "report"]);
      assert.equal(result.manifest[mode]?.supported, scenario.supported, JSON.stringify(result.manifest));
      const recovered = Boolean(scenario.recovered);
      if (mode === "scout") assert.equal(result.manifest.reportRecovered, recovered, scenario.id);
      const recoveryAttempted = mode === "scout" && scenario.replies.length === 2;
      assert.deepEqual(calls, recoveryAttempted ? ["", "-recovery"] : [""], scenario.id);
      const log = path.join(result.jobDir, `openclaw${recovered ? "-recovery" : ""}.stdout.log`);
      const expectedIssue = `No finding had a resolved citation. Full worker reply: ${log}. The scout format requires cited findings; prose belongs in an implement job on a file.`;
      assert.deepEqual(result.manifest.issues.filter(issue => issue.includes("Full worker reply:")), scenario.supported ? [] : [expectedIssue], scenario.id);
      assert.deepEqual(JSON.parse(fs.readFileSync(log, "utf8")), { final: scenario.replies[recovered ? 1 : 0] });
      assert.equal(JSON.stringify(result).includes("PRIVATE_RAW_REPLY_SENTINEL"), false, scenario.id);
      assert.equal(JSON.stringify(result).includes(scenario.replies[recovered ? 1 : 0].replaceAll("\n", "\\n")), false, "raw report must not be appended");
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.jobDir, "metadata.json"), "utf8")).issues, result.manifest.issues);
    }
  });
}
