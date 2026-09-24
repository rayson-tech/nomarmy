// nomArmy's army: who the General (the coordinator session) calls for what.
//
// The General is the Claude Code / Codex session itself. Its charter is
// GENERAL below, fixed by how nomArmy works; no config layer can rewrite
// it. What IS configured is which agent the General is (`general: opus`),
// defined after agents exist, so nomArmy can warn when a role shares the
// General's model (a review that isn't independent) or its subscription
// login (the same usage limit). nomArmy never launches the General: the
// General is what calls nomArmy. Every other role
// is open to interpretation: a name, a description of when the General
// calls it, the phase it belongs to, and the agent (lib/agents.mjs) it
// runs on.
//
// Layers merge the way Claude Code's settings do, lowest to highest, each
// under an `army:` key:
//   global             ~/.config/nomarmy/config.yml
//   project            <repo>/.nomarmy.yml         (committed, beside verification)
//   local              <repo>/.nomarmy.local.yml   (gitignored)
//
// Security boundary: a project file is repository content, and a cloned
// repo is not trusted. So army files can only SELECT among agents defined
// globally in agents.yml; the schema has no field for a credential, an
// endpoint, an owner or a provider, and never will. A hostile
// .nomarmy.yml can at worst route a job to one of your own agents.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

export const GLOBAL_CONFIG_FILENAME = "config.yml";
export const PROJECT_CONFIG_FILENAMES = Object.freeze([".nomarmy.yml", ".nomarmy.yaml"]);
export const LOCAL_CONFIG_FILENAME = ".nomarmy.local.yml";
export const ARMY_PHASES = Object.freeze(["build", "review", "acceptance"]);
export const ARMY_LAYERS = Object.freeze(["global", "project", "local"]);
export const ROLE_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * The General's charter. Static on purpose: the General is the session
 * calling nomArmy's tools, and these responsibilities are what the rest of
 * the system (the verified execution record, coordinator-owned commits,
 * never auto-merging) is built around. Not a role, not in any config file,
 * never assigned an agent.
 */
export const GENERAL = Object.freeze({
  who: "The coordinator session calling nomArmy's tools (Claude Code, Codex or Cursor). It runs outside every sandbox and is never a worker.",
  responsibilities: Object.freeze([
    "Plans and decomposes the work, and owns any uncertain diagnosis.",
    "Makes the architecture and security decisions.",
    "Briefs each role with the outcome and acceptance criteria, and dispatches it with army_role.",
    "Reviews every result against nomArmy's verified execution record; a worker's report is a claim, not evidence.",
    "Owns Git and integration: reviews diffs, resolves conflicts, merges. nomArmy never auto-merges.",
    "Gives final acceptance, and decides which roles the work needs.",
  ]),
});

/** Where global nomArmy config lives: NOMARMY_CONFIG_DIR, else $XDG_CONFIG_HOME/nomarmy, else ~/.config/nomarmy. */
export function globalConfigDir(env = process.env) {
  if (env.NOMARMY_CONFIG_DIR) return path.resolve(env.NOMARMY_CONFIG_DIR);
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "nomarmy");
}

export function armyLayerPath(layer, { projectDir, env = process.env } = {}) {
  if (layer === "global") return path.join(globalConfigDir(env), GLOBAL_CONFIG_FILENAME);
  if (layer === "project") {
    const existing = PROJECT_CONFIG_FILENAMES.map((f) => path.join(projectDir, f)).find(isFile);
    return existing ?? path.join(projectDir, PROJECT_CONFIG_FILENAMES[0]);
  }
  if (layer === "local") return path.join(projectDir, LOCAL_CONFIG_FILENAME);
  throw new Error(`not a writable army layer: "${layer}" (use global, project or local)`);
}

function isFile(candidate) {
  try { return fs.statSync(candidate).isFile(); } catch { return false; }
}

/**
 * Why a global config file (agents.yml) isn't safe to
 * trust, or null. On a machine several people share (a team DGX Spark),
 * each person has their own OS account, and these files are what bind a
 * subscription to its owner and an API key to its endpoint: if another
 * account can rewrite yours, it can point your key at its own base_url or
 * run its jobs as your subscription. So the file must be owned by the
 * account reading it and writable by nobody else. POSIX only; Windows ACLs
 * don't map onto mode bits.
 */
