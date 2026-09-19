// nomArmy v1.3 — normalized repository evidence package.
//
// This module owns the SHAPE of the evidence that `lib/scan.mjs` produces and
// the rules that keep it safe to hand to a model:
//
//   1. Names only, never values. Environment variables, build args and
//      secrets are recorded by NAME. A value never enters this structure.
//   2. Bounded. Every category is capped and marks `truncated: true` when it
//      drops findings. Long strings are truncated. Whole files are never
//      inlined.
//   3. Traceable. Every finding carries the `source` path it was derived from.
//   4. Deterministic. No timestamps, no randomness, no host paths beyond the
//      caller-supplied repoDir. Items are deduped and sorted.
//
// This file performs no I/O and executes nothing.

export const EVIDENCE_VERSION = 1;

/** Every category present in a normalized evidence package, in output order. */
export const CATEGORIES = Object.freeze([
  "files",
  "services",
  "commands",
  "ports",
  "healthchecks",
  "dependencies",
  "environment",
  "tooling",
  "profiles",
  "seeds",
  "ci",
  "notes",
]);

/** Classification used for discovered commands. */
export const COMMAND_KINDS = Object.freeze([
  "start",
  "build",
  "test",
  "e2e",
  "lint",
  "migrate",
  "seed",
  "other",
]);

export const DEFAULT_LIMITS = Object.freeze({
  /** Max findings retained per category before `truncated` is set. */
  perCategory: 50,
  /** Max length of a generic recorded string (paths, images, names). */
  stringLength: 240,
  /** Max length of a recorded command line. */
  commandLength: 400,
  /** Max ports / env names / depends_on entries recorded inside one service. */
  perService: 40,
  /** Max bytes read from any single file during scanning. */
  fileBytes: 256 * 1024,
  /** Max files opened for content grepping (testcontainers detection). */
  grepFiles: 300,
  /** Max directory depth walked below the repo root. */
  maxDepth: 5,
  /** Max directory entries visited overall. */
  maxEntries: 20000,
});

export function resolveLimits(overrides) {
  const limits = { ...DEFAULT_LIMITS };
  if (overrides && typeof overrides === "object") {
    for (const key of Object.keys(DEFAULT_LIMITS)) {
      const value = overrides[key];
      if (Number.isFinite(value) && value >= 0) limits[key] = Math.floor(value);
    }
  }
  return Object.freeze(limits);
}

// ---------------------------------------------------------------------------
// String hygiene
// ---------------------------------------------------------------------------

export const TRUNCATION_MARK = "...[truncated]";

export function truncateString(value, max) {
  if (typeof value !== "string") return null;
  const flat = value.replace(/\r\n?/g, "\n");
  const limit = Number.isFinite(max) && max > 0 ? max : DEFAULT_LIMITS.stringLength;
  if (flat.length <= limit) return flat;
  // The result must never exceed the limit, even when the limit is shorter
  // than the marker itself.
  if (limit <= TRUNCATION_MARK.length) return flat.slice(0, limit);
  return flat.slice(0, limit - TRUNCATION_MARK.length) + TRUNCATION_MARK;
}

const SECRETISH_NAME = /(pass|passwd|password|secret|token|api[_-]?key|apikey|credential|private[_-]?key|access[_-]?key|session|cookie|auth)/i;

/** True when an identifier NAME suggests it holds a credential. */
export function looksLikeSecretName(name) {
  return typeof name === "string" && SECRETISH_NAME.test(name);
}

/**
 * Remove anything value-shaped from a command line before it is recorded.
 * Commands are useful evidence; the values embedded in them are not.
 */
export function redactCommand(value, max) {
  if (typeof value !== "string") return null;
  let out = value.replace(/\s+/g, " ").trim();
  // URLs carrying userinfo: scheme://user:pass@host
  out = out.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/@]+@/g, "$1<redacted>@");
  // NAME=value where NAME looks like a credential
  out = out.replace(
    /\b([A-Za-z_][A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|\S+)/g,
    (match, name) => (looksLikeSecretName(name) ? `${name}=<redacted>` : match),
  );
  // Explicit secret-bearing flags
  out = out.replace(
    /(--?(?:password|passwd|token|secret|api[-_]?key|auth)(?:[-_a-z0-9]*)?[=\s])(?:"[^"]*"|'[^']*'|\S+)/gi,
    "$1<redacted>",
  );
  // Long opaque blobs (likely encoded credentials)
  out = out.replace(/\b[A-Za-z0-9+/_-]{48,}={0,2}\b/g, "<redacted>");
  return truncateString(out, Number.isFinite(max) ? max : DEFAULT_LIMITS.commandLength);
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** Validate and normalize an environment variable NAME. Returns null if it is not one. */
export function envName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!name || name.length > 128) return null;
  return ENV_NAME_RE.test(name) ? name : null;
}

