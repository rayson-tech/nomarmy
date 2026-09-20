// nomArmy capacity sizing (v1.3).
//
// Turns hardware facts (`lib/hardware.mjs`) and model facts (`lib/gguf.mjs`)
// into a *recommendation* for the three coupled knobs. It never writes config:
// a human reads the recommendation and applies it.
//
// THE THING EVERYBODY GETS WRONG
// ------------------------------
// In llama.cpp's server, `-c` is the TOTAL context, shared out across the `-np`
// inference slots. Each slot gets `ctx_total / n_parallel`. So:
//
//     -c 65536 -np 2   ->   32K per nom, not 64K per nom
//
// The v1.3 target is 64K *per nom*, so two noms need `-c 131072`. Every input
// and output here is therefore named `contextPerNom` or `contextTotal`. There
// is no bare "context" in this module, on purpose.
//
// THE SECOND THING
// ----------------
// `NOMARMY_MAX_WORKERS` above `NOMARMY_LLAMA_PARALLEL` does not buy throughput:
// the extra jobs queue on inference slots. That concurrency is fictional and
// only adds latency, so it is flagged as oversubscription and the default
// recommendation keeps the two equal for local execution.
//
// Both `recommend()` and `evaluateConfig()` are pure: facts in, structure out,
// no I/O at all.

import { deriveHeadDim } from "./gguf.mjs";

export const MIB = 1024 * 1024;
export const GIB = 1024 * 1024 * 1024;

/** v1.3 target: the autonomous explore/implement/test/repair loop needs room. */
export const DEFAULT_TARGET_CONTEXT_PER_NOM = 65536;
/** Architectural ceiling on bounded workers (see CLAUDE.md). */
export const MAX_NOMS = 8;
/** Never recommend a slot context below this; the loop cannot work in less. */
export const MIN_CONTEXT_PER_NOM = 8192;
/** Cloud execution is bounded by quota and budget, not by this machine. */
export const CLOUD_DEFAULT_MAX_WORKERS = 4;

/** Execution values that mean "inference does not happen on this machine". */
export const CLOUD_EXECUTIONS = Object.freeze(["bedrock", "bedrock-cheap", "cloud", "hosted"]);

/**
 * Explicit, generous headroom. Everything here is memory that is NOT available
 * for weights or KV cache. Swapping mid-inference is far worse than running one
 * fewer nom, so these are deliberately not tight.
 */
export const RESERVES = Object.freeze({
  /** OS, page cache, desktop, editor. */
  osBytes: 3 * GIB,
  /** The frontier coordinator process, its MCP server and Git work. */
  coordinatorBytes: 2 * GIB,
  /** The Podman sandbox container nomArmy starts for every job. */
  sandboxPerNomBytes: Math.round(1.5 * GIB),
  /** llama-server runtime: CUDA/Metal context, graph and scratch allocations. */
  runtimeOverheadBytes: 1 * GIB,
  /** Per-slot activation/compute buffers, which are not KV cache. */
  computeBufferPerSlotBytes: Math.round(0.5 * GIB),
  /** Never plan to fill more than this fraction of the pool. */
  safetyFraction: 0.9,
  /**
   * Share of Apple unified memory the GPU may hold wired. 0.75 was an
   * unverified rule of thumb carried since the initial commit. Measured
   * directly on an M3 Max 64 GiB running Qwen3-Coder-Next Q4_K_M (45.1 GiB
   * weights): 3 noms at 64K each (~52.1 GiB estimated GPU-resident, ~81% of
   * the pool) completed a real job correctly; 4 noms at 64K each (~54.1 GiB,
   * ~85%) failed to load with a genuine Metal allocation error
   * (ggml_metal_synchronize: command buffer failed, kIOGPUCommandBufferCallbackErrorOutOfMemory)
   * that /health did not catch (see the completion-based health check in
   * lib/doctor.mjs / scripts/start-inference.sh). 0.80 sits with real margin
   * below the observed 81% success point and well below the 85% failure
   * point -- still a deliberate margin, now one anchored to a measurement
   * instead of a guess. This is one machine and one (hybrid-architecture,
   * small-KV-footprint) model; revisit if a dense model or different
   * hardware class shows a different real ceiling.
   */
  unifiedGpuFraction: 0.80,
  /**
   * Coherent-memory detection. On a GB10 / DGX Spark class machine the
   * "VRAM" nvidia-smi reports and the system RAM are the same silicon, so they
   * must not be budgeted twice. The signal is that the two figures are nearly
   * equal -- a band, not a floor: a large discrete card in a RAM-poor box has
   * VRAM well *above* system RAM and is not coherent.
   */
  coherentMemoryRatioMin: 0.85,
  /** Grace/Jetson class hosts are ARM64, where the same closeness is stronger evidence. */
  coherentMemoryRatioMinArm: 0.6,
  coherentMemoryRatioMax: 1.2,
});

/**
 * fp16 KV cache. llama.cpp defaults to f16 for both K and V unless started with
 * `--cache-type-k` / `--cache-type-v`. Override via `bytesPerKvElement` when you
 * quantize the cache; the assumption is always stated in the result.
 */
export const DEFAULT_BYTES_PER_KV_ELEMENT = 2;

/**
 * Bytes per element for llama-server's `--cache-type-k` / `--cache-type-v`
 * values, so `NOMARMY_LLAMA_CACHE_TYPE_K/V` (see scripts/start-inference.sh)
 * can be reflected in the sizing math instead of silently assuming fp16 once
 * someone quantizes the KV cache to fit more context. K and V are modeled as
 * one shared element size (see bytesPerKvElementForCacheTypes below); llama.cpp
 * allows setting them independently, but mixed-precision KV is not separately
 * modeled here.
 */
export const KV_CACHE_TYPE_BYTES = Object.freeze({
  f32: 4,
  f16: 2,
  bf16: 2,
  q8_0: 1,
  q5_1: 0.6875,
  q5_0: 0.625,
  q4_1: 0.5625,
  q4_0: 0.5,
  iq4_nl: 0.5,
});

/**
 * Resolve the KV element size to use for sizing math from the K/V cache-type
 * strings a caller may have set (matching llama-server's own flag values,
 * case-insensitively). Unset or unrecognized values fall back to the fp16
 * default. When K and V differ, the smaller (cheaper) of the two is used --
 * an optimistic estimate is flagged in the assumptions text by the caller,
 * rather than silently averaging two different real allocations.
 */
export function bytesPerKvElementForCacheTypes(cacheTypeK, cacheTypeV) {
  const resolve = (t) => (t ? KV_CACHE_TYPE_BYTES[String(t).toLowerCase()] : undefined);
  const kExplicit = resolve(cacheTypeK);
  const vExplicit = resolve(cacheTypeV);
  if (kExplicit === undefined && vExplicit === undefined) return DEFAULT_BYTES_PER_KV_ELEMENT;
  // An unset side is not "ignore it" -- llama.cpp still allocates it at the
  // real fp16 default. Setting only one of K/V (e.g. quantizing V while
  // leaving K untouched) must compare against that real default, not vanish
  // from the comparison entirely, or the still-fp16 side is silently dropped
  // from consideration. This still returns ONE scalar applied to both K and V
  // in kvBytesPerSlot's formula, so a genuinely asymmetric K/V is approximated
  // by its smaller side either way -- that approximation is unchanged and
  // intentional (see doc comment above); this only makes the unset-side
  // comparison honest instead of skipping it.
  return Math.min(kExplicit ?? DEFAULT_BYTES_PER_KV_ELEMENT, vExplicit ?? DEFAULT_BYTES_PER_KV_ELEMENT);
}

