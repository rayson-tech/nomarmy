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
  generalOverlap,
  GENERAL,
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

test("armySchema: a role can only name an agent -- credential, endpoint, owner and old target fields are refused", () => {
  for (const field of ["auth_env", "base_url", "owner", "provider", "api_key", "worker", "pool", "local"]) {
    const result = armySchema.safeParse({ roles: { x: { agent: "codex", [field]: "anything" } } });
    assert.equal(result.success, false, field);
  }
});

test("armySchema: the General is an agent name, never a rewritable charter", () => {
  assert.equal(armySchema.safeParse({ general: "opus" }).success, true);
  assert.equal(armySchema.safeParse({ general: { description: "I do whatever I like" } }).success, false);
  assert.ok(GENERAL.responsibilities.some((r) => /Owns Git/.test(r)));
  assert.ok(Object.isFrozen(GENERAL) && Object.isFrozen(GENERAL.responsibilities));
});

test("armySchema: lowercase role names, capped descriptions", () => {
  assert.equal(armySchema.safeParse({ roles: { "Sr Dev": { agent: "local" } } }).success, false);
  assert.equal(armySchema.safeParse({ roles: { __proto__x: { agent: "local" } } }).success, false);
  assert.equal(armySchema.safeParse({ roles: { x: { description: "a".repeat(801) } } }).success, false);
  assert.equal(armySchema.safeParse({ roles: { x: {} } }).success, true, "an unassigned role is allowed; dispatch refuses it");
});

test("DEFAULT_ARMY: valid, and every role is dispatchable out of the box", () => {
  assert.equal(armySchema.safeParse(DEFAULT_ARMY).success, true);
  const { army } = mergeArmy([{ layer: "global", army: structuredClone(DEFAULT_ARMY) }]);
  assert.deepEqual(armyTargetProblems(army, { local: { kind: "local", slot: "coder" } }), {}, "every role starts on the built-in local agent");
  assert.deepEqual(Object.keys(DEFAULT_ARMY.roles), ["sr-dev", "jr-dev", "ui-ux", "data-architect", "security-analyst", "pm", "po", "stakeholder"]);
});

test("mergeArmy: fields merge one at a time, so a higher layer reassigns without restating the description", () => {
  const { army, sources } = mergeArmy([
    { layer: "global", army: { roles: { "sr-dev": { description: "first cut", phase: "build", agent: "local" } } } },
    { layer: "project", army: { roles: { "sr-dev": { agent: "codex" } } } },
  ]);
  assert.deepEqual(army.roles["sr-dev"], { description: "first cut", phase: "build", agent: "codex" });
  assert.equal(sources.roles["sr-dev"].description, "global");
  assert.equal(sources.roles["sr-dev"].agent, "project");
});

test("mergeArmy: disabled in a higher layer removes the role; workflow and general take the highest layer", () => {
  const { army, sources } = mergeArmy([
    { layer: "global", army: { workflow: "global flow", general: "opus", roles: { pm: { agent: "local" }, po: { agent: "local" } } } },
    { layer: "local", army: { workflow: "my flow", general: "codex", roles: { po: { disabled: true } } } },
  ]);
  assert.deepEqual(Object.keys(army.roles), ["pm"]);
  assert.equal(army.workflow, "my flow");
  assert.equal(army.general, "codex");
  assert.equal(sources.general, "local");
});

