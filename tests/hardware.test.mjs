// Tests for lib/hardware.mjs and lib/gguf.mjs.
//
// The parsers are pure and are tested against captured output. `detectHardware()`
// itself is tested for the contract that matters: it never throws, and whatever
// it could not measure is null rather than invented.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  GIB,
  MIB,
  detectHardware,
  looksLikeWSL,
  parsePodmanMemTotal,
  parseNvidiaSmiMemoryCsv,
  parseProcCpuinfoPhysicalCores,
  parseProcMeminfoBytes,
  parseVmStatBytes,
} from "../lib/hardware.mjs";

import { deriveHeadDim, readGGUFMetadata, findGgufFiles, resolveModelPath, totalSplitBytes } from "../lib/gguf.mjs";

// --- nvidia-smi ------------------------------------------------------------

test("parses nvidia-smi memory CSV (MiB) into bytes", () => {
  const gpus = parseNvidiaSmiMemoryCsv("81920, 80112\n81920, 81000\n");
  assert.equal(gpus.length, 2);
  assert.equal(gpus[0].totalVramBytes, 81920 * MIB);
  assert.equal(gpus[0].freeVramBytes, 80112 * MIB);
  assert.equal(gpus[0].vendor, "nvidia");
  assert.equal(gpus[1].index, 1);
});

test("nvidia-smi parsing tolerates junk, blank lines and [N/A]", () => {
  assert.deepEqual(parseNvidiaSmiMemoryCsv(""), []);
  assert.deepEqual(parseNvidiaSmiMemoryCsv("\n\n"), []);
  assert.deepEqual(parseNvidiaSmiMemoryCsv("no devices were found"), []);
  assert.deepEqual(parseNvidiaSmiMemoryCsv(undefined), []);
  const partial = parseNvidiaSmiMemoryCsv("16384, [N/A]");
  assert.equal(partial.length, 1);
  assert.equal(partial[0].totalVramBytes, 16384 * MIB);
  assert.equal(partial[0].freeVramBytes, null, "unknown must be null, not zero");
});

// --- /proc parsing ---------------------------------------------------------

test("counts physical cores from /proc/cpuinfo hyperthread pairs", () => {
  const cpuinfo = [
    "processor\t: 0\nphysical id\t: 0\ncore id\t\t: 0\n",
    "processor\t: 1\nphysical id\t: 0\ncore id\t\t: 1\n",
    "processor\t: 2\nphysical id\t: 0\ncore id\t\t: 0\n",
    "processor\t: 3\nphysical id\t: 0\ncore id\t\t: 1\n",
  ].join("\n");
  assert.equal(parseProcCpuinfoPhysicalCores(cpuinfo), 2);
});

test("physical core count is null when /proc/cpuinfo omits the fields", () => {
  // Typical of ARM SoCs and of containers.
  assert.equal(parseProcCpuinfoPhysicalCores("processor\t: 0\nBogoMIPS\t: 50.00\n"), null);
  assert.equal(parseProcCpuinfoPhysicalCores(""), null);
  assert.equal(parseProcCpuinfoPhysicalCores(null), null);
});

test("reads MemAvailable, not MemFree, from /proc/meminfo", () => {
  const meminfo = "MemTotal:       131072000 kB\nMemFree:          512000 kB\nMemAvailable:   98304000 kB\n";
  assert.equal(parseProcMeminfoBytes(meminfo), 98304000 * 1024);
  assert.equal(parseProcMeminfoBytes(meminfo, "MemTotal"), 131072000 * 1024);
  assert.equal(parseProcMeminfoBytes(meminfo, "Nonsense"), null);
  assert.equal(parseProcMeminfoBytes(""), null);
});

// --- vm_stat parsing (Darwin) -----------------------------------------------
//
// os.freemem() on Darwin counts only free+speculative pages, ignoring tens of
// GiB of reclaimable file-backed cache the kernel evicts instantly under
// pressure. parseVmStatBytes sums free+inactive+speculative+purgeable instead,
// mirroring what /proc/meminfo's MemAvailable does on Linux.

