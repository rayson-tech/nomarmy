import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { autoUpdateDue, autoUpdateIssues, openclawAutoEnabled, outcomeOf, readAutoUpdateState, runAutoUpdate, setOpenclawAuto, takeUpdateLock, updateInProgress, updateInProgressProblem, AUTO_UPDATE_INTERVAL_MS, LOCK_STALE_MS } from "../lib/openclaw-auto-update.mjs";
import { writeLease } from "../lib/slots.mjs";
import { createJobRuntime } from "../lib/admission.mjs";
import { deriveBudgets } from "../lib/budget.mjs";

const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-autoupd-")); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const NOW = Date.parse("2026-11-27T12:00:00Z");
const alive = () => true;

test("openclaw_auto: on unless set off, kept beside the other limits", (t) => {
  const filePath = path.join(tmp(t), "limits.yml");
  assert.equal(openclawAutoEnabled({ filePath }), true);
  fs.writeFileSync(filePath, "# keep me\nopenclaw: latest\n");
  assert.equal(openclawAutoEnabled({ filePath }), true);
  setOpenclawAuto(false, { filePath });
  assert.equal(fs.readFileSync(filePath, "utf8"), "# keep me\nopenclaw: latest\nopenclaw_auto: false\n");
  assert.equal(openclawAutoEnabled({ filePath }), false);
  setOpenclawAuto(true, { filePath });
  assert.equal(openclawAutoEnabled({ filePath }), true);
});

test("autoUpdateDue: once a day, on latest, when enabled", () => {
  const day = AUTO_UPDATE_INTERVAL_MS;
  assert.equal(autoUpdateDue({ channel: "latest", enabled: true, state: {}, now: NOW }), true);
  assert.equal(autoUpdateDue({ channel: "latest", enabled: true, state: { lastAttempt: new Date(NOW - day + 60000).toISOString() }, now: NOW }), false);
  assert.equal(autoUpdateDue({ channel: "latest", enabled: true, state: { lastAttempt: new Date(NOW - day).toISOString() }, now: NOW }), true);
  assert.equal(autoUpdateDue({ channel: "tested", enabled: true, state: {}, now: NOW }), false);
  assert.equal(autoUpdateDue({ channel: "latest", enabled: false, state: {}, now: NOW }), false);
});