test("loadArmy: reads global config.yml, the repo's .nomarmy.yml army section, and .nomarmy.local.yml, in that order", () => {
  const globalDir = tmp(), repo = tmp();
  const env = { NOMARMY_CONFIG_DIR: globalDir };
  write(path.join(globalDir, "config.yml"), "army:\n  roles:\n    sr-dev:\n      description: first cut\n      agent: local\n");
  write(path.join(repo, ".nomarmy.yml"), "verification:\n  quick:\n    commands: [\"npm test\"]\narmy:\n  roles:\n    sr-dev:\n      agent: grok\n");
  write(path.join(repo, ".nomarmy.local.yml"), "army:\n  roles:\n    sr-dev:\n      agent: codex\n");
  const loaded = loadArmy({ projectDir: repo, env });
  assert.deepEqual(loaded.army.roles["sr-dev"], { description: "first cut", agent: "codex" });
  assert.deepEqual(loaded.layers.map((l) => [l.layer, l.exists, l.hasArmy]), [["global", true, true], ["project", true, true], ["local", true, true]]);
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
  assignRoleInFile(file, "security-analyst", { agent: "local-gpt" });
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /^# the environment contract/);
  assert.match(text, /"npm test" # fast/);
  assert.match(text, /army:\n  roles:\n    security-analyst:\n      agent: local-gpt/);
});

test("assignRoleInFile: replaces that layer's previous agent, keeps its description, refuses a bad role name", () => {
  const file = path.join(tmp(), "config.yml");
  assignRoleInFile(file, "pm", { agent: "a" });
  updateArmyInFile(file, (army) => { army.roles.pm.description = "reviews"; return army; });
  assert.deepEqual(assignRoleInFile(file, "pm", { agent: "grok" }).roles.pm, { description: "reviews", agent: "grok" });
  assert.deepEqual(assignRoleInFile(file, "pm", {}).roles.pm, { description: "reviews" }, "none unassigns");
  assert.throws(() => assignRoleInFile(file, "Bad Name", { agent: "local" }), /not a valid role name/);
});

test("parseTargetSpec: a bare agent name or none -- the old worker:/pool:/local: prefixes are refused", () => {
  assert.deepEqual(parseTargetSpec("codex"), { agent: "codex" });
  assert.deepEqual(parseTargetSpec("codex", "gpt-6-astra"), { agent: "codex", model: "gpt-6-astra" });
  assert.deepEqual(parseTargetSpec("codex", "auto"), { agent: "codex", model: "auto" });
  assert.throws(() => parseTargetSpec("none", "auto"), /takes no model/);
  assert.deepEqual(parseTargetSpec("local"), { agent: "local" });
  assert.deepEqual(parseTargetSpec("none"), {});
  assert.throws(() => parseTargetSpec("worker:codex"), /not an agent name/);
});

const AGENTS = {
  local: { kind: "local", slot: "coder" },
  grok: { kind: "api", provider: "xai", model: "grok-4.7", auth_env: "K" },
  opus: { kind: "subscription", provider: "claude-cli", model: "claude-opus-5", owner: "you@example.com" },
  sonnet: { kind: "subscription", provider: "claude-cli", model: "claude-sonnet-5", owner: "you@example.com" },
  codex: { kind: "subscription", provider: "openai", model: "gpt-6-astra", owner: "you@example.com" },
};

test("armyTargetProblems: a role needs a model when its agent has no default; a model on the local agent can't apply", () => {
  const agents = { local: { kind: "local", slot: "coder" }, codex: { kind: "subscription", provider: "openai", owner: "o" } };
  const problems = armyTargetProblems({ roles: { a: { agent: "codex" }, b: { agent: "codex", model: "auto" }, c: { agent: "codex", model: "gpt-6-sol" }, d: { agent: "local", model: "x" } } }, agents);
  assert.deepEqual(Object.keys(problems).sort(), ["a", "d"]);
  assert.match(problems.a, /needs one: `nomarmy army assign a codex <model\|auto>`/);
  assert.match(problems.d, /local model/);
});

test("assignRoleInFile: a new assignment replaces the previous agent AND its model", () => {
  const file = path.join(tmp(), "config.yml");
  assignRoleInFile(file, "pm", { agent: "codex", model: "gpt-6-astra" });
  assert.deepEqual(assignRoleInFile(file, "pm", { agent: "grok" }).roles.pm, { agent: "grok" }, "a stale model never carries over to a different agent");
});

test("armyTargetProblems: flags unassigned roles and agents that don't exist", () => {
  const problems = armyTargetProblems({ roles: { a: {}, b: { agent: "ghost" }, c: { agent: "grok" } } }, AGENTS);
  assert.deepEqual(Object.keys(problems).sort(), ["a", "b"]);
  assert.match(problems.b, /agent "ghost" is not defined in your agents.yml/);
});

test("generalOverlap: flags a role on the General's own agent, and one sharing the General's subscription login", () => {
  const overlap = generalOverlap({ general: "opus", roles: { reviewer: { agent: "opus" }, "sr-dev": { agent: "sonnet" }, ui: { agent: "codex" }, pm: { agent: "grok" } } }, AGENTS);
  assert.deepEqual(Object.keys(overlap).sort(), ["reviewer", "sr-dev"]);
  assert.match(overlap.reviewer, /isn't independently reviewed/);
  assert.match(overlap["sr-dev"], /shares the General's claude-cli login \(you@example.com\)/);
  assert.deepEqual(generalOverlap({ roles: { x: { agent: "opus" } } }, AGENTS), {}, "no General defined, nothing to compare");
});

const ARMY = {
  roles: {
    "sr-dev": { description: "Does the first cut.", phase: "build", agent: "codex" },
    "security-analyst": { phase: "review", agent: "local" },
    pm: {},
  },
};

test("expandArmyRole: a role becomes agent: <its agent>, headed by the role's description", () => {
  const job = expandArmyRole({ task: "Build the form.", army_role: "sr-dev", on_behalf_of: "you@example.com" }, ARMY);
  assert.equal(job.agent, "codex");
  assert.equal(job.on_behalf_of, "you@example.com", "left for the agent expansion to keep or drop");
  assert.equal(job.army_role, undefined);
  assert.equal(job.armyRole, "sr-dev");
  assert.equal(job.task, "[nomArmy role: sr-dev, build phase]\nDoes the first cut.\n\nBuild the form.");
  assert.equal(job.roleModel, null);
  assert.equal(expandArmyRole({ task: "t", army_role: "security-analyst" }, ARMY).task, "[nomArmy role: security-analyst, review phase]\n\nt");
});

test("expandArmyRole: refuses an unknown role, an unassigned one, and a job that also names its own agent", () => {
  assert.throws(() => expandArmyRole({ task: "t", army_role: "cto" }, ARMY), /unknown army_role "cto" -- this repo's roles are: sr-dev, security-analyst, pm/);
  assert.throws(() => expandArmyRole({ task: "t", army_role: "pm" }, ARMY), /no agent assigned -- run `nomarmy army assign pm <agent>`/);
  assert.throws(() => expandArmyRole({ task: "t", army_role: "sr-dev", agent: "grok" }, ARMY), /drop agent "grok"/);
  assert.throws(() => expandArmyRole({ task: "t", army_role: "x" }, { roles: {} }), /no army is configured/);
});

test("expandArmyRole: a job without army_role passes through untouched", () => {
  const job = { task: "t", agent: "grok" };
  assert.equal(expandArmyRole(job, ARMY), job);
});

test("describeArmy: the fixed charter plus the General's agent, each role's agent and where its values came from", () => {
  const summary = describeArmy({
    army: { general: "opus", workflow: "w", roles: { pm: { description: "reviews", phase: "review", agent: "sonnet" } } },
    sources: { general: "global", roles: { pm: { description: "global", phase: "global", agent: "project" } } },
    layers: [],
  }, { agents: AGENTS, describeAgent: (a) => `${a.kind} ${a.model}` });
  assert.equal(summary.general.agent, "opus");
  assert.equal(summary.general.agentRunsOn, "subscription claude-opus-5");
  assert.equal(summary.general.problem, null);
  assert.deepEqual(summary.general.responsibilities, GENERAL.responsibilities);
  assert.equal(summary.roles.pm.agent, "sonnet");
  assert.equal(summary.roles.pm.setBy.agent, "project");
  assert.match(summary.roles.pm.overlapsGeneral, /same usage limit/);
  const undefinedGeneral = describeArmy({ army: { general: null, workflow: null, roles: {} }, sources: { roles: {} }, layers: [] }, { agents: AGENTS });
  assert.match(undefinedGeneral.general.problem, /nomarmy army general <agent>/);
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
  write(path.join(repo, ".nomarmy.local.yml"), "army:\n  roles:\n    pm:\n      agent: local\n");
  assert.equal(loadArmy({ projectDir: repo, env: { NOMARMY_CONFIG_DIR: globalDir } }).army.roles.pm.agent, "local", "untracked is fine");
  execFileSync("git", ["add", "-f", ".nomarmy.local.yml"], { cwd: repo });
  assert.throws(() => loadArmy({ projectDir: repo, env: { NOMARMY_CONFIG_DIR: globalDir } }), /tracked by git, so it isn't local.*git rm --cached/);
});

test("describeArmy: a subscription owned by someone other than the General's owner gets a note, not a refusal", () => {
  const agents = { ...AGENTS, meta: { kind: "subscription", provider: "meta", owner: "personal@example.com" } };
  const summary = describeArmy({ army: { general: "opus", workflow: null, roles: { "data-architect": { agent: "meta", model: "muse-spark-1.3" }, pm: { agent: "grok" } } }, sources: { roles: { "data-architect": {}, pm: {} } }, layers: [] }, { agents });
  assert.match(summary.roles["data-architect"].ownerNote, /owned by personal@example\.com, not the General's own you@example\.com; jobs on it need on_behalf_of "personal@example\.com"\. If that's the operator's own other account, it's fine/);
  assert.equal(summary.roles.pm.ownerNote, null, "an api agent has no owner to compare");
});

test("loadArmy: a .nomarmy.yml with no army section exists, it just has nothing for the army -- not \"missing\"", () => {
  const repo = tmp();
  write(path.join(repo, ".nomarmy.yml"), "verification:\n  quick:\n    commands: [\"npm test\"]\n");
  const project = loadArmy({ projectDir: repo, env: { NOMARMY_CONFIG_DIR: tmp() } }).layers.find((l) => l.layer === "project");
  assert.deepEqual({ exists: project.exists, hasArmy: project.hasArmy }, { exists: true, hasArmy: false });
});
