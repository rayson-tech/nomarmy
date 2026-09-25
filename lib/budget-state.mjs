import { deriveBudgets, resolveContextPerNom } from "./budget.mjs";
import { executionMode } from "./execution.mjs";

export function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

export function createBudgetState({ env = process.env } = {}) {
  let budgets = deriveBudgets({});
  let contextInfo = { contextPerNom: budgets.contextPerNom, slots: null, source: budgets.source };
  let hardwareSnapshot = null;
  function currentBudgets() { return budgets; }
  async function refresh() {
    try {
      if (executionMode(env).hasLocalModel) {
        contextInfo = await resolveContextPerNom({ env });
        budgets = deriveBudgets({ contextPerNom: contextInfo.contextPerNom, source: contextInfo.source, env });
      }
    } catch { /* keep the previous budgets; a failed probe is not a reason to refuse work */ }
    try {
      const { detectHardware } = await import("./hardware.mjs");
      hardwareSnapshot = await detectHardware();
    } catch { hardwareSnapshot = null; }
    return budgets;
  }

  // NOMARMY_MAX_WORKERS, when set, is the operator's own declared ceiling.
  // Left unset, the natural default is however many inference slots
  // llama-server actually reports right now (contextInfo.slots, refreshed
  // alongside the context budget on every admission check) -- not a value
  // frozen from the environment at server startup. assessAdmission already
  // refuses independently once running jobs reach the real slot count
  // (`slots && runningJobs >= slots`), so a lower, stale default here only
  // ever added a second, needlessly tighter ceiling on top of that real one:
  // restarting llama-server with more slots (e.g. -np 4) had no effect on
  // concurrency until the whole coordinator process was also restarted.
  function currentMaxWorkers() {
    const declared = env.NOMARMY_MAX_WORKERS;
    if (declared !== undefined) return clampInt(declared, 1, 8, 1);
    const slots = contextInfo?.slots;
    return Number.isFinite(slots) && slots > 0 ? Math.min(slots, 8) : 1;
  }

  return {
    get budgets() { return budgets; },
    get contextInfo() { return contextInfo; },
    get hardwareSnapshot() { return hardwareSnapshot; },
    refresh, currentBudgets, currentMaxWorkers,
  };
}
