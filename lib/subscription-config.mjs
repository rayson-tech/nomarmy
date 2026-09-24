// nomArmy subscription-backed worker loader.
//
// config/subscriptions.yml is nomArmy's OWN tool-level config, sibling to
// config/providers.yml, describing individually-owned, never-pooled worker
// entries -- see lib/subscription-schema.mjs's own header comment for why
// this is a separate structure and not a new pool provider type.
//
// A missing file is not an error: a fresh install with no
// config/subscriptions.yml gets { found: false }, and this feature is
// entirely opt-in, the same backward-compatibility contract
// lib/dispatch-config.mjs's loadDispatchConfig already keeps.

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import { subscriptionConfigSchema, formatSubscriptionIssues, findReservedWorkerName } from "./subscription-schema.mjs";
import { openclawProviderId } from "./dispatch-schema.mjs";

export const SUBSCRIPTION_CONFIG_FILENAME = "subscriptions.yml";

/** Raised when config/subscriptions.yml exists but cannot be used. Same
 * shape as lib/dispatch-config.mjs's DispatchConfigError. */
export class SubscriptionConfigError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "SubscriptionConfigError";
    this.errors = details.errors || [];
    this.path = details.path || null;
    if (details.cause !== undefined) this.cause = details.cause;
  }
}

function isReadableFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Absolute path config/subscriptions.yml would live at under nomarmyRoot,
 * whether or not it currently exists. */
export function subscriptionConfigPath(nomarmyRoot) {
  return path.join(nomarmyRoot, "config", SUBSCRIPTION_CONFIG_FILENAME);
}

/**
 * Find, parse and validate config/subscriptions.yml under `nomarmyRoot`.
 * @param {string} nomarmyRoot
 * @returns {{ found: boolean, path: string|null, config: { workers: object }|null }}
 */
export function loadSubscriptionConfig(nomarmyRoot) {
  const configPath = subscriptionConfigPath(nomarmyRoot);
  if (!isReadableFile(configPath)) {
    return { found: false, path: null, config: null };
  }

  let text;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    throw new SubscriptionConfigError(`${path.basename(configPath)} could not be read: ${error.message}`, {
      path: configPath,
      errors: [`config: could not be read: ${error.message}`],
      cause: error,
    });
  }

  let parsed;
  try {
    parsed = YAML.parse(text, { prettyErrors: true });
  } catch (error) {
    throw new SubscriptionConfigError(`${path.basename(configPath)} is not valid YAML: ${error.message}`, {
      path: configPath,
      errors: [`config: is not valid YAML: ${error.message}`],
      cause: error,
    });
  }
  const candidate = parsed === null || parsed === undefined ? {} : parsed;

  const reserved = findReservedWorkerName(candidate);
  if (reserved) {
    throw new SubscriptionConfigError(`${path.basename(configPath)} uses "${reserved}" as a worker name, which is reserved`, {
      path: configPath,
      errors: [`workers.${reserved}: "${reserved}" is a reserved name and cannot be used as a worker name`],
    });
  }

  const result = subscriptionConfigSchema.safeParse(candidate);
  if (!result.success) {
    const errors = formatSubscriptionIssues(result.error);
    const detail = errors.map((line) => `  - ${line}`).join("\n");
    throw new SubscriptionConfigError(`${path.basename(configPath)} is not a valid subscriptions.yml:\n${detail}`, {
      path: configPath,
      errors,
    });
  }

  return { found: true, path: configPath, config: result.data };
}

/** Serialize a subscription config object back to YAML text. */
export function stringifySubscriptionConfig(config) {
  return YAML.stringify(config);
}

/**
 * Look up a named worker in a loaded subscription config, or throw a clear
 * error naming which workers DO exist -- a typo in `subscription_worker`
 * must never silently fall back to anything else. There is no picker
 * function alongside this one, by design: dispatch to this mode always
 * names an entry, never selects one.
 */
