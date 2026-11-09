import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliFile = fileURLToPath(new URL("../bin/nomarmy.mjs", import.meta.url));

test("a yes/no prompt with no terminal says so and changes nothing (it used to exit with an unsettled await)", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "no-tty-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = path.join(dir, "agents.yml");
  fs.writeFileSync(config, "agents:\n  spare:\n    kind: api\n    provider: xai\n    auth_env: X_KEY\n", { mode: 0o600 });
  const result = spawnSync(process.execPath, [cliFile, "agents", "remove", "spare"], {
    encoding: "utf8", input: "", env: { ...process.env, NOMARMY_CONFIG_DIR: dir },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /needs an interactive terminal, or --json/);
  assert.doesNotMatch(result.stderr, /unsettled top-level await/);
  assert.match(fs.readFileSync(config, "utf8"), /spare:/, "the agent is still there");
});