/**
 * Used only when the GGUF is absent or unreadable, which is the normal state of
 * a fresh install. These are deliberately pessimistic stand-ins for a ~30B-class
 * GQA coder model at Q4_K_M. They are ASSUMPTIONS, not measurements, and any
 * result built on them is marked `confidence: "low"`.
 */
export const FALLBACK_MODEL = Object.freeze({
  weightsBytes: 18 * GIB,
  blockCount: 48,
  headCountKv: 8,
  headDim: 128,
  contextLength: 262144,
  label: "~30B-class GQA coder model at Q4_K_M",
});

/**
 * KV cache only grows with context on layers that do full (softmax)
 * attention. A hybrid architecture mixes those with recurrent/state-space
 * layers (Mamba-style; GGUF exposes this as `.ssm.*` header keys) whose state
 * is a small, roughly context-INDEPENDENT size -- `block_count` alone cannot
 * tell full attention layers from recurrent ones apart, and there is no
 * per-layer array in the GGUF header either (checked directly against a real
 * Qwen3-Coder-Next-GGUF file: `attention.head_count_kv` and `block_count` are
 * both plain scalars, not arrays). The ratio is a fixed fact of each specific
 * hybrid architecture's design, not something derivable from the file, so
 * this is a small, explicit, named table rather than a formula -- add an
 * entry only once the ratio is verified against that architecture's own
 * documentation, the way qwen3next's was.
 *
 * qwen3next (Qwen3-Next, including Qwen3-Coder-Next): a fixed 3:1 layout of
 * three Gated DeltaNet (linear-attention) blocks then one full-attention
 * block, repeating -- 1 in 4 layers is full attention. Sources: Qwen's own
 * announcement (https://qwen.ai/blog?id=4074cca80393150c248e508aa62983f9cb7d27cd)
 * and NVIDIA's technical writeup of the architecture.
 */
export const HYBRID_ATTENTION_LAYER_FRACTION = Object.freeze({
  qwen3next: 1 / 4,
});

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function num(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** Human-readable byte size, for warning text and for display. */
export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "unknown";
  const sign = bytes < 0 ? "-" : "";
  const abs = Math.abs(bytes);
  if (abs >= GIB) return `${sign}${(abs / GIB).toFixed(1)} GiB`;
  if (abs >= MIB) return `${sign}${Math.round(abs / MIB)} MiB`;
  return `${sign}${abs} B`;
}

/** Human-readable context size, e.g. 65536 -> "64K". */
export function formatContext(tokens) {
  if (!Number.isFinite(tokens)) return "unknown";
  return tokens % 1024 === 0 ? `${tokens / 1024}K` : `${tokens}`;
}

function warning(code, severity, message) {
  return { code, severity, message };
}

export function isCloudExecution(execution) {
  return CLOUD_EXECUTIONS.includes(String(execution || "").toLowerCase());
}

// ---------------------------------------------------------------------------
// Model facts
// ---------------------------------------------------------------------------

/**
 * Resolve the architecture numbers needed for the KV formula, recording which
 * of them came from the file and which were assumed.
 *
 * @param {object|null} gguf result of `readGGUFMetadata`
 * @returns {object}
 */
export function resolveModel(gguf) {
  const found = Boolean(gguf && gguf.found);
  const params = (gguf && gguf.params) || {};
  const assumed = [];

  let layers = found ? num(params.blockCount) : null;
  if (!layers) {
    layers = FALLBACK_MODEL.blockCount;
    assumed.push(`block_count assumed to be ${FALLBACK_MODEL.blockCount}`);
  }

  let kvHeads = found ? num(params.headCountKv) || num(params.headCount) : null;
  if (!kvHeads) {
    kvHeads = FALLBACK_MODEL.headCountKv;
    assumed.push(`attention.head_count_kv assumed to be ${FALLBACK_MODEL.headCountKv} (GQA)`);
  }

  const derived = found ? deriveHeadDim(params) : { headDim: null, source: null };
  let keyLength = found ? num(params.keyLength) || derived.headDim : null;
  if (!keyLength) {
    keyLength = FALLBACK_MODEL.headDim;
    assumed.push(`attention.key_length assumed to be ${FALLBACK_MODEL.headDim}`);
  }

  let valueLength = found ? num(params.valueLength) || (num(params.keyLength) ? params.keyLength : derived.headDim) : null;
  if (!valueLength) {
    valueLength = keyLength;
    if (!found) assumed.push(`attention.value_length assumed equal to key_length (${keyLength})`);
  }

  let weightsBytes = found ? num(gguf && gguf.fileSizeBytes) : null;
  if (!weightsBytes) {
    weightsBytes = FALLBACK_MODEL.weightsBytes;
    assumed.push(
      `model weights assumed to be ${formatBytes(FALLBACK_MODEL.weightsBytes)} (${FALLBACK_MODEL.label})`,
    );
  }

  const modelContextLength = found ? num(params.contextLength) : null;

  // `layers` above is the TOTAL block count, used for weights and display.
  // `kvLayers` is the count that actually belongs in the KV-cache-per-context
  // formula: on a hybrid architecture only a fraction of layers do full
  // attention (see HYBRID_ATTENTION_LAYER_FRACTION), the rest carry a
  // recurrent state whose size does not scale with context. This is a known,
  // cited correction, not a guess filling in missing data -- it is kept out
  // of `assumed`/`complete`/confidence, which mean "the file didn't say and
  // we substituted something"; applying it makes the estimate MORE accurate,
  // not less certain.
  const arch = (gguf && gguf.arch) || null;
  const hasSsmLayers = found && [params.ssmStateSize, params.ssmInnerSize, params.ssmConvKernel, params.ssmGroupCount]
    .some((v) => num(v));
  const hybridFraction = arch && Object.prototype.hasOwnProperty.call(HYBRID_ATTENTION_LAYER_FRACTION, arch)
    ? HYBRID_ATTENTION_LAYER_FRACTION[arch]
    : null;
  let kvLayers = layers;
  let hybridNote = null;
  if (hasSsmLayers && hybridFraction !== null) {
    kvLayers = Math.max(1, Math.round(layers * hybridFraction));
    hybridNote = `${arch} is a known hybrid architecture (${Math.round(hybridFraction * 100)}% full attention); ` +
      `KV cache is sized for ${kvLayers} of ${layers} layers, not all of them, since the rest carry a ` +
      "recurrent state that does not grow with context.";
  }

  return {
    source: found ? "gguf" : "fallback",
    found,
    truncated: Boolean(gguf && gguf.truncated),
    arch,
    layers,
    kvLayers,
    isHybrid: hasSsmLayers,
    hybridRecognized: hybridNote !== null,
    hybridNote,
    kvHeads,
    keyLength,
    valueLength,
    weightsBytes,
    modelContextLength,
    assumed,
    complete: found && assumed.length === 0 && !(gguf && gguf.truncated),
  };
}

