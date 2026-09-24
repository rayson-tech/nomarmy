// nomArmy subscription-backed worker schema.
//
// This module owns the *shape* of config/subscriptions.yml: named entries
// naming one person's own already-authenticated OpenClaw provider (a Claude
// Pro/Max/Team seat via the `claude-cli` provider, an OpenAI ChatGPT plan
// via the `openai` provider's Codex-imported OAuth profile, or Meta Muse
// Code via `meta`), dispatched with
// `subscription_worker: "<name>"` + `on_behalf_of: "<owner>"`.
//
// This is a DELIBERATELY separate structure from config/providers.yml's
// pools, not a new discriminated-union branch inside providerEntrySchema --
// see lib/dispatch-config.mjs's pickProvider: a pool is fundamentally an
// interchangeability engine (weighted-random pick over fungible capacity).
// A subscription entry is the opposite: bound to one specific person's own
// account, always addressed by name, never picked. Folding it into
// providerEntrySchema would put it one `weight` field away from silently
// becoming pooled capacity the moment a second entry lands in the same
// array -- omitting `weight` (and any picker function) from this schema
// entirely makes that a type error, not a discipline problem.
//
// OpenClaw owns credential acquisition and refresh entirely for these
// providers (see mcp/server.mjs's resolveSubscriptionSelection and
// runOpenClaw's --no-auth-env-only handling) -- this schema carries no
// `auth_env` and no credential material of any kind, only the OpenClaw
// provider id an operator already registered on this machine.

import { z } from "zod";

const requiredString = () =>
  z
    .string({ required_error: "is required", invalid_type_error: "must be a string" })
    .refine((value) => value.trim().length > 0, { message: "must not be empty" });

// Same footgun lib/dispatch-schema.mjs's findReservedPoolName already
// documents: z.record() silently drops a key literally named "__proto__"
// with no validation error at all. Checked on the raw, not-yet-validated
// object's own keys, before dispatchConfigSchema-equivalent parsing ever
// sees `workers`.
export const RESERVED_WORKER_NAMES = Object.freeze(["__proto__", "constructor", "prototype"]);
export function findReservedWorkerName(candidate) {
  const workers = candidate && typeof candidate === "object" ? candidate.workers : null;
  if (!workers || typeof workers !== "object") return null;
  return RESERVED_WORKER_NAMES.find((name) => Object.prototype.hasOwnProperty.call(workers, name)) ?? null;
}

export const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

const idSchema = z
  .string({ required_error: "is required", invalid_type_error: "must be a string" })
  .regex(ID_RE, "must be 1-64 characters of letters, numbers, dot, underscore or hyphen");

// A personal, already-authenticated subscription session was never
// rate-provisioned for concurrent automated jobs the way an API key's
// max_concurrent (lib/dispatch-schema.mjs's default of 2) is -- default to
// 1 so raising it is an explicit, informed operator choice, not an
// inherited pooled-capacity-shaped default.
const maxConcurrentSchema = z
  .number({ invalid_type_error: "must be a number" })
  .int("must be a whole number")
  .positive("must be a positive number")
  .default(1);

// Same union lib/dispatch-schema.mjs's thinkingSchema already uses, same
// meaning: true passes through the job's requested reasoning level, false
// forces "off", a specific level is this entry's own fixed floor.
const thinkingSchema = z.union([z.boolean(), z.enum(["low", "medium", "high"])]).default(true);

const contextWindowSchema = z
  .number({ invalid_type_error: "must be a number" })
  .int("must be a whole number")
  .positive("must be a positive number")
  .optional();

// A role is a DETERMINISTIC alternative to naming a worker directly --
// "architect always goes to this entry" -- never a weighted/random pick.
// That distinction matters: fixed role assignment is one person using the
// right dedicated tool for a known kind of work (the same choice they'd
// make by hand, automated for convenience), not load-balanced capacity
// across interchangeable subscriptions -- the pooled-capacity pattern this
// whole module exists to stay away from. Optional; a worker with no role
// can still only ever be dispatched by its exact name.
const roleSchema = requiredString().optional();

export const subscriptionWorkerEntrySchema = z
  .object({
    provider: requiredString().describe("The OpenClaw provider id already registered on this machine (e.g. \"claude-cli\") -- an operator sets this up once with `openclaw models auth login`/`plugins install`, never nomArmy."),
    model: requiredString(),
    owner: requiredString().describe("Exactly who this credential belongs to. A job dispatched here must supply a matching on_behalf_of, or nomArmy refuses it."),
    role: roleSchema.describe("Optional, unique across every entry. Lets a job select this worker with `role` instead of naming it directly (e.g. role: \"architect\") -- always the SAME entry for that role, never a pick among several."),
    max_concurrent: maxConcurrentSchema,
    thinking: thinkingSchema,
    context_window: contextWindowSchema,
  })
  .strict();

export const workersSchema = z.record(idSchema, subscriptionWorkerEntrySchema);

export const subscriptionConfigSchema = z
  .object({
    workers: workersSchema,
  })
  .strict()
  .superRefine((data, ctx) => {
    // Two entries claiming the same role would make role-based dispatch
    // genuinely ambiguous, not just untidy -- a hard error here, the same
    // way dispatchConfigSchema treats a duplicate pool-entry id, rather
    // than something a resolver has to pick a winner from at dispatch time.
    const seenAt = new Map();
    for (const [name, entry] of Object.entries(data.workers || {})) {
      if (!entry.role) continue;
      if (seenAt.has(entry.role)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["workers", name, "role"],
          message: `role "${entry.role}" is already used by worker "${seenAt.get(entry.role)}" -- roles must be unique across every worker`,
        });
      } else {
        seenAt.set(entry.role, name);
      }
    }
  });

/**
 * Turn a ZodError from `subscriptionConfigSchema` into readable
 * `path: message` lines -- a sibling of lib/dispatch-schema.mjs's own
 * formatDispatchIssues, kept separate for the same reason that one is kept
 * separate from lib/schema.mjs's formatIssues: a small, single-call-site
 * function is cheaper and safer to duplicate than to parameterize.
 */
export function formatSubscriptionIssues(error) {
  const lines = [];
  for (const issue of error.issues) {
    const where = issue.path.length > 0 ? issue.path.join(".") : "config";
    if (issue.code === "unrecognized_keys") {
      const keys = (issue.keys || []).map((key) => `"${key}"`).join(", ");
      lines.push(`${where}: unexpected field(s) ${keys}`);
      continue;
    }
    if (issue.code === "invalid_type" && issue.received === "undefined") {
      lines.push(`${where}: is required`);
      continue;
    }
    lines.push(`${where}: ${issue.message}`);
  }
  return [...new Set(lines)];
}
