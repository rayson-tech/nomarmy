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

test("review can't loop: ranked findings, evidence-backed blockers, two rounds, decided points stay decided", () => {
  for (const [name, text] of [["instructions", COORDINATOR_INSTRUCTIONS], ["playbook", playbook]]) {
    assert.match(text, /blocker, fix now,? or follow-up/i, name);
    assert.match(text, /at most two review rounds per change/i, name);
    assert.match(text, /bring the operator[^.]*disagreement/i, name);
    assert.match(text, /(already decided|already decided into the next review)/i, name);
  }
  assert.match(playbook, /A worker may dispute a finding with evidence/);
  assert.match(playbook, /blocker backed by evidence/);
});
