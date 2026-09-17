// nomArmy repository configuration loader (v1.3).
//
// `.nomarmy.yml` is the environment contract for a job: what services the
// worker's sandbox gets, how the application is started, which verification
// profiles exist, and what happens to the environment afterwards.
//
// All YAML parsing lives in this file so the parser stays swappable; the shape
// itself lives in `lib/schema.mjs`.

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import {
  collectElevated,
  configSchema,
  emptyElevated,
  formatIssues,
} from "./schema.mjs";

export {
  DEFAULT_RETENTION,
  ELEVATED_SERVICE_SOURCES,
  ENVIRONMENT_LEVELS,
  RETENTION_ACTIONS,
  SERVICE_SOURCES,
} from "./schema.mjs";

/** Filenames searched, in order. First hit wins. */
export const CONFIG_FILENAMES = Object.freeze([".nomarmy.yml", ".nomarmy.yaml"]);

/**
 * Raised when a `.nomarmy.yml` exists but cannot be used. Carries the same
 * readable `path: message` lines that `validateConfig` returns, so a caller
 * never has to re-derive them from the message text.
 */
export class ConfigError extends Error {
  /**
   * @param {string} message
   * @param {{ errors?: string[], path?: string|null, cause?: unknown }} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = "ConfigError";
    this.errors = details.errors || [];
    this.path = details.path || null;
    if (details.cause !== undefined) this.cause = details.cause;
  }
}

function isReadableFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Absolute path of the repository's config file, or null when absent.
 * @param {string} [repoDir]
 * @returns {string|null}
 */
export function findConfigFile(repoDir = process.cwd()) {
  const base = path.resolve(repoDir);
  for (const filename of CONFIG_FILENAMES) {
    const candidate = path.join(base, filename);
    if (isReadableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Parse YAML text into a plain object. The only YAML entry point in nomArmy.
 * An empty document (or a comments-only file) becomes `{}`.
 * @param {string} text
 * @param {string|null} [sourcePath] used only for the error message
 * @returns {object}
 */
export function parseYaml(text, sourcePath = null) {
  let parsed;
  try {
    parsed = YAML.parse(text, { prettyErrors: true });
  } catch (error) {
    const where = sourcePath ? `${path.basename(sourcePath)}` : "configuration";
    throw new ConfigError(`${where} is not valid YAML: ${error.message}`, {
      path: sourcePath,
      errors: [`config: is not valid YAML: ${error.message}`],
      cause: error,
    });
  }
  return parsed === null || parsed === undefined ? {} : parsed;
}

/**
 * Validate an already-parsed plain object against the `.nomarmy.yml` schema.
 *
 * `elevated` lists every `shared` and `remote` service found. Those sources
 * reach outside the job sandbox, so they are accepted here but the caller is
 * expected to require explicit policy approval before running the job. It is
 * structured data on purpose, not a warning string.
 *
 * @param {unknown} input
 * @returns {{ valid: boolean, config: object|null, errors: string[], elevated: { shared: string[], remote: string[] } }}
 */
export function validateConfig(input) {
  const candidate = input === null || input === undefined ? {} : input;

  if (typeof candidate !== "object" || Array.isArray(candidate)) {
    return {
      valid: false,
      config: null,
      errors: ["config: must be a mapping of top-level sections"],
      elevated: emptyElevated(),
    };
  }

  const result = configSchema.safeParse(candidate);
  if (!result.success) {
    return {
      valid: false,
      config: null,
      errors: formatIssues(result.error),
      elevated: emptyElevated(),
    };
  }

  return {
    valid: true,
    config: result.data,
    errors: [],
    elevated: collectElevated(result.data),
  };
}

/**
 * Find, parse and validate a repository's `.nomarmy.yml`.
 *
 * A missing file is not an error: the repo simply has no environment contract,
 * and `{ found: false }` comes back cleanly. A file that exists but is broken
 * throws `ConfigError` — an unusable contract must not be mistaken for none.
 *
 * @param {string} [repoDir] repository root to search
 * @returns {{ found: boolean, path: string|null, config: object|null, elevated: { shared: string[], remote: string[] } }}
 */
export function loadConfig(repoDir = process.cwd()) {
  const configPath = findConfigFile(repoDir);
  if (!configPath) {
    return { found: false, path: null, config: null, elevated: emptyElevated() };
  }

  let text;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    throw new ConfigError(
      `${path.basename(configPath)} could not be read: ${error.message}`,
      {
        path: configPath,
        errors: [`config: could not be read: ${error.message}`],
        cause: error,
      },
    );
  }

  const parsed = parseYaml(text, configPath);
  const result = validateConfig(parsed);

  if (!result.valid) {
    const detail = result.errors.map((line) => `  - ${line}`).join("\n");
    throw new ConfigError(
      `${path.basename(configPath)} is not a valid nomArmy configuration:\n${detail}`,
      { path: configPath, errors: result.errors },
    );
  }

  return {
    found: true,
    path: configPath,
    config: result.config,
    elevated: result.elevated,
  };
}
