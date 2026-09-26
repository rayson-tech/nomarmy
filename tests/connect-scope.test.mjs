import "./helpers/isolate-global-config.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { connectClaude, connectCodex, connectCursor, portableServerLaunch, excludeFromGit } from "../lib/connect.mjs";

function setup(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-scope-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const nomarmyRoot = path.join(base, "nomarmy"), installDir = path.join(base, "install"), projectDir = path.join(base, "repo");
  for (const dir of [path.join(nomarmyRoot, "mcp"), path.join(nomarmyRoot, "lib"), path.join(nomarmyRoot, "playbooks"), path.join(projectDir, ".git", "info")]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(nomarmyRoot, "package.json"), '{"name":"nomarmy","version":"0.1.0-alpha.11"}');
  fs.writeFileSync(path.join(nomarmyRoot, "mcp", "server.mjs"), "// server");
  fs.writeFileSync(path.join(nomarmyRoot, "playbooks", "feature.md"), "# feature");
  const calls = [];
  // A fake run: records every call with its cwd, answers git's exclude path and claude's mcp get.
  const run = (cmd, args, opts = {}) => {
    calls.push({ line: [cmd, ...args].join(" "), cwd: opts.cwd ?? null });
    if (cmd === "git" && args.includes("--git-path")) return ".git/info/exclude\n";
    if (cmd === "claude" && args[1] === "get") return "nomarmy-local-worker:\n  Scope: User config (available in all your projects)\n";
    return "";
  };
  return { nomarmyRoot, installDir, projectDir, calls, run, configDir: path.join(base, "config") };
}

test("claude --scope local: this repo only, the playbook kept out of git, and a note that user scope is still on", (t) => {
  const s = setup(t);
  const result = connectClaude({ nomarmyRoot: s.nomarmyRoot, installDir: s.installDir, run: s.run, configDir: s.configDir, scope: "local", projectDir: s.projectDir });
  const add = s.calls.find((c) => c.line.startsWith("claude mcp add"));
  assert.match(add.line, /^claude mcp add --scope local nomarmy-local-worker (.* )?-- node .*\/install\/mcp\/server\.mjs$/);
  assert.equal(add.cwd, s.projectDir, "registered from the repository, so Claude Code ties it to that project");
  assert.ok(s.calls.some((c) => c.line === "claude mcp remove nomarmy-local-worker --scope local" && c.cwd === s.projectDir));
  assert.equal(s.calls.some((c) => /--scope user/.test(c.line)), false, "the user-scope registration is left alone");
  assert.ok(fs.existsSync(path.join(s.projectDir, ".claude", "commands", "feature.md")));
  assert.deepEqual(result.excluded, ["/.claude/commands/feature.md"]);
  assert.match(fs.readFileSync(path.join(s.projectDir, ".git", "info", "exclude"), "utf8"), /^\/\.claude\/commands\/feature\.md$/m);
  assert.equal(result.userScoped, true);
});

test("claude --scope project: .mcp.json runs the portable `nomarmy mcp`, with no machine-specific env", (t) => {
  const s = setup(t);
  const result = connectClaude({ nomarmyRoot: s.nomarmyRoot, installDir: s.installDir, run: s.run, configDir: s.configDir, scope: "project", projectDir: s.projectDir });
  const add = s.calls.find((c) => c.line.startsWith("claude mcp add"));
  assert.equal(add.line, "claude mcp add --scope project nomarmy-local-worker -- nomarmy mcp");
  assert.equal(add.cwd, s.projectDir);
  assert.deepEqual(result.excluded, [], "a project registration is meant to be committed");
  assert.equal(result.configPath, path.join(s.projectDir, ".mcp.json"));
});

