import { deriveBudgets } from "./budget.mjs";
import { poolContextPerNom, entryContextPerNom } from "./dispatch-config.mjs";
import { resolveSubscriptionWorker } from "./subscription-config.mjs";
import { readOpenClawTranscript } from "./transcript.mjs";
import { readClaudeSessionTranscript } from "./claude-transcript.mjs";

/**
 * A transcript can only measure reads when the agent's tools ran through
 * OpenClaw. A CLI-backed agent (claude-cli runs Claude Code's own tools
 * inside Claude Code) leaves OpenClaw's transcript with no tool events even
 * though its result reports the calls -- a real Senti scout reported 51
 * Bash calls while the transcript held none, and was flagged "read ~0
 * tokens, negative displacement". That's "can't measure", not "read
 * nothing", so the transcript is marked unavailable and no displacement
 * verdict is drawn.
 */
export function readsMeasurable(transcript, worker) {
  const reported = worker?.toolSummary?.calls ?? 0;
  if (transcript?.available && transcript.toolCalls.length === 0 && reported > 0) {
    return { ...transcript, available: false, reason: `the agent ran ${reported} tool call(s) outside OpenClaw's transcript (its own CLI's tools), so reads can't be measured` };
  }
  return transcript;
}

/**
 * What the worker read: OpenClaw's transcript, or -- for a claude-cli
 * worker, whose tools OpenClaw never sees -- Claude Code's own session
 * transcript for the job's working directory (lib/claude-transcript.mjs).
 * Falls back to readsMeasurable's honest "can't measure" when neither has it.
 */
export async function measureReads(stateDir, worker, { cwd, sinceMs = 0 } = {}) {
  const openclaw = readsMeasurable(await readOpenClawTranscript(stateDir), worker);
  if (openclaw.available || worker?.provider !== "claude-cli" || !cwd) return openclaw;
  const claude = readClaudeSessionTranscript(cwd, { sinceMs });
  return claude.available ? claude : openclaw;
}

export function createJobBudgets({ budgetState, dispatchConfig, subscriptionConfig, modelCatalog }) {
  /**
   * The budgets a pool-routed job should be checked/prompted against, instead
   * of the single local-derived global `budgets` every job used before this
   * existed -- a hosted model's real context window is usually nothing like a
   * local llama-server's, and budgeting a Grok/Anthropic/OpenAI job against
   * the local machine's ~64K was an accidental, needless cap, not a deliberate
   * one. Falls back to the outer `budgets`/`contextInfo` when the pool can't
   * be resolved (unknown pool, no available entries, or an all-llama-cpp pool
   * with no local context known yet) -- pickProvider itself raises the real,
   * specific dispatch-time error in those cases; this is not the place to
   * duplicate it, only to avoid ever computing budgets from `null`.
   */
  function budgetsForPool(poolName, model = null, reportSize = null) {
    const loaded = dispatchConfig();
    if (!loaded?.found) return budgetState.budgets;
    const configured = Object.prototype.hasOwnProperty.call(loaded.config.pools, poolName) ? loaded.config.pools[poolName] : null;
    if (!configured) return budgetState.budgets;
    const pool = model ? configured.map((entry) => ({ ...entry, model })) : configured;
    const resolved = poolContextPerNom(pool, process.env, { catalog: modelCatalog(), localContextPerNom: budgetState.contextInfo.contextPerNom });
    if (!resolved) return budgetState.budgets;
    const tier = pool.some((entry) => entry.provider === "llama-cpp") ? "local" : "frontier";
    return deriveBudgets({ contextPerNom: resolved.contextPerNom, source: resolved.source, env: process.env, tier, reportSize: reportSize ?? "standard" });
  }

  /** The budget an (already expanded) job is admitted and briefed against: its own agent's, or the local one. */
  function budgetsForJob(j) {
    if (j.pool) return budgetsForPool(j.pool, j.model, j.report);
    if (j.subscription_worker) return budgetsForSubscriptionWorker(j.subscription_worker, j.model, j.report);
    return budgetState.budgets;
  }

  /**
   * What a job record says about its budget: the one its prompt was really
   * built with (runOpenClaw's budgetsUsed), or the server-wide local one when
   * the worker never produced a result. `briefChars` sits next to the brief
   * ceiling so records show how close real briefs come to it.
   */
  function recordedBudgets(result, section, task) {
    const used = result?.budgetsUsed ?? budgetState.budgets;
    return {
      contextPerNom: used.contextPerNom, source: used.source, tier: used.tier ?? "local", reportSize: used.reportSize ?? "standard",
      brief: used.brief, briefChars: String(task ?? "").length,
      ...(section === "implement" ? {} : { [section]: used[section] }),
      report: used.report[section],
    };
  }

  // The subscription-worker sibling of budgetsForPool -- simpler, since a
  // named worker is a single known entry, not a pool of many to take the
  // minimum across. Falls back to the outer `budgets` the same way
  // budgetsForPool does on anything unresolved (missing config, unknown name,
  // no context known yet); resolveSubscriptionSelection is where the real,
  // specific "unknown subscription_worker" error belongs, not here.
  function budgetsForSubscriptionWorker(name, model = null, reportSize = null) {
    const loaded = subscriptionConfig();
    if (!loaded?.found) return budgetState.budgets;
    let entry;
    try { entry = resolveSubscriptionWorker(loaded, name); } catch { return budgetState.budgets; }
    if (model) entry = { ...entry, model };
    const resolved = entryContextPerNom(entry, { catalog: modelCatalog(), localContextPerNom: budgetState.contextInfo.contextPerNom });
    if (!resolved) return budgetState.budgets;
    return deriveBudgets({ contextPerNom: resolved.contextPerNom, source: resolved.source, env: process.env, tier: "frontier", reportSize: reportSize ?? "standard" });
  }

  return { budgetsForPool, budgetsForJob, recordedBudgets, budgetsForSubscriptionWorker };
}
