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
//   cli-session    OpenClaw runs the vendor CLI itself, which uses its own
//                  logged-in session; nothing to link (Claude, and Muse
//                  Code through nomArmy's muse-cli plugin).
//   openclaw-login OpenClaw's plugin wants its own `models auth login` on
//                  top of the vendor CLI's login (Codex). `loginProvider`
//                  is the id that login takes when it differs from the
//                  provider the models run under.

import { modelRejection } from "./openclaw-errors.mjs";
import { PINNED_OPENCLAW_VERSION } from "./openclaw-pin.mjs";

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
    provider: "muse-cli",
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
    // nomArmy's own OpenClaw plugin (openclaw-plugin/muse-cli), which runs
    // `muse exec`. Meta's own plugin calls api.meta.ai with the key `muse
    // login` mints, and Meta now refuses that key (403) from anything but
    // Muse Code's client, so a subscription has to go through the CLI.
    plugin: Object.freeze({ id: "muse-cli", bundled: "openclaw-plugin/muse-cli" }),
    // OpenClaw's own id for Meta's API, which a Muse Code plan no longer
    // covers: signing in to it by hand goes to this setup instead.
    formerProviders: Object.freeze(["meta"]),
    credential: Object.freeze({ kind: "cli-session" }),
    defaultModel: "muse-spark-1.3",
  }),
});

/**
 * A vendor plugin's install spec at the tested OpenClaw release. Unversioned,
 * ClawHub serves its latest, which can need a newer OpenClaw than the one
 * nomArmy installs (codex 2026.10.2 on OpenClaw 2026.10.1). The vendor
 * plugins release in step with OpenClaw, under the same version.
 */
export function pinnedPluginSpec(plugin, version = PINNED_OPENCLAW_VERSION) {
  return `${plugin.spec}@${version}`;
}

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
 * A test call's outcome, from both streams: { ok, reason }.
 *
 * It must read the way a job does. A model the provider refuses fails
 * with a model_not_found reason in the run log; a run that answered and
 * then hit OpenClaw's known cleanup error (Codex: "Agent runtime cleanup did
 * not settle", after stopReason=stop) worked, and jobs salvage it too.
 */
export function probeOutcome({ stdout = "", stderr = "" } = {}) {
  if (probeSucceeded(stdout)) return { ok: true, reason: null };
  const rejected = modelRejection(`${stderr}\n${stdout}`);
  if (rejected) return { ok: false, reason: rejected.message };
  if (/ended with stopReason=stop\b/.test(stderr) && /cleanup/i.test(`${stdout}\n${stderr}`)) return { ok: true, reason: null };
  const message = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(stdout)?.[1];
  return { ok: false, reason: message ? message.replace(/\\"/g, '"').slice(0, 300) : null };
}

/**
 * A probe answer that means the login itself failed, not the model.
 * 401, a missing bearer, no usable profiles, or an unavailable selected
 * profile are sign-in failures. A refusal, rate limit, or timeout is not.
 */
export function openclawSignInFailure(text) {
  const s = String(text ?? "");
  return /\b401\b/.test(s)
    || /missing bearer/i.test(s)
    || /no usable profiles/i.test(s)
    || /selected auth profile\b[^]{0,240}?\bis unavailable/i.test(s);
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
 * Subscriptions signed in through OpenClaw's own login for the provider
 * (`openclaw models auth login --provider <id>`), with no vendor CLI of
 * their own. `openclaw` is any provider by id; the others are presets.
 * OpenClaw does the authenticating and keeps the credential; nomArmy only
 * starts the flow and then proves it with a real test call.
 */
export const OPENCLAW_SIGN_IN_PRESETS = Object.freeze({
  grok: Object.freeze({ label: "xAI Grok (SuperGrok or X Premium+)", provider: "xai", defaultName: "grok" }),
  openclaw: Object.freeze({ label: "Another provider, with OpenClaw's own sign-in (OpenRouter, MiniMax, Qwen, ...)", provider: null, defaultName: null }),
});

/**
 * Saved API keys for `provider`, which a subscription sign-in doesn't
 * replace. A job runs on whichever profile OpenClaw picks for the provider,
 * so a key left behind could bill the metered API instead of the plan.
 * Tokens stay: some plans (token plans) sign in with one.
 */
export function competingProviderProfiles(profiles, provider) {
  return (profiles ?? []).filter((profile) => profile?.provider === provider && profile.type === "api_key");
}