export function privateConfigProblem(filePath, { platform = process.platform, uid = process.getuid?.() } = {}) {
  if (platform === "win32" || uid === undefined) return null;
  let st;
  try { st = fs.statSync(filePath); } catch { return null; }
  if (st.uid !== uid) return `${filePath} is owned by another account (uid ${st.uid}); nomArmy only trusts global config its own OS user owns -- each person on a shared machine keeps their own`;
  if (st.mode & 0o022) return `${filePath} is writable by other accounts (mode ${(st.mode & 0o777).toString(8)}); run \`chmod go-w ${filePath}\` -- on a shared machine anyone who can edit it can redirect your credentials`;
  return null;
}

/** True when git tracks this file (committed or force-added past .gitignore). No git or no repo -> false. */
export function isTrackedByGit(filePath) {
  const result = spawnSync("git", ["ls-files", "--error-unmatch", "--", path.basename(filePath)], { cwd: path.dirname(filePath), stdio: "ignore" });
  return result.status === 0;
}

const roleSchema = z.object({
  // Capped because it is prepended to the worker's brief on every dispatch.
  description: z.string().min(1).max(800, "must be at most 800 characters (it is prepended to every brief for this role)").optional(),
  phase: z.enum(ARMY_PHASES).optional(),
  mode: z.enum(["implement", "scout"]).optional(),
  agent: z.string().regex(NAME_RE, "must name an agent from agents.yml").optional(),
  // A model id on that agent, or "auto" to let the General pick per job.
  // Omitted, the agent's own default model applies.
  model: z.string().regex(/^\S{1,200}$/, "must be a model id, or auto").optional(),
  disabled: z.boolean().optional(),
}).strict();

const positiveNumber = () => z.number({ invalid_type_error: "must be a number" }).positive("must be positive");
// Limits on one /feature run (lib/runs.mjs). Personal, like the General:
// global or local only, never a committed project file.
const runLimitsSchema = z.object({
  max_jobs: positiveNumber().int("must be a whole number").optional(),
  max_api_usd: positiveNumber().optional(),
  max_hours: positiveNumber().optional(),
  warn_at: z.number().gt(0).lt(1, "is a share of the limit, e.g. 0.8").optional(),
}).strict();

export const armySchema = z.object({
  general: z.string().regex(NAME_RE, "must name the agent from agents.yml that your coordinator session runs on").optional(),
  run_limits: runLimitsSchema.optional(),
  workflow: z.string().min(1).max(4000).optional(),
  roles: z.record(z.string().regex(ROLE_NAME_RE, "role names are lowercase letters, digits and hyphens, starting with a letter"), roleSchema).optional(),
}).strict();

export class ArmyConfigError extends Error {
  constructor(message, { path: filePath = null, errors = [] } = {}) {
    super(message);
    this.name = "ArmyConfigError";
    this.path = filePath;
    this.errors = errors;
  }
}

function formatIssues(error) {
  return error.issues.map((issue) => {
    const where = issue.path.length ? issue.path.join(".") : "config";
    if (issue.code === "unrecognized_keys") {
      const keys = issue.keys.map((k) => `"${k}"`).join(", ");
      return `${where}: unexpected field(s) ${keys} (army files can only select agents; credentials, endpoints and owners belong in your global agents.yml)`;
    }
    return `${where}: ${issue.message}`;
  });
}

// The global and local files hold only `army:` for now (the global one is
// where machine-level settings such as the local model will move later);
// strict, so a typo'd key is an error rather than silently ignored. The
// project file is .nomarmy.yml, whose other sections lib/schema.mjs owns.
const armyOnlyFileSchema = z.object({ army: armySchema.optional() }).strict();

/** Parse one layer's file and validate its `army:` section. Missing file or no section -> null. */
export function readArmyFile(filePath, { armyOnly = false } = {}) {
  if (!isFile(filePath)) return null;
  let parsed;
  try {
    parsed = YAML.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new ArmyConfigError(`${filePath} is not valid YAML: ${error.message}`, { path: filePath, errors: [`config: is not valid YAML: ${error.message}`] });
  }
  const doc = parsed ?? {};
  const result = armyOnly ? armyOnlyFileSchema.safeParse(doc) : armySchema.optional().safeParse(doc.army);
  if (result.success) return (armyOnly ? result.data.army : result.data) ?? null;
  const errors = formatIssues(result.error).map((line) => (armyOnly ? line : `army.${line}`));
  throw new ArmyConfigError(`${filePath} has an invalid army section:\n${errors.map((l) => `  - ${l}`).join("\n")}`, { path: filePath, errors });
}

