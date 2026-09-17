// nomArmy `.nomarmy.yml` schema (v1.3).
//
// This module owns the *shape* of a repository's environment contract and
// nothing else: no filesystem access, no YAML. `lib/config.mjs` is the only
// place that touches either, so the parser stays swappable.
//
// Design rules the rest of the system depends on:
//   * Every object is strict. A field belonging to another service source is a
//     configuration error, never a silently ignored key.
//   * `shared` and `remote` services are elevated: validation accepts them, but
//     the caller is handed a structured list so it can require explicit policy
//     approval before the job runs. See `collectElevated`.

import { z } from "zod";

export const SERVICE_SOURCES = Object.freeze([
  "compose",
  "image",
  "process",
  "shared",
  "remote",
]);

/** Sources that reach outside the job's own sandbox and need policy approval. */
export const ELEVATED_SERVICE_SOURCES = Object.freeze(["shared", "remote"]);

export const ENVIRONMENT_LEVELS = Object.freeze([
  "none",
  "basic",
  "integration",
  "e2e",
]);

export const RETENTION_ACTIONS = Object.freeze(["destroy", "logs", "retain"]);

export const DEFAULT_RETENTION = Object.freeze({
  success: "destroy",
  failure: "logs",
  debug: "retain",
});

/** The field each service source owns, keyed by source. */
export const SERVICE_FIELDS = Object.freeze({
  compose: "service",
  image: "image",
  process: "command",
  shared: "endpoint",
  remote: "endpoint_env",
});

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

// Error messages omit the field name on purpose: `formatIssues` always prefixes
// the dotted path, so repeating it reads as stutter.
const requiredString = () =>
  z
    .string({ required_error: "is required", invalid_type_error: "must be a string" })
    .refine((value) => value.trim().length > 0, { message: "must not be empty" });

const enumOf = (values) =>
  z.enum(values, {
    errorMap: () => ({ message: `must be one of ${values.join(", ")}` }),
  });

// A plain hostname: no scheme, no path, no port, no whitespace.
const HOSTNAME_RE =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/**
 * Why a value is not a usable bare hostname, or null when it is fine.
 * Ordered so the most specific explanation wins (a URL trips scheme, not port).
 * @param {unknown} value
 * @returns {string|null}
 */
export function hostnameProblem(value) {
  if (typeof value !== "string") return "must be a string hostname";
  if (value.length === 0) return "must not be empty";
  if (/\s/.test(value)) return `must not contain whitespace (got "${value}")`;
  if (SCHEME_RE.test(value)) return `must not include a URI scheme (got "${value}")`;
  if (value.includes("/")) return `must not include a path or slash (got "${value}")`;
  if (value.includes(":")) return `must not include a port (got "${value}")`;
  if (value.length > 253) return "must be at most 253 characters";
  if (!HOSTNAME_RE.test(value)) return `must be a plain hostname (got "${value}")`;
  return null;
}

const hostnameSchema = z
  .string({ invalid_type_error: "must be a string hostname" })
  .superRefine((value, ctx) => {
    const problem = hostnameProblem(value);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  });

// Service names become DNS names on the job network, so keep them boring.
const serviceNameSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_.-]*$/,
    "service name must start alphanumeric and use only letters, digits, hyphen, underscore or dot",
  );

// ---------------------------------------------------------------------------
// services (discriminated on `source`, every branch strict)
// ---------------------------------------------------------------------------

export const composeServiceSchema = z
  .object({
    source: z.literal("compose"),
    service: requiredString(),
  })
  .strict();

export const imageServiceSchema = z
  .object({
    source: z.literal("image"),
    image: requiredString(),
  })
  .strict();

export const processServiceSchema = z
  .object({
    source: z.literal("process"),
    command: requiredString(),
  })
  .strict();

export const sharedServiceSchema = z
  .object({
    source: z.literal("shared"),
    endpoint: requiredString(),
  })
  .strict();

export const remoteServiceSchema = z
  .object({
    source: z.literal("remote"),
    endpoint_env: requiredString(),
  })
  .strict();

export const serviceSchema = z.discriminatedUnion("source", [
  composeServiceSchema,
  imageServiceSchema,
  processServiceSchema,
  sharedServiceSchema,
  remoteServiceSchema,
]);

// ---------------------------------------------------------------------------
// environment
// ---------------------------------------------------------------------------

export const environmentSchema = z
  .object({
    compose: z.object({ file: requiredString() }).strict().optional(),
    services: z.record(serviceNameSchema, serviceSchema).optional(),
    application: z
      .object({
        command: requiredString(),
        healthcheck: requiredString().optional(),
      })
      .strict()
      .optional(),
    browser: z.object({ base_url: requiredString() }).strict().optional(),
    allowed_hosts: z.array(hostnameSchema).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// verification
// ---------------------------------------------------------------------------

export const verificationProfileSchema = z
  .object({
    environment: enumOf(ENVIRONMENT_LEVELS).default("none"),
    commands: z
      .array(requiredString(), {
        required_error: "is required",
        invalid_type_error: "must be an array of strings",
      })
      .min(1, "must list at least one command"),
  })
  .strict();

export const verificationSchema = z.record(
  z.string().min(1, "verification profile name must not be empty"),
  verificationProfileSchema,
);

// ---------------------------------------------------------------------------
// retention
// ---------------------------------------------------------------------------

export const environmentRetentionSchema = z
  .object({
    success: enumOf(RETENTION_ACTIONS).default(DEFAULT_RETENTION.success),
    failure: enumOf(RETENTION_ACTIONS).default(DEFAULT_RETENTION.failure),
    debug: enumOf(RETENTION_ACTIONS).default(DEFAULT_RETENTION.debug),
  })
  .strict()
  .default({});

// ---------------------------------------------------------------------------
// root
// ---------------------------------------------------------------------------

export const configSchema = z
  .object({
    environment: environmentSchema.optional(),
    verification: verificationSchema.optional(),
    environment_retention: environmentRetentionSchema,
  })
  .strict();

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** A fresh, empty elevated-services record. */
export function emptyElevated() {
  return { shared: [], remote: [] };
}

/**
 * Structured list of every service that reaches outside the job sandbox.
 * Declaration order is preserved so the list reads like the file.
 * @param {object|null|undefined} config validated config
 * @returns {{ shared: string[], remote: string[] }}
 */
export function collectElevated(config) {
  const elevated = emptyElevated();
  const services = config && config.environment && config.environment.services;
  if (!services) return elevated;
  for (const [name, definition] of Object.entries(services)) {
    if (!definition) continue;
    if (definition.source === "shared") elevated.shared.push(name);
    else if (definition.source === "remote") elevated.remote.push(name);
  }
  return elevated;
}

/**
 * Turn a ZodError into readable `path: message` lines. Never leak a raw dump.
 * @param {import("zod").ZodError} error
 * @returns {string[]}
 */
export function formatIssues(error) {
  const lines = [];
  for (const issue of error.issues) {
    const where = issue.path.length > 0 ? issue.path.join(".") : "config";
    if (issue.code === "unrecognized_keys") {
      const keys = (issue.keys || []).map((key) => `"${key}"`).join(", ");
      lines.push(`${where}: unexpected field(s) ${keys}`);
      continue;
    }
    if (issue.code === "invalid_union_discriminator") {
      lines.push(`${where}: must be one of ${SERVICE_SOURCES.join(", ")}`);
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
