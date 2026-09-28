import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readSetting, readSettings, writeSetting, profilePathFor, migrateUserConfig, userCommonPath, userProfilePath } from "../lib/user-config.mjs";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-uc-"));
  const pkg = path.join(dir, "pkg"), cfg = path.join(dir, "cfg");
  fs.mkdirSync(path.join(pkg, "config", "profiles"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "config", "common.env"), "NOMARMY_EXECUTION=local\nNOMARMY_WORKER_MODEL=gpt-oss-20b\n");
  fs.writeFileSync(path.join(pkg, "config", "profiles", "macbook-pro.env"), "NOMARMY_LLAMA_PARALLEL=1\n");
  return { dir, pkg, env: { NOMARMY_CONFIG_DIR: cfg, HOME: dir } };
}

test("your settings sit over the package defaults, and writes never touch the package", () => {
  const { pkg, env } = fixture();
  assert.equal(readSetting("NOMARMY_EXECUTION", { nomarmyRoot: pkg, env }), "local");
  writeSetting("NOMARMY_EXECUTION", "hosted", { env });
  assert.equal(readSetting("NOMARMY_EXECUTION", { nomarmyRoot: pkg, env }), "hosted");
  assert.equal(readSettings({ nomarmyRoot: pkg, env }).NOMARMY_WORKER_MODEL, "gpt-oss-20b", "defaults still show through");
  assert.match(fs.readFileSync(path.join(pkg, "config", "common.env"), "utf8"), /NOMARMY_EXECUTION=local/, "the package file is untouched");
});

test("an update replacing the package keeps your settings (the practice-run bug)", () => {
  const { pkg, env } = fixture();
  writeSetting("NOMARMY_EXECUTION", "hosted", { env });
  fs.writeFileSync(path.join(pkg, "config", "common.env"), "NOMARMY_EXECUTION=local\nNOMARMY_WORKER_MODEL=gpt-oss-20b\n"); // npm install -g replaced it
  assert.equal(readSetting("NOMARMY_EXECUTION", { nomarmyRoot: pkg, env }), "hosted");
});

test("profiles: yours first, then the shipped one", () => {
  const { pkg, env } = fixture();
  assert.equal(profilePathFor("macbook-pro", { nomarmyRoot: pkg, env }), path.join(pkg, "config", "profiles", "macbook-pro.env"));
  fs.mkdirSync(path.dirname(userProfilePath("macbook-pro", env)), { recursive: true });
  fs.writeFileSync(userProfilePath("macbook-pro", env), "NOMARMY_LLAMA_PARALLEL=2\n");
  assert.equal(profilePathFor("macbook-pro", { nomarmyRoot: pkg, env }), userProfilePath("macbook-pro", env));
  assert.equal(profilePathFor("nope", { nomarmyRoot: pkg, env }), null);
});

test("migration rescues what only the old installed copy still holds, and never overwrites", () => {
  const { dir, pkg, env } = fixture();
  const old = path.join(dir, "installed", "config");
  fs.mkdirSync(path.join(old, "profiles"), { recursive: true });
  fs.writeFileSync(path.join(old, "common.env"), "NOMARMY_EXECUTION=hosted\nNOMARMY_WORKER_MODEL=gpt-oss-20b\nNOMARMY_SETUP_PROFILE=hosted\n");
  fs.writeFileSync(path.join(old, "profiles", "macbook-pro.env"), "NOMARMY_LLAMA_PARALLEL=1\n"); // same as shipped
  fs.writeFileSync(path.join(old, "profiles", "custom.env"), "NOMARMY_LLAMA_PARALLEL=4\n");   // the user's own
  const moved = migrateUserConfig({ oldConfigDir: old, nomarmyRoot: pkg, env });
  assert.deepEqual(moved, { keys: ["NOMARMY_EXECUTION", "NOMARMY_SETUP_PROFILE"], profiles: ["custom"] }, "only what differs from the new defaults");
  assert.equal(readSetting("NOMARMY_EXECUTION", { nomarmyRoot: pkg, env }), "hosted");
  writeSetting("NOMARMY_EXECUTION", "bedrock", { env });
  assert.deepEqual(migrateUserConfig({ oldConfigDir: old, nomarmyRoot: pkg, env }).keys, [], "a second run changes nothing you set");
  assert.equal(readSetting("NOMARMY_EXECUTION", { nomarmyRoot: pkg, env }), "bedrock");
  assert.deepEqual(migrateUserConfig({ oldConfigDir: path.join(pkg, "config"), nomarmyRoot: pkg, env }), { keys: [], profiles: [] }, "a checkout's own config isn't an old copy");
});

test("scripts/lib.sh layers the same files", () => {
  const { pkg, env } = fixture();
  writeSetting("NOMARMY_EXECUTION", "hosted", { env });
  const lib = path.resolve("scripts/lib.sh");
  const out = execFileSync("bash", ["-c", `source "${lib}"; nomarmy_root(){ echo "${pkg}"; }; nomarmy_is_cloud(){ return 1; }; nomarmy_validate_local(){ :; }; load_profile macbook-pro >/dev/null 2>&1 || true; echo "$NOMARMY_EXECUTION"`], { env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("NOMARMY_"))), ...env }, encoding: "utf8" }).trim();
  assert.equal(out.split("\n").pop(), "hosted");
  assert.ok(userCommonPath(env).startsWith(env.NOMARMY_CONFIG_DIR));
});
