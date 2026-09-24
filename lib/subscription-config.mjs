// Subscription agents at dispatch time: exact-name lookup (never a pick),
// and the one-credential-per-provider conflict check. The agents
// themselves are defined in agents.yml (lib/agents.mjs), which hands these
// functions the `{ config: { workers } }` shape they were written for.

import { openclawProviderId } from "./dispatch-schema.mjs";

/**
 * Look up a named worker in a loaded subscription config, or throw a clear
 * error naming which ones DO exist -- a typo must never silently fall back
 * to anything else. There is no picker
 * function alongside this one, by design: dispatch to this mode always
 * names an entry, never selects one.
 */
export function resolveSubscriptionWorker(subscriptionConfig, name) {
  const workers = subscriptionConfig?.config?.workers;
  // hasOwnProperty, not a truthy lookup -- same reasoning as
  // lib/dispatch-config.mjs's resolvePool: `workers?.["__proto__"]` on a
  // plain object returns Object.prototype itself, a real truthy value even
  // though lib/agents.mjs already refuses a file that declares one.
  const entry = workers && Object.prototype.hasOwnProperty.call(workers, name) ? workers[name] : undefined;
  if (!entry) {
    const known = Object.keys(subscriptionConfig?.config?.workers || {});
    throw new Error(
      known.length
        ? `unknown subscription agent "${name}" -- your subscription agents are: ${known.join(", ")}`
        : `unknown subscription agent "${name}" -- none are defined yet (run \`nomarmy agents add subscription\`)`,
    );
  }
  return { id: name, ...entry };
}

/**
 * OpenClaw providers that BOTH an api agent (as its one-entry pool) and a
 * subscription agent use. Some vendors (OpenAI, Meta, xAI) put their
 * subscription credential and their pay-as-you-go API key under the same
 * OpenClaw provider id -- so a pool entry for that provider could silently
 * run on the subscription credential (or a subscription agent on the
 * metered key), which is exactly the pooling subscriptions must never be. Only Claude (claude-cli vs anthropic) uses distinct ids and
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
  const apiAgents = conflict.poolEntries.map((e) => e.split("/").pop());
  return `OpenClaw provider "${conflict.provider}" is used by both api agent${apiAgents.length === 1 ? "" : "s"} ${apiAgents.join(", ")} and subscription agent${conflict.workers.length === 1 ? "" : "s"} ${conflict.workers.join(", ")} -- OpenClaw holds one credential per provider, so the api agent could run on the subscription (or the subscription on the metered key). Keep only one of them.`;
}

