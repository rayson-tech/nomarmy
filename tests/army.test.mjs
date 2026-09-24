import "./helpers/isolate-global-config.mjs";
// Tests for lib/army.mjs: layered role config, the select-only security
// boundary, and army_role expansion.
// Run: node --test tests/army.test.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  armySchema,
  armyLayerPath,
  armyTargetProblems,
  assignRoleInFile,
  DEFAULT_ARMY,
  describeArmy,
  expandArmyRole,
  globalConfigDir,
  loadArmy,
  mergeArmy,
  parseTargetSpec,
  privateConfigProblem,
  readArmyFile,
  subscriptionRolesLayer,
  updateArmyInFile,
} from "../lib/army.mjs";

const scratch = [];
function tmp(prefix = "nomarmy-army-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}
after(() => { for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true }); });

function write(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
}

test("globalConfigDir: NOMARMY_CONFIG_DIR, then XDG_CONFIG_HOME, then ~/.config", () => {
  assert.equal(globalConfigDir({ NOMARMY_CONFIG_DIR: "/x/nm" }), path.resolve("/x/nm"));
  assert.equal(globalConfigDir({ XDG_CONFIG_HOME: "/x/xdg" }), path.join("/x/xdg", "nomarmy"));
  assert.equal(globalConfigDir({}), path.join(os.homedir(), ".config", "nomarmy"));
});

test("armySchema: a role can only select an agent -- credential, endpoint and owner fields are refused", () => {
  for (const field of ["auth_env", "base_url", "owner", "provider", "api_key"]) {
    const result = armySchema.safeParse({ roles: { x: { local: "coder", [field]: "anything" } } });
    assert.equal(result.success, false, field);
  }
});

test("armySchema: exactly one agent per role, lowercase role names, capped descriptions", () => {
  assert.equal(armySchema.safeParse({ roles: { x: { worker: "a", pool: "b" } } }).success, false);
  assert.equal(armySchema.safeParse({ roles: { "Sr Dev": { local: "coder" } } }).success, false);
  assert.equal(armySchema.safeParse({ roles: { __proto__x: { local: "coder" } } }).success, false);
  assert.equal(armySchema.safeParse({ roles: { x: { description: "a".repeat(801) } } }).success, false);
  assert.equal(armySchema.safeParse({ roles: { x: {} } }).success, true, "an unassigned role is allowed; dispatch refuses it");
});

test("DEFAULT_ARMY: valid, and every role is dispatchable out of the box", () => {
  assert.equal(armySchema.safeParse(DEFAULT_ARMY).success, true);
  const { army } = mergeArmy([{ layer: "global", army: structuredClone(DEFAULT_ARMY) }]);
  assert.deepEqual(armyTargetProblems(army), {});
  assert.deepEqual(Object.keys(DEFAULT_ARMY.roles), ["sr-dev", "jr-dev", "ui-ux", "data-architect", "security-analyst", "pm", "po", "stakeholder"]);
});

test("mergeArmy: fields merge one at a time, so a higher layer reassigns without restating the description", () => {
  const { army, sources } = mergeArmy([
    { layer: "global", army: { roles: { "sr-dev": { description: "first cut", phase: "build", local: "coder" } } } },
    { layer: "project", army: { roles: { "sr-dev": { worker: "jason-codex" } } } },
  ]);
  assert.deepEqual(army.roles["sr-dev"], { description: "first cut", phase: "build", worker: "jason-codex" }, "local:coder is cleared, never combined with worker");
  assert.equal(sources.roles["sr-dev"].description, "global");
  assert.equal(sources.roles["sr-dev"].worker, "project");
  assert.equal(sources.roles["sr-dev"].local, undefined);
});

test("mergeArmy: disabled in a higher layer removes the role; workflow and general take the highest layer", () => {
  const { army } = mergeArmy([
    { layer: "global", army: { workflow: "global flow", general: { description: "g" }, roles: { pm: { local: "coder" }, po: { local: "coder" } } } },
    { layer: "local", army: { workflow: "my flow", roles: { po: { disabled: true } } } },
  ]);
  assert.deepEqual(Object.keys(army.roles), ["pm"]);
  assert.equal(army.workflow, "my flow");
  assert.equal(army.general.description, "g");
});

test("subscriptionRolesLayer: legacy subscriptions.yml roles become the lowest layer", () => {
  const layer = subscriptionRolesLayer({ path: "/x", config: { workers: { "jason-claude": { role: "senior-dev" }, other: {} } } });
  assert.deepEqual(layer, { roles: { "senior-dev": { worker: "jason-claude" } } });
});

