// nomArmy agents: every model a job can run on, in one list.
//
// ~/.config/nomarmy/agents.yml names each agent and says how to reach it:
//
//   local         the local llama-server model (built in as `local`, even
//                 with no file at all)
//   api           a metered API key (xai, openai, a generic OpenClaw
//                 provider, a custom endpoint, ...), registered with
//                 OpenClaw once and read from auth_env at dispatch
//   subscription  ONE person's own subscription (Claude via claude-cli, a
//                 ChatGPT plan via openai, Meta Muse Code via meta). Never
//                 pooled: a job must name the agent's owner in on_behalf_of.
//
// An api or subscription agent is an ACCOUNT, not a model: `model` on it
// is only a default. The model a job runs is, first to last: the job's own
// `model` (the General's choice), the role's `model` (unless it's "auto",
// which leaves it to the General), then the agent's default. No model at
// all is refused, never guessed.
//
// Roles (lib/army.mjs) point at agents by name; a job picks an agent by
// role (`army_role`) or directly (`agent`). Nothing chooses between agents
// at random.
//
// Internally an api agent is a one-entry pool and a subscription agent a
// subscription worker (agentsAsDispatchConfig / agentsAsSubscriptionConfig),
// so the execution path in mcp/server.mjs, which predates this file, runs
// unchanged.

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

import { providerEntrySchema, formatDispatchIssues, openclawProviderId, PROVIDER_TYPES, ID_RE, HOST_TOOL_PROVIDERS, agentRunsToolsOnHost } from "./dispatch-schema.mjs";

export { HOST_TOOL_PROVIDERS, agentRunsToolsOnHost };
import { findProviderConflicts, describeProviderConflict } from "./subscription-config.mjs";
import { privateConfigProblem } from "./army.mjs";

export const AGENTS_FILENAME = "agents.yml";
export const AGENT_KINDS = Object.freeze(["local", "api", "subscription"]);
export const API_PROVIDER_TYPES = Object.freeze(PROVIDER_TYPES.filter((t) => t !== "llama-cpp"));
export const RESERVED_AGENT_NAMES = Object.freeze(["__proto__", "constructor", "prototype"]);
/** Always present, even with no agents.yml: the local model's default slot. */
export const BUILTIN_LOCAL_AGENT = Object.freeze({ kind: "local", slot: "coder" });

const requiredString = () =>
  z.string({ required_error: "is required", invalid_type_error: "must be a string" })
    .refine((value) => value.trim().length > 0, { message: "must not be empty" });
const thinkingSchema = z.union([z.boolean(), z.enum(["low", "medium", "high"])]).default(true);
const positiveInt = () => z.number({ invalid_type_error: "must be a number" }).int("must be a whole number").positive("must be a positive number");

const localAgentSchema = z.object({
  kind: z.literal("local"),
  // coder = NOMARMY_WORKER_MODEL, gpt = NOMARMY_WORKER_MODEL_FALLBACK
  // (config/common.env). The same model today unless one is swapped.
  slot: z.enum(["coder", "gpt"]).default("coder"),
}).strict();

// Shape-checked here; the per-provider rules (base_url for custom
// endpoints, openclaw_provider for the generic type) come from
// providerEntrySchema in agentsFileSchema's superRefine, so they exist once.
const apiAgentSchema = z.object({
  kind: z.literal("api"),
  provider: z.enum(API_PROVIDER_TYPES, { errorMap: () => ({ message: `must be one of ${API_PROVIDER_TYPES.join(", ")}` }) }),
  model: requiredString().optional(),
  auth_env: requiredString(),
  base_url: z.string().optional(),
  openclaw_provider: z.string().optional(),
  plugin: z.string().optional(),
  max_concurrent: positiveInt().default(2),
  thinking: thinkingSchema,
  context_window: positiveInt().optional(),
}).strict();

const subscriptionAgentSchema = z.object({
  kind: z.literal("subscription"),
  provider: requiredString(),
  model: requiredString().optional(),
  owner: requiredString(),
  // 1, not an API agent's 2: a personal session was never provisioned for
  // concurrent automation.
  max_concurrent: positiveInt().default(1),
  thinking: thinkingSchema,
  context_window: positiveInt().optional(),
  // An explicit yes to implement jobs on a provider whose own tools run on
  // this machine (hostToolProvider below). Off unless set.
  allow_host_tools: z.boolean().optional(),
}).strict();

/** Why an implement job can't run on this agent, or null. */
export function hostToolsImplementProblem(name, agent) {
  if (!agentRunsToolsOnHost(agent) || agent.allow_host_tools === true) return null;
  return `agent "${name}" (${agent.provider}) runs its own tools on this machine, outside nomArmy's sandbox: its shell has your files and the network, so an implement job on it isn't bounded the way nomArmy promises. Use it for scout or review work, move the role to a sandboxed agent (codex, an api key, or local), or set allow_host_tools: true on "${name}" in agents.yml to accept that.`;
}

