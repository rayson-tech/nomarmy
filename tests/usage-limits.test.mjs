import "./helpers/isolate-global-config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readCodexRateLimits, normalizeClaudeRateLimits, mergeUsageSnapshot, recordUsageSnapshot, readUsageSnapshots, usageStatus } from "../lib/usage-limits.mjs";
import { COORDINATOR_INSTRUCTIONS } from "../lib/coordinator-instructions.mjs";
import { createJobRuntime } from "../lib/admission.mjs";
import { deriveBudgets } from "../lib/budget.mjs";
import { expandJobs, jobSchema } from "../mcp/server.mjs";

const now = Date.parse("2026-09-25T05:12:07.298Z");
const reset = now + 3600000;
const win = (name = "week", usedPercent = 15, resetsAt = reset, windowMinutes = 10080) => ({ name, usedPercent, windowMinutes, resetsAt });
const snap = (windows = [win()], limitReached = false) => ({ source: "codex", plan: "prolite", limitReached, observedAt: now, windows });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".usage-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function rollout(root, limits, name = "new", timestamp = now) {
  const dir = path.join(root, "runtime/state/agents/main/agent/codex-home/sessions/2026/09/25");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${name}.jsonl`);
  fs.writeFileSync(file, limits.map(rate_limits => JSON.stringify({ timestamp: new Date(timestamp).toISOString(), type: "event_msg", payload: { type: "token_count", rate_limits } })).join("\n") + '\n{"partial":');
  return file;
}
const raw = (percent, minutes = 10080) => ({ plan_type: "prolite", primary: { used_percent: percent, window_minutes: minutes, resets_at: reset / 1000 } });

test("Codex newest nested rollout uses last rate_limits event, with named windows and flags", t => {
  const root = fixture(t);
  assert.equal(readCodexRateLimits(root), null);
  const old = rollout(root, [raw(99)], "old");
  fs.utimesSync(old, new Date(0), new Date(0));
  rollout(root, [raw(80), raw(15)]);
  assert.deepEqual(readCodexRateLimits(root), snap());
  for (const [minutes, name] of [[300, "5h"], [10080, "week"], [1440, "day"], [60, "60m"]]) {
    rollout(root, [{ ...raw(25, minutes), secondary: { used_percent: 42, window_minutes: 300, resets_at: reset / 1000 }, rate_limit_reached_type: "primary" }]);
    assert.deepEqual(readCodexRateLimits(root), snap([win(name, 25, reset, minutes), win("5h", 42, reset, 300)], true));
  }
  rollout(root, [{ spend_control_reached: true }]);
  assert.deepEqual(readCodexRateLimits(root), { ...snap([], true), plan: null });
  rollout(root, [{}]);
  assert.equal(readCodexRateLimits(root), null);
});

test("Claude normalization handles absent and unusable windows and spend", t => {
  t.mock.method(Date, "now", () => now);
  assert.equal(normalizeClaudeRateLimits(null), null);
  assert.equal(normalizeClaudeRateLimits({ five_hour: { used_percentage: "50" } }), null);
  assert.deepEqual(normalizeClaudeRateLimits({ seven_day: { used_percentage: 15, resets_at: reset / 1000 } }), { ...snap(), source: "claude", plan: null });
  assert.deepEqual(normalizeClaudeRateLimits({ five_hour: { used_percentage: 80 }, spend_limit: { used_percentage: 100, resets_at: reset / 1000 } }), {
    source: "claude", plan: null, limitReached: false, observedAt: now, windows: [win("5h", 80, null, 300), win("spend", 100, reset, null)],
  });
});

test("usage status levels, ordered text, expired windows and reached flags", () => {
  const label = new Date(reset).toLocaleString("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  for (const [percent, level] of [[15, "ok"], [80, "high"], [100, "over"], [110, "over"]]) {
    assert.deepEqual(usageStatus(snap([win("week", percent)]), now + 120000), { level, text: `${percent}% of week, resets ${label}`, short: `${percent}% wk`, resetsAt: level === "over" ? reset : null, ageMinutes: 2 });
  }
  assert.deepEqual(usageStatus(snap([win("5h", 10), win("week", 85)]), now), { level: "high", text: `85% of week, resets ${label}; 10% of 5h, resets ${label}`, short: "85% wk", resetsAt: null, ageMinutes: 0 });
  assert.deepEqual(usageStatus(snap([win("week", 100, now)], true), now), { level: "ok", text: "no live usage windows", short: null, resetsAt: null, ageMinutes: 0 });
  assert.deepEqual(usageStatus(snap([win("week", 15)], true), now), { level: "over", text: `15% of week, resets ${label}`, short: "15% wk", resetsAt: reset, ageMinutes: 0 });
  assert.deepEqual(usageStatus(snap([], true), now), { level: "over", text: "limit reached, reset unknown", short: "limit", resetsAt: null, ageMinutes: 0 });
  assert.deepEqual(usageStatus(snap([win("week", 100, now), win("5h", 85, null, 300)]), now), { level: "high", text: "85% of 5h, resets unknown", short: "85% 5h", resetsAt: null, ageMinutes: 0 });
});

test("coordinator instructions require operator approval before overriding a usage hold", () => {
  assert.match(COORDINATOR_INSTRUCTIONS, /usage limits show in army and local_worker_capacity/);
  assert.match(COORDINATOR_INSTRUCTIONS, /Ask the operator before resubmitting with confirm_over_limit: true/);
  assert.match(COORDINATOR_INSTRUCTIONS, /Never set it on your own/);
});

test("snapshot persistence recovers corrupt files and retains every provider atomically", t => {
  const root = fixture(t), file = path.join(root, "usage-limits.json");
  assert.deepEqual(readUsageSnapshots(root), {});
  for (const corrupt of ["{broken", "null", "[]", '{"bad":{"windows":[]}}']) {
    fs.writeFileSync(file, corrupt);
    assert.deepEqual(readUsageSnapshots(root), {});
  }
  recordUsageSnapshot(root, "openai", snap());
  recordUsageSnapshot(root, "anthropic", { ...snap(), source: "claude" });
  assert.deepEqual(readUsageSnapshots(root), { openai: snap(), anthropic: { ...snap(), source: "claude" } });
  assert.deepEqual(fs.readdirSync(root), ["usage-limits.json"]);
  // A job that finishes late doesn't replace a newer reading with an older one.
  recordUsageSnapshot(root, "openai", { ...snap(), observedAt: snap().observedAt - 60000, windows: [] });
  assert.deepEqual(readUsageSnapshots(root).openai, snap());
});

function runtime(root, extra = {}) {
  const budgets = deriveBudgets({ env: {} });
  return createJobRuntime({ env: { NOMARMY_EXECUTION: "hosted" }, projectDir: root, projectDirProblem: () => null, stateRoot: root, jobsRoot: path.join(root, "jobs"),
    leasesRoot: path.join(root, "leases"), slotsRoot: path.join(root, "slots"),
    budgetState: { hardwareSnapshot: null, contextInfo: { slots: 3 }, budgets, refresh: async () => {} },
    currentMaxWorkers: () => 2, budgetsForJob: () => budgets, subscriptionJobFieldProblems: () => [], repoPolicy: () => ({}), modelCatalogReady: async () => {},
    agentsConfig: () => ({ agents: { coder: { kind: "subscription", provider: "openai" } } }),
    usageRun: extra.usageRun, usageRefreshTimeoutMs: extra.usageRefreshTimeoutMs,
  });
}

test("admission holds over-limit jobs, allows confirmation and high usage; capacity shows provider status", async t => {
  t.mock.method(Date, "now", () => now);
  const root = fixture(t), rt = runtime(root), job = { task: "t", agentName: "coder", subscription_worker: "coder", mode: "scout" };
  recordUsageSnapshot(root, "openai", snap([win("week", 100)]));
  assert.deepEqual(jobSchema.parse({ task: "t", confirm_over_limit: true }), { task: "t", mode: "implement", reasoning: "medium", confirm_over_limit: true });
  assert.equal(jobSchema.safeParse({ task: "t", confirm_over_limit: "true" }).success, false);
  const expanded = expandJobs([{ task: "t", confirm_over_limit: true }], { getActiveRun: () => null, env: {} });
  assert.deepEqual(expanded, { jobs: [{ task: "t", confirm_over_limit: true, timeout_seconds: 600, profile: "coder" }], problems: [] });
  const label = new Date(reset).toLocaleString("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  assert.deepEqual((await rt.admit([job])).problems, [`agent "coder" is held at its usage limit: 100% of week, resets ${label} (reading 0 minutes old). Ask the operator before resubmitting with confirm_over_limit: true, or send the job to another agent.`]);
  assert.deepEqual((await rt.admit([{ ...job, confirm_over_limit: true }])).problems, []);
  assert.deepEqual(rt.capacitySnapshot().usageLimits, { openai: { level: "over", text: `100% of week, resets ${label}`, short: "100% wk", resetsAt: reset, ageMinutes: 0 } });
  recordUsageSnapshot(root, "openai", snap([win("week", 85)]));
  assert.deepEqual((await rt.admit([job])).problems, []);
  assert.deepEqual((await rt.admit([{ ...job, agentName: "unconfigured" }])).problems, []);
});

test("settled jobs record provider usage; write failures preserve both success and rejection", async t => {
  const previous = process.env.NOMARMY_NOTIFY;
  process.env.NOMARMY_NOTIFY = "0";
  t.after(() => { if (previous === undefined) delete process.env.NOMARMY_NOTIFY; else process.env.NOMARMY_NOTIFY = previous; });
  const root = fixture(t), rt = runtime(root);
  for (const id of ["success", "failure", "cannot-write", "cannot-write-error"]) rollout(path.join(root, "jobs", id), [raw(15)]);
  const result = { ok: true, manifest: { outcome: "DONE" } };
  assert.equal(await rt.track("success", { agent: "coder", lane: "remote" }, Promise.resolve(result)).promise, result);
  assert.deepEqual(readUsageSnapshots(root), { openai: snap() });
  fs.unlinkSync(path.join(root, "usage-limits.json"));
  const failure = new Error("original failure");
  await assert.rejects(rt.track("failure", { agent: "coder", lane: "remote" }, Promise.reject(failure)).promise, e => e === failure);
  assert.deepEqual(readUsageSnapshots(root), { openai: snap() });
  fs.unlinkSync(path.join(root, "usage-limits.json"));
  fs.mkdirSync(path.join(root, "usage-limits.json")); // rename onto a directory must fail
  assert.equal(await rt.track("cannot-write", { agent: "coder", lane: "remote" }, Promise.resolve(result)).promise, result);
  await assert.rejects(rt.track("cannot-write-error", { agent: "coder", lane: "remote" }, Promise.reject(failure)).promise, e => e === failure);
  assert.deepEqual(readUsageSnapshots(root), {});
  assert.deepEqual(fs.readdirSync(path.join(root, "leases")), []);
  assert.deepEqual(fs.readdirSync(root).filter(name => name.endsWith(".tmp")), []);
});

const OPENCLAW_TEXT = "- openai usage: 168h 100% left ⏱6d 10h";
const CLAUDE_TEXT = "- claude-cli usage: 5h 82% left ⏱3h 4m";
const openclawReset = (at) => at + 6 * 86400000 + 10 * 3600000;
function openclawSnapshot(at) {
  return { source: "openclaw", plan: null, limitReached: false, observedAt: at,
    windows: [{ name: "week", usedPercent: 0, windowMinutes: 10080, resetsAt: openclawReset(at) }] };
}
const hold = (label, age, extra = "") => `agent "coder" is held at its usage limit: 100% of week, resets ${label} (reading ${age} minutes old).${extra} Ask the operator before resubmitting with confirm_over_limit: true, or send the job to another agent.`;
function writeSnapshot(root, snapshot) {
  fs.writeFileSync(path.join(root, "usage-limits.json"), JSON.stringify({ openai: snapshot }));
}

test("OpenClaw captured usage text converts exact week and 5h windows without JSON", async () => {
  const { parseOpenClawUsageOutput, fetchOpenClawUsage } = await import("../lib/usage-limits.mjs");
  const expected = { openai: openclawSnapshot(now), "claude-cli": {
    source: "openclaw", plan: null, limitReached: false, observedAt: now,
    windows: [{ name: "5h", usedPercent: 18, windowMinutes: 300, resetsAt: now + 11040000 }],
  } };
  assert.equal(expected.openai.windows[0].resetsAt, now + 554400000);
  const stdout = `${OPENCLAW_TEXT}\n${CLAUDE_TEXT}\n`;
  assert.deepEqual(parseOpenClawUsageOutput(stdout, now), expected);
  for (const [duration, milliseconds] of [["3h 20m", 12000000], ["45m", 2700000]]) {
    assert.deepEqual(parseOpenClawUsageOutput(CLAUDE_TEXT.replace("3h 4m", duration), now), {
      "claude-cli": { ...expected["claude-cli"], windows: [{ name: "5h", usedPercent: 18, windowMinutes: 300, resetsAt: now + milliseconds }] },
    });
  }
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, args]);
    return { ok: true, stdout: args.includes("--json") ? '{"auth":{}}' : stdout };
  };
  assert.deepEqual(await fetchOpenClawUsage({ run, now, timeoutMs: 1000, openclawCmd: "openclaw" }), { ok: true, snapshots: expected, error: null });
  assert.deepEqual(calls, [["openclaw", ["models", "status"]]]);
});

test("usage refresh is async: the event loop keeps running while OpenClaw is pending", async () => {
  const { fetchOpenClawUsage } = await import("../lib/usage-limits.mjs");
  let interleaved = false;
  const run = () => new Promise((resolve) => {
    setTimeout(() => resolve({ ok: true, stdout: OPENCLAW_TEXT }), 40);
  });
  const pending = fetchOpenClawUsage({ run, now, timeoutMs: 2000, openclawCmd: "openclaw" });
  setTimeout(() => { interleaved = true; }, 5);
  const result = await pending;
  assert.equal(interleaved, true);
  assert.equal(result.ok, true);
  assert.equal(result.snapshots.openai.windows[0].usedPercent, 0);
  assert.deepEqual(Object.keys(result.snapshots).sort(), ["openai"]);
});

test("a stale over-limit reading is refreshed before the hold; a fresh one is not", async (t) => {
  t.mock.method(Date, "now", () => now);
  const { staleUsageRefreshedNote } = await import("../lib/usage-limits.mjs");
  const root = fixture(t);
  const label = new Date(reset).toLocaleString("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  const job = { task: "t", agentName: "coder", subscription_worker: "coder", mode: "scout" };
  const calls = [];
  const run = async (cmd, args) => { calls.push([cmd, args]); return { ok: true, stdout: OPENCLAW_TEXT }; };
  writeSnapshot(root, { ...snap([win("week", 100)]), observedAt: now });
  assert.deepEqual((await runtime(root, { usageRun: run }).admit([job])).problems, [hold(label, 0)]);
  assert.deepEqual(calls, []);
  writeSnapshot(root, { ...snap([win("week", 100)]), observedAt: now - 9 * 60000 });
  assert.deepEqual((await runtime(root, { usageRun: run }).admit([job])).problems, [hold(label, 9)]);
  assert.deepEqual(calls, [], "a 9 minute old reading is still fresh");
  writeSnapshot(root, { ...snap([win("week", 100)]), observedAt: now - 149 * 60000 });
  const admitted = await runtime(root, { usageRun: run }).admit([job]);
  assert.deepEqual(admitted.problems, []);
  assert.deepEqual(admitted.admission.reasons.filter((line) => line.startsWith("stale usage reading ")), [staleUsageRefreshedNote("openai")]);
  assert.equal(staleUsageRefreshedNote("openai"), "stale usage reading for openai was refreshed from OpenClaw");
  assert.deepEqual(calls, [["openclaw", ["models", "status"]]]);
  const saved = readUsageSnapshots(root).openai;
  assert.deepEqual(saved, openclawSnapshot(now));
  assert.deepEqual(Object.keys(saved).sort(), ["limitReached", "observedAt", "plan", "source", "windows"]);
});

test("a failed or timed-out usage refresh keeps the hold and says the refresh failed", async (t) => {
  t.mock.method(Date, "now", () => now);
  const root = fixture(t);
  const label = new Date(reset).toLocaleString("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  const job = { task: "t", agentName: "coder", subscription_worker: "coder", mode: "scout" };
  const stale = { ...snap([win("week", 100)]), observedAt: now - 149 * 60000 };
  writeSnapshot(root, stale);
  const failed = await runtime(root, { usageRun: async () => ({ ok: false, stdout: "" }) }).admit([job]);
  assert.deepEqual(failed.problems, [hold(label, 149, " OpenClaw usage refresh failed.")]);
  assert.deepEqual(readUsageSnapshots(root).openai, stale);
  writeSnapshot(root, stale);
  const timedOut = await runtime(root, { usageRun: () => new Promise(() => {}), usageRefreshTimeoutMs: 30 }).admit([job]);
  assert.deepEqual(timedOut.problems, [hold(label, 149, " OpenClaw usage refresh failed (timed out).")]);
  assert.deepEqual(readUsageSnapshots(root).openai, stale);
});

test("health, army, and capacity mark a stale over-limit reading and refresh it", async (t) => {
  t.mock.method(Date, "now", () => now);
  const { describeArmy } = await import("../lib/army.mjs");
  const { runHealthChecks } = await import("../lib/health.mjs");
  const root = fixture(t);
  const label = new Date(reset).toLocaleString("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  const freshLabel = new Date(openclawReset(now)).toLocaleString("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  const stale = { ...snap([win("week", 100)]), observedAt: now - 149 * 60000 };
  const loaded = { army: { general: null, workflow: null, roles: { coder: { agent: "coder" } } }, sources: { roles: { coder: {} } }, layers: [] };
  const agents = { coder: { kind: "subscription", provider: "openai" } };
  const marked = describeArmy(loaded, { agents, agentProviderId: (agent) => agent.provider, now, usageSnapshots: { openai: stale } });
  assert.deepEqual(marked.roles.coder.usage, { level: "over", text: `100% of week, resets ${label}; possibly stale (149 minutes old)` });
  const failedView = describeArmy(loaded, { agents, agentProviderId: (agent) => agent.provider, now, usageSnapshots: { openai: stale }, usageRefreshError: "OpenClaw usage refresh failed", usageRefreshFailed: ["openai"] });
  assert.deepEqual(failedView.roles.coder.usage, { level: "over", text: `100% of week, resets ${label}; possibly stale (149 minutes old). OpenClaw usage refresh failed` });
  writeSnapshot(root, stale);
  const calls = [];
  const run = async (cmd, args) => {
    calls.push(args);
    return args[0] === "models" && args[1] === "status" ? { ok: true, stdout: OPENCLAW_TEXT } : { ok: false, stdout: "" };
  };
  const health = await runHealthChecks({ now, run, stateRoot: root, usageSnapshots: { openai: stale }, openclawCmd: "openclaw" });
  assert.deepEqual(health.issues.filter((issue) => String(issue.id).startsWith("usage:")), []);
  assert.deepEqual(readUsageSnapshots(root).openai, openclawSnapshot(now));
  assert.deepEqual(calls.filter((args) => args[0] === "models" && args[1] === "status"), [["models", "status"]]);
  writeSnapshot(root, stale);
  const held = await runHealthChecks({ now, run: async () => ({ ok: false, stdout: "" }), stateRoot: root, usageSnapshots: { openai: stale }, openclawCmd: "openclaw" });
  assert.deepEqual(held.issues.filter((issue) => String(issue.id).startsWith("usage:")), [{
    id: "usage:openai:over", severity: "warn", title: "openai is at its usage limit",
    detail: `100% of week, resets ${label}; possibly stale (149 minutes old). OpenClaw usage refresh failed.`,
    fix: "wait for the reset, or move its roles with nomarmy army assign", short: "openai 100% wk",
  }]);
  const quiet = [];
  writeSnapshot(root, { ...snap([win("week", 100)]), observedAt: now });
  const freshView = await runtime(root, { usageRun: async (cmd, args) => { quiet.push(args); return { ok: true, stdout: OPENCLAW_TEXT }; } }).displayedCapacity();
  assert.deepEqual(quiet, []);
  assert.equal(freshView.usageLimits.openai.level, "over");
  assert.equal(freshView.usageLimits.openai.text, `100% of week, resets ${label}`);
  writeSnapshot(root, stale);
  const refreshedView = await runtime(root, { usageRun: run }).displayedCapacity();
  assert.deepEqual(Object.keys(refreshedView.usageLimits.openai).sort(), ["ageMinutes", "level", "resetsAt", "short", "text"]);
  assert.deepEqual(refreshedView.usageLimits.openai, { level: "ok", text: `0% of week, resets ${freshLabel}`, short: "0% wk", resetsAt: null, ageMinutes: 0 });
  const army = describeArmy(loaded, { agents, agentProviderId: (agent) => agent.provider, now, usageSnapshots: readUsageSnapshots(root) });
  assert.deepEqual(army.roles.coder.usage, { level: "ok", text: `0% of week, resets ${freshLabel}` });
});

const claude = (percent, sourceId, observedAt = now, resetsAt = reset) => ({
  source: "claude", plan: null, limitReached: false, observedAt, sourceId,
  windows: [win("week", percent, resetsAt)],
});
const observation = (sourceId, usedPercent, observedAt = now) => ({ sourceId, usedPercent, observedAt });
const mergedClaude = (usedPercent, sources, observedAt = now, resetsAt = reset) => ({
  source: "claude", plan: null, limitReached: false, observedAt,
  windows: [{ ...win("week", usedPercent, resetsAt), sources }],
});

test("Claude sources: fresh 6 percent replaces a 40-minute-old 89 percent", () => {
  const oldAt = now - 40 * 60000;
  const old = mergeUsageSnapshot(null, claude(89, "idle", oldAt), oldAt);
  const result = mergeUsageSnapshot(old, claude(6, "active"), now);
  assert.deepEqual(result, mergedClaude(6, [observation("active", 6)]));
});

test("Claude sources: two fresh sources use the maximum and each source can decrease", () => {
  const first = mergeUsageSnapshot(null, claude(30, "a"), now);
  const second = mergeUsageSnapshot(first, claude(35, "b"), now);
  assert.deepEqual(second, mergedClaude(35, [observation("a", 30), observation("b", 35)]));
  const next = mergeUsageSnapshot(second, claude(20, "b", now + 1000), now + 1000);
  assert.deepEqual(next, mergedClaude(30, [observation("a", 30), observation("b", 20, now + 1000)], now + 1000));
  // A delayed response from the same source must not replace its latest reading.
  assert.deepEqual(mergeUsageSnapshot(next, claude(99, "b"), now + 1000), next);
});

test("Claude sources: later reset wins outright and rejects an earlier reset", () => {
  const first = mergeUsageSnapshot(null, claude(89, "a"), now);
  const nextReset = reset + 86400000;
  const next = mergeUsageSnapshot(first, claude(2, "b", now, nextReset), now);
  assert.deepEqual(next, mergedClaude(2, [observation("b", 2)], now, nextReset));
  assert.deepEqual(mergeUsageSnapshot(next, claude(99, "a"), now), next);
  // This also holds when the later reset comes from the same source.
  assert.deepEqual(mergeUsageSnapshot(first, claude(2, "a", now, nextReset), now),
    mergedClaude(2, [observation("a", 2)], now, nextReset));
});

test("Claude sources: old-format snapshots load and expire at their original observedAt", t => {
  const root = fixture(t);
  const legacy = { ...snap([win("week", 89)]), source: "claude", plan: null, observedAt: now - 40 * 60000 };
  fs.writeFileSync(path.join(root, "usage-limits.json"), JSON.stringify({ "claude-cli": legacy }));
  assert.deepEqual(readUsageSnapshots(root), { "claude-cli": legacy });
  const result = mergeUsageSnapshot(readUsageSnapshots(root)["claude-cli"], claude(6, "active"), now);
  assert.deepEqual(result, mergedClaude(6, [observation("active", 6)]));
  recordUsageSnapshot(root, "claude-cli", result);
  assert.deepEqual(readUsageSnapshots(root), { "claude-cli": result });
  // A fresh legacy reading still competes as one anonymous source.
  const fresh = mergeUsageSnapshot({ ...legacy, observedAt: now }, claude(6, "active"), now);
  assert.equal(fresh.windows[0].usedPercent, 89);
  assert.equal(fresh.windows[0].sources.length, 2);
  const legacyId = fresh.windows[0].sources[0].sourceId;
  assert.equal(typeof legacyId, "string");
  assert.notEqual(legacyId, "active");
  assert.deepEqual(fresh, mergedClaude(89, [observation(legacyId, 89), observation("active", 6)]));
});

test("Claude sources: invalid persisted source metadata is rejected", t => {
  const root = fixture(t);
  for (const sources of [null, {}, [{ sourceId: "a", usedPercent: 89 }], [observation("a", -1)], [observation(1, 89)]]) {
    const snapshot = mergedClaude(89, sources);
    fs.writeFileSync(path.join(root, "usage-limits.json"), JSON.stringify({ "claude-cli": snapshot }));
    assert.deepEqual(readUsageSnapshots(root), {});
  }
});

test("Claude sources: anonymous readings remain separate and missing windows age independently", () => {
  const first = mergeUsageSnapshot(null, claude(35), now);
  const second = mergeUsageSnapshot(first, claude(30), now);
  const sources = second.windows[0].sources;
  assert.equal(sources.length, 2);
  assert.equal(typeof sources[0].sourceId, "string");
  assert.equal(typeof sources[1].sourceId, "string");
  assert.notEqual(sources[0].sourceId, sources[1].sourceId);
  assert.deepEqual(second, mergedClaude(35, [observation(sources[0].sourceId, 35), observation(sources[1].sourceId, 30)]));
  const partial = { ...claude(10, "a"), windows: [win("5h", 10, null, 300)] };
  const merged = mergeUsageSnapshot(second, partial, now);
  assert.deepEqual(merged, { ...second, windows: [...second.windows,
    { ...win("5h", 10, null, 300), sources: [observation("a", 10)] }] });
  const later = now + 31 * 60000;
  assert.deepEqual(mergeUsageSnapshot(merged, { ...partial, observedAt: later }, later), {
    ...merged, observedAt: later, windows: [{ ...win("5h", 10, null, 300), sources: [observation("a", 10, later)] }],
  });
});

test("Claude sources: display expires observations without a new merge and TTL is configurable", () => {
  const oldAt = now - 30 * 60000;
  const snapshot = mergedClaude(89, [observation("idle", 89, oldAt), observation("active", 6)]);
  assert.equal(usageStatus(snapshot, now).short, "89% wk");
  const label = new Date(reset).toLocaleString("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  assert.deepEqual(usageStatus(snapshot, now + 1), { level: "ok", text: `6% of week, resets ${label}`, short: "6% wk", resetsAt: null, ageMinutes: 0 });
  assert.deepEqual(usageStatus(snapshot, now + 31 * 60000), { level: "ok", text: "no live usage windows", short: null, resetsAt: null, ageMinutes: 31 });
  assert.equal(usageStatus(snapshot, now + 1, 60 * 60000).short, "89% wk");
  assert.deepEqual(mergeUsageSnapshot(snapshot, claude(6, "active"), now, 10 * 60000), mergedClaude(6, [observation("active", 6)]));
  assert.deepEqual(mergeUsageSnapshot(snapshot, claude(6, "active"), now, 60 * 60000), snapshot);
});


test("refresh regression: ANSI and box-drawing prefixes preserve captured usage", async () => {
  const { fetchOpenClawUsage } = await import("../lib/usage-limits.mjs");
  for (const stdout of [
    OPENCLAW_TEXT,
    `\x1b[32m${OPENCLAW_TEXT}\x1b[0m`,
    `│ ${OPENCLAW_TEXT} │`,
    "\x1b[32m│openai\x1b[0m usage: 168h \x1b[32m100%\x1b[0m left ⏱6d 10h│",
  ]) {
    const calls = [];
    const result = await fetchOpenClawUsage({ now, run: async (cmd, args) => {
      calls.push(args);
      return { ok: true, stdout };
    } });
    assert.deepEqual(result, { ok: true, snapshots: { openai: openclawSnapshot(now) }, error: null });
    assert.deepEqual(calls, [["models", "status"]]);
  }
});

test("refresh regression: failed commands cannot clear a hold using partial stdout", async (t) => {
  t.mock.method(Date, "now", () => now);
  const root = fixture(t);
  const stale = { ...snap([win("week", 100)]), observedAt: now - 149 * 60000 };
  writeSnapshot(root, stale);
  const calls = [];
  const rt = runtime(root, { usageRun: async (cmd, args) => {
    calls.push(args);
    return { ok: false, stdout: OPENCLAW_TEXT };
  } });
  const label = new Date(reset).toLocaleString("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  const result = await rt.admit([{ task: "t", agentName: "coder", subscription_worker: "coder", mode: "scout" }]);
  assert.deepEqual(result.problems, [hold(label, 149, " OpenClaw usage refresh failed.")]);
  assert.deepEqual(readUsageSnapshots(root), { openai: stale });
  assert.deepEqual(calls, [["models", "status"]]);
});

test("refresh regression: text command receives the timeout budget and empty usage fails", async () => {
  const { fetchOpenClawUsage } = await import("../lib/usage-limits.mjs");
  for (const stdout of [OPENCLAW_TEXT, '{"auth":{}}', "No usage available"]) {
    const calls = [];
    const result = await fetchOpenClawUsage({ now, timeoutMs: 100, run: async (cmd, args, options) => {
      calls.push([args, options]);
      return { ok: true, stdout };
    } });
    assert.deepEqual(result, stdout === OPENCLAW_TEXT
      ? { ok: true, snapshots: { openai: openclawSnapshot(now) }, error: null }
      : { ok: false, snapshots: {}, error: "OpenClaw usage refresh failed" });
    assert.deepEqual(calls, [[["models", "status"], { timeoutMs: 100 }]]);
  }
});

test("refresh regression: health reads and refreshes saved state without a supplied snapshot", async (t) => {
  const { runHealthChecks } = await import("../lib/health.mjs");
  const root = fixture(t);
  writeSnapshot(root, { ...snap([win("week", 100)]), observedAt: now - 149 * 60000 });
  const calls = [];
  const result = await runHealthChecks({ now, stateRoot: root, run: async (cmd, args) => {
    if (args[0] === "models" && args[1] === "status") {
      calls.push(args);
      return { ok: true, stdout: OPENCLAW_TEXT };
    }
    return { ok: false, stdout: "" };
  } });
  assert.deepEqual(result.issues.filter(issue => issue.id.startsWith("usage:")), []);
  assert.deepEqual(readUsageSnapshots(root), { openai: openclawSnapshot(now) });
  assert.deepEqual(calls, [["models", "status"]]);
});

test("refresh regression: persistence failure preserves the stale hold", async (t) => {
  const { refreshStaleOverLimitReadings } = await import("../lib/usage-limits.mjs");
  const root = fixture(t);
  const stateRoot = path.join(root, "not-a-directory");
  fs.writeFileSync(stateRoot, "occupied");
  const snapshots = { openai: { ...snap([win("week", 100)]), observedAt: now - 149 * 60000 } };
  assert.deepEqual(await refreshStaleOverLimitReadings(stateRoot, {
    now, snapshots, run: async () => ({ ok: true, stdout: OPENCLAW_TEXT }),
  }), { called: true, ok: false, snapshots, error: "OpenClaw usage refresh failed", failedProviders: ["openai"] });
});

test("refresh regression: a newer job observation wins over an in-flight refresh", async (t) => {
  const { refreshStaleOverLimitReadings } = await import("../lib/usage-limits.mjs");
  const root = fixture(t);
  writeSnapshot(root, { ...snap([win("week", 100)]), observedAt: now - 149 * 60000 });
  const newer = { ...snap([win("week", 100)]), observedAt: now + 1 };
  const result = await refreshStaleOverLimitReadings(root, { now, run: async () => {
    recordUsageSnapshot(root, "openai", newer);
    return { ok: true, stdout: OPENCLAW_TEXT };
  } });
  assert.deepEqual(result, { called: true, ok: true, snapshots: { openai: newer }, error: null, failedProviders: [] });
  assert.deepEqual(readUsageSnapshots(root), { openai: newer });
});

test("Claude sources: unchanged redraw still drops a reset window and all its observations", () => {
  const shortReset = now + 60000;
  const incoming = { ...claude(15, "active"), windows: [win("5h", 80, shortReset, 300), win()] };
  const first = mergeUsageSnapshot(null, incoming, now);
  const previous = mergeUsageSnapshot(first, { ...incoming, sourceId: "idle" }, now);
  assert.strictEqual(mergeUsageSnapshot(previous, { ...incoming, observedAt: now + 1000 }, now + 1000), previous);
  for (const later of [shortReset, shortReset + 1]) {
    const expected = mergedClaude(15, [observation("active", 15), observation("idle", 15)], later);
    // Check both an omitted window and an incoming stale copy of the reset window.
    for (const windows of [[win()], incoming.windows]) {
      const result = mergeUsageSnapshot(previous, { ...incoming, windows, observedAt: later }, later);
      assert.deepEqual(result, expected);
      assert.deepEqual(result.windows.map(w => w.name), ["week"]);
    }
  }
});
