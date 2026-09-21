// nomArmy multi-provider dispatch pool schema (v1.3).
//
// This module owns the *shape* of config/providers.yml: named pools of
// weighted worker-provider entries a job can be dispatched against with
// `pool: "<name>"`, instead of (or alongside) the single global
// NOMARMY_WORKER_PROVIDER/NOMARMY_WORKER_MODEL pair every job used before
// this existed. No filesystem access, no YAML -- lib/dispatch-config.mjs is
// the only place that touches either, the same separation lib/schema.mjs
// and lib/config.mjs keep for .nomarmy.yml.
//
// Design rules (same as lib/schema.mjs):
//   * Every object is strict. An unrecognized field is a configuration
//     error, never a silently ignored key.
//   * A provider entry never carries a raw credential -- only `auth_env`,
//     the NAME of an environment variable nomArmy reads at dispatch time.
//     The credential itself lives in the operator's shell/secrets manager,
//     never in a file nomArmy writes or reads back.

import { z } from "zod";

const requiredString = () =>
  z
    .string({ required_error: "is required", invalid_type_error: "must be a string" })
    .refine((value) => value.trim().length > 0, { message: "must not be empty" });

// Exported (not just used internally) so bin/nomarmy.mjs's interactive
// `providers add` wizard can validate as-you-type and re-prompt immediately,
// instead of only failing via schema validation after every question has
// already been answered -- a real confusion this caused live: a user typed
// their actual API key into the "Entry id" prompt (which looks like the
// first free-text field after picking a provider) and only found out it was
// invalid at the very end, with no indication which answer was the problem.
export const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const AUTH_ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/**
 * `z.record()` silently drops a key literally named "__proto__" (verified
 * live: no prototype pollution results, since a computed-key object
 * literal is spec-safe, but the pool and every entry in it vanish with no
 * validation error at all -- the opposite of this schema's own "unknown
 * field is a hard error, never silently ignored" rule). Checked on the RAW,
 * not-yet-validated object's own keys, because by the time any
 * `.superRefine` could see `pools` the record step has already dropped it;
 * callers run this before `dispatchConfigSchema.safeParse`.
 */
export const RESERVED_POOL_NAMES = Object.freeze(["__proto__", "constructor", "prototype"]);
export function findReservedPoolName(candidate) {
  const pools = candidate && typeof candidate === "object" ? candidate.pools : null;
  if (!pools || typeof pools !== "object") return null;
  return RESERVED_POOL_NAMES.find((name) => Object.prototype.hasOwnProperty.call(pools, name)) ?? null;
}

/**
 * Provider types nomArmy knows how to register with OpenClaw (see
 * scripts/configure-openclaw.sh). `llama-cpp` is the only one with no
 * `auth_env` -- it shares the already-configured local server's
 * credential-free setup. `anthropic`/`openai`/`xai`/`deepinfra` register
 * through OpenClaw's own native onboarding flags (--anthropic-api-key, etc);
 * `bedrock` and `azure-openai` register as a custom endpoint with an
 * explicit base URL, the same mechanism this codebase already uses for
 * Bedrock. `openai-compatible` is the escape hatch for anything else with an
 * OpenAI-shaped endpoint and always needs its own `base_url`.
 */
export const PROVIDER_TYPES = Object.freeze([
  "llama-cpp",
  "bedrock",
  "anthropic",
  "openai",
  "xai",
  "deepinfra",
  "azure-openai",
  "openai-compatible",
]);

/** Provider types with a native OpenClaw onboarding flag -- no base_url. */
export const NATIVE_PROVIDER_TYPES = Object.freeze(["anthropic", "openai", "xai", "deepinfra"]);

/** Provider types that register as a custom endpoint and therefore require
 * `base_url` (bedrock's default is derived from its region at setup time
 * the same way it already is today; azure-openai and openai-compatible have
 * no sensible default at all -- every Azure deployment has its own URL). */
export const CUSTOM_ENDPOINT_PROVIDER_TYPES = Object.freeze(["bedrock", "azure-openai", "openai-compatible"]);

const idSchema = z
  .string({ required_error: "is required", invalid_type_error: "must be a string" })
  .regex(ID_RE, "must be 1-64 characters of letters, numbers, dot, underscore or hyphen");

const weightSchema = z
  .number({ required_error: "is required", invalid_type_error: "must be a number" })
  .positive("must be a positive number")
  .finite("must be a finite number");

// Static, operator-declared ceiling on how many jobs may run against this
// one entry at once -- a stand-in for real rate-limit-aware admission (see
// README's dispatch-pool section for why that's out of scope for now).
const maxConcurrentSchema = z
  .number({ invalid_type_error: "must be a number" })
  .int("must be a whole number")
  .positive("must be a positive number")
  .default(2);

const authEnvSchema = z
  .string({ required_error: "is required", invalid_type_error: "must be a string" })
  .regex(
    AUTH_ENV_NAME_RE,
    "must be an environment variable NAME (uppercase letters, digits, underscores), never the credential itself",
  );

