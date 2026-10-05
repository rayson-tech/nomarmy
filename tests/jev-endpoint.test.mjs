import "./helpers/isolate-global-config.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import test from "node:test";
import * as validators from "../lib/validators.mjs";
import * as health from "../lib/health.mjs";
import { checkScoutCitations, checkReportClaims } from "../lib/jev-checks.mjs";
import { judgeTrust } from "../lib/trust-judgment.mjs";

const checks = ["scout-citations", "report-claims"];
function fixture(t) {
  const dir = fs.mkdtempSync(path.resolve(".jev-endpoint-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "local-only.mjs"), `
const realFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  if (new URL(url).hostname !== "127.0.0.1") throw new Error("Fixture forbids non-local requests");
  return realFetch(url, options);
};
`);
  return dir;
}
function config(dir, entry) {
  fs.writeFileSync(path.join(dir, "validators.yml"), JSON.stringify({ jev: entry }));
}
async function server(t, handler) {
  const instance = http.createServer(handler);
  await new Promise((resolve, reject) => { instance.once("error", reject); instance.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise(resolve => { instance.close(resolve); instance.closeAllConnections(); }));
  return { instance, endpoint: `http://127.0.0.1:${instance.address().port}/v1/systemone` };
}
function cli(dir, args, { input = "", env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", path.join(dir, "local-only.mjs"), path.resolve("bin/nomarmy.mjs"), "validators", ...args], {
      cwd: dir, env: { ...process.env, NOMARMY_CONFIG_DIR: dir, NOMARMY_AGENT_STATE: path.join(dir, "state"), NO_COLOR: "1", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}
const response = { answers: { passed: { noul: 1 } }, usage: { input_tokens: 2 }, model: "local-model" };
function reply(res, body = response) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); }

test("endpoint config normalizes allowed URLs and keeps keys optional only on exact loopback hosts", t => {
  const dir = fixture(t);
  for (const [input, endpoint, local] of [
    ["http://127.0.0.1:8000", "http://127.0.0.1:8000/v1/systemone", true],
    ["http://[::1]:8001/", "http://[::1]:8001/v1/systemone", true],
    ["http://localhost:9000/prefix", "http://localhost:9000/prefix/v1/systemone", true],
    ["https://localhost/v1/systemone", "https://localhost/v1/systemone", true],
    ["https://judge.example/prefix/v1/systemone", "https://judge.example/prefix/v1/systemone", false],
    ["https://judge.example/", "https://judge.example/v1/systemone", false],
  ]) {
    config(dir, { endpoint: input, ...(local ? {} : { key_env: "FIXTURE_KEY" }) });
    assert.deepEqual(validators.loadValidators(dir), { jev: { enabled: true, endpoint, ...(local ? {} : { key_env: "FIXTURE_KEY" }), model: "jev-latest", checks } });
    assert.deepEqual(validators.jevSettings({ configDir: dir, env: { FIXTURE_KEY: "fixture" } }),
      { enabled: true, endpoint, local, ...(local ? {} : { key_env: "FIXTURE_KEY" }), model: "jev-latest", checks, key: local ? null : "fixture" });
  }
  config(dir, { key_env: "FIXTURE_KEY" });
  assert.deepEqual(validators.jevSettings({ configDir: dir, env: { FIXTURE_KEY: "fixture" } }),
    { enabled: true, key_env: "FIXTURE_KEY", model: "jev-latest", checks, endpoint: validators.JEV_ENDPOINT, local: false, key: "fixture" });
  for (const endpoint of ["https://judge.example", validators.JEV_ENDPOINT]) {
    config(dir, { endpoint });
    assert.throws(() => validators.loadValidators(dir), /needs key_file or key_env for a non-local endpoint/);
  }
  config(dir, { endpoint: "http://localhost", key_env: "MISSING" });
  assert.equal(validators.jevSettings({ configDir: dir, env: {} }), null);
});

test("endpoint config rejects unsafe and malformed destinations with a clear endpoint error", t => {
  const dir = fixture(t);
  for (const endpoint of ["http://example.com", "http://192.168.1.1", "http://127.1", "http://2130706433", "http://0x7f000001",
    "http://localhost.evil", "http://localhost.", "http://[::ffff:127.0.0.1]", "file:///v1/systemone", "ftp://localhost",
    "not a URL", "https://", "https:example.com", "http://localhost:99999", "http://user:secret@localhost",
    "https://@localhost", "https://judge.example?q=x", "http://localhost/#x", "http://localhost\\@evil", " http://localhost"]) {
    config(dir, { endpoint, key_env: "FIXTURE_KEY" });
    assert.throws(() => validators.loadValidators(dir), /Jev endpoint must be an https:\/\/ URL/, endpoint);
  }
});

test("client posts to configured endpoint with exact optional auth headers and blocks redirects", async () => {
  for (const key of [undefined, "fixture"]) {
    const requests = [];
    const result = await validators.askJev({ endpoint: "http://localhost:9000/base", key, model: "local-model", state: { code: "x" }, questions: { q: { type: "noul" } },
      fetchFn: async (url, init) => { requests.push({ url, init }); return { ok: true, json: async () => response }; } });
    assert.deepEqual(result, response);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "http://localhost:9000/base/v1/systemone");
    const { signal, ...init } = requests[0].init;
    assert.equal(signal instanceof AbortSignal, true);
    assert.deepEqual(init, { method: "POST", redirect: "error", headers: { ...(key ? { Authorization: "Bearer fixture" } : {}), "Content-Type": "application/json" },
      body: JSON.stringify({ model: "local-model", state: { code: "x" }, questions: { q: { type: "noul" } } }) });
  }
  let calls = 0;
  await assert.rejects(validators.askJev({ endpoint: "http://example.com", key: "fixture", fetchFn: async () => { calls++; } }), /Jev endpoint/);
  await assert.rejects(validators.askJev({ endpoint: "https://example.com", fetchFn: async () => { calls++; } }), /needs a key/);
  assert.equal(calls, 0);
});

