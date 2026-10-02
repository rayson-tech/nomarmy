// Optional semantic validators: judgments nomArmy's mechanical checks can't
// make, from a model the operator configures with their own key. Today one:
// Jev, TypeSafe's System One model (https://docs.typesafe.ai).
//
// They only ever add review flags. Diffs and reports are written by the
// worker being judged, and a model can be talked into a verdict (Jev's own
// docs list prompt injection as a weakness), so a validator's answer never
// passes a check, clears a flag or allows a commit. Its worst case is a flag
// it failed to raise.
//
// Off by default, and it sends excerpts of your code to TypeSafe.
//
// ~/.config/nomarmy/validators.yml:
//   jev:
//     enabled: true
//     key_file: ~/.config/nomarmy/secrets/typesafe.key   # or key_env: NAME
//     model: jev-latest
//     checks: [scout-citations, report-claims]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { globalConfigDir } from "./army.mjs";

export const VALIDATORS_FILE = "validators.yml";
export const JEV_CHECKS = Object.freeze(["scout-citations", "report-claims"]);
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/** The same disclosure before saving, in the saved result, and in listings. */
export function validatorTrustDisclosure(validator, vendor) {
  vendor = ({ "claude-cli": "Anthropic", anthropic: "Anthropic", openai: "OpenAI", "openai-codex": "OpenAI", xai: "xAI", meta: "Meta" })[vendor] ?? vendor;
  return `Adding ${validator} also turns on nomArmy's trust judgment in every repository: each implement job's diff, and its brief at dispatch, is sent to ${vendor} to check for security-sensitive changes (access control, removed checks, personal data, secrets, money). It can only raise a job's review level. Turn it off for a repository with trust: { judgment: false } in its .nomarmy.yml.`;
}


const jevSchema = z.object({
  enabled: z.boolean().default(true),
  key_file: z.string().min(1).optional(),
  key_env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "must be an environment variable NAME, never the key itself").optional(),
  model: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).default("jev-latest"),
  checks: z.array(z.enum(JEV_CHECKS)).default([...JEV_CHECKS]),
}).strict().refine((j) => j.key_file || j.key_env, "needs key_file or key_env");

// A model judge (lib/judge.mjs): an agent from agents.yml and a model.
export const JUDGE_CHECK_NAMES = Object.freeze(["acceptance", "report-claims", "test-weakening"]);
const judgeSchema = z.object({
  enabled: z.boolean().default(true),
  agent: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, "must name an agent from agents.yml"),
  model: z.string().regex(/^\S{1,200}$/, "must be a model id"),
  checks: z.array(z.enum(JUDGE_CHECK_NAMES)).default([...JUDGE_CHECK_NAMES]),
  // A judge on an agent whose tools run on this machine (the Claude CLI)
  // reads worker-written text with those tools available: explicit consent.
  host_tools: z.boolean().default(false),
}).strict();

const validatorsSchema = z.object({ jev: jevSchema.optional(), judge: judgeSchema.optional() }).strict();

export function validatorsPath(configDir = globalConfigDir()) {
  return path.join(configDir, VALIDATORS_FILE);
}

export function defaultKeyFile(configDir = globalConfigDir()) {
  return path.join(configDir, "secrets", "typesafe.key");
}

const expandHome = (p) => (p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);