test("cursor --scope local and project write the repo's .cursor/mcp.json; local keeps it out of git", (t) => {
  const s = setup(t);
  const local = connectCursor({ nomarmyRoot: s.nomarmyRoot, installDir: s.installDir, run: s.run, configDir: s.configDir, scope: "local", projectDir: s.projectDir });
  const file = path.join(s.projectDir, ".cursor", "mcp.json");
  assert.equal(local.configPath, file);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers["nomarmy-local-worker"].command, "node");
  assert.deepEqual(local.excluded, ["/.cursor/mcp.json", "/.cursor/commands/feature.md"]);
  connectCursor({ nomarmyRoot: s.nomarmyRoot, installDir: s.installDir, run: s.run, configDir: s.configDir, scope: "project", projectDir: s.projectDir });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers["nomarmy-local-worker"], { command: "nomarmy", args: ["mcp"], env: { NOMARMY_PROJECT_DIR: "${workspaceFolder}" } });
});

test("codex has only the user scope, and a repo scope needs a repository", (t) => {
  const s = setup(t);
  assert.throws(() => connectCodex({ nomarmyRoot: s.nomarmyRoot, installDir: s.installDir, run: s.run, scope: "local" }), /Codex registers MCP servers only for every project/);
  assert.throws(() => connectClaude({ nomarmyRoot: s.nomarmyRoot, installDir: s.installDir, run: s.run, scope: "local" }), /run it inside that repository/);
  assert.throws(() => connectClaude({ nomarmyRoot: s.nomarmyRoot, installDir: s.installDir, run: s.run, scope: "team", projectDir: s.projectDir }), /unknown scope "team"/);
});

test("excludeFromGit adds each path once", (t) => {
  const s = setup(t);
  assert.deepEqual(excludeFromGit(s.projectDir, [".cursor/mcp.json"], s.run), ["/.cursor/mcp.json"]);
  assert.deepEqual(excludeFromGit(s.projectDir, [".cursor/mcp.json"], s.run), []);
  assert.equal(fs.readFileSync(path.join(s.projectDir, ".git", "info", "exclude"), "utf8").match(/\/\.cursor\/mcp\.json/g).length, 1);
});

test("nomarmy mcp runs the installed copy when there is one, else the package's own server, and the caller's env wins", (t) => {
  const s = setup(t);
  const fromPackage = portableServerLaunch({ nomarmyRoot: s.nomarmyRoot, installDir: s.installDir, configDir: s.configDir, env: {} });
  assert.equal(fromPackage.serverPath, path.join(s.nomarmyRoot, "mcp", "server.mjs"));
  fs.mkdirSync(path.join(s.installDir, "mcp"), { recursive: true });
  fs.writeFileSync(path.join(s.installDir, "mcp", "server.mjs"), "// installed");
  const fromCopy = portableServerLaunch({ nomarmyRoot: s.nomarmyRoot, installDir: s.installDir, configDir: s.configDir, env: { NOMARMY_WORKER_MODEL: "mine", NOMARMY_PROJECT_DIR: "/repo" } });
  assert.equal(fromCopy.serverPath, path.join(s.installDir, "mcp", "server.mjs"));
  assert.equal(fromCopy.env.NOMARMY_WORKER_MODEL, "mine");
  assert.equal(fromCopy.env.NOMARMY_PROJECT_DIR, "/repo");
});

test("switching a repo from local to project takes nomArmy's paths back out of .git/info/exclude", (t) => {
  const s = setup(t);
  fs.writeFileSync(path.join(s.projectDir, ".git", "info", "exclude"), "# mine\n*.log\n");
  connectCursor({ nomarmyRoot: s.nomarmyRoot, installDir: s.installDir, run: s.run, configDir: s.configDir, scope: "local", projectDir: s.projectDir });
  connectCursor({ nomarmyRoot: s.nomarmyRoot, installDir: s.installDir, run: s.run, configDir: s.configDir, scope: "project", projectDir: s.projectDir });
  const exclude = fs.readFileSync(path.join(s.projectDir, ".git", "info", "exclude"), "utf8");
  assert.doesNotMatch(exclude, /\.cursor\//);
  assert.match(exclude, /^\*\.log$/m, "the operator's own lines stay");
});