/**
 * Merge layers (lowest first). Fields merge one at a time, so a project
 * file can reassign a role without restating its description.
 * @param {{ layer: string, path: string|null, army: object|null }[]} layers
 */
export function mergeArmy(layers) {
  const merged = { general: null, workflow: null, runLimits: {}, roles: {} };
  const sources = { general: null, workflow: null, runLimits: {}, roles: {} };
  for (const { layer, army } of layers) {
    if (!army) continue;
    if (army.general) { merged.general = army.general; sources.general = layer; }
    for (const [k, v] of Object.entries(army.run_limits ?? {})) { merged.runLimits[k] = v; sources.runLimits[k] = layer; }
    if (army.workflow) { merged.workflow = army.workflow; sources.workflow = layer; }
    for (const [name, role] of Object.entries(army.roles ?? {})) {
      const into = merged.roles[name] ?? (merged.roles[name] = {});
      const from = sources.roles[name] ?? (sources.roles[name] = {});
      for (const [field, value] of Object.entries(role)) {
        into[field] = value;
        from[field] = layer;
      }
    }
  }
  for (const [name, role] of Object.entries(merged.roles)) {
    if (role.disabled) { delete merged.roles[name]; delete sources.roles[name]; }
  }
  return { army: merged, sources };
}

/** Read every layer and merge. Throws ArmyConfigError naming the bad file. */
export function loadArmy({ projectDir, env = process.env }) {
  const layers = [];
  for (const layer of ARMY_LAYERS) {
    const filePath = armyLayerPath(layer, { projectDir, env });
    // The local layer is one person's overrides. A tracked copy is shared
    // with everyone who pulls, so it's refused rather than quietly used.
    if (layer === "local" && isFile(filePath) && isTrackedByGit(filePath)) {
      throw new ArmyConfigError(`${filePath} is tracked by git, so it isn't local: everyone who pulls gets it. Run \`git rm --cached ${LOCAL_CONFIG_FILENAME}\` and keep it in .gitignore, or move shared choices to .nomarmy.yml.`, { path: filePath });
    }
    const army = readArmyFile(filePath, { armyOnly: layer !== "project" });
    // Who the General is and what a run may spend are one person's choices;
    // a committed .nomarmy.yml is anyone's who can push to the repo.
    for (const personal of ["general", "run_limits"]) {
      if (layer === "project" && army?.[personal] !== undefined) {
        throw new ArmyConfigError(`${filePath} sets army.${personal}, which is personal: set it in ~/.config/nomarmy/config.yml or .nomarmy.local.yml, never in the committed project file.`, { path: filePath });
      }
    }
    layers.push({ layer, path: filePath, army });
  }
  return { ...mergeArmy(layers), layers: layers.map(({ layer, path: p, army }) => ({ layer, path: p, found: Boolean(army) })) };
}

/** ("codex", "gpt-6-astra"|"auto"|undefined) -> { agent, model? }; "none" -> {} (unassigned). */
export function parseTargetSpec(spec, model) {
  const text = String(spec ?? "").trim();
  if (text === "none") {
    if (model) throw new Error("none unassigns the role, so it takes no model");
    return {};
  }
  if (!NAME_RE.test(text)) throw new Error(`"${text}" is not an agent name (see \`nomarmy agents list\`), or "none" to unassign`);
  if (model !== undefined && !/^\S{1,200}$/.test(String(model))) throw new Error(`"${model}" is not a model id (or auto)`);
  return model ? { agent: text, model: String(model) } : { agent: text };
}

/**
 * Problems with each role's agent against the agents defined globally: a
 * name that doesn't exist, or none at all. Returned per role rather than
 * thrown, so `army show` can list them all.
 */
export function armyTargetProblems(army, agents = {}) {
  const problems = {};
  for (const [name, role] of Object.entries(army.roles)) {
    const agent = role.agent && Object.prototype.hasOwnProperty.call(agents, role.agent) ? agents[role.agent] : null;
    if (!role.agent) problems[name] = "no agent assigned";
    else if (!agent) problems[name] = `agent "${role.agent}" is not defined in your agents.yml`;
    else if (agent.kind === "local" && role.model) problems[name] = `agent "${role.agent}" is the local model, so the role's model "${role.model}" can't apply (\`nomarmy model\` sets it)`;
    else if (agent.kind !== "local" && !role.model && !agent.model) problems[name] = `agent "${role.agent}" has no default model, so this role needs one: \`nomarmy army assign ${name} ${role.agent} <model|auto>\``;
  }
  return problems;
}

