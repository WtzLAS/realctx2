/**
 * Late-interaction math (§9.2.3): MaxSim, int8 and 1-bit quantization, token pooling, and
 * MUVERA fixed-dimensional encodings (FDE) for first-stage candidate generation.
 */
import type { TokenMatrix } from "../core/types.ts";

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

/** MaxSim: each query vector takes its best match among the document's vectors; matches are summed. */
export function maxSim(query: TokenMatrix, doc: TokenMatrix): number {
  let total = 0;
  for (const q of query) {
    let best = -Infinity;
    for (const d of doc) {
      const s = dot(q, d);
      if (s > best) best = s;
    }
    if (best > -Infinity) total += best;
  }
  return total;
}

/** MaxSim divided by the number of query tokens: comparable across query lengths, in [-1, 1]. */
export function normalizedMaxSim(query: TokenMatrix, doc: TokenMatrix): number {
  return query.length === 0 || doc.length === 0 ? 0 : maxSim(query, doc) / query.length;
}

/** Symmetric normalized MaxSim, used for de-duplication (§6.3.2 step 8). */
export function symmetricMaxSim(a: TokenMatrix, b: TokenMatrix): number {
  return (normalizedMaxSim(a, b) + normalizedMaxSim(b, a)) / 2;
}

// ───────────────────────────── Quantization

export type Quant = "float32" | "int8" | "binary";

export interface PackedMatrix {
  quant: Quant;
  rows: number;
  dims: number;
  data: Uint8Array;
}

export function packMatrix(m: TokenMatrix, quant: Quant): PackedMatrix {
  const rows = m.length;
  const dims = rows ? m[0]!.length : 0;
  if (quant === "float32") {
    const f = new Float32Array(rows * dims);
    m.forEach((r, i) => f.set(r, i * dims));
    return { quant, rows, dims, data: new Uint8Array(f.buffer) };
  }
  if (quant === "int8") {
    const out = new Int8Array(rows * dims);
    m.forEach((r, i) => {
      for (let j = 0; j < dims; j++) out[i * dims + j] = Math.max(-127, Math.min(127, Math.round(r[j]! * 127)));
    });
    return { quant, rows, dims, data: new Uint8Array(out.buffer) };
  }
  const bytes = Math.ceil(dims / 8);
  const out = new Uint8Array(rows * bytes);
  m.forEach((r, i) => {
    for (let j = 0; j < dims; j++) if (r[j]! > 0) out[i * bytes + (j >> 3)]! |= 1 << (j & 7);
  });
  return { quant, rows, dims, data: out };
}

export function unpackMatrix(p: PackedMatrix): TokenMatrix {
  const out: Float32Array[] = [];
  const { rows, dims } = p;
  if (p.quant === "float32") {
    const f = new Float32Array(p.data.buffer.slice(p.data.byteOffset, p.data.byteOffset + rows * dims * 4));
    for (let i = 0; i < rows; i++) out.push(f.subarray(i * dims, (i + 1) * dims));
    return out;
  }
  if (p.quant === "int8") {
    const q = new Int8Array(p.data.buffer, p.data.byteOffset, rows * dims);
    for (let i = 0; i < rows; i++) {
      const r = new Float32Array(dims);
      for (let j = 0; j < dims; j++) r[j] = q[i * dims + j]! / 127;
      out.push(r);
    }
    return out;
  }
  // binary rows are reconstructed as ±1/√d so a float query can be scored asymmetrically
  const bytes = Math.ceil(dims / 8);
  const mag = 1 / Math.sqrt(dims || 1);
  for (let i = 0; i < rows; i++) {
    const r = new Float32Array(dims);
    for (let j = 0; j < dims; j++) r[j] = p.data[i * bytes + (j >> 3)]! & (1 << (j & 7)) ? mag : -mag;
    out.push(r);
  }
  return out;
}

