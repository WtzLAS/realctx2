/**
 * Similarity service (§9.2): which embedding model does what, calibrated thresholds, and the
 * embedding work that fills the local indexes.
 *
 * | Configured        | First-stage search          | Thresholds                               |
 * | late (± dense)    | MaxSim, fused with BM25     | normalized MaxSim, calibrated per model  |
 * | dense only        | cosine, fused with BM25     | cosine at the document's values          |
 * | neither           | BM25 + graph activation     | content hash + trigram Jaccard ≥ 0.9     |
 */
import type { Config, Layout } from "../core/config.ts";
import type { Telemetry } from "../core/telemetry.ts";
import type { Clock, DenseVector, EmbeddingClient, TokenMatrix } from "../core/types.ts";
import { type PackedMatrix, symmetricMaxSim, symmetricMaxSimPacked } from "../providers/late.ts";
import { createTimeSlicer } from "../util/async.ts";
import { embedHash, embedText } from "../storage/index.ts";
import type { TurnIndex } from "../storage/turnindex.ts";
import type { Scored, VectorTables } from "../storage/vectors.ts";
import { errMsg } from "../util/errors.ts";
import { readJson, writeJson } from "../util/fs.ts";
import { clamp, cosine, median, sha256, trigramJaccard } from "../util/text.ts";
import { CALIBRATION_SET_VERSION, CALIBRATION_TARGETS, calibrationPairs } from "./calibration-data.ts";
import type { MemoryGraph, ScopeHandle } from "./graph.ts";

export type SimMode = "late" | "dense" | "lexical";
export type ThresholdName = "dedup" | "conflict" | "floor" | "fusion" | "intentDuplicate" | "analogous";
const THRESHOLD_NAMES: ThresholdName[] = ["dedup", "conflict", "floor", "fusion", "intentDuplicate", "analogous"];
const LEXICAL_THRESHOLDS: Record<ThresholdName, number> = { dedup: 0.9, intentDuplicate: 0.9, analogous: 0.8, conflict: 0.5, fusion: 0.6, floor: 0 };

export interface Encoded {
  text: string;
  dense?: DenseVector;
  late?: TokenMatrix;
}

export interface LoggedPair {
  name: ThresholdName;
  score: number;
  ok: boolean;
  /** Inverse-probability weight: 1 above the threshold, 1/p_s for sampled pairs below it. */
  w: number;
}

export interface ModelCalibration {
  modelKey: string;
  kind: "late" | "dense";
  setVersion: number;
  calibratedAt: string | null;
  source: "set" | "default" | "learned";
  thresholds: Record<ThresholdName, number>;
  samples: Record<string, number>;
  /** Median score of unrelated pairs: the low anchor of the calibration curve. */
  unrelated: number;
  pairs: LoggedPair[];
  sinceRefit: number;
}

/**
 * The lowest threshold whose weighted precision reaches the target. `items` are (score, positive, weight).
 * Deterministic: ties are broken by score, then by input order.
 */
export function fitThreshold(items: Array<{ score: number; positive: boolean; w?: number }>, precision: number, minPositives = 3): number | null {
  const sorted = items.map((it, i) => ({ ...it, i })).sort((a, b) => b.score - a.score || a.i - b.i);
  let pos = 0;
  let total = 0;
  let positives = 0;
  let best: number | null = null;
  for (let k = 0; k < sorted.length; k++) {
    const it = sorted[k]!;
    const w = it.w ?? 1;
    total += w;
    if (it.positive) {
      pos += w;
      positives++;
    }
    // evaluate only at the end of a run of equal scores
    if (k + 1 < sorted.length && sorted[k + 1]!.score === it.score) continue;
    if (positives >= minPositives && pos / total >= precision) best = it.score;
  }
  return best;
}

interface SimilarityOptions {
  cfg: Config;
  layout: Layout | null;
  late?: EmbeddingClient<"multivector"> | null;
  dense?: EmbeddingClient<"dense"> | null;
  telemetry?: Telemetry;
  clock?: Clock;
  random?: () => number;
}