test("real local System One server receives configured route and keyless or bearer requests", async t => {
  const requests = [];
  const { endpoint } = await server(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization ?? null, body: JSON.parse(body) });
    reply(res);
  });
  for (const key of [undefined, "fixture"]) {
    assert.deepEqual(await validators.askJev({ endpoint, key, model: "local-model", state: { text: "test" }, questions: { passed: { type: "noul" } }, fetchFn: (url, options) => { assert.equal(url, endpoint); return fetch(url, options); } }), response);
  }
  assert.deepEqual(requests, [null, "Bearer fixture"].map(authorization => ({ method: "POST", url: "/v1/systemone", authorization,
    body: { model: "local-model", state: { text: "test" }, questions: { passed: { type: "noul" } } } })));
});

test("all job checks forward the local endpoint without changing verdict semantics", async () => {
  validators.resetJevBreaker();
  const settings = { endpoint: "http://localhost:8000/v1/systemone", model: "local-model", key: null };
  const seen = [];
  const ask = async request => {
    seen.push(request.endpoint);
    return { answers: { support: { choice: "contradicts", probabilities: { contradicts: 0.9 } },
      claims: { choice: "contradicts", probabilities: { contradicts: 0.9 } },
      access: { probabilities: { yes: 0.1 } }, checks: { probabilities: { yes: 0.2 } }, data: { probabilities: { yes: 0.3 } } } };
  };
  assert.deepEqual(await checkScoutCitations({ settings, ask, findings: [{ text: "claim", citations: [{ status: "ok", path: "x", start: 1, end: 1, excerpt: [{ line: 1, text: "x" }] }] }] }),
    { flags: [{ index: 0, verdict: "contradicts", probability: 0.9 }], checked: 1, errors: [], usage: 0, verdicts: [{ index: 0, verdict: "contradicts", probability: 0.9 }] });
  assert.deepEqual(await checkReportClaims({ settings, ask, report: { note: "claim" }, diff: "x" }),
    { flag: { verdict: "contradicts", probability: 0.9 }, verdict: { verdict: "contradicts", probability: 0.9 }, error: null, usage: 0, truncated: false });
  assert.deepEqual(await judgeTrust({ jev: settings, askJev: ask, evidence: "x" }),
    { status: "available", validator: "jev", answers: { access: 0.1, checks: 0.2, data: 0.3 }, error: null });
  assert.deepEqual(seen, Array(3).fill(settings.endpoint));
});

