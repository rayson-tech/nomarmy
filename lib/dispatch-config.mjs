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

import { dispatchConfigSchema, formatDispatchIssues, findReservedPoolName } from "./dispatch-schema.mjs";

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

  const reserved = findReservedPoolName(candidate);
  if (reserved) {
    throw new DispatchConfigError(`${path.basename(configPath)} uses "${reserved}" as a pool name, which is reserved`, {
      path: configPath,
      errors: [`pools.${reserved}: "${reserved}" is a reserved name and cannot be used as a pool name`],
    });
  }

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
 * Weighted-random pick over `pool`'s currently-available (authenticated,
 * under-capacity) entries. Stateless on purpose -- nomArmy keeps no
 * persistent scheduler state across jobs or process restarts, and a
 * weighted-random pick needs none to converge on the configured ratios over
 * many dispatches, unlike a round-robin cursor would. `rng` is injectable
 * for deterministic tests. `runningById` (entry id -> current in-flight
 * count, supplied by the caller -- mcp/server.mjs tracks this per pool
 * entry) enforces each entry's own `max_concurrent`; omitted, no entry is
 * excluded on capacity grounds, only on missing auth.
 * @throws if no entry in the pool has its auth_env set, or (a distinct,
 *   more specific error) if every authenticated entry is already at its cap.
 */
export function pickProvider(pool, { rng = Math.random, runningById = {} } = {}) {
  const authenticated = availableEntries(pool);
  if (authenticated.length === 0) {
    throw new Error(
      "no provider in this pool has its auth_env set -- export the credential, or run `nomarmy providers list` to see what's missing",
    );
  }
  const available = authenticated.filter((entry) => !entry.max_concurrent || (runningById[entry.id] || 0) < entry.max_concurrent);
  if (available.length === 0) {
    throw new Error(
      "every authenticated provider in this pool is already at its max_concurrent limit -- wait for one to finish, or raise max_concurrent in config/providers.yml",
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
  const pools = dispatchConfig?.config?.pools;
  // hasOwnProperty, not a truthy lookup: `pools?.["__proto__"]` on a plain
  // object returns Object.prototype itself -- a real, truthy value even
  // when no such pool was ever configured (loadDispatchConfig already
  // refuses to load a config that legitimately declares one) -- and would
  // otherwise reach pickProvider() and crash with a confusing
  // "pool.filter is not a function" instead of this function's own clear,
  // purpose-built "unknown pool" error.
  const pool = pools && Object.prototype.hasOwnProperty.call(pools, poolName) ? pools[poolName] : undefined;
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
