// A provider plugin's own config step, which `paste-api-key` never runs.
//
// OpenClaw runs a model only when ~/.openclaw/openclaw.json has an entry
// for its provider under models.providers (base URL, API shape, models).
// A plugin writes that entry in its onboarding step -- the Meta plugin's
// applyMetaConfig -- which `openclaw onboard` calls. nomArmy links a
// subscription key with `openclaw models auth paste-api-key`, which saves
// the key and nothing else. So the catalog listed every Muse model (it asks
// Meta directly) while every job on one failed "Unknown model" (a real
// Senti run). This runs that same plugin function, only when the entry is
// missing, with a backup of the file first.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** OpenClaw's home directory (its config, extensions and state). */
export function openclawHome(env = process.env) {
  return env.OPENCLAW_STATE_DIR || path.join(env.HOME || os.homedir(), ".openclaw");
}

/** OpenClaw's config file (OPENCLAW_CONFIG_PATH, as OpenClaw itself honors). */
export function openclawConfigPath(home = openclawHome(), env = process.env) {
  return env.OPENCLAW_CONFIG_PATH || path.join(home, "openclaw.json");
}

/** Whether OpenClaw's config has an entry for this provider. */
export function providerConfigured(config, provider) {
  return Boolean(config?.models?.providers && Object.prototype.hasOwnProperty.call(config.models.providers, provider));
}

/** The parsed openclaw.json, or null when it's missing or unreadable. */
export function readOpenclawConfig(home = openclawHome()) {
  try { return JSON.parse(fs.readFileSync(openclawConfigPath(home), "utf8")); } catch { return null; }
}

const modelId = (entry) => (typeof entry === "string" ? entry : entry?.id);

/**
 * Apply a plugin's provider config if its entry is missing, or, when it's
 * there, add the models the plugin now lists that the entry lacks. A plugin
 * update brings new models (Meta's 2026.10.3 added muse-wonder-1.0), but the
 * entry written by the older plugin lists models explicitly, so they stay
 * "Unknown model" until it's refreshed. A refresh only adds model entries;
 * nothing else in the file changes.
 * @param {{ provider: string, pluginId: string, module: string, exportName: string, home?: string }} spec
 * dryRun reports what it would do (wouldChange, added) and writes nothing.
 * @returns {Promise<{ changed: boolean, wouldChange?: boolean, backup?: string, added?: string[], error?: string }>}
 */
export async function ensureProviderConfig({ provider, pluginId, module, exportName, home = openclawHome(), dryRun = false }) {
  const file = openclawConfigPath(home);
  let config;
  try { config = JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { return { changed: false, error: `couldn't read ${file}: ${error.message}` }; }
  let apply;
  try { apply = (await import(pathToFileURL(path.join(home, "extensions", pluginId, module)).href))[exportName]; }
  catch (error) { return providerConfigured(config, provider) ? { changed: false } : { changed: false, error: `couldn't load the ${pluginId} plugin's config step: ${error.message}` }; }
  if (typeof apply !== "function") return providerConfigured(config, provider) ? { changed: false } : { changed: false, error: `the ${pluginId} plugin has no ${exportName}; it may have changed shape` };
  let next;
  try { next = apply(structuredClone(config)); } catch (error) { return providerConfigured(config, provider) ? { changed: false } : { changed: false, error: `the ${pluginId} plugin's config step failed: ${error.message}` }; }
  if (!providerConfigured(next, provider)) return providerConfigured(config, provider) ? { changed: false } : { changed: false, error: `the ${pluginId} plugin's config step didn't add a ${provider} provider entry` };
  let added = [];
  if (providerConfigured(config, provider)) {
    const current = config.models.providers[provider];
    if (!Array.isArray(current.models)) return { changed: false };
    const have = new Set(current.models.map(modelId));
    const missing = (Array.isArray(next.models.providers[provider].models) ? next.models.providers[provider].models : [])
      .filter((entry) => modelId(entry) && !have.has(modelId(entry)));
    if (!missing.length) return { changed: false };
    added = missing.map(modelId);
    next = structuredClone(config);
    next.models.providers[provider].models = [...current.models, ...missing];
  } else {
    // It may only add: every top-level section the file had must still be there.
    const dropped = Object.keys(config).filter((k) => !(k in next));
    if (dropped.length) return { changed: false, error: `refused: the ${pluginId} plugin's config step would remove ${dropped.join(", ")}` };
  }
  if (dryRun) return { changed: false, wouldChange: true, ...(added.length ? { added } : {}) };
  const backup = `${file}.before-nomarmy-${provider}${added.length ? "-models" : ""}`;
  fs.copyFileSync(file, backup);
  const tmp = `${file}.nomarmy-tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: fs.statSync(file).mode & 0o777 });
  fs.renameSync(tmp, file);
  return { changed: true, backup, ...(added.length ? { added } : {}) };
}

/** Refresh every configured vendor's provider entry (see ensureProviderConfig). Never throws. */
export async function refreshProviderConfigs(vendors, { home = openclawHome(), dryRun = false } = {}) {
  const results = [];
  for (const vendor of vendors) {
    if (!vendor?.plugin?.providerConfig) continue;
    try { results.push({ provider: vendor.provider, ...(await ensureProviderConfig({ provider: vendor.provider, pluginId: vendor.plugin.id, ...vendor.plugin.providerConfig, home, dryRun })) }); }
    catch (error) { results.push({ provider: vendor.provider, changed: false, error: error.message }); }
  }
  return results;
}
