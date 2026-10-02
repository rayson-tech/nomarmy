import "./helpers/isolate-global-config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { validateTrustMap, loadTrustMap, writeTrustScoutBrief, writeTrustProposal, reviewTrustProposal, scoutFiles, TRUST_MAP_FILE, TRUST_PROPOSAL_FILE } from "../lib/trust-map.mjs";
import { computeTrustReach, cachedTrustReach, evaluateReachTrust } from "../lib/trust-reach.mjs";
import { evaluateTrust } from "../lib/trust.mjs";
import { evaluateDiffTrust } from "../lib/trust-judgment.mjs";

const entry = { symbol: "boundary", file: "boundary.py", category: "tenant", reason: "Enforces tenant scope" };
const sources = {
  "boundary.py": "def boundary(user):\n    return middle(user)\n",
  "helpers.py": "def middle(user):\n    return leaf(user)\n\ndef leaf(user):\n    assert user.tenant_id\n    return user.tenant_id\n\ndef unrelated():\n    return 1\n",
};
function write(root, file, content) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), content); }
function fixture(t) {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".trust-map-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(sources)) write(root, file, text);
  return root;
}
const cliFile = path.resolve("bin/nomarmy.mjs");
function cli(root, args) {
  const run = spawnSync(process.execPath, [cliFile, "trust", ...args, "--repo", root, "--json"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  return JSON.parse(run.stdout);
}

test("trust map schema reads only the operator checkout and map edits are human gated", t => {
  const root = fixture(t), worktree = path.join(root, "worker");
  write(worktree, TRUST_MAP_FILE, JSON.stringify([{ ...entry, category: "access" }]));
  write(root, TRUST_PROPOSAL_FILE, JSON.stringify([{ ...entry, line: 1 }]));
  assert.deepEqual(loadTrustMap(root), []);
  write(root, TRUST_MAP_FILE, JSON.stringify([entry]));
  assert.deepEqual(loadTrustMap(root), [entry]);
  for (const bad of [null, {}, [{ ...entry, extra: true }], [{ ...entry, category: "folder" }], [{ ...entry, file: "../escape" }], [{ ...entry, symbol: "**" }], [{ ...entry, reason: "" }], [entry, entry]]) assert.throws(() => validateTrustMap(bad));
  assert.deepEqual(validateTrustMap([entry]), [entry]);
  assert.deepEqual(evaluateTrust({ changedFiles: [TRUST_MAP_FILE] }), { level: "human", reasons: [{ rule: "trust", reason: "changes the repository's trust rules", file: TRUST_MAP_FILE }] });
  write(root, TRUST_MAP_FILE, "broken: map\n");
  assert.throws(() => loadTrustMap(root));
  if (process.platform !== "win32") {
    fs.unlinkSync(path.join(root, TRUST_MAP_FILE));
    fs.symlinkSync("missing-map.yml", path.join(root, TRUST_MAP_FILE));
    assert.throws(() => loadTrustMap(root), /regular file, not a symlink/);
  }
});

test("trust map scout brief and cited import skip generated and vendored files", t => {
  const root = fixture(t);
  for (const file of ["node_modules/a.py", "vendor/a.py", "dist/a.py", "build/a.py", "gen/a.py", "third/a.py", "src/generated.py", "src/kept.py"]) write(root, file, "def guard():\n    pass\n");
  write(root, ".gitattributes", "gen/** linguist-generated\nthird/** linguist-vendored=true\nsrc/*.py linguist-generated\nsrc/kept.py -linguist-generated\n");
  assert.deepEqual(scoutFiles(root), { files: [".gitattributes", "boundary.py", "helpers.py", "src/kept.py"], truncated: false });
  const result = writeTrustScoutBrief({ operatorDir: root, roles: { builder: { phase: "build" }, audit: { phase: "review" } } });
  assert.deepEqual(Object.keys(result).sort(), ["brief", "dispatch", "proposal", "status", "truncated"]);
  assert.deepEqual(Object.keys(result.dispatch).sort(), ["army_role", "mode", "task"]);
  assert.equal(result.status, "awaiting-scout");
  assert.equal(result.dispatch.army_role, "audit");
  assert.equal(result.dispatch.mode, "scout");
  assert.equal(result.truncated, false);
  assert.match(fs.readFileSync(path.join(root, result.brief), "utf8"), /CLI has no job-dispatch client/);
  assert.equal(result.dispatch.task.includes('"gen/a.py"'), false);
  assert.deepEqual(loadTrustMap(root), []);
  assert.deepEqual(writeTrustProposal(root, [{ ...entry, line: 1 }]), { status: "proposed", proposal: TRUST_PROPOSAL_FILE, entries: [{ ...entry, line: 1 }] });
  for (const bad of [{ ...entry, line: 2 }, { ...entry, file: "gen/a.py", symbol: "guard", line: 1 }]) assert.throws(() => writeTrustProposal(root, [bad]));
  assert.deepEqual(loadTrustMap(root), []);
  write(root, "scout.yml", JSON.stringify([{ ...entry, line: 1 }]));
  assert.deepEqual(cli(root, ["map", "--from", "scout.yml"]), { status: "proposed", proposal: TRUST_PROPOSAL_FILE, entries: [{ ...entry, line: 1 }] });
});

test("trust review JSON accepts drops and edits proposals without implicit activation", t => {
  const root = fixture(t);
  const proposals = [{ ...entry, line: 1 }, { ...entry, symbol: "middle", file: "helpers.py", line: 1 }, { ...entry, symbol: "leaf", file: "helpers.py", line: 4 }];
  writeTrustProposal(root, proposals);
  assert.deepEqual(cli(root, ["review"]), { status: "pending", entries: proposals });
  assert.deepEqual(loadTrustMap(root), []);
  const edit = { ...entry, symbol: "leaf", file: "helpers.py", category: "access", reason: "Checks tenant identity" };
  const decisions = [{ action: "accept" }, { action: "drop" }, { action: "edit", entry: edit }];
  assert.deepEqual(cli(root, ["review", "--decisions", JSON.stringify(decisions)]), { status: "reviewed", map: TRUST_MAP_FILE, entries: [entry, edit], decisions });
  assert.deepEqual(loadTrustMap(root), [entry, edit]);
  assert.deepEqual(cli(root, ["review"]), { status: "pending", entries: [] });
  writeTrustProposal(root, [{ ...entry, symbol: "middle", file: "helpers.py", line: 1 }]);
  assert.throws(() => reviewTrustProposal({ operatorDir: root, decisions: [] }), /one decision/);
  assert.deepEqual(cli(root, ["review", "--accept-all"]), { status: "reviewed", map: TRUST_MAP_FILE, entries: [entry, edit, { ...entry, symbol: "middle", file: "helpers.py" }], decisions: [{ action: "accept" }] });
});

test("trust reach gates two-call helpers not unrelated functions and removed checks become human", async t => {
  const root = fixture(t);
  const reach = computeTrustReach({ baseDir: root, entries: [entry] });
  assert.deepEqual(Object.keys(reach).sort(), ["boundaries", "caps", "depth", "fanOut", "heuristic"]);
  assert.deepEqual(reach.caps, []);
  assert.deepEqual(reach.boundaries, [{ entry, nodes: [
    { symbol: "boundary", file: "boundary.py", line: 1, end: 3, depth: 0, via: [] },
    { symbol: "middle", file: "helpers.py", line: 1, end: 3, depth: 1, via: [{ symbol: "boundary", file: "boundary.py", line: 1 }] },
    { symbol: "leaf", file: "helpers.py", line: 4, end: 7, depth: 2, via: [{ symbol: "boundary", file: "boundary.py", line: 1 }, { symbol: "middle", file: "helpers.py", line: 1 }] },
  ] }]);
  const change = { file: "helpers.py", before: sources["helpers.py"], after: sources["helpers.py"].replace("return user.tenant_id", "return str(user.tenant_id)") };
  const reason = { rule: "trust-reach", file: "helpers.py", line: 4, reason: "changes helper `leaf` (helpers.py:4), which `boundary` (boundary.py:1), the tenant boundary, depends on via `boundary` (boundary.py:1) -> `middle` (helpers.py:1)" };
  assert.deepEqual(evaluateReachTrust({ reach, fileChanges: [change] }), { level: "review", reasons: [reason] });
  assert.deepEqual(evaluateReachTrust({ reach, fileChanges: [{ ...change, after: change.before.replace("return 1", "return 2") }] }), { level: "normal", reasons: [] });
  const direct = evaluateReachTrust({ reach, fileChanges: [{ file: "boundary.py", before: sources["boundary.py"], after: sources["boundary.py"].replace("middle(user)", "middle(None)") }] });
  assert.deepEqual(direct, { level: "review", reasons: [{ rule: "trust-reach", file: "boundary.py", line: 1, reason: "changes mapped symbol `boundary` (boundary.py:1), the tenant boundary" }] });
  const trust = await evaluateDiffTrust({ reach: { key: "cache", baseCommit: "base", ...reach }, floor: { level: "normal", reasons: [] }, judgment: false, fileChanges: [{ ...change, after: change.before.replace("    assert user.tenant_id\n", "") }] });
  assert.deepEqual(Object.keys(trust).sort(), ["checks", "judgment", "level", "reach", "reasons"]);
  assert.equal(trust.level, "human");
  assert.deepEqual(trust.reasons, [{ ...reason, reason: reason.reason.replace("changes helper", "removes a check in helper") }, { rule: "removed-check", reason: "Removes or changes an assertion or validation at helpers.py:5.", file: "helpers.py", line: 5 }]);
  assert.deepEqual(trust.reach, { key: "cache", baseCommit: "base", heuristic: true, depth: 3, fanOut: 25, caps: [] });
  const js = "export function gate(user) { return next(user); }\nfunction next(user) { return final(user); }\nfunction final(user) { return user.id; }\nfunction other() { return 1; }\n";
  write(root, "flow.mjs", js);
  const jsReach = computeTrustReach({ baseDir: root, entries: [{ ...entry, symbol: "gate", file: "flow.mjs", category: "access" }] });
  assert.deepEqual(jsReach.boundaries[0].nodes.map(({ symbol, line, end, depth }) => ({ symbol, line, end, depth })), [
    { symbol: "gate", line: 1, end: 1, depth: 0 }, { symbol: "next", line: 2, end: 2, depth: 1 }, { symbol: "final", line: 3, end: 3, depth: 2 },
  ]);
  assert.deepEqual(evaluateReachTrust({ reach: jsReach, fileChanges: [{ file: "flow.mjs", before: js, after: js.replace("return user.id", "return user.name") }] }), {
    level: "review", reasons: [{ rule: "trust-reach", file: "flow.mjs", line: 3, reason: "changes helper `final` (flow.mjs:3), which `gate` (flow.mjs:1), the access boundary, depends on via `gate` (flow.mjs:1) -> `next` (flow.mjs:2)" }],
  });
  assert.deepEqual(evaluateReachTrust({ reach: jsReach, fileChanges: [{ file: "flow.mjs", before: js, after: js.replace("return 1", "return 2") }] }), { level: "normal", reasons: [] });
});

test("trust reach states depth and fan-out caps and caches separately per base commit and map", t => {
  const root = fixture(t), stateDir = path.join(root, "state");
  const limited = computeTrustReach({ baseDir: root, entries: [entry], depth: 1 });
  assert.deepEqual(limited.caps, [{ kind: "depth", symbol: "middle", file: "helpers.py", limit: 1 }]);
  assert.deepEqual(evaluateReachTrust({ reach: limited, fileChanges: [{ file: "other.py", before: "x = 1", after: "x = 2" }] }), {
    level: "review", reasons: [{ rule: "trust-reach-cap", reason: "trust reach is incomplete: depth at helpers.py:middle (limit 1)" }],
  });
  write(root, "boundary.py", "def boundary(user):\n    return middle(user) + leaf(user)\n");
  assert.deepEqual(computeTrustReach({ baseDir: root, entries: [entry], fanOut: 1 }).caps, [{ kind: "fan-out", symbol: "boundary", file: "boundary.py", limit: 1 }]);
  const args = { baseDir: root, baseCommit: "base-one", entries: [entry], stateDir };
  const first = cachedTrustReach(args);
  assert.deepEqual(Object.keys(first).sort(), ["baseCommit", "boundaries", "caps", "depth", "fanOut", "heuristic", "key"]);
  write(root, "boundary.py", "def boundary(user):\n    return user\n");
  assert.deepEqual(cachedTrustReach(args), first);
  const second = cachedTrustReach({ ...args, baseCommit: "base-two" });
  assert.equal(second.baseCommit, "base-two");
  assert.notEqual(first.key, second.key);
  assert.deepEqual(second.boundaries[0].nodes.map(n => n.symbol), ["boundary"]);
  assert.equal(fs.readdirSync(path.join(stateDir, "trust-reach")).length, 2);
  const changedMap = cachedTrustReach({ ...args, entries: [{ ...entry, category: "access" }] });
  assert.notEqual(changedMap.key, first.key);
  assert.deepEqual(changedMap.boundaries[0].entry, { ...entry, category: "access" });
});
