import fs from "node:fs";
import path from "node:path";
import { executionMode } from "./execution.mjs";
import { loadConfig } from "./config.mjs";
import { clampInt } from "./budget-state.mjs";
import { checkBrief, assessAdmission, describeBudgets } from "./budget.mjs";
import { parseStatusPorcelainZ, isRuntimeJunk } from "./git-record.mjs";
import { readJson } from "./openclaw-run.mjs";
import { readOpenClawTranscriptTail } from "./transcript.mjs";
import { readClaudeSessionTranscript } from "./claude-transcript.mjs";
import { notify } from "./notify.mjs";
import { readCodexRateLimits, recordUsageSnapshot, readUsageSnapshots, usageStatus } from "./usage-limits.mjs";
import { projectDirProblem } from "./server-context.mjs";
import { recentModelRefusal, refusedModelIn, recordModelRefusal, clearModelRefusal } from "./health.mjs";
import { writeLease, removeLease, liveLeases, liveSlots, acquireSlot } from "./slots.mjs";
import { loadRun, runTotals, runAdmissionProblems, recordRunJob, detectUsageLimit } from "./runs.mjs";
import { agentProviderId, hostToolsImplementProblem } from "./agents.mjs";
import { policyAdmissionProblems } from "./outcome.mjs";

// `lane` is "local" (the local model on llama-server) or "remote" (an api
// or subscription agent: the inference runs at the vendor). The local-slot
// admission check must only ever count the local lane. A subscription job
// used to land in "local" (the lane was decided by `pool` alone), so a
// Claude or Codex job took llama-server's only slot and blocked local work
// it never competed with -- reported from a real Senti run.
export function jobLane(job) {
  return job.mode === "verify" || job.pool || job.subscription_worker ? "remote" : "local";
}

// A static, operator-declared ceiling on how many remote jobs (api and
// subscription agents) may run at once, independent of and additive to
// currentMaxWorkers()'s local ceiling. Each still runs a sandbox and a
// worktree on this machine, which is what this bounds; each agent's own
// max_concurrent bounds its vendor. The env name predates agents.yml
// (remote jobs were all "pool" jobs then) -- exactly the "more real concurrency, not just diversity"
// benefit of spreading load across providers with their own separate rate
// limits. Not rate-limit-aware (see config/providers.yml.example); read
// fresh each call, matching currentMaxWorkers()'s own env-read pattern.
export function currentMaxPoolWorkers() {
  return clampInt(process.env.NOMARMY_MAX_POOL_WORKERS, 1, 32, 4);
}

// Pure partition of a batch's ORIGINAL indices by lane -- pulled out of
// local_workers' handler so this specific invariant (every job lands in
// exactly one lane, indices preserved) is directly testable without also
// exercising the full async dispatch/mapLimit machinery around it. This is
// the exact split that used to not exist at all: every job in a batch
// shared one `parallel` slot count derived only from the local ceiling,
// which let an all-pool batch ignore NOMARMY_MAX_POOL_WORKERS entirely.
export function splitJobsByLane(jobs) {
  const localIndices = [], remoteIndices = [];
  jobs.forEach((j, i) => (jobLane(j) === "remote" ? remoteIndices : localIndices).push(i));
  return { localIndices, remoteIndices };
}

export function toolText(text, isError = false) { return { content: [{ type: "text", text }], isError }; }

// The capacity snapshot only when a problem is about capacity: a
// model_not_found or bad-field refusal came with ~60 lines of local-model
// capacity JSON that had nothing to do with it (a Senti review).
export function refusalText(problems, snapshot) {
  const aboutCapacity = problems.some((p) => /capacity|memory|context|slot|MAX_(POOL_)?WORKERS|max_concurrent/i.test(p));
  return `REFUSED - nothing was started.\n${problems.map(p => `- ${p}`).join("\n")}${aboutCapacity ? `\n\nCapacity right now:\n${JSON.stringify(snapshot(), null, 2)}` : ""}`;
}

