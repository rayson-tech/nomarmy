// nomArmy hardware detection (v1.3).
//
// `detectHardware()` returns normalized *facts* about the machine so that
// `lib/sizing.mjs` can turn them into a recommendation for the three coupled
// knobs `NOMARMY_LLAMA_CONTEXT`, `NOMARMY_LLAMA_PARALLEL` and
// `NOMARMY_MAX_WORKERS`.
//
// Contract:
//   * It never throws. Anything undetermined is `null`.
//   * Every probe is individually fault tolerant. A missing `nvidia-smi` is a
//     normal outcome on a Mac, not an error.
//   * Everything attempted is recorded in `probes`, so a human can see what was
//     measured versus what was left unknown. A recommendation built on nulls
//     must be presentable as a guess, and that is only possible if the caller
//     can tell the difference.
//
// External commands are deliberately limited to:
//   * nvidia-smi --query-gpu=memory.total,memory.free --format=csv,noheader,nounits
//   * sysctl -n <key>            (macOS only: physical core count, memory size)
//   * docker info --format {{.MemTotal}}
// Everything else comes from `node:os` or from reading `/proc`.

import os from "node:os";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

export const MIB = 1024 * 1024;
export const GIB = 1024 * 1024 * 1024;

/** Wall-clock budget for any external command. Detection must stay cheap. */
const COMMAND_TIMEOUT_MS = 5000;
/** `docker info` talks to the daemon and can hang while it is starting up. */
const DOCKER_TIMEOUT_MS = 6000;

/**
 * Run an external command without ever throwing.
 *
 * @param {string} file
 * @param {string[]} args
 * @param {number} [timeoutMs]
 * @returns {{ ok: boolean, stdout: string, reason: string|null }}
 */
function runCommand(file, args, timeoutMs = COMMAND_TIMEOUT_MS) {
  try {
    const result = spawnSync(file, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      shell: false,
      maxBuffer: MIB,
    });
    if (result.error) {
      return { ok: false, stdout: "", reason: result.error.message };
    }
    if (result.signal) {
      return { ok: false, stdout: "", reason: `terminated by ${result.signal}` };
    }
    if (result.status !== 0) {
      const stderr = (result.stderr || "").trim().split("\n")[0] || "";
      return {
        ok: false,
        stdout: "",
        reason: `exit ${result.status}${stderr ? `: ${stderr}` : ""}`,
      };
    }
    return { ok: true, stdout: result.stdout || "", reason: null };
  } catch (err) {
    return { ok: false, stdout: "", reason: String(err && err.message ? err.message : err) };
  }
}

