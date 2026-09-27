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
const agent = (r) => r.labels?.agent ?? null;
const pct = (n, of) => Math.round((100 * n) / of);

/** Whether a high-stakes job has had an independent review: a scout, or a judge, on another vendor. */
export function reviewOf(job, records) {
  const workerProvider = provider(job);
  const scout = records.find((r) => r.mode === "scout" && r.reviews === job.jobId && provider(r) && provider(r) !== workerProvider);
  if (scout) return { by: "scout", jobId: scout.jobId, provider: provider(scout) };
  const judge = job.validators?.judge;
  if (judge?.answer && judge.provider && judge.provider !== workerProvider) return { by: "judge", provider: judge.provider };
  return null;
}

/**
 * @param {object[]} records this repo's records, already filtered to a period
 * @returns {{ level: "warn"|"info", key: string, title: string, evidence: string, command: string|null }[]}
 */
export function computeSuggestions(records, { minJobs = MIN_JOBS, agentFor = () => null } = {}) {
  const out = [];
  const work = records.filter((r) => r.mode === "implement" || r.mode === "scout");

  // Per role and model.
  const groups = new Map();
  for (const r of work) {
    const key = `${jobRole(r) ?? ""}|${model(r) ?? ""}|${r.mode}`;
    const g = groups.get(key) ?? { role: jobRole(r), model: model(r), mode: r.mode, agent: agent(r), provider: provider(r), jobs: 0, ok: 0, timeout: 0, unsupported: 0, tokens: 0 };
    g.jobs++; if (OK.test(r.outcome ?? "")) g.ok++;
    if (r.outcome === "WORKER_TIMEOUT") g.timeout++;
    if (r.outcome === "SCOUT_UNSUPPORTED") g.unsupported++;
    g.tokens += r.metrics?.worker_tokens_total ?? 0;
    g.agent = g.agent ?? agent(r) ?? agentFor(provider(r));
    groups.set(key, g);
  }
  const assign = (g, to = "<another model>") => (g.role ? `nomarmy army assign ${g.role} ${g.agent ?? "<agent>"} ${to}` : null);

  for (const g of groups.values()) {
    if (!g.model) continue;
    const kind = g.mode === "scout" ? "scouts" : "implement jobs";
    const who = g.role ? `${g.role} on ${g.model}` : `${kind} with no role on ${g.model}`;
    // Scouts that come back empty.
    if (g.mode === "scout" && g.jobs >= 3 && g.unsupported / g.jobs >= 0.4) {
      out.push({ level: "warn", key: `scout-unsupported:${g.role}:${g.model}`, title: `${who}: ${g.unsupported} of ${g.jobs} scouts came back unsupported`,
        evidence: "Their findings couldn't be tied to cited lines. A different agent, or report: full, usually fixes it.", command: assign(g) });
      continue;
    }
    if (g.jobs < minJobs) continue;
    // A pairing that rarely finishes.
    if (g.ok / g.jobs < 0.5) {
      const better = [...groups.values()].filter((o) => o !== g && o.mode === g.mode && o.jobs >= minJobs && o.model && o.ok / o.jobs >= g.ok / g.jobs + 0.2)
        .sort((a, b) => b.ok / b.jobs - a.ok / a.jobs)[0];
      out.push({ level: "warn", key: `low-success:${g.role}:${g.model}:${g.mode}`, title: `${who} finished ${g.ok} of ${g.jobs} ${g.role ? kind : ""}`.trim() + ` (${pct(g.ok, g.jobs)}%)`,
        evidence: (better ? `${better.model} finished ${pct(better.ok, better.jobs)}% of its ${better.jobs} ${kind} here${better.role ? ` (as ${better.role})` : ""}.` : "No other model has enough jobs here to compare.") + (g.role ? "" : " These ran with no army role: send this kind of work to a role on a stronger agent instead."),
        command: g.role ? assign(g, better?.model ?? "<another model>") : null });
    }
    // Timeouts.
    if (g.timeout >= 3 && g.timeout / g.jobs >= 0.25) {
      out.push({ level: "info", key: `timeouts:${g.role}:${g.model}`, title: `${who} timed out on ${g.timeout} of ${g.jobs} jobs`,
        evidence: "Smaller briefs (one outcome each), a longer timeout_seconds, or a faster model would help.", command: null });
    }
  }

  // A lighter model doing as well on implement work, for much less.
  const impl = [...groups.values()].filter((g) => g.mode === "implement" && g.model && g.jobs >= minJobs && g.tokens > 0);
  for (const heavy of impl) {
    for (const light of impl) {
      if (light === heavy || light.model === heavy.model) continue;
      const lightRate = light.ok / light.jobs, heavyRate = heavy.ok / heavy.jobs;
      if (lightRate >= heavyRate - 0.05 && light.tokens / light.jobs <= 0.5 * (heavy.tokens / heavy.jobs)) {
        out.push({ level: "info", key: `lighter:${heavy.role}:${heavy.model}:${light.model}`,
          title: `${light.model} finished ${pct(light.ok, light.jobs)}% of its jobs${light.role ? ` (as ${light.role})` : ""} on ${Math.round((light.tokens / light.jobs) / 1000)}k tokens a job; ${heavy.model}${heavy.role ? ` (as ${heavy.role})` : ""} finished ${pct(heavy.ok, heavy.jobs)}% on ${Math.round((heavy.tokens / heavy.jobs) / 1000)}k`,
          evidence: "They did different work, so try it rather than switch outright: put the role on auto so the General picks per job, or send its routine pieces to the lighter model.",
          command: heavy.role ? `nomarmy army assign ${heavy.role} ${heavy.agent ?? "<agent>"} auto` : null });
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

  // High-stakes work without an independent review.
  const unreviewed = records.filter((r) => r.mode === "implement" && r.stakes === "high" && !reviewOf(r, records));
  if (unreviewed.length) {
    out.push({ level: "warn", key: `unreviewed:${unreviewed.map((r) => r.jobId).sort().join(",")}`, title: `${unreviewed.length} high-stakes job(s) without an independent review: ${unreviewed.slice(0, 5).map((r) => r.jobId).join(", ")}`,
      evidence: "Send a scout on another vendor with reviews: <job id> before accepting them (or configure a judge on another vendor).", command: null });
  }
  return out;
}

/** This repository's suggestions from its last 14 days of jobs. */
export function recentSuggestions(records, { projectDir, agentFor = () => null, now = Date.now(), days = 14 } = {}) {
  const since = now - days * 86400000;
  return computeSuggestions(records.filter((r) => r.projectDir === projectDir && Date.parse(r.startedAt ?? "") >= since), { agentFor });
}

export function formatSuggestions(list) {
  if (!list.length) return ["  none: nothing in the records suggests a routing change"];
  return list.flatMap((s) => [`  ${s.level === "warn" ? "!" : "-"} ${s.title}`, `    ${s.evidence}`, ...(s.command ? [`    ${s.command}`] : [])]);
}
