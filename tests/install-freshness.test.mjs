import "./helpers/isolate-global-config.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { compareVersions, freshnessIssues, restartNotice, readInstallVersions, SOURCE_FILE } from "../lib/install-freshness.mjs";
import { installMcpCopy } from "../lib/connect.mjs";
import { runHealthChecks, readRegisteredInstall } from "../lib/health.mjs";

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function fakeRoot(t, version) {
  const dir = tmp(t, "nomarmy-fresh-root-");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "nomarmy", version }));
  fs.mkdirSync(path.join(dir, "mcp"));
  fs.writeFileSync(path.join(dir, "mcp", "server.mjs"), "// fake server");
  fs.mkdirSync(path.join(dir, "lib"));
  return dir;
}

test("compareVersions orders releases and prereleases numerically", () => {
  const ordered = ["0.1.0-alpha.2", "0.1.0-alpha.7", "0.1.0-alpha.10", "0.1.0-beta", "0.1.0-beta.1", "0.1.0", "0.1.1", "0.2.0", "1.0.0"];
  for (let i = 0; i < ordered.length - 1; i++) {
    assert.equal(compareVersions(ordered[i], ordered[i + 1]), -1, `${ordered[i]} < ${ordered[i + 1]}`);
    assert.equal(compareVersions(ordered[i + 1], ordered[i]), 1, `${ordered[i + 1]} > ${ordered[i]}`);
  }
  assert.equal(compareVersions("0.1.0-alpha.7", "v0.1.0-alpha.7\n"), 0);
});

test("freshnessIssues: a newer npm release, and a copy older than the CLI, each get one issue", () => {
  const both = freshnessIssues({ copyVersion: "0.1.0-alpha.6", sourceVersion: "0.1.0-alpha.7", latestVersion: "0.1.0-alpha.8\n" });
  assert.deepEqual(both.map((i) => [i.id, i.severity, i.fix]), [
    ["nomarmy-update:0.1.0-alpha.8", "info", "nomarmy update"],
    ["nomarmy-copy:0.1.0-alpha.7", "warn", "nomarmy connect claude (and codex, cursor), then restart those sessions"],
  ]);
  assert.match(both[1].title, /run nomArmy 0\.1\.0-alpha\.6, but 0\.1\.0-alpha\.7 is installed/);
  // Current, a dev checkout ahead of npm, and anything unknown: silent.
  assert.deepEqual(freshnessIssues({ copyVersion: "0.1.0-alpha.7", sourceVersion: "0.1.0-alpha.7", latestVersion: "0.1.0-alpha.7" }), []);
  assert.deepEqual(freshnessIssues({ copyVersion: "0.1.0-alpha.8", sourceVersion: "0.1.0-alpha.8", latestVersion: "0.1.0-alpha.7" }), []);
  assert.deepEqual(freshnessIssues({ copyVersion: null, sourceVersion: null, latestVersion: "npm ERR! offline" }), []);
});

test("installMcpCopy records its source, so health can compare the copy with the CLI it came from", (t) => {
  const root = fakeRoot(t, "0.1.0-alpha.7");
  const installDir = tmp(t, "nomarmy-fresh-install-");
  installMcpCopy({ nomarmyRoot: root, installDir, run: () => {} });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(installDir, SOURCE_FILE), "utf8")), { root, version: "0.1.0-alpha.7" });
  assert.deepEqual(readInstallVersions(installDir), { copyVersion: "0.1.0-alpha.7", sourceVersion: "0.1.0-alpha.7" });
  // npm upgrades the CLI in place; the copy stays behind until connect runs again.
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "nomarmy", version: "0.1.0-alpha.8" }));
  assert.deepEqual(readInstallVersions(installDir), { copyVersion: "0.1.0-alpha.7", sourceVersion: "0.1.0-alpha.8" });
  // A copy connected before source.json existed still reports its own version.
  fs.rmSync(path.join(installDir, SOURCE_FILE));
  assert.deepEqual(readInstallVersions(installDir), { copyVersion: "0.1.0-alpha.7", sourceVersion: null });
});