/** Normalized MaxSim of a float query against a packed document, without unpacking it. */
export function maxSimPacked(query: TokenMatrix, p: PackedMatrix): number {
  const { rows, dims } = p;
  if (!query.length || !rows) return 0;
  const dims4 = dims & ~3;
  let total = 0;
  if (p.quant === "int8") {
    const d = new Int8Array(p.data.buffer, p.data.byteOffset, rows * dims);
    for (let qi = 0; qi < query.length; qi++) {
      const q = query[qi]!;
      let best = -Infinity;
      for (let i = 0, off = 0; i < rows; i++, off += dims) {
        let s = 0;
        let j = 0;
        for (; j < dims4; j += 4) {
          s += q[j]! * d[off + j]! + q[j + 1]! * d[off + j + 1]! + q[j + 2]! * d[off + j + 2]! + q[j + 3]! * d[off + j + 3]!;
        }
        for (; j < dims; j++) s += q[j]! * d[off + j]!;
        if (s > best) best = s;
      }
      total += best / 127;
    }
    return total / query.length;
  }
  if (p.quant === "float32") {
    const aligned = p.data.byteOffset % 4 === 0 ? new Float32Array(p.data.buffer, p.data.byteOffset, rows * dims) : new Float32Array(p.data.buffer.slice(p.data.byteOffset, p.data.byteOffset + rows * dims * 4));
    for (let qi = 0; qi < query.length; qi++) {
      const q = query[qi]!;
      let best = -Infinity;
      for (let i = 0, off = 0; i < rows; i++, off += dims) {
        let s = 0;
        let j = 0;
        for (; j < dims4; j += 4) {
          s += q[j]! * aligned[off + j]! + q[j + 1]! * aligned[off + j + 1]! + q[j + 2]! * aligned[off + j + 2]! + q[j + 3]! * aligned[off + j + 3]!;
        }
        for (; j < dims; j++) s += q[j]! * aligned[off + j]!;
        if (s > best) best = s;
      }
      total += best;
    }
    return total / query.length;
  }
  const bytes = Math.ceil(dims / 8);
  const mag = 1 / Math.sqrt(dims || 1);
  for (let qi = 0; qi < query.length; qi++) {
    const q = query[qi]!;
    let sum = 0;
    for (let j = 0; j < dims; j++) sum += q[j]!;
    let best = -Infinity;
    for (let i = 0; i < rows; i++) {
      // Σ ±q_j = 2·Σ_{bit set} q_j − Σ q_j
      let pos = 0;
      const off = i * bytes;
      for (let j = 0; j < dims; j++) if (p.data[off + (j >> 3)]! & (1 << (j & 7))) pos += q[j]!;
      const s = (2 * pos - sum) * mag;
      if (s > best) best = s;
    }
    total += best;
  }
  return total / query.length;
}

/**
 * Single-pass symmetric normalized MaxSim between a float TokenMatrix and a PackedMatrix.
 * Computes both directions in one dot-product pass with zero unpacking or repacking.
 */
