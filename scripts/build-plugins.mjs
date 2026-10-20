#!/usr/bin/env node
// Builds the nomArmy plugin (plugins/nomarmy) and the marketplace files that
// serve it to Claude Code, Codex and Cursor, from package.json and
// playbooks/. Run `npm run plugins:build` after changing either; the test
// suite fails when the committed files are stale. `--check` only compares.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PLAYBOOKS } from "../lib/connect.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_DIR = "plugins/nomarmy";
const SERVER_NAME = "nomarmy-local-worker";
const GENERATED = "<!-- Generated from playbooks/%s.md by `npm run plugins:build`; edit the playbook, not this file. -->";

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** Every generated file: { "relative/path": contents }. */
export function pluginFiles(pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))) {
  const repository = pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");
  const author = { name: pkg.author, url: "https://rayson-tech.com" };
  const description = "Your coding assistant plans, sandboxed workers build, and nomArmy checks every change before it counts: the tests run again in a fresh sandbox, and must fail with the change reverted. Needs `npm install -g nomarmy` and `nomarmy setup` first.";
  const keywords = ["ai", "agents", "verification", "mcp", "sandbox", "testing", "code-review"];
  const meta = { name: "nomarmy", version: pkg.version, description, author, homepage: pkg.homepage, repository, license: pkg.license, keywords };
  const server = { command: "nomarmy", args: ["mcp"] };
  // Claude's directory follows only plain shell scripts, run by literal path;
  // Codex keeps the Node check, which also runs on Windows without a shell.
  const claudeHook = { command: `"\${CLAUDE_PLUGIN_ROOT}/hooks/check-nomarmy.sh"` };
  const codexHook = { command: `node "\${CLAUDE_PLUGIN_ROOT}/hooks/check-nomarmy.mjs"` };
  const sessionStart = (hook) => json({ hooks: { SessionStart: [{ hooks: [{ type: "command", ...hook, timeout: 10 }] }] } });
  const files = {};

  // Claude Code reads .claude-plugin/plugin.json; the MCP server is inline
  // because Claude reads .mcp.json, not the shared mcp.json below.
  // Claude Code starts it through a script the plugin ships (bin/nomarmy-mcp.mjs),
  // which the directory's validator can read, and which says what to install
  // when nomarmy is missing. It runs the same `nomarmy mcp`.
  const claudeServer = { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/bin/nomarmy-mcp.mjs"] };
  files[`${PLUGIN_DIR}/.claude-plugin/plugin.json`] = json({ ...meta, mcpServers: { [SERVER_NAME]: claudeServer }, hooks: "./hooks/session-start.json" });
  // Codex reads the portable Agent Plugins manifest (Cursor does too, and
  // ignores the com.openai block).
  files[`${PLUGIN_DIR}/plugin.json`] = json({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", ...meta, author: { ...author }, extensions: {
      "com.openai": { displayName: "nomArmy", shortDescription: "Verify what coding workers claim before it counts", longDescription: description,
        websiteURL: pkg.homepage, logo: "./assets/logo.png", hooks: "./hooks/codex-session-start.json" },
    },
  });
  files[`${PLUGIN_DIR}/.cursor-plugin/plugin.json`] = json({ ...meta, displayName: "nomArmy", logo: "assets/logo.png" });
  files[`${PLUGIN_DIR}/mcp.json`] = json({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: { [SERVER_NAME]: { type: "stdio", ...server } } });
  // Not hooks/hooks.json: Cursor discovers that path and expects its own
  // format, so Claude Code and Codex are each pointed at theirs explicitly.
  files[`${PLUGIN_DIR}/hooks/session-start.json`] = sessionStart(claudeHook);
  files[`${PLUGIN_DIR}/hooks/codex-session-start.json`] = sessionStart(codexHook);

  for (const name of Object.keys(PLAYBOOKS)) {
    const playbook = PLAYBOOKS[name];
    const body = fs.readFileSync(path.join(root, "playbooks", `${name}.md`), "utf8");
    // One skill for every tool: /nomarmy:feature in Claude Code (which appends
    // the user's text when the skill doesn't use $ARGUMENTS), a skill in
    // Codex, and a slash command in Cursor.
    const skillDescription = `${playbook.description}. Use when the user asks nomArmy (or "the army") to build a feature end to end, or to resume a nomArmy run by its run-id.`;
    files[`${PLUGIN_DIR}/skills/${name}/SKILL.md`] = [
      "---", `name: ${name}`, `description: ${JSON.stringify(skillDescription)}`, `argument-hint: ${JSON.stringify(playbook.argumentHint)}`, "---",
      GENERATED.replace("%s", name), "",
      body.replace("{{REQUEST}}", "The feature is the request the user gave with this command (or `resume <run-id>` to continue a run)."),
    ].join("\n");
  }

  const entry = { name: "nomarmy", description, version: pkg.version, author, homepage: pkg.homepage, repository, license: pkg.license, keywords };
  const owner = { name: pkg.author, url: "https://rayson-tech.com" };
  files[".claude-plugin/marketplace.json"] = json({ name: "nomarmy", owner, metadata: { description: "nomArmy's own marketplace" }, plugins: [{ ...entry, source: `./${PLUGIN_DIR}`, category: "development" }] });
  files[".cursor-plugin/marketplace.json"] = json({ name: "nomarmy", owner, plugins: [{ name: "nomarmy", source: PLUGIN_DIR, description }] });
  files[".agents/plugins/marketplace.json"] = json({ name: "nomarmy", interface: { displayName: "nomArmy" },
    plugins: [{ name: "nomarmy", source: { source: "local", path: `./${PLUGIN_DIR}` }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Coding" }] });

  // The MCP Registry: npm's published package must carry the same mcpName.
  files["server.json"] = json({
    $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    name: pkg.mcpName, title: "nomArmy", description: "Sandboxed coding workers, verified: tests rerun fresh and must fail with the change reverted.",
    repository: { url: repository, source: "github" }, websiteUrl: pkg.homepage, version: pkg.version,
    packages: [{ registryType: "npm", identifier: pkg.name, version: pkg.version, transport: { type: "stdio" }, packageArguments: [{ type: "positional", value: "mcp" }] }],
  });
  return files;
}

function main() {
  const check = process.argv.includes("--check");
  const stale = [];
  for (const [rel, text] of Object.entries(pluginFiles())) {
    const file = path.join(root, rel);
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    if (current === text) continue;
    stale.push(rel);
    if (!check) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
  }
  if (check && stale.length) { console.error(`Stale plugin files (run npm run plugins:build): ${stale.join(", ")}`); process.exit(1); }
  console.log(stale.length ? `${check ? "stale" : "wrote"}: ${stale.join(", ")}` : "plugin files are up to date");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