/**
 * Turn a job's `army_role` into `agent: <that role's agent>`, with the
 * role's description at the top of the task so the worker knows which hat
 * it's wearing. Refuses (throws) rather than falling back: an unknown
 * role, an unassigned one, or a job that also names its own agent.
 */
export function expandArmyRole(args, army) {
  if (!args.army_role) return args;
  if (args.agent) throw new Error(`army_role picks the agent itself; drop agent "${args.agent}" from this job, or drop army_role`);
  const role = Object.prototype.hasOwnProperty.call(army.roles, args.army_role) ? army.roles[args.army_role] : undefined;
  if (!role) {
    const known = Object.keys(army.roles);
    throw new Error(known.length ? `unknown army_role "${args.army_role}" -- this repo's roles are: ${known.join(", ")}` : `unknown army_role "${args.army_role}" -- no army is configured (run \`nomarmy army init\`)`);
  }
  if (!role.agent) throw new Error(`army_role "${args.army_role}" has no agent assigned -- run \`nomarmy army assign ${args.army_role} <agent>\``);
  const { army_role: roleName, ...rest } = args;
  const header = `[nomArmy role: ${roleName}${role.phase ? `, ${role.phase} phase` : ""}]${role.description ? `\n${role.description}` : ""}`;
  return { ...rest, task: `${header}\n\n${args.task}`, agent: role.agent, armyRole: roleName, roleModel: role.model ?? null };
}

/**
 * Change a layer file's `army:` section in place: `mutate(army)` gets the
 * current section (or {}) and returns the new one. Uses YAML's document
 * API so every other section of .nomarmy.yml, and every comment, survives.
 */
export function updateArmyInFile(filePath, mutate) {
  const text = isFile(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) throw new ArmyConfigError(`${filePath} is not valid YAML: ${doc.errors[0].message}`, { path: filePath });
  const current = doc.toJS()?.army ?? {};
  const next = mutate(structuredClone(current));
  const result = armySchema.safeParse(next);
  if (!result.success) {
    const errors = formatIssues(result.error);
    throw new ArmyConfigError(`refusing to write an invalid army section:\n${errors.map((l) => `  - ${l}`).join("\n")}`, { path: filePath, errors });
  }
  if (doc.contents === null) doc.contents = doc.createNode({});
  doc.set("army", doc.createNode(result.data));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, String(doc));
  return result.data;
}

/** Point one role at an agent (fields from parseTargetSpec) in one layer file. */
export function assignRoleInFile(filePath, roleName, targetFields) {
  if (!ROLE_NAME_RE.test(roleName)) throw new Error(`"${roleName}" is not a valid role name (lowercase letters, digits and hyphens, starting with a letter)`);
  return updateArmyInFile(filePath, (army) => {
    const roles = army.roles ?? (army.roles = {});
    const role = roles[roleName] ?? (roles[roleName] = {});
    delete role.agent;
    delete role.model;
    Object.assign(role, targetFields);
    return army;
  });
}

/** The default army, from the operator's own description of how it runs. */
export const DEFAULT_ARMY = Object.freeze({
  workflow: [
    "Not every role runs every time; the General calls only the ones the work needs.",
    "1. Build: the Sr Dev does the first cut, handing simple work to Jr Devs while keeping the harder implementation that needs more reasoning. UI work goes to UI/UX.",
    "2. Review: once the General is told the build is done, it calls the specialists who apply (data architect, security analyst).",
    "3. The PM reviews the work against the plan.",
    "4. Acceptance: the PO and stakeholders test end to end.",
  ].join("\n"),
  roles: {
    "sr-dev": { phase: "build", mode: "implement", agent: "local", description: "Senior developer. Does the first cut, keeps the harder implementation that needs more reasoning, and splits out simple, well-specified pieces for Jr Devs." },
    "jr-dev": { phase: "build", mode: "implement", agent: "local", description: "Junior developer. Takes simple, well-specified work handed off by the Sr Dev: mechanical changes, tests, docs, repetitive edits." },
    "ui-ux": { phase: "build", mode: "implement", agent: "local", description: "UI/UX. Handed UI work: components, layout, styling, interaction and accessibility." },
    "data-architect": { phase: "review", mode: "scout", agent: "local", description: "Data architect. Reviews data work from a star schema / medallion (bronze, silver, gold) perspective: grain, keys, conformed dimensions, slowly changing dimensions, and clean layer boundaries." },
    "security-analyst": { phase: "review", mode: "scout", agent: "local", description: "Security analyst. Reviews from a security perspective: authentication and authorization, input handling and injection, secrets, data exposure, and dependency risk." },
    pm: { phase: "review", mode: "scout", agent: "local", description: "Project manager. Reviews the work against the plan and its acceptance criteria: what's done, what's missing, and what crept in out of scope." },
    po: { phase: "acceptance", mode: "implement", agent: "local", description: "Product owner. Tests end to end against the user story: does it do what the user needs? Writes or runs e2e checks and reports gaps." },
    stakeholder: { phase: "acceptance", mode: "implement", agent: "local", description: "Stakeholder. Exercises the finished feature end to end the way a real user would, and reports anything confusing, broken or missing." },
  },
});

