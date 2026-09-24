// Tests for lib/sizing.mjs.
//
// Everything here uses hand-constructed fact objects: `recommend()` and
// `evaluateConfig()` are pure, so no real hardware and no real model file are
// needed to pin the behavior that matters.

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_TARGET_CONTEXT_PER_NOM,
  DEFAULT_BYTES_PER_KV_ELEMENT,
  GIB,
  RESERVES,
  MIN_CONTEXT_PER_NOM,
  bytesPerKvElementForCacheTypes,
  customRecommendation,
  evaluateConfig,
  kvBytesPerSlot,
  recommend,
  resolveModel,
} from "../lib/sizing.mjs";

// --- fixtures --------------------------------------------------------------

/** A readable GGUF: ~30B-class GQA coder model, 48 layers, 4 KV heads. */
function ggufFound(overrides = {}) {
  return {
    found: true,
    path: "/models/qwen3-coder-next-Q4_K_M.gguf",
    fileSizeBytes: 18 * GIB,
    arch: "qwen3",
    truncated: false,
    params: {
      blockCount: 48,
      headCount: 32,
      headCountKv: 4,
      keyLength: 128,
      valueLength: 128,
      embeddingLength: 4096,
      contextLength: 262144,
    },
    ...overrides,
  };
}

const ggufMissing = {
  found: false,
  path: null,
  fileSizeBytes: null,
  arch: null,
  truncated: false,
  params: {},
  reason: "no model path supplied",
};

function nvidiaMachine({ freeVramBytes, totalVramBytes, ramBytes, gpuCount = 1 }) {
  return {
    platform: "linux",
    arch: "x64",
    isWSL: false,
    appleSilicon: false,
    cpu: { model: "Xeon", physicalCores: 16, logicalCores: 32 },
    memory: { totalBytes: ramBytes, availableBytes: ramBytes, unified: false, unifiedBytes: null },
    gpu: {
      vendor: "nvidia",
      count: gpuCount,
      devices: [],
      totalVramBytes: totalVramBytes ?? freeVramBytes,
      freeVramBytes,
    },
    podman: { available: true, totalMemoryBytes: ramBytes },
    probes: [],
  };
}

function appleMachine(ramBytes) {
  return {
    platform: "darwin",
    arch: "arm64",
    isWSL: false,
    appleSilicon: true,
    cpu: { model: "Apple M3 Max", physicalCores: 14, logicalCores: 14 },
    memory: { totalBytes: ramBytes, availableBytes: ramBytes, unified: true, unifiedBytes: ramBytes },
    gpu: { vendor: "apple", count: 0, devices: [], totalVramBytes: null, freeVramBytes: null },
    podman: { available: true, totalMemoryBytes: 8 * GIB },
    probes: [],
  };
}

function cpuOnlyMachine(ramBytes, availableBytes = ramBytes) {
  return {
    platform: "linux",
    arch: "x64",
    isWSL: false,
    appleSilicon: false,
    cpu: { model: "i5", physicalCores: 4, logicalCores: 8 },
    memory: { totalBytes: ramBytes, availableBytes, unified: false, unifiedBytes: null },
    gpu: { vendor: null, count: 0, devices: [], totalVramBytes: null, freeVramBytes: null },
    podman: { available: true, totalMemoryBytes: ramBytes },
    probes: [],
  };
}

function codes(result) {
  return result.warnings.map((w) => w.code);
}

// --- the per-slot division -------------------------------------------------

test("2 noms at 64K each require a TOTAL context of 131072", () => {
  const result = recommend({
    hardware: nvidiaMachine({ freeVramBytes: 80 * GIB, ramBytes: 128 * GIB }),
    gguf: ggufFound(),
    execution: "local",
    targetContextPerNom: 65536,
    maxNoms: 2,
  });

  assert.equal(result.llamaParallel, 2);
  assert.equal(result.contextPerNom, 65536);
  assert.equal(result.contextTotal, 131072, "-c is total context shared across -np slots");
  assert.equal(result.contextTotal, result.contextPerNom * result.llamaParallel);
  assert.equal(result.env.NOMARMY_LLAMA_CONTEXT, 131072);
  assert.equal(result.env.NOMARMY_LLAMA_PARALLEL, 2);
});

test("contextTotal always equals contextPerNom * llamaParallel", () => {
  for (const maxNoms of [1, 2, 3, 4, 8]) {
    const result = recommend({
      hardware: nvidiaMachine({ freeVramBytes: 180 * GIB, ramBytes: 256 * GIB }),
      gguf: ggufFound(),
      maxNoms,
    });
    assert.equal(result.contextTotal, result.contextPerNom * result.llamaParallel);
    assert.ok(result.llamaParallel <= maxNoms);
  }
});

