// Which OpenClaw release nomArmy keeps: the tested pin ("tested", the
// default), or npm's latest ("latest") so new models arrive with each vendor
// plugin release instead of waiting for a nomArmy release. Machine-wide, in
// limits.yml, like the installation it describes.
//
// "latest" is never below the pin, and an upgrade to it has to prove itself:
// the models the roles use are test-called before and after, and a model
// that answered before and fails after rolls OpenClaw and the vendor plugins
// back to the exact versions that worked.

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { limitsPath } from "./limits.mjs";
import { PINNED_OPENCLAW_VERSION } from "./openclaw-pin.mjs";
import { parseOpenclawVersion, versionAtLeast } from "./subscription-setup.mjs";
import { repairOpenclaw, runOpenclawCommand, openclawInstallPlan, pluginUpdatePlan } from "./openclaw-install.mjs";

export const OPENCLAW_CHANNELS = Object.freeze(["tested", "latest"]);

/** The configured channel; anything unreadable or unknown is "tested". */
export function openclawChannel({ filePath = limitsPath() } = {}) {
  try {
    const value = YAML.parse(fs.readFileSync(filePath, "utf8"))?.openclaw;
    return OPENCLAW_CHANNELS.includes(value) ? value : "tested";
  } catch { return "tested"; }
}

/** Write `openclaw: <channel>`, keeping the rest of limits.yml (comments included). */
export function setOpenclawChannel(channel, { filePath = limitsPath() } = {}) {
  if (!OPENCLAW_CHANNELS.includes(channel)) throw new Error(`openclaw must be ${OPENCLAW_CHANNELS.join(" or ")}, got "${channel}"`);
  const text = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "# Machine-wide settings for nomArmy.\n";
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) throw new Error(`${filePath} is not valid YAML: ${doc.errors[0].message}`);
  if (doc.contents === null) doc.contents = doc.createNode({});
  doc.set("openclaw", channel);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, String(doc));
  return channel;
}

/**
 * The release to install: the pin, or for "latest" npm's latest when it's
 * newer. An npm lookup that fails falls back to the pin, with a note.
 * @returns {{ target: string, note: string|null }}
 */
export function resolveOpenclawTarget(channel, { run = runOpenclawCommand, skipped = [], installed = null } = {}) {
  if (channel !== "latest") return { target: PINNED_OPENCLAW_VERSION, note: null };
  const viewed = run("npm", ["view", "openclaw@latest", "version"], { timeoutMs: 60000 });
  const latest = viewed.ok ? parseOpenclawVersion(viewed.stdout) : null;
  if (!latest) return { target: PINNED_OPENCLAW_VERSION, note: `couldn't read npm's latest OpenClaw (${viewed.timedOut ? "timed out" : "npm view failed"}); kept the tested ${PINNED_OPENCLAW_VERSION}` };
  if (skipped.includes(latest.join("."))) {
    const keep = installed && versionAtLeast(parseOpenclawVersion(installed), PINNED_OPENCLAW_VERSION) ? installed : PINNED_OPENCLAW_VERSION;
    return { target: keep, note: `OpenClaw ${latest.join(".")} broke a model here and was rolled back; staying on ${keep} until a newer release` };
  }
  return versionAtLeast(latest, PINNED_OPENCLAW_VERSION)
    ? { target: latest.join("."), note: null }
    : { target: PINNED_OPENCLAW_VERSION, note: `npm's latest OpenClaw (${latest.join(".")}) is older than the tested ${PINNED_OPENCLAW_VERSION}; kept the tested release` };
}

/** Releases a "latest" upgrade rolled back, in `file` (JSON list). */
export function skippedReleases(file) {
  try { const list = JSON.parse(fs.readFileSync(file, "utf8")); return Array.isArray(list) ? list.filter((v) => typeof v === "string") : []; } catch { return []; }
}
function skipRelease(file, version) {
  if (!file) return;
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify([...new Set([...skippedReleases(file), version])])); } catch { /* best-effort */ }
}

/**
 * "provider/model" for every api or subscription model a role or an agent's
 * default names: what an OpenClaw upgrade must keep working. "auto" roles
 * have no fixed model and the local model doesn't go through a vendor plugin.
 */
