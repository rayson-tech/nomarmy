import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureOpenClawOnPath } from "../lib/openclaw-path.mjs";

const bin = (dir, name) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), "#!/bin/sh\n", { mode: 0o755 }); };
const openclawName = process.platform === "win32" ? "openclaw.cmd" : "openclaw";

test("OpenClaw in ~/.npm-global/bin is found without the operator editing PATH (the practice-run bug)", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-oc-"));
  bin(path.join(home, ".npm-global", "bin"), openclawName);
  const initialPath = [path.join(path.sep, "usr", "bin"), path.join(path.sep, "bin")].join(path.delimiter);
  const env = { PATH: initialPath };
  assert.equal(ensureOpenClawOnPath(env, { home, platform: process.platform }), path.join(home, ".npm-global", "bin"));
  assert.equal(env.PATH, [path.join(home, ".npm-global", "bin"), initialPath].join(path.delimiter));
  assert.equal(ensureOpenClawOnPath(env, { home, platform: process.platform }), null, "already reachable: nothing added twice");
});

test("left alone when openclaw is on PATH, when NOMARMY_OPENCLAW_CMD is set, or when it's nowhere", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-oc-"));
  const onPath = path.join(home, "bin"); bin(onPath, openclawName); bin(path.join(home, ".npm-global", "bin"), openclawName);
  const env = { PATH: onPath };
  assert.equal(ensureOpenClawOnPath(env, { home, platform: process.platform }), null);
  assert.equal(env.PATH, onPath);
  assert.equal(ensureOpenClawOnPath({ PATH: path.join(path.sep, "usr", "bin"), NOMARMY_OPENCLAW_CMD: path.join(path.sep, "x", "openclaw") }, { home, platform: process.platform }), null);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-oc-"));
  assert.equal(ensureOpenClawOnPath({ PATH: path.join(path.sep, "usr", "bin") }, { home: empty, platform: process.platform }), null);
});