test("loadArmy: reads global config.yml, the repo's .nomarmy.yml army section, and .nomarmy.local.yml, in that order", () => {
  const globalDir = tmp(), repo = tmp();
  const env = { NOMARMY_CONFIG_DIR: globalDir };
  write(path.join(globalDir, "config.yml"), "army:\n  roles:\n    sr-dev:\n      description: first cut\n      local: coder\n");
  write(path.join(repo, ".nomarmy.yml"), "verification:\n  quick:\n    commands: [\"npm test\"]\narmy:\n  roles:\n    sr-dev:\n      pool: capable\n");
  write(path.join(repo, ".nomarmy.local.yml"), "army:\n  roles:\n    sr-dev:\n      worker: jason-codex\n");
  const loaded = loadArmy({ projectDir: repo, env });
  assert.deepEqual(loaded.army.roles["sr-dev"], { description: "first cut", worker: "jason-codex" });
  assert.deepEqual(loaded.layers.map((l) => [l.layer, l.found]), [["subscriptions", false], ["global", true], ["project", true], ["local", true]]);
});

test("loadArmy: the global and local files are army-only, so a typo'd top-level key is an error, not ignored", () => {
  const globalDir = tmp(), repo = tmp();
  write(path.join(globalDir, "config.yml"), "armee:\n  roles: {}\n");
  assert.throws(() => loadArmy({ projectDir: repo, env: { NOMARMY_CONFIG_DIR: globalDir } }), /unexpected field\(s\) "armee"/);
});

test("readArmyFile: a .nomarmy.yml with no army section is fine; a bad one names the file and the path", () => {
  const repo = tmp();
  write(path.join(repo, ".nomarmy.yml"), "verification: {}\n");
  assert.equal(readArmyFile(path.join(repo, ".nomarmy.yml")), null);
  write(path.join(repo, ".nomarmy.yml"), "army:\n  roles:\n    x:\n      base_url: https://attacker.example\n");
  assert.throws(() => readArmyFile(path.join(repo, ".nomarmy.yml")), (e) => e.path.endsWith(".nomarmy.yml") && /army\.roles\.x: unexpected field/.test(e.errors[0]));
});

test("armyLayerPath: the project layer reuses an existing .nomarmy.yaml rather than creating a second file", () => {
  const repo = tmp();
  assert.equal(armyLayerPath("project", { projectDir: repo }), path.join(repo, ".nomarmy.yml"));
  write(path.join(repo, ".nomarmy.yaml"), "{}\n");
  assert.equal(armyLayerPath("project", { projectDir: repo }), path.join(repo, ".nomarmy.yaml"));
  assert.throws(() => armyLayerPath("subscriptions", { projectDir: repo }), /not a writable army layer/);
});

