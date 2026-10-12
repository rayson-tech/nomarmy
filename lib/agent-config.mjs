import fs from "node:fs";
import { loadArmy, globalConfigDir } from "./army.mjs";
import { loadAgents, agentsConfigPath, agentsAsDispatchConfig, agentsAsSubscriptionConfig, agentProviderId } from "./agents.mjs";
import { queryModelCatalog, queryModelCatalogAsync } from "./model-catalog.mjs";

// agents.yml lives in ~/.config/nomarmy (lib/army.mjs's globalConfigDir),
// outside both the dev checkout and the installed copy, and is re-read
// whenever it changes, so an edit takes effect on the next job with no
// reconnect or restart. The config/*.env values are still read once at
// module load.
export function fileKey(filePath) {
  try { const st = fs.statSync(filePath); return `${filePath}:${st.mtimeMs}:${st.size}`; }
  catch { return `${filePath}:missing`; }
}
// A load that throws is not cached, so a fixed file is picked up next call.
export function reloadingConfig(pathFn, loadFn) {
  let key = null, value;
  return () => {
    const next = fileKey(pathFn());
    if (next !== key) { value = loadFn(); key = next; }
    return value;
  };
}

const CATALOG_RETRY_MS = 10 * 60 * 1000;

export function createAgentConfig({ projectDir, queryCatalog = queryModelCatalog, queryCatalogAsync = queryModelCatalogAsync, now = Date.now }) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const agentsConfig = reloadingConfig(() => agentsConfigPath(globalConfigDir()), () => loadAgents(globalConfigDir()));
  // The execution path below predates agents.yml and speaks in pools (an api
  // agent is a one-entry pool) and subscription workers; these adapters keep
  // it unchanged.
  const dispatchConfig = () => agentsAsDispatchConfig(agentsConfig());
  const subscriptionConfig = () => agentsAsSubscriptionConfig(agentsConfig());

  // The army is small and read per call: three tiny YAML files, merged fresh,
  // so an edit to .nomarmy.yml or .nomarmy.local.yml applies to the next job.
  function currentArmy() {
    return loadArmy({ projectDir });
  }

  // OpenClaw's own model catalog (queryModelCatalog), cached once per process
  // like everything else read-once-at-connect-time here -- a subprocess call
  // per job would be needless latency for a number that doesn't change
  // mid-session. null (openclaw unreachable) is cached too, on purpose: if it
  // wasn't on PATH at server startup it won't become reachable mid-process,
  // and every hosted entry still works via its context_window override or the
  // conservative unknown-model fallback either way (see lib/dispatch-config.mjs).
  let cachedModelCatalog;
  let catalogRefresh = null;
  let catalogRefreshedAt = 0;
  function startCatalogRefresh() {
    catalogRefreshedAt = now();
    catalogRefresh = queryCatalogAsync({ refresh: true }).then((fresh) => { if (fresh?.size) cachedModelCatalog = fresh; return cachedModelCatalog; });
    return catalogRefresh;
  }
  /**
   * Start the background catalog refresh if an agent's provider is missing
   * from the cached catalog (OpenClaw's un-refreshed list only holds its
   * built-in claude-cli models; openai, xai and meta only appear after
   * --refresh). Once per process. Returns the in-flight refresh, or null.
   */
  function ensureCatalogRefresh() {
    if (catalogRefresh) return catalogRefresh;
    if (cachedModelCatalog === undefined) cachedModelCatalog = queryCatalog();
    let providers = [];
    try { providers = [...new Set(Object.values(agentsConfig().agents).map(agentProviderId).filter(Boolean))]; } catch { /* reported elsewhere */ }
    const keys = cachedModelCatalog ? [...cachedModelCatalog.keys()] : [];
    if (!providers.some((p) => !keys.some((k) => k.startsWith(`${p}/`)))) return null;
    return startCatalogRefresh();
  }
  // Synchronous callers get whatever is known right now (the refresh runs in
  // the background: run synchronously, a stalled provider froze the server).
  function modelCatalog() {
    ensureCatalogRefresh();
    return cachedModelCatalog;
  }
  /**
   * The catalog, waiting (asynchronously, never blocking the server) up to
   * `timeoutMs` for the refresh. Used where the answer matters: admission
   * sizes budgets from it, and the `army` tool lists each agent's models.
   * Not waiting is what left the General with empty model lists and first
   * jobs budgeted at the 32k fallback (a real Senti run).
   */
  async function modelCatalogReady(timeoutMs = 30000, keys = []) {
    let pending = ensureCatalogRefresh();
    if (pending) await Promise.race([pending, sleep(timeoutMs)]);
    // A provider already in the catalog can still gain a model after this
    // process read it: a plugin update brought openai/gpt-6.1-sol, and jobs
    // on it were budgeted at the 32k unknown-model fallback until a restart.
    // So a job's model missing from the catalog refreshes it again, at most
    // every CATALOG_RETRY_MS, since a model OpenClaw really doesn't list
    // would otherwise refresh on every job.
    if (keys.some((key) => !cachedModelCatalog?.has(key)) && now() - catalogRefreshedAt >= CATALOG_RETRY_MS) {
      pending = startCatalogRefresh();
      await Promise.race([pending, sleep(timeoutMs)]);
    }
    return cachedModelCatalog;
  }

  return { agentsConfig, dispatchConfig, subscriptionConfig, currentArmy, ensureCatalogRefresh, modelCatalog, modelCatalogReady };
}
