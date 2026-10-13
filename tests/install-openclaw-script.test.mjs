import "./helpers/isolate-global-config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PINNED_OPENCLAW_VERSION } from "../lib/openclaw-install.mjs";

// scripts/install-openclaw.mjs --update, as `nomarmy update` runs it, against
// a fake openclaw and npm: silent at the pin, asks (or needs --yes) below it.
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "install-openclaw.mjs");
const [major, minor] = process.versions.node.split(".").map(Number);
const nodeOk = (major === 24 && minor >= 16) || (major === 26 && minor >= 1) || major > 26;
const skip = process.platform === "win32" ? "fake commands are shell scripts" : !nodeOk && "OpenClaw needs Node 24.16+ or 26.1+, so the script refuses below the pin";

function fakes({ version, globalPrefixWritable = true, codexPlugin = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-openclaw-update-"));
  const globalPrefix = path.join(dir, "global");
  fs.mkdirSync(globalPrefix);
  if (!globalPrefixWritable) fs.chmodSync(globalPrefix, 0o555);
  fs.writeFileSync(path.join(dir, "version"), `${version}\n`);
  // codexPlugin: a configured Codex subscription whose OpenClaw plugin is at that version.
  const configDir = path.join(dir, "config");
  fs.mkdirSync(configDir);
  if (codexPlugin) {
    fs.writeFileSync(path.join(dir, "codex-plugin"), `${codexPlugin}\n`);
    fs.writeFileSync(path.join(configDir, "agents.yml"), "agents:\n  codex:\n    kind: subscription\n    provider: openai\n    owner: dev@example.com\n");
  }
  fs.writeFileSync(path.join(dir, "openclaw"), `#!/bin/sh
case "$1" in
  --version) echo "OpenClaw $(cat "${dir}/version") (abc1234)";;
  update) echo '{"migrationWarnings":[]}';;
  plugins)
    echo "$*" >> "${dir}/plugins.log"
    case "$2" in
      inspect) v=$(cat "${dir}/codex-plugin"); printf '{"plugin":{"id":"%s","enabled":true,"version":"%s","builtWithOpenClawVersion":"%s"}}\n' "$3" "$v" "$v";;
      install) v=\${3##*@}; echo "$v" > "${dir}/codex-plugin";;
    esac;;
  *) exit 1;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "npm"), `#!/bin/sh
echo "$*" >> "${dir}/npm.log"
case "$1" in
  prefix) echo "${globalPrefix}";;
  install) for a; do case "$a" in openclaw@*) echo "\${a#openclaw@}" > "${dir}/version";; esac; done;;
esac
`, { mode: 0o755 });
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
  const run = (...args) => spawnSync(process.execPath, [script, "--update", ...args], {
    encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HOME: home, PATH: `${dir}${path.delimiter}${process.env.PATH}`, NOMARMY_OPENCLAW_CMD: path.join(dir, "openclaw"), NOMARMY_CONFIG_DIR: configDir },
  });
  const npmCalls = () => { try { return fs.readFileSync(path.join(dir, "npm.log"), "utf8").trim().split("\n"); } catch { return []; } };
  const installed = () => fs.readFileSync(path.join(dir, "version"), "utf8").trim();
  const pluginUpdates = () => { try { return fs.readFileSync(path.join(dir, "plugins.log"), "utf8").trim().split("\n").filter((l) => l.startsWith("plugins install")); } catch { return []; } };
  return { run, npmCalls, installed, home, pluginUpdates };
}

test("--update is silent and installs nothing at or past the pin", { skip: process.platform === "win32" && "fake commands are shell scripts" }, () => {
  for (const version of [PINNED_OPENCLAW_VERSION, "2099.1.1"]) {
    const f = fakes({ version });
    const r = f.run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "");
    assert.deepEqual(f.npmCalls(), []);
    assert.equal(f.installed(), version, "never a downgrade");
  }
});

test("--update below the pin without a terminal or --yes changes nothing and exits 2", { skip }, () => {
  const f = fakes({ version: "2026.9.6" });
  const r = f.run();
  assert.equal(r.status, 2, r.stderr);
  assert.ok(r.stdout.includes(`tested with OpenClaw ${PINNED_OPENCLAW_VERSION}; this machine has OpenClaw 2026.9.6`), r.stdout);
  assert.match(r.stdout, /Non-interactive repair requires --yes/);
  assert.equal(f.npmCalls().some((call) => call.startsWith("install")), false);
  assert.equal(f.installed(), "2026.9.6");
});

test("--update --yes installs exactly the pin into npm's writable global prefix", { skip }, () => {
  const f = fakes({ version: "2026.9.6" });
  const r = f.run("--yes");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(f.npmCalls().filter((call) => call.startsWith("install")), [`install -g openclaw@${PINNED_OPENCLAW_VERSION}`]);
  assert.equal(f.installed(), PINNED_OPENCLAW_VERSION);
});

test("--update --yes falls back to ~/.npm-global when npm's global prefix isn't writable", { skip: skip || (process.getuid?.() === 0 && "root can write anywhere") }, () => {
  const f = fakes({ version: "2026.9.6", globalPrefixWritable: false });
  const r = f.run("--yes");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(f.npmCalls().filter((call) => call.startsWith("install")),
    [`install -g openclaw@${PINNED_OPENCLAW_VERSION} --prefix ${path.join(f.home, ".npm-global")}`]);
});

test("--update below the pin on an old Node refuses without installing", { skip: (process.platform === "win32" || nodeOk) && "needs a Node older than OpenClaw supports" }, () => {
  const f = fakes({ version: "2026.9.6" });
  const r = f.run("--yes");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /needs Node 24\.16\+ or 26\.1\+/);
  assert.deepEqual(f.npmCalls(), []);
});

test("--update with OpenClaw at the pin but a configured vendor's plugin behind it updates that plugin", { skip: process.platform === "win32" && "fake commands are shell scripts" }, () => {
  const current = fakes({ version: PINNED_OPENCLAW_VERSION, codexPlugin: PINNED_OPENCLAW_VERSION });
  assert.equal(current.run().stdout, "", "silent when the plugin is at the pin too");
  assert.deepEqual(current.pluginUpdates(), []);

  const f = fakes({ version: PINNED_OPENCLAW_VERSION, codexPlugin: "2026.9.7" });
  const asked = f.run();
  assert.equal(asked.status, 2, asked.stderr);
  assert.ok(asked.stdout.includes(`Update OpenClaw plugin codex 2026.9.7 to ${PINNED_OPENCLAW_VERSION}: `) && asked.stdout.includes(`openclaw plugins install clawhub:@openclaw/codex@${PINNED_OPENCLAW_VERSION} --force`), asked.stdout);
  assert.deepEqual(f.pluginUpdates(), []);

  const applied = f.run("--yes");
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.deepEqual(f.pluginUpdates(), [`plugins install clawhub:@openclaw/codex@${PINNED_OPENCLAW_VERSION} --force`]);
  assert.deepEqual(f.npmCalls().filter((call) => call.startsWith("install")), [], "OpenClaw itself is left alone");
});