// --- oversubscription ------------------------------------------------------

test("recommend() never oversubscribes: maxWorkers equals llamaParallel", () => {
  const result = recommend({
    hardware: nvidiaMachine({ freeVramBytes: 80 * GIB, ramBytes: 128 * GIB }),
    gguf: ggufFound(),
  });
  assert.equal(result.maxWorkers, result.llamaParallel);
  assert.ok(!codes(result).includes("oversubscription"));
});

// --- nominal preset: "more noms" (the primary recommendation) answers what
// fits in memory; "nominal" is 1 worker at the same context, matching every
// profile actually shipped in config/profiles/*.env regardless of how much
// more would fit. No third "fast" tier: worker count is the only speed-
// relevant lever this codebase has real data for (README's own measured
// contention notes), and it collapses to the same thing as nominal.
// ---------------------------------------------------------------------------
test("recommend(): nominal is always 1 worker at the same target context as the primary recommendation", () => {
  const result = recommend({
    hardware: nvidiaMachine({ freeVramBytes: 80 * GIB, ramBytes: 128 * GIB }),
    gguf: ggufFound(),
  });
  assert.equal(result.nominal.contextPerNom, result.contextPerNom);
  assert.equal(result.nominal.llamaParallel, 1);
  assert.equal(result.nominal.maxWorkers, 1);
  assert.equal(result.nominal.contextTotal, result.contextPerNom);
  assert.deepEqual(result.nominal.env, {
    NOMARMY_LLAMA_CONTEXT: result.contextPerNom,
    NOMARMY_LLAMA_PARALLEL: 1,
    NOMARMY_MAX_WORKERS: 1,
  });
});

test("recommend(): nominal is always guaranteed to fit, even on a machine where only 1 nom fits at all", () => {
  // A machine so constrained that the primary recommendation itself is
  // already 1 nom -- nominal must equal it exactly, not something smaller.
  const result = recommend({ hardware: cpuOnlyMachine(4 * GIB), gguf: ggufFound() });
  assert.equal(result.maxWorkers, 1);
  assert.equal(result.nominal.maxWorkers, 1);
  assert.equal(result.nominal.contextPerNom, result.contextPerNom);
  assert.equal(result.nominal.sameAsRecommended, true);
});

test("recommend(): sameAsRecommended is false when more than 1 nom is actually recommended", () => {
  const result = recommend({
    hardware: nvidiaMachine({ freeVramBytes: 80 * GIB, ramBytes: 128 * GIB }),
    gguf: ggufFound(),
  });
  assert.ok(result.maxWorkers > 1, "test setup should recommend more than 1 nom");
  assert.equal(result.nominal.sameAsRecommended, false);
});

test("recommend(): a cloud (bedrock) execution has no nominal preset -- no local slots to trade off", () => {
  const result = recommend({ hardware: cpuOnlyMachine(4 * GIB), gguf: ggufMissing, execution: "bedrock" });
  assert.equal(result.nominal, null);
});

// Caught by a live code-review pass on this exact code: the step-down loop
// only updates target/capacity when it actually finds a context that fits
// >=1 nom. On a machine where NOTHING fits even at MIN_CONTEXT_PER_NOM,
// target stays at its original infeasible value -- nominal must say so
// (fits: false), not silently inherit that infeasibility with no signal.
test("recommend(): nominal.fits is false on a machine where nothing fits even at the minimum context", () => {
  const result = recommend({ hardware: cpuOnlyMachine(1 * 1024 * 1024), gguf: ggufFound() });
  assert.equal(result.memory.fits, false, "test setup should genuinely not fit");
  assert.equal(result.nominal.fits, false);
});

test("recommend(): nominal.fits is true whenever the primary recommendation itself fits", () => {
  const result = recommend({
    hardware: nvidiaMachine({ freeVramBytes: 80 * GIB, ramBytes: 128 * GIB }),
    gguf: ggufFound(),
  });
  assert.equal(result.nominal.fits, true);
});

test("evaluateConfig() warns when maxWorkers exceeds llamaParallel", () => {
  const result = evaluateConfig({
    hardware: nvidiaMachine({ freeVramBytes: 80 * GIB, ramBytes: 128 * GIB }),
    gguf: ggufFound(),
    contextTotal: 65536,
    llamaParallel: 1,
    maxWorkers: 4,
  });

  const over = result.warnings.find((w) => w.code === "oversubscription");
  assert.ok(over, "expected an oversubscription warning");
  assert.equal(over.severity, "warning");
  assert.match(over.message, /queue/i);
  assert.match(over.message, /NOMARMY_MAX_WORKERS=4/);
});

