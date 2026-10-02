import "./helpers/isolate-global-config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { linkCodex } from "../lib/codex-link.mjs";
import { runHealthChecks } from "../lib/health.mjs";
import { runDoctor } from "../lib/doctor.mjs";

const now = Date.parse("2026-10-01T12:00:00Z");
const imported = { id: "openai:account-123", provider: "openai", type: "oauth", label: "(Codex import)", expiresAt: "2099-01-01T00:00:00.000Z" };
const email = { id: "openai:person@example.com", provider: "openai", type: "oauth", expiresAt: "2099-01-01T00:00:00.000Z" };
const migrate = "openclaw migrate apply codex --from ~/.codex --agent main --include-secrets --item auth:openai --yes";
const fix = `openclaw models auth logout ${email.id} && ${migrate}`;
const list = ["models", "auth", "list", "--json"];
const migration = ["migrate", "apply", "codex", "--from", "/sandbox/codex", "--agent", "main", "--include-secrets", "--item", "auth:openai", "--yes"];
function linkRunner(initial, final = [imported], fail = null) {
  let profiles = initial;
  const calls = [];
  return { calls, run: async (cmd, args) => {
    assert.equal(cmd, "stub"); calls.push(args);
    if (args.join(" ") === list.join(" ")) return { ok: true, stdout: `note\n${JSON.stringify({ profiles })}` };
    if (args[2] === "logout" && fail !== "logout") profiles = profiles.filter((p) => p.id !== args[3]);
    if (args[0] === "migrate") profiles = final;
    return { ok: !(fail === "logout" && args[2] === "logout") && !(fail === "migrate" && args[0] === "migrate"), stdout: "SECRET_SENTINEL" };
  } };
}
const options = { command: "stub", codexDir: "/sandbox/codex", now, importLogin: true };

test("Codex link removes capturing email before migration and confirms the account import without logging output", async () => {
  const r = linkRunner([email, imported]); const printed = []; const questions = [];
  assert.equal(await linkCodex({ ...options, run: r.run, isTTY: true, print: (s) => printed.push(s), confirm: async (...args) => { questions.push(args); return true; } }), true);
  assert.deepEqual(questions, [["Remove these email-keyed profiles before importing?", { defaultYes: true }]]);
  assert.deepEqual(r.calls, [list, ["models", "auth", "logout", email.id], list, migration, list]);
  assert.deepEqual(printed, [`Email-keyed profiles will capture the Codex import: ${email.id}.`, `Linking OpenClaw: ${migrate}`, "Imported the ChatGPT credential stored by Codex into OpenClaw's auth store.", "Confirmed an unexpired openai:account- (Codex import) profile."]);
});

test("Codex link requires removal consent, with an explicit noninteractive flag", async () => {
  for (const isTTY of [true, false]) {
    const r = linkRunner([email]);
    assert.equal(await linkCodex({ ...options, run: r.run, isTTY, confirm: async () => false }), false);
    assert.deepEqual(r.calls, [list]);
  }
  const unapproved = linkRunner([]);
  assert.equal(await linkCodex({ ...options, run: unapproved.run, importLogin: false, removeEmailProfiles: true }), false);
  assert.deepEqual(unapproved.calls, [list]);
  const r = linkRunner([email]);
  assert.equal(await linkCodex({ ...options, run: r.run, removeEmailProfiles: true }), true);
  assert.deepEqual(r.calls, [list, ["models", "auth", "logout", email.id], list, migration, list]);
});

test("Codex link rejects missing, email, expired, and mislabeled imports and failed migrations", async () => {
  const unapproved = linkRunner([]);
  assert.equal(await linkCodex({ ...options, run: unapproved.run, importLogin: false }), false);
  assert.deepEqual(unapproved.calls, [list]);
  for (const final of [[], [email], [{ ...imported, expiresAt: "1970-01-01T00:00:00.000Z" }], [{ ...imported, label: "OAuth" }]]) {
    const r = linkRunner([], final);
    assert.equal(await linkCodex({ ...options, run: r.run }), false);
    assert.deepEqual(r.calls, [list, migration, list]);
  }
  for (const fail of ["logout", "migrate"]) {
    const r = linkRunner(fail === "logout" ? [email] : [], [imported], fail);
    assert.equal(await linkCodex({ ...options, run: r.run, removeEmailProfiles: true }), false);
    assert.deepEqual(r.calls, fail === "logout" ? [list, ["models", "auth", "logout", email.id]] : [list, migration]);
  }
});

