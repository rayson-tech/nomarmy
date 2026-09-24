// Worker budgets derived from the context a nom actually has, and an
// admission check derived from the memory this host actually has free.
//
// Two different resources, two different levers, deliberately not conflated:
//
//   * Context per nom bounds TEXT: how long a brief may be, how long a report
//     may be, how many scout findings and excerpt lines are worth carrying.
//     llama-server allocates the whole KV cache for every slot at startup, so
//     a shorter brief does not save memory -- it saves the nom's attention.
//
//   * Free memory bounds ADMISSION: whether starting one more job (which adds
//     a Podman sandbox and an OpenClaw process, never a second copy of the
//     model) is safe right now. Under pressure nomArmy refuses to start; it
//     does not shrink the brief and hope.
//
// Everything here is pure except `resolveContextPerNom`, which may ask a
// running llama-server what its slots actually are; the probe is injectable.
import { DEFAULT_TARGET_CONTEXT_PER_NOM, MIN_CONTEXT_PER_NOM, RESERVES, GIB, formatBytes, isCloudExecution } from "./sizing.mjs";

/**
 * Hard ceilings the MCP tool schema enforces regardless of hardware. The
 * derived budget may be lower than these, never higher, unless an explicit
 * environment override says so. 3000 characters is the calibrated value: a
 * ten-file, ~3.5k-character brief produced zero edits before a small model ran
 * out of output budget.
 */
export const CALIBRATED = Object.freeze({
  taskChars: 3000,
  acceptanceItemChars: 300,
  charsPerToken: 4,
});

/**
 * Ceilings for a frontier worker (any api or subscription agent). The
 * CALIBRATED numbers above were measured on a ~20B local model, where a long
 * brief made it thrash; applied to a 272k-context frontier model they only
 * starve it of the spec the coordinator already has. These are estimates,
 * not measurements yet -- revisit them against real frontier jobs.
 */
export const FRONTIER = Object.freeze({
  taskChars: 16000,
  acceptanceItemChars: 600,
  evidenceChars: 24000,
});

/** Evidence ceiling for the local tier (NOMARMY_MAX_EVIDENCE_CHARS overrides it). */
export const LOCAL_EVIDENCE_CHARS = 6000;

/**
 * Report ceilings in tokens by tier and requested size. A report lands in
 * the coordinator's own context and is re-read on every later turn, so the
 * coordinator picks the size per job (`report`), capped by the worker's
 * tier. The local tier never grows past its calibrated caps.
 */
export const REPORT_CAPS = Object.freeze({
  local: Object.freeze({
    brief: { implement: 512, scout: 1536, decompose: 2048 },
    standard: { implement: 512, scout: 1536, decompose: 2048 },
    full: { implement: 512, scout: 1536, decompose: 2048 },
  }),
  frontier: Object.freeze({
    brief: { implement: 512, scout: 1536, decompose: 2048 },
    standard: { implement: 1024, scout: 2048, decompose: 2048 },
    full: { implement: 2048, scout: 4096, decompose: 4096 },
  }),
});
export const REPORT_SIZES = Object.freeze(["brief", "standard", "full"]);