export const agentSchema = z.discriminatedUnion("kind", [localAgentSchema, apiAgentSchema, subscriptionAgentSchema], {
  errorMap: (issue, ctx) => (issue.code === "invalid_union_discriminator" ? { message: `kind must be one of ${AGENT_KINDS.join(", ")}` } : { message: ctx.defaultError }),
});

/** An api agent as the pool entry the dispatch path understands. `model` may be absent (see resolveAgentModel). */
export function apiAgentAsPoolEntry(name, agent) {
  const { kind, ...fields } = agent;
  return { id: name, weight: 1, ...fields };
}

// providerEntrySchema requires a model; an agent with no default model is
// validated with this stand-in, which never reaches a dispatch.
const MODEL_STANDIN = "model-chosen-per-role";

export const agentsFileSchema = z.object({
  agents: z.record(z.string().regex(ID_RE, "agent names are 1-64 letters, numbers, dot, underscore or hyphen"), agentSchema).default({}),
}).strict().superRefine((data, ctx) => {
  const pools = {}, workers = {};
  for (const [name, agent] of Object.entries(data.agents)) {
    if (agent.kind === "api") {
      const entry = apiAgentAsPoolEntry(name, agent);
      const result = providerEntrySchema.safeParse(entry.model ? entry : { ...entry, model: MODEL_STANDIN });
      if (!result.success) {
        for (const line of formatDispatchIssues(result.error)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["agents", name], message: line.replace(/^config: /, "") });
        }
      } else {
        pools[name] = [result.data];
      }
    } else if (agent.kind === "subscription") {
      workers[name] = agent;
    }
  }
  // OpenAI, Meta and xAI keep their subscription login and their API key
  // under one OpenClaw provider id, so an api and a subscription agent on
  // the same id would be ambiguous about which credential runs.
  for (const conflict of findProviderConflicts(pools, workers)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["agents", conflict.workers[0]], message: describeProviderConflict(conflict) });
  }
});

export class AgentsConfigError extends Error {
  constructor(message, { path: filePath = null, errors = [] } = {}) {
    super(message);
    this.name = "AgentsConfigError";
    this.path = filePath;
    this.errors = errors;
  }
}

export function formatAgentIssues(error) {
  const lines = error.issues.map((issue) => {
    const where = issue.path.length ? issue.path.join(".") : "config";
    if (issue.code === "unrecognized_keys") return `${where}: unexpected field(s) ${issue.keys.map((k) => `"${k}"`).join(", ")}`;
    if (issue.code === "invalid_type" && issue.received === "undefined") return `${where}: is required`;
    return `${where}: ${issue.message}`;
  });
  return [...new Set(lines)];
}

export function agentsConfigPath(configDir) {
  return path.join(configDir, AGENTS_FILENAME);
}

/** Validate a candidate `{ agents }` object; returns { ok, data } or { ok: false, errors }. */
export function validateAgents(candidate) {
  const agents = candidate?.agents;
  if (agents && typeof agents === "object") {
    const reserved = RESERVED_AGENT_NAMES.find((n) => Object.prototype.hasOwnProperty.call(agents, n));
    if (reserved) return { ok: false, errors: [`agents.${reserved}: "${reserved}" is a reserved name`] };
  }
  const result = agentsFileSchema.safeParse(candidate ?? {});
  return result.success ? { ok: true, data: result.data } : { ok: false, errors: formatAgentIssues(result.error) };
}

/**
 * Load agents.yml from `configDir`. A missing file is fine: you still get
 * the built-in `local` agent. Every loaded result includes it unless the
 * file defines its own `local`.
 * @returns {{ found: boolean, path: string, agents: Record<string, object> }}
 */
export function loadAgents(configDir) {
  const filePath = agentsConfigPath(configDir);
  let fileAgents = {};
  let found = false;
  if (fs.existsSync(filePath)) {
    found = true;
    const unsafe = privateConfigProblem(filePath);
    if (unsafe) throw new AgentsConfigError(unsafe, { path: filePath, errors: [`config: ${unsafe}`] });
    let parsed;
    try {
      parsed = YAML.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      throw new AgentsConfigError(`${filePath} is not valid YAML: ${error.message}`, { path: filePath, errors: [`config: is not valid YAML: ${error.message}`] });
    }
    const result = validateAgents(parsed ?? {});
    if (!result.ok) throw new AgentsConfigError(`${filePath} is not valid:\n${result.errors.map((l) => `  - ${l}`).join("\n")}`, { path: filePath, errors: result.errors });
    fileAgents = result.data.agents;
  }
  return { found, path: filePath, agents: { local: { ...BUILTIN_LOCAL_AGENT }, ...fileAgents } };
}