const VM_STAT_SAMPLE = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    13008.
Pages active:                                 187220.
Pages inactive:                               185715.
Pages speculative:                              3988.
Pages throttled:                                   0.
Pages wired down:                            3305691.
Pages purgeable:                               19047.
"Translation faults":                      245081780.
Pages copy-on-write:                        15991108.
File-backed pages:                            123309.
Anonymous pages:                              253614.
`;

test("parseVmStatBytes sums free+inactive+speculative+purgeable, scaled by the real page size", () => {
  const bytes = parseVmStatBytes(VM_STAT_SAMPLE);
  const pageSize = 16384;
  assert.equal(bytes, (13008 + 185715 + 3988 + 19047) * pageSize);
});

test("parseVmStatBytes is far larger than free+speculative alone (the freemem() bug)", () => {
  const bytes = parseVmStatBytes(VM_STAT_SAMPLE);
  const freememEquivalent = (13008 + 3988) * 16384;
  assert.ok(bytes > freememEquivalent * 5, "reclaimable-inclusive figure should dwarf the freemem-only figure");
});

test("parseVmStatBytes returns null when the page size line is missing", () => {
  assert.equal(parseVmStatBytes("Pages free: 100.\nPages inactive: 200.\n"), null);
});

test("parseVmStatBytes returns null when a required field is missing", () => {
  const missingPurgeable = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    100.
Pages inactive:                                200.
Pages speculative:                              50.
`;
  assert.equal(parseVmStatBytes(missingPurgeable), null);
});

test("parseVmStatBytes tolerates junk input", () => {
  assert.equal(parseVmStatBytes(""), null);
  assert.equal(parseVmStatBytes(null), null);
  assert.equal(parseVmStatBytes(undefined), null);
});

test("detects WSL2 from the kernel release or /proc/version", () => {
  assert.equal(looksLikeWSL("5.15.153.1-microsoft-standard-WSL2"), true);
  assert.equal(looksLikeWSL("6.1.0-generic", "Linux version 6.1.0 (Microsoft@Microsoft.com)"), true);
  assert.equal(looksLikeWSL("6.8.0-45-generic", "Linux version 6.8.0-45-generic (buildd@lcy02)"), false);
  assert.equal(looksLikeWSL(""), false);
});

test("parses podman info Host.MemTotal", () => {
  assert.equal(parsePodmanMemTotal("16637308928\n"), 16637308928);
  assert.equal(parsePodmanMemTotal("0"), null);
  assert.equal(parsePodmanMemTotal("<no value>"), null);
  assert.equal(parsePodmanMemTotal(undefined), null);
});

// --- detectHardware contract ----------------------------------------------

test("detectHardware() never throws and returns a well-formed facts object", () => {
  let facts;
  assert.doesNotThrow(() => {
    facts = detectHardware();
  });

  assert.equal(facts.platform, process.platform);
  assert.equal(facts.arch, process.arch);
  assert.equal(typeof facts.isWSL, "boolean");
  assert.ok(Array.isArray(facts.probes) && facts.probes.length > 0);

  for (const probe of facts.probes) {
    assert.deepEqual(Object.keys(probe).sort(), ["description", "detail", "error", "name", "ok", "source"]);
    assert.equal(typeof probe.ok, "boolean");
  }

  // Undetermined facts must be null, never a guess and never NaN.
  const nullable = [
    facts.cpu.physicalCores,
    facts.cpu.logicalCores,
    facts.memory.totalBytes,
    facts.memory.availableBytes,
    facts.gpu.totalVramBytes,
    facts.gpu.freeVramBytes,
    facts.podman.totalMemoryBytes,
  ];
  for (const value of nullable) {
    assert.ok(value === null || (typeof value === "number" && Number.isFinite(value) && value > 0));
  }

  assert.ok(Array.isArray(facts.gpu.devices));
  assert.equal(facts.gpu.devices.length, facts.gpu.count);
  assert.ok(["nvidia", "apple", null].includes(facts.gpu.vendor));
});

test("detectHardware() measures the basics that sizing depends on", () => {
  const facts = detectHardware({ skipPodman: true, skipGpu: true });
  assert.ok(facts.memory.totalBytes > 0, "total RAM must be measurable via node:os everywhere");
  assert.ok(facts.cpu.logicalCores >= 1);
  // Skipped probes are recorded as attempted-and-skipped, not silently dropped.
  const gpuProbe = facts.probes.find((p) => p.name === "gpu.nvidia");
  assert.equal(gpuProbe.ok, false);
  assert.match(gpuProbe.detail, /skipped/);
});

