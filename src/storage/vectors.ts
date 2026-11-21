/**
 * Vector tables shared by the memory index and the turn index (Appendix B.4, §9.2.2–§9.2.3):
 * dense vectors, quantized token matrices and fixed-dimensional encodings, all local-only.
 */
import type { DenseVector, TokenMatrix } from "../core/types.ts";
import { dot, FdeEncoder, fdeParams, fdeScore, maxSimPacked, packDense, packFde, type PackedMatrix, packMatrix, poolTokens, type Quant, requantize, unpackDense, unpackMatrix } from "../providers/late.ts";
import type { Db } from "./sqlite.ts";

export interface Scored {
  id: string;
  score: number;
}

export interface LateSearchOptions {
  limit: number;
  /** Exact MaxSim over everything while the set is at most this large (§9.2.3). */
  exactMax: number;
  /** First-stage candidates from the fixed-dimensional encodings. */
  candidates: number;
  filter?: (id: string) => boolean;
  /** Restrict the scan to these ids (e.g. BM25 pre-filtering for very large sets). */
  only?: Set<string>;
}

const encoders = new Map<string, FdeEncoder>();
function encoder(tokenDims: number, fdeDims: number): FdeEncoder {
  const key = `${tokenDims}:${fdeDims}`;
  let e = encoders.get(key);
  if (!e) {
    e = new FdeEncoder(fdeParams(tokenDims, fdeDims));
    encoders.set(key, e);
  }
  return e;
}

function blob(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return new Uint8Array(0);
}

export class VectorTables {
  private readonly db: Db;
  private readonly t: string;
  private denseCache = new Map<string, Map<string, Float32Array>>();
  private fdeCache = new Map<string, Map<string, Uint8Array>>();
  private tokenCache = new Map<string, Map<string, PackedMatrix>>();
  private tokenCacheSize = new Map<string, number>();
  /** Token matrices are cached in memory only below this many bytes per model. */
  tokenCacheBytes = 64 * 1024 * 1024;
  fdeDims: number;
  fdeQuant: "int8" | "float32";

