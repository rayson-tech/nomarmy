// Machine-wide job leases and agent slots.
//
// Every coordinator session runs its own MCP server process, and each used
// to count only its own jobs -- seen live: six server processes, so an
// agent's `max_concurrent: 1` held per session, not per machine. These live
// in files under nomArmy's shared state directory instead, so every session
// sees every job:
//
//   leases/<jobId>.json       one per running job: lane, agent, owning pid
//   slots/<agent>.<n>.lock    one per occupied max_concurrent slot, taken
//                             with exclusive create (O_EXCL), so two sessions
//                             can't both take the last one
//
// A lease or slot whose owning process is gone is stale: it doesn't count,
// and the next reader removes it, so a crashed session never wedges a slot.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** True when `pid` is a running process (EPERM: it exists, owned by someone else). */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/** A lease/slot file is stale when its owner is gone, or it's unreadable and not brand new. */
function isStale(file, { alive = pidAlive } = {}) {
  const held = readJson(file);
  if (held) return !alive(held.pid);
  try { return Date.now() - fs.statSync(file).mtimeMs > 60000; } catch { return true; }
}

const safeKey = (key) => String(key).replace(/[^A-Za-z0-9._-]/g, "_");

// --- job leases -------------------------------------------------------------

export function writeLease(leasesDir, jobId, { lane, agent = null, runId = null, role = null, model = null }) {
  fs.mkdirSync(leasesDir, { recursive: true });
  fs.writeFileSync(path.join(leasesDir, `${safeKey(jobId)}.json`), JSON.stringify({ jobId, lane, agent, runId, role, model, pid: process.pid, startedAt: new Date().toISOString() }));
}

export function removeLease(leasesDir, jobId) {
  try { fs.unlinkSync(path.join(leasesDir, `${safeKey(jobId)}.json`)); } catch { /* already gone */ }
}

/** Live leases across every session on this machine, optionally filtered. Removes stale ones. */
export function liveLeases(leasesDir, { lane = null, agent = null, runId = null, alive = pidAlive } = {}) {
  let files;
  try { files = fs.readdirSync(leasesDir).filter((f) => f.endsWith(".json")); } catch { return []; }
  const out = [];
  for (const f of files) {
    const file = path.join(leasesDir, f);
    if (isStale(file, { alive })) { try { fs.unlinkSync(file); } catch { /* raced another reader */ } continue; }
    const lease = readJson(file);
    if (!lease) continue;
    if (lane && lease.lane !== lane) continue;
    if (agent && lease.agent !== agent) continue;
    if (runId && lease.runId !== runId) continue;
    out.push(lease);
  }
  return out;
}

// --- agent slots ------------------------------------------------------------

/** How many of `key`'s slots are held right now, across the machine. */
export function liveSlots(slotsDir, key, { alive = pidAlive } = {}) {
  const prefix = `${safeKey(key)}.`;
  let files;
  try { files = fs.readdirSync(slotsDir).filter((f) => f.startsWith(prefix) && f.endsWith(".lock")); } catch { return 0; }
  return files.filter((f) => !isStale(path.join(slotsDir, f), { alive })).length;
}

/**
 * Take one of `key`'s `max` slots, atomically. Returns { release } or null
 * when all are held. With `waitMs`, polls until one frees up or time runs
 * out (for a batch, where the next job should queue, not fail).
 */
export async function acquireSlot(slotsDir, key, max, { jobId = null, waitMs = 0, pollMs = 2000, alive = pidAlive } = {}) {
  fs.mkdirSync(slotsDir, { recursive: true });
  const token = crypto.randomBytes(6).toString("hex");
  const deadline = Date.now() + waitMs;
  for (;;) {
    for (let i = 0, retried = false; i < max; i++) {
      const file = path.join(slotsDir, `${safeKey(key)}.${i}.lock`);
      try {
        const fd = fs.openSync(file, "wx");
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, token, jobId, key, takenAt: new Date().toISOString() }));
        fs.closeSync(fd);
        return {
          file,
          release() {
            const held = readJson(file);
            if (held?.token === token) { try { fs.unlinkSync(file); } catch { /* already gone */ } }
          },
        };
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        // A stale slot is cleared and retried once; never loop on it.
        if (!retried && isStale(file, { alive })) { try { fs.unlinkSync(file); } catch { /* raced */ } retried = true; i--; continue; }
        retried = false;
      }
    }
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
  }
}
