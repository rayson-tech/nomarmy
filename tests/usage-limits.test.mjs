import "./helpers/isolate-global-config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readCodexRateLimits, normalizeClaudeRateLimits, recordUsageSnapshot, readUsageSnapshots, usageStatus } from "../lib/usage-limits.mjs";
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

function runtime(root) {
  const budgets = deriveBudgets({ env: {} });
  return createJobRuntime({ env: { NOMARMY_EXECUTION: "hosted" }, projectDir: root, projectDirProblem: () => null, stateRoot: root, jobsRoot: path.join(root, "jobs"),
    leasesRoot: path.join(root, "leases"), slotsRoot: path.join(root, "slots"),
    budgetState: { hardwareSnapshot: null, contextInfo: { slots: 3 }, budgets, refresh: async () => {} },
    currentMaxWorkers: () => 2, budgetsForJob: () => budgets, subscriptionJobFieldProblems: () => [], repoPolicy: () => ({}), modelCatalogReady: async () => {},
    agentsConfig: () => ({ agents: { coder: { kind: "subscription", provider: "openai" } } }),
  });
}

test("admission holds over-limit jobs, allows confirmation and high usage; capacity shows provider status", async t => {
  t.mock.method(Date, "now", () => now);
  const root = fixture(t), rt = runtime(root), job = { task: "t", agentName: "coder", subscription_worker: "coder", mode: "scout" };
  recordUsageSnapshot(root, "openai", snap([win("week", 100)]));
  assert.deepEqual(jobSchema.parse({ task: "t", confirm_over_limit: true }), { task: "t", mode: "implement", timeout_seconds: 600, reasoning: "medium", confirm_over_limit: true });
  assert.equal(jobSchema.safeParse({ task: "t", confirm_over_limit: "true" }).success, false);
  const expanded = expandJobs([{ task: "t", confirm_over_limit: true }], { getActiveRun: () => null, env: {} });
  assert.deepEqual(expanded, { jobs: [{ task: "t", confirm_over_limit: true, profile: "coder" }], problems: [] });
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

test("mergeUsageSnapshot: an idle window's stale, lower reading never replaces a newer one", async () => {
  const { mergeUsageSnapshot } = await import("../lib/usage-limits.mjs");
  const now = Date.parse("2026-09-25T06:00:00Z"), week = now + 86400000, fiveHour = now + 3600000;
  const w = (name, usedPercent, resetsAt) => ({ name, usedPercent, windowMinutes: null, resetsAt });
  const s = (windows, observedAt = now) => ({ source: "claude", plan: null, limitReached: false, observedAt, windows });
  const fresh = s([w("5h", 55, fiveHour), w("week", 93, week)]);
  // Seen live: an idle window reporting 45%/92%, and another only 81% of the week.
  assert.equal(mergeUsageSnapshot(fresh, s([w("5h", 45, fiveHour), w("week", 92, week)]), now), fresh);
  assert.equal(mergeUsageSnapshot(fresh, s([w("week", 81, week)]), now), fresh);
  // A higher figure at the same reset, or a later reset, is taken.
  const up = mergeUsageSnapshot(fresh, s([w("week", 94, week)]), now + 1000);
  assert.deepEqual(up.windows.map((x) => [x.name, x.usedPercent]), [["5h", 55], ["week", 94]]);
  assert.equal(up.observedAt, now + 1000);
  const reset = mergeUsageSnapshot(fresh, s([w("5h", 3, fiveHour + 18000000)]), now);
  assert.deepEqual(reset.windows.find((x) => x.name === "5h").usedPercent, 3);
  // A stored window that has reset is dropped even if the reading lacks it.
  const later = mergeUsageSnapshot(fresh, s([w("week", 93, week)]), fiveHour + 1);
  assert.deepEqual(later.windows.map((x) => x.name), ["week"]);
  assert.equal(mergeUsageSnapshot(null, fresh, now), fresh);
});