export class Similarity {
  readonly cfg: Config;
  late: EmbeddingClient<"multivector"> | null;
  dense: EmbeddingClient<"dense"> | null;
  private readonly layout: Layout | null;
  private readonly telemetry?: Telemetry;
  private readonly clock: Clock;
  private readonly random: () => number;
  private calibrations = new Map<string, ModelCalibration>();
  private queryCache = new Map<string, Encoded>();
  private calibrating: Promise<{ ok: boolean; problem?: string }> | null = null;

  constructor(o: SimilarityOptions) {
    this.cfg = o.cfg;
    this.layout = o.layout;
    this.late = o.late ?? null;
    this.dense = o.dense ?? null;
    this.telemetry = o.telemetry;
    this.clock = o.clock ?? (() => new Date());
    this.random = o.random ?? Math.random;
  }

  /** Replace embedding clients after a live configuration reload. */
  setClients(late: EmbeddingClient<"multivector"> | null, dense: EmbeddingClient<"dense"> | null): void {
    this.late = late;
    this.dense = dense;
    this.queryCache.clear();
    this.calibrating = null;
  }

  // ───────────── modes
  lateKey(): string | null {
    return this.late ? this.late.key : null;
  }
  denseKey(): string | null {
    return this.dense ? this.dense.key : null;
  }

  /** Model used for first-stage search: late when reachable, else dense, else none (§9.2.1). */
  searchMode(): SimMode {
    if (this.late?.healthy()) return "late";
    if (this.dense?.healthy()) return "dense";
    return "lexical";
  }

  /** Model used for thresholds: late only once it is calibrated. */
  thresholdMode(): SimMode {
    if (this.late?.healthy() && this.calibration("late")?.calibratedAt) return "late";
    if (this.dense?.healthy()) return "dense";
    return "lexical";
  }

  // ───────────── calibration (§9.2.4)
  private defaults(): Record<ThresholdName, number> {
    const s = this.cfg.memory.similarity;
    return { dedup: s.dedup, conflict: s.conflict, floor: s.floor, fusion: s.fusion, intentDuplicate: s.intentDuplicate, analogous: s.analogous };
  }

  calibration(kind: "late" | "dense"): ModelCalibration | null {
    const key = kind === "late" ? this.lateKey() : this.denseKey();
    if (!key) return null;
    let c = this.calibrations.get(key);
    if (!c) {
      const fresh: ModelCalibration = { modelKey: key, kind, setVersion: CALIBRATION_SET_VERSION, calibratedAt: kind === "dense" ? "default" : null, source: "default", thresholds: this.defaults(), samples: {}, unrelated: 0.3, pairs: [], sinceRefit: 0 };
      const saved = this.layout ? readJson<ModelCalibration | null>(this.layout.modelFile(key), null) : null;
      c = saved && saved.modelKey === key && saved.thresholds ? { ...fresh, ...saved, thresholds: { ...fresh.thresholds, ...saved.thresholds }, pairs: Array.isArray(saved.pairs) ? saved.pairs : [] } : fresh;
      // a newer calibration set invalidates set-based thresholds
      if (kind === "late" && c.setVersion !== CALIBRATION_SET_VERSION) c.calibratedAt = null;
      this.calibrations.set(key, c);
    }
    return c;
  }

  private save(c: ModelCalibration): void {
    if (!this.layout) return;
    try {
      writeJson(this.layout.modelFile(c.modelKey), c);
    } catch {
      // calibration is recomputed when it cannot be stored
    }
  }

  needsCalibration(): boolean {
    return this.cfg.memory.similarity.calibrate !== "off" && !!this.late && !this.calibration("late")?.calibratedAt;
  }

  /**
   * Score the shipped calibration set with the late-interaction model and pick each threshold
   * to reach its precision target. Reproducible: the same model output gives the same thresholds.
   */
  calibrate(force = false): Promise<{ ok: boolean; problem?: string }> {
    if (this.calibrating) return this.calibrating;
    this.calibrating = this.runCalibration(force).finally(() => {
      this.calibrating = null;
    });
    return this.calibrating;
  }

