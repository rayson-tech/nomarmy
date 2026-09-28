import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureOpenClawOnPath } from "../lib/openclaw-path.mjs";

const bin = (dir, name) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), "#!/bin/sh\n", { mode: 0o755 }); };

test("OpenClaw in ~/.npm-global/bin is found without the operator editing PATH (the practice-run bug)", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-oc-"));
  bin(path.join(home, ".npm-global", "bin"), "openclaw");
  const env = { PATH: "/usr/bin:/bin" };
  assert.equal(ensureOpenClawOnPath(env, { home, platform: "darwin" }), path.join(home, ".npm-global", "bin"));
  assert.equal(env.PATH, `${path.join(home, ".npm-global", "bin")}:/usr/bin:/bin`);
  assert.equal(ensureOpenClawOnPath(env, { home, platform: "darwin" }), null, "already reachable: nothing added twice");
});

test("left alone when openclaw is on PATH, when NOMARMY_OPENCLAW_CMD is set, or when it's nowhere", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-oc-"));
  const onPath = path.join(home, "bin"); bin(onPath, "openclaw"); bin(path.join(home, ".npm-global", "bin"), "openclaw");
  const env = { PATH: onPath };
  assert.equal(ensureOpenClawOnPath(env, { home, platform: "darwin" }), null);
  assert.equal(env.PATH, onPath);
  assert.equal(ensureOpenClawOnPath({ PATH: "/usr/bin", NOMARMY_OPENCLAW_CMD: "/x/openclaw" }, { home, platform: "darwin" }), null);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-oc-"));
  assert.equal(ensureOpenClawOnPath({ PATH: "/usr/bin" }, { home: empty, platform: "darwin" }), null);
});