/**
 * Roles that aren't independent of the General: on the very same agent
 * (the General reviewing its own model's work), or on a subscription with
 * the same provider and owner (drawing from the General's usage limit).
 */
export function generalOverlap(army, agents = {}) {
  const general = army.general && agents[army.general];
  const out = {};
  if (!general) return out;
  for (const [name, role] of Object.entries(army.roles)) {
    const agent = role.agent && agents[role.agent];
    if (!agent) continue;
    if (role.agent === army.general) out[name] = `runs on the General's own agent "${army.general}": its work isn't independently reviewed, and it shares the General's usage`;
    else if (agent.kind === "subscription" && general.kind === "subscription" && agent.provider === general.provider && agent.owner === general.owner) {
      out[name] = `shares the General's ${agent.provider} login (${agent.owner}), so it draws from the same usage limit`;
    }
  }
  return out;
}

/**
 * The merged army as the General sees it (the `army` MCP tool and
 * `nomarmy army show --json` return exactly this): the General's fixed
 * charter and the agent it's defined as, the workflow, then each role's
 * description, phase, suggested mode, agent, any problem or overlap with
 * the General, and which layer set each field.
 */
export function describeArmy(loaded, { agents = {}, describeAgent = null } = {}) {
  const army = loaded.army;
  const problems = armyTargetProblems(army, agents);
  const overlap = generalOverlap(army, agents);
  const runsOn = (name) => (name && agents[name] && describeAgent ? describeAgent(agents[name]) : null);
  // A subscription whose owner isn't the General's own is worth a word,
  // not a refusal: it may be the same person's other account (a real Senti
  // General skipped a role's agent for exactly this, unsure whose it was).
  const generalAgent = army.general && agents[army.general];
  const ownerNote = (name) => {
    const agent = name && agents[name];
    if (agent?.kind !== "subscription" || generalAgent?.kind !== "subscription" || agent.owner === generalAgent.owner) return null;
    return `subscription owned by ${agent.owner}, not the General's own ${generalAgent.owner}; jobs on it need on_behalf_of "${agent.owner}". If that's the operator's own other account, it's fine to use.`;
  };
  const roles = Object.fromEntries(Object.entries(army.roles).map(([name, role]) => [name, {
    description: role.description ?? null, phase: role.phase ?? null, mode: role.mode ?? null,
    agent: role.agent ?? null, model: role.model ?? agents[role.agent]?.model ?? null, modelIsAuto: role.model === "auto",
    agentRunsOn: runsOn(role.agent),
    problem: problems[name] ?? null, overlapsGeneral: overlap[name] ?? null, ownerNote: ownerNote(role.agent), setBy: loaded.sources.roles[name],
  }]));
  const generalProblem = !army.general
    ? "not defined -- run `nomarmy army general <agent>` so nomArmy can flag roles that share the General's model or usage"
    : !Object.prototype.hasOwnProperty.call(agents, army.general) ? `agent "${army.general}" is not defined in your agents.yml` : null;
  return {
    general: { ...GENERAL, agent: army.general, agentRunsOn: runsOn(army.general), problem: generalProblem, setBy: loaded.sources.general },
    workflow: army.workflow,
    runLimits: army.runLimits ?? {},
    roles,
    layers: loaded.layers,
    howToDispatch: Object.keys(roles).length
      ? "Pass army_role: \"<role>\" on a job (plus on_behalf_of when its agent is a subscription). The role's description goes at the top of the brief; set `mode` on the job yourself, the role's is only a suggestion. A role with model \"auto\" needs model on the job, picked from that agent's models below; any job may pass model to override the role's. Use agent: \"<name>\" instead to pick an agent directly."
      : "No army is configured. Run `nomarmy army init` for the default roster, or dispatch with agent: \"<name>\".",
  };
}