export function resolveSubscriptionWorker(subscriptionConfig, name) {
  const workers = subscriptionConfig?.config?.workers;
  // hasOwnProperty, not a truthy lookup -- same reasoning as
  // lib/dispatch-config.mjs's resolvePool: `workers?.["__proto__"]` on a
  // plain object returns Object.prototype itself, a real truthy value even
  // though loadSubscriptionConfig already refuses to load a config that
  // legitimately declares one.
  const entry = workers && Object.prototype.hasOwnProperty.call(workers, name) ? workers[name] : undefined;
  if (!entry) {
    const known = Object.keys(subscriptionConfig?.config?.workers || {});
    throw new Error(
      known.length
        ? `unknown subscription_worker "${name}" -- configured workers are: ${known.join(", ")}`
        : `unknown subscription_worker "${name}" -- no workers are configured yet (config/subscriptions.yml missing or empty)`,
    );
  }
  return { id: name, ...entry };
}

/**
 * OpenClaw providers that BOTH a config/providers.yml pool entry and a
 * config/subscriptions.yml worker use. Some vendors (OpenAI, Meta, xAI) put their
 * subscription credential and their pay-as-you-go API key under the same
 * OpenClaw provider id -- so a pool entry for that provider could silently
 * run on the subscription credential (or a subscription worker on the
 * metered key), which is exactly the pooling this whole module exists to
 * prevent. Only Claude (claude-cli vs anthropic) uses distinct ids and
 * never collides. Callers refuse to dispatch either side of
 * a conflict rather than guess which credential OpenClaw will pick.
 * @returns {{ provider: string, poolEntries: string[], workers: string[] }[]}
 */
export function findProviderConflicts(pools = {}, workers = {}) {
  const poolByProvider = new Map();
  for (const [pool, entries] of Object.entries(pools || {})) {
    for (const entry of entries || []) {
      const provider = openclawProviderId(entry);
      if (!poolByProvider.has(provider)) poolByProvider.set(provider, []);
      poolByProvider.get(provider).push(`${pool}/${entry.id}`);
    }
  }
  const conflicts = new Map();
  for (const [name, entry] of Object.entries(workers || {})) {
    const poolEntries = poolByProvider.get(entry.provider);
    if (!poolEntries) continue;
    if (!conflicts.has(entry.provider)) conflicts.set(entry.provider, { provider: entry.provider, poolEntries, workers: [] });
    conflicts.get(entry.provider).workers.push(name);
  }
  return [...conflicts.values()];
}

/** One readable refusal line for a conflict, shared by dispatch and the CLI. */
export function describeProviderConflict(conflict) {
  return `OpenClaw provider "${conflict.provider}" is used by both pool entr${conflict.poolEntries.length === 1 ? "y" : "ies"} ${conflict.poolEntries.join(", ")} (config/providers.yml) and subscription worker${conflict.workers.length === 1 ? "" : "s"} ${conflict.workers.join(", ")} (config/subscriptions.yml) -- OpenClaw holds one credential per provider, so a pool job could run on the subscription (or a subscription job on the metered key). Remove one side before dispatching either.`;
}

/**
 * Look up the one worker declaring `role`, or throw a clear error naming
 * which roles DO exist -- the schema's own uniqueness check
 * (subscriptionConfigSchema's superRefine) already guarantees at most one
 * worker can ever declare a given role, so there is no ambiguity to resolve
 * here, only "found" or "not found". A DETERMINISTIC alternative to naming a
 * worker directly (see lib/subscription-schema.mjs's roleSchema comment for
 * why this is not the same thing as a weighted pick).
 */
export function resolveSubscriptionWorkerByRole(subscriptionConfig, role) {
  const workers = subscriptionConfig?.config?.workers || {};
  for (const [name, entry] of Object.entries(workers)) {
    if (entry.role === role) return { id: name, ...entry };
  }
  const known = Object.entries(workers).filter(([, e]) => e.role).map(([, e]) => e.role);
  throw new Error(
    known.length
      ? `unknown role "${role}" -- configured roles are: ${known.join(", ")}`
      : `unknown role "${role}" -- no worker in config/subscriptions.yml declares a role yet`,
  );
}
