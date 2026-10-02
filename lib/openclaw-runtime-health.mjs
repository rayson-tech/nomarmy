// Metadata-only checks for the runtime used by nomArmy's real test calls.
import { agentProviderId } from "./agents.mjs";
export const CODEX_IMPORT_RECOVERY = "openclaw migrate apply codex --from ~/.codex --agent main --include-secrets --item auth:openai --yes";
export function codexImportRecovery({ profiles = [] } = {}) {
  return [...emailOpenaiProfiles(profiles).map((p) => `openclaw models auth logout ${shellId(p.id)}`), CODEX_IMPORT_RECOVERY].join(" && ");
}

export const CODEX_IMPORT_ARGS = ["migrate", "apply", "codex", "--from", "~/.codex", "--agent", "main", "--include-secrets", "--item", "auth:openai", "--yes"];
export function emailOpenaiProfiles(profiles) {
  return profiles.filter((p) => /^openai:.*@/.test(p.id ?? ""));
}
export function shellId(id) {
  return /^[\w@.+:-]+$/.test(id) ? id : "'" + id.replaceAll("'", "'\\''") + "'";
}
export function usableCodexImport(profiles, now = Date.now()) {
  return profiles.some((p) => p.provider === "openai" && /^openai:account-/.test(p.id ?? "") &&
    [p.label, p.name, p.displayName].some((s) => typeof s === "string" && s.includes("(Codex import)")) &&
    (p.expiresAt == null || Date.parse(p.expiresAt) > now));
}
export function codexImportIssues(profiles, { now = Date.now() } = {}) {
  const issues = [];
  const emails = emailOpenaiProfiles(profiles);
  const fix = codexImportRecovery({ profiles });
  if (!usableCodexImport(profiles, now)) issues.push({
    id: "codex-import:missing", severity: "error", title: "Codex has no unexpired account-ID (Codex import) profile",
    detail: "The Codex app-server cannot use an email-keyed OpenAI login. Confirm Codex CLI login, then re-import it.",
    fix, short: "Codex import missing",
  });
  if (emails.length) issues.push({
    id: "codex-import:shadowed", severity: "error", title: "Email-keyed OpenAI profiles capture the Codex import",
    detail: `Remove before importing: ${emails.map((p) => p.id).join(", ")}. A models status probe is not an app-server login test.`,
    fix, short: "Codex import shadowed",
  });
  return issues;
}
export function modelPolicyIssues({ policies, paths, agents = {}, armySummary = null, modelsInUse = null }) {
  const models = new Set(modelsInUse ?? []);
  for (const a of Object.values(agents ?? {})) {
    const provider = agentProviderId(a);
    if (provider && a.model && a.model !== "auto") models.add(`${provider}/${a.model}`);
  }
  for (const role of Object.values(armySummary?.roles ?? {})) {
    const provider = agentProviderId(agents?.[role.agent]);
    if (provider && role.model && role.model !== "auto" && !role.modelIsAuto) models.add(`${provider}/${role.model}`);
  }
  return policies.flatMap((result, i) => {
    let allow;
    try { allow = result.ok ? JSON.parse(result.stdout) : null; } catch { return []; }
    if (!Array.isArray(allow)) return [];
    const missing = [...models].filter((m) => !allow.includes(m)).sort();
    if (!missing.length) return [];
    return [{ id: `model-policy:${paths[i]}`, severity: "error", title: `OpenClaw model policy excludes: ${missing.join(", ")}`,
      detail: `${paths[i]} refuses models used by nomArmy agents or roles.`,
      fix: `openclaw config unset ${paths[i].replace(/\.allow$/, "")} (or add the missing models to ${paths[i]})`, short: "models blocked" }];
  });
}