/**
 * KV cache bytes for ONE slot at `contextPerNom` tokens.
 *
 *   kv_per_slot = n_layers * n_kv_heads * (key_length + value_length)
 *                 * context_per_nom * bytes_per_element
 *
 * which is the familiar `2 * layers * kv_heads * head_dim * ctx * bytes` when
 * key and value dimensions are equal, and stays correct when they are not.
 *
 * Uses `model.kvLayers` when present -- the count of layers that actually do
 * full attention, which is `layers` itself except on a recognized hybrid
 * architecture (see resolveModel) -- falling back to `model.layers` for a
 * hand-built model object that predates this field.
 *
 * @param {object} model result of `resolveModel`
 * @param {number} contextPerNom
 * @param {number} bytesPerElement
 * @returns {number}
 */
export function kvBytesPerSlot(model, contextPerNom, bytesPerElement = DEFAULT_BYTES_PER_KV_ELEMENT) {
  const layers = model.kvLayers ?? model.layers;
  return (
    layers * model.kvHeads * (model.keyLength + model.valueLength) * contextPerNom * bytesPerElement
  );
}

// ---------------------------------------------------------------------------
// Memory pool
// ---------------------------------------------------------------------------

/**
 * Work out which pool the weights and KV cache actually land in.
 *
 * kinds:
 *   "vram"    discrete NVIDIA VRAM; Podman/OS/coordinator live in system RAM
 *   "unified" one pool shared by CPU and GPU (Apple Silicon, GB10 coherent)
 *   "system"  no GPU at all; everything is system RAM
 *   "unknown" nothing could be measured
 *
 * @param {object|null} hardware
 * @returns {object}
 */
/**
 * Memory Podman has carved out of host RAM and that a local model can never use.
 *
 * On a macOS/Windows Podman machine, containers run inside a VM with a fixed
 * memory allocation, reserved whether or not anything is running. That
 * allocation is unavailable to llama-server, so it must come off the pool.
 * On native Linux, containers share the host kernel and draw from the same
 * pool as everything else, so only the per-nom sandbox charge applies.
 *
 * The absolute numbers here can be dramatic: on one real machine, switching
 * this sandbox from Docker Desktop to Podman took the configured VM ceiling
 * from ~31.2 GiB down to Podman machine's 2 GiB default, over 15x less
 * memory permanently carved out of the pool a local model can use.
 */
export function podmanVmReservation(hardware) {
  const hw = hardware || {};
  const total = Number(hw.podman && hw.podman.totalMemoryBytes) || 0;
  if (!total) return 0;
  const desktopHost = hw.platform === "win32" || hw.platform === "darwin";
  if (!desktopHost) return 0;
  // MemTotal is the VM CEILING, not a standing reservation: the WSL2 and
  // virtiofs backends grow and release within it. Charging all of it made an
  // 11.3 GiB model that demonstrably runs here report "does not fit", so half
  // the ceiling is used as a working estimate of steady-state pressure. This
  // is a heuristic, not a measurement, and it is stated as one in the output.
  return Math.floor(total / 2);
}

export function resolveMemoryPool(hardware, options = {}) {
  // A Podman machine holds its VM allocation out of host RAM permanently, so
  // the pool a local model can actually use is smaller than total RAM suggests.
  const vmReservationBytes = podmanVmReservation(hardware);
  const hw = hardware || {};
  const mem = hw.memory || {};
  const gpu = hw.gpu || {};
  const systemTotal = num(mem.totalBytes);
  const systemAvailable = num(mem.availableBytes);
  const gpuCount = Number.isFinite(gpu.count) ? gpu.count : 0;
  const vramTotal = num(gpu.totalVramBytes);
  const vramFree = num(gpu.freeVramBytes) || vramTotal;

  if (gpuCount > 0 && vramTotal) {
    const ratio = systemTotal ? vramTotal / systemTotal : null;
    const minRatio =
      hw.arch === "arm64" ? RESERVES.coherentMemoryRatioMinArm : RESERVES.coherentMemoryRatioMin;
    const coherent = Boolean(
      ratio !== null && ratio >= minRatio && ratio <= RESERVES.coherentMemoryRatioMax,
    );
    if (coherent) {
      // Grace Blackwell / DGX Spark class: the reported "VRAM" is the same
      // silicon as system RAM. Budget it once.
      return {
        kind: "unified", vmReservationBytes,
        coherent: true,
        poolBytes: Math.min(systemTotal, vramTotal),
        gpuResidentCapBytes: vramFree,
        systemTotalBytes: systemTotal,
        systemAvailableBytes: systemAvailable,
        gpuCount,
        source: "nvidia-smi on a coherent-memory system",
      };
    }
    return {
      kind: "vram", vmReservationBytes,
      coherent: false,
      poolBytes: vramFree,
      gpuResidentCapBytes: vramFree,
      systemTotalBytes: systemTotal,
      systemAvailableBytes: systemAvailable,
      gpuCount,
      source: "nvidia-smi free VRAM",
    };
  }

  if (mem.unified) {
    const unified = num(mem.unifiedBytes) || systemTotal;
    if (unified) {
      return {
        kind: "unified", vmReservationBytes,
        coherent: true,
        poolBytes: unified,
        gpuResidentCapBytes: Math.floor(unified * RESERVES.unifiedGpuFraction),
        systemTotalBytes: systemTotal || unified,
        systemAvailableBytes: systemAvailable,
        gpuCount: 0,
        // Apple Silicon is not the only coherent-memory platform nomArmy targets:
        // DGX Spark (Grace Blackwell, Linux arm64) shares one pool too. Naming the
        // wrong platform in a sizing warning misleads exactly the users who most
        // need it, so the label follows the detected platform.
        appleUnified: hardware?.platform === "darwin" || hardware?.appleSilicon === true,
        source: hardware?.platform === "darwin" || hardware?.appleSilicon === true
          ? "Apple Silicon unified memory"
          : "coherent unified memory",
      };
    }
  }

  if (systemAvailable || systemTotal) {
    return {
      kind: "system",
      coherent: false,
      // Capacity planning sizes against what the machine HAS, not what happens to
      // be free while a browser is open -- otherwise the same machine yields a
      // different recommendation hour to hour. useAvailable opts into the
      // right-now view; a large gap between the two is reported as a warning.
      poolBytes: (options.useAvailable ? systemAvailable : systemTotal) || systemAvailable || systemTotal,
      gpuResidentCapBytes: null,
      systemTotalBytes: systemTotal,
      systemAvailableBytes: systemAvailable,
      vmReservationBytes,

      gpuCount: 0,
      source: "system RAM (no GPU detected)",
    };
  }

  return {
    kind: "unknown",
    coherent: false,
    poolBytes: null,
    gpuResidentCapBytes: null,
    systemTotalBytes: null,
    systemAvailableBytes: null,
    gpuCount: 0,
    source: "nothing measurable",
  };
}

