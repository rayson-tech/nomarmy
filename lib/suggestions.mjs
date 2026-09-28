// Routing suggestions from the job records: which role and model pairings
// are working, which aren't, and what a change would be. Evidence first,
// with minimum sample sizes; roles do different work, so a comparison across
// roles is worded as something to try, not a verdict. Never applied: the
// operator or the General decides, and each suggestion carries the command.

import { jobRole } from "./stats.mjs";

export const MIN_JOBS = 5;
const OK = /^(WORKER_DONE|RECOVERED_SUCCESS|SCOUT_DONE|SCOUT_NOT_FOUND|DECOMPOSE_DONE|VERIFIED)$/;

const provider = (r) => r.metrics?.worker_provider ?? r.worker?.provider ?? null;
const model = (r) => r.metrics?.worker_model ?? r.worker?.model ?? null;
// The local model is the built-in "local" agent, whatever model is loaded.
const agent = (r) => r.labels?.agent ?? (provider(r) === "llama-cpp" ? "local" : null);
// New tokens only: cache reads are most of an api job's total and cost a fraction.
const freshTokens = (r) => (r.metrics?.worker_tokens_in ?? 0) + (r.metrics?.worker_tokens_out ?? 0);
/** The runner exited before a report: an OpenClaw, sandbox or provider failure, not the model's work. */
export const runnerFailed = (r) => r.outcome === "WORKER_FAILED" && [...(r.issues ?? []), ...(r.reasons ?? [])].some((x) => /^(worker|scout|decomposer) process failed/.test(x));
const pct = (n, of) => Math.round((100 * n) / of);

const REVIEW_FINISHED = /^(SCOUT_DONE|SCOUT_NOT_FOUND)$/;
// How recently a pairing must have run for a suggestion about it to still be
// about how you work now: a week-old local-model experiment led Senti's list.
export const CURRENT_DAYS = 3;

/** Whether a high-stakes job has had an independent review: a finished scout, or a judge, on another vendor. A review that timed out or failed isn't one. */
export function reviewOf(job, records) {
  const workerProvider = provider(job);
  const scout = records.find((r) => r.mode === "scout" && r.reviews === job.jobId && REVIEW_FINISHED.test(r.outcome ?? "") && provider(r) && provider(r) !== workerProvider);
  if (scout) return { by: "scout", jobId: scout.jobId, provider: provider(scout) };
  const judge = job.validators?.judge;
  if (judge?.answer && judge.provider && judge.provider !== workerProvider) return { by: "judge", provider: judge.provider };
  return null;
}

/**
 * @param {object[]} records this repo's records, already filtered to a period
 * @returns {{ level: "warn"|"info", key: string, title: string, evidence: string, command: string|null }[]}
 */