test("the update lock: one holder; a dead or stale holder's lock is cleared", (t) => {
  const root = tmp(t);
  const release = takeUpdateLock(root, { now: NOW, pid: 111, alive });
  assert.ok(release);
  assert.equal(takeUpdateLock(root, { now: NOW, alive }), null);
  assert.equal(updateInProgress(root, { now: NOW, alive }).pid, 111);
  assert.match(updateInProgressProblem(root, { now: NOW + 3 * 60000, alive }), /^OpenClaw is updating \(started 3 minutes ago;.*nothing was started\.$/);
  assert.equal(updateInProgress(root, { now: NOW, alive: () => false }), null, "dead holder");
  assert.ok(takeUpdateLock(root, { now: NOW, pid: 222, alive }));
  assert.equal(updateInProgress(root, { now: NOW + LOCK_STALE_MS + 1, alive }), null, "held too long");
  assert.equal(updateInProgressProblem(root, { now: NOW, alive }), null);
  release();
});

test("outcomeOf: a rollback is a broken model only when one broke; part-way failures are failures", () => {
  assert.equal(outcomeOf({ ok: true, changed: [] }), "current");
  assert.equal(outcomeOf({ ok: true, changed: ["Upgrade OpenClaw to 2026.11.10"] }), "upgraded");
  assert.equal(outcomeOf({ ok: false, rolledBack: true, broke: [{ model: "openai/gpt-6-astra" }] }), "rolled-back");
  assert.equal(outcomeOf({ ok: false, rolledBack: true, changed: ["Upgrade OpenClaw to 2026.11.10"] }), "failed");
  assert.equal(outcomeOf({ ok: false, keptNewer: true, broke: [{ model: "x/y" }] }), "kept-newer");
  assert.equal(outcomeOf({ ok: false, declined: true, changed: [] }), "failed");
});

test("runAutoUpdate: skips when not due or jobs run, waits out a lease race, records the outcome, and frees the lock", async (t) => {
  const root = tmp(t), leases = path.join(root, "leases");
  let upgrades = 0, clock = NOW;
  const base = { stateRoot: root, leasesDir: leases, channel: "latest", enabled: true, now: () => clock, sleep: async () => {}, alive };
  const upgrade = async () => { upgrades++; return { ok: false, rolledBack: true, previous: "2026.11.3", target: "2026.11.10", changed: ["Upgrade OpenClaw to 2026.11.10"], broke: [{ model: "openai/gpt-6-astra", reason: "401" }] }; };

  writeLease(leases, "job-1", { lane: "remote" });
  assert.deepEqual(await runAutoUpdate({ ...base, upgrade }), { ran: false, skipped: "jobs running" });
  fs.rmSync(leases, { recursive: true });
  // A job got its lease while the updater waited.
  assert.deepEqual(await runAutoUpdate({ ...base, upgrade, sleep: async () => writeLease(leases, "job-2", { lane: "remote" }) }), { ran: false, skipped: "jobs running" });
  assert.equal(updateInProgress(root, { alive }), null, "lock released after backing off");
  fs.rmSync(leases, { recursive: true });
  assert.equal(upgrades, 0);
  assert.deepEqual(readAutoUpdateState(root), {}, "a skip isn't an attempt, so the next check tries again");

  // While it runs, admission sees the lock.
  let sawLock = null;
  const watching = async () => { sawLock = updateInProgressProblem(root, { now: clock, alive }); return upgrade(); };
  assert.deepEqual(await runAutoUpdate({ ...base, upgrade: watching }), { ran: true, outcome: "rolled-back" });
  assert.match(sawLock, /^OpenClaw is updating/);
  assert.equal(updateInProgress(root, { alive }), null);
  const state = readAutoUpdateState(root);
  assert.equal(state.lastAttempt, new Date(NOW).toISOString());
  assert.deepEqual(state.result, { at: new Date(NOW).toISOString(), outcome: "rolled-back", from: "2026.11.3", to: "2026.11.10", broke: [{ model: "openai/gpt-6-astra", reason: "401" }], fixed: [], failed: null, restored: true });

  clock = NOW + 3600000;
  assert.deepEqual(await runAutoUpdate({ ...base, upgrade }), { ran: false, skipped: "not due" });
  assert.deepEqual(await runAutoUpdate({ ...base, upgrade: async () => ({ ok: true, changed: [] }), force: true }), { ran: true, outcome: "current" });
  // An upgrade that throws is recorded as a failure, never rethrown.
  assert.deepEqual(await runAutoUpdate({ ...base, upgrade: async () => { throw new Error("npm exploded"); }, force: true }), { ran: true, outcome: "failed" });
  assert.equal(readAutoUpdateState(root).result.failed, "npm exploded");
  // Another update holds the lock.
  const held = takeUpdateLock(root, { pid: 999, alive });
  assert.deepEqual(await runAutoUpdate({ ...base, upgrade, force: true }), { ran: false, skipped: "another update is running" });
  held();
});

test("autoUpdateIssues: says something only for a rollback, a failure, or a kept newer release", () => {
  const log = "/state/openclaw-auto-update.log";
  const result = (r) => autoUpdateIssues({ result: { from: "2026.11.3", to: "2026.11.10", broke: [], ...r } }, { logPath: log });
  assert.deepEqual(autoUpdateIssues({}), []);
  assert.deepEqual(result({ outcome: "upgraded" }), []);
  assert.deepEqual(result({ outcome: "current" }), []);
  const [rolled] = result({ outcome: "rolled-back", broke: [{ model: "openai/gpt-6-astra" }] });
  assert.equal(rolled.severity, "info");
  assert.equal(rolled.title, "OpenClaw 2026.11.10 broke openai/gpt-6-astra; nomArmy rolled back to 2026.11.3");
  const [failed] = result({ outcome: "failed", failed: "Update OpenClaw plugin codex 2026.11.3 to 2026.11.10", restored: true });
  assert.equal(failed.severity, "warn");
  assert.equal(failed.detail, `It stopped at: Update OpenClaw plugin codex 2026.11.3 to 2026.11.10. OpenClaw and its plugins were put back to 2026.11.3. Its log: ${log}.`);
  const [kept] = result({ outcome: "kept-newer", broke: [{ model: "x/y" }] });
  assert.match(kept.fix, /^nomarmy army assign/);
});

test("admission refuses model jobs while OpenClaw updates; verification runs aren't held", async (t) => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".autoupd-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const budgets = deriveBudgets({ env: {} });
  let updating = "OpenClaw is updating (started 1 minute ago).";
  const runtime = createJobRuntime({ env: { NOMARMY_EXECUTION: "hosted" }, projectDir: root, stateRoot: root, jobsRoot: root, leasesRoot: path.join(root, "leases"),
    budgetState: { hardwareSnapshot: null, contextInfo: { slots: 1 }, budgets, refresh: async () => {} },
    currentMaxWorkers: () => 1, budgetsForJob: () => budgets, subscriptionJobFieldProblems: () => [], repoPolicy: () => ({}), modelCatalogReady: async () => {},
    agentsConfig: () => ({ agents: {} }), projectDirProblem: () => null, sandboxProblem: () => null, openclawUpdatingProblem: () => updating });
  assert.ok((await runtime.admit([{ task: "t", mode: "scout" }])).problems.includes(updating));
  assert.equal((await runtime.admit([{ task: "t", mode: "verify" }])).problems.includes(updating), false);
  updating = null;
  assert.deepEqual((await runtime.admit([{ task: "t", mode: "scout" }])).problems, []);
});