/** Read a small text file, or null. Never throws. */
function readTextFile(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Record one attempted measurement. `fn` may return a value or null; any throw
 * is captured on the probe rather than propagated.
 *
 * @template T
 * @param {Array<object>} probes
 * @param {string} name
 * @param {string} description
 * @param {(entry: object) => T} fn
 * @returns {T|null}
 */
function probe(probes, name, description, fn) {
  const entry = { name, description, ok: false, source: null, detail: null, error: null };
  probes.push(entry);
  try {
    const value = fn(entry);
    entry.ok = value !== null && value !== undefined;
    return entry.ok ? value : null;
  } catch (err) {
    entry.ok = false;
    entry.error = String(err && err.message ? err.message : err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pure parsers, exported so they can be tested without the hardware present.
// ---------------------------------------------------------------------------

/**
 * Parse the CSV emitted by
 * `nvidia-smi --query-gpu=memory.total,memory.free --format=csv,noheader,nounits`.
 * Values are MiB. Returns one entry per GPU; `[]` when nothing parses.
 *
 * @param {string} stdout
 * @returns {Array<object>}
 */
export function parseNvidiaSmiMemoryCsv(stdout) {
  if (typeof stdout !== "string") return [];
  const gpus = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const fields = line.split(",").map((f) => f.trim());
    if (fields.length < 2) continue;
    const totalMiB = Number.parseInt(fields[0], 10);
    const freeMiB = Number.parseInt(fields[1], 10);
    if (!Number.isFinite(totalMiB) && !Number.isFinite(freeMiB)) continue;
    gpus.push({
      index: gpus.length,
      vendor: "nvidia",
      totalVramBytes: Number.isFinite(totalMiB) ? totalMiB * MIB : null,
      freeVramBytes: Number.isFinite(freeMiB) ? freeMiB * MIB : null,
    });
  }
  return gpus;
}

/**
 * Count physical cores from `/proc/cpuinfo` by counting distinct
 * (physical id, core id) pairs. Returns null when the file does not carry
 * those fields, which is normal on ARM SoCs and inside containers.
 *
 * @param {string} text
 * @returns {number|null}
 */
export function parseProcCpuinfoPhysicalCores(text) {
  if (typeof text !== "string" || !text) return null;
  const pairs = new Set();
  let physicalId = null;
  let coreId = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      if (physicalId !== null && coreId !== null) pairs.add(`${physicalId}/${coreId}`);
      physicalId = null;
      coreId = null;
      continue;
    }
    const sep = line.indexOf(":");
    if (sep < 0) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (key === "physical id") physicalId = value;
    else if (key === "core id") coreId = value;
  }
  if (physicalId !== null && coreId !== null) pairs.add(`${physicalId}/${coreId}`);
  return pairs.size > 0 ? pairs.size : null;
}

/**
 * Read a `/proc/meminfo` field (kB) and return bytes.
 *
 * `MemAvailable` is the kernel's own estimate of what a new allocation can get
 * without swapping, which is the number that matters here. `MemFree` is not.
 *
 * @param {string} text
 * @param {string} [field]
 * @returns {number|null}
 */
export function parseProcMeminfoBytes(text, field = "MemAvailable") {
  if (typeof text !== "string" || !text) return null;
  const match = new RegExp(`^${field}:\\s+(\\d+)\\s*kB`, "m").exec(text);
  if (!match) return null;
  const kB = Number.parseInt(match[1], 10);
  return Number.isFinite(kB) ? kB * 1024 : null;
}

/**
 * WSL2 identifies itself in the kernel release string and in `/proc/version`.
 * It matters because a WSL2 VM sees only the memory WSL was granted (often
 * about half the host), so "total RAM" there is not the machine's RAM.
 *
 * @param {string} release
 * @param {string|null} [procVersion]
 * @returns {boolean}
 */
export function looksLikeWSL(release, procVersion = null) {
  const haystack = `${release || ""}\n${procVersion || ""}`;
  return /microsoft|wsl/i.test(haystack);
}

/**
 * Parse `docker info --format {{.MemTotal}}` output (bytes).
 *
 * @param {string} stdout
 * @returns {number|null}
 */
export function parseDockerMemTotal(stdout) {
  if (typeof stdout !== "string") return null;
  const value = Number.parseInt(stdout.trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

// ---------------------------------------------------------------------------
// detectHardware
// ---------------------------------------------------------------------------

/**
 * Detect the machine's capacity-relevant facts.
 *
 * @param {{ skipDocker?: boolean, skipGpu?: boolean }} [options]
 * @returns {object} facts; never throws, `null` where undetermined
 */
export function detectHardware(options = {}) {
  const probes = [];
  const platform = process.platform;
  const arch = process.arch;

  const release = probe(probes, "os.release", "kernel/OS release string", () => os.release() || null);

  const procVersion =
    platform === "linux"
      ? probe(probes, "proc.version", "read /proc/version (WSL marker)", (entry) => {
          const text = readTextFile("/proc/version");
          if (text) entry.source = "/proc/version";
          return text;
        })
      : null;

  const isWSL = platform === "linux" ? looksLikeWSL(release || "", procVersion) : false;

  const logicalCores = probe(probes, "cpu.logical", "logical core count", (entry) => {
    entry.source = "node:os";
    if (typeof os.availableParallelism === "function") {
      const n = os.availableParallelism();
      if (Number.isFinite(n) && n > 0) return n;
    }
    const cpus = os.cpus();
    return Array.isArray(cpus) && cpus.length > 0 ? cpus.length : null;
  });

  const cpuModel = probe(probes, "cpu.model", "CPU model string", (entry) => {
    entry.source = "node:os";
    const cpus = os.cpus();
    const model = Array.isArray(cpus) && cpus[0] ? String(cpus[0].model || "").trim() : "";
    return model || null;
  });

  const physicalCores = probe(probes, "cpu.physical", "physical core count", (entry) => {
    if (platform === "linux") {
      entry.source = "/proc/cpuinfo";
      const parsed = parseProcCpuinfoPhysicalCores(readTextFile("/proc/cpuinfo") || "");
      if (parsed) return parsed;
      entry.detail = "no physical id/core id fields (normal on ARM SoCs and in containers)";
      return null;
    }
    if (platform === "darwin") {
      entry.source = "sysctl -n hw.physicalcpu";
      const res = runCommand("sysctl", ["-n", "hw.physicalcpu"]);
      if (!res.ok) {
        entry.detail = res.reason;
        return null;
      }
      const n = Number.parseInt(res.stdout.trim(), 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    }
    entry.detail = "physical core count is not obtainable on this platform without extra tooling";
    return null;
  });

  const totalMemoryBytes = probe(probes, "memory.total", "total system RAM", (entry) => {
    entry.source = "node:os totalmem";
    const total = os.totalmem();
    return Number.isFinite(total) && total > 0 ? total : null;
  });

  const availableMemoryBytes = probe(
    probes,
    "memory.available",
    "memory available without swapping",
    (entry) => {
      if (platform === "linux") {
        const parsed = parseProcMeminfoBytes(readTextFile("/proc/meminfo") || "", "MemAvailable");
        if (parsed) {
          entry.source = "/proc/meminfo MemAvailable";
          return parsed;
        }
      }
      entry.source = "node:os freemem";
      if (platform === "darwin") {
        entry.detail =
          "macOS freemem excludes reclaimable cache and compressed pages, so it understates what is really available";
      }
      const free = os.freemem();
      return Number.isFinite(free) && free > 0 ? free : null;
    },
  );

  // Apple Silicon: one physical memory pool is shared by CPU and GPU. There is
  // no separate VRAM figure to read, and the GPU cannot address all of it --
  // macOS caps the GPU wired working set below total RAM. Sizing must not treat
  // unified memory as if it were discrete VRAM *plus* system RAM.
  const appleSilicon = platform === "darwin" && arch === "arm64";
  const unifiedMemoryBytes = probe(
    probes,
    "memory.unified",
    "Apple Silicon unified memory (CPU and GPU share one pool)",
    (entry) => {
      if (!appleSilicon) {
        entry.detail = "not Apple Silicon";
        return null;
      }
      entry.source = "sysctl -n hw.memsize";
      const res = runCommand("sysctl", ["-n", "hw.memsize"]);
      if (res.ok) {
        const n = Number.parseInt(res.stdout.trim(), 10);
        if (Number.isFinite(n) && n > 0) return n;
      } else {
        entry.detail = res.reason;
      }
      entry.source = "node:os totalmem (fallback)";
      return totalMemoryBytes;
    },
  );

  const gpus = probe(probes, "gpu.nvidia", "NVIDIA VRAM via nvidia-smi", (entry) => {
    if (options.skipGpu) {
      entry.detail = "skipped by caller";
      return null;
    }
    entry.source =
      "nvidia-smi --query-gpu=memory.total,memory.free --format=csv,noheader,nounits";
    const res = runCommand("nvidia-smi", [
      "--query-gpu=memory.total,memory.free",
      "--format=csv,noheader,nounits",
    ]);
    if (!res.ok) {
      // Absence of nvidia-smi is the expected outcome on Apple Silicon and on
      // CPU-only Linux. It is information, not a failure.
      entry.detail = `nvidia-smi unavailable (${res.reason}); treating as "no NVIDIA GPU"`;
      return null;
    }
    const parsed = parseNvidiaSmiMemoryCsv(res.stdout);
    if (parsed.length === 0) {
      entry.detail = "nvidia-smi ran but returned no parseable rows";
      return null;
    }
    return parsed;
  });

  const docker = probe(probes, "docker.info", "Docker availability and reported memory", (entry) => {
    if (options.skipDocker) {
      entry.detail = "skipped by caller";
      return null;
    }
    entry.source = "docker info --format {{.MemTotal}}";
    const res = runCommand("docker", ["info", "--format", "{{.MemTotal}}"], DOCKER_TIMEOUT_MS);
    if (!res.ok) {
      entry.detail = `docker unavailable or daemon not responding (${res.reason})`;
      return { available: false, totalMemoryBytes: null };
    }
    return { available: true, totalMemoryBytes: parseDockerMemTotal(res.stdout) };
  });

  const gpuList = Array.isArray(gpus) ? gpus : [];
  const nvidiaTotal = gpuList.reduce((sum, g) => sum + (g.totalVramBytes || 0), 0);
  const nvidiaFree = gpuList.reduce(
    (sum, g) => sum + (g.freeVramBytes != null ? g.freeVramBytes : g.totalVramBytes || 0),
    0,
  );

  return {
    detectedAt: new Date().toISOString(),
    platform,
    arch,
    release: release || null,
    isWSL,
    appleSilicon,
    cpu: {
      model: cpuModel || null,
      physicalCores: physicalCores || null,
      logicalCores: logicalCores || null,
    },
    memory: {
      totalBytes: totalMemoryBytes || null,
      availableBytes: availableMemoryBytes || null,
      // True when the GPU has no private memory of its own. On such machines
      // model weights, KV cache, the OS, the coordinator and every Docker
      // sandbox all come out of the same pool.
      unified: appleSilicon,
      unifiedBytes: appleSilicon ? unifiedMemoryBytes || totalMemoryBytes || null : null,
    },
    gpu: {
      vendor: gpuList.length > 0 ? "nvidia" : appleSilicon ? "apple" : null,
      count: gpuList.length,
      devices: gpuList,
      totalVramBytes: gpuList.length > 0 ? nvidiaTotal : null,
      freeVramBytes: gpuList.length > 0 ? nvidiaFree : null,
    },
    docker: docker || { available: null, totalMemoryBytes: null },
    probes,
  };
}

export default { detectHardware };