/** The rules of thumb, in one place so a reviewer can argue with them. */
export const BUDGET_RULES = Object.freeze({
  /** Share of the nom's context a brief may occupy, then clamped. */
  briefFraction: 0.05,
  briefTokensMin: 300,
  briefTokensMax: CALIBRATED.taskChars / CALIBRATED.charsPerToken, // 750 -> 3000 chars
  /** Implement report: four lines. The cap only shrinks on tiny contexts. */
  implementReportFraction: 0.02,
  implementReportTargetTokens: 256,
  implementReportCapMin: 320,
  implementReportCapMax: 512,
  /** Scout report: one line per finding plus citations; needs more room. */
  scoutReportFraction: 0.04,
  scoutReportCapMin: 384,
  scoutReportCapMax: 1536,
  /** Scout structure. Excerpt lines are frontier context, so they stay modest. */
  scoutFindingsMin: 4,
  scoutFindingsMax: 12,
  scoutCitationsPerFinding: 4,
  scoutExcerptLinesPerCitation: 12,
  scoutExcerptLinesTotalMin: 60,
  scoutExcerptLinesTotalMax: 160,
  scoutFindingChars: 300,
  /** Decompose report: one subtask block per finding; heavier than scout. */
  decomposeReportFraction: 0.06,
  decomposeReportCapMin: 512,
  decomposeReportCapMax: 2048,
  decomposeSubtasksMin: 2,
  decomposeSubtasksMax: 6,
  decomposeAcceptancePerSubtask: 3,
  decomposeFilesPerSubtask: 4,
  decomposeSubtaskChars: 200,
  /** Admission: what one more job needs free, and the floor below it. */
  admissionFloorBytes: 1 * GIB,
  tightFraction: 0.15,
  /**
   * Wall-clock split of a job's requested timeout: a work phase and a
   * reserved report phase. A worker that spends its entire budget "working"
   * has nothing left to emit even the four-line report if OpenClaw's own
   * per-turn output budget runs out mid-reply -- observed directly: a run
   * returned ok:true with a reply cut off mid-sentence, rescued only by a
   * follow-up call squeezed into whatever time happened to be left.
   * Reserving a slice up front guarantees that follow-up has real room
   * instead of fighting the same deadline the work phase already used up.
   */
  reportReserveFraction: 0.12,
  reportReserveMin: 30,
  reportReserveMax: 180,
  workTimeoutMin: 20,
  /**
   * Idle-diff circuit breaker: end the work phase early once the worktree
   * stops changing, instead of running to the deadline after the work is
   * already done. Never fires before idleMinElapsedFraction of the work
   * phase has passed, and never before any change has been observed at all
   * (a job that has made no edits yet is not "idle", it just hasn't started).
   */
  idleBreakFraction: 0.35,
  idleBreakMin: 60,
  idleBreakMax: 300,
  idleMinElapsedFraction: 0.15,
  idleMinElapsedMin: 30,
  idleMinElapsedMax: 120,
  idlePollSeconds: 15,
});

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function envInt(env, name) {
  const n = Number.parseInt(env?.[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Derive text budgets from the context one nom has.
 *
 * @param {{ contextPerNom?: number|null, source?: string, env?: object }} input
 * @returns {object} budgets, with every applied override named
 */
/**
 * `tier`: "local" (the local model; every calibrated number, and the
 * NOMARMY_MAX_* env overrides, apply) or "frontier" (an api or
 * subscription agent; FRONTIER and REPORT_CAPS.frontier ceilings).
 * `reportSize`: the coordinator's per-job choice of how much comes back,
 * capped by the tier ("standard" when omitted).
 */
export function deriveBudgets({ contextPerNom = null, source = "default", env = process.env, tier = "local", reportSize = "standard" } = {}) {
  const ctx = Number.isFinite(contextPerNom) && contextPerNom > 0 ? Math.floor(contextPerNom) : DEFAULT_TARGET_CONTEXT_PER_NOM;
  const effectiveSource = Number.isFinite(contextPerNom) && contextPerNom > 0 ? source : "default";
  const R = BUDGET_RULES, cpt = CALIBRATED.charsPerToken;
  const frontier = tier === "frontier";
  const caps = REPORT_CAPS[frontier ? "frontier" : "local"][REPORT_SIZES.includes(reportSize) ? reportSize : "standard"];
  const overrides = [];

  const briefTokens = clamp(Math.floor(ctx * R.briefFraction), R.briefTokensMin, (frontier ? FRONTIER.taskChars : CALIBRATED.taskChars) / cpt);
  let maxTaskChars = briefTokens * cpt;
  let maxAcceptanceItemChars = Math.min(frontier ? FRONTIER.acceptanceItemChars : CALIBRATED.acceptanceItemChars, Math.max(120, Math.floor(maxTaskChars / 10)));
  let maxEvidenceChars = frontier ? FRONTIER.evidenceChars : LOCAL_EVIDENCE_CHARS;
  // The env overrides tune the local model, where the calibration came
  // from; a frontier worker's ceilings don't follow them.
  if (!frontier) {
    const taskOverride = envInt(env, "NOMARMY_MAX_TASK_CHARS");
    if (taskOverride) { maxTaskChars = taskOverride; overrides.push("NOMARMY_MAX_TASK_CHARS"); }
    const itemOverride = envInt(env, "NOMARMY_MAX_ACCEPTANCE_ITEM_CHARS");
    if (itemOverride) { maxAcceptanceItemChars = itemOverride; overrides.push("NOMARMY_MAX_ACCEPTANCE_ITEM_CHARS"); }
    const evidenceOverride = envInt(env, "NOMARMY_MAX_EVIDENCE_CHARS");
    if (evidenceOverride) { maxEvidenceChars = evidenceOverride; overrides.push("NOMARMY_MAX_EVIDENCE_CHARS"); }
  }

  const implementCap = clamp(Math.floor(ctx * R.implementReportFraction), R.implementReportCapMin, caps.implement);
  const implementTarget = Math.min(frontier ? Math.floor(caps.implement / 2) : R.implementReportTargetTokens, Math.floor(implementCap / 2) + 64);
  const scoutCap = clamp(Math.floor(ctx * R.scoutReportFraction), R.scoutReportCapMin, caps.scout);
  const scoutTarget = Math.floor(scoutCap * 0.6);

  // Findings scale with the report cap: one finding with citations is roughly
  // 60 tokens, and the header/footer lines take about 40.
  const maxFindings = clamp(Math.floor((scoutCap - 40) / 60), R.scoutFindingsMin, frontier ? 24 : R.scoutFindingsMax);
  const decomposeCap = clamp(Math.floor(ctx * R.decomposeReportFraction), R.decomposeReportCapMin, caps.decompose);
  const decomposeTarget = Math.floor(decomposeCap * 0.6);
  const maxSubtasks = clamp(Math.floor((decomposeCap - 40) / 150), R.decomposeSubtasksMin, R.decomposeSubtasksMax);
  let maxExcerptLinesTotal = clamp(Math.floor(ctx / 512), R.scoutExcerptLinesTotalMin, frontier ? 320 : R.scoutExcerptLinesTotalMax);
  const excerptOverride = envInt(env, "NOMARMY_SCOUT_MAX_EXCERPT_LINES");
  if (excerptOverride && !frontier) { maxExcerptLinesTotal = excerptOverride; overrides.push("NOMARMY_SCOUT_MAX_EXCERPT_LINES"); }

  return {
    contextPerNom: ctx,
    source: effectiveSource,
    tier: frontier ? "frontier" : "local",
    reportSize: REPORT_SIZES.includes(reportSize) ? reportSize : "standard",
    brief: { maxTaskChars, maxAcceptanceItemChars, maxAcceptanceItems: 20, maxEvidenceChars },
    report: {
      implement: { targetTokens: implementTarget, hardCapTokens: implementCap },
      scout: { targetTokens: scoutTarget, hardCapTokens: scoutCap },
      decompose: { targetTokens: decomposeTarget, hardCapTokens: decomposeCap },
    },
    scout: {
      maxFindings,
      maxCitationsPerFinding: R.scoutCitationsPerFinding,
      maxExcerptLinesPerCitation: R.scoutExcerptLinesPerCitation,
      maxExcerptLinesTotal,
      maxFindingChars: R.scoutFindingChars,
    },
    decompose: {
      maxSubtasks,
      maxAcceptancePerSubtask: R.decomposeAcceptancePerSubtask,
      maxFilesPerSubtask: R.decomposeFilesPerSubtask,
      maxSubtaskChars: R.decomposeSubtaskChars,
    },
    overrides,
    tooSmall: ctx < MIN_CONTEXT_PER_NOM,
  };
}

/**
 * Split a job's requested wall-clock timeout into a work phase and a
 * reserved report phase, plus the idle-diff circuit-breaker thresholds
 * derived from the work phase. Pure and deterministic; env overrides use the
 * same envInt() convention as everything else here.
 *
 * @param {{ timeoutSeconds: number, env?: object }} input
 */
export function deriveTimeBudget({ timeoutSeconds, env = process.env } = {}) {
  const R = BUDGET_RULES;
  const total = Math.max(30, Math.floor(Number(timeoutSeconds) || 600));

  let reportReserveSeconds = clamp(Math.round(total * R.reportReserveFraction), R.reportReserveMin, R.reportReserveMax);
  const reserveOverride = envInt(env, "NOMARMY_REPORT_RESERVE_SECONDS");
  if (reserveOverride) reportReserveSeconds = reserveOverride;
  const workTimeoutSeconds = Math.max(R.workTimeoutMin, total - reportReserveSeconds);
  reportReserveSeconds = total - workTimeoutSeconds; // recomputed so work + reserve always equals what the caller asked for

  let idleBreakSeconds = Math.min(clamp(Math.round(workTimeoutSeconds * R.idleBreakFraction), R.idleBreakMin, R.idleBreakMax), workTimeoutSeconds);
  const idleOverride = envInt(env, "NOMARMY_IDLE_BREAK_SECONDS");
  if (idleOverride) idleBreakSeconds = Math.min(idleOverride, workTimeoutSeconds);
  const idleMinElapsedSeconds = Math.min(clamp(Math.round(workTimeoutSeconds * R.idleMinElapsedFraction), R.idleMinElapsedMin, R.idleMinElapsedMax), workTimeoutSeconds);

  return { timeoutSeconds: total, workTimeoutSeconds, reportReserveSeconds, idleBreakSeconds, idleMinElapsedSeconds, idlePollSeconds: R.idlePollSeconds };
}

/**
 * Check a brief against a derived budget. Returns a list of problems; empty
 * means admissible. This is the soft, hardware-aware check; the tool schema's
 * ceiling is the hard one.
 */
export function checkBrief({ task, acceptance = [], evidence = null }, budgets) {
  const problems = [];
  const b = budgets.brief;
  const who = budgets.tier === "frontier" ? "this agent's model" : "this nom";
  const taskLen = String(task ?? "").length;
  if (taskLen > b.maxTaskChars) {
    problems.push(`objective is ${taskLen} characters; ${who}'s ${budgets.contextPerNom}-token context (${budgets.source}) allows ${b.maxTaskChars}. Split the job, or reference paths and line ranges instead of pasting content.`);
  }
  const evidenceLen = String(evidence ?? "").length;
  if (b.maxEvidenceChars && evidenceLen > b.maxEvidenceChars) {
    problems.push(`evidence is ${evidenceLen} characters; ${who} allows ${b.maxEvidenceChars}. Hand over less, or a path and line range instead of the material.`);
  }
  (acceptance ?? []).forEach((item, i) => {
    const len = String(item ?? "").length;
    if (len > b.maxAcceptanceItemChars) problems.push(`acceptance item ${i + 1} is ${len} characters; the budget allows ${b.maxAcceptanceItemChars}.`);
  });
  if ((acceptance ?? []).length > b.maxAcceptanceItems) problems.push(`${acceptance.length} acceptance items; the budget allows ${b.maxAcceptanceItems}.`);
  return problems;
}

/**
 * Parse a llama-server `/props` body. `default_generation_settings.n_ctx` is
 * the PER-SLOT context (llama-server divides `-c` across `-np`), and
 * `total_slots` is the slot count. Anything else is ignored.
 */
export function parseLlamaProps(body) {
  let obj = body;
  if (typeof body === "string") { try { obj = JSON.parse(body); } catch { return null; } }
  if (!obj || typeof obj !== "object") return null;
  const perSlot = Number(obj.default_generation_settings?.n_ctx);
  const slots = Number(obj.total_slots);
  if (!Number.isFinite(perSlot) || perSlot <= 0) return null;
  return {
    contextPerNom: Math.floor(perSlot),
    slots: Number.isFinite(slots) && slots > 0 ? Math.floor(slots) : null,
    modelPath: typeof obj.model_path === "string" ? obj.model_path : null,
  };
}

async function defaultProbe(env) {
  const host = env.NOMARMY_LLAMA_HOST || "127.0.0.1", port = env.NOMARMY_LLAMA_PORT || "8080";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(`http://${host}:${port}/props`, { signal: controller.signal });
    if (!res.ok) return null;
    return parseLlamaProps(await res.text());
  } catch { return null; } finally { clearTimeout(timer); }
}

/**
 * Work out how much context one nom has, most authoritative source first:
 *   1. NOMARMY_CONTEXT_PER_NOM (lib.sh exports it when a profile is loaded)
 *   2. NOMARMY_LLAMA_CONTEXT / NOMARMY_LLAMA_PARALLEL
 *   3. the running llama-server's own /props (local execution only)
 *   4. NOMARMY_CONTEXT_LIMIT, the older per-worker hint
 *   5. the v1.3 design target, labeled as an assumption
 */
export async function resolveContextPerNom({ env = process.env, probe = defaultProbe } = {}) {
  const direct = envInt(env, "NOMARMY_CONTEXT_PER_NOM");
  if (direct) return { contextPerNom: direct, slots: envInt(env, "NOMARMY_LLAMA_PARALLEL"), source: "profile (NOMARMY_CONTEXT_PER_NOM)" };
  const total = envInt(env, "NOMARMY_LLAMA_CONTEXT"), parallel = envInt(env, "NOMARMY_LLAMA_PARALLEL");
  if (total && parallel) return { contextPerNom: Math.floor(total / parallel), slots: parallel, source: "profile (NOMARMY_LLAMA_CONTEXT / NOMARMY_LLAMA_PARALLEL)" };
  if (!isCloudExecution(env.NOMARMY_EXECUTION || "local")) {
    const probed = await probe(env);
    if (probed) return { contextPerNom: probed.contextPerNom, slots: probed.slots, source: "llama-server /props", modelPath: probed.modelPath };
  }
  const hint = envInt(env, "NOMARMY_CONTEXT_LIMIT") ?? envInt(env, "NOMARMY_WORKER_CONTEXT_LIMIT");
  if (hint) return { contextPerNom: hint, slots: null, source: "NOMARMY_CONTEXT_LIMIT" };
  return { contextPerNom: DEFAULT_TARGET_CONTEXT_PER_NOM, slots: null, source: "assumed v1.3 target; no profile loaded and no llama-server answered" };
}

/**
 * Decide whether one more job may start, from the memory free right now.
 * A new job costs a sandbox container plus an OpenClaw process, not a second
 * model, so the need is the per-nom sandbox reserve above a floor.
 *
 * @param {{ hardware: object|null, runningJobs?: number, slots?: number|null, maxWorkers?: number }} input
 */
export function assessAdmission({ hardware, runningJobs = 0, slots = null, maxWorkers = 1 } = {}) {
  const total = Number(hardware?.memory?.totalBytes) || null;
  const available = Number(hardware?.memory?.availableBytes) || null;
  const need = RESERVES.sandboxPerNomBytes;
  const out = { admit: true, level: "ok", reasons: [], totalBytes: total, availableBytes: available, needBytes: need, runningJobs, maxWorkers, slots };

  if (runningJobs >= maxWorkers) {
    out.admit = false; out.level = "capacity";
    out.reasons.push(`${runningJobs} job(s) already running; NOMARMY_MAX_WORKERS is ${maxWorkers}. Wait for one to finish or poll with local_worker_status.`);
  }
  if (slots && runningJobs >= slots) {
    out.admit = false; out.level = "capacity";
    out.reasons.push(`${runningJobs} job(s) already running against ${slots} llama-server slot(s); another would queue inside the server and time out.`);
  }
  if (available === null) {
    out.reasons.push("free memory could not be read; admitting on capacity alone");
    return out;
  }
  if (available < need + BUDGET_RULES.admissionFloorBytes) {
    out.admit = false; out.level = "critical";
    out.reasons.push(`only ${formatBytes(available)} free; one more sandbox needs about ${formatBytes(need)} plus a ${formatBytes(BUDGET_RULES.admissionFloorBytes)} floor. Free memory before starting another nom.`);
  } else if (total && available < total * BUDGET_RULES.tightFraction) {
    out.level = out.level === "ok" ? "tight" : out.level;
    out.reasons.push(`${formatBytes(available)} of ${formatBytes(total)} free; this job fits but the next may not.`);
  }
  return out;
}

/** Human-readable budget summary for the CLI and the capacity tool. */
export function describeBudgets(b) {
  return [
    `${b.tier === "frontier" ? "frontier agent" : "local model"}: ${b.contextPerNom}-token context (${b.source})${b.tier === "frontier" ? `, ${b.reportSize ?? "standard"} report` : ""}`,
    `brief: objective <= ${b.brief.maxTaskChars} chars, acceptance items <= ${b.brief.maxAcceptanceItemChars} chars`,
    `implement report: ~${b.report.implement.targetTokens} tokens, cap ${b.report.implement.hardCapTokens}`,
    `scout report: ~${b.report.scout.targetTokens} tokens, cap ${b.report.scout.hardCapTokens}; <= ${b.scout.maxFindings} findings, <= ${b.scout.maxExcerptLinesTotal} excerpt lines returned`,
    ...(b.overrides.length ? [`overridden by: ${b.overrides.join(", ")}`] : []),
    ...(b.tooSmall ? [`WARNING: ${b.contextPerNom} tokens is below the ${MIN_CONTEXT_PER_NOM}-token floor; expect truncated reports`] : []),
  ];
}