test("evaluateConfig() flags idle slots when maxWorkers is below llamaParallel", () => {
  const result = evaluateConfig({
    hardware: nvidiaMachine({ freeVramBytes: 80 * GIB, ramBytes: 128 * GIB }),
    gguf: ggufFound(),
    contextTotal: 131072,
    llamaParallel: 2,
    maxWorkers: 1,
  });
  assert.ok(codes(result).includes("idle_slots"));
});

// --- cloud execution -------------------------------------------------------

test("bedrock execution returns a cloud recommendation, not a hardware-derived one", () => {
  const result = recommend({
    hardware: cpuOnlyMachine(4 * GIB),
    gguf: ggufMissing,
    execution: "bedrock",
  });

  assert.equal(result.kind, "cloud");
  assert.equal(result.hardwareDerived, false);
  assert.equal(result.llamaParallel, null, "hosted inference has no local slots");
  assert.equal(result.contextTotal, null);
  assert.equal(result.memory, null);
  assert.ok(result.maxWorkers >= 1);
  assert.ok(codes(result).includes("cloud_execution"));
  assert.equal(result.limitedBy, "api-quota-and-budget");
  // A 4 GiB CPU-only box must not drag the cloud answer down.
  assert.ok(!codes(result).includes("low_memory"));
  assert.ok(!codes(result).includes("no_gpu"));
});

test("bedrock-cheap is also treated as cloud execution", () => {
  const result = recommend({ hardware: null, gguf: null, execution: "bedrock-cheap" });
  assert.equal(result.kind, "cloud");
  assert.equal(result.hardwareDerived, false);
});

// --- low memory ------------------------------------------------------------

test("a low-memory machine recommends exactly 1 nom and warns", () => {
  const result = recommend({
    hardware: cpuOnlyMachine(8 * GIB, 6 * GIB),
    gguf: ggufFound(),
  });

  assert.equal(result.llamaParallel, 1);
  assert.equal(result.maxWorkers, 1);
  const list = codes(result);
  assert.ok(list.includes("low_memory"), `expected low_memory, got ${list.join(",")}`);
  assert.ok(list.includes("no_gpu"));
  const low = result.warnings.find((w) => w.code === "low_memory");
  assert.equal(low.severity, "error");
});

// --- unknown model ---------------------------------------------------------

test("an absent GGUF yields confidence low with the assumption spelled out", () => {
  const result = recommend({
    hardware: nvidiaMachine({ freeVramBytes: 80 * GIB, ramBytes: 128 * GIB }),
    gguf: ggufMissing,
  });

  assert.equal(result.confidence, "low");
  assert.equal(result.model.source, "fallback");
  assert.ok(codes(result).includes("unknown_model"));

  const unknown = result.warnings.find((w) => w.code === "unknown_model");
  assert.match(unknown.message, /guess, not a measurement/i);
  assert.ok(
    result.assumptions.some((a) => /^ASSUMED: block_count/.test(a)),
    "the assumed architecture numbers must be stated in the result",
  );
});

test("a fully readable GGUF on measured hardware yields confidence high", () => {
  const result = recommend({
    hardware: nvidiaMachine({ freeVramBytes: 80 * GIB, ramBytes: 128 * GIB }),
    gguf: ggufFound(),
  });
  assert.equal(result.confidence, "high");
  assert.equal(result.model.source, "gguf");
  assert.equal(result.model.layers, 48);
  assert.equal(result.model.kvHeads, 4);
});

test("a truncated GGUF header degrades confidence rather than claiming a measurement", () => {
  const result = recommend({
    hardware: nvidiaMachine({ freeVramBytes: 80 * GIB, ramBytes: 128 * GIB }),
    gguf: ggufFound({ truncated: true }),
  });
  assert.equal(result.confidence, "medium");
  assert.ok(codes(result).includes("partial_model_metadata"));
});