test("runHealthChecks reports a stale install from npm's alpha tag, and skips npm without install info", async () => {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    return cmd === "npm" && args.includes("dist-tags.alpha") ? { ok: true, stdout: "0.1.0-alpha.8\n" } : { ok: false, stdout: "" };
  };
  const { issues } = await runHealthChecks({ run, install: { copyVersion: "0.1.0-alpha.6", sourceVersion: "0.1.0-alpha.7" } });
  assert.deepEqual(issues.filter((i) => i.id.startsWith("nomarmy-")).map((i) => i.id), ["nomarmy-copy:0.1.0-alpha.7", "nomarmy-update:0.1.0-alpha.8"]);
  calls.length = 0;
  const bare = await runHealthChecks({ run });
  assert.equal(calls.some((c) => c.includes("nomarmy")), false);
  assert.equal(bare.issues.some((i) => i.id.startsWith("nomarmy-")), false);
});

test("restartNotice: only when the copy on disk changed after this server started", () => {
  const installRoot = path.join(path.sep, "install");
  const serverFile = path.join(installRoot, "mcp", "server.mjs");
  const at = (mtimeMs) => () => ({ mtimeMs });
  assert.equal(restartNotice({ serverFile, startedAtMs: 2000, runningVersion: "0.1.0-alpha.7", stat: at(1000), readVersion: () => "0.1.0-alpha.7" }), null);
  const sameVersion = restartNotice({ serverFile, startedAtMs: 2000, runningVersion: "0.1.0-alpha.7", stat: at(3000), readVersion: () => "0.1.0-alpha.7" });
  assert.match(sameVersion, /updated after this session started\. Restart this session/);
  const newer = restartNotice({ serverFile, startedAtMs: 2000, runningVersion: "0.1.0-alpha.7", stat: at(3000), readVersion: (dir) => { assert.equal(dir, installRoot); return "0.1.0-alpha.8"; } });
  assert.match(newer, /this session runs 0\.1\.0-alpha\.7; 0\.1\.0-alpha\.8 is installed/);
  assert.equal(restartNotice({ serverFile, startedAtMs: 2000, runningVersion: "x", stat: () => { throw new Error("gone"); } }), null);
});

import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { copyIsStale } from "../lib/install-freshness.mjs";
import { linkDir } from "./helpers/symlinks.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the installed copy loads every harness the checkout has (connect used to leave harnesses/ behind)", async (t) => {
  const installDir = fs.realpathSync(tmp(t, "nomarmy-fresh-harness-"));
  installMcpCopy({ nomarmyRoot: REPO_ROOT, installDir, run: () => {} });
  linkDir(path.join(REPO_ROOT, "node_modules"), path.join(installDir, "node_modules"));
  const installed = await import(pathToFileURL(path.join(installDir, "lib", "harnesses.mjs")).href);
  const fromCheckout = await import("../lib/harnesses.mjs");
  assert.equal(installed.HARNESS_ROOT, path.join(installDir, "harnesses") + path.sep);
  const names = Object.keys(installed.loadHarnesses().harnesses);
  assert.deepEqual(names, Object.keys(fromCheckout.loadHarnesses().harnesses));
  assert.ok(names.includes("node") && names.includes("python"), `got ${names.join(", ")}`);
});

test("freshnessIssues: a copy with no harnesses is an error, with the fix", () => {
  const [issue] = freshnessIssues({ copyVersion: "0.1.0-alpha.8", sourceVersion: "0.1.0-alpha.8", copyHarnesses: 0 });
  assert.equal(issue.severity, "error");
  assert.match(issue.title, /no harnesses/);
  assert.match(issue.fix, /nomarmy connect claude/);
  assert.deepEqual(freshnessIssues({ copyVersion: "0.1.0-alpha.8", sourceVersion: "0.1.0-alpha.8", copyHarnesses: 6 }), []);
  assert.deepEqual(freshnessIssues({ copyVersion: null, copyHarnesses: 0 }), [], "no copy installed yet: nothing to say");
});