test("updateArmyInFile: keeps every comment and every other section of .nomarmy.yml", () => {
  const repo = tmp();
  const file = path.join(repo, ".nomarmy.yml");
  write(file, "# the environment contract\nverification:\n  quick:\n    commands:\n      - \"npm test\" # fast\n");
  assignRoleInFile(file, "security-analyst", { local: "gpt" });
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /^# the environment contract/);
  assert.match(text, /"npm test" # fast/);
  assert.match(text, /army:\n  roles:\n    security-analyst:\n      local: gpt/);
});

test("assignRoleInFile: replaces that layer's previous agent, keeps its description, refuses a bad role name", () => {
  const file = path.join(tmp(), "config.yml");
  assignRoleInFile(file, "pm", { worker: "a" });
  updateArmyInFile(file, (army) => { army.roles.pm.description = "reviews"; return army; });
  const written = assignRoleInFile(file, "pm", { pool: "cheap" });
  assert.deepEqual(written.roles.pm, { description: "reviews", pool: "cheap" });
  assert.deepEqual(assignRoleInFile(file, "pm", {}).roles.pm, { description: "reviews" }, "none unassigns");
  assert.throws(() => assignRoleInFile(file, "Bad Name", { local: "coder" }), /not a valid role name/);
});

test("parseTargetSpec: worker:/pool:/local/local:gpt/none, and a clear error otherwise", () => {
  assert.deepEqual(parseTargetSpec("worker:jason-codex"), { worker: "jason-codex" });
  assert.deepEqual(parseTargetSpec("pool:cheap"), { pool: "cheap" });
  assert.deepEqual(parseTargetSpec("local"), { local: "coder" });
  assert.deepEqual(parseTargetSpec("local:gpt"), { local: "gpt" });
  assert.deepEqual(parseTargetSpec("none"), {});
  assert.throws(() => parseTargetSpec("jason-codex"), /must be worker:<name>/);
  assert.throws(() => parseTargetSpec("local:big"), /local:coder or local:gpt/);
});

test("armyTargetProblems: flags unassigned roles and names that aren't defined globally", () => {
  const army = { roles: { a: {}, b: { worker: "ghost" }, c: { pool: "nope" }, d: { worker: "real" }, e: { local: "coder" } } };
  const problems = armyTargetProblems(army, {
    subscriptionLoaded: { config: { workers: { real: {} } } },
    dispatchLoaded: { config: { pools: { cheap: [] } } },
  });
  assert.deepEqual(Object.keys(problems).sort(), ["a", "b", "c"]);
  assert.match(problems.b, /"ghost" is not defined/);
});

const ARMY = {
  roles: {
    "sr-dev": { description: "Does the first cut.", phase: "build", worker: "jason-codex" },
    "jr-dev": { description: "Simple work.", pool: "cheap" },
    "security-analyst": { phase: "review", local: "gpt" },
    pm: {},
  },
};

test("expandArmyRole: a worker role becomes subscription_worker, keeps on_behalf_of, and heads the brief with the role", () => {
  const job = expandArmyRole({ task: "Build the form.", army_role: "sr-dev", on_behalf_of: "you@example.com", mode: "implement" }, ARMY);
  assert.equal(job.subscription_worker, "jason-codex");
  assert.equal(job.on_behalf_of, "you@example.com");
  assert.equal(job.army_role, undefined);
  assert.equal(job.task, "[nomArmy role: sr-dev, build phase]\nDoes the first cut.\n\nBuild the form.");
});

test("expandArmyRole: pool and local roles drop on_behalf_of instead of tripping the subscription-only check", () => {
  const pooled = expandArmyRole({ task: "t", army_role: "jr-dev", on_behalf_of: "x" }, ARMY);
  assert.equal(pooled.pool, "cheap");
  assert.equal(pooled.on_behalf_of, undefined);
  const local = expandArmyRole({ task: "t", army_role: "security-analyst", profile: "coder" }, ARMY);
  assert.equal(local.profile, "gpt", "the role's local slot replaces the default profile");
  assert.equal(local.task, "[nomArmy role: security-analyst, review phase]\n\nt");
});

test("expandArmyRole: refuses an unknown role, an unassigned one, and a job that also picks its own agent", () => {
  assert.throws(() => expandArmyRole({ task: "t", army_role: "cto" }, ARMY), /unknown army_role "cto" -- this repo's roles are: sr-dev, jr-dev, security-analyst, pm/);
  assert.throws(() => expandArmyRole({ task: "t", army_role: "pm" }, ARMY), /no agent assigned -- run `nomarmy army assign pm/);
  assert.throws(() => expandArmyRole({ task: "t", army_role: "sr-dev", pool: "cheap" }, ARMY), /drop pool/);
  assert.throws(() => expandArmyRole({ task: "t", army_role: "x" }, { roles: {} }), /no army is configured/);
});

test("expandArmyRole: a job without army_role passes through untouched", () => {
  const job = { task: "t", pool: "cheap" };
  assert.equal(expandArmyRole(job, ARMY), job);
});

test("describeArmy: what the General sees, including where each value came from", () => {
  const summary = describeArmy({
    army: { general: { description: "g" }, workflow: "w", roles: { pm: { description: "reviews", phase: "review", pool: "ghost" } } },
    sources: { roles: { pm: { description: "global", phase: "global", pool: "project" } } },
    layers: [],
  }, { dispatchLoaded: { config: { pools: {} } } });
  assert.deepEqual(summary.roles.pm, {
    description: "reviews", phase: "review", mode: null, agent: { kind: "pool", name: "ghost" },
    problem: 'pool "ghost" is not defined in your global providers.yml', setBy: { description: "global", phase: "global", pool: "project" },
  });
  assert.match(summary.howToDispatch, /army_role/);
});

test("privateConfigProblem: refuses global config another account owns or can write, fine otherwise", () => {
  const file = path.join(tmp(), "providers.yml");
  write(file, "pools: {}\n");
  fs.chmodSync(file, 0o600);
  const uid = fs.statSync(file).uid;
  assert.equal(privateConfigProblem(file, { platform: "linux", uid }), null);
  assert.match(privateConfigProblem(file, { platform: "linux", uid: uid + 1 }), /owned by another account/);
  fs.chmodSync(file, 0o620);
  assert.match(privateConfigProblem(file, { platform: "linux", uid }), /writable by other accounts \(mode 620\).*chmod go-w/);
  assert.equal(privateConfigProblem(file, { platform: "win32", uid }), null, "mode bits mean nothing on Windows");
  assert.equal(privateConfigProblem(path.join(tmp(), "missing.yml"), { platform: "linux", uid }), null);
});

test("loadArmy: a .nomarmy.local.yml that git tracks is refused -- local must mean local", () => {
  const repo = tmp(), globalDir = tmp();
  execFileSync("git", ["init", "-q"], { cwd: repo });
  write(path.join(repo, ".nomarmy.local.yml"), "army:\n  roles:\n    pm:\n      local: coder\n");
  assert.equal(loadArmy({ projectDir: repo, env: { NOMARMY_CONFIG_DIR: globalDir } }).army.roles.pm.local, "coder", "untracked is fine");
  execFileSync("git", ["add", "-f", ".nomarmy.local.yml"], { cwd: repo });
  assert.throws(() => loadArmy({ projectDir: repo, env: { NOMARMY_CONFIG_DIR: globalDir } }), /tracked by git, so it isn't local.*git rm --cached/);
});
