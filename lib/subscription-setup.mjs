// Pure pieces of `nomarmy subscriptions setup <vendor>` -- the guided path
// that wraps every OpenClaw step behind one command so an operator never has
// to know OpenClaw is involved for the common case. bin/nomarmy.mjs owns the
// actual subprocess calls and prompts; everything here is parse/decide logic
// so it can be tested without a real TTY, a real login, or a real network.
//
// Every value in SUBSCRIPTION_VENDORS was confirmed live against a real
// install, not taken from docs: "claude-cli" (not "anthropic-cli", a wrong
// guess that cost real time), Codex needing OpenAI's own @openai/codex CLI
// installed separately, @openclaw/codex needing OpenClaw >= 2026.9.5, and a
// ChatGPT plan running under OpenClaw's `openai` provider, not `codex` (the
// codex login is imported as an `openai/oauth` profile; `codex/<model>`
// answers "Unknown model" while `openai/gpt-6-astra` completes).
// KNOWN TO DRIFT: if OpenClaw or a vendor renames any of this, the table goes
// stale before nomArmy's own code does.
//
// `credential.kind` is how the subscription credential actually reaches
// OpenClaw, and it genuinely differs per vendor (each confirmed live):
//   cli-session    OpenClaw reuses the vendor CLI's own logged-in session
//                  directly; nothing to link (Claude).
//   openclaw-login OpenClaw's plugin wants its own `models auth login` on
//                  top of the vendor CLI's login (Codex). `loginProvider`
//                  is the id that login takes when it differs from the
//                  provider the models run under.
//   minted-key     The vendor CLI's login mints a Model API key into the OS
//                  keychain, and OpenClaw's plugin only accepts an API key
//                  (Meta: @openclaw/meta-provider declares authMethods
//                  ["api-key"] only). Meta's own subscription docs say the
//                  flat rate covers "the Muse Code API key that is
//                  automatically connected in the Muse Code CLI onboarding
//                  process" -- that minted key, not one you create by hand
//                  (those bill pay-as-you-go). It is copied into OpenClaw by
//                  stdin on every setup run, since it can rotate.

export const SUBSCRIPTION_VENDORS = Object.freeze({
  claude: Object.freeze({
    label: "Anthropic Claude (Pro/Max/Team seat)",
    provider: "claude-cli",
    cli: Object.freeze({
      bin: "claude",
      npmPackage: null,
      installHint: "Install Claude Code first: https://claude.com/claude-code",
      statusArgs: ["auth", "status"],
      loginArgs: ["auth", "login"],
    }),
    plugin: null,
    credential: Object.freeze({ kind: "cli-session" }),
    defaultModel: null,
  }),
  codex: Object.freeze({
    label: "OpenAI Codex (ChatGPT plan)",
    provider: "openai",
    cli: Object.freeze({
      bin: "codex",
      npmPackage: "@openai/codex",
      installHint: "npm install -g @openai/codex",
      statusArgs: ["login", "status"],
      loginArgs: ["login"],
    }),
    plugin: Object.freeze({ id: "codex", spec: "clawhub:@openclaw/codex", minOpenclaw: "2026.9.5" }),
    credential: Object.freeze({ kind: "openclaw-login", loginProvider: "codex" }),
    // The top entry in Codex's own ~/.codex/models_cache.json.
    defaultModel: "gpt-6-astra",
  }),
  meta: Object.freeze({
    label: "Meta Muse Code (subscription)",
    provider: "meta",
    cli: Object.freeze({
      bin: "muse",
      npmPackage: null,
      installHint: "Install Muse Code first (Meta's developer site, dev.meta.ai)",
      // No status subcommand exists; `muse login` records a non-secret
      // descriptor here (mechanism/storage/obtained_via -- confirmed live),
      // and the credential itself goes to the OS keychain.
      statusArgs: null,
      statusFile: "~/.config/muse/auth.json",
      loginArgs: ["login"],
    }),
    plugin: Object.freeze({ id: "meta", spec: "clawhub:@openclaw/meta-provider", minOpenclaw: "2026.9.3" }),
    credential: Object.freeze({
      kind: "minted-key",
      keychain: Object.freeze({ service: "ai.meta.dev.credentials", account: "meta", field: "api_key" }),
      profileId: "meta:subscription",
    }),
    // The plugin manifest's own defaultModel; Meta models don't appear in
    // OpenClaw's catalog until a credential is linked.
    defaultModel: "muse-spark-1.3",
  }),
});

