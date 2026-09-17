// Minimal GGUF header reader (v1.3).
//
// The accurate way to size a KV cache is the model's own architecture, and a
// GGUF file states it in its header. This reader parses *only* the header
// key/value block. It never reads tensor data, never memory-maps the file, and
// never loads weights.
//
// Layout (little-endian):
//   magic            4 bytes  "GGUF"
//   version          u32      1, 2 or 3
//   tensor_count     u64      (u32 in version 1)
//   metadata_kv_cnt  u64      (u32 in version 1)
//   then metadata_kv_cnt records of:
//     key            gguf_string  (u64 length + raw bytes, u32 length in v1)
//     value_type     u32          (see GGUF_TYPE)
//     value          typed
//
// Defensive posture: a fresh nomArmy install has no model downloaded yet. That
// is the common case, not an error. Anything unreadable, absent or malformed
// returns `{ found: false, ... }` with a reason; this function never throws.

import fs from "node:fs";

/** GGUF metadata value types. */
export const GGUF_TYPE = Object.freeze({
  UINT8: 0,
  INT8: 1,
  UINT16: 2,
  INT16: 3,
  UINT32: 4,
  INT32: 5,
  FLOAT32: 6,
  BOOL: 7,
  STRING: 8,
  ARRAY: 9,
  UINT64: 10,
  INT64: 11,
  FLOAT64: 12,
});

const SCALAR_SIZE = Object.freeze({
  0: 1, // UINT8
  1: 1, // INT8
  2: 2, // UINT16
  3: 2, // INT16
  4: 4, // UINT32
  5: 4, // INT32
  6: 4, // FLOAT32
  7: 1, // BOOL
  10: 8, // UINT64
  11: 8, // INT64
  12: 8, // FLOAT64
});

/** How far into the file we are willing to walk before giving up. */
export const DEFAULT_HEADER_BYTE_LIMIT = 64 * 1024 * 1024;
/** Sliding window used for the small reads (keys, scalars, short strings). */
const WINDOW_BYTES = 256 * 1024;
/** A single string longer than this is treated as malformed rather than read. */
const MAX_STRING_BYTES = 4 * 1024 * 1024;
/** Guard rails against a corrupt header claiming absurd counts. */
const MAX_KV_COUNT = 1_000_000;
const MAX_TENSOR_COUNT = 10_000_000;
const MAX_ARRAY_DEPTH = 4;

/** Thrown internally when the header runs past the byte limit or file end. */
class TruncatedHeader extends Error {
  constructor(message) {
    super(message);
    this.name = "TruncatedHeader";
  }
}

/** Thrown internally when the bytes do not describe a valid GGUF header. */
class MalformedHeader extends Error {
  constructor(message) {
    super(message);
    this.name = "MalformedHeader";
  }
}

/**
 * A bounded forward cursor over a file descriptor. It keeps a small window in
 * memory and can `skip` arbitrarily large regions (vocabulary arrays run to
 * megabytes) without ever holding them.
 */
class Cursor {
  /**
   * @param {number} fd
   * @param {number} fileSize
   * @param {number} limit absolute offset we refuse to read past
   */
  constructor(fd, fileSize, limit) {
    this.fd = fd;
    this.fileSize = fileSize;
    this.limit = Math.min(limit, fileSize);
    this.pos = 0;
    this.window = Buffer.alloc(0);
    this.windowStart = 0;
  }

  /** Ensure `n` bytes from the current position are in the window. */
  ensure(n) {
    if (n > WINDOW_BYTES) {
      throw new MalformedHeader(`refusing to buffer ${n} bytes for a single field`);
    }
    if (this.pos + n > this.limit) {
      throw new TruncatedHeader(
        `header field at offset ${this.pos} extends past the ${this.limit}-byte read limit`,
      );
    }
    const end = this.windowStart + this.window.length;
    if (this.pos >= this.windowStart && this.pos + n <= end) return;
    const want = Math.min(WINDOW_BYTES, this.fileSize - this.pos);
    const buf = Buffer.alloc(want);
    const read = fs.readSync(this.fd, buf, 0, want, this.pos);
    this.window = buf.subarray(0, read);
    this.windowStart = this.pos;
    if (read < n) {
      throw new TruncatedHeader(`short read at offset ${this.pos}`);
    }
  }

  /** Advance without reading. Used to step over tensor-free bulk arrays. */
  skip(n) {
    if (n < 0) throw new MalformedHeader(`negative skip (${n})`);
    if (this.pos + n > this.limit) {
      throw new TruncatedHeader(
        `skipping ${n} bytes from ${this.pos} would pass the ${this.limit}-byte read limit`,
      );
    }
    this.pos += n;
  }

  slice(n) {
    this.ensure(n);
    const offset = this.pos - this.windowStart;
    const out = this.window.subarray(offset, offset + n);
    this.pos += n;
    return out;
  }

  u8() {
    return this.slice(1).readUInt8(0);
  }

  u32() {
    return this.slice(4).readUInt32LE(0);
  }

