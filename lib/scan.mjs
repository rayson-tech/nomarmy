// nomArmy v1.3 — deterministic repository / environment scanner.
//
// `scanRepository(repoDir, options)` inspects a repository and returns the
// normalized evidence package defined by `lib/evidence.mjs`.
//
// HARD CONSTRAINTS (these are security properties, not style):
//   * READ ONLY. This module opens files. It never spawns a process, never
//     runs docker/npm/make, never resolves network anything. A scanner that
//     executes a command it discovered is a remote-code-execution bug.
//   * NAMES ONLY. Environment variables are recorded by name. A value from a
//     `.env.example`, a compose `environment:` block or a Dockerfile `ENV`
//     never enters the output.
//   * BOUNDED. Depth, entry count, file size, per-category findings and string
//     lengths are all capped. No whole file is ever inlined.
//   * DETERMINISTIC. No timestamps, no randomness. Directory listings are
//     sorted; findings are deduped and sorted by `normalize()`.
//
// This runs BEFORE any model sees the repository. The evidence it produces is
// what bounds the model's later config proposal.

import fs from "node:fs";
import path from "node:path";

import {
  classifyCommand,
  compareEvidence,
  emptyEvidence,
  envName,
  envNamesFromDotenv,
  envNamesFromInterpolation,
  normalize,
  resolveLimits,
} from "./evidence.mjs";

export { compareEvidence, emptyEvidence };

// ---------------------------------------------------------------------------
// Narrow YAML-subset parser
// ---------------------------------------------------------------------------
//
// The repo cannot assume `npm install` has run (another component owns
// package.json), so this module ships its own parser rather than importing
// `yaml`. It supports the subset Compose / CI files actually use:
//
//   block mappings, block sequences, sequences of mappings, nested blocks,
//   quoted and plain scalars, inline flow sequences `[a, b]` and flow maps
//   `{a: b}`, `#` comments, block scalars `|` and `>`, and the first document
//   of a multi-document file.
//
// It does NOT support anchors/aliases/merge keys, complex keys, or multi-line
// plain scalars. Those degrade: the parser records a note and the caller falls
// back to regex extraction for Compose files.

const BLANK_LINE = /^[ \t]*$/;

function expandIndent(raw) {
  const ws = raw.match(/^[ \t]*/)[0];
  const width = ws.replace(/\t/g, "  ").length;
  return { width, rest: raw.slice(ws.length) };
}

function stripComment(text) {
  let out = "";
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      out += ch;
      if (ch === "\\" && quote === '"' && i + 1 < text.length) {
        out += text[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(text[i - 1]))) break;
    out += ch;
  }
  return out;
}

function lineInfo(raw) {
  const { width, rest } = expandIndent(raw);
  const body = stripComment(rest).replace(/\s+$/, "");
  return { indent: width, body };
}

function nextSignificant(state) {
  while (state.i < state.src.length) {
    const raw = state.src[state.i];
    if (BLANK_LINE.test(raw)) {
      state.i += 1;
      continue;
    }
    const info = lineInfo(raw);
    if (info.body === "") {
      state.i += 1;
      continue;
    }
    if (info.body === "---" || info.body === "...") {
      if (state.started) {
        // Only the first document is parsed.
        state.i = state.src.length;
        return null;
      }
      state.i += 1;
      continue;
    }
    return info;
  }
  return null;
}

function consume(state) {
  state.i += 1;
  state.started = true;
}

function unquote(text) {
  if (typeof text !== "string" || text.length < 2) return text;
  const first = text[0];
  const last = text[text.length - 1];
  if (first === last && (first === '"' || first === "'")) {
    const inner = text.slice(1, -1);
    return first === '"'
      ? inner.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\(["\\])/g, "$1")
      : inner.replace(/''/g, "'");
  }
  return text;
}

function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === "\\" && quote === '"' && i + 1 < text.length) {
        current += text[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "[" || ch === "{") depth += 1;
    if (ch === "]" || ch === "}") depth -= 1;
    if (ch === separator && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

function splitKey(body) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quote) {
      if (ch === "\\" && quote === '"') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "[" || ch === "{") depth += 1;
    else if (ch === "]" || ch === "}") depth -= 1;
    else if (ch === ":" && depth === 0 && (i + 1 >= body.length || /\s/.test(body[i + 1]))) {
      const key = unquote(body.slice(0, i).trim());
      if (key === "") return null;
      return { key, rest: body.slice(i + 1).trim() };
    }
  }
  return null;
}

function parseScalar(text, state) {
  let value = text.trim();
  if (value === "") return null;
  if (value.startsWith("&")) {
    // Anchor definition: keep the value, drop the anchor token.
    state.notes.push("YAML anchors are not resolved by the narrow parser");
    value = value.replace(/^&\S+\s*/, "");
    if (value === "") return null;
  }
  if (value.startsWith("*")) {
    state.notes.push("YAML aliases are not resolved by the narrow parser");
    return null;
  }
  if (value.startsWith("!!")) value = value.replace(/^!!\S+\s*/, "");
  if (value === "~" || /^null$/i.test(value)) return null;
  if (/^true$/i.test(value)) return true;
  if (/^false$/i.test(value)) return false;
  if (/^-?\d+$/.test(value)) {
    const n = Number(value);
    if (Number.isSafeInteger(n)) return n;
  }
  if (/^-?\d*\.\d+$/.test(value)) return Number(value);
  return unquote(value);
}

function parseFlow(text, state) {
  const trimmed = text.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return splitTopLevel(trimmed.slice(1, -1), ",").map((part) => parseFlow(part, state));
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const map = {};
    for (const part of splitTopLevel(trimmed.slice(1, -1), ",")) {
      const kv = splitKey(part) || (part.includes(":") ? { key: part.split(":")[0].trim(), rest: part.split(":").slice(1).join(":").trim() } : null);
      if (kv) map[unquote(kv.key)] = parseFlow(kv.rest, state);
    }
    return map;
  }
  return parseScalar(trimmed, state);
}