test("unified memory is reported only on Apple Silicon", () => {
  const facts = detectHardware({ skipPodman: true, skipGpu: true });
  const expected = process.platform === "darwin" && process.arch === "arm64";
  assert.equal(facts.memory.unified, expected);
  if (!expected) assert.equal(facts.memory.unifiedBytes, null);
});

// --- gguf ------------------------------------------------------------------

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-gguf-"));
  return path.join(dir, name);
}

/** Build a minimal but valid GGUF v3 header in memory. */
function buildGGUF(entries) {
  const chunks = [];
  const str = (s) => {
    const body = Buffer.from(s, "utf8");
    const len = Buffer.alloc(8);
    len.writeBigUInt64LE(BigInt(body.length));
    return Buffer.concat([len, body]);
  };
  const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const u64 = (n) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n));
    return b;
  };

  chunks.push(Buffer.from("GGUF", "latin1"), u32(3), u64(0), u64(entries.length));
  for (const [key, type, value] of entries) {
    chunks.push(str(key), u32(type));
    if (type === 8) chunks.push(str(value));
    else if (type === 4) chunks.push(u32(value));
    else if (type === 9) {
      // array of strings, which is how tokenizer vocabularies are stored
      chunks.push(u32(8), u64(value.length));
      for (const item of value) chunks.push(str(item));
    } else throw new Error(`test builder does not handle type ${type}`);
  }
  return Buffer.concat(chunks);
}

