// Pool selection and context budgeting for api agents. Each api agent in
// agents.yml (lib/agents.mjs) reaches this code as a one-entry pool, which
// is the shape it was written for.

import { openclawProviderId } from "./dispatch-schema.mjs";

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
      "every authenticated provider in this pool is already at its max_concurrent limit -- wait for one to finish, or raise the agent's max_concurrent in agents.yml",
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
  // when no such pool was ever configured (lib/agents.mjs already refuses
  // a file that declares one) -- and would
  // otherwise reach pickProvider() and crash with a confusing
  // "pool.filter is not a function" instead of this function's own clear,
  // purpose-built "unknown pool" error.
  const pool = pools && Object.prototype.hasOwnProperty.call(pools, poolName) ? pools[poolName] : undefined;
  if (!pool) {
    const known = Object.keys(dispatchConfig?.config?.pools || {});
    throw new Error(
      known.length
        ? `unknown api agent "${poolName}" -- your api agents are: ${known.join(", ")}`
        : `unknown api agent "${poolName}" -- none are defined yet (run \`nomarmy agents add api\`)`,
    );
  }
  return pool;
}

// --- Model-dependent context budgeting for hosted (non-llama-cpp) entries -

/** Reserve this fraction of a model's rated context window before using it
 * to size a brief/report -- the rating is the provider's own ceiling, not a
 * safe working room once a system prompt, tool calls and generation share
 * it. Applied uniformly to every hosted entry regardless of where its window
 * came from (catalog lookup, explicit override, or the unknown-model
 * fallback), never to a llama-cpp entry's LOCALLY PROBED context -- that
 * number is already precise, not a rating that needs a safety margin. */
export const CONTEXT_WINDOW_BUFFER = 0.75;

/** Used only when a hosted entry has no `context_window` override AND isn't
 * in OpenClaw's cached model catalog (a model newer than that cache, most
 * likely -- see lib/model-catalog.mjs). Deliberately conservative rather
 * than optimistic: admitting a brief sized for a window the model may not
 * actually have is the failure mode this whole mechanism exists to avoid. */
export const UNKNOWN_MODEL_CONTEXT_FALLBACK = 32000;

/**
 * The context window this ONE entry should be budgeted against, before the
 * buffer: an explicit `context_window` override always wins (it exists
 * specifically for a model the catalog doesn't know yet); otherwise
 * OpenClaw's own model catalog (`catalog`, a "<provider>/<model>" -> tokens
 * Map from lib/model-catalog.mjs's queryModelCatalog); otherwise the
 * conservative unknown-model fallback, never a silent "assume it's fine".
 * Returns null for a `llama-cpp` entry -- the caller has a more precise,
 * already-probed local number and should use that instead.
 */
export function resolveEntryContext(entry, { catalog = null } = {}) {
  if (entry.provider === "llama-cpp") return null;
  if (entry.context_window) return { raw: entry.context_window, source: `agents.yml context_window override (${entry.id})` };
  const key = `${openclawProviderId(entry)}/${entry.model}`;
  const looked = catalog?.get(key);
  if (looked) return { raw: looked, source: `openclaw model catalog (${key})` };
  return {
    raw: UNKNOWN_MODEL_CONTEXT_FALLBACK,
    source: `unknown model "${key}" -- not in openclaw's cached catalog and no context_window override set (run \`openclaw models list --refresh\`, or set the agent's context_window in agents.yml); using a conservative ${UNKNOWN_MODEL_CONTEXT_FALLBACK}-token fallback`,
  };
}

/**
 * The precise {contextPerNom, source} budget input for ONE already-selected
 * entry -- used at actual dispatch time (mcp/server.mjs's runOpenClaw,
 * right after resolvePoolSelection picks a specific entry) to size that
 * job's own brief/report generously instead of a pool-wide worst case.
 * `localContextPerNom` is the existing local resolution (resolveContextPerNom
 * in lib/budget.mjs) -- passed through unbuffered for a llama-cpp entry,
 * since that number is already a live probe, not a rated ceiling.
 */
export function entryContextPerNom(entry, { catalog = null, localContextPerNom = null } = {}) {
  if (entry.provider === "llama-cpp") {
    return Number.isFinite(localContextPerNom) && localContextPerNom > 0
      ? { contextPerNom: localContextPerNom, source: "local llama-server" }
      : null;
  }
  const resolved = resolveEntryContext(entry, { catalog });
  return {
    contextPerNom: Math.floor(resolved.raw * CONTEXT_WINDOW_BUFFER),
    source: `${resolved.source}, buffered to ${Math.round(CONTEXT_WINDOW_BUFFER * 100)}%`,
  };
}

/**
 * The conservative {contextPerNom, source} budget input for a NAMED pool
 * BEFORE dispatch has picked a specific entry -- used at admission time
 * (mcp/server.mjs's admit(), via checkBrief) when a job names `pool` but
 * pickProvider's weighted-random choice hasn't run yet, so which entry it
 * lands on isn't known. Takes the MINIMUM across every currently-available
 * (authenticated) entry's own budget, so an admitted brief can never
 * overflow whichever entry the weighted picker actually chooses.
 * Returns null if the pool has no available entries right now (pickProvider
 * itself will raise the real, specific error at dispatch time -- this isn't
 * the place to duplicate that), or if every available entry is `llama-cpp`
 * and no `localContextPerNom` was given.
 */
export function poolContextPerNom(pool, env, { catalog = null, localContextPerNom = null } = {}) {
  const available = availableEntries(pool, env);
  let min = null, minSource = null;
  for (const entry of available) {
    const resolved = entryContextPerNom(entry, { catalog, localContextPerNom });
    if (!resolved) continue;
    if (min === null || resolved.contextPerNom < min) { min = resolved.contextPerNom; minSource = resolved.source; }
  }
  if (min === null) return null;
  return { contextPerNom: min, source: `pool minimum across ${available.length} available entr${available.length === 1 ? "y" : "ies"} (${minSource})` };
}
