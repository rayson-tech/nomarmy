// nomArmy's army: who the General (the coordinator session) calls for what.
//
// The General is the Claude Code / Codex session itself. It plans, briefs,
// dispatches, reviews and accepts, runs outside every sandbox, and is never
// a worker, so it has a description here but no target. Every other role
// is open to interpretation: a name, a description of when the General
// calls it, the phase it belongs to, and which agent handles it (one
// subscription worker, one pool, or the local model).
//
// Layers merge the way Claude Code's settings do, lowest to highest, each
// under an `army:` key:
//   subscriptions.yml  legacy `role:` fields on subscription workers
//   global             ~/.config/nomarmy/config.yml
//   project            <repo>/.nomarmy.yml         (committed, beside verification)
//   local              <repo>/.nomarmy.local.yml   (gitignored)
//
// Security boundary: a project file is repository content, and a cloned
// repo is not trusted. So army files can only SELECT among workers and
// pools defined globally; the schema has no field for a credential, an
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
export const ARMY_LAYERS = Object.freeze(["subscriptions", "global", "project", "local"]);
export const ROLE_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
const TARGET_FIELDS = Object.freeze(["worker", "pool", "local"]);
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

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
 * Why a global config file (providers.yml, subscriptions.yml) isn't safe to
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
  worker: z.string().regex(NAME_RE, "must name a subscription worker").optional(),
  pool: z.string().regex(NAME_RE, "must name a pool").optional(),
  local: z.enum(["coder", "gpt"]).optional(),
  disabled: z.boolean().optional(),
}).strict().superRefine((role, ctx) => {
  const set = TARGET_FIELDS.filter((f) => role[f] !== undefined);
  if (set.length > 1) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `sets ${set.join(" and ")}; a role goes to exactly one of worker, pool or local` });
});

