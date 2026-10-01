import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { COORDINATOR_INSTRUCTIONS } from "../lib/coordinator-instructions.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const playbook = fs.readFileSync(path.join(root, "playbooks", "feature.md"), "utf8");

test("coordinator instructions name scoped job watches", () => {
  for (const text of [COORDINATOR_INSTRUCTIONS, playbook]) {
    assert.match(text, /nomarmy jobs --wait <id> <id> \.\.\./);
    assert.match(text, /nomarmy jobs --events --until-done --run <run-id>/);
    assert.match(text, /Never use unscoped .*--until-done.* when other sessions may have jobs/);
  }
});
