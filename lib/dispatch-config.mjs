// nomArmy multi-provider dispatch pool loader (v1.3).
//
// config/providers.yml is nomArmy's OWN tool-level config, not a target
// repository's .nomarmy.yml -- it lives alongside config/common.env and
// describes named pools of weighted worker-provider entries a job can be
// dispatched against with `pool: "<name>"` instead of the single global
// NOMARMY_WORKER_PROVIDER/NOMARMY_WORKER_MODEL pair.
//
// A missing file is not an error: a fresh install with no config/providers.yml
// gets { found: false } and every job continues to use `profile` exactly as
// before this existed -- this is purely additive and opt-in, the same
// backward-compatibility contract lib/config.mjs's loadConfig already keeps
// for .nomarmy.yml.

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import { dispatchConfigSchema, formatDispatchIssues } from "./dispatch-schema.mjs";

export const DISPATCH_CONFIG_FILENAME = "providers.yml";

/** Raised when config/providers.yml exists but cannot be used. Carries the
 * same readable `path: message` lines lib/config.mjs's ConfigError does, so
 * a caller never has to re-derive them from the message text. */
export class DispatchConfigError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "DispatchConfigError";
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

/** Absolute path config/providers.yml would live at under nomarmyRoot,
 * whether or not it currently exists. */
export function dispatchConfigPath(nomarmyRoot) {
  return path.join(nomarmyRoot, "config", DISPATCH_CONFIG_FILENAME);
}

/**
 * Find, parse and validate config/providers.yml under `nomarmyRoot`.
 * @param {string} nomarmyRoot
 * @returns {{ found: boolean, path: string|null, config: { pools: object }|null }}
 */
export function loadDispatchConfig(nomarmyRoot) {
  const configPath = dispatchConfigPath(nomarmyRoot);
  if (!isReadableFile(configPath)) {
    return { found: false, path: null, config: null };
  }

  let text;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    throw new DispatchConfigError(`${path.basename(configPath)} could not be read: ${error.message}`, {
      path: configPath,
      errors: [`config: could not be read: ${error.message}`],
      cause: error,
    });
  }

  let parsed;
  try {
    parsed = YAML.parse(text, { prettyErrors: true });
  } catch (error) {
    throw new DispatchConfigError(`${path.basename(configPath)} is not valid YAML: ${error.message}`, {
      path: configPath,
      errors: [`config: is not valid YAML: ${error.message}`],
      cause: error,
    });
  }
  const candidate = parsed === null || parsed === undefined ? {} : parsed;

  const result = dispatchConfigSchema.safeParse(candidate);
  if (!result.success) {
    const errors = formatDispatchIssues(result.error);
    const detail = errors.map((line) => `  - ${line}`).join("\n");
    throw new DispatchConfigError(`${path.basename(configPath)} is not a valid providers.yml:\n${detail}`, {
      path: configPath,
      errors,
    });
  }

  return { found: true, path: configPath, config: result.data };
}

/** Serialize a dispatch config object back to YAML text -- the only write
 * entry point, so `nomarmy providers add/remove` never hand-builds YAML. */
export function stringifyDispatchConfig(config) {
  return YAML.stringify(config);
}

/**
 * Entries in `pool` whose declared `auth_env` is actually set right now.
 * `llama-cpp` entries have no `auth_env` and are always available.
 * Filtering here, not at selection time, means an unconfigured provider is
 * simply invisible to dispatch rather than a per-job failure the operator
 * can't see coming until a job happens to land on it.
 */
export function availableEntries(pool, env = process.env) {
  return (pool || []).filter((entry) => !entry.auth_env || Boolean(env[entry.auth_env]));
}

/**
 * Weighted-random pick over `pool`'s currently-available (authenticated)
 * entries. Stateless on purpose -- nomArmy keeps no persistent scheduler
 * state across jobs or process restarts, and a weighted-random pick needs
 * none to converge on the configured ratios over many dispatches, unlike a
 * round-robin cursor would. `rng` is injectable for deterministic tests.
 * @throws if no entry in the pool has its auth_env set.
 */
export function pickProvider(pool, { rng = Math.random } = {}) {
  const available = availableEntries(pool);
  if (available.length === 0) {
    throw new Error(
      "no provider in this pool has its auth_env set -- export the credential, or run `nomarmy providers list` to see what's missing",
    );
  }
  const totalWeight = available.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = rng() * totalWeight;
  for (const entry of available) {
    roll -= entry.weight;
    if (roll <= 0) return entry;
  }
  return available[available.length - 1]; // floating-point guard; statistically unreachable
}

/**
 * Look up a named pool in a loaded dispatch config, or throw a clear error
 * naming which pools DO exist -- a typo in `pool` must never silently fall
 * back to local capacity without saying so.
 */
export function resolvePool(dispatchConfig, poolName) {
  const pool = dispatchConfig?.config?.pools?.[poolName];
  if (!pool) {
    const known = Object.keys(dispatchConfig?.config?.pools || {});
    throw new Error(
      known.length
        ? `unknown pool "${poolName}" -- configured pools are: ${known.join(", ")}`
        : `unknown pool "${poolName}" -- no pools are configured yet (config/providers.yml missing or empty); run \`nomarmy providers add\` first`,
    );
  }
  return pool;
}