export function symmetricMaxSimWithPacked(query: TokenMatrix, p: PackedMatrix): number {
  const qRows = query.length;
  const { rows, dims } = p;
  if (!qRows || !rows) return 0;
  const dims4 = dims & ~3;
  const colBest = new Float64Array(rows);
  colBest.fill(-Infinity);
  let rowSum = 0;
  if (p.quant === "int8") {
    const d = new Int8Array(p.data.buffer, p.data.byteOffset, rows * dims);
    for (let qi = 0; qi < qRows; qi++) {
      const q = query[qi]!;
      let best = -Infinity;
      for (let i = 0, off = 0; i < rows; i++, off += dims) {
        let s = 0;
        let j = 0;
        for (; j < dims4; j += 4) {
          s += q[j]! * d[off + j]! + q[j + 1]! * d[off + j + 1]! + q[j + 2]! * d[off + j + 2]! + q[j + 3]! * d[off + j + 3]!;
        }
        for (; j < dims; j++) s += q[j]! * d[off + j]!;
        if (s > best) best = s;
        if (s > colBest[i]!) colBest[i] = s;
      }
      rowSum += best;
    }
    let colSum = 0;
    for (let i = 0; i < rows; i++) colSum += colBest[i]!;
    return (rowSum / (qRows * 127) + colSum / (rows * 127)) / 2;
  }
  if (p.quant === "float32") {
    const aligned = p.data.byteOffset % 4 === 0 ? new Float32Array(p.data.buffer, p.data.byteOffset, rows * dims) : new Float32Array(p.data.buffer.slice(p.data.byteOffset, p.data.byteOffset + rows * dims * 4));
    for (let qi = 0; qi < qRows; qi++) {
      const q = query[qi]!;
      let best = -Infinity;
      for (let i = 0, off = 0; i < rows; i++, off += dims) {
        let s = 0;
        let j = 0;
        for (; j < dims4; j += 4) {
          s += q[j]! * aligned[off + j]! + q[j + 1]! * aligned[off + j + 1]! + q[j + 2]! * aligned[off + j + 2]! + q[j + 3]! * aligned[off + j + 3]!;
        }
        for (; j < dims; j++) s += q[j]! * aligned[off + j]!;
        if (s > best) best = s;
        if (s > colBest[i]!) colBest[i] = s;
      }
      rowSum += best;
    }
    let colSum = 0;
    for (let i = 0; i < rows; i++) colSum += colBest[i]!;
    return (rowSum / qRows + colSum / rows) / 2;
  }
  const bytes = Math.ceil(dims / 8);
  const mag = 1 / Math.sqrt(dims || 1);
  for (let qi = 0; qi < qRows; qi++) {
    const q = query[qi]!;
    let sum = 0;
    for (let j = 0; j < dims; j++) sum += q[j]!;
    let best = -Infinity;
    for (let i = 0; i < rows; i++) {
      let pos = 0;
      const off = i * bytes;
      for (let j = 0; j < dims; j++) if (p.data[off + (j >> 3)]! & (1 << (j & 7))) pos += q[j]!;
      const s = (2 * pos - sum) * mag;
      if (s > best) best = s;
      if (s > colBest[i]!) colBest[i] = s;
    }
    rowSum += best;
  }
  let colSum = 0;
  for (let i = 0; i < rows; i++) colSum += colBest[i]!;
  return (rowSum / qRows + colSum / rows) / 2;
}

/**
 * Single-pass symmetric normalized MaxSim between two PackedMatrix values.
 * Fast integer dot-product path when both are int8 (the common stored-memory format).
 */
export function symmetricMaxSimPacked(a: PackedMatrix, b: PackedMatrix): number {
  const aRows = a.rows;
  const bRows = b.rows;
  const dims = a.dims;
  if (!aRows || !bRows || dims !== b.dims) return 0;
  if (a.quant === "int8" && b.quant === "int8") {
    const da = new Int8Array(a.data.buffer, a.data.byteOffset, aRows * dims);
    const db = new Int8Array(b.data.buffer, b.data.byteOffset, bRows * dims);
    const dims4 = dims & ~3;
    const colBest = new Int32Array(bRows);
    colBest.fill(-2147483648);
    let rowSum = 0;
    for (let i = 0, offA = 0; i < aRows; i++, offA += dims) {
      let best = -2147483648;
      for (let k = 0, offB = 0; k < bRows; k++, offB += dims) {
        let s = 0;
        let j = 0;
        for (; j < dims4; j += 4) {
          s += da[offA + j]! * db[offB + j]! + da[offA + j + 1]! * db[offB + j + 1]! + da[offA + j + 2]! * db[offB + j + 2]! + da[offA + j + 3]! * db[offB + j + 3]!;
        }
        for (; j < dims; j++) s += da[offA + j]! * db[offB + j]!;
        if (s > best) best = s;
        if (s > colBest[k]!) colBest[k] = s;
      }
      rowSum += best;
    }
    let colSum = 0;
    for (let k = 0; k < bRows; k++) colSum += colBest[k]!;
    return (rowSum / (aRows * 16129) + colSum / (bRows * 16129)) / 2;
  }
  return symmetricMaxSimWithPacked(unpackMatrix(a), b);
}