/**
 * Extract environment variable NAMES from the text of a dotenv-style example
 * file. Values on the right-hand side of `=` are discarded, never returned.
 */
export function envNamesFromDotenv(text) {
  const names = [];
  if (typeof text !== "string") return names;
  for (const rawLine of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const withoutExport = line.replace(/^export\s+/, "");
    const eq = withoutExport.indexOf("=");
    const candidate = eq === -1 ? withoutExport : withoutExport.slice(0, eq);
    const name = envName(candidate);
    if (name) names.push(name);
  }
  return names;
}

/** Extract `${VAR}` / `$VAR` interpolation NAMES from an arbitrary string. */
export function envNamesFromInterpolation(text) {
  const names = [];
  if (typeof text !== "string") return names;
  const re = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = envName(m[1]);
    if (name) names.push(name);
  }
  return names;
}

// ---------------------------------------------------------------------------
// Command classification
// ---------------------------------------------------------------------------

const CLASSIFIERS = [
  ["e2e", /(^|[^a-z])(e2e|end[-_]?to[-_]?end|playwright|cypress|webdriver|selenium|puppeteer|integration(?:[-_]?tests?)?)([^a-z]|$)/i],
  ["migrate", /(migrat|alembic|flyway|liquibase|prisma\s+migrate|knex\s+migrate|rails\s+db:migrate)/i],
  ["seed", /(^|[^a-z])(seed|seeds|fixtures?|bootstrap[-_]?data|db:seed|loaddata)([^a-z]|$)/i],
  ["test", /(^|[^a-z])(tests?|spec|specs|jest|vitest|pytest|mocha|tox|unittest|go\s+test|cargo\s+test|check)([^a-z]|$)/i],
  ["lint", /(^|[^a-z])(lint|eslint|prettier|ruff|flake8|black|mypy|tsc|typecheck|format|fmt|vet|clippy)([^a-z]|$)/i],
  ["build", /(^|[^a-z])(build|compile|bundle|package|dist|webpack|rollup|vite\s+build|tsc\s+-b)([^a-z]|$)/i],
  ["start", /(^|[^a-z])(start|serve|server|dev|develop|run|up|watch|preview|uvicorn|gunicorn|flask\s+run|nodemon|docker[-\s]?compose\s+up)([^a-z]|$)/i],
];

/**
 * Classify a named command. The NAME dominates because it carries author
 * intent; the command body is only consulted when the name says nothing.
 */
export function classifyCommand(name, command) {
  for (const [kind, re] of CLASSIFIERS) {
    if (typeof name === "string" && re.test(name)) return kind;
  }
  for (const [kind, re] of CLASSIFIERS) {
    if (typeof command === "string" && re.test(command)) return kind;
  }
  return "other";
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function clean(value, max) {
  const s = truncateString(
    typeof value === "number" || typeof value === "boolean" ? String(value) : value,
    max,
  );
  return s && s.length ? s : null;
}

function uniqueStrings(values, cap, max) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(values)) return out;
  for (const value of values) {
    const s = clean(value, max);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

function uniqueEnvNames(values, cap) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(values)) return out;
  for (const value of values) {
    const name = envName(value);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= cap) break;
  }
  return out.sort();
}

function normalizePort(entry, limits) {
  if (!entry || typeof entry !== "object") return null;
  const published = toPortNumber(entry.published);
  const target = toPortNumber(entry.target);
  const raw = clean(entry.raw, limits.stringLength);
  if (published === null && target === null && !raw) return null;
  return {
    service: clean(entry.service, limits.stringLength),
    published,
    target,
    protocol: clean(entry.protocol, 16) || "tcp",
    host: clean(entry.host, 64),
    raw,
    source: clean(entry.source, limits.stringLength),
  };
}

function toPortNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number.parseInt(String(value), 10);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : null;
}