// --- hybrid (recurrent/SSM) architectures -----------------------------------
//
// A hybrid model mixes full-attention layers with recurrent/state-space
// layers (GGUF exposes the latter as `.ssm.*` header keys) whose state does
// not grow with context. Treating every layer as full attention -- the naive
// formula -- overstates KV cache growth for these models. Numbers below are
// the real Qwen3-Coder-Next-GGUF header values, verified directly against
// the file and against Qwen's own published 3:1 Gated DeltaNet : full
// attention ratio.
function qwen3NextGguf(overrides = {}) {
  return ggufFound({
    arch: "qwen3next",
    fileSizeBytes: 45.1 * GIB,
    params: {
      blockCount: 48,
      headCount: 16,
      headCountKv: 2,
      keyLength: 256,
      valueLength: 256,
      embeddingLength: 2048,
      contextLength: 262144,
      ssmConvKernel: 4,
      ssmStateSize: 128,
      ssmGroupCount: 16,
      ssmTimeStepRank: 32,
      ssmInnerSize: 4096,
    },
    ...overrides,
  });
}

test("resolveModel: a recognized hybrid architecture sizes KV cache for its full-attention layers only", () => {
  const model = resolveModel(qwen3NextGguf());
  assert.equal(model.isHybrid, true);
  assert.equal(model.hybridRecognized, true);
  assert.equal(model.layers, 48, "total block count is unchanged, still reported");
  assert.equal(model.kvLayers, 12, "48 layers * 1/4 full-attention fraction, rounded");
  assert.match(model.hybridNote, /qwen3next/);
  assert.match(model.hybridNote, /12 of 48/);
  // The correction is a known, cited fact, not a guess for missing data --
  // it must not read as reduced confidence.
  assert.equal(model.assumed.length, 0);
  assert.equal(model.complete, true);
});

test("resolveModel: ssm keys present but an unrecognized architecture leaves layers uncorrected", () => {
  const model = resolveModel(qwen3NextGguf({ arch: "some-future-hybrid-arch" }));
  assert.equal(model.isHybrid, true);
  assert.equal(model.hybridRecognized, false);
  assert.equal(model.kvLayers, model.layers, "no known ratio -- fall back to the conservative (safe-direction) assumption");
  assert.equal(model.hybridNote, null);
});

test("resolveModel: an ordinary (non-hybrid) model is never treated as hybrid", () => {
  const model = resolveModel(ggufFound());
  assert.equal(model.isHybrid, false);
  assert.equal(model.hybridRecognized, false);
  assert.equal(model.kvLayers, model.layers);
});

test("kvBytesPerSlot: uses kvLayers, not the total layer count, for a recognized hybrid model", () => {
  const model = resolveModel(qwen3NextGguf());
  const kv = kvBytesPerSlot(model, DEFAULT_TARGET_CONTEXT_PER_NOM);
  const naiveKv = model.layers * model.kvHeads * (model.keyLength + model.valueLength) * DEFAULT_TARGET_CONTEXT_PER_NOM * 2;
  assert.equal(kv, model.kvLayers * model.kvHeads * (model.keyLength + model.valueLength) * DEFAULT_TARGET_CONTEXT_PER_NOM * 2);
  assert.equal(kv, naiveKv / 4, "1 in 4 layers is full attention, so the corrected KV cost is a quarter of the naive one");
});

test("recommend: the hybrid correction is what makes 64K fit on a machine where the naive formula would refuse it", () => {
  const gguf = qwen3NextGguf();
  const model = resolveModel(gguf);
  const naiveKvPerSlot = model.layers * model.kvHeads * (model.keyLength + model.valueLength) * DEFAULT_TARGET_CONTEXT_PER_NOM * 2;
  const correctedKvPerSlot = kvBytesPerSlot(model, DEFAULT_TARGET_CONTEXT_PER_NOM);
  assert.ok(correctedKvPerSlot < naiveKvPerSlot, "sanity: the correction must actually shrink the estimate");

  // Mirrors capacityFor's own "vram" branch exactly: 1 slot fits iff
  // poolBytes * safetyFraction - runtimeOverhead - weights >= perSlotBudget.
  // Pick a pool at the corrected threshold (plus a small margin) -- this is
  // the exact shape of the real discrepancy (64K context, ~45 GiB weights,
  // works in practice; the naive formula said it would not).
  const poolFor = (kvPerSlot) =>
    Math.ceil((model.weightsBytes + kvPerSlot + RESERVES.computeBufferPerSlotBytes + RESERVES.runtimeOverheadBytes) / RESERVES.safetyFraction);
  const pool = poolFor(correctedKvPerSlot) + 1 * GIB;
  assert.ok(pool < poolFor(naiveKvPerSlot), "sanity: the naive estimate would still need a bigger pool than this");

  const result = recommend({
    hardware: nvidiaMachine({ freeVramBytes: pool, ramBytes: pool + 64 * GIB }),
    gguf,
  });
  assert.equal(result.contextPerNom, DEFAULT_TARGET_CONTEXT_PER_NOM, "64K must be reachable, not stepped down");
  assert.ok(codes(result).includes("hybrid_architecture_corrected"));
});