export function modelsToCheck({ agents = {}, roles = {}, providerOf }) {
  const models = new Set();
  const add = (agent, model) => {
    if (!agent || agent.kind === "local" || !model || model === "auto") return;
    try { const provider = providerOf(agent); if (provider) models.add(`${provider}/${model}`); } catch { /* unknown shape */ }
  };
  for (const role of Object.values(roles)) add(agents[role.agent], role.modelIsAuto ? null : role.model);
  for (const agent of Object.values(agents)) add(agent, agent.model);
  return [...models].sort();
}

async function probeAll(models, probe) {
  const results = await Promise.all(models.map(async (model) => {
    const [provider, ...rest] = model.split("/");
    try { return [model, await probe({ provider, model: rest.join("/") })]; }
    catch (error) { return [model, { ok: false, refused: false, reason: error.message }]; }
  }));
  return Object.fromEntries(results);
}

/**
 * Bring OpenClaw and the vendor plugins to the channel's target. On
 * "latest", an actual upgrade is checked against the models in use and
 * rolled back to the exact previous release if one that answered before
 * fails after. `probe({ provider, model })` is lib/model-probe.mjs's probeModel.
 * @returns {Promise<{ ok: boolean, target: string, previous: string|null, changed: string[], declined?: boolean, rolledBack?: boolean, broke?: object[] }>}
 */
export async function upgradeOpenclaw({
  channel = "tested", run = runOpenclawCommand, command = "openclaw", vendors = [], prefix = null,
  yes = false, isTTY = false, ask = async () => "", print = console.log,
  models = [], probe = null, repair = repairOpenclaw, skipFile = null,
} = {}) {
  const version = run(command, ["--version"]);
  const previous = version.ok ? parseOpenclawVersion(version.stdout)?.join(".") ?? null : null;
  const { target, note } = resolveOpenclawTarget(channel, { run, skipped: skipFile ? skippedReleases(skipFile) : [], installed: previous });
  if (note) print(`Note: ${note}.`);
  // Plugins carry model support too, so a plugin-only update is checked as well.
  const planned = previous !== null && channel === "latest" && probe && models.length
    && (openclawInstallPlan(version.stdout, { target }).length > 0 || pluginUpdatePlan({ run, command, vendors, target }).length > 0);
  const check = Boolean(planned);
  let before = {};
  if (check) {
    print(`Checking ${models.length} model${models.length === 1 ? "" : "s"} on OpenClaw ${previous} before updating to ${target}...`);
    before = await probeAll(models, probe);
  }
  const result = await repair({ run, command, vendors, prefix, yes, isTTY, ask, print, target });
  const outcome = { ...result, target, previous, changed: result.changed ?? [] };
  if (!check || !result.ok || !outcome.changed.length) return outcome;
  const answered = models.filter((model) => before[model]?.ok);
  if (!answered.length) return outcome;
  print(`Checking the same models on OpenClaw ${target}...`);
  const after = await probeAll(answered, probe);
  const broke = answered.filter((model) => !after[model]?.ok).map((model) => ({ model, reason: after[model]?.reason ?? null }));
  if (!broke.length) { print(`OpenClaw ${target}: every model that worked on ${previous} still answers.`); return outcome; }
  // Never below the tested release, whatever was installed before.
  const backTo = versionAtLeast(parseOpenclawVersion(previous), PINNED_OPENCLAW_VERSION) ? previous : PINNED_OPENCLAW_VERSION;
  print(`OpenClaw ${target} broke ${broke.map((b) => `${b.model}${b.reason ? ` (${b.reason})` : ""}`).join(", ")}. Rolling back to ${backTo}.`);
  skipRelease(skipFile, target);
  const back = await repair({ run, command, vendors, prefix, yes: true, isTTY: false, ask, print, target: backTo, exact: true });
  print(back.ok ? `Rolled back to OpenClaw ${backTo}. Updates skip ${target} and try the next newer release.` : `Rolling back to ${backTo} didn't finish; run: nomarmy doctor --fix`);
  return { ...outcome, ok: false, rolledBack: back.ok, broke };
}
