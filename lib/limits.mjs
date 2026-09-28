// Machine-wide limits, in the global config.yml under `limits:`. One place
// for every coordinator: an environment variable lives in each Claude Code,
// Codex and Cursor registration separately, so the sessions could disagree.

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { globalConfigDir, GLOBAL_CONFIG_FILENAME, limitsSchema, MAX_MAX_JOBS } from "./army.mjs";
import { RESERVES } from "./sizing.mjs";

export { limitsSchema, MAX_MAX_JOBS };
export const DEFAULT_MAX_JOBS = 4;

export function globalConfigPath(env = process.env) {
  return path.join(globalConfigDir(env), GLOBAL_CONFIG_FILENAME);
}

/**
 * How many api and subscription jobs may run at once, and where that came
 * from: config.yml, then NOMARMY_MAX_POOL_WORKERS (older setups set it in each
 * registration), then the default. Read on every call, so a change applies to
 * the next job in every session. An unreadable file falls through rather than
 * holding jobs up; `nomarmy health` and `nomarmy army` report the file itself.
 */
export function maxJobs({ env = process.env, filePath = globalConfigPath(env) } = {}) {
  try {
    const doc = YAML.parse(fs.readFileSync(filePath, "utf8")) ?? {};
    const parsed = limitsSchema.safeParse(doc.limits ?? {});
    if (parsed.success && parsed.data.max_jobs) return { value: parsed.data.max_jobs, source: "config", path: filePath };
  } catch { /* no file, or not YAML */ }
  const declared = Number.parseInt(env.NOMARMY_MAX_POOL_WORKERS ?? "", 10);
  if (Number.isFinite(declared)) return { value: Math.min(MAX_MAX_JOBS, Math.max(1, declared)), source: "env", path: null };
  return { value: DEFAULT_MAX_JOBS, source: "default", path: null };
}

/** Write limits.max_jobs, keeping the rest of the file (comments included) as it was. */
export function setMaxJobs(n, { filePath = globalConfigPath() } = {}) {
  const parsed = limitsSchema.shape.max_jobs.safeParse(n);
  if (!parsed.success || n === undefined) throw new Error(`max-jobs must be a whole number from 1 to ${MAX_MAX_JOBS}, got "${n}"`);
  const text = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) throw new Error(`${filePath} is not valid YAML: ${doc.errors[0].message}`);
  if (doc.contents === null) doc.contents = doc.createNode({});
  doc.setIn(["limits", "max_jobs"], n);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, String(doc));
  return n;
}

// The Podman VM's own system and page cache, before any sandbox.
const VM_BASE_BYTES = 2 * 1024 ** 3;

/** How many sandboxes fit in a Podman VM of this size, by the per-job reserve admission uses. */
export function jobsThatFit(vmMemoryMb) {
  if (!Number.isFinite(vmMemoryMb)) return null;
  return Math.max(0, Math.floor((vmMemoryMb * 1024 ** 2 - VM_BASE_BYTES) / RESERVES.sandboxPerNomBytes));
}

/** The VM size (GiB, rounded up to an even number) that fits `jobs` sandboxes. */
export function vmGibFor(jobs) {
  const gib = Math.ceil((VM_BASE_BYTES + jobs * RESERVES.sandboxPerNomBytes) / 1024 ** 3);
  return gib + (gib % 2);
}
