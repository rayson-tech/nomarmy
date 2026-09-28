// Machine-wide limits, in ~/.config/nomarmy/limits.yml. One place for every
// coordinator: an environment variable lives in each Claude Code, Codex and
// Cursor registration separately, so the sessions could disagree.
//
// Its own file, not a section of config.yml: config.yml is validated strictly,
// and a session still running an older copy refused the whole file (and with
// it every role) when a new key appeared there. Older copies never read this
// file, so writing it can't break them.

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { globalConfigDir } from "./army.mjs";
import { RESERVES } from "./sizing.mjs";

export const LIMITS_FILENAME = "limits.yml";
export const DEFAULT_MAX_JOBS = 4;
export const MAX_MAX_JOBS = 32;

export const limitsSchema = z.object({
  // Api and subscription jobs at once, across every session. Local-model jobs have their own limit.
  max_jobs: z.number().int().min(1).max(MAX_MAX_JOBS).optional(),
}).passthrough();

export function limitsPath(env = process.env) {
  return path.join(globalConfigDir(env), LIMITS_FILENAME);
}

/**
 * How many api and subscription jobs may run at once, and where that came
 * from: limits.yml, then NOMARMY_MAX_POOL_WORKERS (older setups set it in each
 * registration), then the default. Read on every call, so a change applies to
 * the next job in every session. A missing or unreadable file falls through
 * rather than holding jobs up.
 */
export function maxJobs({ env = process.env, filePath = limitsPath(env) } = {}) {
  let problem = null;
  if (fs.existsSync(filePath)) {
    try {
      const parsed = limitsSchema.safeParse(YAML.parse(fs.readFileSync(filePath, "utf8")) ?? {});
      if (parsed.success && parsed.data.max_jobs) return { value: parsed.data.max_jobs, source: "file", path: filePath, problem };
      if (!parsed.success) problem = `${filePath}: max_jobs must be a whole number from 1 to ${MAX_MAX_JOBS}; ignored. Fix: nomarmy config max-jobs <n>`;
    } catch (error) { problem = `${filePath} is not valid YAML (${error.message.split("\n")[0]}); ignored.`; }
  }
  const declared = Number.parseInt(env.NOMARMY_MAX_POOL_WORKERS ?? "", 10);
  if (Number.isFinite(declared)) return { value: Math.min(MAX_MAX_JOBS, Math.max(1, declared)), source: "env", path: null, problem };
  return { value: DEFAULT_MAX_JOBS, source: "default", path: null, problem };
}

/** Write max_jobs, keeping the rest of limits.yml (comments included) as it was. */
export function setMaxJobs(n, { filePath = limitsPath() } = {}) {
  if (!Number.isInteger(n) || n < 1 || n > MAX_MAX_JOBS) throw new Error(`max-jobs must be a whole number from 1 to ${MAX_MAX_JOBS}, got "${n}"`);
  const text = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "# Machine-wide limits for nomArmy: `nomarmy config max-jobs <n>` sets max_jobs.\n";
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) throw new Error(`${filePath} is not valid YAML: ${doc.errors[0].message}`);
  if (doc.contents === null) doc.contents = doc.createNode({});
  doc.set("max_jobs", n);
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