/** "OpenClaw 2026.9.5 (ec9c1a1)" -> [2026, 9, 5], or null if unparseable. */
export function parseOpenclawVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ""));
  return match ? match.slice(1, 4).map(Number) : null;
}

/** True when `have` ([a,b,c]) is at least the dotted `min` string. */
export function versionAtLeast(have, min) {
  const want = parseOpenclawVersion(min);
  if (!have || !want) return false;
  for (let i = 0; i < 3; i++) {
    if (have[i] > want[i]) return true;
    if (have[i] < want[i]) return false;
  }
  return true;
}

/**
 * Model ids for one provider from `openclaw models list --refresh` output,
 * which prints one `<provider>/<model>  <capabilities> ...` row per model.
 * Returned without the provider prefix, in catalog order, de-duplicated.
 */
export function parseCatalogModels(listOutput, provider) {
  const prefix = `${provider}/`;
  const models = [];
  for (const line of String(listOutput ?? "").split(/\r?\n/)) {
    const first = line.trim().split(/\s+/)[0] ?? "";
    if (first.startsWith(prefix) && first.length > prefix.length) models.push(first.slice(prefix.length));
  }
  return [...new Set(models)];
}

/**
 * Whether a vendor CLI's own status command says it's logged in, plus the
 * account email when the CLI reports one (used as the default owner, so the
 * operator doesn't retype who they are). Claude prints JSON
 * (`{"loggedIn":true,"email":...}`); Codex prints a line like
 * "Logged in using ChatGPT". Anything unrecognized is "not logged in" --
 * running the login again is harmless, silently skipping a needed one isn't.
 */
export function parseCliLoginStatus(vendorKey, output) {
  const text = String(output ?? "");
  if (vendorKey === "claude") {
    try {
      // stdout and stderr arrive merged (see bin/nomarmy.mjs's runQuiet), so
      // parse just the JSON object, not the whole blob.
      const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
      return { loggedIn: parsed.loggedIn === true, email: typeof parsed.email === "string" ? parsed.email : null, subscriptionType: parsed.subscriptionType ?? null };
    } catch {
      return { loggedIn: false, email: null, subscriptionType: null };
    }
  }
  if (vendorKey === "codex") {
    return { loggedIn: /^\s*logged in\b/im.test(text) && !/not logged in/i.test(text), email: null, subscriptionType: /chatgpt/i.test(text) ? "chatgpt" : null };
  }
  return { loggedIn: false, email: null, subscriptionType: null };
}

/**
 * The one-token probe envelope `openclaw agent exec --json` returns; true
 * only on a real completion. Tolerates log lines around the envelope (it
 * is parsed from its first "{" line to its last "}"), since OpenClaw
 * writes a colored run log to stderr and callers may have merged the two.
 */
export function probeSucceeded(stdout) {
  const text = String(stdout ?? "");
  const start = text.search(/^\{/m), end = text.lastIndexOf("}");
  if (start === -1 || end < start) return false;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed?.ok === true && typeof parsed.final === "string" && parsed.final.length > 0;
  } catch {
    return false;
  }
}

/**
 * Muse Code's non-secret login descriptor (~/.config/muse/auth.json) ->
 * { loggedIn, email }. Reads only descriptor fields; the credential itself
 * is never in this file (storage: "keychain").
 */
export function parseMuseAuthDescriptor(text) {
  try {
    const meta = JSON.parse(String(text ?? ""))?.providers?.meta;
    return { loggedIn: Boolean(meta?.mechanism), email: typeof meta?.user_email === "string" ? meta.user_email : null, subscriptionType: meta?.mechanism ? "muse-code" : null };
  } catch {
    return { loggedIn: false, email: null, subscriptionType: null };
  }
}

/**
 * The minted API key out of a keychain JSON blob, or null. Muse's blob holds
 * both an `api_key` ("LLM|<id>|<secret>") and an OAuth `access_token`; only
 * the api_key works as a bearer against api.meta.ai, so anything that isn't
 * that exact three-part shape is refused rather than passed on.
 */
export function extractMintedKey(blob, field) {
  try {
    const value = JSON.parse(String(blob ?? ""))?.[field];
    return typeof value === "string" && /^LLM\|[^|\s]+\|[^|\s]+$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** A default worker name like "jason-claude" from an owner email and vendor key. */
export function defaultWorkerName(owner, vendorKey) {
  const local = String(owner ?? "").split("@")[0].split(/[._+-]/)[0].toLowerCase().replace(/[^a-z0-9]/g, "");
  return local ? `${local}-${vendorKey}` : vendorKey;
}