const urlSchema = () =>
  z
    .string({ required_error: "is required", invalid_type_error: "must be a string" })
    .url("must be a valid URL");

// Whether/how the entry's model uses a thinking/reasoning mode. `true`
// (default) mirrors config/common.env's NOMARMY_MODEL_THINKING -- pass
// through whatever `reasoning` level the job requested. `false` means this
// model has no reasoning mode at all, same as before this existed. A
// specific level ("low"/"medium"/"high") means this ENTRY always requests
// that level regardless of what the job asked for -- for a pool tier that
// exists specifically for harder work (e.g. "capable") and should never
// settle for less reasoning than its own declared floor. If the model
// doesn't actually support the requested level, OpenClaw says so in its own
// error and mcp/server.mjs's runOpenClaw retries once with whatever level
// OpenClaw names as supported (see parseUnsupportedThinkingError) -- so a
// level this schema accepts is never a guarantee the provider/model
// combination honors it today, only what to keep asking for.
const thinkingSchema = z.union([z.boolean(), z.enum(["low", "medium", "high"])]).default(true);

// Optional override for the model's real context window, in tokens. Absent
// (the common case), lib/dispatch-config.mjs looks this up from OpenClaw's
// own model catalog at dispatch time instead -- this field exists for the
// gap that lookup can't cover: a model newer than OpenClaw's cached catalog
// knows about yet (see lib/model-catalog.mjs), or an operator who wants to
// be more conservative than the model's rated maximum.
const contextWindowSchema = z
  .number({ invalid_type_error: "must be a number" })
  .int("must be a whole number")
  .positive("must be a positive number")
  .optional();

function hostedProviderSchema(providerType, { requireBaseUrl }) {
  const shape = {
    id: idSchema,
    provider: z.literal(providerType),
    model: requiredString(),
    weight: weightSchema,
    max_concurrent: maxConcurrentSchema,
    auth_env: authEnvSchema,
    thinking: thinkingSchema,
    context_window: contextWindowSchema,
  };
  if (requireBaseUrl) shape.base_url = urlSchema();
  return z.object(shape).strict();
}

const llamaCppEntrySchema = z
  .object({
    id: idSchema,
    provider: z.literal("llama-cpp"),
    // Omitted -> falls back to NOMARMY_WORKER_MODEL/NOMARMY_MODEL_THINKING,
    // the exact same defaults a job gets today with no `pool` at all.
    model: requiredString().optional(),
    weight: weightSchema,
    max_concurrent: maxConcurrentSchema,
  })
  .strict();

export const providerEntrySchema = z.discriminatedUnion("provider", [
  llamaCppEntrySchema,
  ...NATIVE_PROVIDER_TYPES.map((type) => hostedProviderSchema(type, { requireBaseUrl: false })),
  ...CUSTOM_ENDPOINT_PROVIDER_TYPES.map((type) => hostedProviderSchema(type, { requireBaseUrl: true })),
]);

export const poolsSchema = z.record(
  z.string().min(1, "pool name must not be empty"),
  z
    .array(providerEntrySchema, { invalid_type_error: "must be an array of provider entries" })
    .min(1, "must list at least one provider entry"),
);

export const dispatchConfigSchema = z
  .object({
    pools: poolsSchema,
  })
  .strict()
  .superRefine((data, ctx) => {
    // Ids double as the OpenClaw provider id and the per-entry admission/
    // metrics key -- a collision across pools would be genuinely ambiguous,
    // not just untidy, so this is a hard error rather than a lint.
    const seenAt = new Map();
    for (const [poolName, entries] of Object.entries(data.pools || {})) {
      entries.forEach((entry, index) => {
        if (seenAt.has(entry.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["pools", poolName, index, "id"],
            message: `id "${entry.id}" is already used by pool "${seenAt.get(entry.id)}" -- provider ids must be unique across every pool`,
          });
        } else {
          seenAt.set(entry.id, poolName);
        }
      });
    }
  });

/**
 * Turn a ZodError from `dispatchConfigSchema` into readable `path: message`
 * lines. A sibling of lib/schema.mjs's own formatIssues, kept separate
 * because the discriminator values differ (PROVIDER_TYPES, not
 * SERVICE_SOURCES) -- duplicating this one small function is cheaper and
 * safer than parameterizing the shared one for a single call site.
 */
export function formatDispatchIssues(error) {
  const lines = [];
  for (const issue of error.issues) {
    const where = issue.path.length > 0 ? issue.path.join(".") : "config";
    if (issue.code === "unrecognized_keys") {
      const keys = (issue.keys || []).map((key) => `"${key}"`).join(", ");
      lines.push(`${where}: unexpected field(s) ${keys}`);
      continue;
    }
    if (issue.code === "invalid_union_discriminator") {
      lines.push(`${where}: must be one of ${PROVIDER_TYPES.join(", ")}`);
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