/**
 * How many noms fit at a given per-nom context, and the breakdown that produced
 * the answer. `rawCapacity` may be 0 or negative: that is the signal that not
 * even one nom fits inside the reserved headroom.
 */
function capacityFor(pool, model, contextPerNom, bytesPerElement) {
  const kvPerSlot = kvBytesPerSlot(model, contextPerNom, bytesPerElement);
  const R = RESERVES;

  if (pool.kind === "unknown") {
    return { rawCapacity: 1, kvPerSlot, budgetBytes: null, perSlotBytes: null, limitedBy: "unknown-hardware" };
  }

  if (pool.kind === "vram") {
    // Weights and KV live in VRAM; sandboxes and the coordinator do not.
    const gpuBudget = pool.poolBytes * R.safetyFraction - R.runtimeOverheadBytes - model.weightsBytes;
    const perSlotGpu = kvPerSlot + R.computeBufferPerSlotBytes;
    const byGpu = Math.floor(gpuBudget / perSlotGpu);

    const sysPool = pool.systemAvailableBytes || pool.systemTotalBytes;
    let bySystem = Number.POSITIVE_INFINITY;
    let systemBudget = null;
    if (sysPool) {
      // Must mirror the unified/system branch below: a Podman machine VM
      // allocation comes off system RAM here too, not just out of the GPU pool.
      systemBudget = sysPool * R.safetyFraction - R.osBytes - R.coordinatorBytes - (pool.vmReservationBytes ?? 0);
      bySystem = Math.floor(systemBudget / R.sandboxPerNomBytes);
    }
    return {
      rawCapacity: Math.min(byGpu, bySystem),
      kvPerSlot,
      budgetBytes: gpuBudget,
      systemBudgetBytes: systemBudget,
      perSlotBytes: perSlotGpu,
      limitedBy: byGpu <= bySystem ? "vram" : "system-ram",
    };
  }

  // One pool: everything comes out of the same bytes.
  // Must mirror memoryBreakdown exactly: a Podman machine VM allocation comes
  // off the pool, and its sandboxes are then inside the VM rather than extra.
  const vmReservation = pool.vmReservationBytes ?? 0;
  const budget =
    pool.poolBytes * R.safetyFraction -
    R.osBytes -
    R.coordinatorBytes -
    R.runtimeOverheadBytes -
    vmReservation -
    model.weightsBytes;
  const perSlot =
    kvPerSlot + R.computeBufferPerSlotBytes + (vmReservation > 0 ? 0 : R.sandboxPerNomBytes);
  let raw = Math.floor(budget / perSlot);
  let limitedBy = pool.kind === "system" ? "system-ram" : "unified-memory";

  if (pool.gpuResidentCapBytes) {
    // The GPU may not be allowed to hold the whole pool wired.
    const gpuBudget = pool.gpuResidentCapBytes - R.runtimeOverheadBytes - model.weightsBytes;
    const byGpu = Math.floor(gpuBudget / (kvPerSlot + R.computeBufferPerSlotBytes));
    if (byGpu < raw) {
      raw = byGpu;
      limitedBy = "gpu-resident-cap";
    }
  }

  return { rawCapacity: raw, kvPerSlot, budgetBytes: budget, perSlotBytes: perSlot, limitedBy };
}

/** Full memory breakdown for a concrete (noms, contextPerNom) choice. */
function memoryBreakdown(pool, model, noms, contextPerNom, bytesPerElement) {
  const R = RESERVES;
  const kvPerSlot = kvBytesPerSlot(model, contextPerNom, bytesPerElement);
  const kvTotal = kvPerSlot * noms;
  const computeBuffers = R.computeBufferPerSlotBytes * noms;
  // On a Podman machine host the sandboxes live inside the VM, so charging them
  // per nom on top of the whole VM allocation would double-count.
  const vmReservationBytes = pool.vmReservationBytes ?? 0;
  const sandboxes = vmReservationBytes > 0 ? 0 : R.sandboxPerNomBytes * noms;

  const gpuResidentBytes = model.weightsBytes + kvTotal + computeBuffers + R.runtimeOverheadBytes;
  const systemResidentBytes = sandboxes + vmReservationBytes + R.osBytes + R.coordinatorBytes;
  const estimatedTotalBytes =
    pool.kind === "vram" ? gpuResidentBytes : gpuResidentBytes + systemResidentBytes;

  const budgetBytes = pool.poolBytes === null ? null : pool.poolBytes * R.safetyFraction;
  const headroomBytes = budgetBytes === null ? null : budgetBytes - estimatedTotalBytes;

  return {
    pool: {
      kind: pool.kind,
      coherent: pool.coherent,
      bytes: pool.poolBytes,
      source: pool.source,
      gpuResidentCapBytes: pool.gpuResidentCapBytes,
      systemTotalBytes: pool.systemTotalBytes,
      systemAvailableBytes: pool.systemAvailableBytes,
    },
    bytesPerKvElement: bytesPerElement,
    modelWeightsBytes: model.weightsBytes,
    kvBytesPerSlot: kvPerSlot,
    kvBytesTotal: kvTotal,
    reserved: {
      osBytes: R.osBytes,
      coordinatorBytes: R.coordinatorBytes,
      vmReservationBytes,
      sandboxBytes: sandboxes,
      sandboxPerNomBytes: R.sandboxPerNomBytes,
      runtimeOverheadBytes: R.runtimeOverheadBytes,
      computeBufferBytes: computeBuffers,
      safetyFraction: R.safetyFraction,
      safetyMarginBytes: pool.poolBytes === null ? null : pool.poolBytes * (1 - R.safetyFraction),
      totalBytes:
        (pool.kind === "vram" ? 0 : R.osBytes + R.coordinatorBytes + sandboxes) +
        R.runtimeOverheadBytes +
        computeBuffers +
        (pool.poolBytes === null ? 0 : pool.poolBytes * (1 - R.safetyFraction)),
    },
    gpuResidentBytes,
    systemResidentBytes,
    estimatedTotalBytes,
    budgetBytes,
    headroomBytes,
    fits: headroomBytes === null ? null : headroomBytes >= 0,
  };
}

// ---------------------------------------------------------------------------
// Shared warning builders, so recommend() and evaluateConfig() agree on shape
// ---------------------------------------------------------------------------

function oversubscriptionWarning(maxWorkers, llamaParallel) {
  return warning(
    "oversubscription",
    "warning",
    `NOMARMY_MAX_WORKERS=${maxWorkers} exceeds NOMARMY_LLAMA_PARALLEL=${llamaParallel}: ` +
      `${maxWorkers - llamaParallel} nom(s) will queue waiting for an inference slot. ` +
      "That concurrency is fictional; it adds latency without adding throughput. " +
      `Set max workers to ${llamaParallel}, or raise parallel slots (and the total context with it).`,
  );
}

function contextBelowTargetWarning(contextPerNom, target, contextTotal, llamaParallel) {
  return warning(
    "context_below_target",
    "warning",
    `-c ${contextTotal} shared across -np ${llamaParallel} gives each nom ` +
      `${formatContext(contextPerNom)} (${contextPerNom} tokens), below the ` +
      `${formatContext(target)} v1.3 target. llama.cpp divides total context by slots: ` +
      `for ${llamaParallel} nom(s) at ${formatContext(target)} each, set ` +
      `NOMARMY_LLAMA_CONTEXT=${target * llamaParallel}.`,
  );
}