test("unreachable local endpoint warns in health and returns unavailable for jobs", async t => {
  const dir = fixture(t);
  const { endpoint, instance } = await server(t, (_req, res) => reply(res));
  await new Promise(resolve => instance.close(resolve));
  config(dir, { endpoint });
  const settings = validators.jevSettings({ configDir: dir });
  assert.equal(settings?.endpoint, endpoint);
  const port = new URL(endpoint).port;
  const issue = { id: `validator:local:${endpoint}`, severity: "warn", title: `Local Jev endpoint is unavailable: ${endpoint}`,
    detail: "Jev checks and trust judgments will be unavailable, never a pass.",
    fix: `Start your System One server at ${endpoint}; for Kev: python -m kev.serve --port ${port}`, short: "local Jev unavailable" };
  assert.deepEqual(await health.localValidatorIssues({ configDir: dir }), [issue]);
  const result = await health.runHealthChecks({ configDir: dir, run: async () => ({ ok: false, stdout: "", stderr: "" }) });
  assert.deepEqual(result.issues.filter(i => i.id.startsWith("validator:")), [issue]);
  validators.resetJevBreaker();
  assert.deepEqual(await checkReportClaims({ settings, report: { note: "claim" }, diff: "x" }),
    { flag: null, verdict: null, error: "fetch failed", usage: 0, truncated: false });
  validators.resetJevBreaker();
  assert.deepEqual(await judgeTrust({ jev: settings, evidence: "x" }),
    { status: "unavailable", validator: "jev", answers: {}, error: "fetch failed" });
  validators.resetJevBreaker();
});

test("local health accepts POST-only routes and does not probe remote validators", async t => {
  const dir = fixture(t);
  const { endpoint } = await server(t, (req, res) => { assert.equal(req.method, "GET"); res.writeHead(405); res.end(); });
  config(dir, { endpoint });
  assert.deepEqual(await health.localValidatorIssues({ configDir: dir }), []);
  config(dir, { endpoint: "https://judge.example", key_env: "FIXTURE_KEY" });
  assert.deepEqual(await health.localValidatorIssues({ configDir: dir, fetchFn: () => assert.fail("no remote health request") }), []);
});

for (const name of ["jev", "kev"]) {
  test(`CLI add ${name} tests before saving and lists the local endpoint in text and JSON`, async t => {
    const dir = fixture(t);
    const requests = [];
    const { endpoint } = await server(t, async (req, res) => {
      assert.equal(fs.existsSync(path.join(dir, "validators.yml")), false, "test must precede save");
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push({ route: req.url, auth: req.headers.authorization ?? null, model: JSON.parse(body).model });
      reply(res);
    });
    const added = await cli(dir, ["add", name, "--endpoint", endpoint.replace("/v1/systemone", ""), "--model", "local-model", "--json"]);
    assert.equal(added.code, 0, added.stderr);
    const disclosure = validators.validatorTrustDisclosure("Jev", "TypeSafe", endpoint);
    assert.deepEqual(JSON.parse(added.stdout), { saved: true, configPath: path.join(dir, "validators.yml"), test: "pass", reason: null, trustJudgment: disclosure });
    assert.equal(added.stderr, `Before saving: ${disclosure}\nEndpoint saved: open coordinator sessions must run this version before reading validators.yml. Run nomarmy update, then restart them; older versions reject the endpoint field.\n`);
    assert.match(disclosure, /Code excerpts, diffs and briefs stay on this machine/);
    assert.deepEqual(requests, [{ route: "/v1/systemone", auth: null, model: "local-model" }]);
    assert.deepEqual(validators.loadValidators(dir), { jev: { enabled: true, endpoint, model: "local-model", checks } });
    const listed = await cli(dir, ["list", "--json"]);
    assert.equal(listed.code, 0, listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout), { path: path.join(dir, "validators.yml"), jev: { enabled: true, checks, model: "local-model", endpoint, local: true, key: null, keyReadable: true, trustJudgment: disclosure }, judge: null });
    const text = await cli(dir, ["list"]);
    assert.equal(text.code, 0, text.stderr);
    assert.equal(text.stdout, `Jev: on (local-model); checks: scout-citations, report-claims; endpoint: ${endpoint} (local); key: none (local)\n  Also drives the trust judgment. ${disclosure}\n`);
  });
}