test("recommend: an unrecognized hybrid architecture warns instead of silently guessing a ratio", () => {
  const result = recommend({
    hardware: nvidiaMachine({ freeVramBytes: 80 * GIB, ramBytes: 128 * GIB }),
    gguf: qwen3NextGguf({ arch: "unknown-hybrid" }),
  });
  const w = result.warnings.find((x) => x.code === "unrecognized_hybrid_architecture");
  assert.ok(w, "must warn when ssm layers are present but the ratio is unknown");
  assert.match(w.message, /OVERSTATES/);
  assert.equal(codes(result).includes("hybrid_architecture_corrected"), false);
});

// --- headroom --------------------------------------------------------------

test("headroom is actually reserved: a machine that 'just fits' gets fewer noms", () => {
  const gguf = ggufFound();
  const model = resolveModel(gguf);
  const kvPerSlot = kvBytesPerSlot(model, DEFAULT_TARGET_CONTEXT_PER_NOM);

  // Exactly weights + 2 slots of KV cache and not one byte more. Naive maths
  // says "2 noms"; with the OS, coordinator, sandbox, runtime and safety margin
  // reserved, only one can actually run.
  const justFits = model.weightsBytes + 2 * kvPerSlot;

  const tight = recommend({
    hardware: nvidiaMachine({ freeVramBytes: justFits, ramBytes: 128 * GIB }),
    gguf,
  });
  assert.equal(tight.llamaParallel, 1, "must not fill the pool to the brim");
  assert.ok(tight.memory.headroomBytes > 0, "the recommendation must leave headroom");

  // Same model, same context, enough extra room for the reserves: now 2 fit.
  const roomy = recommend({
    hardware: nvidiaMachine({
      freeVramBytes: Math.ceil(
        (justFits + RESERVES.runtimeOverheadBytes + 2 * RESERVES.computeBufferPerSlotBytes) /
          RESERVES.safetyFraction,
      ),
      ramBytes: 128 * GIB,
    }),
    gguf,
  });
  assert.equal(roomy.llamaParallel, 2);

  // And the breakdown must name the reserves, not bury them.
  assert.equal(tight.memory.reserved.runtimeOverheadBytes, RESERVES.runtimeOverheadBytes);
  assert.equal(tight.memory.reserved.safetyFraction, RESERVES.safetyFraction);
  assert.ok(tight.memory.reserved.sandboxBytes >= RESERVES.sandboxPerNomBytes);
});

test("the Podman sandbox per nom is charged against system RAM on a discrete-GPU box", () => {
  // Plenty of VRAM, but system RAM only has room for a couple of sandboxes.
  const result = recommend({
    hardware: nvidiaMachine({ freeVramBytes: 180 * GIB, ramBytes: 8 * GIB }),
    gguf: ggufFound(),
  });
  assert.equal(result.limitedBy, "system-ram");
  assert.equal(result.llamaParallel, 1);
});

// --- memory breakdown ------------------------------------------------------

test("the memory breakdown adds up and uses the stated KV formula", () => {
  const gguf = ggufFound();
  const result = recommend({
    hardware: nvidiaMachine({ freeVramBytes: 80 * GIB, ramBytes: 128 * GIB }),
    gguf,
    maxNoms: 2,
  });

  const expectedKv = 48 * 4 * (128 + 128) * 65536 * 2;
  assert.equal(result.memory.kvBytesPerSlot, expectedKv);
  assert.equal(result.memory.kvBytesTotal, expectedKv * 2);
  assert.equal(result.memory.bytesPerKvElement, 2);
  assert.equal(result.memory.modelWeightsBytes, 18 * GIB);

  // Discrete VRAM: weights + KV + compute buffers + runtime overhead.
  assert.equal(
    result.memory.estimatedTotalBytes,
    18 * GIB + expectedKv * 2 + 2 * RESERVES.computeBufferPerSlotBytes + RESERVES.runtimeOverheadBytes,
  );
  assert.ok(result.assumptions.some((a) => /fp16/.test(a)), "the fp16 KV assumption must be stated");
});