  constructor(db: Db, prefix: string, opts: { fdeDims?: number; fdeQuant?: "int8" | "float32" } = {}) {
    this.db = db;
    this.t = prefix;
    this.fdeDims = opts.fdeDims ?? 512;
    this.fdeQuant = opts.fdeQuant ?? "int8";
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${prefix}_dense  (id TEXT, model TEXT, hash TEXT, vec BLOB, PRIMARY KEY (id, model));
      CREATE TABLE IF NOT EXISTS ${prefix}_tokens (id TEXT, model TEXT, hash TEXT, quant TEXT, pool INTEGER, rows INTEGER, dims INTEGER, data BLOB, PRIMARY KEY (id, model));
      CREATE TABLE IF NOT EXISTS ${prefix}_fde    (id TEXT, model TEXT, vec BLOB, PRIMARY KEY (id, model));
    `);
  }

  private invalidate(model: string): void {
    this.denseCache.delete(model);
    this.fdeCache.delete(model);
    this.tokenCache.delete(model);
    this.tokenCacheSize.delete(model);
  }

  private cacheToken(model: string, id: string, packed: PackedMatrix): void {
    const m = this.tokenCache.get(model);
    if (!m) return;
    const prev = m.get(id)?.data.byteLength ?? 0;
    const nextSize = (this.tokenCacheSize.get(model) ?? 0) - prev + packed.data.byteLength;
    if (nextSize > this.tokenCacheBytes) {
      this.tokenCache.delete(model);
      this.tokenCacheSize.delete(model);
      return;
    }
    m.set(id, packed);
    this.tokenCacheSize.set(model, nextSize);
  }

  private uncacheToken(id: string): void {
    for (const [model, m] of this.tokenCache) {
      const prev = m.get(id);
      if (!prev) continue;
      m.delete(id);
      this.tokenCacheSize.set(model, Math.max(0, (this.tokenCacheSize.get(model) ?? 0) - prev.data.byteLength));
    }
  }

  /** Rebuild every FDE blob from stored token matrices (called when `fdeDims` or `fdeQuant` changes). */
  rebuildFde(): number {
    let n = 0;
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM ${this.t}_fde`).run();
      const rows = this.db.prepare(`SELECT id, model, quant, rows, dims, data FROM ${this.t}_tokens`).all();
      const ins = this.db.prepare(`INSERT OR REPLACE INTO ${this.t}_fde (id, model, vec) VALUES (?, ?, ?)`);
      for (const r of rows) {
        const packed: PackedMatrix = { quant: String(r.quant) as Quant, rows: Number(r.rows), dims: Number(r.dims), data: blob(r.data) };
        if (!packed.rows || !packed.dims) continue;
        const matrix = unpackMatrix(packed);
        const fde = packFde(encoder(packed.dims, this.fdeDims).document(matrix), this.fdeQuant);
        ins.run(String(r.id), String(r.model), fde);
        n++;
      }
    });
    this.fdeCache.clear();
    return n;
  }

  // ───────────── writes
  putDense(id: string, model: string, hash: string, vec: DenseVector): void {
    this.db.prepare(`INSERT OR REPLACE INTO ${this.t}_dense (id, model, hash, vec) VALUES (?, ?, ?, ?)`).run(id, model, hash, packDense(vec));
    this.denseCache.get(model)?.set(id, vec);
  }

  /** Store a token matrix (pooled and quantized) together with its fixed-dimensional encoding. */
  putTokens(id: string, model: string, hash: string, matrix: TokenMatrix, quant: Quant, pool: number): void {
    if (!matrix.length) return;
    const pooled = poolTokens(matrix, pool);
    const packed = packMatrix(pooled, quant);
    this.db
      .prepare(`INSERT OR REPLACE INTO ${this.t}_tokens (id, model, hash, quant, pool, rows, dims, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, model, hash, quant, pool, packed.rows, packed.dims, packed.data);
    // the encoding is computed from the unquantized vectors
    const fde = packFde(encoder(packed.dims, this.fdeDims).document(matrix), this.fdeQuant);
    this.db.prepare(`INSERT OR REPLACE INTO ${this.t}_fde (id, model, vec) VALUES (?, ?, ?)`).run(id, model, fde);
    this.fdeCache.get(model)?.set(id, fde);
    this.cacheToken(model, id, packed);
  }

  /** Move a stored matrix to a smaller tier (int8 → 1-bit as raw turns age, §9.2.2). */
  requantize(id: string, model: string, quant: Quant): boolean {
    const p = this.getTokens(id, model);
    if (!p || p.quant === quant) return false;
    const next = requantize(p, quant);
    this.db.prepare(`UPDATE ${this.t}_tokens SET quant = ?, data = ? WHERE id = ? AND model = ?`).run(quant, next.data, id, model);
    this.cacheToken(model, id, next);
    return true;
  }

  delete(id: string): void {
    for (const table of ["dense", "tokens", "fde"]) this.db.prepare(`DELETE FROM ${this.t}_${table} WHERE id = ?`).run(id);
    for (const m of this.denseCache.values()) m.delete(id);
    for (const m of this.fdeCache.values()) m.delete(id);
    this.uncacheToken(id);
  }

  deleteTokens(id: string): void {
    this.db.prepare(`DELETE FROM ${this.t}_tokens WHERE id = ?`).run(id);
    this.uncacheToken(id);
  }

  deleteFdeAndDense(id: string): void {
    this.db.prepare(`DELETE FROM ${this.t}_fde WHERE id = ?`).run(id);
    this.db.prepare(`DELETE FROM ${this.t}_dense WHERE id = ?`).run(id);
    for (const m of this.denseCache.values()) m.delete(id);
    for (const m of this.fdeCache.values()) m.delete(id);
  }

  /** Drop vectors made by other models (a model change rebuilds lazily, §9.2.5). */
  dropOtherModels(keep: string[]): number {
    let n = 0;
    for (const table of ["dense", "tokens", "fde"]) {
      const rows = this.db.prepare(`SELECT DISTINCT model FROM ${this.t}_${table}`).all();
      for (const r of rows) {
        const model = String(r.model);
        if (keep.includes(model)) continue;
        this.db.prepare(`DELETE FROM ${this.t}_${table} WHERE model = ?`).run(model);
        this.invalidate(model);
        n++;
      }
    }
    return n;
  }

  // ───────────── reads
  /** Which of these items still need a vector from `model` (missing, or made from other content). */
  missing(kind: "dense" | "tokens", model: string, items: Array<{ id: string; hash: string }>): string[] {
    const have = new Map<string, string>();
    for (const r of this.db.prepare(`SELECT id, hash FROM ${this.t}_${kind} WHERE model = ?`).all(model)) have.set(String(r.id), String(r.hash));
    return items.filter((it) => have.get(it.id) !== it.hash).map((it) => it.id);
  }

  count(kind: "dense" | "tokens" | "fde", model?: string): number {
    const r = model ? this.db.prepare(`SELECT COUNT(*) AS n FROM ${this.t}_${kind} WHERE model = ?`).get(model) : this.db.prepare(`SELECT COUNT(*) AS n FROM ${this.t}_${kind}`).get();
    return Number(r?.n ?? 0);
  }

  bytes(): { dense: number; tokens: number; fde: number } {
    const one = (table: string, col: string) => Number(this.db.prepare(`SELECT COALESCE(SUM(LENGTH(${col})), 0) AS n FROM ${this.t}_${table}`).get()?.n ?? 0);
    return { dense: one("dense", "vec"), tokens: one("tokens", "data"), fde: one("fde", "vec") };
  }

  getDense(id: string, model: string): Float32Array | null {
    const cached = this.denseCache.get(model)?.get(id);
    if (cached) return cached;
    const r = this.db.prepare(`SELECT vec FROM ${this.t}_dense WHERE id = ? AND model = ?`).get(id, model);
    return r ? unpackDense(blob(r.vec)) : null;
  }

  getTokens(id: string, model: string): PackedMatrix | null {
    const cached = this.tokenCache.get(model)?.get(id);
    if (cached) return cached;
    const r = this.db.prepare(`SELECT quant, rows, dims, data FROM ${this.t}_tokens WHERE id = ? AND model = ?`).get(id, model);
    if (!r) return null;
    return { quant: String(r.quant) as Quant, rows: Number(r.rows), dims: Number(r.dims), data: blob(r.data) };
  }

  getMatrix(id: string, model: string): TokenMatrix | null {
    const p = this.getTokens(id, model);
    return p ? unpackMatrix(p) : null;
  }

  private allDense(model: string): Map<string, Float32Array> {
    let m = this.denseCache.get(model);
    if (!m) {
      m = new Map();
      for (const r of this.db.prepare(`SELECT id, vec FROM ${this.t}_dense WHERE model = ?`).all(model)) m.set(String(r.id), unpackDense(blob(r.vec)));
      this.denseCache.set(model, m);
    }
    return m;
  }

  private allFde(model: string): Map<string, Uint8Array> {
    let m = this.fdeCache.get(model);
    if (!m) {
      m = new Map();
      for (const r of this.db.prepare(`SELECT id, vec FROM ${this.t}_fde WHERE model = ?`).all(model)) m.set(String(r.id), blob(r.vec));
      this.fdeCache.set(model, m);
    }
    return m;
  }

  private allTokens(model: string): Map<string, PackedMatrix> | null {
    const cached = this.tokenCache.get(model);
    if (cached) return cached;
    const total = Number(this.db.prepare(`SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM ${this.t}_tokens WHERE model = ?`).get(model)?.n ?? 0);
    if (total > this.tokenCacheBytes) return null;
    const m = new Map<string, PackedMatrix>();
    let bytes = 0;
    for (const r of this.db.prepare(`SELECT id, quant, rows, dims, data FROM ${this.t}_tokens WHERE model = ?`).all(model)) {
      const data = blob(r.data);
      bytes += data.byteLength;
      m.set(String(r.id), { quant: String(r.quant) as Quant, rows: Number(r.rows), dims: Number(r.dims), data });
    }
    this.tokenCache.set(model, m);
    this.tokenCacheSize.set(model, bytes);
    return m;
  }

  /** Cosine search (vectors are L2-normalized on the way in). */
  denseSearch(query: DenseVector, model: string, opts: { limit: number; filter?: (id: string) => boolean; floor?: number }): Scored[] {
    const out: Scored[] = [];
    for (const [id, vec] of this.allDense(model)) {
      if (opts.filter && !opts.filter(id)) continue;
      if (vec.length !== query.length) continue;
      const score = dot(query, vec);
      if (opts.floor !== undefined && score < opts.floor) continue;
      out.push({ id, score });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, opts.limit);
  }

  /**
   * Late-interaction search (§9.2.3): exact normalized MaxSim over small sets; for large sets,
   * fixed-dimensional encodings pick the candidates and exact MaxSim ranks them.
   */
  lateSearch(query: TokenMatrix, model: string, opts: LateSearchOptions): Scored[] {
    if (!query.length) return [];
    const dims = query[0]!.length;
    const total = opts.only ? opts.only.size : this.count("tokens", model);
    let candidates: string[];
    if (total <= opts.exactMax) {
      const all = this.allTokens(model);
      candidates = opts.only ? [...opts.only] : all ? [...all.keys()] : this.db.prepare(`SELECT id FROM ${this.t}_tokens WHERE model = ?`).all(model).map((r) => String(r.id));
      if (opts.filter) candidates = candidates.filter(opts.filter);
    } else {
      const qf = encoder(dims, this.fdeDims).query(query);
      const first: Scored[] = [];
      for (const [id, vec] of this.allFde(model)) {
        if (opts.only && !opts.only.has(id)) continue;
        if (opts.filter && !opts.filter(id)) continue;
        first.push({ id, score: fdeScore(qf, vec, this.fdeQuant) });
      }
      first.sort((a, b) => b.score - a.score);
      candidates = first.slice(0, opts.candidates).map((s) => s.id);
    }
    const out: Scored[] = [];
    for (const id of candidates) {
      const p = this.getTokens(id, model);
      if (!p || p.dims !== dims) continue;
      out.push({ id, score: maxSimPacked(query, p) });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, opts.limit);
  }

  /** Symmetric normalized MaxSim between a fresh matrix and a stored item (de-dup, conflicts). */
  symmetricWith(matrix: TokenMatrix, id: string, model: string): number | null {
    const p = this.getTokens(id, model);
    if (!p || !matrix.length || p.dims !== matrix[0]!.length) return null;
    const stored = unpackMatrix(p);
    const ab = maxSimPacked(matrix, p);
    const ba = maxSimPacked(stored, packMatrix(matrix, "float32"));
    return (ab + ba) / 2;
  }

  ids(kind: "dense" | "tokens", model: string): string[] {
    return this.db.prepare(`SELECT id FROM ${this.t}_${kind} WHERE model = ?`).all(model).map((r) => String(r.id));
  }
}

/** Reciprocal-rank fusion (§6.4.3; k = 60). */
export function rrf(lists: Scored[][], k = 60): Scored[] {
  const acc = new Map<string, number>();
  for (const list of lists) list.forEach((s, rank) => acc.set(s.id, (acc.get(s.id) ?? 0) + 1 / (k + rank + 1)));
  return [...acc.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
}
