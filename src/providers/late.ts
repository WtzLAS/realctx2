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
  let total = 0;
  if (p.quant === "int8") {
    const d = new Int8Array(p.data.buffer, p.data.byteOffset, rows * dims);
    for (const q of query) {
      let best = -Infinity;
      for (let i = 0, off = 0; i < rows; i++, off += dims) {
        let s = 0;
        for (let j = 0; j < dims; j++) s += q[j]! * d[off + j]!;
        if (s > best) best = s;
      }
      total += best / 127;
    }
    return total / query.length;
  }
  if (p.quant === "float32") {
    const aligned = p.data.byteOffset % 4 === 0 ? new Float32Array(p.data.buffer, p.data.byteOffset, rows * dims) : new Float32Array(p.data.buffer.slice(p.data.byteOffset, p.data.byteOffset + rows * dims * 4));
    for (const q of query) {
      let best = -Infinity;
      for (let i = 0, off = 0; i < rows; i++, off += dims) {
        let s = 0;
        for (let j = 0; j < dims; j++) s += q[j]! * aligned[off + j]!;
        if (s > best) best = s;
      }
      total += best;
    }
    return total / query.length;
  }
  const bytes = Math.ceil(dims / 8);
  const mag = 1 / Math.sqrt(dims || 1);
  for (const q of query) {
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

/** Re-quantize a packed matrix (int8 → 1-bit when raw turns age out of the recent tier). */
export function requantize(p: PackedMatrix, quant: Quant): PackedMatrix {
  return p.quant === quant ? p : packMatrix(unpackMatrix(p), quant);
}

// ───────────────────────────── Token pooling

/**
 * Token pooling (Clavié et al. 2024): merge similar token vectors and mean-pool them, keeping
 * about n / factor rows. This uses size-capped agglomeration over the similarity-sorted pair
 * list rather than Ward linkage, which is close enough at factor 2 and much cheaper.
 */
export function poolTokens(m: TokenMatrix, factor: number): TokenMatrix {
  const n = m.length;
  if (factor <= 1 || n <= 2) return m;
  const target = Math.max(1, Math.ceil(n / factor));
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
  const cap = Math.max(2, Math.ceil(factor * 2));
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

/** Dot product of a float query FDE with a packed document FDE. */
export function fdeScore(query: Float32Array, packed: Uint8Array, quant: "int8" | "float32"): number {
  if (quant === "float32") {
    const f = new Float32Array(packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength));
    return dot(query, f);
  }
  const maxAbs = new DataView(packed.buffer, packed.byteOffset, 4).getFloat32(0, true);
  const q = new Int8Array(packed.buffer, packed.byteOffset + 4, packed.length - 4);
  let s = 0;
  const n = Math.min(query.length, q.length);
  for (let i = 0; i < n; i++) s += query[i]! * q[i]!;
  return (s * maxAbs) / 127;
}

export function packDense(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

export function unpackDense(b: Uint8Array): Float32Array {
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}