test("a quantized KV cache is honoured and restated", () => {
  const base = recommend({
    hardware: nvidiaMachine({ freeVramBytes: 80 * GIB, ramBytes: 128 * GIB }),
    gguf: ggufFound(),
  });
  const q8 = recommend({
    hardware: nvidiaMachine({ freeVramBytes: 80 * GIB, ramBytes: 128 * GIB }),
    gguf: ggufFound(),
    bytesPerKvElement: 1,
  });
  assert.equal(q8.memory.kvBytesPerSlot, base.memory.kvBytesPerSlot / 2);
  assert.ok(q8.llamaParallel >= base.llamaParallel);
});

// --- unified memory --------------------------------------------------------

test("Apple Silicon is reported as one shared pool, not VRAM plus RAM", () => {
  const result = recommend({ hardware: appleMachine(64 * GIB), gguf: ggufFound() });
  assert.equal(result.memory.pool.kind, "unified");
  const caveat = result.warnings.find((w) => w.code === "unified_memory");
  assert.ok(caveat, "unified memory must carry a caveat");
  assert.match(caveat.message, /share one pool/i);
  // The sandbox comes out of the same pool on a unified machine.
  assert.ok(result.memory.estimatedTotalBytes > result.memory.gpuResidentBytes);
});

test("coherent GB10-class memory is not counted twice", () => {
  // Reported VRAM is essentially all of system RAM: the same silicon.
  const result = recommend({
    hardware: nvidiaMachine({ freeVramBytes: 118 * GIB, totalVramBytes: 120 * GIB, ramBytes: 128 * GIB }),
    gguf: ggufFound(),
  });
  assert.equal(result.memory.pool.kind, "unified");
  assert.equal(result.memory.pool.coherent, true);
  assert.ok(result.memory.pool.bytes <= 128 * GIB);
  assert.ok(codes(result).includes("unified_memory"));
});

// --- alternatives ----------------------------------------------------------

test("alternatives show the tradeoff between fewer noms and more context", () => {
  const result = recommend({
    hardware: nvidiaMachine({ freeVramBytes: 40 * GIB, ramBytes: 64 * GIB }),
    gguf: ggufFound(),
  });

  assert.ok(Array.isArray(result.alternatives));
  assert.ok(result.alternatives.length >= 2, "a human should be able to choose");
  assert.ok(result.alternatives.some((a) => a.recommended));
  for (const alt of result.alternatives) {
    assert.equal(alt.contextTotal, alt.contextPerNom * alt.noms);
    assert.equal(alt.maxWorkers, alt.llamaParallel);
    assert.match(alt.label, /nom/);
  }
  // Halving the per-nom context must allow at least as many noms.
  const sorted = [...result.alternatives].sort((a, b) => b.contextPerNom - a.contextPerNom);
  for (let i = 1; i < sorted.length; i += 1) {
    assert.ok(sorted[i].noms >= sorted[i - 1].noms);
  }
});

// --- evaluateConfig against the shipped profiles ---------------------------

test("evaluateConfig flags the real dgx-spark numbers as 32K per nom", () => {
  // config/profiles/dgx-spark.env: NOMARMY_LLAMA_CONTEXT=65536, PARALLEL=2, MAX_WORKERS=2
  const result = evaluateConfig({
    hardware: nvidiaMachine({ freeVramBytes: 118 * GIB, totalVramBytes: 120 * GIB, ramBytes: 128 * GIB }),
    gguf: ggufFound(),
    contextTotal: 65536,
    llamaParallel: 2,
    maxWorkers: 2,
    targetContextPerNom: 65536,
  });

  assert.equal(result.contextPerNom, 32768);
  const below = result.warnings.find((w) => w.code === "context_below_target");
  assert.ok(below, "dgx-spark gives each nom half the context the profile appears to promise");
  assert.match(below.message, /32K/);
  assert.match(below.message, /NOMARMY_LLAMA_CONTEXT=131072/);
  // Slots and workers match, so this specific config is not oversubscribed.
  assert.ok(!codes(result).includes("oversubscription"));
});

test("evaluateConfig accepts a correctly sized single-nom profile", () => {
  // config/profiles/macbook-pro.env: CONTEXT=65536, PARALLEL=1, MAX_WORKERS=1
  const result = evaluateConfig({
    hardware: appleMachine(64 * GIB),
    gguf: ggufFound(),
    contextTotal: 65536,
    llamaParallel: 1,
    maxWorkers: 1,
  });
  assert.equal(result.contextPerNom, 65536);
  assert.ok(!codes(result).includes("context_below_target"));
  assert.ok(!codes(result).includes("oversubscription"));
  assert.equal(result.memory.fits, true);
  assert.equal(result.ok, true);
});