  private async runCalibration(force: boolean): Promise<{ ok: boolean; problem?: string }> {
    const late = this.late;
    if (!late) return { ok: false, problem: "no late-interaction model is configured (dense thresholds use the documented values)" };
    const cal = this.calibration("late")!;
    if (cal.calibratedAt && !force) return { ok: true };
    try {
      const pairs = calibrationPairs();
      const texts = [...new Set(pairs.flatMap((p) => [p.a, p.b]))];
      const matrices = await late.embed(texts, "document");
      const byText = new Map(texts.map((t, i) => [t, matrices[i]!]));
      const scored = pairs.map((p) => ({ label: p.label, score: symmetricMaxSim(byText.get(p.a)!, byText.get(p.b)!) }));
      const thresholds = this.defaults();
      const samples: Record<string, number> = {};
      for (const name of THRESHOLD_NAMES) {
        const target = CALIBRATION_TARGETS[name]!;
        const items = scored.map((s) => ({ score: s.score, positive: s.label >= target.positive }));
        const t = fitThreshold(items, target.precision);
        if (t !== null) thresholds[name] = Math.round(t * 10000) / 10000;
        samples[name] = items.length;
      }
      // keep the documented ordering even when the set gives ties
      thresholds.dedup = Math.max(thresholds.dedup, thresholds.intentDuplicate);
      thresholds.analogous = Math.min(thresholds.analogous, thresholds.intentDuplicate);
      for (const name of ["conflict", "fusion", "floor"] as const) thresholds[name] = Math.min(thresholds[name], thresholds.analogous);
      cal.thresholds = thresholds;
      cal.samples = samples;
      cal.unrelated = median(scored.filter((s) => s.label === 0).map((s) => s.score));
      cal.calibratedAt = this.clock().toISOString();
      cal.setVersion = CALIBRATION_SET_VERSION;
      cal.source = "set";
      cal.pairs = [];
      cal.sinceRefit = 0;
      this.save(cal);
      this.telemetry?.event("calibration.done", { model: cal.modelKey, thresholds });
      return { ok: true };
    } catch (e) {
      const problem = errMsg(e);
      this.telemetry?.event("calibration.failed", { problem });
      return { ok: false, problem };
    }
  }

  /** Threshold on the scale of `mode` (default: the active threshold model). */
  threshold(name: ThresholdName, mode: SimMode = this.thresholdMode()): number {
    if (mode === "lexical") return LEXICAL_THRESHOLDS[name];
    return this.calibration(mode)?.thresholds[name] ?? this.defaults()[name];
  }

  /**
   * Map a score onto [0, 1] through the model's calibration curve, so late-interaction and
   * dense models give comparable importance values (§6.5.2).
   */
  toUnit(score: number, mode: SimMode = this.thresholdMode()): number {
    if (mode === "lexical") return clamp(score, 0, 1);
    if (mode === "dense") return clamp(score, 0, 1);
    const c = this.calibration("late");
    if (!c?.calibratedAt) return clamp(score, 0, 1);
    const anchors: Array<[number, number]> = [
      [Math.min(c.unrelated, c.thresholds.floor - 1e-6), 0.3],
      [c.thresholds.floor, 0.75],
      [c.thresholds.analogous, 0.85],
      [c.thresholds.intentDuplicate, 0.9],
      [c.thresholds.dedup, 0.92],
      [1, 1],
    ];
    if (score <= anchors[0]![0]) return clamp((score / Math.max(1e-6, anchors[0]![0])) * 0.3, 0, 0.3);
    for (let i = 1; i < anchors.length; i++) {
      const [x0, y0] = anchors[i - 1]!;
      const [x1, y1] = anchors[i]!;
      if (score <= x1) return x1 > x0 ? y0 + ((score - x0) / (x1 - x0)) * (y1 - y0) : y1;
    }
    return 1;
  }