const SANITIZERS = {
  files(item, limits) {
    const path = clean(item?.path, limits.stringLength);
    if (!path) return null;
    return { path, kind: clean(item?.kind, 64) || "other" };
  },

  services(item, limits) {
    const name = clean(item?.name, limits.stringLength);
    if (!name) return null;
    const source = clean(item?.source, limits.stringLength);
    return {
      name,
      source,
      image: clean(item?.image, limits.stringLength),
      build: clean(item?.build, limits.stringLength),
      command: redactCommand(item?.command, limits.commandLength),
      ports: uniqueStrings(item?.ports, limits.perService, 64),
      environmentNames: uniqueEnvNames(item?.environmentNames, limits.perService),
      envFiles: uniqueStrings(item?.envFiles, limits.perService, limits.stringLength),
      dependsOn: uniqueStrings(item?.dependsOn, limits.perService, limits.stringLength),
      profiles: uniqueStrings(item?.profiles, limits.perService, limits.stringLength),
      healthcheck: item?.healthcheck ? true : false,
    };
  },

  commands(item, limits) {
    const command = redactCommand(item?.command, limits.commandLength);
    const name = clean(item?.name, limits.stringLength);
    if (!command && !name) return null;
    const kind = COMMAND_KINDS.includes(item?.kind) ? item.kind : "other";
    return {
      name: name || "(unnamed)",
      kind,
      command: command || null,
      source: clean(item?.source, limits.stringLength),
    };
  },

  ports(item, limits) {
    return normalizePort(item, limits);
  },

  healthchecks(item, limits) {
    const source = clean(item?.source, limits.stringLength);
    const service = clean(item?.service, limits.stringLength);
    if (!source && !service) return null;
    return {
      service,
      test: redactCommand(item?.test, limits.commandLength),
      interval: clean(item?.interval, 32),
      timeout: clean(item?.timeout, 32),
      retries: clean(item?.retries, 32),
      startPeriod: clean(item?.startPeriod, 32),
      source,
    };
  },

  dependencies(item, limits) {
    const from = clean(item?.from, limits.stringLength);
    const to = clean(item?.to, limits.stringLength);
    if (!from || !to) return null;
    return {
      from,
      to,
      condition: clean(item?.condition, 64),
      source: clean(item?.source, limits.stringLength),
    };
  },

  environment(item, limits) {
    const name = envName(item?.name);
    if (!name) return null;
    return {
      name,
      scope: clean(item?.scope, 64) || "unknown",
      service: clean(item?.service, limits.stringLength),
      source: clean(item?.source, limits.stringLength),
      // A hint for reviewers. The VALUE is never present in this package.
      sensitiveName: looksLikeSecretName(name),
    };
  },

  tooling(item, limits) {
    const name = clean(item?.name, limits.stringLength);
    if (!name) return null;
    return {
      name,
      category: clean(item?.category, 64) || "other",
      detail: clean(item?.detail, limits.stringLength),
      source: clean(item?.source, limits.stringLength),
    };
  },

  profiles(item, limits) {
    const name = clean(item?.name, limits.stringLength);
    if (!name) return null;
    return {
      name,
      services: uniqueStrings(item?.services, limits.perService, limits.stringLength),
      source: clean(item?.source, limits.stringLength),
    };
  },

  seeds(item, limits) {
    const target = clean(item?.target, limits.stringLength);
    const name = clean(item?.name, limits.stringLength);
    if (!target && !name) return null;
    return {
      name: name || target,
      kind: clean(item?.kind, 64) || "other",
      target,
      service: clean(item?.service, limits.stringLength),
      source: clean(item?.source, limits.stringLength),
    };
  },

  ci(item, limits) {
    const path = clean(item?.path, limits.stringLength);
    if (!path) return null;
    return {
      path,
      name: clean(item?.name, limits.stringLength),
      jobs: uniqueStrings(item?.jobs, limits.perService, limits.stringLength),
      triggers: uniqueStrings(item?.triggers, limits.perService, 64),
      services: uniqueStrings(item?.services, limits.perService, limits.stringLength),
    };
  },

  notes(item, limits) {
    const message = clean(item?.message, limits.stringLength);
    if (!message) return null;
    const level = ["info", "warn", "error"].includes(item?.level) ? item.level : "info";
    return { level, message, source: clean(item?.source, limits.stringLength) };
  },
};

function categoryKey(category, item) {
  switch (category) {
    case "files":
      return item.path;
    case "services":
      return `${item.source || ""}::${item.name}`;
    case "commands":
      return `${item.source || ""}::${item.kind}::${item.name}::${item.command || ""}`;
    case "ports":
      return `${item.source || ""}::${item.service || ""}::${item.host || ""}::${item.published}::${item.target}::${item.protocol}`;
    case "healthchecks":
      return `${item.source || ""}::${item.service || ""}`;
    case "dependencies":
      return `${item.source || ""}::${item.from}->${item.to}`;
    case "environment":
      return `${item.name}::${item.scope}::${item.service || ""}::${item.source || ""}`;
    case "tooling":
      return `${item.category}::${item.name}::${item.source || ""}`;
    case "profiles":
      return `${item.source || ""}::${item.name}`;
    case "seeds":
      return `${item.source || ""}::${item.kind}::${item.name}`;
    case "ci":
      return item.path;
    case "notes":
      return `${item.level}::${item.message}::${item.source || ""}`;
    default:
      return JSON.stringify(item);
  }
}

