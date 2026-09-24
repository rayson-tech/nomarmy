// Imported first by every test file that can reach nomArmy's global config.
// Global config lives in ~/.config/nomarmy (lib/army.mjs's
// globalConfigDir), so without this a test run on a developer's machine
// would read, or write, their real agents.yml and army config.yml. Points it at a fresh empty directory instead.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NOMARMY_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-test-global-"));
// connect also installs the /feature playbook into each coordinator; never
// into the developer's real ~/.claude, ~/.codex or ~/.cursor from a test.
for (const name of ["NOMARMY_CLAUDE_COMMANDS_DIR", "NOMARMY_CODEX_SKILLS_DIR", "NOMARMY_CURSOR_COMMANDS_DIR"]) {
  process.env[name] = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-test-playbooks-"));
}

// Job leases and agent slots are machine-wide, under nomArmy's state
// directory; tests get their own, never the developer's live one.
process.env.NOMARMY_AGENT_STATE = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-test-state-"));
// No desktop notifications from a test run.
process.env.NOMARMY_NOTIFY = "0";
// ...and never touch the developer's real Claude Code settings.
process.env.NOMARMY_CLAUDE_SETTINGS_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-test-claude-")), "settings.json");
// ...nor the developer's real OpenClaw config (lib/openclaw-config.mjs).
process.env.OPENCLAW_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-test-openclaw-"));
delete process.env.OPENCLAW_CONFIG_PATH;