  /** Whether a pair just below a threshold should also be judged, so refits see both sides (5%). */
  sampleBelow(): boolean {
    return this.random() < this.cfg.memory.similarity.learn.belowSample;
  }

  /**
   * Learning from use (§9.2.4): log a (score, verdict) pair; every `refitEvery` pairs, refit each
   * threshold to its precision target, moving it by at most `maxStep`.
   */
  logPair(name: ThresholdName, score: number, ok: boolean, opts: { below?: boolean; mode?: SimMode } = {}): void {
    const mode = opts.mode ?? this.thresholdMode();
    if (mode === "lexical") return;
    const cal = this.calibration(mode);
    if (!cal) return;
    const learn = this.cfg.memory.similarity.learn;
    cal.pairs.push({ name, score: Math.round(score * 10000) / 10000, ok, w: opts.below ? 1 / Math.max(1e-6, learn.belowSample) : 1 });
    if (cal.pairs.length > 4000) cal.pairs.splice(0, cal.pairs.length - 4000);
    cal.sinceRefit++;
    if (cal.sinceRefit >= learn.refitEvery) this.refit(cal);
    else if (cal.sinceRefit % 20 === 0) this.save(cal);
  }

  private refit(cal: ModelCalibration): void {
    const learn = this.cfg.memory.similarity.learn;
    cal.sinceRefit = 0;
    for (const name of THRESHOLD_NAMES) {
      const items = cal.pairs.filter((p) => p.name === name || (name === "floor" && p.name === "conflict") || (name === "analogous" && p.name === "conflict"));
      if (items.length < 20) continue;
      const fitted = fitThreshold(items.map((p) => ({ score: p.score, positive: p.ok, w: p.w })), CALIBRATION_TARGETS[name]!.precision);
      if (fitted === null) continue;
      const cur = cal.thresholds[name];
      cal.thresholds[name] = Math.round(clamp(fitted, cur - learn.maxStep, cur + learn.maxStep) * 10000) / 10000;
      cal.samples[`${name}.learned`] = items.length;
    }
    cal.source = "learned";
    this.save(cal);
    this.telemetry?.event("calibration.refit", { model: cal.modelKey, thresholds: cal.thresholds });
  }

  status(): Array<{ kind: string; model: string; healthy: boolean; calibratedAt: string | null; source: string; thresholds: Record<string, number>; samples: Record<string, number> }> {
    const out: Array<{ kind: string; model: string; healthy: boolean; calibratedAt: string | null; source: string; thresholds: Record<string, number>; samples: Record<string, number> }> = [];
    for (const kind of ["late", "dense"] as const) {
      const client = kind === "late" ? this.late : this.dense;
      const c = this.calibration(kind);
      if (!client || !c) continue;
      out.push({ kind, model: client.model, healthy: client.healthy(), calibratedAt: c.calibratedAt, source: c.source, thresholds: c.thresholds, samples: c.samples });
    }
    return out;
  }

  // ───────────── encoding
  /** Encode a text with every reachable model. Never throws: missing vectors mean lexical matching. */
  async encode(text: string, role: "query" | "document", signal?: AbortSignal): Promise<Encoded> {
    const key = `${role}\u0000${sha256(text).slice(0, 24)}`;
    const cached = this.queryCache.get(key);
    if (cached) return cached;
    const out: Encoded = { text };
    const jobs: Array<Promise<void>> = [];
    if (this.late?.healthy()) {
      jobs.push(
        this.late.embed([text], role, signal).then(
          (m) => void (out.late = m[0]),
          () => undefined,
        ),
      );
    }
    if (this.dense?.healthy()) {
      jobs.push(
        this.dense.embed([text], role, signal).then(
          (v) => void (out.dense = v[0]),
          () => undefined,
        ),
      );
    }
    await Promise.all(jobs);
    if (this.queryCache.size > 256) this.queryCache.delete(this.queryCache.keys().next().value as string);
    this.queryCache.set(key, out);
    return out;
  }

