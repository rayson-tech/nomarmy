import assert from "node:assert/strict";
import test from "node:test";

import { withCliBackendFsPolicy } from "../lib/cli-backend-policy.mjs";

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