test("CLI endpoint keys use stdin or environment and failed probes preserve existing config", async t => {
  const auth = [];
  const { endpoint } = await server(t, (req, res) => { auth.push(req.headers.authorization ?? null); reply(res); });
  for (const method of ["stdin", "env"]) {
    const dir = fixture(t);
    const args = method === "stdin" ? ["--key-stdin"] : ["--key-env", "FIXTURE_KEY"];
    const result = await cli(dir, ["add", "jev", "--endpoint", endpoint, ...args], { input: "fixture\n", env: { FIXTURE_KEY: "fixture" } });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.split("Before saving:").length - 1, 1);
    const expected = { enabled: true, endpoint, model: "jev-latest", checks,
      ...(method === "stdin" ? { key_file: path.join(dir, "secrets", "typesafe.key") } : { key_env: "FIXTURE_KEY" }) };
    assert.deepEqual(validators.loadValidators(dir), { jev: expected });
    if (method === "stdin") assert.equal(fs.readFileSync(expected.key_file, "utf8"), "fixture\n");
  }
  assert.deepEqual(auth, ["Bearer fixture", "Bearer fixture"]);
  const dir = fixture(t);
  config(dir, { key_env: "EXISTING_KEY" });
  const original = fs.readFileSync(path.join(dir, "validators.yml"), "utf8");
  const failedServer = await server(t, (_req, res) => { res.writeHead(503); res.end(); });
  const failed = await cli(dir, ["add", "kev", "--endpoint", failedServer.endpoint, "--key-stdin", "--json"], { input: "fixture\n" });
  assert.equal(failed.code, 1);
  assert.deepEqual(JSON.parse(failed.stdout), { saved: false, test: "fail", reason: `${new URL(failedServer.endpoint).host} answered 503`,
    trustJudgment: validators.validatorTrustDisclosure("Jev", "TypeSafe", failedServer.endpoint) });
  assert.equal(fs.readFileSync(path.join(dir, "validators.yml"), "utf8"), original);
  assert.equal(fs.existsSync(path.join(dir, "secrets")), false);
});

test("disclosure names the actual HTTPS recipient and local server endpoint", () => {
  const tail = " to check for security-sensitive changes (access control, removed checks, personal data, secrets, money). It can only raise a job's review level. Turn it off for a repository with trust: { judgment: false } in its .nomarmy.yml.";
  for (const [endpoint, first, recipient] of [
    ["http://[::1]:8000", "Code excerpts, diffs and briefs stay on this machine (sent to the local server at http://[::1]:8000/v1/systemone).", "the local server at http://[::1]:8000/v1/systemone"],
    ["https://judge.example:8443", "Code excerpts, diffs and briefs are sent to judge.example:8443.", "judge.example:8443"],
    [validators.JEV_ENDPOINT, "Code excerpts, diffs and briefs are sent to api.typesafe.ai.", "api.typesafe.ai"],
  ]) assert.equal(validators.validatorTrustDisclosure("Jev", "TypeSafe", endpoint),
    `${first} Adding Jev also turns on nomArmy's trust judgment in every repository: each implement job's diff, and its brief at dispatch, is sent to ${recipient}${tail}`);
});
