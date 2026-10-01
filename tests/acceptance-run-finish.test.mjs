import "./helpers/isolate-global-config.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createRun, DEFAULT_RUN_LIMITS } from "../lib/runs.mjs";

test("run_finish delivers its real acceptance verdict including check errors and no-contract omission", async t => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".acceptance-finish-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previous = process.env.NOMARMY_PROJECT_DIR;
  process.env.NOMARMY_PROJECT_DIR = root;
  t.after(() => { if (previous === undefined) delete process.env.NOMARMY_PROJECT_DIR; else process.env.NOMARMY_PROJECT_DIR = previous; });
  let finish;
  const original = McpServer.prototype.tool;
  t.mock.method(McpServer.prototype, "tool", function (...args) {
    if (args[0] === "run_finish") finish = args.at(-1);
    return original.apply(this, args);
  });
  await import("../mcp/server.mjs");
  fs.mkdirSync(path.join(root, "acceptance"));
  fs.writeFileSync(path.join(root, "example.test.mjs"), 'import test from "node:test"; test("works", () => {});');
  const file = path.join(root, "acceptance/example.yml");
  const source = 'feature: Example\ncriteria:\n  - id: ACC-1\n    text: first\n    proven_by: [{file: example.test.mjs, test: works}]\n    status: unproven\n';
  const runsRoot = path.join(process.env.NOMARMY_AGENT_STATE, "runs");
  for (const state of ["met", "broken", "unproven", "error", "none"]) {
    if (state === "none") fs.unlinkSync(file);
    else fs.writeFileSync(file, state === "error" ? "criteria: [" : state === "unproven" ? source.replace('[{file: example.test.mjs, test: works}]', '[]') : source);
    fs.writeFileSync(path.join(root, "example.test.mjs"), `import test from "node:test"; test("works", () => { ${state === "broken" ? 'throw Error("failed")' : ''} });`);
    const run = createRun(runsRoot, { name: "acceptance", repo: root, limits: DEFAULT_RUN_LIMITS });
    let timerFired = false;
    const timer = setTimeout(() => { timerFired = true; }, 0);
    const response = await finish({ run_id: run.id, status: "complete", summary: "tested" });
    clearTimeout(timer);
    assert.equal(timerFired, true, "run_finish must yield the server event loop during acceptance");
    assert.deepEqual(Object.keys(response).sort(), ["content", "isError"]);
    assert.equal(response.isError, false);
    const data = JSON.parse(response.content[0].text);
    assert.deepEqual(Object.keys(data).sort(), ["byAgent", "id", "prBlock", "prBlockNote", "share", "status", "used", "warnings"]);
    assert.equal(data.status, "complete");
    const rows = data.prBlock.split("\n").filter(l => l.startsWith("| Acceptance |"));
    if (state === "error") { assert.equal(rows.length, 1); assert.equal(rows[0].startsWith("| Acceptance | couldn't run: "), true); }
    else assert.deepEqual(rows, state === "none" ? [] : [`| Acceptance | 1 ${state}${state === "met" ? "" : " (ACC-1)"} |`]);
  }
});
