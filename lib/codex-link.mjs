import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseOpenclawAuthProfiles } from "./health.mjs";
import { openclawHome } from "./openclaw-config.mjs";
import { serialOpenclawRun } from "./openclaw-busy.mjs";
import { CODEX_IMPORT_ARGS, CODEX_IMPORT_RECOVERY, emailOpenaiProfiles, usableCodexImport } from "./openclaw-runtime-health.mjs";

// Never relay migration output: --include-secrets may expose credential data.
export async function linkCodex({ run, command = "openclaw", isTTY = false, importLogin = false, removeEmailProfiles = false, confirm = async () => false, print = () => {}, codexDir = path.join(os.homedir(), ".codex"), backupDir = `${openclawHome()}-backups`, now = Date.now() }) {
  // A read refused while OpenClaw's state is busy isn't a missing import.
  run = serialOpenclawRun(run, command);
  const read = async () => {
    const result = await run(command, ["models", "auth", "list", "--json"]);
    return result.ok ? parseOpenclawAuthProfiles(result.stdout) : null;
  };
  const profiles = await read();
  if (!profiles) { print("Cannot inspect OpenClaw auth profiles; nothing imported."); return false; }
  if (!importLogin && !(isTTY && await confirm("Import your Codex login into OpenClaw? This copies the ChatGPT credential Codex stores into OpenClaw's auth store", { defaultYes: true }))) {
    print("Nothing imported; use --link-openclaw to authorize the Codex login import non-interactively.");
    return false;
  }
  const emails = emailOpenaiProfiles(profiles);
  if (emails.length) {
    print(`Email-keyed profiles will capture the Codex import: ${emails.map((p) => p.id).join(", ")}.`);
    if (!removeEmailProfiles && !(isTTY && await confirm("Remove these email-keyed profiles before importing?", { defaultYes: true }))) {
      print("Stopped; use --remove-email-profiles to allow removal non-interactively.");
      return false;
    }
    for (const p of emails) {
      if (!(await run(command, ["models", "auth", "logout", p.id])).ok) { print("OpenClaw profile logout failed; nothing imported."); return false; }
    }
    const remaining = await read();
    if (!remaining || emailOpenaiProfiles(remaining).length) { print("Email-keyed profiles still exist; nothing imported."); return false; }
  }
  print(`Linking OpenClaw: ${CODEX_IMPORT_RECOVERY}`);
  const args = CODEX_IMPORT_ARGS.map((arg) => arg === "~/.codex" ? codexDir : arg === "~/.openclaw-backups" ? backupDir : arg);
  try { fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 }); } catch { /* the migration reports an unusable backup directory itself */ }
  // An OpenClaw upgrade can leave the agent database on an old schema, which
  // refuses the auth write until `openclaw doctor --fix` migrates it.
  if (!(await run(command, args)).ok) { print("Codex import failed. Run `openclaw doctor`; after an OpenClaw upgrade its database may need `openclaw doctor --fix`."); return false; }
  const imported = await read();
  if (!imported || emailOpenaiProfiles(imported).length || !usableCodexImport(imported, now)) {
    print("Sign-in has no usable auth profile: expected an unexpired openai:account- profile labeled (Codex import).");
    return false;
  }
  print("Imported the ChatGPT credential stored by Codex into OpenClaw's auth store.");
  print("Confirmed an unexpired openai:account- (Codex import) profile.");
  return true;
}