/** A deterministic, locale-independent comparator. */
function compareKeys(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** An evidence package with every category present and empty. */
export function emptyEvidence(repoDir = null, limits = DEFAULT_LIMITS) {
  return { ...normalize({}, { repoDir, limits }), fixturePaths: [] };
}

/**
 * Turn raw scanner findings into the normalized, capped, redacted evidence
 * package. Pure: same input always yields the same output.
 *
 * @param {object} raw  map of category -> array of raw findings
 * @param {{repoDir?: string, limits?: object}} [options]
 */
// Last path segment, handling both separators without importing node:path —
// this module stays dependency-free so it can be reasoned about in isolation.
function basenameOf(p) {
  const trimmed = String(p).replace(/[\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

export function normalize(raw, options = {}) {
  const limits = resolveLimits(options.limits);
  const source = raw && typeof raw === "object" ? raw : {};

  const evidence = {
    evidenceVersion: EVIDENCE_VERSION,
    // The repo NAME only, never the absolute path. Evidence is designed to be
    // handed to a model (possibly a hosted one) to propose a .nomarmy.yml, and an
    // absolute path carries the local username and directory layout with it.
    // Callers that genuinely need the full path pass includeAbsolutePath: true.
    repoName: typeof options.repoDir === "string" ? basenameOf(options.repoDir) : null,
    repoDir: options.includeAbsolutePath === true && typeof options.repoDir === "string" ? options.repoDir : null,
    limits: {
      perCategory: limits.perCategory,
      stringLength: limits.stringLength,
      commandLength: limits.commandLength,
    },
    truncated: false,
    counts: {},
  };

  for (const category of CATEGORIES) {
    const sanitize = SANITIZERS[category];
    const input = Array.isArray(source[category]) ? source[category] : [];
    const seen = new Set();
    const rows = [];

    for (const rawItem of input) {
      const item = sanitize(rawItem, limits);
      if (!item) continue;
      const key = categoryKey(category, item);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ key, item });
    }

    rows.sort((a, b) => compareKeys(a.key, b.key));
    const total = rows.length;
    const kept = rows.slice(0, limits.perCategory).map((row) => row.item);
    const truncated = total > kept.length;
    if (truncated) evidence.truncated = true;

    evidence[category] = {
      items: kept,
      truncated,
      // `total` lets a reviewer see how much was dropped without the payload.
      total,
    };
    evidence.counts[category] = kept.length;
  }

  return evidence;
}

// ---------------------------------------------------------------------------
// Drift comparison (backs `nomarmy scan --check`)
// ---------------------------------------------------------------------------

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

function items(evidence, category) {
  const bucket = evidence && evidence[category];
  return bucket && Array.isArray(bucket.items) ? bucket.items : [];
}

function configServices(config) {
  if (!config || typeof config !== "object") return [];
  const raw = config.services ?? config.environment?.services ?? null;
  if (Array.isArray(raw)) {
    return raw.map((entry) => (typeof entry === "string" ? { name: entry } : entry)).filter(Boolean);
  }
  if (raw && typeof raw === "object") {
    return Object.entries(raw).map(([name, value]) => ({
      name,
      ...(value && typeof value === "object" ? value : {}),
    }));
  }
  return [];
}

function configServiceNames(config) {
  return configServices(config)
    .map((s) => (typeof s?.name === "string" ? s.name : null))
    .filter(Boolean);
}

function configPorts(config) {
  const out = [];
  if (!config || typeof config !== "object") return out;
  for (const value of asArray(config.ports)) out.push(value);
  for (const service of configServices(config)) {
    for (const value of asArray(service?.ports)) out.push(value);
    if (service?.port !== undefined) out.push(service.port);
    if (service?.healthcheck?.port !== undefined) out.push(service.healthcheck.port);
  }
  return out
    .map((value) => {
      if (value && typeof value === "object") return toPortNumber(value.published ?? value.target ?? value.port);
      const text = String(value);
      const match = text.match(/(\d{1,5})(?!.*\d)/);
      const first = text.match(/^(\d{1,5})/);
      return toPortNumber(first ? first[1] : match ? match[1] : null);
    })
    .filter((n) => n !== null);
}

function configEnvNames(config) {
  const out = [];
  if (!config || typeof config !== "object") return out;
  const sources = [config.env, config.environment, config.environmentNames, config.envNames];
  for (const src of sources) {
    if (Array.isArray(src)) out.push(...src.map((v) => (typeof v === "string" ? v : v?.name)));
    else if (src && typeof src === "object") out.push(...Object.keys(src));
  }
  for (const service of configServices(config)) {
    const src = service?.environment ?? service?.env ?? service?.environmentNames;
    if (Array.isArray(src)) out.push(...src.map((v) => (typeof v === "string" ? String(v).split("=")[0] : v?.name)));
    else if (src && typeof src === "object") out.push(...Object.keys(src));
  }
  return out.map(envName).filter(Boolean);
}

function configCommandKinds(config) {
  const out = [];
  if (!config || typeof config !== "object") return out;
  const commands = config.commands ?? config.scripts ?? null;
  if (Array.isArray(commands)) {
    for (const entry of commands) {
      if (typeof entry === "string") out.push(classifyCommand(entry, entry));
      else if (entry && typeof entry === "object") out.push(entry.kind || classifyCommand(entry.name, entry.command));
    }
  } else if (commands && typeof commands === "object") {
    for (const [name, value] of Object.entries(commands)) {
      out.push(COMMAND_KINDS.includes(name) ? name : classifyCommand(name, typeof value === "string" ? value : ""));
    }
  }
  for (const kind of COMMAND_KINDS) {
    if (typeof config[kind] === "string" && config[kind].trim()) out.push(kind);
  }
  if (typeof config.testCommand === "string") out.push("test");
  if (typeof config.startCommand === "string") out.push("start");
  return out.filter((kind) => COMMAND_KINDS.includes(kind));
}

function diffSets(repoValues, configValues) {
  const repo = new Set(repoValues);
  const cfg = new Set(configValues);
  const sortValues = (set) => [...set].sort((a, b) => compareKeys(String(a), String(b)));
  return {
    missingFromConfig: sortValues(new Set([...repo].filter((v) => !cfg.has(v)))),
    missingFromRepo: sortValues(new Set([...cfg].filter((v) => !repo.has(v)))),
    matched: sortValues(new Set([...repo].filter((v) => cfg.has(v)))),
  };
}

/**
 * Compare a scanned evidence package against an existing nomArmy config and
 * report drift in both directions. Pure: takes both as arguments, returns data,
 * reads no files.
 *
 * `missingFromConfig` = the repo has it, the config does not mention it.
 * `missingFromRepo`   = the config declares it, the scan found no evidence.
 */
export function compareEvidence(evidence, existingConfig) {
  const ev = evidence && typeof evidence === "object" ? evidence : {};
  const configPresent = Boolean(existingConfig && typeof existingConfig === "object");
  const config = configPresent ? existingConfig : null;

  const repoServiceNames = items(ev, "services").map((s) => s.name);
  const repoPorts = items(ev, "ports")
    .map((p) => (p.published !== null && p.published !== undefined ? p.published : p.target))
    .filter((n) => n !== null && n !== undefined);
  const repoEnvNames = items(ev, "environment").map((e) => e.name);
  const repoCommandKinds = items(ev, "commands").map((c) => c.kind);

  const sections = {
    services: diffSets(repoServiceNames, configServiceNames(config)),
    ports: diffSets(repoPorts, configPorts(config)),
    environment: diffSets(repoEnvNames, configEnvNames(config)),
    commandKinds: diffSets(repoCommandKinds, configCommandKinds(config)),
  };

  const notes = [];
  if (!configPresent) {
    notes.push("No existing config supplied; every finding is reported as missing from config.");
  }
  if (ev.truncated) {
    notes.push("Evidence package was truncated; drift may be incomplete.");
  }

  let missingFromConfig = 0;
  let missingFromRepo = 0;
  for (const section of Object.values(sections)) {
    missingFromConfig += section.missingFromConfig.length;
    missingFromRepo += section.missingFromRepo.length;
  }

  return {
    evidenceVersion: EVIDENCE_VERSION,
    configPresent,
    ok: missingFromConfig === 0 && missingFromRepo === 0,
    summary: {
      missingFromConfig,
      missingFromRepo,
      total: missingFromConfig + missingFromRepo,
    },
    ...sections,
    notes,
  };
}