  /** First-stage semantic search over one vector table. */
  searchVectors(vectors: VectorTables, q: Encoded, opts: { limit: number; floor?: boolean; filter?: (id: string) => boolean; only?: Set<string> }): { hits: Scored[]; mode: SimMode } {
    const li = this.cfg.index.lateInteraction;
    const lateKey = this.lateKey();
    if (q.late && lateKey && vectors.count("tokens", lateKey) > 0) {
      let hits = vectors.lateSearch(q.late, lateKey, { limit: opts.limit, exactMax: li.exactMax, candidates: li.candidates, filter: opts.filter, only: opts.only });
      if (opts.floor && this.calibration("late")?.calibratedAt) {
        const floor = this.threshold("floor", "late");
        hits = hits.filter((h) => h.score >= floor);
      }
      return { hits, mode: "late" };
    }
    const denseKey = this.denseKey();
    if (q.dense && denseKey) {
      const filter = opts.only ? (id: string) => opts.only!.has(id) && (!opts.filter || opts.filter(id)) : opts.filter;
      return { hits: vectors.denseSearch(q.dense, denseKey, { limit: opts.limit, filter, floor: opts.floor ? this.threshold("floor", "dense") : undefined }), mode: "dense" };
    }
    return { hits: [], mode: "lexical" };
  }

  /**
   * Symmetric similarity between a fresh document encoding and a stored node, on the scale of
   * the returned mode. Falls back to trigram Jaccard when no vectors are available.
   */
  pair(h: ScopeHandle, doc: Encoded, id: string, otherText: string): { sim: number; mode: SimMode } {
    const mode = this.thresholdMode();
    if (h.index) {
      if (mode === "late" && doc.late && this.lateKey()) {
        const s = h.index.vectors.symmetricWith(doc.late, id, this.lateKey()!);
        if (s !== null) return { sim: s, mode: "late" };
      }
      if ((mode === "late" || mode === "dense") && doc.dense && this.denseKey()) {
        const v = h.index.vectors.getDense(id, this.denseKey()!);
        if (v && v.length === doc.dense.length) return { sim: cosine(doc.dense, v), mode: "dense" };
      }
    }
    return { sim: trigramJaccard(doc.text, otherText), mode: "lexical" };
  }

  /** Similarity between two texts (Janus duplicate guard, fusion clusters). */
  async textPair(a: string, b: string, signal?: AbortSignal): Promise<{ sim: number; mode: SimMode }> {
    const mode = this.thresholdMode();
    if (mode !== "lexical") {
      const [ea, eb] = await Promise.all([this.encode(a, "document", signal), this.encode(b, "document", signal)]);
      if (mode === "late" && ea.late && eb.late) return { sim: symmetricMaxSim(ea.late, eb.late), mode: "late" };
      if (ea.dense && eb.dense) return { sim: cosine(ea.dense, eb.dense), mode: "dense" };
    }
    return { sim: trigramJaccard(a, b), mode: "lexical" };
  }

  encodedPair(a: Encoded, b: Encoded): { sim: number; mode: SimMode } {
    const mode = this.thresholdMode();
    if (mode === "late" && a.late && b.late) return { sim: symmetricMaxSim(a.late, b.late), mode: "late" };
    if (mode !== "lexical" && a.dense && b.dense) return { sim: cosine(a.dense, b.dense), mode: "dense" };
    return { sim: trigramJaccard(a.text, b.text), mode: "lexical" };
  }

