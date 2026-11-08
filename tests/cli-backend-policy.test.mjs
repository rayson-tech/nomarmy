import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { cliBackendConfigArgs, withCliBackendFsPolicy } from "../lib/cli-backend-policy.mjs";

test("withCliBackendFsPolicy: only muse-cli runs with OpenClaw's workspace-only restriction off", () => {
  const ambient = { tools: { fs: { workspaceOnly: true } }, auth: { kept: true } };
  const muse = withCliBackendFsPolicy(ambient, "muse-cli/muse-spark-1.3");
  assert.equal(muse.tools.fs.workspaceOnly, false);
  assert.deepEqual(muse.auth, { kept: true });
  assert.equal(ambient.tools.fs.workspaceOnly, true, "the ambient config is never modified");
  for (const ref of ["openai/gpt-6-astra", "claude-cli/claude-opus-5-5", "llama-cpp/gpt-oss-20b", "muse-cli-other/x", null]) {
    assert.equal(withCliBackendFsPolicy(ambient, ref), ambient, `${ref} keeps the restriction`);
  }
  assert.equal(withCliBackendFsPolicy(undefined, "muse-cli/x").tools.fs.workspaceOnly, false);
});

test("cliBackendConfigArgs: a muse-cli test call gets a private config with the restriction off; others get none", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbp-"));
  const ambientPath = path.join(dir, "openclaw.json");
  fs.writeFileSync(ambientPath, JSON.stringify({ tools: { fs: { workspaceOnly: true } }, auth: { kept: true } }));
  const args = cliBackendConfigArgs({ provider: "muse-cli", model: "muse-spark-1.3", dir, ambientPath: `${ambientPath}\n` });
  assert.equal(args[0], "--config");
  const written = JSON.parse(fs.readFileSync(args[1], "utf8"));
  assert.equal(written.tools.fs.workspaceOnly, false);
  assert.deepEqual(written.auth, { kept: true });
  if (process.platform !== "win32") assert.equal(fs.statSync(args[1]).mode & 0o777, 0o600);
  assert.deepEqual(cliBackendConfigArgs({ provider: "openai", model: "gpt-6-astra", dir, ambientPath }), []);
  const fallback = cliBackendConfigArgs({ provider: "muse-cli", model: "x", dir, ambientPath: path.join(dir, "missing.json") });
  assert.equal(JSON.parse(fs.readFileSync(fallback[1], "utf8")).tools.fs.workspaceOnly, false);
  fs.rmSync(dir, { recursive: true, force: true });
});
