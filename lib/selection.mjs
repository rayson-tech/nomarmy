import { resolvePool, pickProvider } from "./dispatch-config.mjs";
import { openclawProviderId } from "./dispatch-schema.mjs";
import { resolveSubscriptionWorker, findProviderConflicts, describeProviderConflict } from "./subscription-config.mjs";

export function createSelection({ dispatchConfig, subscriptionConfig, profileConfig }) {
  const workerProvider = process.env.NOMARMY_WORKER_PROVIDER || "llama-cpp";
  const workerModel = process.env.NOMARMY_WORKER_MODEL || "qwen3-coder-next";
  const workerModelThinkingSupported = process.env.NOMARMY_WORKER_MODEL_THINKING === "true";
  // One in-flight-count per pool entry id, incremented/decremented around the
  // single `openclaw agent exec` call that entry backs (see runOpenClaw's use
  // below). This is deliberately NOT derived from `activeJobs` -- an implement
  // job can call runOpenClaw twice in sequence (the work call, then the
  // report-reserve call), each picking its own entry independently, and this
  // only ever needs to answer "how many calls are using entry X right now",
  // not "how many jobs". Enforces each entry's own `max_concurrent` as a
  // static, operator-declared ceiling -- see config/providers.yml.example for
  // why real rate-limit-aware admission is out of scope for now.
  const poolEntryRunningCounts = new Map();
  function withPoolEntrySlot(entryId, fn) {
    if (!entryId) return fn();
    poolEntryRunningCounts.set(entryId, (poolEntryRunningCounts.get(entryId) || 0) + 1);
    return Promise.resolve().then(fn).finally(() => {
      const next = (poolEntryRunningCounts.get(entryId) || 1) - 1;
      if (next <= 0) poolEntryRunningCounts.delete(entryId);
      else poolEntryRunningCounts.set(entryId, next);
    });
  }

  // Picks one entry from a named pool in config/providers.yml and shapes it
  // exactly like profileConfig's return value ({model, thinking}), so it drops
  // into runOpenClaw's existing `--model`/`--thinking` seam with a one-line
  // branch. Never falls back to `profile` silently on a bad pool name or an
  // exhausted pool -- both throw a specific, actionable error instead (unknown
  // pool name / pool exists but nothing in it is currently authenticated or
  // under its max_concurrent), since silently substituting a different worker
  // identity than the one requested would be a much worse failure mode than a
  // clear refusal.
  // Refuses when `provider` is used by both a pool entry and a subscription
  // worker -- see findProviderConflicts for why that's never safe to guess
  // through. Only checked when both files actually exist.
  function assertNoProviderConflict(provider, dispatchLoaded, subscriptionLoaded) {
    if (!dispatchLoaded?.found || !subscriptionLoaded?.found) return;
    const conflict = findProviderConflicts(dispatchLoaded.config.pools, subscriptionLoaded.config.workers).find((c) => c.provider === provider);
    if (conflict) throw new Error(describeProviderConflict(conflict));
  }

  function resolvePoolSelection(poolName, reasoning, {
    getDispatchConfig = dispatchConfig,
    getSubscriptionConfig = subscriptionConfig,
    pickProviderFn = pickProvider,
    runningById = Object.fromEntries(poolEntryRunningCounts),
    model: modelOverride = null,
  } = {}) {
    const dispatchLoaded = getDispatchConfig();
    const pool = resolvePool(dispatchLoaded, poolName);
    // The job's model (already resolved by expandJobs: job, role, then the
    // agent's default) wins over the entry's own default.
    const picked = pickProviderFn(pool, { runningById });
    const entry = modelOverride ? { ...picked, model: modelOverride } : picked;
    if (entry.provider !== "llama-cpp" && !entry.model) throw new Error(`api agent "${poolName}" has no default model and this job named none`);
    assertNoProviderConflict(openclawProviderId(entry), dispatchLoaded, getSubscriptionConfig());
    const model = entry.provider === "llama-cpp"
      ? `${workerProvider}/${entry.model || workerModel}`
      : `${openclawProviderId(entry)}/${entry.model}`;
    // llama-cpp defers to the single global NOMARMY_MODEL_THINKING flag, same
    // as a profile-routed job. A hosted entry's own `thinking` decides: false
    // -> off; true -> pass through the job's requested `reasoning`; a specific
    // level -> always that level, this entry's own floor, regardless of what
    // the job asked for (see thinkingSchema's doc comment for why).
    const thinking = entry.provider === "llama-cpp"
      ? (workerModelThinkingSupported ? reasoning : "off")
      : entry.thinking === false ? "off"
      : entry.thinking === true ? reasoning
      : entry.thinking;
    return { model, thinking, entry };
  }

  // The subscription-worker sibling of resolvePoolSelection -- shaped
  // identically ({model, thinking, entry}) so it drops into runOpenClaw's
  // existing seam, but with no picker at all: `name` always names one exact
  // entry (resolveSubscriptionWorker throws on an unknown one, never falls
  // back), and the owner-match attestation check happens here, first, before
  // anything else -- called once from admit() at admission time and again
  // naturally when runOpenClaw builds `selected`, since this is the same pure
  // function either way. A missing or mismatched on_behalf_of is refused with
  // the concrete mismatch named plainly, never a silent substitution.
  function resolveSubscriptionSelection(name, onBehalfOf, reasoning, {
    getSubscriptionConfig = subscriptionConfig,
    getDispatchConfig = dispatchConfig,
    model: modelOverride = null,
  } = {}) {
    const subscriptionLoaded = getSubscriptionConfig();
    const found = resolveSubscriptionWorker(subscriptionLoaded, name);
    const entry = modelOverride ? { ...found, model: modelOverride } : found;
    if (!onBehalfOf) {
      throw new Error(`agent "${name}" is a subscription and requires on_behalf_of naming the specific person this job is for -- it was not supplied`);
    }
    if (onBehalfOf !== entry.owner) {
      throw new Error(`agent "${name}" belongs to "${entry.owner}"; this job's on_behalf_of ("${onBehalfOf}") does not match -- refusing rather than silently running someone else's work under ${name}'s credential`);
    }
    assertNoProviderConflict(entry.provider, getDispatchConfig(), subscriptionLoaded);
    if (!entry.model) throw new Error(`subscription agent "${name}" has no default model and this job named none`);
    const model = `${entry.provider}/${entry.model}`;
    const thinking = entry.thinking === false ? "off" : entry.thinking === true ? reasoning : entry.thinking;
    return { model, thinking, entry };
  }

  return { resolvePoolSelection, resolveSubscriptionSelection, withPoolEntrySlot, assertNoProviderConflict };
}