  // ───────────── embedding work (§9.2.5): off the hot loop
  /** Embed memory nodes that have no vectors yet (or whose text changed). Returns how many were embedded. */
  async embedNodes(graph: MemoryGraph, opts: { limit?: number; signal?: AbortSignal } = {}): Promise<number> {
    let done = 0;
    const limit = opts.limit ?? 256;
    const li = this.cfg.index.lateInteraction;
    for (const scope of graph.visible()) {
      const h = graph.handle(scope);
      if (!h.index) continue;
      const keep = [this.lateKey(), this.denseKey()].filter((k): k is string => !!k);
      if (keep.length) h.index.vectors.dropOtherModels(keep);
      for (const kind of ["tokens", "dense"] as const) {
        const client = kind === "tokens" ? this.late : this.dense;
        if (!client?.healthy() || done >= limit) continue;
        const ids = h.index.pendingEmbeds(kind, client.key, limit - done);
        const nodes = ids.map((id) => h.store.sd.getNode(id)).filter((n): n is NonNullable<typeof n> => n !== null);
        if (!nodes.length) continue;
        try {
          const texts = nodes.map(embedText);
          if (kind === "tokens") {
            const out = await this.late!.embed(texts, "document", opts.signal);
            const slicer = createTimeSlicer(12, opts.signal);
            const prepared: Array<{ id: string; hash: string; data: NonNullable<ReturnType<VectorTables["prepareTokens"]>> }> = [];
            for (let i = 0; i < nodes.length; i++) {
              if (!(await slicer.check())) break;
              const n = nodes[i]!;
              const data = h.index.vectors.prepareTokens(out[i]!, li.quantize.memories, li.pool.memories);
              if (data) prepared.push({ id: n.id, hash: embedHash(n), data });
            }
            if (prepared.length) {
              h.index.db.transaction(() => {
                for (const item of prepared) h.index!.vectors.putPreparedTokens(item.id, client.key, item.hash, item.data);
              });
            }
            done += prepared.length;
            if (opts.signal?.aborted) break;
          } else {
            const out = await this.dense!.embed(texts, "document", opts.signal);
            h.index.db.transaction(() => nodes.forEach((n, i) => h.index!.vectors.putDense(n.id, client.key, embedHash(n), out[i]!)));
            done += nodes.length;
          }
        } catch (e) {
          this.telemetry?.event("embed.nodes_failed", { scope, kind, error: errMsg(e) });
        }
      }
    }
    return done;
  }

  /** Embed intent purposes of a scope (duplicate guard and importance). */
  async embedPurposes(h: ScopeHandle, signal?: AbortSignal): Promise<void> {
    if (!h.index) return;
    const rows = h.index.purposes();
    for (const kind of ["tokens", "dense"] as const) {
      const client = kind === "tokens" ? this.late : this.dense;
      if (!client?.healthy()) continue;
      const missing = new Set(h.index.purposeVectors.missing(kind, client.key, rows.map((r) => ({ id: r.id, hash: sha256(r.text).slice(0, 32) }))));
      const todo = rows.filter((r) => missing.has(r.id));
      if (!todo.length) continue;
      try {
        if (kind === "tokens") {
          const out = await this.late!.embed(todo.map((r) => r.text), "document", signal);
          todo.forEach((r, i) => h.index!.purposeVectors.putTokens(r.id, client.key, sha256(r.text).slice(0, 32), out[i]!, "int8", 1));
        } else {
          const out = await this.dense!.embed(todo.map((r) => r.text), "document", signal);
          todo.forEach((r, i) => h.index!.purposeVectors.putDense(r.id, client.key, sha256(r.text).slice(0, 32), out[i]!));
        }
      } catch {
        // purposes stay lexical until the endpoint recovers
      }
    }
  }

  /** Preload a scope's recent intent purposes once for batch importance scoring (e.g. hygiene). */
  preparePurposes(h: ScopeHandle): { mode: SimMode; texts: string[]; packed: PackedMatrix[]; dense: Float32Array[] } | null {
    if (!h.index) return null;
    const purposes = h.index.purposes();
    if (!purposes.length) return null;
    const mode = this.thresholdMode();
    const packed: PackedMatrix[] = [];
    const dense: Float32Array[] = [];
    if (mode === "late" && this.lateKey()) {
      const key = this.lateKey()!;
      for (const p of purposes) {
        const tok = h.index.purposeVectors.getTokens(p.id, key);
        if (tok && tok.rows > 0) packed.push(tok);
      }
    }
    if (mode !== "lexical" && this.denseKey()) {
      const key = this.denseKey()!;
      for (const p of purposes) {
        const pv = h.index.purposeVectors.getDense(p.id, key);
        if (pv) dense.push(pv);
      }
    }
    return { mode, texts: purposes.map((p) => p.text), packed, dense };
  }