/** Re-quantize a packed matrix (int8 → 1-bit when raw turns age out of the recent tier). */
export function requantize(p: PackedMatrix, quant: Quant): PackedMatrix {
  return p.quant === quant ? p : packMatrix(unpackMatrix(p), quant);
}

// ───────────────────────────── Token pooling

function poolBlock(m: TokenMatrix, target: number, cap: number): TokenMatrix {
  const n = m.length;
  if (n <= target || n <= 1) return m;
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const size = new Int32Array(n).fill(1);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  const pairCount = (n * (n - 1)) / 2;
  const scores = new Float32Array(pairCount);
  const left = new Int32Array(pairCount);
  const right = new Int32Array(pairCount);
  const order = new Int32Array(pairCount);
  let idx = 0;
  for (let i = 0; i < n; i++) {
    const mi = m[i]!;
    for (let j = i + 1; j < n; j++) {
      scores[idx] = dot(mi, m[j]!);
      left[idx] = i;
      right[idx] = j;
      order[idx] = idx;
      idx++;
    }
  }
  order.sort((a, b) => scores[b]! - scores[a]!);
  let clusters = n;
  for (let k = 0; k < pairCount; k++) {
    if (clusters <= target) break;
    const p = order[k]!;
    const a = find(left[p]!);
    const b = find(right[p]!);
    if (a === b || size[a]! + size[b]! > cap) continue;
    parent[b] = a;
    size[a] = size[a]! + size[b]!;
    clusters--;
  }
  const dims = m[0]!.length;
  const sums = new Map<number, Float32Array>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let s = sums.get(r);
    if (!s) sums.set(r, (s = new Float32Array(dims)));
    for (let j = 0; j < dims; j++) s[j] = s[j]! + m[i]![j]!;
  }
  const out: Float32Array[] = [];
  for (const s of sums.values()) {
    let norm = 0;
    for (let j = 0; j < dims; j++) norm += s[j]! * s[j]!;
    norm = Math.sqrt(norm) || 1;
    for (let j = 0; j < dims; j++) s[j] = s[j]! / norm;
    out.push(s);
  }
  return out;
}

const POOL_EXACT_MAX = 192;
const POOL_BUCKET_CAP = 160;
const POOL_SUBBLOCK = 128;

/**
 * Token pooling (Clavié et al. 2024): merge similar token vectors and mean-pool them, keeping
 * about n / factor rows. Uses size-capped agglomeration directly for small matrices (≤ 192 rows),
 * and partitions larger matrices by deterministic SimHash buckets (bounded to ≤ 160 rows each)
 * so pooling stays O(n) instead of O(n² log n) on long chunks.
 */
export function poolTokens(m: TokenMatrix, factor: number): TokenMatrix {
  const n = m.length;
  if (factor <= 1 || n <= 2) return m;
  const target = Math.max(1, Math.ceil(n / factor));
  const cap = Math.max(2, Math.ceil(factor * 2));
  if (n <= POOL_EXACT_MAX) return poolBlock(m, target, cap);

  const dims = m[0]!.length;
  const bits = Math.max(1, Math.min(6, Math.ceil(Math.log2(n / 96))));
  const rand = mulberry32(0x706f6f6c ^ (dims * 2654435761) ^ bits);
  const planes: Float32Array[] = [];
  for (let b = 0; b < bits; b++) {
    const h = new Float32Array(dims);
    for (let j = 0; j < dims; j++) h[j] = gaussian(rand);
    planes.push(h);
  }
  const buckets: TokenMatrix[] = Array.from({ length: 1 << bits }, () => []);
  for (let i = 0; i < n; i++) {
    const v = m[i]!;
    let bid = 0;
    for (let b = 0; b < bits; b++) if (dot(planes[b]!, v) > 0) bid |= 1 << b;
    buckets[bid]!.push(v);
  }
  const blocks: TokenMatrix[] = [];
  for (const b of buckets) {
    if (!b.length) continue;
    if (b.length <= POOL_BUCKET_CAP) {
      blocks.push(b);
    } else {
      for (let i = 0; i < b.length; i += POOL_SUBBLOCK) blocks.push(b.slice(i, i + POOL_SUBBLOCK));
    }
  }
  const targets = blocks.map((b) => Math.max(1, Math.min(b.length, Math.round((b.length / n) * target))));
  let sumTargets = targets.reduce((a, b) => a + b, 0);
  if (sumTargets !== target) {
    const bySize = blocks.map((b, i) => ({ i, len: b.length })).sort((a, b) => b.len - a.len);
    for (const { i, len } of bySize) {
      if (sumTargets === target) break;
      if (sumTargets > target && targets[i]! > 1) {
        targets[i]!--;
        sumTargets--;
      } else if (sumTargets < target && targets[i]! < len) {
        targets[i]!++;
        sumTargets++;
      }
    }
  }
  const out: Float32Array[] = [];
  for (let i = 0; i < blocks.length; i++) {
    for (const v of poolBlock(blocks[i]!, targets[i]!, cap)) out.push(v);
  }
  return out;
}

