import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { saveJevKey, removeJev, jevSettings, loadValidators, askJev, JEV_ENDPOINT, jevBreaker, resetJevBreaker } from "../lib/validators.mjs";
import { checkScoutCitations, checkReportClaims, FLAG_AT } from "../lib/jev-checks.mjs";

function configDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-jev-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("saveJevKey keeps the key out of validators.yml, in a file only this user can read", (t) => {
  const dir = configDir(t);
  const { keyFile, configPath } = saveJevKey("  ts-secret-key  ", { configDir: dir });
  assert.equal(fs.readFileSync(keyFile, "utf8"), "ts-secret-key\n");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600, "Unix mode bits keep the key private");
    assert.equal(fs.statSync(path.dirname(keyFile)).mode & 0o777, 0o700, "Unix mode bits keep the directory private");
  }
  assert.equal(fs.readFileSync(configPath, "utf8").includes("ts-secret-key"), false, "the key is never in the config");
  assert.deepEqual(loadValidators(dir).jev.checks, ["scout-citations", "report-claims"]);
  assert.equal(jevSettings({ configDir: dir }).key, "ts-secret-key");
  assert.throws(() => saveJevKey("has spaces in it", { configDir: dir }), /doesn't look like an API key/);
  removeJev({ configDir: dir });
  assert.equal(fs.existsSync(keyFile), false);
  assert.equal(jevSettings({ configDir: dir }), null);
});

test("jevSettings reads key_env from the environment, and is null when disabled, keyless or invalid", (t) => {
  const dir = configDir(t);
  fs.writeFileSync(path.join(dir, "validators.yml"), "jev:\n  key_env: TYPESAFE_API_KEY\n");
  assert.equal(jevSettings({ configDir: dir, env: {} }), null);
  assert.equal(jevSettings({ configDir: dir, env: { TYPESAFE_API_KEY: "k" } }).key, "k");
  fs.writeFileSync(path.join(dir, "validators.yml"), "jev:\n  enabled: false\n  key_env: TYPESAFE_API_KEY\n");
  assert.equal(jevSettings({ configDir: dir, env: { TYPESAFE_API_KEY: "k" } }), null);
  fs.writeFileSync(path.join(dir, "validators.yml"), "jev:\n  key: the-actual-secret\n");
  assert.throws(() => loadValidators(dir), /unexpected|Unrecognized|needs key_file or key_env/i);
  assert.equal(jevSettings({ configDir: dir }), null);
});

test("askJev posts the documented shape with a Bearer key, retries once on 429, and names a rejected key", async () => {
  const seen = [];
  let calls = 0;
  const fetchFn = async (url, init) => {
    seen.push({ url, init });
    calls++;
    if (calls === 1) return { ok: false, status: 429 };
    return { ok: true, status: 200, json: async () => ({ model: "jev-1.13.0", answers: { q: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 42 } }) };
  };
  const r = await askJev({ key: "k", state: { a: 1 }, questions: { q: { type: "noul", instructions: "x?" } }, fetchFn });
  assert.equal(r.answers.q.noul, 0.9);
  assert.equal(r.usage.input_tokens, 42);
  assert.equal(seen[1].url, JEV_ENDPOINT);
  assert.equal(seen[1].init.headers.Authorization, "Bearer k");
  assert.deepEqual(JSON.parse(seen[1].init.body), { model: "jev-latest", state: { a: 1 }, questions: { q: { type: "noul", instructions: "x?" } } });
  await assert.rejects(askJev({ key: "bad", state: {}, questions: {}, fetchFn: async () => ({ ok: false, status: 401 }) }), /API key was rejected/);
});

const settings = { key: "k", model: "jev-latest" };

test.beforeEach(() => resetJevBreaker());