export const armySchema = z.object({
  general: z.object({ description: z.string().min(1).max(2000).optional() }).strict().optional(),
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
    if (issue.code === "unrecognized_keys") return `${where}: unexpected field(s) ${issue.keys.map((k) => `"${k}"`).join(", ")} (army files can only select agents; credentials, endpoints and owners belong in global providers.yml / subscriptions.yml)`;
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

/** Legacy `role:` fields in subscriptions.yml, as the lowest army layer. */
export function subscriptionRolesLayer(subscriptionLoaded) {
  const roles = {};
  for (const [name, entry] of Object.entries(subscriptionLoaded?.config?.workers ?? {})) {
    if (entry.role && ROLE_NAME_RE.test(entry.role)) roles[entry.role] = { worker: name };
  }
  return { roles };
}

/**
 * Merge layers (lowest first). Fields merge one at a time, so a project
 * file can reassign a role without restating its description. The three
 * target fields move as one unit: setting `pool` in a higher layer clears
 * a lower layer's `worker`, never combines with it.
 * @param {{ layer: string, path: string|null, army: object|null }[]} layers
 */
export function mergeArmy(layers) {
  const merged = { general: {}, workflow: null, roles: {} };
  const sources = { general: null, workflow: null, roles: {} };
  for (const { layer, army } of layers) {
    if (!army) continue;
    if (army.general?.description) { merged.general.description = army.general.description; sources.general = layer; }
    if (army.workflow) { merged.workflow = army.workflow; sources.workflow = layer; }
    for (const [name, role] of Object.entries(army.roles ?? {})) {
      const into = merged.roles[name] ?? (merged.roles[name] = {});
      const from = sources.roles[name] ?? (sources.roles[name] = {});
      if (TARGET_FIELDS.some((f) => role[f] !== undefined)) {
        for (const f of TARGET_FIELDS) { delete into[f]; delete from[f]; }
      }
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
export function loadArmy({ projectDir, subscriptionLoaded = null, env = process.env }) {
  const layers = [{ layer: "subscriptions", path: subscriptionLoaded?.path ?? null, army: subscriptionRolesLayer(subscriptionLoaded) }];
  for (const layer of ["global", "project", "local"]) {
    const filePath = armyLayerPath(layer, { projectDir, env });
    // The local layer is one person's overrides. A tracked copy is shared
    // with everyone who pulls, so it's refused rather than quietly used.
    if (layer === "local" && isFile(filePath) && isTrackedByGit(filePath)) {
      throw new ArmyConfigError(`${filePath} is tracked by git, so it isn't local: everyone who pulls gets it. Run \`git rm --cached ${LOCAL_CONFIG_FILENAME}\` and keep it in .gitignore, or move shared choices to .nomarmy.yml.`, { path: filePath });
    }
    layers.push({ layer, path: filePath, army: readArmyFile(filePath, { armyOnly: layer !== "project" }) });
  }
  return { ...mergeArmy(layers), layers: layers.map(({ layer, path: p, army }) => ({ layer, path: p, found: Boolean(army) && (layer !== "subscriptions" || Object.keys(army.roles).length > 0) })) };
}

/** A role's target as { kind, name } or null when unassigned. */
export function roleTarget(role) {
  if (role?.worker) return { kind: "worker", name: role.worker };
  if (role?.pool) return { kind: "pool", name: role.pool };
  if (role?.local) return { kind: "local", name: role.local };
  return null;
}

/** "worker:jason-codex" / "pool:cheap" / "local" / "local:gpt" / "none" -> role fields, or throws. */
export function parseTargetSpec(spec) {
  const text = String(spec ?? "").trim();
  if (text === "none") return {};
  if (text === "local") return { local: "coder" };
  const match = /^(worker|pool|local):(.+)$/.exec(text);
  if (!match) throw new Error(`target "${text}" must be worker:<name>, pool:<name>, local, local:gpt, or none`);
  const [, kind, name] = match;
  if (kind === "local" && !["coder", "gpt"].includes(name)) throw new Error(`local target must be local:coder or local:gpt, not "${text}"`);
  if (kind !== "local" && !NAME_RE.test(name)) throw new Error(`"${name}" is not a valid ${kind} name`);
  return { [kind]: name };
}

/**
 * Problems with each role's target against the globally defined workers
 * and pools: a name that doesn't exist, or no target at all. Returned per
 * role rather than thrown, so `army show` can list them all.
 */
export function armyTargetProblems(army, { subscriptionLoaded = null, dispatchLoaded = null } = {}) {
  const problems = {};
  for (const [name, role] of Object.entries(army.roles)) {
    const target = roleTarget(role);
    if (!target) problems[name] = "no agent assigned";
    else if (target.kind === "worker" && !Object.prototype.hasOwnProperty.call(subscriptionLoaded?.config?.workers ?? {}, target.name)) problems[name] = `subscription worker "${target.name}" is not defined in your global subscriptions.yml`;
    else if (target.kind === "pool" && !Object.prototype.hasOwnProperty.call(dispatchLoaded?.config?.pools ?? {}, target.name)) problems[name] = `pool "${target.name}" is not defined in your global providers.yml`;
  }
  return problems;
}

/**
 * Turn a job's `army_role` into the concrete dispatch fields every
 * downstream path already understands, plus the role's description at the
 * top of the task so the worker knows which hat it's wearing. Refuses
 * (throws) rather than falling back: an unknown role, an unassigned one, or
 * a job that also picks its own agent.
 */
export function expandArmyRole(args, army) {
  if (!args.army_role) return args;
  const clash = ["pool", "subscription_worker", "subscription_role"].filter((f) => args[f]);
  if (clash.length) throw new Error(`army_role picks the agent itself; drop ${clash.join(" and ")} from this job`);
  const role = Object.prototype.hasOwnProperty.call(army.roles, args.army_role) ? army.roles[args.army_role] : undefined;
  if (!role) {
    const known = Object.keys(army.roles);
    throw new Error(known.length ? `unknown army_role "${args.army_role}" -- this repo's roles are: ${known.join(", ")}` : `unknown army_role "${args.army_role}" -- no army is configured (run \`nomarmy army init\`)`);
  }
  const target = roleTarget(role);
  if (!target) throw new Error(`army_role "${args.army_role}" has no agent assigned -- run \`nomarmy army assign ${args.army_role} <worker:NAME|pool:NAME|local>\``);
  const { army_role: roleName, ...rest } = args;
  const header = `[nomArmy role: ${roleName}${role.phase ? `, ${role.phase} phase` : ""}]${role.description ? `\n${role.description}` : ""}`;
  const expanded = { ...rest, task: `${header}\n\n${args.task}`, armyRole: roleName };
  // on_behalf_of only means something for a subscription worker, and the
  // General can't know which roles are subscription-backed in every repo,
  // so it's dropped (not refused) when the role runs on a pool or locally.
  if (target.kind === "worker") expanded.subscription_worker = target.name;
  else if (target.kind === "pool") { expanded.pool = target.name; delete expanded.on_behalf_of; }
  else { expanded.profile = target.name; delete expanded.on_behalf_of; }
  return expanded;
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

/** Point one role at a target (fields from parseTargetSpec) in one layer file, clearing that layer's other target fields. */
export function assignRoleInFile(filePath, roleName, targetFields) {
  if (!ROLE_NAME_RE.test(roleName)) throw new Error(`"${roleName}" is not a valid role name (lowercase letters, digits and hyphens, starting with a letter)`);
  return updateArmyInFile(filePath, (army) => {
    const roles = army.roles ?? (army.roles = {});
    const role = roles[roleName] ?? (roles[roleName] = {});
    for (const f of TARGET_FIELDS) delete role[f];
    Object.assign(role, targetFields);
    return army;
  });
}

/** The default army, from the operator's own description of how it runs. */
export const DEFAULT_ARMY = Object.freeze({
  general: {
    description: "The General runs the nomArmy: it plans, briefs, dispatches, reviews and accepts. It is the coordinator session itself, outside every sandbox, and never a worker.",
  },
  workflow: [
    "Not every role runs every time; the General calls only the ones the work needs.",
    "1. Build: the Sr Dev does the first cut, handing simple work to Jr Devs while keeping the harder implementation that needs more reasoning. UI work goes to UI/UX.",
    "2. Review: once the General is told the build is done, it calls the specialists who apply (data architect, security analyst).",
    "3. The PM reviews the work against the plan.",
    "4. Acceptance: the PO and stakeholders test end to end.",
  ].join("\n"),
  roles: {
    "sr-dev": { phase: "build", mode: "implement", local: "coder", description: "Senior developer. Does the first cut, keeps the harder implementation that needs more reasoning, and splits out simple, well-specified pieces for Jr Devs." },
    "jr-dev": { phase: "build", mode: "implement", local: "coder", description: "Junior developer. Takes simple, well-specified work handed off by the Sr Dev: mechanical changes, tests, docs, repetitive edits." },
    "ui-ux": { phase: "build", mode: "implement", local: "coder", description: "UI/UX. Handed UI work: components, layout, styling, interaction and accessibility." },
    "data-architect": { phase: "review", mode: "scout", local: "coder", description: "Data architect. Reviews data work from a star schema / medallion (bronze, silver, gold) perspective: grain, keys, conformed dimensions, slowly changing dimensions, and clean layer boundaries." },
    "security-analyst": { phase: "review", mode: "scout", local: "coder", description: "Security analyst. Reviews from a security perspective: authentication and authorization, input handling and injection, secrets, data exposure, and dependency risk." },
    pm: { phase: "review", mode: "scout", local: "coder", description: "Project manager. Reviews the work against the plan and its acceptance criteria: what's done, what's missing, and what crept in out of scope." },
    po: { phase: "acceptance", mode: "implement", local: "coder", description: "Product owner. Tests end to end against the user story: does it do what the user needs? Writes or runs e2e checks and reports gaps." },
    stakeholder: { phase: "acceptance", mode: "implement", local: "coder", description: "Stakeholder. Exercises the finished feature end to end the way a real user would, and reports anything confusing, broken or missing." },
  },
});

/**
 * The merged army as the General sees it (the `army` MCP tool and
 * `nomarmy army show --json` return exactly this): each role's description,
 * phase, suggested mode, agent, any problem, and which layer set each field.
 */
export function describeArmy(loaded, { subscriptionLoaded = null, dispatchLoaded = null } = {}) {
  const problems = armyTargetProblems(loaded.army, { subscriptionLoaded, dispatchLoaded });
  const roles = Object.fromEntries(Object.entries(loaded.army.roles).map(([name, role]) => [name, {
    description: role.description ?? null, phase: role.phase ?? null, mode: role.mode ?? null,
    agent: roleTarget(role), problem: problems[name] ?? null, setBy: loaded.sources.roles[name],
  }]));
  return {
    general: loaded.army.general.description ?? null,
    workflow: loaded.army.workflow,
    roles,
    layers: loaded.layers,
    howToDispatch: Object.keys(roles).length
      ? "Pass army_role: \"<role>\" on a job (plus on_behalf_of when its agent is a subscription worker). The role's description goes at the top of the brief; set `mode` on the job yourself, the role's is only a suggestion."
      : "No army is configured. Run `nomarmy army init` for the default roster.",
  };
}