// ───────────────────────────── MUVERA fixed-dimensional encodings

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

export interface FdeParams {
  dims: number; // token-vector width
  reps: number; // R
  simhashBits: number; // k_sim: 2^k buckets per repetition
  projDims: number; // d_proj
  seed: number;
}

/** Choose (R, k_sim, d_proj) so that R · 2^k · d_proj equals the requested FDE size. */
export function fdeParams(tokenDims: number, fdeDims: number, seed = 0x5eed): FdeParams {
  const table: Record<number, [number, number, number]> = { 128: [2, 2, 16], 256: [4, 2, 16], 512: [4, 3, 16], 1024: [8, 3, 16], 2048: [8, 4, 16] };
  const [reps, simhashBits, projDims] = table[fdeDims] ?? [Math.max(1, Math.round(fdeDims / (8 * 16))), 3, 16];
  return { dims: tokenDims, reps, simhashBits, projDims: Math.min(projDims, tokenDims), seed };
}

export class FdeEncoder {
  readonly params: FdeParams;
  readonly size: number;
  private readonly planes: Float32Array[][]; // [rep][bit] → hyperplane
  private readonly proj: Int8Array[]; // [rep] → projDims × dims matrix of ±1

  constructor(params: FdeParams) {
    this.params = params;
    const { dims, reps, simhashBits, projDims, seed } = params;
    this.size = reps * (1 << simhashBits) * projDims;
    const rand = mulberry32(seed ^ (dims * 2654435761));
    this.planes = [];
    this.proj = [];
    for (let r = 0; r < reps; r++) {
      const hs: Float32Array[] = [];
      for (let b = 0; b < simhashBits; b++) {
        const h = new Float32Array(dims);
        for (let i = 0; i < dims; i++) h[i] = gaussian(rand);
        hs.push(h);
      }
      this.planes.push(hs);
      const p = new Int8Array(projDims * dims);
      for (let i = 0; i < p.length; i++) p[i] = rand() < 0.5 ? -1 : 1;
      this.proj.push(p);
    }
  }

  private bucket(rep: number, v: Float32Array): number {
    let id = 0;
    const hs = this.planes[rep]!;
    for (let b = 0; b < hs.length; b++) if (dot(hs[b]!, v) > 0) id |= 1 << b;
    return id;
  }