function environmentWarnings(hardware, pool, model) {
  const out = [];
  const hw = hardware || {};

  if (pool.kind === "unknown") {
    out.push(
      warning(
        "hardware_unknown",
        "error",
        "No memory or GPU facts could be measured on this machine, so this is a default, not a measurement.",
      ),
    );
  }

  if (pool.kind === "system") {
    out.push(
      warning(
        "no_gpu",
        "warning",
        "No NVIDIA GPU and no unified-memory GPU detected: inference will run on CPU. " +
          "Expect a large latency penalty; consider the cpu-linux profile's smaller context, or a cloud profile.",
      ),
    );
  }

  if (pool.kind === "unified") {
    out.push(
      warning(
        "unified_memory",
        "info",
        pool.coherent && pool.gpuCount > 0
          ? "GPU memory and system RAM are the same physical pool on this machine (coherent memory), " +
              "so VRAM and RAM must not be added together. Weights, KV cache, the OS, the coordinator and " +
              "every Podman sandbox all draw on the one pool."
          : pool.appleUnified
            ? "Apple Silicon unified memory: CPU and GPU share one pool, and macOS caps how much of it the GPU " +
                `may hold wired (budgeted here at ${Math.round(RESERVES.unifiedGpuFraction * 100)}%). ` +
                "There is no separate VRAM to spend."
            : "This machine has coherent unified memory: CPU and GPU share one physical pool, so there is no " +
                `separate VRAM to spend and only about ${Math.round(RESERVES.unifiedGpuFraction * 100)}% of the ` +
                "pool is budgeted for model residency. Weights, KV cache, the OS, the coordinator and every " +
                "Podman sandbox all draw on the one pool.",
      ),
    );
  }

  if (hw.isWSL) {
    out.push(
      warning(
        "wsl_memory",
        "info",
        "Running under WSL2: the memory seen here is what WSL was granted, not the host's RAM. " +
          "Raise it in .wslconfig before treating this as the machine's capacity.",
      ),
    );
  }

  if (pool.gpuCount > 1) {
    out.push(
      warning(
        "multi_gpu",
        "info",
        `${pool.gpuCount} GPUs detected. VRAM is summed here, which assumes llama.cpp splits the model across ` +
          "them; a single-GPU run is bounded by the smallest card instead.",
      ),
    );
  }

  if (!model.found) {
    out.push(
      warning(
        "unknown_model",
        "warning",
        "No readable GGUF was found, so the KV-cache maths uses assumed architecture numbers " +
          `(${FALLBACK_MODEL.label}): ${model.assumed.join("; ")}. This is a guess, not a measurement. ` +
          "Re-run after the model has been downloaded for a real number.",
      ),
    );
  } else if (model.assumed.length > 0 || model.truncated) {
    out.push(
      warning(
        "partial_model_metadata",
        "warning",
        `The GGUF header was read but incomplete${model.truncated ? " (truncated)" : ""}; ` +
          `substituted: ${model.assumed.join("; ") || "none"}.`,
      ),
    );
  }

  if (model.found && model.hybridRecognized) {
    out.push(warning("hybrid_architecture_corrected", "info", model.hybridNote));
  } else if (model.found && model.isHybrid) {
    out.push(
      warning(
        "unrecognized_hybrid_architecture",
        "warning",
        `${model.arch ?? "this architecture"} has recurrent/state-space layers (per its GGUF .ssm.* header ` +
          "keys), but nomArmy has no verified full-attention ratio for it, so the KV-cache estimate below " +
          "assumes every layer is full attention. That almost certainly OVERSTATES real memory need -- treat " +
          "the recommendation as conservative, not tight.",
      ),
    );
  }

  if (hw.podman && hw.podman.available === false) {
    out.push(
      warning(
        "podman_unavailable",
        "warning",
        "Podman did not respond. nomArmy starts a sandbox container per job, so worker jobs will not run " +
          "until Podman is available (on macOS, 'podman machine start'). Its memory ceiling could not be " +
          "measured either way, so this plan assumes ZERO reservation for it -- if Podman is actually running " +
          "and just slow to answer (e.g. a machine still starting up), the real number is available and this " +
          "plan is optimistic until you re-run sizing once Podman responds.",
      ),
    );
  }


  // The pool is sized against total RAM so the answer does not change hour to
  // hour. That is only honest if we say when the machine cannot deliver it now.
  const totalRam = pool?.systemTotalBytes ?? null;
  const freeRam = pool?.systemAvailableBytes ?? null;
  if (totalRam && freeRam && freeRam < totalRam * 0.6) {
    out.push(
      warning(
        "memory_pressure",
        "info",
        `Sized against this machine's full ${formatBytes(totalRam)}, but only ` +
          `${formatBytes(freeRam)} is free right now. Free memory before starting noms, ` +
          `or size against current load instead if you need a right-now answer.`,
      ),
    );
  }
  return out;
}

function confidenceFor(model, pool) {
  if (!model.found || pool.kind === "unknown") return "low";
  if (model.assumed.length > 0 || model.truncated) return "medium";
  if (!pool.poolBytes) return "low";
  return "high";
}

function assumptionsFor(model, pool, bytesPerElement) {
  const list = [
    `KV cache is ${bytesPerElement} bytes per element (${bytesPerElement === 2 ? "fp16, llama.cpp's default for both K and V" : "caller-supplied"}).`,
    model.isHybrid
      ? `kv_per_slot = kv_layers * kv_heads * (key_length + value_length) * context_per_nom * bytes_per_element, ` +
        `where kv_layers (${model.kvLayers} of ${model.layers}) is the layer count that actually does full ` +
        "attention -- see the hybrid-architecture note above for how that count was determined."
      : "kv_per_slot = layers * kv_heads * (key_length + value_length) * context_per_nom * bytes_per_element.",
    `Headroom reserved: ${formatBytes(RESERVES.osBytes)} OS, ${formatBytes(RESERVES.coordinatorBytes)} coordinator, ` +
      (pool.vmReservationBytes ? `${formatBytes(pool.vmReservationBytes)} for the Podman machine VM (half its reported ceiling, a heuristic ` +
        `for steady-state pressure -- sandboxes run inside it and are not charged again), ` : `${formatBytes(RESERVES.sandboxPerNomBytes)} Podman sandbox per nom, `) +
      `${formatBytes(RESERVES.runtimeOverheadBytes)} llama-server runtime, ` +
      `${formatBytes(RESERVES.computeBufferPerSlotBytes)} compute buffers per slot, ` +
      `and ${Math.round((1 - RESERVES.safetyFraction) * 100)}% of the pool left unallocated.`,
    `Model weights taken as ${model.source === "gguf" ? "the GGUF file size on disk" : "an assumed figure"} ` +
      `(${formatBytes(model.weightsBytes)}).`,
    `Memory pool: ${pool.source}${pool.poolBytes ? ` (${formatBytes(pool.poolBytes)})` : ""}.`,
  ];
  for (const item of model.assumed) list.push(`ASSUMED: ${item}`);
  return list;
}