const agents = { codex: { kind: "subscription", provider: "openai", model: "gpt-6-astra" }, grok: { kind: "api", provider: "xai", model: "grok-4.7" } };
const facts = { nodeVersion: "v20.11.3", platform: "linux", gitFound: true, gitLongPaths: null, podmanFound: true, podmanDaemonReachable: true, podmanDaemonError: null, execution: "local", endpoint: { mode: "local", url: "http://127.0.0.1:8080/health", healthy: true, error: null } };
const paths = ["agents.entries.main.modelPolicy.allow", "agents.defaults.modelPolicy.allow"];
async function checks(kind, profiles, allows = [null, null], armySummary = null) {
  const calls = [];
  const run = async (_cmd, args) => {
    calls.push(args);
    if (args.join(" ") === list.join(" ")) return { ok: true, stdout: `note\n${JSON.stringify({ profiles })}` };
    if (args[0] === "config") return { ok: true, stdout: JSON.stringify(allows[paths.indexOf(args[2])]) };
    return { ok: false, stdout: "" };
  };
  const runtime = { run, agents, armySummary, now };
  let issues;
  if (kind === "health") issues = (await runHealthChecks(runtime)).issues;
  else {
    const old = console.log; console.log = () => {};
    try {
      const result = await runDoctor({ facts, runtime });
      issues = result.checks.filter((c) => !c.ok);
      assert.deepEqual(Object.keys(result).sort(), ["checks", "ok"]);
      assert.equal(result.ok, issues.length === 0);
      for (const c of issues) assert.deepEqual(Object.keys(c).sort(), ["fix", "id", "message", "ok"]);
    } finally { console.log = old; }
  }
  assert.deepEqual(calls.filter((a) => a[0] === "config"), paths.map((p) => ["config", "get", p, "--json"]));
  return issues;
}
for (const kind of ["health", "doctor"]) {
  test(`${kind} flags absent, expired and shadowed Codex imports with ordered exact recovery`, async () => {
    for (const [profiles, ids, recovery] of [
      [[], ["codex-import:missing"], migrate],
      [[email], ["codex-import:missing", "codex-import:shadowed"], fix],
      [[imported, email], ["codex-import:shadowed"], fix],
      [[{ ...imported, expiresAt: "1970-01-01T00:00:00.000Z" }, email], ["login-expired:openai:account-123", "codex-import:missing", "codex-import:shadowed"], fix],
      [[imported], [], migrate],
    ]) {
      const issues = await checks(kind, profiles);
      assert.deepEqual(issues.map((i) => i.id), ids);
      assert.deepEqual(issues.map((i) => i.fix), ids.map(() => recovery));
      if (kind === "health") for (const i of issues) {
        assert.deepEqual(Object.keys(i).sort(), ["detail", "fix", "id", "severity", "short", "title"]);
        assert.equal(i.severity, "error");
      }
    }
  });
  test(`${kind} names excluded agent and role models in entry and default allowlists`, async () => {
    const summary = { roles: { reviewer: { agent: "grok", model: "grok-review" }, pm: { agent: "codex", model: "auto", modelIsAuto: true } } };
    const issues = await checks(kind, [imported], [["openai/gpt-6-astra"], ["xai/grok-4.7", "xai/grok-review"]], summary);
    assert.deepEqual(issues.map((i) => i.id), paths.map((p) => `model-policy:${p}`));
    assert.deepEqual(issues.map((i) => i.fix), paths.map((p) => `openclaw config unset ${p.replace(/\.allow$/, "")} (or add the missing models to ${p})`));
    const titles = ["OpenClaw model policy excludes: xai/grok-4.7, xai/grok-review", "OpenClaw model policy excludes: openai/gpt-6-astra"];
    assert.deepEqual(issues.map((i) => kind === "health" ? i.title : i.message), kind === "health" ? titles : titles.map((t, i) => `${t}. ${paths[i]} refuses models used by nomArmy agents or roles.`));
    assert.deepEqual(await checks(kind, [imported], [["openai/gpt-6-astra", "xai/grok-4.7", "xai/grok-review"], null], summary), []);
    assert.deepEqual((await checks(kind, [imported], [[], null])).map((i) => i.id), ["model-policy:agents.entries.main.modelPolicy.allow"]);
  });
}
