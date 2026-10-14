import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openclawChannel, setOpenclawChannel, resolveOpenclawTarget, modelsToCheck, upgradeOpenclaw, skippedReleases } from "../lib/openclaw-channel.mjs";
import { PINNED_OPENCLAW_VERSION } from "../lib/openclaw-pin.mjs";

const tmp = (t) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-channel-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const NEWER = "2099.1.1";

test("openclaw channel: defaults to tested, is set in limits.yml beside max_jobs, and refuses anything else", (t) => {
  const filePath = path.join(tmp(t), "limits.yml");
  assert.equal(openclawChannel({ filePath }), "tested");
  fs.writeFileSync(filePath, "# keep me\nmax_jobs: 8\n");
  assert.equal(setOpenclawChannel("latest", { filePath }), "latest");
  assert.equal(openclawChannel({ filePath }), "latest");
  assert.equal(fs.readFileSync(filePath, "utf8"), "# keep me\nmax_jobs: 8\nopenclaw: latest\n");
  assert.throws(() => setOpenclawChannel("nightly", { filePath }), /openclaw must be tested or latest/);
  fs.writeFileSync(filePath, "openclaw: nightly\n");
  assert.equal(openclawChannel({ filePath }), "tested");
});

test("resolveOpenclawTarget: the pin for tested; npm's latest, never below the pin, and never a rolled-back release", () => {
  const npm = (stdout, ok = true) => () => ({ ok, stdout, stderr: "" });
  assert.deepEqual(resolveOpenclawTarget("tested", { run: () => assert.fail("tested never asks npm") }), { target: PINNED_OPENCLAW_VERSION, note: null });
  assert.deepEqual(resolveOpenclawTarget("latest", { run: npm(`${NEWER}\n`) }), { target: NEWER, note: null });
  assert.equal(resolveOpenclawTarget("latest", { run: npm("2020.1.1\n") }).target, PINNED_OPENCLAW_VERSION);
  assert.match(resolveOpenclawTarget("latest", { run: npm("", false) }).note, /couldn't read npm's latest OpenClaw/);
  const skipped = resolveOpenclawTarget("latest", { run: npm(NEWER), skipped: [NEWER], installed: "2098.1.1" });
  assert.equal(skipped.target, "2098.1.1");
  assert.match(skipped.note, /broke a model here and was rolled back/);
});

test("modelsToCheck: role and default models on api and subscription agents; never auto or the local model", () => {
  const agents = { codex: { kind: "subscription", provider: "openai", model: "gpt-6-astra" }, muse: { kind: "subscription", provider: "meta" }, local: { kind: "local" } };
  const roles = { "sr-dev": { agent: "codex", model: "gpt-6.1-sol" }, ui: { agent: "codex", model: "auto", modelIsAuto: true }, data: { agent: "muse", model: "muse-spark-1.3" }, jr: { agent: "local", model: "x" } };
  assert.deepEqual(modelsToCheck({ agents, roles, providerOf: (a) => a.provider }), ["meta/muse-spark-1.3", "openai/gpt-6-astra", "openai/gpt-6.1-sol"]);
});

function fakeUpgrade(t, { channel = "latest", broken = [], failedBefore = [] } = {}) {
  const repairs = [], probes = [], printed = [];
  let installed = PINNED_OPENCLAW_VERSION;
  const run = (command, args) => command === "npm" ? { ok: true, stdout: NEWER } : args[0] === "--version" ? { ok: true, stdout: `OpenClaw ${installed} (abc)` } : { ok: false, stdout: "", stderr: "" };
  const repair = async (opts) => { repairs.push({ target: opts.target, exact: opts.exact ?? false, yes: opts.yes }); installed = opts.target; return { ok: true, changed: [`to ${opts.target}`], checks: [] }; };
  const probe = async ({ provider, model }) => {
    const id = `${provider}/${model}`; probes.push([installed, id]);
    const bad = installed === NEWER ? broken.includes(id) : failedBefore.includes(id);
    return { ok: !bad, refused: bad, reason: bad ? "model_not_found" : null };
  };
  const skipFile = path.join(tmp(t), "skipped.json");
  return { repairs, probes, printed, skipFile, go: () => upgradeOpenclaw({ channel, run, repair, probe, skipFile, models: ["meta/muse-spark-1.3", "openai/gpt-6.1-sol"], print: (line) => printed.push(line), yes: true }) };
}

test("upgradeOpenclaw latest: checks the models before and after, and keeps a release that breaks none", async (t) => {
  const f = fakeUpgrade(t);
  const result = await f.go();
  assert.equal(result.ok, true);
  assert.deepEqual(f.repairs, [{ target: NEWER, exact: false, yes: true }]);
  assert.deepEqual(f.probes.map(([v]) => v), [PINNED_OPENCLAW_VERSION, PINNED_OPENCLAW_VERSION, NEWER, NEWER]);
  assert.deepEqual(skippedReleases(f.skipFile), []);
});

test("upgradeOpenclaw latest: a model that answered before and fails after rolls back exactly, and the release is skipped", async (t) => {
  const f = fakeUpgrade(t, { broken: ["meta/muse-spark-1.3"] });
  const result = await f.go();
  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, true);
  assert.deepEqual(result.broke, [{ model: "meta/muse-spark-1.3", reason: "model_not_found" }]);
  assert.deepEqual(f.repairs, [{ target: NEWER, exact: false, yes: true }, { target: PINNED_OPENCLAW_VERSION, exact: true, yes: true }]);
  assert.deepEqual(skippedReleases(f.skipFile), [NEWER]);
  assert.ok(f.printed.some((line) => line.includes(`Rolled back to OpenClaw ${PINNED_OPENCLAW_VERSION}`)));
});

test("upgradeOpenclaw: a model that already failed before isn't the upgrade's fault, and tested never probes", async (t) => {
  const f = fakeUpgrade(t, { broken: ["meta/muse-spark-1.3"], failedBefore: ["meta/muse-spark-1.3"] });
  const result = await f.go();
  assert.equal(result.ok, true);
  assert.deepEqual(f.probes.filter(([v]) => v === NEWER).map(([, id]) => id), ["openai/gpt-6.1-sol"]);
  const tested = fakeUpgrade(t, { channel: "tested" });
  await tested.go();
  assert.deepEqual(tested.probes, []);
  assert.deepEqual(tested.repairs, [{ target: PINNED_OPENCLAW_VERSION, exact: false, yes: true }]);
});