// ---------------------------------------------------------------------------
// recommend
// ---------------------------------------------------------------------------

/**
 * Recommend context/parallel/worker settings.
 *
 * @param {{
 *   hardware?: object|null,
 *   gguf?: object|null,
 *   execution?: string,
 *   targetContextPerNom?: number,
 *   maxNoms?: number,
 *   bytesPerKvElement?: number
 * }} input
 * @returns {object}
 */
export function recommend(input = {}) {
  const {
    hardware = null,
    gguf = null,
    execution = "local",
    targetContextPerNom = DEFAULT_TARGET_CONTEXT_PER_NOM,
    maxNoms = MAX_NOMS,
    bytesPerKvElement = DEFAULT_BYTES_PER_KV_ELEMENT,
    useAvailable = false,
  } = input;

  const requestedTarget = num(targetContextPerNom) || DEFAULT_TARGET_CONTEXT_PER_NOM;
  const nomCeiling = Math.max(1, Math.min(num(maxNoms) || MAX_NOMS, MAX_NOMS));

  if (isCloudExecution(execution)) {
    return cloudRecommendation(execution, requestedTarget);
  }

  const model = resolveModel(gguf);
  const pool = resolveMemoryPool(hardware, { useAvailable: input.useAvailable === true });
  const warnings = environmentWarnings(hardware, pool, model);

  // Step down to the largest context that actually fits before giving up.
  // Recommending an unusable configuration and burying the working ones in an
  // "alternatives" table below is the wrong way round: the recommendation
  // should be the best option that works, with the shortfall stated plainly.
  let target = requestedTarget;
  let capacity = capacityFor(pool, model, target, bytesPerKvElement);
  let steppedDownFrom = null;
  if (capacity.rawCapacity < 1) {
    for (let ctx = Math.floor(target / 2); ctx >= MIN_CONTEXT_PER_NOM; ctx = Math.floor(ctx / 2)) {
      const c = capacityFor(pool, model, ctx, bytesPerKvElement);
      if (c.rawCapacity >= 1) {
        steppedDownFrom = target;
        target = ctx;
        capacity = c;
        break;
      }
    }
  }
  if (steppedDownFrom) {
    warnings.push(
      warning(
        "context_stepped_down",
        "warning",
        `${formatContext(steppedDownFrom)} per nom does not fit, so the recommendation steps down to ` +
          `${formatContext(target)}. Free memory, use a smaller quantization, or quantize the KV cache ` +
          `to reach the ${formatContext(steppedDownFrom)} target.`,
      ),
    );
  }
  const feasible = Math.min(Math.max(capacity.rawCapacity, 0), nomCeiling);
  const noms = Math.max(1, feasible);

  if (capacity.rawCapacity < 1) {
    warnings.push(
      warning(
        "low_memory",
        "error",
        `Not even one nom at ${formatContext(target)} fits inside the reserved headroom: ` +
          `${formatBytes(pool.poolBytes)} pool, ${formatBytes(model.weightsBytes)} weights and ` +
          `${formatBytes(capacity.kvPerSlot)} KV per slot. Recommending 1 nom anyway, but expect swapping or an ` +
          "out-of-memory failure. Reduce the per-nom context, use a smaller quantization, or quantize the KV cache.",
      ),
    );
  } else if (capacity.rawCapacity < 2 && pool.kind !== "unknown") {
    warnings.push(
      warning(
        "single_nom_only",
        "info",
        `This machine has room for one nom at ${formatContext(target)} (limited by ${capacity.limitedBy}). ` +
          "A second nom needs roughly " +
          `${formatBytes(capacity.perSlotBytes)} more.`,
      ),
    );
  }

  if (model.modelContextLength && target > model.modelContextLength) {
    warnings.push(
      warning(
        "context_exceeds_model",
        "warning",
        `Target ${formatContext(target)} per nom exceeds the model's trained context of ` +
          `${formatContext(model.modelContextLength)}.`,
      ),
    );
  }

  const llamaParallel = noms;
  const maxWorkers = noms; // Deliberately equal: see the oversubscription note.
  const contextTotal = target * llamaParallel;
  const memory = memoryBreakdown(pool, model, noms, target, bytesPerKvElement);

  // Capacity planning sizes against total RAM, because configuration persists
  // and should not change with whatever happens to be open. But a plan you
  // cannot act on right now is a trap: this check compares what must actually
  // be resident against what is free, and says how much to free before starting.
  const residentNeed =
    memory.modelWeightsBytes + memory.kvBytesTotal +
    (RESERVES.computeBufferPerSlotBytes * noms) + RESERVES.runtimeOverheadBytes;
  const freeNow = pool.systemAvailableBytes;
  if (freeNow && residentNeed > freeNow) {
    warnings.push(
      warning(
        "cannot_start_now",
        "error",
        `This configuration needs about ${formatBytes(residentNeed)} resident, but only ` +
          `${formatBytes(freeNow)} is free right now. Free at least ` +
          `${formatBytes(residentNeed - freeNow)} before starting, or it will not load ` +
          `and may take other processes down with it.`,
      ),
    );
  }

  // "More noms" (the recommendation above) answers "what fits in memory" --
  // this project's own README is explicit that this is a different question
  // from "is this fast enough to be useful", and that raising worker count
  // is the one documented contention/speed cost sizing has no model for.
  // Every profile actually shipped in config/profiles/*.env uses 1-2 workers
  // regardless of how much more memory-headroom exists, so "nominal" is that
  // convention made explicit: 1 worker at the SAME target context, not a
  // separately computed number.
  //
  // NOT always guaranteed to fit, caught by review: the step-down loop above
  // only updates `target`/`capacity` when it actually FINDS a context that
  // fits at least 1 nom. On a machine where nothing fits even at
  // MIN_CONTEXT_PER_NOM (the genuine "NOTHING FITS" case cmdSizing already
  // has to handle for the primary recommendation), the loop exhausts without
  // ever breaking, `target` stays at its original infeasible value, and
  // `capacity.rawCapacity` stays below 1 -- nominal would silently inherit
  // that same infeasibility with no way for a caller to tell. `fits` makes
  // that visible, mirroring the same field `alternatives` entries already
  // carry for exactly this reason.
  const nominal = {
    label: `1 nom @ ${formatContext(target)} (nominal -- matches this project's own shipped profiles, regardless of how many more would fit)`,
    contextPerNom: target,
    contextTotal: target,
    llamaParallel: 1,
    maxWorkers: 1,
    env: { NOMARMY_LLAMA_CONTEXT: target, NOMARMY_LLAMA_PARALLEL: 1, NOMARMY_MAX_WORKERS: 1 },
    summary: `1 nom at ${formatContext(target)} -> NOMARMY_LLAMA_CONTEXT=${target}, NOMARMY_LLAMA_PARALLEL=1, NOMARMY_MAX_WORKERS=1.`,
    fits: capacity.rawCapacity >= 1,
    // True when "more noms" already recommended exactly 1 -- nothing to
    // choose between in that case, both options are the same configuration.
    sameAsRecommended: noms === 1,
  };

  return {
    kind: "local",
    execution: "local",
    hardwareDerived: true,
    contextPerNom: target,
    contextTotal,
    llamaParallel,
    maxWorkers,
    targetContextPerNom: target,
    env: {
      NOMARMY_LLAMA_CONTEXT: contextTotal,
      NOMARMY_LLAMA_PARALLEL: llamaParallel,
      NOMARMY_MAX_WORKERS: maxWorkers,
    },
    model: {
      source: model.source,
      arch: model.arch,
      layers: model.layers,
      kvHeads: model.kvHeads,
      keyLength: model.keyLength,
      valueLength: model.valueLength,
      weightsBytes: model.weightsBytes,
      modelContextLength: model.modelContextLength,
    },
    memory,
    limitedBy: capacity.limitedBy,
    confidence: confidenceFor(model, pool),
    assumptions: assumptionsFor(model, pool, bytesPerKvElement),
    warnings,
    alternatives: buildAlternatives(pool, model, target, bytesPerKvElement, nomCeiling, noms),
    nominal,
    summary:
      `${noms} nom(s) at ${formatContext(target)} each -> NOMARMY_LLAMA_CONTEXT=${contextTotal}, ` +
      `NOMARMY_LLAMA_PARALLEL=${llamaParallel}, NOMARMY_MAX_WORKERS=${maxWorkers}.`,
  };
}