test("health checks only registered server copies and fixes their actual scope", async (t) => {
  const base = tmp(t, "nomarmy-registered-health-");
  const projectDir = path.join(base, "repo"), globalDir = path.join(base, "global"), localDir = path.join(base, "local");
  for (const dir of [projectDir, globalDir, localDir]) fs.mkdirSync(path.join(dir, "mcp"), { recursive: true });
  for (const dir of [globalDir, localDir]) {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "0.1.0-alpha.8" }));
    fs.writeFileSync(path.join(dir, "mcp", "server.mjs"), "// server");
  }
  fs.mkdirSync(path.join(localDir, "harnesses", "node"), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, "harnesses", "node", "harness.yml"), path.join(localDir, "harnesses", "node", "harness.yml"));
  const issuesFor = async (scope, serverPath) => {
    const run = async (cmd, args, opts) => {
      if (cmd !== "claude" || opts.cwd !== (scope === "user" ? os.homedir() : projectDir)) return { ok: false, stdout: "" };
      return { ok: true, stdout: `nomarmy-local-worker:\n  Scope: ${scope} config\n  Command: node\n  Args: ${serverPath}\n` };
    };
    const install = await readRegisteredInstall({ projectDir, installDir: globalDir, run });
    return install ? freshnessIssues(install) : [];
  };
  const localPath = path.join(localDir, "mcp", "server.mjs"), globalPath = path.join(globalDir, "mcp", "server.mjs");
  assert.deepEqual((await issuesFor("local", localPath)).map((issue) => [issue.id, issue.fix]), []);
  fs.rmSync(path.join(localDir, "harnesses"), { recursive: true });
  assert.deepEqual((await issuesFor("local", localPath)).map((issue) => [issue.id, issue.fix]), [
    ["nomarmy-harnesses:0.1.0-alpha.8", "nomarmy connect claude --scope local, then restart that session"],
  ]);
  assert.deepEqual((await issuesFor("user", globalPath)).map((issue) => [issue.id, issue.fix]), [
    ["nomarmy-harnesses:0.1.0-alpha.8", "nomarmy connect claude (and codex, cursor), then restart those sessions"],
  ]);
  const projectRun = async (cmd, args, opts) => cmd === "claude" && opts.cwd === projectDir
    ? { ok: true, stdout: "nomarmy-local-worker:\n  Scope: Project config\n  Command: nomarmy\n  Args: mcp\n" }
    : { ok: false, stdout: "" };
  const projectInstall = await readRegisteredInstall({ projectDir, installDir: globalDir, run: projectRun });
  assert.deepEqual(freshnessIssues(projectInstall).map((issue) => [issue.id, issue.fix]), [
    ["nomarmy-harnesses:0.1.0-alpha.8", "nomarmy connect claude --scope project, then restart that session"],
  ]);
  fs.mkdirSync(path.join(projectDir, ".cursor"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: {
    "nomarmy-local-worker": { command: "nomarmy", args: ["mcp"] },
  } }));
  const cursorInstall = await readRegisteredInstall({ projectDir, installDir: globalDir, run: async () => ({ ok: false, stdout: "" }) });
  assert.deepEqual(freshnessIssues(cursorInstall).map((issue) => [issue.id, issue.fix]), [
    ["nomarmy-harnesses:0.1.0-alpha.8", "nomarmy connect cursor --scope project, then restart that session"],
  ]);
  fs.rmSync(path.join(projectDir, ".cursor"), { recursive: true });
  const codexRun = async (cmd) => cmd === "codex"
    ? { ok: true, stdout: JSON.stringify({ transport: { command: "node", args: [globalPath] } }) }
    : { ok: false, stdout: "" };
  const codexInstall = await readRegisteredInstall({ projectDir, installDir: globalDir, run: codexRun });
  assert.deepEqual(freshnessIssues(codexInstall).map((issue) => [issue.id, issue.fix]), [
    ["nomarmy-harnesses:0.1.0-alpha.8", "nomarmy connect codex, then restart that session"],
  ]);
});

test("copyIsStale: a git checkout that moved on without a version bump makes the copy stale", (t) => {
  const root = fakeRoot(t, "0.1.0-alpha.8");
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  git("init", "-q"); git("config", "user.email", "t@example.com"); git("config", "user.name", "t");
  git("add", "-A"); git("commit", "-qm", "one");
  const installDir = tmp(t, "nomarmy-fresh-stale-");
  assert.equal(copyIsStale(installDir, root), true, "never connected");
  installMcpCopy({ nomarmyRoot: root, installDir, run: () => {} });
  assert.equal(JSON.parse(fs.readFileSync(path.join(installDir, SOURCE_FILE), "utf8")).commit, git("rev-parse", "HEAD"));
  assert.equal(copyIsStale(installDir, root), false);
  fs.writeFileSync(path.join(root, "lib", "new.mjs"), "export {};\n");
  git("add", "-A"); git("commit", "-qm", "two");
  assert.equal(copyIsStale(installDir, root), true, "same version, newer commit");
  installMcpCopy({ nomarmyRoot: root, installDir, run: () => {} });
  assert.equal(copyIsStale(installDir, root), false);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "nomarmy", version: "0.1.0-alpha.9" }));
  assert.equal(copyIsStale(installDir, root), true, "version differs");
});