  private encode(m: TokenMatrix, isQuery: boolean): Float32Array {
    const { dims, reps, simhashBits, projDims } = this.params;
    const buckets = 1 << simhashBits;
    const out = new Float32Array(this.size);
    const scale = 1 / Math.sqrt(projDims);
    for (let r = 0; r < reps; r++) {
      const sums: Float32Array[] = Array.from({ length: buckets }, () => new Float32Array(dims));
      const counts = new Int32Array(buckets);
      const ids = m.map((v) => this.bucket(r, v));
      m.forEach((v, i) => {
        const s = sums[ids[i]!]!;
        for (let j = 0; j < dims; j++) s[j] = s[j]! + v[j]!;
        counts[ids[i]!]!++;
      });
      for (let b = 0; b < buckets; b++) {
        let vec = sums[b]!;
        if (!isQuery) {
          if (counts[b]! > 0) {
            // documents use the bucket centroid
            for (let j = 0; j < dims; j++) vec[j] = vec[j]! / counts[b]!;
          } else if (m.length > 0) {
            // fill an empty bucket with the token whose bucket id is nearest in Hamming distance
            let best = 0;
            let bd = Infinity;
            for (let i = 0; i < ids.length; i++) {
              let x = ids[i]! ^ b;
              let d = 0;
              while (x) {
                d += x & 1;
                x >>= 1;
              }
              if (d < bd) {
                bd = d;
                best = i;
              }
            }
            vec = m[best]!;
          }
        }
        const p = this.proj[r]!;
        const base = (r * buckets + b) * projDims;
        for (let k = 0; k < projDims; k++) {
          let s = 0;
          const row = k * dims;
          for (let j = 0; j < dims; j++) s += p[row + j]! * vec[j]!;
          out[base + k] = s * scale;
        }
      }
    }
    return out;
  }

  /** Query encoding: per-bucket sums. */
  query(m: TokenMatrix): Float32Array {
    return this.encode(m, true);
  }

  /** Document encoding: per-bucket centroids with empty buckets filled. */
  document(m: TokenMatrix): Float32Array {
    return this.encode(m, false);
  }
}

/** int8 FDE with a 4-byte float32 scale header. */
export function packFde(v: Float32Array, quant: "int8" | "float32"): Uint8Array {
  if (quant === "float32") return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
  let maxAbs = 0;
  for (let i = 0; i < v.length; i++) maxAbs = Math.max(maxAbs, Math.abs(v[i]!));
  const out = new Uint8Array(4 + v.length);
  new DataView(out.buffer).setFloat32(0, maxAbs || 1, true);
  const q = new Int8Array(out.buffer, 4);
  const s = maxAbs > 0 ? 127 / maxAbs : 0;
  for (let i = 0; i < v.length; i++) q[i] = Math.round(v[i]! * s);
  return out;
}

export type DecodedFde =
  | { quant: "float32"; vec: Float32Array }
  | { quant: "int8"; scale: number; q: Int8Array };

/** Decode a stored FDE blob once so repeated FDE scans do zero DataView/TypedArray allocations. */
export function decodeFde(packed: Uint8Array, quant: "int8" | "float32"): DecodedFde {
  if (quant === "float32") {
    const vec = packed.byteOffset % 4 === 0 ? new Float32Array(packed.buffer, packed.byteOffset, packed.byteLength >> 2) : new Float32Array(packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength));
    return { quant: "float32", vec };
  }
  const maxAbs = new DataView(packed.buffer, packed.byteOffset, 4).getFloat32(0, true);
  const q = new Int8Array(packed.buffer, packed.byteOffset + 4, packed.length - 4);
  return { quant: "int8", scale: maxAbs / 127, q };
}

/** Dot product of a float query FDE with a pre-decoded document FDE (unrolled hot loop). */
export function fdeScoreDecoded(query: Float32Array, d: DecodedFde): number {
  if (d.quant === "float32") return dot(query, d.vec);
  const q = d.q;
  const n = Math.min(query.length, q.length);
  const n4 = n & ~3;
  let s = 0;
  let i = 0;
  for (; i < n4; i += 4) {
    s += query[i]! * q[i]! + query[i + 1]! * q[i + 1]! + query[i + 2]! * q[i + 2]! + query[i + 3]! * q[i + 3]!;
  }
  for (; i < n; i++) s += query[i]! * q[i]!;
  return s * d.scale;
}

/** Dot product of a float query FDE with a packed document FDE. */
export function fdeScore(query: Float32Array, packed: Uint8Array, quant: "int8" | "float32"): number {
  return fdeScoreDecoded(query, decodeFde(packed, quant));
}

export function packDense(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

export function unpackDense(b: Uint8Array): Float32Array {
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}