test("checkScoutCitations flags only a confident non-support, and only findings with cited lines", async () => {
  const findings = [
    { text: "retries are capped at 3", citations: [{ status: "ok", path: "a.js", start: 1, end: 2, excerpt: [{ line: 1, text: "const MAX_RETRIES = 3;" }] }] },
    { text: "the cache is per user", citations: [{ status: "ok", path: "b.js", start: 5, end: 5, excerpt: [{ line: 5, text: "log('hi')" }] }] },
    { text: "timeouts are 30s", citations: [{ status: "ok", path: "c.js", start: 9, end: 9, excerpt: [{ line: 9, text: "timeout: 30000" }] }] },
    { text: "no citation", citations: [{ status: "missing", path: "d.js" }] },
  ];
  const replies = { "retries are capped at 3": ["supports", 0.95], "the cache is per user": ["unrelated", 0.88], "timeouts are 30s": ["contradicts", FLAG_AT - 0.1] };
  const asked = [];
  const ask = async ({ state, questions }) => {
    asked.push(state);
    assert.deepEqual(Object.keys(questions), ["support"]);
    const [choice, p] = replies[state.finding];
    return { answers: { support: { choice, probabilities: { [choice]: p } } }, usage: { input_tokens: 50 } };
  };
  const r = await checkScoutCitations({ findings, settings, ask });
  assert.equal(asked.length, 3, "the finding without verified lines isn't sent");
  assert.equal(asked[1].cited[0].text, "5: log('hi')");
  assert.deepEqual(r.flags, [{ index: 1, verdict: "unrelated", probability: 0.88 }]);
  assert.equal(r.usage, 150);
});

test("checkReportClaims flags a confident contradiction, frames the diff, and skips what it can't judge", async () => {
  let state;
  const ask = async (req) => { state = req.state; return { answers: { claims: { choice: "contradicts", probabilities: { contradicts: 0.91 } } }, usage: { input_tokens: 300 } }; };
  const report = { status: "done", tests: "pass", note: "restored check.js to base commit", notDone: "none" };
  const r = await checkReportClaims({ report, diff: "diff --git a/check.js b/check.js\n-exit(1)\n+exit(0)\n", settings, ask });
  assert.deepEqual(r.flag, { verdict: "contradicts", probability: 0.91 });
  assert.equal(state.report.note, "restored check.js to base commit", "NOT_DONE: none adds nothing");
  const unsure = await checkReportClaims({ report, diff: "x", settings, ask: async () => ({ answers: { claims: { choice: "unclear", probabilities: { unclear: 0.95 } } } }) });
  assert.equal(unsure.flag, null);
  assert.equal((await checkReportClaims({ report: { note: "" }, diff: "x", settings, ask })).verdict, null, "no note: nothing to check");
  const long = await checkReportClaims({ report, diff: "+".repeat(70000), settings, ask });
  assert.equal(long.truncated, true);
  const failed = await checkReportClaims({ report, diff: "x", settings, ask: async () => { throw new Error("TypeSafe answered 529"); } });
  assert.equal(failed.flag, null);
  assert.equal(failed.error, "TypeSafe answered 529");
});

test("a Jev outage never stalls nomArmy: one failure stops the job's checks and every job skips Jev for a while", async () => {
  const findings = Array.from({ length: 10 }, (_, i) => ({ text: `claim ${i}`, citations: [{ status: "ok", path: "a.js", start: 1, end: 1, excerpt: [{ line: 1, text: "x" }] }] }));
  let calls = 0;
  const down = async () => { calls++; const e = new Error("aborted"); e.name = "AbortError"; throw e; };
  const r = await checkScoutCitations({ findings, settings, ask: down });
  assert.ok(calls <= 4, `at most one round of requests, got ${calls}`);
  assert.deepEqual(r.flags, []);
  assert.match(r.errors[0], /timed out/);
  assert.equal(jevBreaker().open, true);
  // The next job doesn't even try.
  let later = 0;
  const next = await checkReportClaims({ report: { status: "done", note: "did the thing" }, diff: "d", settings, ask: async () => { later++; return {}; } });
  assert.equal(later, 0);
  assert.match(next.error, /skipped: Jev failed recently \(timed out\)/);
  assert.equal(next.flag, null);
});