  /** rel_i (§6.5.2): max similarity between a node and the scope's recent intent purposes, in [0, 1]. */
  relevanceToPurposes(h: ScopeHandle, nodeId: string, nodeText: string, prepared?: ReturnType<Similarity["preparePurposes"]>): number {
    if (!h.index) return 0;
    const prep = prepared === undefined ? this.preparePurposes(h) : prepared;
    if (!prep || !prep.texts.length) return 0;
    let best = 0;
    if (prep.mode === "late" && this.lateKey() && prep.packed.length) {
      const m = h.index.vectors.getTokens(nodeId, this.lateKey()!);
      if (m && m.rows > 0) {
        for (const p of prep.packed) {
          if (p.dims !== m.dims) continue;
          const s = symmetricMaxSimPacked(m, p);
          best = Math.max(best, this.toUnit(s, "late"));
        }
        return best;
      }
    }
    if (prep.mode !== "lexical" && this.denseKey() && prep.dense.length) {
      const v = h.index.vectors.getDense(nodeId, this.denseKey()!);
      if (v) {
        for (const pv of prep.dense) {
          if (pv.length === v.length) best = Math.max(best, clamp(cosine(v, pv), 0, 1));
        }
        return best;
      }
    }
    for (const text of prep.texts) best = Math.max(best, trigramJaccard(nodeText, text));
    return best;
  }

  /**
   * Embed turn-index rows: consolidated turns first, then raw chunks, newest first.
   * Token vectors are pooled ×2; raw turns older than `recentDays` use the 1-bit tier.
   */
  async embedTurns(turns: TurnIndex, opts: { limit?: number; signal?: AbortSignal } = {}): Promise<number> {
    const li = this.cfg.index.lateInteraction;
    const limit = opts.limit ?? 64;
    let done = 0;
    const cutoff = new Date(this.clock().getTime() - li.recentDays * 86_400_000).toISOString();
    for (const kind of ["tokens", "dense"] as const) {
      const client = kind === "tokens" ? this.late : this.dense;
      if (!client?.healthy() || done >= limit) continue;
      const rows = turns.pendingEmbeds(kind, client.key, limit - done).sort((a, b) => Number(a.kind === "raw") - Number(b.kind === "raw"));
      if (!rows.length) continue;
      try {
        if (kind === "tokens") {
          const out = await this.late!.embed(rows.map((r) => r.text), "document", opts.signal);
          const slicer = createTimeSlicer(12, opts.signal);
          const prepared: Array<{ id: string; hash: string; data: NonNullable<ReturnType<VectorTables["prepareTokens"]>> }> = [];
          for (let i = 0; i < rows.length; i++) {
            if (!(await slicer.check())) break;
            const r = rows[i]!;
            const quant = r.kind !== "raw" || r.at >= cutoff ? li.quantize.recentTurns : li.quantize.olderTurns;
            const data = turns.vectors.prepareTokens(out[i]!, quant, li.pool.turns);
            if (data) prepared.push({ id: r.id, hash: r.contentHash, data });
          }
          if (prepared.length) {
            turns.db.transaction(() => {
              for (const item of prepared) turns.vectors.putPreparedTokens(item.id, client.key, item.hash, item.data);
            });
          }
          done += prepared.length;
          if (opts.signal?.aborted) break;
        } else {
          const out = await this.dense!.embed(rows.map((r) => r.text), "document", opts.signal);
          turns.db.transaction(() => rows.forEach((r, i) => turns.vectors.putDense(r.id, client.key, r.contentHash, out[i]!)));
          done += rows.length;
        }
      } catch (e) {
        this.telemetry?.event("embed.turns_failed", { kind, error: errMsg(e) });
        break;
      }
    }
    if (this.lateKey()) turns.ageTokens(this.lateKey()!, li.recentDays, this.clock(), li.quantize.olderTurns);
    return done;
  }
}