/**
 * Size for an EXACT worker count the caller picked, rather than solving for
 * the max that fits ("more noms") or the fixed shipped-profile convention
 * ("nominal"). Same step-down behavior as recommend(): the requested target
 * context is used if `noms` fits at it, otherwise context steps down until
 * `noms` fits or the machine genuinely cannot run that many at all (fits:
 * false, never silently substituted with a smaller count the caller didn't
 * ask for -- that decision belongs to the human who typed the number).
 *
 * @param {{
 *   hardware?: object|null, gguf?: object|null, execution?: string,
 *   noms: number, targetContextPerNom?: number, bytesPerKvElement?: number
 * }} input
 * @returns {object}
 */
export function customRecommendation(input = {}) {
  const {
    hardware = null, gguf = null, execution = "local",
    targetContextPerNom = DEFAULT_TARGET_CONTEXT_PER_NOM,
    bytesPerKvElement = DEFAULT_BYTES_PER_KV_ELEMENT,
  } = input;
  const noms = Math.max(1, Math.floor(num(input.noms) || 1));
  const requestedTarget = num(targetContextPerNom) || DEFAULT_TARGET_CONTEXT_PER_NOM;

  if (isCloudExecution(execution)) {
    // No local slots to divide -- concurrency is quota/budget-bound, so the
    // requested count is honored as-is, same as cloudRecommendation's own
    // NOMARMY_MAX_WORKERS.
    return {
      kind: "cloud", execution: String(execution).toLowerCase(), requestedNoms: noms,
      contextPerNom: requestedTarget, contextTotal: null, llamaParallel: null, maxWorkers: noms,
      env: { NOMARMY_MAX_WORKERS: noms }, fits: true, steppedDownFrom: null, memory: null,
      confidence: "not-applicable", limitedBy: "api-quota-and-budget",
      summary: `Hosted execution: NOMARMY_MAX_WORKERS=${noms} as requested, bounded by quota/budget, not local memory.`,
    };
  }

  const model = resolveModel(gguf);
  const pool = resolveMemoryPool(hardware, {});
  let target = requestedTarget;
  let capacity = capacityFor(pool, model, target, bytesPerKvElement);
  let fits = capacity.rawCapacity >= noms;
  let steppedDownFrom = null;
  if (!fits) {
    for (let ctx = Math.floor(target / 2); ctx >= MIN_CONTEXT_PER_NOM; ctx = Math.floor(ctx / 2)) {
      const c = capacityFor(pool, model, ctx, bytesPerKvElement);
      if (c.rawCapacity >= noms) { steppedDownFrom = target; target = ctx; capacity = c; fits = true; break; }
    }
  }
  const contextTotal = target * noms;
  const memory = memoryBreakdown(pool, model, noms, target, bytesPerKvElement);
  return {
    kind: "local", execution, requestedNoms: noms,
    contextPerNom: target, contextTotal, llamaParallel: noms, maxWorkers: noms,
    env: { NOMARMY_LLAMA_CONTEXT: contextTotal, NOMARMY_LLAMA_PARALLEL: noms, NOMARMY_MAX_WORKERS: noms },
    fits, steppedDownFrom, memory, limitedBy: capacity.limitedBy,
    confidence: confidenceFor(model, pool),
    assumptions: assumptionsFor(model, pool, bytesPerKvElement),
    summary: fits
      ? `${noms} nom(s) at ${formatContext(target)} each -> NOMARMY_LLAMA_CONTEXT=${contextTotal}, ` +
        `NOMARMY_LLAMA_PARALLEL=${noms}, NOMARMY_MAX_WORKERS=${noms}.`
      : `${noms} nom(s) does not fit on this machine even at the minimum context (${formatContext(MIN_CONTEXT_PER_NOM)}).`,
  };
}

/**
 * Cloud execution: local hardware is irrelevant. There are no inference slots
 * to divide, and the bound is API quota and budget.
 */
function cloudRecommendation(execution, target) {
  return {
    kind: "cloud",
    execution: String(execution).toLowerCase(),
    hardwareDerived: false,
    contextPerNom: target,
    contextTotal: null,
    llamaParallel: null,
    maxWorkers: CLOUD_DEFAULT_MAX_WORKERS,
    targetContextPerNom: target,
    env: {
      NOMARMY_MAX_WORKERS: CLOUD_DEFAULT_MAX_WORKERS,
    },
    model: null,
    memory: null,
    limitedBy: "api-quota-and-budget",
    confidence: "not-applicable",
    assumptions: [
      "Execution is hosted, so no local weights, KV cache or inference slots exist on this machine.",
      "NOMARMY_LLAMA_CONTEXT and NOMARMY_LLAMA_PARALLEL do not apply and are left unset.",
      `NOMARMY_MAX_WORKERS=${CLOUD_DEFAULT_MAX_WORKERS} is the profile default, not a hardware-derived number.`,
    ],
    warnings: [
      warning(
        "cloud_execution",
        "info",
        `NOMARMY_EXECUTION=${execution}: worker concurrency is bounded by your Bedrock TPM quota and your budget, ` +
          "not by this machine. Measure first-pass accept rate before raising it; coordinator review tokens " +
          "dominate worker tokens.",
      ),
      warning(
        "cloud_data_flow",
        "info",
        "Cloud profiles send repository content off the machine. That is a data-residency decision, not a sizing one.",
      ),
    ],
    alternatives: [],
    // "More noms" vs "nominal" is a local memory/contention tradeoff; a
    // cloud profile has no local slots to trade off in the first place.
    nominal: null,
    summary:
      `Hosted execution: no local slots. NOMARMY_MAX_WORKERS=${CLOUD_DEFAULT_MAX_WORKERS} bounded by quota/budget.`,
  };
}

/**
 * Show the tradeoff rather than handing back one number: fewer noms with more
 * context each, or more noms with less.
 */