/** The validators config, or {} when there's none. Throws on an invalid file. */
export function loadValidators(configDir = globalConfigDir()) {
  let text;
  try { text = fs.readFileSync(validatorsPath(configDir), "utf8"); } catch { return {}; }
  const parsed = validatorsSchema.safeParse(YAML.parse(text) ?? {});
  if (!parsed.success) throw new Error(`${validatorsPath(configDir)} is not valid: ${parsed.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

/** Jev's settings and key when it's enabled and its key is readable; else null. */
export function jevSettings({ configDir = globalConfigDir(), env = process.env } = {}) {
  let config;
  try { config = loadValidators(configDir).jev; } catch { return null; }
  if (!config?.enabled) return null;
  const key = config.key_env ? String(env[config.key_env] ?? "").trim() : readKeyFile(expandHome(config.key_file));
  return key ? { ...config, key } : null;
}

function readKeyFile(file) {
  try { return fs.readFileSync(file, "utf8").trim() || null; } catch { return null; }
}

/**
 * Save the key where only this user can read it (0600, in a 0700 directory)
 * and enable Jev. The key never goes into validators.yml.
 */
export function saveJevKey(key, { configDir = globalConfigDir(), checks = [...JEV_CHECKS] } = {}) {
  const clean = String(key ?? "").trim();
  if (!clean || /\s/.test(clean)) throw new Error("that doesn't look like an API key (empty, or contains spaces)");
  const keyFile = defaultKeyFile(configDir);
  fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(keyFile), 0o700);
  fs.writeFileSync(keyFile, `${clean}\n`, { mode: 0o600 });
  fs.chmodSync(keyFile, 0o600);
  const current = (() => { try { return loadValidators(configDir); } catch { return {}; } })();
  const next = { ...current, jev: { enabled: true, key_file: keyFile, model: current.jev?.model ?? "jev-latest", checks } };
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(validatorsPath(configDir), YAML.stringify(next));
  return { keyFile, configPath: validatorsPath(configDir) };
}

/**
 * The judge's settings with its agent resolved, or { problem } when it can't
 * run as configured (unknown agent, host tools without consent), or null
 * when there's no enabled judge.
 */
export function judgeSettings({ configDir = globalConfigDir(), agents = {}, providerOf, runsOnHost }) {
  let config;
  try { config = loadValidators(configDir).judge; } catch (error) { return { problem: error.message }; }
  if (!config?.enabled) return null;
  const agent = agents[config.agent];
  if (!agent) return { problem: `the judge's agent "${config.agent}" isn't in agents.yml` };
  if (agent.kind === "local") return { problem: "the judge needs an api or subscription agent; the local model's context is too small for a whole diff" };
  if (runsOnHost(agent) && !config.host_tools) return { problem: `agent "${config.agent}" runs its tools on this machine, and a judge reads worker-written text; set host_tools: true on the judge in validators.yml to accept that, or use a sandboxed agent` };
  return { ...config, provider: providerOf(agent) };
}

export function saveJudge({ agent, model, hostTools = false, checks = [...JUDGE_CHECK_NAMES] }, { configDir = globalConfigDir() } = {}) {
  const current = (() => { try { return loadValidators(configDir); } catch { return {}; } })();
  const next = { ...current, judge: { enabled: true, agent, model, checks, host_tools: Boolean(hostTools) } };
  const parsed = validatorsSchema.safeParse(next);
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(validatorsPath(configDir), YAML.stringify(next));
  return { configPath: validatorsPath(configDir) };
}

/** Build the guided judge list. Local agents cannot judge a whole diff. */
export function judgeAgentChoices({ agents, roles = {}, providerOf, runsOnHost }) {
  const builderVendors = new Map();
  for (const role of Object.values(roles)) {
    if (role.phase !== "build" || !agents[role.agent] || agents[role.agent].kind === "local") continue;
    const vendor = providerOf(agents[role.agent]);
    builderVendors.set(vendor, (builderVendors.get(vendor) ?? 0) + 1);
  }
  const choices = Object.entries(agents)
    .filter(([name, agent]) => name !== "local" && agent.kind !== "local")
    .map(([name, agent]) => {
      const vendor = providerOf(agent);
      return { name, agent, vendor, hostTools: runsOnHost(agent), sharesBuilderVendor: builderVendors.has(vendor) };
    });
  choices.sort((a, b) => Number(a.sharesBuilderVendor) - Number(b.sharesBuilderVendor) || a.name.localeCompare(b.name));
  const dominantBuilderVendor = [...builderVendors.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
  return { choices, dominantBuilderVendor };
}

/** Print numbered choices and keep asking until one valid number is entered. */
export async function chooseJudgeAgent({ choices, ask, write }) {
  write("Configured judge agents:");
  choices.forEach((choice, index) => {
    const independence = choice.sharesBuilderVendor ? "same vendor as builders; verdicts are not independent" : "independent of your builders";
    write(`  ${index + 1}. ${choice.name}${choice.hostTools ? " (runs tools on this machine)" : ""} (${independence})`);
  });
  for (;;) {
    const answer = String(await ask("Choose a judge agent: ")).trim();
    if (/^[1-9][0-9]*$/.test(answer) && Number(answer) <= choices.length) return choices[Number(answer) - 1];
    write(`Choose a number from 1 to ${choices.length}.`);
  }
}

/** Explain the host boundary and accept only an explicit y or yes. */
export async function confirmJudgeHostTools({ agent, ask, write }) {
  write("The judge's model can run commands on this machine as you, outside the sandbox, while reading text a worker wrote.");
  write("Alternatively, use a sandboxed agent such as an api key, Codex or Muse.");
  const answer = String(await ask(`Allow ${agent} to run as a judge with tools on this machine? [y/N] `)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

export function removeJudge({ configDir = globalConfigDir() } = {}) {
  const current = (() => { try { return loadValidators(configDir); } catch { return {}; } })();
  delete current.judge;
  if (fs.existsSync(validatorsPath(configDir))) fs.writeFileSync(validatorsPath(configDir), YAML.stringify(current));
}

/** Turn Jev off and delete the key file nomArmy saved. */
export function removeJev({ configDir = globalConfigDir() } = {}) {
  const current = (() => { try { return loadValidators(configDir); } catch { return {}; } })();
  const keyFile = current.jev?.key_file ? expandHome(current.jev.key_file) : null;
  if (keyFile && path.resolve(keyFile) === path.resolve(defaultKeyFile(configDir))) fs.rmSync(keyFile, { force: true });
  delete current.jev;
  if (fs.existsSync(validatorsPath(configDir))) fs.writeFileSync(validatorsPath(configDir), YAML.stringify(current));
  return { removedKey: Boolean(keyFile) };
}

// A Jev outage must never slow nomArmy down, let alone stop it: after a
// failure (unreachable, timeout, 5xx, a rejected key), every job skips Jev
// for BREAKER_MS, and a job's own checks stop at their first failure.
export const BREAKER_MS = 10 * 60 * 1000;
let openUntil = 0, lastFailure = null;
export function jevBreaker(now = Date.now()) {
  return now < openUntil ? { open: true, reason: lastFailure, retryAt: new Date(openUntil).toISOString() } : { open: false };
}
export function tripJevBreaker(reason, now = Date.now()) { openUntil = now + BREAKER_MS; lastFailure = reason; }
export function resetJevBreaker() { openUntil = 0; lastFailure = null; }

/**
 * One System One request. Retries once on 429/529. Never logs the key.
 * @returns {Promise<{ answers: object, usage: object|null }>}
 */
export async function askJev({ key, model = "jev-latest", state, questions, fetchFn = fetch, timeoutMs = 15000 }) {
  const body = JSON.stringify({ model, state, questions });
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchFn(JEV_ENDPOINT, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body, signal: controller.signal });
    } finally { clearTimeout(timer); }
    if ((response.status === 429 || response.status === 529) && attempt === 0) { await new Promise((r) => setTimeout(r, 1500)); continue; }
    if (!response.ok) {
      const why = response.status === 401 ? "the API key was rejected (401)" : `TypeSafe answered ${response.status}`;
      throw new Error(why);
    }
    const data = await response.json();
    return { answers: data.answers ?? {}, usage: data.usage ?? null, model: data.model ?? model };
  }
  throw new Error("TypeSafe stayed rate-limited or overloaded");
}