  /** u64 as a Number, rejecting values that would lose precision. */
  u64() {
    const value = this.slice(8).readBigUInt64LE(0);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new MalformedHeader(`64-bit length ${value} exceeds the safe integer range`);
    }
    return Number(value);
  }
}

/**
 * GGUF v1 used 32-bit lengths and counts; v2 and v3 use 64-bit.
 *
 * @param {Cursor} cur
 * @param {number} version
 */
function readLength(cur, version) {
  return version === 1 ? cur.u32() : cur.u64();
}

function readString(cur, version) {
  const len = readLength(cur, version);
  if (len > MAX_STRING_BYTES) {
    throw new MalformedHeader(`string length ${len} is implausible for a header field`);
  }
  if (len === 0) return "";
  // Long strings still have to be read whole, so chunk them through the window.
  if (len <= WINDOW_BYTES) {
    return cur.slice(len).toString("utf8");
  }
  const parts = [];
  let remaining = len;
  while (remaining > 0) {
    const take = Math.min(remaining, WINDOW_BYTES);
    parts.push(Buffer.from(cur.slice(take)));
    remaining -= take;
  }
  return Buffer.concat(parts).toString("utf8");
}

/**
 * Read one typed value. Scalars and strings are returned; arrays are skipped
 * (we never need their contents) but must be stepped over exactly, otherwise
 * every subsequent key is garbage.
 *
 * @returns {{ value: unknown, kind: "scalar"|"string"|"array" }}
 */
function readValue(cur, type, version, depth = 0) {
  switch (type) {
    case GGUF_TYPE.UINT8:
      return { value: cur.u8(), kind: "scalar" };
    case GGUF_TYPE.INT8:
      return { value: cur.slice(1).readInt8(0), kind: "scalar" };
    case GGUF_TYPE.UINT16:
      return { value: cur.slice(2).readUInt16LE(0), kind: "scalar" };
    case GGUF_TYPE.INT16:
      return { value: cur.slice(2).readInt16LE(0), kind: "scalar" };
    case GGUF_TYPE.UINT32:
      return { value: cur.u32(), kind: "scalar" };
    case GGUF_TYPE.INT32:
      return { value: cur.slice(4).readInt32LE(0), kind: "scalar" };
    case GGUF_TYPE.FLOAT32:
      return { value: cur.slice(4).readFloatLE(0), kind: "scalar" };
    case GGUF_TYPE.BOOL:
      return { value: cur.u8() !== 0, kind: "scalar" };
    case GGUF_TYPE.UINT64:
      return { value: cur.u64(), kind: "scalar" };
    case GGUF_TYPE.INT64: {
      const raw = cur.slice(8).readBigInt64LE(0);
      return { value: Number(raw), kind: "scalar" };
    }
    case GGUF_TYPE.FLOAT64:
      return { value: cur.slice(8).readDoubleLE(0), kind: "scalar" };
    case GGUF_TYPE.STRING:
      return { value: readString(cur, version), kind: "string" };
    case GGUF_TYPE.ARRAY: {
      if (depth >= MAX_ARRAY_DEPTH) {
        throw new MalformedHeader("array nesting is deeper than this reader allows");
      }
      const elemType = cur.u32();
      const count = readLength(cur, version);
      skipArrayElements(cur, elemType, count, version, depth + 1);
      return { value: { elementType: elemType, length: count }, kind: "array" };
    }
    default:
      // An unknown value type means we can no longer compute where the next key
      // begins. Stopping is the honest outcome; guessing is not.
      throw new MalformedHeader(`unknown GGUF value type ${type}`);
  }
}

function skipArrayElements(cur, elemType, count, version, depth) {
  const size = SCALAR_SIZE[elemType];
  if (size !== undefined) {
    cur.skip(size * count);
    return;
  }
  if (elemType === GGUF_TYPE.STRING) {
    // Variable-length: each element carries its own length prefix.
    for (let i = 0; i < count; i += 1) {
      const len = readLength(cur, version);
      if (len > MAX_STRING_BYTES) {
        throw new MalformedHeader(`array string length ${len} is implausible`);
      }
      cur.skip(len);
    }
    return;
  }
  if (elemType === GGUF_TYPE.ARRAY) {
    for (let i = 0; i < count; i += 1) {
      readValue(cur, GGUF_TYPE.ARRAY, version, depth);
    }
    return;
  }
  throw new MalformedHeader(`unknown GGUF array element type ${elemType}`);
}

/** Keys we care about, matched by suffix so they work for any architecture. */
const WANTED_SUFFIXES = Object.freeze({
  ".block_count": "blockCount",
  ".attention.head_count_kv": "headCountKv",
  ".attention.head_count": "headCount",
  ".attention.key_length": "keyLength",
  ".attention.value_length": "valueLength",
  ".embedding_length": "embeddingLength",
  ".context_length": "contextLength",
});

function matchWanted(key) {
  // Longest suffix first, so `.attention.head_count_kv` is not stolen by
  // `.attention.head_count`.
  const suffixes = Object.keys(WANTED_SUFFIXES).sort((a, b) => b.length - a.length);
  for (const suffix of suffixes) {
    if (key.endsWith(suffix)) return WANTED_SUFFIXES[suffix];
  }
  return null;
}