/** The file's own agents (no built-in), for read-modify-write. */
export function readAgentsFile(configDir) {
  const loaded = loadAgents(configDir);
  if (!loaded.found) return {};
  const { local, ...rest } = loaded.agents;
  const raw = YAML.parse(fs.readFileSync(loaded.path, "utf8"))?.agents ?? {};
  return Object.prototype.hasOwnProperty.call(raw, "local") ? loaded.agents : rest;
}

/** Validate and write the whole agents map; returns the parsed result. */
export function writeAgentsFile(configDir, agents) {
  const result = validateAgents({ agents });
  if (!result.ok) throw new AgentsConfigError(`refusing to write invalid agents:\n${result.errors.map((l) => `  - ${l}`).join("\n")}`, { errors: result.errors });
  const filePath = agentsConfigPath(configDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, YAML.stringify(result.data), { mode: 0o600 });
  return result.data.agents;
}

/** The api agents as the `{ found, config: { pools } }` shape resolvePool/pickProvider expect. */
export function agentsAsDispatchConfig(loaded) {
  const pools = {};
  for (const [name, agent] of Object.entries(loaded.agents)) {
    if (agent.kind === "api") pools[name] = [apiAgentAsPoolEntry(name, agent)];
  }
  return { found: true, path: loaded.path, config: { pools } };
}

/** The subscription agents as the `{ found, config: { workers } }` shape resolveSubscriptionWorker expects. */
export function agentsAsSubscriptionConfig(loaded) {
  const workers = {};
  for (const [name, agent] of Object.entries(loaded.agents)) {
    if (agent.kind === "subscription") {
      const { kind, ...fields } = agent;
      workers[name] = fields;
    }
  }
  return { found: true, path: loaded.path, config: { workers } };
}

/** The OpenClaw provider id an agent's models are listed under (null for local). */
export function agentProviderId(agent) {
  if (!agent || agent.kind === "local") return null;
  return agent.kind === "api" ? openclawProviderId(agent) : agent.provider;
}

/**
 * The model a job runs on `name`: the job's own choice, else the role's
 * (unless "auto"), else the agent's default. Returns null for a local
 * agent (its model comes from `nomarmy model`). Throws, naming what to do,
 * when nothing picks one -- a missing model is never guessed.
 */
export function resolveAgentModel(agents, name, { jobModel = null, roleModel = null, roleName = null } = {}) {
  const agent = agents[name];
  if (agent.kind === "local") {
    if (jobModel) throw new Error(`agent "${name}" is the local model, which \`nomarmy model\` sets; drop model "${jobModel}" from this job, or pick an api or subscription agent`);
    return null;
  }
  const model = jobModel ?? (roleModel && roleModel !== "auto" ? roleModel : null) ?? agent.model ?? null;
  if (!model) {
    const why = roleModel === "auto" ? `role "${roleName}" leaves the model to you (auto)` : `agent "${name}" has no default model`;
    throw new Error(`${why}: pass model on this job (the \`army\` tool lists ${name}'s models), or set one with \`nomarmy army assign ${roleName ?? "<role>"} ${name} <model>\``);
  }
  return model;
}

/**
 * The internal dispatch fields for one agent: `profile` for local,
 * `pool` for api, `subscription_worker` for subscription. Throws on an
 * unknown name, listing the ones that exist -- never a fallback.
 */
export function agentDispatchFields(agents, name) {
  const agent = Object.prototype.hasOwnProperty.call(agents, name) ? agents[name] : undefined;
  if (!agent) throw new Error(`unknown agent "${name}" -- your agents are: ${Object.keys(agents).join(", ")} (see \`nomarmy agents list\`)`);
  if (agent.kind === "local") return { profile: agent.slot ?? "coder" };
  if (agent.kind === "api") return { pool: name };
  return { subscription_worker: name };
}

/** A one-line human label: "local model (coder slot)", "api xai/grok-4.7", "subscription openai (you@...), default gpt-6-astra". */
export function describeAgent(agent) {
  if (!agent) return "unknown";
  if (agent.kind === "local") return `local model (${agent.slot ?? "coder"} slot)`;
  const model = agent.model ? `/${agent.model}` : "";
  if (agent.kind === "api") return `api ${openclawProviderId(agent)}${model}${agent.model ? "" : " (model per role)"}`;
  return `subscription ${agent.provider}${model} (${agent.owner})${agent.model ? "" : ", model per role"}${agentRunsToolsOnHost(agent) ? `, tools run on this machine${agent.allow_host_tools ? " (allowed)" : ""}` : ""}`;
}