test("reads architecture facts out of a GGUF header", () => {
  const file = tmpFile("model.gguf");
  fs.writeFileSync(
    file,
    Buffer.concat([
      buildGGUF([
        ["general.architecture", 8, "qwen3"],
        ["general.name", 8, "Qwen3 Coder Next"],
        ["tokenizer.ggml.tokens", 9, ["a", "bb", "ccc"]],
        ["qwen3.block_count", 4, 48],
        ["qwen3.attention.head_count", 4, 32],
        ["qwen3.attention.head_count_kv", 4, 4],
        ["qwen3.attention.key_length", 4, 128],
        ["qwen3.attention.value_length", 4, 128],
        ["qwen3.embedding_length", 4, 4096],
        ["qwen3.context_length", 4, 262144],
      ]),
      Buffer.alloc(4096, 7), // stand-in for tensor data, which must not be read
    ]),
  );

  const meta = readGGUFMetadata(file);
  assert.equal(meta.found, true);
  assert.equal(meta.truncated, false);
  assert.equal(meta.arch, "qwen3");
  assert.equal(meta.version, 3);
  assert.equal(meta.params.blockCount, 48);
  assert.equal(meta.params.headCountKv, 4);
  assert.equal(meta.params.headCount, 32);
  assert.equal(meta.params.keyLength, 128);
  assert.equal(meta.params.valueLength, 128);
  assert.equal(meta.params.contextLength, 262144);
  assert.equal(meta.fileSizeBytes, fs.statSync(file).size);
  assert.equal(meta.general.name, "Qwen3 Coder Next");

  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test("a missing model file degrades to found:false, which is the fresh-install case", () => {
  const meta = readGGUFMetadata(path.join(os.tmpdir(), "nomarmy-does-not-exist.gguf"));
  assert.equal(meta.found, false);
  assert.equal(meta.arch, null);
  assert.equal(meta.fileSizeBytes, null);
  assert.ok(typeof meta.reason === "string" && meta.reason.length > 0);
});

test("readGGUFMetadata never throws on absent, empty or malformed input", () => {
  assert.doesNotThrow(() => readGGUFMetadata(null));
  assert.doesNotThrow(() => readGGUFMetadata(""));
  assert.doesNotThrow(() => readGGUFMetadata(os.tmpdir()));
  assert.equal(readGGUFMetadata(null).found, false);
  assert.equal(readGGUFMetadata(os.tmpdir()).found, false, "a directory is not a model");

  const notGguf = tmpFile("weights.bin");
  fs.writeFileSync(notGguf, Buffer.from("PK this is a zip"));
  const meta = readGGUFMetadata(notGguf);
  assert.equal(meta.found, false);
  assert.match(meta.reason, /not a GGUF file/);
  fs.rmSync(path.dirname(notGguf), { recursive: true, force: true });
});

test("a truncated header is reported as truncated, not as a clean read", () => {
  const file = tmpFile("cut.gguf");
  const full = buildGGUF([
    ["general.architecture", 8, "qwen3"],
    ["qwen3.block_count", 4, 48],
    ["qwen3.attention.head_count_kv", 4, 4],
  ]);
  fs.writeFileSync(file, full.subarray(0, full.length - 6));

  const meta = readGGUFMetadata(file);
  assert.equal(meta.found, true, "the magic was valid, so the file is a GGUF");
  assert.equal(meta.truncated, true);
  assert.equal(meta.arch, "qwen3");
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test("the header read is capped, so a huge file is never loaded", () => {
  const file = tmpFile("big.gguf");
  const full = buildGGUF([
    ["general.architecture", 8, "qwen3"],
    ["tokenizer.ggml.tokens", 9, ["a", "b", "c"]],
    ["qwen3.block_count", 4, 48],
  ]);
  fs.writeFileSync(file, Buffer.concat([full, Buffer.alloc(1024, 1)]));

  const capped = readGGUFMetadata(file, { headerByteLimit: 32 });
  assert.equal(capped.truncated, true);
  assert.ok(capped.params.blockCount === null || capped.params.blockCount === 48);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test("head dimension prefers key_length and falls back to embedding/head_count", () => {
  assert.deepEqual(deriveHeadDim({ keyLength: 128, embeddingLength: 4096, headCount: 32 }), {
    headDim: 128,
    source: "attention.key_length",
  });
  assert.equal(deriveHeadDim({ embeddingLength: 4096, headCount: 32 }).headDim, 128);
  assert.equal(deriveHeadDim({}).headDim, null);
  assert.equal(deriveHeadDim(null).headDim, null);
});

// Keep the byte-unit exports honest; the sizing maths depends on them.
test("byte unit constants are binary", () => {
  assert.equal(MIB, 1024 * 1024);
  assert.equal(GIB, 1024 * 1024 * 1024);
});

// ---------------------------------------------------------------------------
// Model discovery: findGgufFiles / resolveModelPath / totalSplitBytes.
//
// llama.cpp's `-hf` pulls land in the real Hugging Face hub cache layout --
// ~/.cache/huggingface/hub/models--<org>--<repo>/snapshots/<hash>/<file>,
// every file a symlink to a blob -- not a flat llama.cpp-specific directory.
// `resolveModelPath` used to only check the latter (and only one directory
// level), so it never found an `-hf`-downloaded model at all and silently
// fell back to an assumed ~18 GiB weight figure regardless of the real model
// loaded. These tests build that real layout in a temp dir and use the
// `roots` override so they never touch this machine's actual model cache.
// ---------------------------------------------------------------------------
function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-model-cache-"));
}

/** Write `content` to a real "blob" file and return a symlink to it, mirroring how the HF hub cache stores every file. */
function writeBlobAndLink(root, snapshotDir, linkName, sizeBytes) {
  const blobsDir = path.join(root, "blobs");
  fs.mkdirSync(blobsDir, { recursive: true });
  const blobPath = path.join(blobsDir, `blob-${linkName}-${sizeBytes}`);
  fs.writeFileSync(blobPath, Buffer.alloc(sizeBytes, 1));
  fs.mkdirSync(snapshotDir, { recursive: true });
  const linkPath = path.join(snapshotDir, linkName);
  fs.symlinkSync(blobPath, linkPath);
  return linkPath;
}

test("findGgufFiles walks nested directories and follows symlinks (the HF cache shape)", () => {
  const root = tmpRoot();
  try {
    const snapshotDir = path.join(root, "models--Qwen--Qwen3-Coder-Next-GGUF", "snapshots", "abc123", "Qwen3-Coder-Next-Q4_K_M");
    writeBlobAndLink(root, snapshotDir, "model-00001-of-00002.gguf", 1024);
    writeBlobAndLink(root, snapshotDir, "model-00002-of-00002.gguf", 1024);
    fs.writeFileSync(path.join(snapshotDir, "README.md"), "not a model");

    const found = findGgufFiles(root).map((f) => path.basename(f.path)).sort();
    assert.deepEqual(found, ["model-00001-of-00002.gguf", "model-00002-of-00002.gguf"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("findGgufFiles skips a broken symlink instead of throwing", () => {
  const root = tmpRoot();
  try {
    fs.symlinkSync(path.join(root, "nowhere"), path.join(root, "dangling.gguf"));
    assert.doesNotThrow(() => findGgufFiles(root));
    assert.deepEqual(findGgufFiles(root), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("resolveModelPath: an explicit path wins over discovery entirely", () => {
  const result = resolveModelPath({ explicit: "/some/explicit/model.gguf", roots: ["/should/not/be/scanned"] });
  assert.equal(result, "/some/explicit/model.gguf");
});

test("resolveModelPath: finds a model nested under a nested HF-cache-shaped root", () => {
  const root = tmpRoot();
  try {
    const snapshotDir = path.join(root, "models--ggml-org--gpt-oss-20b-GGUF", "snapshots", "def456");
    const linkPath = writeBlobAndLink(root, snapshotDir, "gpt-oss-20b.gguf", 2048);

    const result = resolveModelPath({ roots: [root] });
    assert.equal(result, linkPath);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("resolveModelPath: a split model resolves to shard 1, not a later shard", () => {
  const root = tmpRoot();
  try {
    const snapshotDir = path.join(root, "models--Qwen--Qwen3-Coder-Next-GGUF", "snapshots", "abc123", "Qwen3-Coder-Next-Q4_K_M");
    writeBlobAndLink(root, snapshotDir, "Qwen3-Coder-Next-Q4_K_M-00002-of-00004.gguf", 1024);
    writeBlobAndLink(root, snapshotDir, "Qwen3-Coder-Next-Q4_K_M-00001-of-00004.gguf", 1024);
    writeBlobAndLink(root, snapshotDir, "Qwen3-Coder-Next-Q4_K_M-00003-of-00004.gguf", 1024);
    writeBlobAndLink(root, snapshotDir, "Qwen3-Coder-Next-Q4_K_M-00004-of-00004.gguf", 1024);

    const result = resolveModelPath({ roots: [root] });
    assert.match(path.basename(result), /-00001-of-00004\.gguf$/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("resolveModelPath: among unrelated candidates, the most recently touched one wins", () => {
  const root = tmpRoot();
  try {
    const older = writeBlobAndLink(root, path.join(root, "models--a--a", "snapshots", "1"), "old.gguf", 16);
    fs.utimesSync(older, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const newer = writeBlobAndLink(root, path.join(root, "models--b--b", "snapshots", "1"), "new.gguf", 16);

    assert.equal(resolveModelPath({ roots: [root] }), newer);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("resolveModelPath: NOMARMY_MODEL_PATH pointing straight at a .gguf file is used as-is", () => {
  const root = tmpRoot();
  try {
    const file = path.join(root, "direct.gguf");
    fs.writeFileSync(file, Buffer.alloc(16));
    assert.equal(resolveModelPath({ env: { NOMARMY_MODEL_PATH: file }, roots: [file] }), file);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("resolveModelPath: no candidates anywhere returns null, not a throw", () => {
  const root = tmpRoot();
  try {
    assert.equal(resolveModelPath({ roots: [root, path.join(root, "does-not-exist")] }), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("totalSplitBytes: sums every shard's real size for a split model", () => {
  const root = tmpRoot();
  try {
    const dir = path.join(root, "snap");
    fs.mkdirSync(dir, { recursive: true });
    const sizes = [100, 200, 150];
    sizes.forEach((size, i) => {
      fs.writeFileSync(path.join(dir, `m-0000${i + 1}-of-00003.gguf`), Buffer.alloc(size));
    });
    const total = totalSplitBytes(path.join(dir, "m-00001-of-00003.gguf"));
    assert.equal(total, sizes.reduce((a, b) => a + b, 0));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("totalSplitBytes: a non-split filename just returns its own size", () => {
  const root = tmpRoot();
  try {
    const file = path.join(root, "single.gguf");
    fs.writeFileSync(file, Buffer.alloc(777));
    assert.equal(totalSplitBytes(file), 777);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("totalSplitBytes: an incomplete shard set falls back to shard 1's own size rather than throwing", () => {
  const root = tmpRoot();
  try {
    const dir = path.join(root, "snap");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "m-00001-of-00003.gguf"), Buffer.alloc(500));
    // shards 2 and 3 are missing -- an interrupted download
    assert.doesNotThrow(() => totalSplitBytes(path.join(dir, "m-00001-of-00003.gguf")));
    assert.equal(totalSplitBytes(path.join(dir, "m-00001-of-00003.gguf")), 500);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