export function computeSuggestions(records, { minJobs = MIN_JOBS, agentFor = () => null, now = Date.now(), includeStale = false } = {}) {
  const out = [];
  let stale = 0;
  const work = records.filter((r) => r.mode === "implement" || r.mode === "scout");

  // Per role and model.
  const groups = new Map();
  for (const r of work) {
    const key = `${jobRole(r) ?? ""}|${model(r) ?? ""}|${r.mode}`;
    const g = groups.get(key) ?? { role: jobRole(r), model: model(r), mode: r.mode, agent: agent(r), provider: provider(r), jobs: 0, rated: 0, ok: 0, runner: 0, timeout: 0, unsupported: 0, tokens: 0, tokenJobs: 0, lastAt: 0 };
    g.jobs++;
    g.lastAt = Math.max(g.lastAt, Date.parse(r.startedAt ?? "") || 0);
    if (runnerFailed(r)) g.runner++; else g.rated++;
    if (OK.test(r.outcome ?? "")) g.ok++;
    if (r.outcome === "WORKER_TIMEOUT") g.timeout++;
    if (r.outcome === "SCOUT_UNSUPPORTED") g.unsupported++;
    if (freshTokens(r) > 0) { g.tokens += freshTokens(r); g.tokenJobs++; }
    g.agent = g.agent ?? agent(r) ?? agentFor(provider(r));
    groups.set(key, g);
  }
  const assign = (g, to = "<another model>") => (g.role ? `nomarmy army assign ${g.role} ${g.agent ?? "<agent>"} ${to}` : null);

  const current = (g) => includeStale || g.lastAt >= now - CURRENT_DAYS * 86400000;
  for (const g of groups.values()) {
    if (!g.model) continue;
    // A stale pairing's suggestions are worked out, then only counted.
    const before = out.length;
    groupSuggestions(g);
    if (!current(g)) stale += out.splice(before).length;
  }
  function groupSuggestions(g) {
    const kind = g.mode === "scout" ? "scouts" : "implement jobs";
    const who = g.role ? `${g.role} on ${g.model}` : `${kind} with no role on ${g.model}`;
    // The runner failing isn't the model doing poor work: say so apart, and leave those out of its rate.
    if (g.runner >= 3 && g.runner / g.jobs >= 0.4) {
      out.push({ level: "warn", key: `runner-failed:${g.role}:${g.model}:${g.mode}`, title: `${who}: the runner failed on ${g.runner} of ${g.jobs} ${kind} before any report`,
        evidence: "OpenClaw, the sandbox or the provider exited early, so these say nothing about the model's work. Check `nomarmy health` and one job's log (`nomarmy jobs <id>`); a model its vendor refuses fails this way too.", command: null });
    }
    // Scouts that come back empty.
    if (g.mode === "scout" && g.rated >= 3 && g.unsupported / g.rated >= 0.4) {
      out.push({ level: "warn", key: `scout-unsupported:${g.role}:${g.model}`, title: `${who}: ${g.unsupported} of ${g.rated} scouts came back unsupported`,
        evidence: "Their findings couldn't be tied to cited lines. A different agent, or report: full, usually fixes it.", command: assign(g) });
      return;
    }
    if (g.rated < minJobs) return;
    const runnerNote = g.runner ? ` (plus ${g.runner} the runner failed on, not counted)` : "";
    // A pairing that rarely finishes.
    if (g.ok / g.rated < 0.5) {
      const better = [...groups.values()].filter((o) => o !== g && o.mode === g.mode && o.rated >= minJobs && o.model && o.ok / o.rated >= g.ok / g.rated + 0.2)
        .sort((a, b) => b.ok / b.rated - a.ok / a.rated)[0];
      out.push({ level: "warn", key: `low-success:${g.role}:${g.model}:${g.mode}`, title: `${who} finished ${g.ok} of ${g.rated} ${g.role ? kind : ""}`.trim() + ` (${pct(g.ok, g.rated)}%)${runnerNote}`,
        evidence: (better ? `${better.model} finished ${pct(better.ok, better.rated)}% of its ${better.rated} ${kind} here${better.role ? ` (as ${better.role})` : ""}.` : "No other model has enough jobs here to compare.") + (g.role ? "" : " These ran with no army role: send this kind of work to a role on a stronger agent instead."),
        command: g.role ? assign(g, better?.model ?? "<another model>") : null });
    }
    // Timeouts.
    if (g.timeout >= 3 && g.timeout / g.rated >= 0.25) {
      out.push({ level: "info", key: `timeouts:${g.role}:${g.model}`, title: `${who} timed out on ${g.timeout} of ${g.rated} jobs`,
        evidence: "Smaller briefs (one outcome each), a longer timeout_seconds, or a faster model would help.", command: null });
    }
  }

  // A lighter model doing as well on the same role's implement work, for much less. Only
  // within one role: different roles do different work, so across roles the numbers don't compare.
  const impl = [...groups.values()].filter((g) => g.mode === "implement" && g.role && g.model && g.rated >= minJobs && g.tokenJobs >= minJobs && current(g));
  for (const heavy of impl) {
    for (const light of impl) {
      if (light === heavy || light.role !== heavy.role || light.model === heavy.model) continue;
      const lightRate = light.ok / light.rated, heavyRate = heavy.ok / heavy.rated;
      const lightPerJob = light.tokens / light.tokenJobs, heavyPerJob = heavy.tokens / heavy.tokenJobs;
      if (lightRate >= heavyRate - 0.05 && lightPerJob <= 0.5 * heavyPerJob) {
        out.push({ level: "info", key: `lighter:${heavy.role}:${heavy.model}:${light.model}`,
          title: `${heavy.role}: ${light.model} finished ${pct(light.ok, light.rated)}% of its jobs on ${Math.round(lightPerJob / 1000)}k new tokens a job; ${heavy.model} finished ${pct(heavy.ok, heavy.rated)}% on ${Math.round(heavyPerJob / 1000)}k`,
          evidence: `Same role, so similar work. Moving ${heavy.role} to ${light.model} would cost less; keep ${heavy.model} for the harder pieces with model on the job.${light.agent === "local" ? ` The local agent runs whichever model is loaded; these ran on ${light.model}.` : ""}`,
          command: light.agent ? `nomarmy army assign ${heavy.role} ${light.agent}${light.agent === "local" ? "" : ` ${light.model}`}` : null });
      }
    }
  }

  // Where the money goes.
  const spend = new Map();
  for (const r of work) if (Number.isFinite(r.metrics?.worker_cost_usd) && r.metrics.worker_cost_usd > 0) spend.set(model(r), (spend.get(model(r)) ?? 0) + r.metrics.worker_cost_usd);
  const total = [...spend.values()].reduce((a, b) => a + b, 0);
  const [top, topUsd] = [...spend.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (top && topUsd >= 5 && topUsd / total >= 0.5) {
    out.push({ level: "info", key: `spend:${top}`, title: `${top} is ${pct(topUsd, total)}% of API spend ($${topUsd.toFixed(2)} of $${total.toFixed(2)})`,
      evidence: "Worth knowing rather than changing if it's catching real problems; check its reviews' findings before moving it.", command: null });
  }

  // Committed high-stakes work without an independent review. Only work that
  // landed: a partial never committed isn't accepted work, and one finished by
  // a later job is that job's to review.
  const unreviewed = records.filter((r) => r.mode === "implement" && r.stakes === "high" && r.commit?.created && !reviewOf(r, records));
  if (unreviewed.length) {
    const ids = unreviewed.map((r) => r.jobId).sort();
    out.unshift({ level: "act", key: `unreviewed:${ids.join(",")}`, title: `${ids.length} high-stakes job(s) committed without an independent review: ${ids.join(", ")}`,
      evidence: "Review each before merging: a scout on another vendor (army_role security-analyst, say) with reviews: <job id>. A review that failed or timed out doesn't count.", command: null });
  }
  const rank = { act: 0, warn: 1, info: 2 };
  out.sort((a, b) => rank[a.level] - rank[b.level]);
  if (stale) out.push({ level: "info", key: "stale", title: `${stale} more about role and model pairings you haven't used in ${CURRENT_DAYS} days, hidden (nomarmy stats --all-suggestions)`, evidence: null, command: null });
  return out;
}

/** This repository's suggestions from its last 14 days of jobs. */
export function recentSuggestions(records, { projectDir, agentFor = () => null, now = Date.now(), days = 14 } = {}) {
  const since = now - days * 86400000;
  return computeSuggestions(records.filter((r) => r.projectDir === projectDir && Date.parse(r.startedAt ?? "") >= since), { agentFor, now });
}

export function formatSuggestions(list) {
  if (!list.length) return ["  none: nothing in the records suggests a routing change"];
  return list.flatMap((s) => [`  ${{ act: "!!", warn: "!", info: "-" }[s.level] ?? "-"} ${s.title}`, ...(s.evidence ? [`    ${s.evidence}`] : []), ...(s.command ? [`    ${s.command}`] : [])]);
}