export function createJobRuntime(deps) {
  const { projectDir, stateRoot, jobsRoot, runsRoot, leasesRoot, slotsRoot, run, currentMaxWorkers, slug, agentsConfig, modelCatalogReady, budgetsForJob, resolveSubscriptionSelection, executeJob, subscriptionJobFieldProblems, repoPolicy, jobArgs } = deps;

  // Staggers concurrent job starts by `slot * staggerMs` before each runner
  // begins pulling work. Verified root cause: two OpenClaw sandbox containers
  // created in the same instant reliably hit a podman/crun race ("crun: mount
  // `devpts` to `dev/pts`: Invalid argument"), even with ample host and VM
  // memory free -- reproduced twice, unrelated to memory pressure. A short
  // stagger between concurrent `podman create`/`run` invocations gives crun's
  // container-creation critical section enough separation to not collide.
  //
  // That original fix/measurement was only verified at 2-way concurrency.
  // Re-verified at 4-way (this session): the same race still fired with the
  // stagger active -- one job failed on this exact error within 5.2s of a
  // 4-job concurrent dispatch. 1500ms of separation between ADJACENT slot
  // starts is not consistently enough once 4 containers are all competing for
  // the same crun critical section under real system load, not 2. Raised to
  // 3000ms as a direct response to that reproduction; RETRY_TRANSIENT_SANDBOX_ERRORS
  // below is the second, more robust layer -- no fixed stagger value can be
  // proven sufficient for every load condition, only likely-sufficient.
  const WORKER_START_STAGGER_MS = Number.parseInt(process.env.NOMARMY_WORKER_START_STAGGER_MS ?? "", 10) || 3000;

  // ---------------------------------------------------------------------------
  // Job registry and admission. Every job, blocking or backgrounded, is tracked
  // here so capacity counts all of them. Admission re-reads the budget (a
  // restarted llama-server or changed profile is picked up) and refuses under
  // memory pressure rather than shrinking the brief and hoping.
  // ---------------------------------------------------------------------------
  const activeJobs = new Map();
  // Counted across every session on this machine, not just this server's own
  // jobs: each coordinator session runs its own server, and per-process
  // counts let six sessions each run their "one" local job at once. Idle
  // sessions hold no leases and count for nothing.
  function runningCount(lane = null) {
    return liveLeases(leasesRoot, lane ? { lane } : {}).length;
  }

  /** An api or subscription agent's max_concurrent (1 for a subscription, 2 for api by default); null for local. */
  function agentMaxConcurrent(agentName) {
    try {
      const agent = agentsConfig().agents[agentName];
      return agent && agent.kind !== "local" ? agent.max_concurrent ?? (agent.kind === "subscription" ? 1 : 2) : null;
    } catch { return null; }
  }

  /**
   * Run a job holding one of its agent's max_concurrent slots, machine-wide
   * (lib/slots.mjs), so `max_concurrent: 1` on a subscription means one job
   * on it across every session -- per-session counting never enforced that,
   * and for subscriptions the count was never checked at all. `waitMs` lets a
   * batch queue for a slot instead of failing.
   */
  function withAgentSlot(args, jobId, fn, { waitMs = 0 } = {}) {
    const max = args.mode !== "verify" && args.agentName ? agentMaxConcurrent(args.agentName) : null;
    if (!max) return fn();
    return (async () => {
      const slot = await acquireSlot(slotsRoot, args.agentName, max, { jobId, waitMs });
      if (!slot) throw new Error(`agent "${args.agentName}" is at its max_concurrent (${max}) across every nomArmy session on this machine; try again when one of its jobs finishes`);
      try { return await fn(); } finally { slot.release(); }
    })();
  }
  function track(jobId, meta, promise) {
    const entry = { ...meta, jobId, startedAt: new Date().toISOString(), settled: false, result: null, error: null, promise: null };
    // A machine-wide lease for as long as the job runs, so every session's
    // admission counts it (runningCount); released however the job ends.
    // `repo` lets each session's status line show its own repo's jobs.
    if (meta.lane) writeLease(leasesRoot, jobId, { lane: meta.lane, agent: meta.agent ?? null, runId: meta.runId ?? null, role: meta.role ?? null, model: meta.model ?? null, repo: projectDir });
    const release = () => removeLease(leasesRoot, jobId);
    entry.promise = promise.then(
      r => { entry.settled = true; entry.result = r; release(); notifyJobFinished(entry, r, null); return r; },
      e => { entry.settled = true; entry.error = e; release(); notifyJobFinished(entry, null, e); throw e; });
    entry.promise.catch(() => {});
    activeJobs.set(jobId, entry);
    return entry;
  }
  /**
   * A desktop notification when a job ends (lib/notify.mjs), so the person
   * watching hears about it from any coordinator without polling.
   */
  function notifyJobFinished(entry, result, error) {
    try {
      const provider = entry.agent ? agentProviderId(agentsConfig().agents[entry.agent]) : null;
      const snapshot = provider ? readCodexRateLimits(path.join(jobsRoot, entry.jobId)) : null;
      if (snapshot) recordUsageSnapshot(stateRoot, provider, snapshot);
    } catch { /* Usage telemetry must never affect the job result. */ }
    if (!entry.lane) return; // only tracked jobs, never internal helpers
    const m = result?.manifest ?? {};
    // Remember a model its vendor refused, until something on it works.
    try {
      const refused = refusedModelIn(m);
      if (refused) recordModelRefusal(stateRoot, refused, String(m.workerError ?? m.worker?.error ?? "").split("\n")[0].slice(0, 300) || null);
      else if (m.worker?.provider && m.worker?.model && !m.workerError && !error) clearModelRefusal(stateRoot, `${m.worker.provider}/${m.worker.model}`);
    } catch { /* best-effort, like the usage reading */ }
    const outcome = error ? "failed" : String(m.outcome ?? (result?.ok ? "done" : "finished")).toLowerCase().replace(/_/g, " ");
    const who = entry.mode === "verify" ? "verification runner" : entry.agent ? `${entry.agent}${entry.model ? `/${entry.model}` : ""}` : "local model";
    const took = Math.round((Date.now() - Date.parse(entry.startedAt)) / 60000);
    const ok = !error && (result?.ok || m.coordinatorStatus === "complete");
    notify(`nomArmy: ${entry.role ?? entry.mode ?? "job"} ${ok ? "done" : outcome}`, `${entry.workerId ?? entry.jobId} on ${who}: ${outcome} after ${took}m. ${ok ? "Ready for the General's review." : "Needs a look."}`);
  }
  function admissionHardware() {
    return executionMode(deps.env).managesModelServer ? deps.budgetState.hardwareSnapshot : null;
  }
  function capacitySnapshot() {
    const admission = assessAdmission({ hardware: admissionHardware(), runningJobs: runningCount("local"), slots: deps.budgetState.contextInfo.slots, maxWorkers: currentMaxWorkers() });
    return {
      // The local model's budget. An api or subscription job's scales with
      // its own model; local_worker_start reports that job's.
      budgets: { ...deps.budgetState.budgets, describe: describeBudgets(deps.budgetState.budgets) },
      context: deps.budgetState.contextInfo,
      admission,
      memory: deps.budgetState.hardwareSnapshot?.memory ?? null,
      running: [...activeJobs.values()].filter(j => !j.settled).map(j => ({ jobId: j.jobId, workerId: j.workerId, mode: j.mode, lane: j.lane, startedAt: j.startedAt, phase: readJson(path.join(jobsRoot, j.jobId, "status.json"))?.phase ?? "starting" })),
      usageLimits: Object.fromEntries(Object.entries(readUsageSnapshots(stateRoot)).map(([provider, snapshot]) => [provider, usageStatus(snapshot)])),
      maxWorkers: currentMaxWorkers(),
      remote: { running: runningCount("remote"), maxWorkers: currentMaxPoolWorkers(), note: "api and subscription agents; each agent's own max_concurrent also applies" }
    };
  }
  async function admit(jobs) {
    if (jobs.some(j => j.mode !== "verify")) await deps.budgetState.refresh();
    if (jobs.some((j) => j.mode !== "verify" && jobLane(j) === "remote")) await modelCatalogReady();
    const problems = [];
    const notARepo = (deps.projectDirProblem ?? projectDirProblem)(projectDir);
    if (notARepo) problems.push(notARepo);
    // Every job needs its sandbox; the server wires the Podman check (tests don't).
    const noSandbox = deps.sandboxProblem ? deps.sandboxProblem() : null;
    if (noSandbox) problems.push(noSandbox);
    const snapshots = readUsageSnapshots(stateRoot);
    jobs.forEach((j, i) => {
      if (j.mode === "verify" || !j.agentName || j.confirm_over_limit === true) return;
      let provider;
      try { provider = agentProviderId(agentsConfig().agents[j.agentName]); } catch { return; }
      const snapshot = snapshots[provider];
      if (!snapshot) return;
      const status = usageStatus(snapshot);
      if (status.level === "over") problems.push(`${jobs.length > 1 ? `job ${i + 1}: ` : ""}agent "${j.agentName}" is held at its usage limit: ${status.text} (reading ${status.ageMinutes} minutes old). Ask the operator before resubmitting with confirm_over_limit: true, or send the job to another agent.`);
    });
    // A pool-routed job is checked against that pool's OWN (model-dependent)
    // budget, not the local-derived global one -- see budgetsForPool. Which
    // specific entry pickProvider will land on isn't known yet at admission
    // time, so this is the conservative minimum across the pool's currently
    // available entries, not any one entry's precise number. A
    // subscription_worker job budgets against that one named entry directly
    // (see budgetsForSubscriptionWorker) -- there's no "which entry" unknown
    // the way a weighted pool has, since the name given IS the entry.
    jobs.forEach((j, i) => {
      if (j.mode === "verify") {
        try {
          const profiles = Object.keys(loadConfig(projectDir)?.config?.verification ?? {});
          if (!j.verification || !profiles.includes(j.verification)) problems.push(`${jobs.length > 1 ? `job ${i + 1}: ` : ""}verify requires a verification profile from .nomarmy.yml; available profiles: ${profiles.join(", ") || "(none)"}`);
        } catch (error) { problems.push(error.message); }
        return;
      }
      const jobBudgets = budgetsForJob(j);
      for (const p of checkBrief(j, jobBudgets)) problems.push(jobs.length > 1 ? `job ${i + 1}: ${p}` : p);
    });
    // verify_regression re-runs `verification`; with no profile set there is
    // nothing to re-run. Refuse before starting anything, matching every other
    // admission check here, rather than silently no-op at runtime.
    jobs.forEach((j, i) => {
      if (j.verify_regression && !j.verification) {
        problems.push(`${jobs.length > 1 ? `job ${i + 1}: ` : ""}verify_regression requires a verification profile; there is nothing to run twice without one`);
      }
    });
    // subscription_worker/on_behalf_of: the owner-match attestation refusal
    // happens here, before a container is ever provisioned -- matching how a
    // bad `pool` name is already caught before dispatch, not mid-flight. Only
    // attempted once the plain field-presence problems above are already
    // clean, so a missing on_behalf_of is never reported twice in two
    // different shapes.
    jobs.forEach((j, i) => {
      if (j.mode === "verify") return;
      const fieldProblems = subscriptionJobFieldProblems(j);
      for (const p of fieldProblems) problems.push(jobs.length > 1 ? `job ${i + 1}: ${p}` : p);
      if (fieldProblems.length === 0 && j.on_behalf_of) {
        try {
          if (j.subscription_worker) resolveSubscriptionSelection(j.subscription_worker, j.on_behalf_of, j.reasoning, { model: j.model });
        } catch (error) { problems.push(jobs.length > 1 ? `job ${i + 1}: ${error.message}` : error.message); }
      }
    });
    // The repo's own policy: verification required, revert check required.
    const policy = repoPolicy();
    jobs.forEach((j, i) => { for (const p of policyAdmissionProblems(j, policy)) problems.push(`${jobs.length > 1 ? `job ${i + 1}: ` : ""}${p}`); });
    // An implement job on an agent whose own tools run on this machine (the
    // Claude CLI) isn't bounded by the sandbox, so it's refused unless that
    // agent says allow_host_tools (lib/agents.mjs). Scouts and reviews still run.
    jobs.forEach((j, i) => {
      if (j.mode === "verify" || !j.agentName || (j.mode ?? "implement") !== "implement") return;
      let problem = null;
      try { problem = hostToolsImplementProblem(j.agentName, agentsConfig().agents[j.agentName]); } catch { return; }
      if (problem) problems.push(`${jobs.length > 1 ? `job ${i + 1}: ` : ""}${problem}`);
    });
    // A model its vendor refused on a job today, with nothing working on it
    // since, isn't sent another job (lib/health.mjs recentModelRefusal).
    jobs.forEach((j, i) => {
      if (j.mode === "verify" || !j.agentName || !j.model) return;
      let provider = null;
      try { provider = agentProviderId(agentsConfig().agents[j.agentName]); } catch { return; }
      if (!provider) return;
      const refusal = recentModelRefusal(stateRoot, `${provider}/${j.model}`);
      if (refusal) problems.push(`${jobs.length > 1 ? `job ${i + 1}: ` : ""}model_not_found: ${provider}/${j.model} was refused on an earlier job today and hasn't worked since, so this job wasn't sent. Use another model (the job's \`model\`, or \`nomarmy army assign\`); \`nomarmy army assign <role> ${j.agentName} ${j.model}\` re-tests it, and a passing test clears this.`);
    });
    // An agent's max_concurrent, machine-wide. Batch jobs on the same agent
    // queue for its slot at launch instead (withAgentSlot's waitMs).
    if (jobs.length === 1) {
      const [j] = jobs;
      const max = j.mode !== "verify" && j.agentName ? agentMaxConcurrent(j.agentName) : null;
      const held = max ? liveSlots(slotsRoot, j.agentName) : 0;
      if (max && held >= max) problems.push(`not admitted (capacity): agent "${j.agentName}" already has ${held} job(s) running across this machine's nomArmy sessions, at its max_concurrent of ${max}`);
    }
    // A job in a /feature run: the run's own limits and paused agents.
    jobs.forEach((j, i) => {
      if (!j.run_id) return;
      try {
        const run = loadRun(runsRoot, j.run_id);
        if (run.repo !== projectDir) problems.push(`${jobs.length > 1 ? `job ${i + 1}: ` : ""}run "${run.id}" belongs to ${run.repo}, not this repository`);
        const running = liveLeases(leasesRoot, { runId: run.id }).length + jobs.slice(0, i).filter((o) => o.run_id === run.id).length;
        for (const p of runAdmissionProblems(run, { agentName: j.mode === "verify" ? null : j.agentName ?? "local", running })) problems.push(jobs.length > 1 ? `job ${i + 1}: ${p}` : p);
      } catch (error) { problems.push(jobs.length > 1 ? `job ${i + 1}: ${error.message}` : error.message); }
    });
    // Slot capacity only concerns local jobs: a remote job's inference runs
    // at its vendor and never competes for llama-server's slots. When this
    // install runs llama-server itself, free memory applies to every job
    // (the model and each job's sandbox share it), so a remote-only batch is
    // checked for memory alone. A remote or hosted install has no model
    // here to size memory against. Remote jobs have their own, additive
    // ceiling (currentMaxPoolWorkers).
    const anyLocal = jobs.some((j) => jobLane(j) === "local");
    const admission = anyLocal
      ? assessAdmission({ hardware: admissionHardware(), runningJobs: runningCount("local"), slots: deps.budgetState.contextInfo.slots, maxWorkers: currentMaxWorkers() })
      : assessAdmission({ hardware: jobs.every(j => j.mode === "verify") ? null : admissionHardware(), runningJobs: 0, slots: null, maxWorkers: Infinity });
    if (!admission.admit) problems.push(...admission.reasons.map(r => `not admitted (${admission.level}): ${r}`));
    if (jobs.some((j) => jobLane(j) === "remote")) {
      const remoteCeiling = currentMaxPoolWorkers(), runningRemote = runningCount("remote");
      if (runningRemote >= remoteCeiling) {
        problems.push(`not admitted (capacity): ${runningRemote} remote job(s) (api or subscription agents) already running, at NOMARMY_MAX_POOL_WORKERS=${remoteCeiling}`);
      }
    }
    return { problems, admission };
  }

  function refusal(problems) {
    return toolText(refusalText(problems, capacitySnapshot), true);
  }
  /** A run's totals and warnings, for a tool response. */
  function runBrief(runId) {
    try {
      const run = loadRun(runsRoot, runId);
      const totals = runTotals(run);
      return { id: run.id, status: run.status, limits: run.limits, used: totals.used, warnings: totals.warnings };
    } catch (error) { return { id: runId, error: error.message }; }
  }

  /**
   * Record a finished job into its run. A usage-limit message is looked for
   * only in error text (OpenClaw's failure envelope, and the error lines of
   * a thrown run), never in the worker's report or tool output, where "rate
   * limit" may just be the code under review.
   */
  function recordJobInRun(args, jobId, result, error = null) {
    if (!args.run_id) return;
    const kind = args.mode === "verify" ? "verify" : args.pool ? "api" : args.subscription_worker ? "subscription" : "local";
    const m = result?.manifest ?? {};
    const errorLines = [m.worker?.error, error?.message,
      ...String(m.workerError ?? "").split(/\r?\n/).filter((l) => /error|limit|429/i.test(l))].filter(Boolean).join("\n");
    const usageLimit = (kind === "local" || kind === "verify") ? null : detectUsageLimit(errorLines);
    try {
      const before = runTotals(loadRun(runsRoot, args.run_id)).warnings;
      const updated = recordRunJob(runsRoot, args.run_id, {
        jobId, agent: kind === "verify" ? null : args.agentName ?? "local", kind, model: kind === "verify" ? null : args.model ?? null, role: args.armyRole ?? null, mode: args.mode,
        outcome: m.outcome ?? (error ? "ERROR" : null), costUsd: kind === "verify" ? 0 : m.metrics?.worker_cost_usd ?? null,
        tokens: kind === "verify" ? 0 : m.metrics?.worker_tokens_total ?? null, usageLimit,
      });
      // A limit crossed or an agent paused by this job is worth interrupting for.
      const fresh = runTotals(updated).warnings.filter((w) => !before.includes(w) && /OVER|paused/.test(w));
      if (fresh.length) notify(`nomArmy run ${updated.name}: stopped short`, fresh.join("; "));
    } catch (recordError) {
      fs.appendFileSync(path.join(jobsRoot, jobId, "coordinator.log"), `${new Date().toISOString()} could not record into run ${args.run_id}: ${recordError.message}\n`);
    }
  }
  function trackInRun(args, entry) {
    if (args.run_id) entry.promise.then((r) => recordJobInRun(args, entry.jobId, r), (e) => recordJobInRun(args, entry.jobId, null, e));
    return entry;
  }
  function launch(args) {
    const workerId = args.worker_id || null;
    const jobId = slug(workerId || (args.mode === "scout" ? "scout" : "worker"));
    return trackInRun(args, track(jobId, { mode: args.mode, workerId: workerId || jobId, lane: jobLane(args), agent: args.agentName ?? null, runId: args.run_id ?? null, role: args.armyRole ?? null, model: args.model ?? null },
      withAgentSlot(args, jobId, () => executeJob({ ...jobArgs(args, workerId), jobId }))));
  }
  // Best-effort progress signal for a job still mid-run: a plain "phase: worker,
  // elapsed: Ns" told a caller nothing about whether the worker was still
  // reading or already editing, short of running `git status` on the worktree
  // by hand. Both lookups here are read-only and disposable -- a job's worktree
  // mid-write or a transcript sqlite file mid-append can legitimately fail to
  // read, and that must never fail the status call, only omit the field.
  async function liveProgress(jobDir) {
    const out = {};
    try {
      const worktree = path.join(jobDir, "worktree");
      if (fs.existsSync(worktree)) {
        // --untracked-files=normal, not all: "all" descends into every
        // untracked directory (a virtualenv, a cache) a job creates. Bounded:
        // a live progress read must never hold anything up.
        const statusOut = (await run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=normal"], { cwd: worktree, trim: false, timeoutMs: 10000 })).stdout;
        // Same runtime-junk filter as collectGitRecord/makeIdleDiffTick: .npm/
        // etc. is the sandbox's own churn, not the worker's progress, and
        // counting it made a job that had made zero real edits report
        // filesChangedLive: 1 anyway.
        out.filesChangedLive = parseStatusPorcelainZ(statusOut).map(e => e.file).filter(f => !isRuntimeJunk(f)).length;
      }
    } catch { /* worktree not ready yet, or mutated mid-read; omit */ }
    try {
      const stateDir = path.join(jobDir, "runtime", "state");
      const transcript = await readOpenClawTranscriptTail(stateDir, { limit: 6 });
      if (transcript.available) {
        const last = transcript.toolCalls.at(-1);
        if (last) out.lastTool = { tool: last.tool, target: last.path ?? last.command ?? null };
      }
      // A claude-cli worker's tools only appear in Claude Code's own session
      // transcript, not OpenClaw's.
      if (!out.lastTool) {
        const startedMs = Date.parse(readJson(path.join(jobDir, "status.json"))?.startedAt ?? "") || 0;
        const claude = readClaudeSessionTranscript(path.join(jobDir, "worktree"), { sinceMs: startedMs, tailBytes: 262144 });
        const last = claude.available ? claude.toolCalls.at(-1) : null;
        if (last) { out.lastTool = { tool: last.tool, target: last.path ?? last.command ?? null }; out.toolCallsLive = claude.toolCalls.length; }
      }
    } catch { /* transcript not created yet, or locked mid-write; omit */ }
    return out;
  }

  async function summarize(entry, files, jobDir = null) {
    const status = files.status, meta = files.meta ?? files.failure;
    const elapsedSeconds = status?.startedAt ? Math.round((Date.now() - Date.parse(status.startedAt)) / 1000) : entry ? Math.round((Date.now() - Date.parse(entry.startedAt)) / 1000) : null;
    const out = { jobId: entry?.jobId ?? status?.jobId ?? meta?.jobId ?? null, workerId: entry?.workerId ?? status?.workerId ?? meta?.workerId ?? null,
      mode: entry?.mode ?? status?.mode ?? meta?.mode ?? null, state: null, phase: status?.phase ?? "starting", elapsedSeconds,
      timeoutSeconds: status?.timeoutSeconds ?? null, coordinatorStatus: meta?.coordinatorStatus ?? null, outcome: meta?.outcome ?? null,
      reviewRequired: meta?.reviewRequired ?? null, issues: (meta?.issues ?? []).slice(0, 6), worktree: meta?.worktree ?? null, branch: meta?.branch ?? null,
      commit: meta?.commit?.sha ?? null, scout: meta?.scout ? { supported: meta.scout.supported, unsupported: meta.scout.unsupported } : null };
    if (meta?.mode === "verify") Object.assign(out, { verification: meta.verification, baseRef: meta.baseRef, baseSha: meta.baseSha });
    if (entry && !entry.settled) out.state = "running";
    else if (entry?.error) { out.state = "failed"; out.error = String(entry.error.message ?? entry.error).split("\n")[0]; }
    else if (meta) out.state = "finished";
    else if (status?.state === "running") { out.state = status.serverPid === process.pid ? "running" : "orphaned"; if (out.state === "orphaned") out.error = `the MCP server that ran this job (pid ${status.serverPid}) is gone; outcome unknown, see the job directory logs`; }
    else out.state = "unknown";
    if (out.state === "running" && jobDir) Object.assign(out, await liveProgress(jobDir));
    return out;
  }

  return { WORKER_START_STAGGER_MS, activeJobs, runningCount, agentMaxConcurrent, withAgentSlot, track, notifyJobFinished, capacitySnapshot, admit, refusal, runBrief, recordJobInRun, trackInRun, launch, liveProgress, summarize };
}
