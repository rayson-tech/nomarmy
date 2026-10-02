import "./helpers/isolate-global-config.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createRun, DEFAULT_RUN_LIMITS } from "../lib/runs.mjs";

test("run_finish reports sandbox unavailable without launching host acceptance tests", async t => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".acceptance-finish-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previous = process.env.NOMARMY_PROJECT_DIR;
  process.env.NOMARMY_PROJECT_DIR = root;
  t.after(() => { if (previous === undefined) delete process.env.NOMARMY_PROJECT_DIR; else process.env.NOMARMY_PROJECT_DIR = previous; });
  const gitCalls = [], hostCalls = [];
  const git = t.mock.method(childProcess, "execFile", (command, args, options, callback) => {
    assert.equal(command, "git");
    gitCalls.push(args);
    if (args[1] === "add") fs.mkdirSync(args[3]);
    else fs.rmSync(args[3], { recursive: true });
    setImmediate(() => callback(null, "", ""));
  });
  const host = t.mock.method(childProcess, "spawn", (command, args) => {
    hostCalls.push([command, args]);
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    setImmediate(() => child.emit("error", new Error("no Podman")));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { git.mock.restore(); host.mock.restore(); syncBuiltinESMExports(); });
  let finish;
  const original = McpServer.prototype.tool;
  t.mock.method(McpServer.prototype, "tool", function (...args) {
    if (args[0] === "run_finish") finish = args.at(-1);
    return original.apply(this, args);
  });
  await import("../mcp/server.mjs");
  const runsRoot = path.join(process.env.NOMARMY_AGENT_STATE, "runs");
  const run = createRun(runsRoot, { name: "acceptance", repo: root, limits: DEFAULT_RUN_LIMITS });
  const response = await finish({ run_id: run.id, status: "complete", summary: "tested" });
  assert.deepEqual(Object.keys(response).sort(), ["content", "isError"]);
  assert.equal(response.isError, false);
  const data = JSON.parse(response.content[0].text);
  assert.deepEqual(Object.keys(data).sort(), ["byAgent", "id", "prBlock", "prBlockNote", "share", "status", "used", "warnings"]);
  assert.equal(data.status, "complete");
  assert.deepEqual(data.prBlock.split("\n").filter(l => l.startsWith("| Acceptance |")), ["| Acceptance | couldn't run: sandbox unavailable |"]);
  assert.deepEqual(hostCalls, [["podman", ["version", "--format", "{{.Server.Version}}"]]]);
  assert.equal(gitCalls.length, 2);
  assert.deepEqual(gitCalls[0], ["worktree", "add", "--detach", gitCalls[0][3], "HEAD"]);
  assert.deepEqual(gitCalls[1], ["worktree", "remove", "--force", gitCalls[0][3]]);
});