function numeric(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Read the architecture facts out of a GGUF file's header.
 *
 * @param {string} filePath
 * @param {{ headerByteLimit?: number }} [options]
 * @returns {{
 *   found: boolean,
 *   path: string|null,
 *   fileSizeBytes: number|null,
 *   arch: string|null,
 *   params: object,
 *   truncated: boolean,
 *   version: number|null,
 *   kvCount: number|null,
 *   tensorCount: number|null,
 *   general: object,
 *   reason: string|null
 * }}
 */
export function readGGUFMetadata(filePath, options = {}) {
  const limit = Number.isFinite(options.headerByteLimit)
    ? options.headerByteLimit
    : DEFAULT_HEADER_BYTE_LIMIT;

  const result = {
    found: false,
    path: typeof filePath === "string" ? filePath : null,
    fileSizeBytes: null,
    arch: null,
    params: {
      blockCount: null,
      headCount: null,
      headCountKv: null,
      keyLength: null,
      valueLength: null,
      embeddingLength: null,
      contextLength: null,
    },
    truncated: false,
    version: null,
    kvCount: null,
    tensorCount: null,
    general: { name: null, fileType: null, sizeLabel: null },
    reason: null,
  };

  if (typeof filePath !== "string" || filePath.length === 0) {
    result.reason = "no model path supplied";
    return result;
  }

  let fd = null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      result.reason = "path is not a regular file";
      return result;
    }
    result.fileSizeBytes = stat.size;

    fd = fs.openSync(filePath, "r");
    const cur = new Cursor(fd, stat.size, limit);

    const magic = cur.slice(4).toString("latin1");
    if (magic !== "GGUF") {
      result.reason = `not a GGUF file (magic ${JSON.stringify(magic)})`;
      return result;
    }
    const version = cur.u32();
    if (!Number.isFinite(version) || version < 1 || version > 3) {
      result.reason = `unsupported GGUF version ${version}`;
      return result;
    }
    result.version = version;

    const tensorCount = readLength(cur, version);
    const kvCount = readLength(cur, version);
    if (tensorCount > MAX_TENSOR_COUNT || kvCount > MAX_KV_COUNT) {
      result.reason = `implausible header counts (tensors=${tensorCount}, kv=${kvCount})`;
      return result;
    }
    result.tensorCount = tensorCount;
    result.kvCount = kvCount;

    // From here the file is a GGUF: whatever we manage to read is real, and
    // anything we cannot read is reported as `truncated`, not as "not found".
    result.found = true;

    const collected = Object.create(null);
    for (let i = 0; i < kvCount; i += 1) {
      const key = readString(cur, version);
      const type = cur.u32();
      const { value } = readValue(cur, type, version);

      if (key === "general.architecture" && typeof value === "string") {
        result.arch = value;
      } else if (key === "general.name" && typeof value === "string") {
        result.general.name = value;
      } else if (key === "general.size_label" && typeof value === "string") {
        result.general.sizeLabel = value;
      } else if (key === "general.file_type") {
        result.general.fileType = numeric(value);
      } else {
        const field = matchWanted(key);
        if (field && numeric(value) !== null) {
          // Prefer keys that belong to the declared architecture; a stray
          // `<other>.block_count` must not overwrite the real one.
          const archPrefixed = result.arch && key.startsWith(`${result.arch}.`);
          if (collected[field] === undefined || archPrefixed) {
            collected[field] = numeric(value);
          }
        }
      }
    }
    Object.assign(result.params, collected);
    return result;
  } catch (err) {
    if (err instanceof TruncatedHeader) {
      result.truncated = true;
      result.reason = err.message;
      return result;
    }
    if (err instanceof MalformedHeader) {
      result.reason = err.message;
      // A malformed header after a valid magic means the numbers we did read
      // cannot be trusted to be complete; say so rather than silently shipping
      // half an architecture.
      result.truncated = result.found;
      return result;
    }
    result.found = false;
    result.reason = String(err && err.message ? err.message : err);
    return result;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* closing a descriptor we already hold cannot usefully fail here */
      }
    }
  }
}

/**
 * Derive the per-head dimension from whatever the header gave us.
 * `key_length` is authoritative when present; otherwise fall back to
 * embedding_length / head_count.
 *
 * @param {object} params
 * @returns {{ headDim: number|null, source: string|null }}
 */
export function deriveHeadDim(params) {
  if (!params) return { headDim: null, source: null };
  if (numeric(params.keyLength)) {
    return { headDim: params.keyLength, source: "attention.key_length" };
  }
  if (numeric(params.embeddingLength) && numeric(params.headCount) && params.headCount > 0) {
    return {
      headDim: Math.floor(params.embeddingLength / params.headCount),
      source: "embedding_length / attention.head_count",
    };
  }
  return { headDim: null, source: null };
}

export default { readGGUFMetadata, deriveHeadDim, GGUF_TYPE };
