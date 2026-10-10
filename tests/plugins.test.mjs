import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pluginFiles } from "../scripts/build-plugins.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const read = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));

test("committed plugin and marketplace files match npm run plugins:build", () => {
  for (const [rel, text] of Object.entries(pluginFiles())) {
    assert.equal(fs.existsSync(path.join(root, rel)) ? fs.readFileSync(path.join(root, rel), "utf8") : null, text, `${rel} is stale: run npm run plugins:build`);
  }
});

test("every manifest carries the package version, and the MCP Registry name matches mcpName", () => {
  for (const rel of ["plugins/nomarmy/.claude-plugin/plugin.json", "plugins/nomarmy/plugin.json", "plugins/nomarmy/.cursor-plugin/plugin.json", "server.json"]) {
    assert.equal(read(rel).version, pkg.version, rel);
  }
  const server = read("server.json");
  assert.equal(pkg.mcpName, "io.github.rayson-tech/nomarmy");
  assert.equal(server.name, pkg.mcpName);
  assert.deepEqual(server.packages.map((p) => [p.identifier, p.version, p.packageArguments[0].value]), [[pkg.name, pkg.version, "mcp"]]);
});

test("each tool registers the same portable server, and no plugin path escapes the plugin", () => {
  const claude = read("plugins/nomarmy/.claude-plugin/plugin.json");
  assert.deepEqual(claude.mcpServers, { "nomarmy-local-worker": { command: "nomarmy", args: ["mcp"] } });
  assert.deepEqual(read("plugins/nomarmy/mcp.json").mcpServers, { "nomarmy-local-worker": { type: "stdio", command: "nomarmy", args: ["mcp"] } });
  const codex = read("plugins/nomarmy/plugin.json").extensions["com.openai"];
  for (const ref of [claude.hooks, codex.hooks, codex.logo, read("plugins/nomarmy/.cursor-plugin/plugin.json").logo]) {
    assert.ok(!ref.includes(".."), ref);
    assert.ok(fs.existsSync(path.join(root, "plugins/nomarmy", ref)), `${ref} exists`);
  }
  // Cursor discovers hooks/hooks.json in its own format; ours must not sit there.
  assert.ok(!fs.existsSync(path.join(root, "plugins/nomarmy/hooks/hooks.json")));
  for (const rel of [".claude-plugin/marketplace.json", ".cursor-plugin/marketplace.json"]) {
    const source = read(rel).plugins[0].source.replace(/^\.\//, "");
    assert.ok(fs.existsSync(path.join(root, source, ".claude-plugin/plugin.json")), rel);
  }
  assert.equal(read(".agents/plugins/marketplace.json").plugins[0].source.path, "./plugins/nomarmy");
});

test("the feature skill is the playbook, with the request placeholder resolved", () => {
  const skill = fs.readFileSync(path.join(root, "plugins/nomarmy/skills/feature/SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: feature\ndescription: ".+"\nargument-hint: ".+"\n---\n/);
  assert.ok(!skill.includes("{{REQUEST}}"));
  assert.ok(skill.includes(fs.readFileSync(path.join(root, "playbooks/feature.md"), "utf8").split("{{REQUEST}}")[1]));
});

test("the session-start check speaks only when nomarmy is missing from PATH", (t) => {
  const script = path.join(root, "plugins/nomarmy/hooks/check-nomarmy.mjs");
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-plugin-bin-"));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  // Windows spells it Path; drop every spelling so only ours is seen.
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"));
  const run = (PATH) => spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...base, PATH } });
  const missing = run(bin);
  assert.equal(missing.status, 0);
  assert.match(missing.stdout, /npm install -g nomarmy/);
  fs.writeFileSync(path.join(bin, process.platform === "win32" ? "nomarmy.cmd" : "nomarmy"), "");
  const present = run(bin);
  assert.equal(present.status, 0);
  assert.equal(present.stdout, "");
});