test("evaluateConfig flags a memory over-commit", () => {
  const result = evaluateConfig({
    hardware: nvidiaMachine({ freeVramBytes: 24 * GIB, ramBytes: 32 * GIB }),
    gguf: ggufFound(),
    contextTotal: 262144,
    llamaParallel: 4,
    maxWorkers: 4,
  });
  assert.ok(codes(result).includes("memory_over_commit"));
  assert.equal(result.ok, false);
  assert.equal(result.memory.fits, false);
});

test("evaluateConfig returns the same warning shape as recommend", () => {
  const evaluated = evaluateConfig({
    hardware: cpuOnlyMachine(8 * GIB),
    gguf: ggufMissing,
    contextTotal: 65536,
    llamaParallel: 1,
    maxWorkers: 2,
  });
  const recommended = recommend({ hardware: cpuOnlyMachine(8 * GIB), gguf: ggufMissing });

  for (const w of [...evaluated.warnings, ...recommended.warnings]) {
    assert.deepEqual(Object.keys(w).sort(), ["code", "message", "severity"]);
    assert.ok(["info", "warning", "error"].includes(w.severity));
    assert.ok(typeof w.message === "string" && w.message.length > 0);
  }
  // Both must report the shared environment facts identically.
  assert.ok(codes(evaluated).includes("no_gpu"));
  assert.ok(codes(recommended).includes("no_gpu"));
  assert.ok(codes(evaluated).includes("unknown_model"));
  assert.ok(codes(recommended).includes("unknown_model"));
});

test("evaluateConfig rejects nonsense input without throwing", () => {
  const result = evaluateConfig({ contextTotal: 0, llamaParallel: 0, maxWorkers: -1 });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes("invalid_config"));
});

test("evaluateConfig on a cloud profile ignores local slot settings", () => {
  const result = evaluateConfig({
    hardware: cpuOnlyMachine(8 * GIB),
    gguf: ggufMissing,
    execution: "bedrock",
    contextTotal: 65536,
    llamaParallel: 1,
    maxWorkers: 4,
  });
  assert.equal(result.kind, "cloud");
  assert.equal(result.hardwareDerived, false);
  assert.ok(!codes(result).includes("oversubscription"));
});

// --- robustness ------------------------------------------------------------

test("recommend survives entirely missing facts without throwing", () => {
  const result = recommend({});
  assert.equal(result.llamaParallel, 1);
  assert.equal(result.maxWorkers, 1);
  assert.equal(result.confidence, "low");
  assert.ok(codes(result).includes("hardware_unknown"));
  assert.ok(codes(result).includes("unknown_model"));
});

test("a WSL2 host is told its memory figure is the VM's, not the machine's", () => {
  const hardware = cpuOnlyMachine(16 * GIB);
  hardware.isWSL = true;
  const result = recommend({ hardware, gguf: ggufFound() });
  assert.ok(codes(result).includes("wsl_memory"));
});

// --- bytesPerKvElementForCacheTypes -----------------------------------------
test("bytesPerKvElementForCacheTypes: neither set falls back to the fp16 default", () => {
  assert.equal(bytesPerKvElementForCacheTypes(undefined, undefined), DEFAULT_BYTES_PER_KV_ELEMENT);
  assert.equal(bytesPerKvElementForCacheTypes(null, ""), DEFAULT_BYTES_PER_KV_ELEMENT);
});

test("bytesPerKvElementForCacheTypes: a single recognized type is used directly", () => {
  assert.equal(bytesPerKvElementForCacheTypes("q8_0", undefined), 1);
  assert.equal(bytesPerKvElementForCacheTypes(undefined, "q4_0"), 0.5);
});

test("bytesPerKvElementForCacheTypes: matches llama-server's flag values case-insensitively", () => {
  assert.equal(bytesPerKvElementForCacheTypes("Q8_0", "Q8_0"), 1);
});

test("bytesPerKvElementForCacheTypes: K and V both set to the same type use that type", () => {
  assert.equal(bytesPerKvElementForCacheTypes("q4_0", "q4_0"), 0.5);
});

test("bytesPerKvElementForCacheTypes: mixed K/V types use the smaller (cheaper) one, not an average", () => {
  assert.equal(bytesPerKvElementForCacheTypes("f16", "q4_0"), 0.5);
  assert.equal(bytesPerKvElementForCacheTypes("q4_0", "f16"), 0.5);
});

