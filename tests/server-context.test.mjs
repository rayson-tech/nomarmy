import "./helpers/isolate-global-config.mjs";
// Tests for lib/server-context.mjs: which repository jobs run against.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { createServerContext, projectDirProblem } from "../lib/server-context.mjs";

test("createServerContext: NOMARMY_PROJECT_DIR, then CLAUDE_PROJECT_DIR, then the start folder; an unexpanded placeholder counts as unset", () => {
  const cwd = "/home/someone";
  assert.equal(createServerContext({ env: {}, cwd }).projectDir, cwd);
  assert.equal(createServerContext({ env: { CLAUDE_PROJECT_DIR: "/r/claude" }, cwd }).projectDir, "/r/claude");
  assert.equal(createServerContext({ env: { NOMARMY_PROJECT_DIR: "/r/cursor", CLAUDE_PROJECT_DIR: "/r/claude" }, cwd }).projectDir, "/r/cursor");
  // A client that doesn't fill in ${workspaceFolder} passes it through literally.
  assert.equal(createServerContext({ env: { NOMARMY_PROJECT_DIR: "${workspaceFolder}" }, cwd }).projectDir, cwd);
  // Seen live: Cursor fills ${workspaceFolder} in as "~/...".
  assert.equal(createServerContext({ env: { NOMARMY_PROJECT_DIR: "~/Documents/source/nomarmy" }, cwd, homedir: "/Users/someone" }).projectDir, "/Users/someone/Documents/source/nomarmy");
  assert.equal(createServerContext({ env: { NOMARMY_PROJECT_DIR: "~" }, cwd, homedir: "/Users/someone" }).projectDir, "/Users/someone");
  assert.equal(createServerContext({ env: { NOMARMY_PROJECT_DIR: "/r/~odd" }, cwd }).projectDir, "/r/~odd", "only a leading ~ is the home folder");
});

test("projectDirProblem: a git repository is fine; anything else (the home folder) is refused with how to fix it", () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-not-a-repo-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-a-repo-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    fs.mkdirSync(path.join(repo, "sub"));
    assert.equal(projectDirProblem(repo), null);
    assert.equal(projectDirProblem(path.join(repo, "sub")), null, "a folder inside the repository is fine");
    const problem = projectDirProblem(plain);
    assert.match(problem, /isn't a git repository, so no job was sent/);
    assert.match(problem, /NOMARMY_PROJECT_DIR/);
  } finally {
    for (const dir of [plain, repo]) fs.rmSync(dir, { recursive: true, force: true });
  }
});