function buildAlternatives(pool, model, target, bytesPerElement, nomCeiling, recommendedNoms) {
  const contexts = [];
  for (let ctx = target; ctx >= MIN_CONTEXT_PER_NOM; ctx = Math.floor(ctx / 2)) {
    contexts.push(ctx);
    if (contexts.length >= 4) break;
  }

  const out = [];
  const seen = new Set();
  for (const ctx of contexts) {
    const capacity = capacityFor(pool, model, ctx, bytesPerElement);
    const noms = Math.max(1, Math.min(Math.max(capacity.rawCapacity, 0), nomCeiling));
    const key = `${noms}@${ctx}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const memory = memoryBreakdown(pool, model, noms, ctx, bytesPerElement);
    out.push({
      label: `${noms} nom${noms === 1 ? "" : "s"} @ ${formatContext(ctx)}`,
      noms,
      contextPerNom: ctx,
      contextTotal: ctx * noms,
      llamaParallel: noms,
      maxWorkers: noms,
      estimatedTotalBytes: memory.estimatedTotalBytes,
      headroomBytes: memory.headroomBytes,
      fits: capacity.rawCapacity >= 1,
      recommended: ctx === target && noms === recommendedNoms,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// evaluateConfig
// ---------------------------------------------------------------------------

/**
 * Check an EXISTING profile's numbers and return the same warning shapes as
 * `recommend()`. This is what tells a user their current profile is
 * oversubscribed, over-committed on memory, or quietly giving each nom half the
 * context they think it has.
 *
 * @param {{
 *   hardware?: object|null,
 *   gguf?: object|null,
 *   contextTotal: number,
 *   llamaParallel: number,
 *   maxWorkers: number,
 *   targetContextPerNom?: number,
 *   execution?: string,
 *   bytesPerKvElement?: number
 * }} input
 * @returns {object}
 */
export function evaluateConfig(input = {}) {
  const {
    hardware = null,
    gguf = null,
    contextTotal,
    llamaParallel,
    maxWorkers,
    targetContextPerNom = DEFAULT_TARGET_CONTEXT_PER_NOM,
    execution = "local",
    bytesPerKvElement = DEFAULT_BYTES_PER_KV_ELEMENT,
    useAvailable = false,
  } = input;

  const target = num(targetContextPerNom) || DEFAULT_TARGET_CONTEXT_PER_NOM;
  const warnings = [];

  if (isCloudExecution(execution)) {
    if (num(contextTotal) || num(llamaParallel)) {
      warnings.push(
        warning(
          "cloud_execution",
          "info",
          `NOMARMY_EXECUTION=${execution}: NOMARMY_LLAMA_CONTEXT and NOMARMY_LLAMA_PARALLEL are ignored, ` +
            "since no llama-server runs on this machine. Worker concurrency is bounded by quota and budget.",
        ),
      );
    }
    return {
      kind: "cloud",
      execution: String(execution).toLowerCase(),
      hardwareDerived: false,
      ok: true,
      contextPerNom: null,
      contextTotal: num(contextTotal) || null,
      llamaParallel: num(llamaParallel) || null,
      maxWorkers: num(maxWorkers) || null,
      memory: null,
      confidence: "not-applicable",
      assumptions: ["Hosted execution: local memory and inference slots do not apply."],
      warnings,
    };
  }

  const parallel = num(llamaParallel);
  const total = num(contextTotal);
  const workers = num(maxWorkers);

  if (!parallel || !total || !workers) {
    warnings.push(
      warning(
        "invalid_config",
        "error",
        "contextTotal, llamaParallel and maxWorkers must each be a positive number to be evaluated " +
          `(got contextTotal=${contextTotal}, llamaParallel=${llamaParallel}, maxWorkers=${maxWorkers}).`,
      ),
    );
    return {
      kind: "local",
      execution: "local",
      hardwareDerived: true,
      ok: false,
      contextPerNom: null,
      contextTotal: total || null,
      llamaParallel: parallel || null,
      maxWorkers: workers || null,
      memory: null,
      confidence: "low",
      assumptions: [],
      warnings,
    };
  }

  const contextPerNom = Math.floor(total / parallel);
  const model = resolveModel(gguf);
  const pool = resolveMemoryPool(hardware, { useAvailable: input.useAvailable === true });
  warnings.push(...environmentWarnings(hardware, pool, model));

  if (contextPerNom < target) {
    warnings.push(contextBelowTargetWarning(contextPerNom, target, total, parallel));
  }
  if (total % parallel !== 0) {
    warnings.push(
      warning(
        "context_not_divisible",
        "info",
        `NOMARMY_LLAMA_CONTEXT=${total} does not divide evenly by ${parallel} slots; ` +
          `each nom gets ${contextPerNom} tokens and ${total % parallel} are wasted.`,
      ),
    );
  }
  if (workers > parallel) {
    warnings.push(oversubscriptionWarning(workers, parallel));
  } else if (workers < parallel) {
    warnings.push(
      warning(
        "idle_slots",
        "info",
        `NOMARMY_MAX_WORKERS=${workers} is below NOMARMY_LLAMA_PARALLEL=${parallel}: ` +
          `${parallel - workers} inference slot(s) hold reserved KV cache that no nom will ever use. ` +
          "Lower the parallel count to give the remaining noms more context each.",
      ),
    );
  }

  const memory = memoryBreakdown(pool, model, parallel, contextPerNom, bytesPerKvElement);
  if (memory.fits === false) {
    warnings.push(
      warning(
        "memory_over_commit",
        "error",
        `This configuration is estimated at ${formatBytes(memory.estimatedTotalBytes)} against a ` +
          `${formatBytes(memory.budgetBytes)} budget (${formatBytes(pool.poolBytes)} pool at ` +
          `${Math.round(RESERVES.safetyFraction * 100)}%): over by ${formatBytes(-memory.headroomBytes)}. ` +
          "Reduce NOMARMY_LLAMA_CONTEXT or NOMARMY_LLAMA_PARALLEL.",
      ),
    );
  }

  const ok = !warnings.some((w) => w.severity === "error");
  return {
    kind: "local",
    execution: "local",
    hardwareDerived: true,
    ok,
    contextPerNom,
    contextTotal: total,
    llamaParallel: parallel,
    maxWorkers: workers,
    targetContextPerNom: target,
    model: {
      source: model.source,
      arch: model.arch,
      layers: model.layers,
      kvHeads: model.kvHeads,
      keyLength: model.keyLength,
      valueLength: model.valueLength,
      weightsBytes: model.weightsBytes,
    },
    memory,
    confidence: confidenceFor(model, pool),
    assumptions: assumptionsFor(model, pool, bytesPerKvElement),
    warnings,
    summary:
      `-c ${total} / -np ${parallel} = ${formatContext(contextPerNom)} per nom, ` +
      `${workers} worker(s), estimated ${formatBytes(memory.estimatedTotalBytes)} of ` +
      `${formatBytes(memory.budgetBytes)} budget.`,
  };
}

export default { recommend, customRecommendation, evaluateConfig, RESERVES, DEFAULT_TARGET_CONTEXT_PER_NOM, KV_CACHE_TYPE_BYTES, bytesPerKvElementForCacheTypes };