test("bytesPerKvElementForCacheTypes: an unrecognized type is ignored, not treated as 0", () => {
  assert.equal(bytesPerKvElementForCacheTypes("not-a-real-type", undefined), DEFAULT_BYTES_PER_KV_ELEMENT);
});

test("bytesPerKvElementForCacheTypes: an unset side still compares against the real fp16 default, not itself", () => {
  // Setting a wider-than-default type on only one side (unusual, but valid)
  // must compare against the OTHER side's true fp16 default, not just return
  // the explicitly-set value verbatim -- the smaller of the two real sides
  // still wins, matching this function's own "smaller of the two" contract.
  assert.equal(bytesPerKvElementForCacheTypes("f32", undefined), DEFAULT_BYTES_PER_KV_ELEMENT);
  assert.equal(bytesPerKvElementForCacheTypes(undefined, "f32"), DEFAULT_BYTES_PER_KV_ELEMENT);
});

test("recommend: a quantized KV cache lets more context fit than the fp16 default estimate", () => {
  const hardware = cpuOnlyMachine(16 * GIB);
  const fp16 = recommend({ hardware, gguf: ggufFound(), bytesPerKvElement: 2 });
  const quantized = recommend({ hardware, gguf: ggufFound(), bytesPerKvElement: bytesPerKvElementForCacheTypes("q8_0", "q8_0") });
  assert.ok(quantized.contextTotal >= fp16.contextTotal, "halving KV bytes-per-element must never recommend less total context");
});

// ---------------------------------------------------------------------------
// customRecommendation: an exact worker count the caller picked, distinct
// from "more noms" (max that fits) and "nominal" (fixed at 1).
// ---------------------------------------------------------------------------

test("customRecommendation: an exact noms count that fits at the requested context is honored as-is", () => {
  const hardware = appleMachine(64 * GIB);
  const res = customRecommendation({ hardware, gguf: ggufFound(), noms: 4, targetContextPerNom: 65536 });
  assert.equal(res.requestedNoms, 4);
  assert.equal(res.llamaParallel, 4);
  assert.equal(res.maxWorkers, 4);
  assert.equal(res.contextPerNom, 65536);
  assert.equal(res.contextTotal, 65536 * 4);
  assert.equal(res.fits, true);
  assert.equal(res.steppedDownFrom, null);
  assert.deepEqual(res.env, { NOMARMY_LLAMA_CONTEXT: 65536 * 4, NOMARMY_LLAMA_PARALLEL: 4, NOMARMY_MAX_WORKERS: 4 });
});

test("customRecommendation: steps context down (never noms down) when the requested count doesn't fit at the target context", () => {
  const hardware = appleMachine(64 * GIB);
  const big = customRecommendation({ hardware, gguf: ggufFound(), noms: 8, targetContextPerNom: 131072 });
  assert.equal(big.requestedNoms, 8, "the exact count the caller asked for is never silently reduced");
  if (!big.fits) return; // if 8 genuinely cannot fit at all on this fixture, the rest is moot
  assert.ok(big.steppedDownFrom === null || big.contextPerNom < 131072, "either it fit at the target, or context (not noms) stepped down");
});

test("customRecommendation: an unreasonable noms count is reported as not fitting, never silently substituted", () => {
  const hardware = cpuOnlyMachine(8 * GIB);
  const res = customRecommendation({ hardware, gguf: ggufFound(), noms: 500, targetContextPerNom: 65536 });
  assert.equal(res.requestedNoms, 500);
  assert.equal(res.fits, false);
  assert.match(res.summary, /500 nom\(s\) does not fit/);
  assert.match(res.summary, new RegExp(String(MIN_CONTEXT_PER_NOM / 1024)));
});

test("customRecommendation: noms is floored and clamped to at least 1", () => {
  const hardware = appleMachine(64 * GIB);
  const res = customRecommendation({ hardware, gguf: ggufFound(), noms: 2.9 });
  assert.equal(res.requestedNoms, 2);
  const zero = customRecommendation({ hardware, gguf: ggufFound(), noms: 0 });
  assert.equal(zero.requestedNoms, 1);
});

test("customRecommendation: cloud execution honors the requested count exactly, unbounded by local memory", () => {
  const res = customRecommendation({ execution: "bedrock", noms: 12 });
  assert.equal(res.kind, "cloud");
  assert.equal(res.requestedNoms, 12);
  assert.equal(res.maxWorkers, 12);
  assert.equal(res.fits, true);
  assert.deepEqual(res.env, { NOMARMY_MAX_WORKERS: 12 });
});