function readBlockScalar(state, parentIndent, indicator) {
  const folded = indicator.trim().startsWith(">");
  const lines = [];
  let blockIndent = null;
  while (state.i < state.src.length) {
    const raw = state.src[state.i];
    if (BLANK_LINE.test(raw)) {
      lines.push("");
      consume(state);
      continue;
    }
    const { width, rest } = expandIndent(raw);
    if (width <= parentIndent) break;
    if (blockIndent === null) blockIndent = width;
    const pad = width - blockIndent;
    lines.push((pad > 0 ? " ".repeat(pad) : "") + rest.replace(/\s+$/, ""));
    consume(state);
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return folded ? lines.join(" ").replace(/\s+/g, " ").trim() : lines.join("\n");
}

function parseAfterKey(state, parentIndent, rest) {
  if (rest === "") {
    return parseNode(state, parentIndent + 1);
  }
  if (/^[|>][-+]?\d*$/.test(rest)) {
    return readBlockScalar(state, parentIndent, rest);
  }
  return parseFlow(rest, state);
}

function parseMap(state, indent) {
  const map = {};
  for (;;) {
    const info = nextSignificant(state);
    if (!info || info.indent < indent) break;
    if (info.indent > indent) {
      state.notes.push("unexpected indentation; line skipped");
      consume(state);
      continue;
    }
    if (info.body === "-" || info.body.startsWith("- ")) break;
    const kv = splitKey(info.body);
    if (!kv) {
      state.notes.push("unparsed YAML line skipped");
      consume(state);
      continue;
    }
    consume(state);
    map[kv.key] = parseAfterKey(state, indent, kv.rest);
  }
  return map;
}

function parseSeq(state, indent) {
  const list = [];
  for (;;) {
    const info = nextSignificant(state);
    if (!info || info.indent < indent) break;
    if (info.indent > indent) {
      state.notes.push("unexpected indentation; line skipped");
      consume(state);
      continue;
    }
    if (!(info.body === "-" || info.body.startsWith("- "))) break;
    const dash = info.body.match(/^-\s*/)[0];
    const rest = info.body.slice(dash.length).trim();
    const childIndent = info.indent + Math.max(dash.length, 2);
    consume(state);
    if (rest === "") {
      list.push(parseNode(state, indent + 1));
      continue;
    }
    const kv = rest.startsWith("[") || rest.startsWith("{") ? null : splitKey(rest);
    if (kv) {
      const entry = {};
      entry[kv.key] = parseAfterKey(state, childIndent, kv.rest);
      Object.assign(entry, parseMap(state, childIndent));
      list.push(entry);
      continue;
    }
    if (/^[|>][-+]?\d*$/.test(rest)) {
      list.push(readBlockScalar(state, info.indent, rest));
      continue;
    }
    list.push(parseFlow(rest, state));
  }
  return list;
}

function parseNode(state, minIndent) {
  const info = nextSignificant(state);
  if (!info || info.indent < minIndent) return null;
  if (info.body === "-" || info.body.startsWith("- ")) return parseSeq(state, info.indent);
  return parseMap(state, info.indent);
}

/**
 * Parse the supported YAML subset. Returns `{ value, notes }`. Never throws for
 * unsupported syntax; it records a note and degrades.
 */
export function parseYamlSubset(text) {
  const state = {
    src: String(text ?? "").replace(/\r\n?/g, "\n").split("\n"),
    i: 0,
    notes: [],
    started: false,
  };
  let value = null;
  try {
    value = parseNode(state, 0);
  } catch (err) {
    state.notes.push(`YAML subset parser failed: ${err && err.message ? err.message : "unknown error"}`);
    value = null;
  }
  return { value, notes: [...new Set(state.notes)] };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function toPosix(p) {
  return String(p).split(path.sep).join("/");
}

function asList(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

function flatten(value) {
  // Compose `command` / healthcheck `test` may be a string or a list.
  if (Array.isArray(value)) return value.filter((v) => v !== null && v !== undefined).map(String).join(" ");
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return null;
  return String(value);
}

function readCapped(fullPath, limits) {
  let stat;
  try {
    stat = fs.statSync(fullPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const size = Math.min(stat.size, limits.fileBytes);
  let fd;
  try {
    fd = fs.openSync(fullPath, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(size);
    if (size > 0) fs.readSync(fd, buf, 0, size, 0);
    return { text: buf.toString("utf8"), truncated: stat.size > size };
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

function parseJsonLoose(text) {
  // JSONC: devcontainer.json and tsconfig-style files allow comments and
  // trailing commas.
  const withoutComments = String(text)
    .replace(/\\"/g, "\u0000ESCQ\u0000")
    .replace(/"(?:[^"\\]|\\.)*"/g, (m) => m.replace(/\/\//g, "\u0000SL\u0000").replace(/\/\*/g, "\u0000BC\u0000"))
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/\u0000SL\u0000/g, "//")
    .replace(/\u0000BC\u0000/g, "/*")
    .replace(/\u0000ESCQ\u0000/g, '\\"')
    .replace(/,(\s*[}\]])/g, "$1");
  try {
    return JSON.parse(withoutComments);
  } catch {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// File classification
// ---------------------------------------------------------------------------

const IGNORED_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", "bower_components", ".venv", "venv", "env",
  "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", "dist", "build",
  "out", "target", "vendor", "coverage", ".next", ".nuxt", ".svelte-kit", ".turbo",
  ".cache", ".parcel-cache", ".gradle", ".idea", ".vs", ".terraform", "site-packages",
  "Pods", ".yarn", ".pnpm-store", "test-results", "playwright-report",
]);

// A path segment naming a fixtures-style directory anywhere in a matched
// file's relative path -- not a directory to skip walking (a real repo can
// have legitimate content elsewhere under the same tree), just a signal to
// label that specific finding as sample data once it's found. Deliberately
// narrower than "tests"/"__tests__" alone; see the comment at its call site.
const FIXTURE_PATH_RE = /(^|\/)(fixtures?|__fixtures__|testdata|test-data)(\/|$)/i;

const GREPPABLE_EXT = new Set([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts",
  ".py", ".go", ".java", ".kt", ".rb", ".cs", ".php", ".rs",
]);

const COMPOSE_RE = /^(docker-compose|compose)(\.[A-Za-z0-9_.-]+)?\.ya?ml$/i;
const DOCKERFILE_RE = /^(Dockerfile|Containerfile)([.-][A-Za-z0-9_.-]+)?$/i;
const DOCKERFILE_SUFFIX_RE = /\.(dockerfile|Dockerfile)$/;
const REQUIREMENTS_RE = /^requirements([-_.][A-Za-z0-9_.-]+)?\.txt$/i;
const ENV_EXAMPLE_RE = /^\.?env(\.[A-Za-z0-9_-]+)*\.(example|sample|template|dist|defaults)$/i;
const ENV_EXAMPLE_SUFFIX_RE = /\.env\.(example|sample|template|dist)$/i;
const PLAYWRIGHT_RE = /^playwright(-[a-z]+)?\.config\.[cm]?[jt]s$/i;
const CYPRESS_RE = /^cypress\.config\.[cm]?[jt]s$|^cypress\.json$/i;
const MAKEFILE_RE = /^(GNUmakefile|Makefile|makefile)$/;
const TASKFILE_RE = /^(Taskfile|taskfile)(\.dist)?\.ya?ml$/;
const PROCFILE_RE = /^Procfile(\.[A-Za-z0-9_-]+)?$/;
const CI_WORKFLOW_RE = /^\.(github|gitea)\/workflows\/[^/]+\.ya?ml$/i;
// Anchored to a `scripts/`-style directory at any depth so monorepo packages
// are covered; CI workflow paths stay root-anchored because that is the only
// place the CI provider reads them from.
const INTEGRATION_SCRIPT_RE = /(^|\/)(scripts|bin|tools|ci|hack)\/[^/]*(integration|e2e|smoke|acceptance|end-to-end)[^/]*$/i;

function classifyFile(relPath) {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  const lower = relPath.toLowerCase();

  if (COMPOSE_RE.test(base)) return "compose";
  if (DOCKERFILE_RE.test(base) || DOCKERFILE_SUFFIX_RE.test(base)) return "dockerfile";
  if (base === "devcontainer.json" || base === ".devcontainer.json") return "devcontainer";
  if (base === "package.json") return "package-json";
  if (base === "pnpm-workspace.yaml" || base === "pnpm-workspace.yml") return "pnpm-workspace";
  if (base === "pyproject.toml") return "pyproject";
  if (REQUIREMENTS_RE.test(base)) return "requirements";
  if (MAKEFILE_RE.test(base)) return "makefile";
  if (TASKFILE_RE.test(base)) return "taskfile";
  if (PROCFILE_RE.test(base)) return "procfile";
  if (PLAYWRIGHT_RE.test(base)) return "playwright-config";
  if (CYPRESS_RE.test(base)) return "cypress-config";
  if (ENV_EXAMPLE_RE.test(base) || ENV_EXAMPLE_SUFFIX_RE.test(base)) return "env-example";
  if (CI_WORKFLOW_RE.test(relPath)) return "ci-github";
  if (base === ".gitlab-ci.yml" || base === ".gitlab-ci.yaml") return "ci-gitlab";
  if (lower === ".circleci/config.yml" || lower === ".circleci/config.yaml") return "ci-circle";
  if (base === "azure-pipelines.yml" || base === "azure-pipelines.yaml") return "ci-azure";
  if (base === "Jenkinsfile") return "ci-jenkins";
  if (INTEGRATION_SCRIPT_RE.test(relPath)) return "integration-script";
  return null;
}

// ---------------------------------------------------------------------------
// Directory walk
// ---------------------------------------------------------------------------

function walk(root, limits) {
  const matched = [];
  const greppable = [];
  let visited = 0;
  let overflow = false;

  const queue = [{ dir: root, rel: "", depth: 0 }];
  while (queue.length) {
    const { dir, rel, depth } = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (visited >= limits.maxEntries) {
        overflow = true;
        break;
      }
      visited += 1;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue; // never follow links out of the repo
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        if (depth + 1 > limits.maxDepth) continue;
        queue.push({ dir: path.join(dir, entry.name), rel: relPath, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      const kind = classifyFile(relPath);
      if (kind) matched.push({ relPath, kind, full: path.join(dir, entry.name) });
      else if (GREPPABLE_EXT.has(path.extname(entry.name).toLowerCase())) {
        greppable.push({ relPath, full: path.join(dir, entry.name) });
      }
    }
    if (overflow) break;
  }

  matched.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  greppable.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return { matched, greppable, overflow };
}

// ---------------------------------------------------------------------------
// Compose
// ---------------------------------------------------------------------------

function parseComposePort(value, service, source) {
  if (typeof value === "number") {
    return { service, source, published: null, target: value, protocol: "tcp", raw: String(value) };
  }
  if (value && typeof value === "object") {
    return {
      service,
      source,
      published: value.published ?? null,
      target: value.target ?? null,
      protocol: value.protocol ?? "tcp",
      host: value.host_ip ?? null,
      raw: null,
    };
  }
  if (typeof value !== "string" || value.trim() === "") return null;
  const raw = value.trim();
  let body = raw;
  let protocol = "tcp";
  const slash = body.lastIndexOf("/");
  if (slash !== -1 && /^[a-zA-Z]+$/.test(body.slice(slash + 1))) {
    protocol = body.slice(slash + 1).toLowerCase();
    body = body.slice(0, slash);
  }
  const parts = body.split(":");
  let host = null;
  let published = null;
  let target = null;
  if (parts.length === 1) {
    target = parts[0];
  } else if (parts.length === 2) {
    published = parts[0];
    target = parts[1];
  } else {
    host = parts.slice(0, parts.length - 2).join(":");
    published = parts[parts.length - 2];
    target = parts[parts.length - 1];
  }
  return { service, source, host, published, target, protocol, raw };
}

/** Environment variable NAMES from a compose `environment:` block. Values dropped. */
function composeEnvNames(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry.split("=")[0] : null))
      .map((name) => envName(name))
      .filter(Boolean);
  }
  if (value && typeof value === "object") {
    return Object.keys(value).map((name) => envName(name)).filter(Boolean);
  }
  return [];
}

/** Interpolated `${VAR}` names appearing anywhere in a nested value. */
function collectInterpolatedNames(value, out = [], depth = 0) {
  if (depth > 6) return out;
  if (typeof value === "string") {
    out.push(...envNamesFromInterpolation(value));
  } else if (Array.isArray(value)) {
    for (const entry of value) collectInterpolatedNames(entry, out, depth + 1);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(...envNamesFromInterpolation(k));
      collectInterpolatedNames(v, out, depth + 1);
    }
  }
  return out;
}

const SEED_HINT_RE = /(seed|init|migrat|fixture|bootstrap|schema)/i;

function composeRegexFallback(text, source, raw) {
  // Degraded path: locate service names and a few obvious keys by regex.
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  let inServices = false;
  let serviceIndent = null;
  let current = null;
  const services = [];
  for (const line of lines) {
    if (/^services:\s*$/.test(line)) {
      inServices = true;
      continue;
    }
    if (!inServices) continue;
    if (/^\S/.test(line)) {
      if (!/^\s/.test(line) && line.trim() !== "") break; // next top-level key
      continue;
    }
    const m = line.match(/^(\s+)([A-Za-z0-9_][A-Za-z0-9_.-]*):\s*$/);
    if (m) {
      const indent = m[1].length;
      if (serviceIndent === null) serviceIndent = indent;
      if (indent === serviceIndent) {
        current = { name: m[2], source, ports: [], environmentNames: [], dependsOn: [], profiles: [] };
        services.push(current);
        continue;
      }
    }
    if (!current) continue;
    const image = line.match(/^\s+image:\s*(\S+)/);
    if (image) current.image = image[1];
    const port = line.match(/^\s*-\s*["']?([0-9.:\-/]+)["']?\s*$/);
    if (port && /\d/.test(port[1])) {
      const parsed = parseComposePort(port[1], current.name, source);
      if (parsed) raw.ports.push(parsed);
      current.ports.push(port[1]);
    }
  }
  for (const service of services) raw.services.push(service);
  return services.length;
}

function handleCompose(text, source, raw) {
  const { value, notes } = parseYamlSubset(text);
  for (const note of notes) raw.notes.push({ level: "warn", message: note, source });

  const services = value && typeof value === "object" ? value.services : null;
  if (!services || typeof services !== "object" || Array.isArray(services)) {
    const found = composeRegexFallback(text, source, raw);
    raw.notes.push({
      level: "warn",
      message: found
        ? "Compose parsed by regex fallback; only service names, images and ports are reliable."
        : "Compose file found but no services could be extracted.",
      source,
    });
    return;
  }

  const profileMap = new Map();

  for (const [name, spec] of Object.entries(services)) {
    if (!name || typeof name !== "string") continue;
    const service = {
      name,
      source,
      image: null,
      build: null,
      command: null,
      ports: [],
      environmentNames: [],
      envFiles: [],
      dependsOn: [],
      profiles: [],
      healthcheck: false,
    };
    const def = spec && typeof spec === "object" && !Array.isArray(spec) ? spec : {};

    service.image = typeof def.image === "string" ? def.image : null;
    if (typeof def.build === "string") service.build = def.build;
    else if (def.build && typeof def.build === "object") {
      service.build = [def.build.context, def.build.dockerfile, def.build.target]
        .filter((v) => typeof v === "string")
        .join(" ") || "(build)";
    }
    service.command = flatten(def.command) || flatten(def.entrypoint);

    for (const entry of asList(def.ports)) {
      const parsed = parseComposePort(entry, name, source);
      if (!parsed) continue;
      raw.ports.push(parsed);
      service.ports.push(parsed.raw || `${parsed.published ?? ""}:${parsed.target ?? ""}`);
    }
    for (const entry of asList(def.expose)) {
      const parsed = parseComposePort(entry, name, source);
      if (parsed) raw.ports.push({ ...parsed, published: null });
    }

    // NAMES ONLY — values are deliberately discarded here.
    const envNames = composeEnvNames(def.environment);
    service.environmentNames = envNames;
    for (const envVar of envNames) {
      raw.environment.push({ name: envVar, scope: "compose", service: name, source });
    }
    for (const file of asList(def.env_file)) {
      const target = typeof file === "string" ? file : file && typeof file === "object" ? file.path : null;
      if (typeof target === "string") service.envFiles.push(target);
    }

    const dependsOn = def.depends_on;
    if (Array.isArray(dependsOn)) {
      for (const dep of dependsOn) {
        if (typeof dep !== "string") continue;
        service.dependsOn.push(dep);
        raw.dependencies.push({ from: name, to: dep, condition: null, source });
      }
    } else if (dependsOn && typeof dependsOn === "object") {
      for (const [dep, cfg] of Object.entries(dependsOn)) {
        service.dependsOn.push(dep);
        raw.dependencies.push({
          from: name,
          to: dep,
          condition: cfg && typeof cfg === "object" ? cfg.condition ?? null : null,
          source,
        });
      }
    }
    for (const link of asList(def.links)) {
      if (typeof link === "string") {
        const target = link.split(":")[0];
        raw.dependencies.push({ from: name, to: target, condition: "link", source });
      }
    }

    if (def.healthcheck && typeof def.healthcheck === "object") {
      service.healthcheck = true;
      raw.healthchecks.push({
        service: name,
        test: flatten(def.healthcheck.test),
        interval: def.healthcheck.interval ?? null,
        timeout: def.healthcheck.timeout ?? null,
        retries: def.healthcheck.retries ?? null,
        startPeriod: def.healthcheck.start_period ?? null,
        source,
      });
    }

    for (const profile of asList(def.profiles)) {
      if (typeof profile !== "string") continue;
      service.profiles.push(profile);
      if (!profileMap.has(profile)) profileMap.set(profile, []);
      profileMap.get(profile).push(name);
    }

    for (const volume of asList(def.volumes)) {
      const spec2 = typeof volume === "string" ? volume : volume && typeof volume === "object" ? volume.source : null;
      if (typeof spec2 !== "string") continue;
      const hostPath = spec2.split(":")[0];
      if (SEED_HINT_RE.test(hostPath) || /\.(sql|sh)$/i.test(hostPath) || /initdb/i.test(spec2)) {
        raw.seeds.push({ name: hostPath, kind: "compose-volume", target: spec2, service: name, source });
      }
    }

    if (service.command) {
      raw.commands.push({
        name: `compose:${name}`,
        kind: classifyCommand(name, service.command),
        command: service.command,
        source,
      });
    }

    raw.services.push(service);
  }

  for (const [profile, members] of profileMap) {
    raw.profiles.push({ name: profile, services: members, source });
  }

  for (const envVar of collectInterpolatedNames(value)) {
    raw.environment.push({ name: envVar, scope: "compose-interpolation", source });
  }

  raw.tooling.push({ name: "docker compose", category: "container", detail: source, source });
  raw.commands.push({
    name: "compose up",
    kind: "start",
    command: `docker compose -f ${source} up -d`,
    source,
  });
}

// ---------------------------------------------------------------------------
// package.json / node ecosystem
// ---------------------------------------------------------------------------

const NODE_TOOLING = [
  [/^@playwright\/test$|^playwright$|^playwright-core$/, "playwright", "e2e"],
  [/^cypress$/, "cypress", "e2e"],
  [/^puppeteer/, "puppeteer", "e2e"],
  [/^(webdriverio|selenium-webdriver|@wdio\/)/, "webdriver", "e2e"],
  [/^(testcontainers|@testcontainers\/)/, "testcontainers", "container"],
  [/^jest$|^ts-jest$/, "jest", "test"],
  [/^vitest$/, "vitest", "test"],
  [/^mocha$/, "mocha", "test"],
  [/^ava$/, "ava", "test"],
  [/^supertest$/, "supertest", "test"],
  [/^prisma$|^@prisma\/client$/, "prisma", "migration"],
  [/^knex$/, "knex", "migration"],
  [/^typeorm$/, "typeorm", "migration"],
  [/^sequelize/, "sequelize", "migration"],
  [/^drizzle-kit$/, "drizzle", "migration"],
  [/^(express|fastify|koa|@nestjs\/core|next|nuxt)$/, "node web framework", "runtime"],
  [/^(pg|mysql2?|mongodb|redis|ioredis)$/, "database client", "runtime"],
];

function handlePackageJson(text, source, raw) {
  const pkg = parseJsonLoose(text);
  if (!pkg || typeof pkg !== "object") {
    raw.notes.push({ level: "warn", message: "package.json could not be parsed", source });
    return;
  }

  const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== "string") continue;
    raw.commands.push({
      name: `npm run ${name}`,
      kind: classifyCommand(name, command),
      command,
      source,
    });
    for (const envVar of envNamesFromInterpolation(command)) {
      raw.environment.push({ name: envVar, scope: "npm-script", source });
    }
  }

  if (typeof pkg.packageManager === "string") {
    raw.tooling.push({
      name: pkg.packageManager.split("@")[0],
      category: "package-manager",
      detail: pkg.packageManager,
      source,
    });
  }
  if (pkg.workspaces) {
    const globs = Array.isArray(pkg.workspaces) ? pkg.workspaces : asList(pkg.workspaces.packages);
    raw.tooling.push({
      name: "npm workspaces",
      category: "package-manager",
      detail: globs.filter((g) => typeof g === "string").join(", ") || "(declared)",
      source,
    });
  }
  if (pkg.engines && typeof pkg.engines === "object" && typeof pkg.engines.node === "string") {
    raw.tooling.push({ name: "node", category: "runtime", detail: pkg.engines.node, source });
  }

  const deps = {};
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const bucket = pkg[field];
    if (bucket && typeof bucket === "object") Object.assign(deps, bucket);
  }
  const seen = new Set();
  for (const dep of Object.keys(deps).sort()) {
    for (const [re, name, category] of NODE_TOOLING) {
      if (re.test(dep) && !seen.has(name)) {
        seen.add(name);
        raw.tooling.push({ name, category, detail: `dependency ${dep}`, source });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Python ecosystem
// ---------------------------------------------------------------------------

const PYTHON_TOOLING = [
  [/^pytest/, "pytest", "test"],
  [/^(playwright|pytest-playwright)$/, "playwright", "e2e"],
  [/^testcontainers/, "testcontainers", "container"],
  [/^(alembic)$/, "alembic", "migration"],
  [/^(django)$/, "django", "runtime"],
  [/^(flask|fastapi|starlette)$/, "python web framework", "runtime"],
  [/^(uvicorn|gunicorn|hypercorn)$/, "python app server", "runtime"],
  [/^(celery)$/, "celery", "runtime"],
  [/^(psycopg2?|asyncpg|pymysql|redis|pymongo|sqlalchemy)/, "database client", "runtime"],
  [/^(tox|nox)$/, "tox", "test"],
  [/^(ruff|flake8|black|mypy)$/, "python linting", "lint"],
];

function recordPythonDependency(dep, source, raw, seen) {
  const name = dep.trim().toLowerCase().replace(/[[<>=!~;].*$/, "").trim();
  if (!name) return;
  for (const [re, label, category] of PYTHON_TOOLING) {
    if (re.test(name) && !seen.has(label)) {
      seen.add(label);
      raw.tooling.push({ name: label, category, detail: `dependency ${name}`, source });
    }
  }
}

function handleRequirements(text, source, raw) {
  const seen = new Set();
  for (const line of String(text).replace(/\r\n?/g, "\n").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) continue;
    recordPythonDependency(trimmed, source, raw, seen);
  }
  raw.tooling.push({ name: "pip", category: "package-manager", detail: source, source });
  raw.commands.push({ name: "pip install", kind: "build", command: `pip install -r ${source}`, source });
}

function handlePyproject(text, source, raw) {
  const body = String(text).replace(/\r\n?/g, "\n");
  const seen = new Set();
  for (const match of body.matchAll(/["']([A-Za-z0-9_.-]+)\s*(?:[[<>=!~].*?)?["']/g)) {
    recordPythonDependency(match[1], source, raw, seen);
  }
  for (const match of body.matchAll(/^\s*([A-Za-z0-9_.-]+)\s*=\s*["{]/gm)) {
    recordPythonDependency(match[1], source, raw, seen);
  }
  if (/^\s*\[tool\.poetry\]/m.test(body)) {
    raw.tooling.push({ name: "poetry", category: "package-manager", detail: source, source });
  }
  if (/^\s*\[tool\.uv/m.test(body)) {
    raw.tooling.push({ name: "uv", category: "package-manager", detail: source, source });
  }
  if (/^\s*\[tool\.pytest/m.test(body)) {
    raw.tooling.push({ name: "pytest", category: "test", detail: "pytest config", source });
    raw.commands.push({ name: "pytest", kind: "test", command: "pytest", source });
  }
  // [project.scripts] / [tool.poetry.scripts] entry points
  const sections = body.split(/^\s*\[/m);
  for (const section of sections) {
    if (!/^(project\.scripts|tool\.poetry\.scripts)\]/.test(section)) continue;
    for (const match of section.matchAll(/^\s*([A-Za-z0-9_.-]+)\s*=\s*["']([^"']+)["']/gm)) {
      raw.commands.push({
        name: match[1],
        kind: classifyCommand(match[1], match[2]),
        command: match[2],
        source,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Makefile / Taskfile / Procfile
// ---------------------------------------------------------------------------

function handleMakefile(text, source, raw) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  let current = null;
  for (const line of lines) {
    const target = line.match(/^([A-Za-z0-9_][A-Za-z0-9_.\-/]*)\s*:(?!=)\s*(.*)$/);
    if (target) {
      current = target[1];
      raw.commands.push({
        name: `make ${current}`,
        kind: classifyCommand(current, ""),
        command: `make ${current}`,
        source,
      });
      continue;
    }
    if (current && /^\t/.test(line)) {
      const recipe = line.replace(/^\t/, "").replace(/^[@-]+/, "").trim();
      if (recipe && !recipe.startsWith("#")) {
        for (const envVar of envNamesFromInterpolation(recipe)) {
          raw.environment.push({ name: envVar, scope: "makefile", source });
        }
      }
      continue;
    }
    const assignment = line.match(/^([A-Z][A-Z0-9_]*)\s*[:?+]?=/);
    if (assignment) {
      // NAME only; the assigned value is never recorded.
      const name = envName(assignment[1]);
      if (name) raw.environment.push({ name, scope: "makefile", source });
    }
  }
  raw.tooling.push({ name: "make", category: "build", detail: source, source });
}

function handleTaskfile(text, source, raw) {
  const { value, notes } = parseYamlSubset(text);
  for (const note of notes) raw.notes.push({ level: "warn", message: note, source });
  const tasks = value && typeof value === "object" ? value.tasks : null;
  if (!tasks || typeof tasks !== "object") return;
  for (const [name, spec] of Object.entries(tasks)) {
    const cmds = spec && typeof spec === "object" ? asList(spec.cmds ?? spec.cmd) : [];
    const command = cmds
      .map((c) => (typeof c === "string" ? c : c && typeof c === "object" ? c.cmd ?? c.task : null))
      .filter((c) => typeof c === "string")
      .join(" && ");
    raw.commands.push({
      name: `task ${name}`,
      kind: classifyCommand(name, command),
      command: command || `task ${name}`,
      source,
    });
  }
  raw.tooling.push({ name: "task", category: "build", detail: source, source });
}

function handleProcfile(text, source, raw) {
  for (const line of String(text).replace(/\r\n?/g, "\n").split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
    if (!match) continue;
    raw.commands.push({
      name: match[1],
      kind: classifyCommand(match[1], match[2]) === "other" ? "start" : classifyCommand(match[1], match[2]),
      command: match[2],
      source,
    });
    for (const envVar of envNamesFromInterpolation(match[2])) {
      raw.environment.push({ name: envVar, scope: "procfile", source });
    }
  }
}

// ---------------------------------------------------------------------------
// Dockerfile / devcontainer
// ---------------------------------------------------------------------------

function handleDockerfile(text, source, raw) {
  const joined = String(text).replace(/\r\n?/g, "\n").replace(/\\\n/g, " ");
  for (const rawLine of joined.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z]+)\s+([\s\S]*)$/);
    if (!match) continue;
    const directive = match[1].toUpperCase();
    const rest = match[2].trim();

    if (directive === "EXPOSE") {
      for (const token of rest.split(/\s+/)) {
        const parsed = parseComposePort(token, null, source);
        if (parsed) raw.ports.push({ ...parsed, published: null });
      }
    } else if (directive === "ENV" || directive === "ARG") {
      // NAMES ONLY.
      const assignments = [...rest.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=/g)].map((m) => m[1]);
      const names = assignments.length ? assignments : [rest.split(/\s+/)[0]];
      for (const candidate of names) {
        const name = envName(candidate);
        if (name) {
          raw.environment.push({
            name,
            scope: directive === "ARG" ? "dockerfile-arg" : "dockerfile-env",
            source,
          });
        }
      }
    } else if (directive === "HEALTHCHECK") {
      const interval = rest.match(/--interval=(\S+)/);
      const timeout = rest.match(/--timeout=(\S+)/);
      const retries = rest.match(/--retries=(\S+)/);
      const startPeriod = rest.match(/--start-period=(\S+)/);
      const cmd = rest.match(/\bCMD\b\s+([\s\S]+)$/);
      raw.healthchecks.push({
        service: null,
        test: cmd ? cmd[1] : rest,
        interval: interval ? interval[1] : null,
        timeout: timeout ? timeout[1] : null,
        retries: retries ? retries[1] : null,
        startPeriod: startPeriod ? startPeriod[1] : null,
        source,
      });
    } else if (directive === "CMD" || directive === "ENTRYPOINT") {
      const parsedJson = rest.startsWith("[") ? parseJsonLoose(rest) : null;
      const command = Array.isArray(parsedJson) ? parsedJson.join(" ") : rest;
      raw.commands.push({ name: `${source} ${directive}`, kind: "start", command, source });
    } else if (directive === "FROM") {
      const image = rest.split(/\s+/)[0];
      if (image) raw.tooling.push({ name: "base image", category: "container", detail: image, source });
    }
  }
  raw.tooling.push({ name: "docker", category: "container", detail: source, source });
}

function handleDevcontainer(text, source, raw) {
  const cfg = parseJsonLoose(text);
  if (!cfg || typeof cfg !== "object") {
    raw.notes.push({ level: "warn", message: "devcontainer.json could not be parsed", source });
    return;
  }
  raw.tooling.push({ name: "devcontainer", category: "container", detail: source, source });
  if (typeof cfg.image === "string") {
    raw.tooling.push({ name: "devcontainer image", category: "container", detail: cfg.image, source });
  }
  for (const file of asList(cfg.dockerComposeFile)) {
    if (typeof file === "string") {
      raw.tooling.push({ name: "devcontainer compose", category: "container", detail: file, source });
    }
  }
  if (typeof cfg.service === "string") {
    raw.services.push({ name: cfg.service, source, image: typeof cfg.image === "string" ? cfg.image : null });
  }
  for (const port of [...asList(cfg.forwardPorts), ...asList(cfg.appPort)]) {
    const parsed = parseComposePort(port, cfg.service ?? null, source);
    if (parsed) raw.ports.push(parsed);
  }
  for (const field of ["postCreateCommand", "postStartCommand", "postAttachCommand", "initializeCommand", "onCreateCommand", "updateContentCommand"]) {
    const value = cfg[field];
    const command = typeof value === "string" ? value : Array.isArray(value) ? value.join(" ") : null;
    if (command) {
      raw.commands.push({ name: field, kind: classifyCommand(field, command), command, source });
    } else if (value && typeof value === "object") {
      for (const [name, inner] of Object.entries(value)) {
        const flat = flatten(inner);
        if (flat) raw.commands.push({ name: `${field}.${name}`, kind: classifyCommand(name, flat), command: flat, source });
      }
    }
  }
  for (const field of ["remoteEnv", "containerEnv"]) {
    const bucket = cfg[field];
    if (!bucket || typeof bucket !== "object") continue;
    // NAMES ONLY.
    for (const name of Object.keys(bucket)) {
      const valid = envName(name);
      if (valid) raw.environment.push({ name: valid, scope: `devcontainer-${field}`, source });
    }
  }
  if (cfg.features && typeof cfg.features === "object") {
    for (const feature of Object.keys(cfg.features)) {
      raw.tooling.push({ name: "devcontainer feature", category: "container", detail: feature, source });
    }
  }
}

// ---------------------------------------------------------------------------
// E2E configs
// ---------------------------------------------------------------------------

function handleBrowserConfig(text, source, raw, tool) {
  raw.tooling.push({ name: tool, category: "e2e", detail: source, source });
  const body = String(text);

  const webServerCommand = body.match(/command\s*:\s*["'`]([^"'`]{1,300})["'`]/);
  if (webServerCommand) {
    raw.commands.push({
      name: `${tool} webServer`,
      kind: "start",
      command: webServerCommand[1],
      source,
    });
  }
  for (const match of body.matchAll(/\b(?:baseURL|baseUrl|url)\s*:\s*["'`]([^"'`]{1,200})["'`]/g)) {
    const portMatch = match[1].match(/:(\d{2,5})(?:\/|$)/);
    if (portMatch) {
      raw.ports.push({ service: null, source, published: portMatch[1], target: portMatch[1], protocol: "tcp", raw: match[1] });
    }
    for (const envVar of envNamesFromInterpolation(match[1])) {
      raw.environment.push({ name: envVar, scope: `${tool}-config`, source });
    }
  }
  for (const match of body.matchAll(/\bport\s*:\s*(\d{2,5})\b/g)) {
    raw.ports.push({ service: null, source, published: match[1], target: match[1], protocol: "tcp", raw: match[1] });
  }
  for (const match of body.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const name = envName(match[1]);
    if (name) raw.environment.push({ name, scope: `${tool}-config`, source });
  }
  for (const match of body.matchAll(/process\.env\[\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\]/g)) {
    const name = envName(match[1]);
    if (name) raw.environment.push({ name, scope: `${tool}-config`, source });
  }
  raw.commands.push({
    name: tool === "playwright" ? "playwright test" : "cypress run",
    kind: "e2e",
    command: tool === "playwright" ? "npx playwright test" : "npx cypress run",
    source,
  });
}

// ---------------------------------------------------------------------------
// CI
// ---------------------------------------------------------------------------

const CI_RUN_CAP = 25;

function handleGithubWorkflow(text, source, raw) {
  const { value, notes } = parseYamlSubset(text);
  for (const note of notes) raw.notes.push({ level: "warn", message: note, source });
  const doc = value && typeof value === "object" ? value : {};
  const jobs = doc.jobs && typeof doc.jobs === "object" ? doc.jobs : {};
  const triggers = doc.on && typeof doc.on === "object" && !Array.isArray(doc.on)
    ? Object.keys(doc.on)
    : asList(doc.on).filter((t) => typeof t === "string");

  const serviceNames = [];
  let runs = 0;
  for (const [jobName, job] of Object.entries(jobs)) {
    const def = job && typeof job === "object" ? job : {};
    if (def.services && typeof def.services === "object") {
      for (const [svc, spec] of Object.entries(def.services)) {
        serviceNames.push(svc);
        raw.services.push({
          name: svc,
          source,
          image: spec && typeof spec === "object" ? spec.image ?? null : null,
          environmentNames: spec && typeof spec === "object" ? composeEnvNames(spec.env) : [],
        });
        if (spec && typeof spec === "object") {
          for (const envVar of composeEnvNames(spec.env)) {
            raw.environment.push({ name: envVar, scope: "ci-service", service: svc, source });
          }
          for (const port of asList(spec.ports)) {
            const parsed = parseComposePort(port, svc, source);
            if (parsed) raw.ports.push(parsed);
          }
        }
      }
    }
    for (const envVar of composeEnvNames(def.env)) {
      raw.environment.push({ name: envVar, scope: "ci-job", source });
    }
    for (const step of asList(def.steps)) {
      if (!step || typeof step !== "object") continue;
      for (const envVar of composeEnvNames(step.env)) {
        raw.environment.push({ name: envVar, scope: "ci-step", source });
      }
      if (typeof step.uses === "string") {
        raw.tooling.push({ name: "github action", category: "ci", detail: step.uses.split("@")[0], source });
      }
      if (typeof step.run === "string" && runs < CI_RUN_CAP) {
        runs += 1;
        const first = step.run.split("\n").map((l) => l.trim()).filter(Boolean)[0] || step.run;
        raw.commands.push({
          name: `ci:${jobName}:${step.name || `step${runs}`}`,
          kind: classifyCommand(step.name || jobName, step.run),
          command: first,
          source,
        });
      }
    }
  }
  for (const envVar of composeEnvNames(doc.env)) {
    raw.environment.push({ name: envVar, scope: "ci-workflow", source });
  }
  raw.ci.push({
    path: source,
    name: typeof doc.name === "string" ? doc.name : null,
    jobs: Object.keys(jobs),
    triggers,
    services: serviceNames,
  });
}

function handleGitlabCi(text, source, raw) {
  const { value, notes } = parseYamlSubset(text);
  for (const note of notes) raw.notes.push({ level: "warn", message: note, source });
  const doc = value && typeof value === "object" ? value : {};
  const jobs = [];
  const serviceNames = [];
  let runs = 0;
  for (const [key, spec] of Object.entries(doc)) {
    if (key.startsWith(".") || !spec || typeof spec !== "object" || Array.isArray(spec)) continue;
    const scripts = [...asList(spec.script), ...asList(spec.before_script)];
    if (!scripts.length && !spec.stage) continue;
    jobs.push(key);
    for (const svc of asList(spec.services ?? spec.image)) {
      const name = typeof svc === "string" ? svc : svc && typeof svc === "object" ? svc.name : null;
      if (typeof name === "string") serviceNames.push(name);
    }
    for (const line of scripts) {
      if (typeof line !== "string" || runs >= CI_RUN_CAP) continue;
      runs += 1;
      raw.commands.push({ name: `ci:${key}`, kind: classifyCommand(key, line), command: line, source });
    }
    for (const envVar of composeEnvNames(spec.variables)) {
      raw.environment.push({ name: envVar, scope: "ci-job", source });
    }
  }
  for (const envVar of composeEnvNames(doc.variables)) {
    raw.environment.push({ name: envVar, scope: "ci-workflow", source });
  }
  raw.ci.push({ path: source, name: "gitlab-ci", jobs, triggers: [], services: serviceNames });
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

const TESTCONTAINERS_RE = /testcontainers/i;

function emptyRaw() {
  return {
    files: [],
    services: [],
    commands: [],
    ports: [],
    healthchecks: [],
    dependencies: [],
    environment: [],
    tooling: [],
    profiles: [],
    seeds: [],
    ci: [],
    notes: [],
  };
}

/**
 * Scan a repository and return a normalized evidence package.
 *
 * Synchronous, read-only and side-effect free. Missing or unreadable files are
 * normal; a repo containing none of the recognised files still returns a valid
 * (empty) evidence package.
 *
 * @param {string} repoDir absolute or relative path to the repository root
 * @param {{limits?: object}} [options]
 */
export function scanRepository(repoDir, options = {}) {
  const limits = resolveLimits(options.limits);
  const root = path.resolve(String(repoDir ?? "."));
  const raw = emptyRaw();

  let stat = null;
  try {
    stat = fs.statSync(root);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isDirectory()) {
    raw.notes.push({ level: "warn", message: "repository directory not found or unreadable", source: toPosix(root) });
    return { ...normalize(raw, { repoDir: root, limits, includeAbsolutePath: options.includeAbsolutePath === true }), fixturePaths: [] };
  }

  const { matched, greppable, overflow } = walk(root, limits);
  if (overflow) {
    raw.notes.push({ level: "warn", message: "directory walk hit the entry cap; scan is partial" });
  }

  // A path under a fixtures-style directory is sample data for testing the
  // repo itself, not real infrastructure -- observed directly against this
  // project: tests/fixtures/node-stack/compose.yaml was reported as a real
  // service with real ports. Deliberately NOT matching bare "tests/"/
  // "__tests__/" alone: a repo's genuine test infrastructure (e.g. a real
  // docker-compose for its own integration suite) can legitimately live
  // there, and that evidence should still be reported normally. Labelled,
  // not excluded, from the evidence itself -- this scan still answers "what
  // did you find", any narrower proposal built from it decides what to trust.
  const fixturePaths = [...new Set(matched.filter((f) => FIXTURE_PATH_RE.test(f.relPath)).map((f) => f.relPath))];
  for (const source of fixturePaths) {
    raw.notes.push({ level: "info", message: "path looks like test fixture data, not real repository infrastructure -- excluded from any automated .nomarmy.yml proposal", source });
  }

  for (const file of matched) {
    const source = file.relPath;
    raw.files.push({ path: source, kind: file.kind });

    // `.env.example` and friends are read for NAMES. A real `.env` is never
    // classified and therefore never read.
    const read = readCapped(file.full, limits);
    if (!read) {
      raw.notes.push({ level: "info", message: "file could not be read; skipped", source });
      continue;
    }
    if (read.truncated) {
      raw.notes.push({ level: "info", message: "file truncated at the byte cap before parsing", source });
    }

    try {
      dispatch(file.kind, read.text, source, raw);
    } catch (err) {
      raw.notes.push({
        level: "warn",
        message: `parser error, finding skipped: ${err && err.message ? err.message : "unknown"}`,
        source,
      });
    }
  }

  // Bounded content grep for testcontainers usage in source files.
  let grepped = 0;
  for (const file of greppable) {
    if (grepped >= limits.grepFiles) {
      raw.notes.push({ level: "info", message: "source grep hit the file cap; usage detection is partial" });
      break;
    }
    grepped += 1;
    const read = readCapped(file.full, { ...limits, fileBytes: Math.min(limits.fileBytes, 32 * 1024) });
    if (!read) continue;
    if (TESTCONTAINERS_RE.test(read.text)) {
      raw.tooling.push({
        name: "testcontainers",
        category: "container",
        detail: "referenced in source",
        source: file.relPath,
      });
    }
  }

  return { ...normalize(raw, { repoDir: root, limits, includeAbsolutePath: options.includeAbsolutePath === true }), fixturePaths };
}

function dispatch(kind, text, source, raw) {
  switch (kind) {
    case "compose":
      handleCompose(text, source, raw);
      break;
    case "dockerfile":
      handleDockerfile(text, source, raw);
      break;
    case "devcontainer":
      handleDevcontainer(text, source, raw);
      break;
    case "package-json":
      handlePackageJson(text, source, raw);
      break;
    case "pnpm-workspace": {
      const { value } = parseYamlSubset(text);
      const packages = value && typeof value === "object" ? asList(value.packages) : [];
      raw.tooling.push({
        name: "pnpm",
        category: "package-manager",
        detail: packages.filter((p) => typeof p === "string").join(", ") || "workspace",
        source,
      });
      break;
    }
    case "pyproject":
      handlePyproject(text, source, raw);
      break;
    case "requirements":
      handleRequirements(text, source, raw);
      break;
    case "makefile":
      handleMakefile(text, source, raw);
      break;
    case "taskfile":
      handleTaskfile(text, source, raw);
      break;
    case "procfile":
      handleProcfile(text, source, raw);
      break;
    case "playwright-config":
      handleBrowserConfig(text, source, raw, "playwright");
      break;
    case "cypress-config":
      handleBrowserConfig(text, source, raw, "cypress");
      break;
    case "env-example":
      for (const name of envNamesFromDotenv(text)) {
        // NAMES ONLY — the right-hand side of every line is discarded.
        raw.environment.push({ name, scope: "env-example", source });
      }
      break;
    case "ci-github":
      handleGithubWorkflow(text, source, raw);
      break;
    case "ci-gitlab":
      handleGitlabCi(text, source, raw);
      break;
    case "ci-circle":
    case "ci-azure":
    case "ci-jenkins":
      raw.ci.push({ path: source, name: kind, jobs: [], triggers: [], services: [] });
      raw.tooling.push({ name: kind, category: "ci", detail: source, source });
      break;
    case "integration-script": {
      const base = source.slice(source.lastIndexOf("/") + 1);
      const classified = classifyCommand(base, "");
      raw.commands.push({
        name: base,
        kind: classified === "other" ? "e2e" : classified,
        command: `./${source}`,
        source,
      });
      for (const name of envNamesFromInterpolation(text)) {
        raw.environment.push({ name, scope: "script", source });
      }
      break;
    }
    default:
      break;
  }
}

export default scanRepository;
