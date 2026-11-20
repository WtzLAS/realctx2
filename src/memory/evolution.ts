/**
 * Evolution (§6.6, EvoDisco): fusion as hygiene, the four strategy operators with layer rules,
 * the published fitness (U per attempt, E per window), the decision-model teacher, the rule
 * schedule, and semantic checks before any operator commits.
 */
import { join } from "node:path";
import type { DecisionQuestion, MemoryEdge, MemoryNode, Relation, ScopeName } from "../core/types.ts";
import { RELATIONS } from "../core/types.ts";
import { binaryP, choiceProbs } from "../providers/decision.ts";
import { errMsg } from "../util/errors.ts";
import { appendJsonl, readJsonl, writeFileAtomic } from "../util/fs.ts";
import { clamp, daysBetween, sanitize, trigramJaccard } from "../util/text.ts";
import type { Lifecycle } from "./lifecycle.ts";
import { type Action, type ActionDist, type Attempt, type EvolutionLog, HEAD_NAMES, HEADS, type Masks, MAX_CANDIDATES, type Operator, OPERATORS, type Policy, sampleFromDist } from "./policy.ts";
import type { Retriever } from "./retrieve.ts";
import { type MemoryServices, TIMEOUTS } from "./services.ts";
import type { SimMode } from "./similarity.ts";
import { memoryWorth, strengthAt } from "./strength.ts";
import { defaultUrgency } from "./urgency.ts";
import type { MemoryWriter } from "./write.ts";

export const NON_COMMIT_U = -0.05;
const FUSION_WINDOW_DAYS = 7;
const FUSION_MIN_MEMBERS = 3;
const PRESERVE_MIN = 0.8;

// ───────────────────────────── query cache 𝒬 (§6.6.5)

/** The last 200 unique `search` queries and kindled-intent purposes, first in, first out. Local only. */
export class QueryCache {
  private readonly file: string | null;
  private readonly cap: number;
  private entries: Array<{ q: string; scope: ScopeName }> | null = null;

  constructor(file: string | null, cap = 200) {
    this.file = file;
    this.cap = cap;
  }

  private load(): Array<{ q: string; scope: ScopeName }> {
    if (!this.entries) this.entries = this.file ? readJsonl<{ q: string; scope: ScopeName }>(this.file).filter((e) => typeof e.q === "string") : [];
    return this.entries;
  }

  add(query: string, scope: ScopeName): void {
    const q = query.trim().replace(/\s+/g, " ").slice(0, 400);
    if (!q) return;
    const list = this.load();
    const at = list.findIndex((e) => e.q === q && e.scope === scope);
    if (at >= 0) return;
    list.push({ q, scope });
    const perScope = list.filter((e) => e.scope === scope).length;
    if (perScope > this.cap) {
      list.splice(list.findIndex((e) => e.scope === scope), 1);
      if (this.file) writeFileAtomic(this.file, list.map((e) => JSON.stringify(e)).join("\n") + "\n");
    } else if (this.file) appendJsonl(this.file, { q, scope });
  }

  for(scope: ScopeName): string[] {
    return this.load().filter((e) => e.scope === scope).map((e) => e.q);
  }
}

export class QueryCaches {
  private readonly global: QueryCache;
  private readonly project: QueryCache | null;
  constructor(globalDir: string | null, projectDir: string | null) {
    this.global = new QueryCache(globalDir ? join(globalDir, "querycache.jsonl") : null);
    this.project = projectDir ? new QueryCache(join(projectDir, "querycache.jsonl")) : null;
  }
  /** Record a query against the scopes it touched. Query text never enters the shared store. */
  record(query: string, scopes: ScopeName[]): void {
    for (const scope of new Set(scopes)) {
      if (scope === "global") this.global.add(query, scope);
      else this.project?.add(query, scope);
    }
  }
  for(scope: ScopeName): string[] {
    return scope === "global" ? this.global.for(scope) : (this.project?.for(scope) ?? []);
  }
}

// ───────────────────────────── graph statistics

export interface GraphStats {
  nodes: number;
  short: number;
  long: number;
  edges: number;
  crossLayerShare: number;
  meanDegree: number;
  density: number;
  components: number;
  modularity: number;
  meanPathLength: number;
  hubs: number;
  longestChain: number;
  contradictPairs: number;
  supersededShare: number;
}

interface Candidates {
  abstract: Array<{ seed: MemoryNode; neighborhood: MemoryNode[] }>;
  refine: Array<{ hub: MemoryNode; degree: number }>;
  bridge: Array<{ a: MemoryNode; b: MemoryNode; sim: number; unit: number; mode: SimMode }>;
  reframe: Array<{ path: MemoryNode[]; edges: MemoryEdge[] }>;
  nearDuplicates: number;
}

export interface FusionReport {
  clusters: number;
  fused: string[];
  rejected: number;
}

export interface PassReport {
  scope: ScopeName;
  hygiene: ReturnType<Lifecycle["hygiene"]> | null;
  rechecked: number;
  fusion: FusionReport;
  attempts: Attempt[];
  stopped?: string;
}

export const FEATURE_DIM = 36;

export class Evolution {
  private readonly s: MemoryServices;
  private readonly retriever: Retriever;
  private readonly writer: MemoryWriter;
  private readonly lifecycle: Lifecycle;
  readonly caches: QueryCaches;
  readonly log: EvolutionLog;
  readonly policy: Policy | null;
  private readonly rnd: () => number;

  constructor(s: MemoryServices, deps: { retriever: Retriever; writer: MemoryWriter; lifecycle: Lifecycle; caches: QueryCaches; log: EvolutionLog; policy?: Policy | null; random?: () => number }) {
    this.s = s;
    this.retriever = deps.retriever;
    this.writer = deps.writer;
    this.lifecycle = deps.lifecycle;
    this.caches = deps.caches;
    this.log = deps.log;
    this.policy = deps.policy ?? null;
    this.rnd = deps.random ?? Math.random;
  }

  private active(scope: ScopeName): MemoryNode[] {
    return this.s.graph.sd(scope).allNodes().filter((n) => n.status === "active");
  }

  private localEdges(scope: ScopeName): MemoryEdge[] {
    return this.s.graph.sd(scope).allEdges().filter((e) => e.active && (!e.dstScope || e.dstScope === scope));
  }

  // ───────────── fitness (§6.6.4)
  /**
   * Q(G; 𝒬): over cached queries that activate at least one node, the mean of mean(top-3 activation).
   * A graph-local surrogate, not task performance.
   */
  async quality(scope: ScopeName, signal?: AbortSignal): Promise<{ Q: number; hitRate: number; diversity: number; latencyMs: number }> {
    const queries = this.caches.for(scope);
    if (!queries.length) return { Q: 0, hitRate: 0, diversity: 0, latencyMs: 0 };
    let sum = 0;
    let hits = 0;
    const seen = new Set<string>();
    let slots = 0;
    const t0 = Date.now();
    for (const q of queries) {
      if (signal?.aborted) break;
      const act = [...(await this.retriever.spread(q, { scopes: [scope], signal })).values()].sort((a, b) => b.a - a.a).slice(0, 3);
      if (!act.length) continue;
      hits++;
      sum += act.reduce((s, x) => s + x.a, 0) / act.length;
      for (const x of act) seen.add(x.ref.node.id);
      slots += act.length;
    }
    return { Q: hits ? sum / hits : 0, hitRate: hits / queries.length, diversity: slots ? seen.size / slots : 0, latencyMs: (Date.now() - t0) / queries.length };
  }

  stats(scope: ScopeName): GraphStats {
    const nodes = this.active(scope);
    const ids = new Set(nodes.map((n) => n.id));
    const edges = this.localEdges(scope).filter((e) => ids.has(e.src) && ids.has(e.dst));
    const layer = new Map(nodes.map((n) => [n.id, n.layer]));
    const adj = new Map<string, string[]>();
    for (const n of nodes) adj.set(n.id, []);
    for (const e of edges) {
      adj.get(e.src)!.push(e.dst);
      adj.get(e.dst)!.push(e.src);
    }
    // components and the modularity of the component partition
    const comp = new Map<string, number>();
    let components = 0;
    for (const n of nodes) {
      if (comp.has(n.id)) continue;
      const stack = [n.id];
      comp.set(n.id, components);
      while (stack.length) for (const o of adj.get(stack.pop()!)!) if (!comp.has(o)) {
        comp.set(o, components);
        stack.push(o);
      }
      components++;
    }
    let modularity = 0;
    if (edges.length) {
      const inside = new Array<number>(components).fill(0);
      const degree = new Array<number>(components).fill(0);
      for (const e of edges) {
        inside[comp.get(e.src)!]!++;
        degree[comp.get(e.src)!]!++;
        degree[comp.get(e.dst)!]!++;
      }
      for (let c = 0; c < components; c++) modularity += inside[c]! / edges.length - (degree[c]! / (2 * edges.length)) ** 2;
    }
    // mean path length, sampled by BFS from up to 16 nodes
    let pathSum = 0;
    let pathCount = 0;
    const step = Math.max(1, Math.floor(nodes.length / 16));
    for (let i = 0; i < nodes.length; i += step) {
      const dist = new Map<string, number>([[nodes[i]!.id, 0]]);
      const queue = [nodes[i]!.id];
      for (let qi = 0; qi < queue.length; qi++) {
        const cur = queue[qi]!;
        for (const o of adj.get(cur)!) if (!dist.has(o)) {
          dist.set(o, dist.get(cur)! + 1);
          queue.push(o);
        }
      }
      for (const d of dist.values()) if (d > 0) {
        pathSum += d;
        pathCount++;
      }
    }
    const degrees = nodes.map((n) => adj.get(n.id)!.length);
    const meanDegree = nodes.length ? degrees.reduce((a, b) => a + b, 0) / nodes.length : 0;
    const sd = Math.sqrt(nodes.length ? degrees.reduce((a, b) => a + (b - meanDegree) ** 2, 0) / nodes.length : 0);
    // longest chain of precedes/causes edges
    const next = new Map<string, string[]>();
    for (const e of edges) if (e.rel === "precedes" || e.rel === "causes") next.set(e.src, [...(next.get(e.src) ?? []), e.dst]);
    const memo = new Map<string, number>();
    const chain = (id: string, guard: Set<string>): number => {
      if (memo.has(id)) return memo.get(id)!;
      if (guard.has(id)) return 0;
      guard.add(id);
      let best = 0;
      for (const o of next.get(id) ?? []) best = Math.max(best, 1 + chain(o, guard));
      guard.delete(id);
      memo.set(id, best);
      return best;
    };
    let longestChain = 0;
    for (const id of next.keys()) longestChain = Math.max(longestChain, chain(id, new Set()));
    const contradict = new Set<string>();
    let superseded = 0;
    for (const e of edges) {
      if (e.rel === "contradicts") contradict.add([e.src, e.dst].sort().join("|"));
      if (e.rel === "supersedes") superseded++;
    }
    return {
      nodes: nodes.length,
      short: nodes.filter((n) => n.layer === "short").length,
      long: nodes.filter((n) => n.layer === "long").length,
      edges: edges.length,
      crossLayerShare: edges.length ? edges.filter((e) => layer.get(e.src) !== layer.get(e.dst)).length / edges.length : 0,
      meanDegree,
      density: nodes.length > 1 ? edges.length / (nodes.length * (nodes.length - 1)) : 0,
      components,
      modularity,
      meanPathLength: pathCount ? pathSum / pathCount : 0,
      hubs: degrees.filter((d) => d >= 3 && d > meanDegree + 2 * sd).length,
      longestChain,
      contradictPairs: contradict.size,
      supersededShare: nodes.length ? superseded / nodes.length : 0,
    };
  }

  /** C(G) = λᵀ · [node count, edge density, mean path length]. */
  cost(st: GraphStats): number {
    const [l0, l1, l2] = this.s.cfg.evolution.hyper.lambda;
    return l0 * st.nodes + l1 * st.density + l2 * st.meanPathLength;
  }

  /** State features s (§6.6.3). */
  features(scope: ScopeName, st: GraphStats, q: { hitRate: number; diversity: number; latencyMs: number }, cands: Candidates, recent: Attempt[]): number[] {
    const nodes = this.active(scope);
    let delivered = 0;
    let used = 0;
    let ignored = 0;
    let mw = 0;
    for (const n of nodes) {
      delivered += n.counters.delivered;
      used += n.counters.used;
      ignored += n.counters.ignoredRelevant;
      mw += memoryWorth(n.counters).mw;
    }
    const lastOp = recent.at(-1)?.a.operator;
    const meanU = (op: Operator) => {
      const us = recent.filter((a) => a.a.operator === op).slice(-8).map((a) => a.U);
      return us.length ? us.reduce((x, y) => x + y, 0) / us.length : 0;
    };
    const outcomes = this.log.outcomes(scope);
    const phase = this.policy?.state.phase ?? "T0";
    const n = Math.max(1, st.nodes);
    const f = [
      Math.log1p(st.short) / 8,
      Math.log1p(st.long) / 8,
      Math.log1p(st.edges) / 8,
      st.crossLayerShare,
      Math.min(1, st.meanDegree / 8),
      st.modularity,
      Math.min(1, st.meanPathLength / 8),
      Math.min(1, q.latencyMs / 100),
      q.hitRate,
      q.diversity,
      delivered > 0 ? Math.min(1, used / delivered) : 0,
      delivered > 0 ? Math.min(1, ignored / delivered) : 0,
      nodes.length ? mw / nodes.length : 0.5,
      Math.min(1, st.supersededShare),
      ...OPERATORS.map((op) => (lastOp === op ? 1 : 0)),
      ...OPERATORS.map((op) => clamp(meanU(op), -1, 1)),
      outcomes.length ? outcomes.reduce((a, b) => a + b, 0) / outcomes.length : 0.5,
      Math.min(1, st.hubs / n),
      Math.min(1, (st.components - 1) / n),
      Math.min(1, st.longestChain / 10),
      Math.min(1, cands.nearDuplicates / n),
      Math.min(1, st.contradictPairs / n),
      scope === "global" ? 1 : 0,
      scope === "personal" ? 1 : 0,
      scope === "shared" ? 1 : 0,
      phase === "T0" ? 1 : 0,
      phase === "T1" ? 1 : 0,
      phase === "T2" ? 1 : 0,
      Math.min(1, cands.abstract.length / MAX_CANDIDATES),
      Math.min(1, cands.refine.length / MAX_CANDIDATES),
    ];
    while (f.length < FEATURE_DIM) f.push(0);
    return f.slice(0, FEATURE_DIM);
  }

  // ───────────── candidates (§6.6.2; at most 8 per operator)
  private pairSim(scope: ScopeName, a: MemoryNode, b: MemoryNode): { sim: number; unit: number; mode: SimMode } {
    const h = this.s.graph.handle(scope);
    const sim = this.s.sim;
    const mode = sim.thresholdMode();
    if (h.index) {
      if (mode === "late" && sim.lateKey()) {
        const m = h.index.vectors.getMatrix(a.id, sim.lateKey()!);
        const v = m ? h.index.vectors.symmetricWith(m, b.id, sim.lateKey()!) : null;
        if (v !== null) return { sim: v, unit: sim.toUnit(v, "late"), mode: "late" };
      }
      if (mode !== "lexical" && sim.denseKey()) {
        const va = h.index.vectors.getDense(a.id, sim.denseKey()!);
        const vb = h.index.vectors.getDense(b.id, sim.denseKey()!);
        if (va && vb && va.length === vb.length) {
          let d = 0;
          for (let i = 0; i < va.length; i++) d += va[i]! * vb[i]!;
          return { sim: d, unit: clamp(d, 0, 1), mode: "dense" };
        }
      }
    }
    const v = trigramJaccard(a.text, b.text);
    return { sim: v, unit: v, mode: "lexical" };
  }

  private threshold(name: "fusion" | "floor" | "analogous", scope: ScopeName, a: MemoryNode, b: MemoryNode): { ok: boolean; sim: number; unit: number; mode: SimMode } {
    const p = this.pairSim(scope, a, b);
    // without vectors, "above the floor" means sharing real wording
    const t = p.mode === "lexical" && name === "floor" ? 0.2 : this.s.sim.threshold(name, p.mode);
    return { ok: p.sim >= t, ...p };
  }

  /** Nearest neighbours of a node by the active similarity model (or BM25 without one). */
  private nearest(scope: ScopeName, node: MemoryNode, limit: number): MemoryNode[] {
    const h = this.s.graph.handle(scope);
    if (!h.index) return [];
    const sd = h.store.sd;
    const sim = this.s.sim;
    const ok = (id: string) => id !== node.id && sd.getNode(id)?.status === "active";
    let ids: string[] = [];
    if (sim.lateKey() && sim.searchMode() === "late") {
      const m = h.index.vectors.getMatrix(node.id, sim.lateKey()!);
      if (m) ids = h.index.vectors.lateSearch(m, sim.lateKey()!, { limit, exactMax: this.s.cfg.index.lateInteraction.exactMax, candidates: this.s.cfg.index.lateInteraction.candidates, filter: ok }).map((x) => x.id);
    }
    if (!ids.length && sim.denseKey()) {
      const v = h.index.vectors.getDense(node.id, sim.denseKey()!);
      if (v) ids = h.index.vectors.denseSearch(v, sim.denseKey()!, { limit, filter: ok }).map((x) => x.id);
    }
    if (!ids.length) ids = h.index.bm25(node.text, { limit: limit + 1 }).map((x) => x.id).filter(ok);
    return ids.map((id) => sd.getNode(id)).filter((n): n is MemoryNode => !!n).slice(0, limit);
  }

  candidates(scope: ScopeName): Candidates {
    const g = this.s.graph;
    const nodes = this.active(scope);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const edges = this.localEdges(scope).filter((e) => byId.has(e.src) && byId.has(e.dst));
    const adj = new Map<string, Set<string>>();
    for (const n of nodes) adj.set(n.id, new Set());
    for (const e of edges) {
      adj.get(e.src)!.add(e.dst);
      adj.get(e.dst)!.add(e.src);
    }
    const hood = (id: string, hops: number): MemoryNode[] => {
      const seen = new Set([id]);
      let frontier = [id];
      for (let h = 0; h < hops; h++) {
        const next: string[] = [];
        for (const cur of frontier) for (const o of adj.get(cur) ?? []) if (!seen.has(o)) {
          seen.add(o);
          next.push(o);
        }
        frontier = next;
      }
      seen.delete(id);
      return [...seen].map((x) => byId.get(x)!);
    };
    // Abstract: seeds whose 2-hop neighbourhood holds at least 2 nodes
    const generalized = new Set(edges.filter((e) => e.rel === "generalizes").map((e) => e.dst));
    const concepts = new Set(edges.filter((e) => e.rel === "generalizes").map((e) => e.src));
    const abstract = nodes
      .filter((n) => !concepts.has(n.id) && !generalized.has(n.id) && n.kind !== "rule")
      .map((seed) => ({ seed, neighborhood: hood(seed.id, 2).filter((m) => !concepts.has(m.id)) }))
      .filter((c) => c.neighborhood.length >= 2)
      .sort((a, b) => b.neighborhood.length + Math.log1p(b.seed.counters.retrieved) + b.seed.counters.used - (a.neighborhood.length + Math.log1p(a.seed.counters.retrieved) + a.seed.counters.used))
      .slice(0, MAX_CANDIDATES);
    // Refine: hubs by layer-weighted degree
    const degree = g.weightedDegree(scope);
    const parents = new Set(edges.filter((e) => e.rel === "part-of").map((e) => e.dst));
    const refine = nodes
      .filter((n) => !parents.has(n.id) && (adj.get(n.id)?.size ?? 0) >= 2 && n.text.split(/\s+/).length >= 12 && n.origin !== "instructions")
      .map((hub) => ({ hub, degree: degree.get(hub.id) ?? 0 }))
      .sort((a, b) => b.degree - a.degree)
      .slice(0, MAX_CANDIDATES);
    // Bridge: non-adjacent pairs, ranked by similarity
    const pairs = new Map<string, { a: MemoryNode; b: MemoryNode; sim: number; unit: number; mode: SimMode }>();
    let nearDuplicates = 0;
    const pool = [...nodes].sort((a, b) => (a.lastAccessAt < b.lastAccessAt ? 1 : -1)).slice(0, 60);
    for (const a of pool) {
      for (const b of this.nearest(scope, a, 4)) {
        const key = [a.id, b.id].sort().join("|");
        if (pairs.has(key)) continue;
        const t = this.threshold("floor", scope, a, b);
        if (this.threshold("fusion", scope, a, b).ok && a.kind === b.kind) nearDuplicates++;
        if (adj.get(a.id)!.has(b.id) || !t.ok) continue;
        pairs.set(key, { a, b, sim: t.sim, unit: t.unit, mode: t.mode });
      }
    }
    let bridge = [...pairs.values()].sort((x, y) => y.sim - x.sim).slice(0, MAX_CANDIDATES);
    if (!bridge.length && nodes.length >= 6) {
      const split = this.twoMeans(scope, nodes);
      if (split && !adj.get(split.a.id)!.has(split.b.id)) bridge = [{ ...split, ...this.pairSim(scope, split.a, split.b) }];
    }
    // Reframe: existing paths of causes/precedes edges
    const chainEdges = edges.filter((e) => e.rel === "causes" || e.rel === "precedes");
    const out = new Map<string, MemoryEdge[]>();
    const hasIn = new Set<string>();
    for (const e of chainEdges) {
      out.set(e.src, [...(out.get(e.src) ?? []), e]);
      hasIn.add(e.dst);
    }
    const reframe: Candidates["reframe"] = [];
    for (const start of out.keys()) {
      if (hasIn.has(start) && out.size > 1) continue;
      const path = [byId.get(start)!];
      const used: MemoryEdge[] = [];
      const seen = new Set([start]);
      let cur = start;
      for (;;) {
        const e = (out.get(cur) ?? []).find((x) => !seen.has(x.dst));
        if (!e) break;
        used.push(e);
        path.push(byId.get(e.dst)!);
        seen.add(e.dst);
        cur = e.dst;
      }
      if (used.length >= 1) reframe.push({ path, edges: used });
    }
    reframe.sort((a, b) => b.edges.length - a.edges.length);
    return { abstract, refine, bridge, reframe: reframe.slice(0, MAX_CANDIDATES), nearDuplicates };
  }

  /** One pair from a two-means split of the scope's dense vectors (Bridge's last resort). */
  private twoMeans(scope: ScopeName, nodes: MemoryNode[]): { a: MemoryNode; b: MemoryNode } | null {
    const h = this.s.graph.handle(scope);
    const key = this.s.sim.denseKey();
    const vecs = h.index && key ? nodes.map((n) => ({ n, v: h.index!.vectors.getDense(n.id, key) })).filter((x): x is { n: MemoryNode; v: Float32Array } => !!x.v) : [];
    if (vecs.length < 6) {
      // without vectors: the oldest and the newest node stand in for the two halves
      const sorted = [...nodes].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
      return sorted.length >= 2 ? { a: sorted[0]!, b: sorted[sorted.length - 1]! } : null;
    }
    const dims = vecs[0]!.v.length;
    let c0 = Float32Array.from(vecs[0]!.v);
    let c1 = Float32Array.from(vecs[vecs.length - 1]!.v);
    const dot = (a: Float32Array, b: Float32Array) => {
      let d = 0;
      for (let i = 0; i < dims; i++) d += a[i]! * b[i]!;
      return d;
    };
    let assign: number[] = [];
    for (let iter = 0; iter < 6; iter++) {
      assign = vecs.map((x) => (dot(x.v, c0) >= dot(x.v, c1) ? 0 : 1));
      const sums = [new Float32Array(dims), new Float32Array(dims)];
      const counts = [0, 0];
      vecs.forEach((x, i) => {
        counts[assign[i]!]!++;
        for (let d = 0; d < dims; d++) sums[assign[i]!]![d]! += x.v[d]!;
      });
      if (!counts[0] || !counts[1]) return null;
      c0 = sums[0]!.map((x) => x / counts[0]!);
      c1 = sums[1]!.map((x) => x / counts[1]!);
    }
    const best = (c: Float32Array, which: number) => vecs.filter((_, i) => assign[i] === which).sort((x, y) => dot(y.v, c) - dot(x.v, c))[0]?.n;
    const a = best(c0, 0);
    const b = best(c1, 1);
    return a && b ? { a, b } : null;
  }

  masks(c: Candidates): Masks {
    const counts = { abstract: c.abstract.length, refine: c.refine.length, bridge: c.bridge.length, reframe: c.reframe.length };
    return { operators: OPERATORS.map((op) => counts[op] > 0), candidates: counts };
  }

  // ───────────── who acts
  private summarize(op: Operator, c: Candidates, i: number): string {
    const head = (n: MemoryNode) => `"${n.title.slice(0, 80)}" (${n.layer === "long" ? "long" : "short"}, used ${Math.round(n.counters.used)}×)`;
    if (op === "abstract") return `seed ${head(c.abstract[i]!.seed)} with ${c.abstract[i]!.neighborhood.length} neighbours: ${c.abstract[i]!.neighborhood.slice(0, 4).map((n) => `"${n.title.slice(0, 50)}"`).join("; ")}`;
    if (op === "refine") return `hub ${head(c.refine[i]!.hub)}, weighted degree ${c.refine[i]!.degree.toFixed(1)}, ${c.refine[i]!.hub.text.split(/\s+/).length} words`;
    if (op === "bridge") return `${head(c.bridge[i]!.a)} ↔ ${head(c.bridge[i]!.b)}, similarity ${c.bridge[i]!.unit.toFixed(2)}`;
    return `path of ${c.reframe[i]!.edges.length} edge(s) [${c.reframe[i]!.edges.map((e) => e.rel).join(", ")}]: ${c.reframe[i]!.path.map((n) => `"${n.title.slice(0, 40)}"`).join(" → ")}`;
  }

  /** The teacher answers the whole choice in one request, with probabilities over every option (§6.6.6). */
  async teacher(scope: ScopeName, st: GraphStats, c: Candidates, masks: Masks, signal?: AbortSignal): Promise<ActionDist | null> {
    if (!this.s.cfg.evolution.teacher || !this.s.decision.available() || !this.s.decision.calibrated()) return null;
    const ops = OPERATORS.filter((_, i) => masks.operators[i]);
    if (!ops.length) return null;
    const describe: Record<Operator, string> = {
      abstract: "create a concept that generalizes a cluster of related memories",
      refine: "split an overloaded hub memory into focused children",
      bridge: "connect two related but unlinked memories with a typed edge",
      reframe: "rewrite the edge types along a causal or temporal path",
    };
    const questions: DecisionQuestion[] = [{ kind: "choice", name: "operator", instructions: "Which maintenance operator would improve this memory graph most right now?", options: ops.map((o) => ({ value: o, description: describe[o] })) }];
    for (const op of ops) {
      questions.push({ kind: "choice", name: `cand.${op}`, instructions: `If the operator is ${op}, which candidate should it act on?`, options: Array.from({ length: masks.candidates[op] }, (_, i) => ({ value: `c${i}`, description: this.summarize(op, c, i) })) });
    }
    const headText: Record<string, string> = { k: "Abstract: how many hops of neighbours to generalize over?", p: "Abstract/Bridge: how aggressively to prune or cut off (0 keeps everything)?", m: "Refine: how many children?", dimension: "Refine: along which dimension?", frame: "Reframe: which rewrite?" };
    for (const h of HEAD_NAMES) questions.push({ kind: "choice", name: h, instructions: headText[h]!, options: HEADS[h].map((v) => ({ value: String(v) })) });
    const evidence = {
      scope,
      graph: { nodes: st.nodes, shortTerm: st.short, longTerm: st.long, edges: st.edges, components: st.components, hubs: st.hubs, longestChain: st.longestChain, nearDuplicatePairs: c.nearDuplicates, openContradictions: st.contradictPairs, meanDegree: Number(st.meanDegree.toFixed(2)) },
    };
    const answers = await this.s.decision.decide(evidence, questions, { callSite: "evo.teacher", timeoutMs: TIMEOUTS.teacher, signal });
    const opProbs = choiceProbs(answers, "operator");
    if (!opProbs) return null;
    const dist: ActionDist = { operator: OPERATORS.map((o) => opProbs[o] ?? 0), candidate: {}, heads: {} };
    for (const op of ops) {
      const p = choiceProbs(answers, `cand.${op}`);
      if (p) dist.candidate[op] = Array.from({ length: MAX_CANDIDATES }, (_, i) => p[`c${i}`] ?? 0);
    }
    for (const h of HEAD_NAMES) {
      const p = choiceProbs(answers, h);
      if (p) dist.heads[h] = HEADS[h].map((v) => p[String(v)] ?? 0);
    }
    return dist;
  }

  /**
   * The fixed rule schedule that replaces the teacher without a decision model (§6.6.6):
   * Abstract when near-duplicates or dense clusters exist, Refine on the top hub, Bridge when
   * components are disconnected, Reframe on the longest chain.
   */
  ruleAction(st: GraphStats, c: Candidates, masks: Masks, round: number, usedSoFar: Record<Operator, number>): Action | null {
    const applicable: Operator[] = [];
    if (masks.operators[0] && (c.nearDuplicates > 0 || c.abstract.some((a) => a.neighborhood.length >= 3))) applicable.push("abstract");
    if (masks.operators[1]) applicable.push("refine");
    if (masks.operators[2] && (st.components > 1 || c.bridge.length > 0)) applicable.push("bridge");
    if (masks.operators[3]) applicable.push("reframe");
    const open = applicable.filter((op) => usedSoFar[op] < masks.candidates[op]);
    if (!open.length) return null;
    const operator = open[round % open.length]!;
    return { operator, candidate: usedSoFar[operator], k: 2, p: 0, m: 2, dimension: "categorical", frame: "temporal_to_causal" };
  }

  // ───────────── semantic check (§6.6.7)
  private async check(question: string, evidence: object, signal?: AbortSignal): Promise<boolean> {
    // fail-safe: veto
    if (!this.s.decision.available()) return false;
    const answers = await this.s.decision.decide(evidence, [{ kind: "binary", name: "valid", instructions: question }], { callSite: "evo.check", timeoutMs: TIMEOUTS.check, signal });
    const p = binaryP(answers, "valid");
    return p !== undefined && p >= 0.5;
  }

  // ───────────── operators
  private async abstract(scope: ScopeName, cand: Candidates["abstract"][number], a: Action, signal?: AbortSignal): Promise<{ committed: boolean; vetoed?: boolean; detail: string }> {
    const g = this.s.graph;
    const sd = g.sd(scope);
    const hoodK = a.k >= 2 ? cand.neighborhood : cand.neighborhood.filter((n) => g.neighbors({ scope, node: cand.seed }, { activeOnly: true }).some((x) => x.other.node.id === n.id));
    const members = [cand.seed, ...hoodK].slice(0, a.k >= 3 ? 8 : 6);
    if (members.length < 2 || !this.s.aux?.available()) return { committed: false, detail: "abstract: no aux model or too few members" };
    const res = await this.s.aux.run<{ kind: string; title: string; text: string; redundant?: string[] }>({
      role: "evo.operator",
      instructions:
        "Write ONE concept (or procedure) that generalizes the member memories: it must be true of every member and say what they have in common, without adding facts that are in none of them. Then list the IDs of members that the concept fully covers (they add nothing beyond it).",
      data: members.map((m) => ({ label: `MEMBER ${m.id}`, text: `${m.title}\n${m.text}` })),
      schema: { type: "object", additionalProperties: false, required: ["kind", "title", "text"], properties: { kind: { type: "string", enum: ["concept", "procedure"] }, title: { type: "string" }, text: { type: "string" }, redundant: { type: "array", items: { type: "string" } } } },
      signal,
    });
    const out = res.output;
    if (!out?.text?.trim()) return { committed: false, detail: "abstract: no output" };
    const text = sanitize(out.text.trim());
    if (!(await this.check("Is this concept true of every member?", { concept: text, members: members.map((m) => m.text.slice(0, 600)) }, signal))) return { committed: false, vetoed: true, detail: "abstract: vetoed" };
    // layer rule: long-term if at least half the members are, or their total attributed use is ≥ 3
    const longShare = members.filter((m) => m.layer === "long").length / members.length;
    const totalUse = members.reduce((s, m) => s + m.counters.used, 0);
    const kind = out.kind === "procedure" ? "procedure" : "concept";
    const [w] = await this.writer.write([{ text, title: out.title, kind, origin: "operator", scope, layer: longShare >= 0.5 || totalUse >= 3 ? "long" : "short", urgency: defaultUrgency(kind), urgencyBy: "default", skipConflicts: true, skipDedup: true, keep: true }], { signal });
    if (w?.status !== "created" || !w.id) return { committed: false, detail: `abstract: write ${w?.status}` };
    const concept = { scope, node: sd.getNode(w.id)! };
    const nowIso = this.s.clock().toISOString();
    for (const m of members) g.link(concept, "generalizes", { scope, node: m }, { w: 0.7 });
    let archived = 0;
    if (a.p > 0) {
      const redundant = new Set((out.redundant ?? []).map((x) => String(x).replace(/^\[?m:/, "").replace(/\]$/, "")));
      const cap = Math.floor(members.length * a.p);
      for (const m of members) {
        if (archived >= cap || !redundant.has(m.id) || m.pinned) continue;
        // redundant members are archived as children of the concept, not deleted
        sd.patchNode(m.id, { status: "archived", statusReason: `abstracted into m:${w.id}`, statusAt: nowIso });
        g.setEdgesActive({ scope, node: sd.getNode(m.id)! }, false);
        archived++;
      }
    }
    return { committed: true, detail: `abstract: m:${w.id} over ${members.length} members${archived ? `, ${archived} archived` : ""}` };
  }

  private async refine(scope: ScopeName, cand: Candidates["refine"][number], a: Action, signal?: AbortSignal): Promise<{ committed: boolean; vetoed?: boolean; detail: string }> {
    const g = this.s.graph;
    const sd = g.sd(scope);
    const parent = cand.hub;
    if (!this.s.aux?.available()) return { committed: false, detail: "refine: no aux model" };
    const res = await this.s.aux.run<{ children: Array<{ title: string; text: string }> }>({
      role: "evo.operator",
      instructions: `Split the PARENT memory into exactly ${a.m} focused child memories along the ${a.dimension} dimension (${a.dimension === "temporal" ? "ordered steps or phases" : a.dimension === "causal" ? "a chain of cause and effect" : "distinct sub-kinds or sub-cases"}). Together the children must preserve every claim of the parent; add nothing new. Each child stands alone. Return them in order.`,
      data: [{ label: "PARENT", text: `${parent.title}\n${parent.text}` }],
      schema: { type: "object", additionalProperties: false, required: ["children"], properties: { children: { type: "array", minItems: 2, maxItems: 4, items: { type: "object", additionalProperties: false, required: ["title", "text"], properties: { title: { type: "string" }, text: { type: "string" } } } } } },
      signal,
    });
    const kids = (res.output?.children ?? []).filter((c) => c && typeof c.text === "string" && c.text.trim()).slice(0, a.m);
    if (kids.length < 2) return { committed: false, detail: "refine: no usable children" };
    if (!(await this.check("Do the children together preserve every claim of the parent?", { parent: parent.text, children: kids.map((k) => k.text) }, signal))) return { committed: false, vetoed: true, detail: "refine: vetoed" };
    // map past uses of the parent onto the children (one choice per use); fail-safe: children go short-term
    const covered = new Set<number>();
    const uses = parent.counters.used > 0 ? this.caches.for(scope).slice(-40) : [];
    if (uses.length && this.s.decision.available()) {
      const relevant: string[] = [];
      for (const q of uses) {
        if (relevant.length >= 8) break;
        const act = await this.retriever.spread(q, { scopes: [scope], signal });
        if (act.get(`${scope}:${parent.id}`)?.seed) relevant.push(q);
      }
      if (relevant.length) {
        const questions: DecisionQuestion[] = relevant.map((_, u) => ({ kind: "choice", name: `map.${u}`, instructions: `Which child covers what past use ${u} needed from the parent?`, options: [...kids.map((_, i) => ({ value: `child${i}` })), { value: "none" }] }));
        const answers = await this.s.decision.decide({ parent: parent.text, children: kids.map((k, i) => ({ i, text: k.text })), pastUses: relevant.map((q, u) => ({ u, query: q })) }, questions, { callSite: "evo.refine_map", timeoutMs: TIMEOUTS.check, signal });
        relevant.forEach((_, u) => {
          const p = choiceProbs(answers, `map.${u}`);
          const best = p ? Object.entries(p).sort((x, y) => y[1] - x[1])[0]?.[0] : undefined;
          if (best?.startsWith("child")) covered.add(Number(best.slice(5)));
        });
      }
    }
    const written = await this.writer.write(
      kids.map((k, i) => ({ text: k.text, title: k.title, kind: parent.kind, origin: "operator" as const, scope, layer: covered.has(i) ? parent.layer : ("short" as const), urgency: parent.urgency, urgencyBy: "default" as const, severity: parent.severity, anchors: parent.anchors, evidence: parent.evidence.map((e) => ({ quote: e.quote, source: e.source, time: e.time })), sourceTexts: parent.evidence.filter((e) => e.verified).map((e) => e.quote), skipConflicts: true, skipDedup: true, keep: true })),
      { signal },
    );
    const children = written.filter((w) => w.status === "created" && w.id).map((w) => ({ scope, node: sd.getNode(w.id!)! }));
    if (children.length < 2) return { committed: false, detail: "refine: children were not written" };
    const self = { scope, node: sd.getNode(parent.id)! };
    children.forEach((child, i) => {
      g.link(child, "part-of", self, { w: 0.8 });
      if (a.dimension === "categorical") g.link(child, "is-a", self, { w: 0.6 });
      else if (i > 0) g.link(children[i - 1]!, a.dimension === "temporal" ? "precedes" : "causes", child, { w: 0.6 });
    });
    // the parent stays as a summary if it has attributed use; otherwise it is replaced
    let replaced = false;
    if (!(parent.counters.used > 0) && !parent.pinned) {
      sd.patchNode(parent.id, { status: "archived", statusReason: `refined into ${children.map((c) => `m:${c.node.id}`).join(", ")}`, statusAt: this.s.clock().toISOString() });
      g.setEdgesActive({ scope, node: sd.getNode(parent.id)! }, false);
      replaced = true;
    }
    return { committed: true, detail: `refine: m:${parent.id} → ${children.length} children (${a.dimension})${replaced ? ", parent replaced" : ""}` };
  }

  private async bridge(scope: ScopeName, cand: Candidates["bridge"][number], a: Action, signal?: AbortSignal): Promise<{ committed: boolean; vetoed?: boolean; detail: string }> {
    const g = this.s.graph;
    const sim = this.s.sim;
    // p sets the similarity cutoff (a fixed rule): 0 → the retrieval floor, 0.5 → the analogy threshold
    if (a.p > 0 && !this.threshold("analogous", scope, cand.a, cand.b).ok) return { committed: false, detail: "bridge: below the cutoff" };
    let rel: Relation | null = null;
    let forward = true;
    if (this.s.aux?.available()) {
      const res = await this.s.aux.run<{ rel: string; direction: string }>({
        role: "evo.operator",
        instructions: `Pick the relation that holds between memory A and memory B, or "none". Relations: causes (A causes B), precedes (A happens or should happen before B), analogous-to (similar situation or solution), is-a (A is a kind of B), part-of (A is a component or sub-case of B), contradicts (unresolved conflict). direction is "a_to_b" or "b_to_a".`,
        data: [
          { label: "A", text: cand.a.text },
          { label: "B", text: cand.b.text },
        ],
        schema: { type: "object", additionalProperties: false, required: ["rel", "direction"], properties: { rel: { type: "string", enum: ["causes", "precedes", "analogous-to", "is-a", "part-of", "contradicts", "none"] }, direction: { type: "string", enum: ["a_to_b", "b_to_a"] } } },
          signal,
      });
      const r = res.output?.rel;
      if (r && r !== "none" && (RELATIONS as string[]).includes(r)) {
        rel = r as Relation;
        forward = res.output?.direction !== "b_to_a";
      }
    } else if (cand.sim >= sim.threshold("analogous", cand.mode)) rel = "analogous-to";
    if (!rel) return { committed: false, detail: "bridge: no relation" };
    const [src, dst] = forward ? [cand.a, cand.b] : [cand.b, cand.a];
    if (!(await this.check(`Are A and B related by "${rel}" (A ${rel} B)?`, { A: src.text, B: dst.text }, signal))) return { committed: false, vetoed: true, detail: `bridge: ${rel} vetoed` };
    g.link({ scope, node: src }, rel, { scope, node: dst }, { w: clamp(cand.unit, 0.3, 1) });
    if (rel === "contradicts") g.link({ scope, node: dst }, rel, { scope, node: src }, { w: clamp(cand.unit, 0.3, 1) });
    return { committed: true, detail: `bridge: m:${src.id} ${rel} m:${dst.id}` };
  }

  private async reframe(scope: ScopeName, cand: Candidates["reframe"][number], a: Action, signal?: AbortSignal): Promise<{ committed: boolean; vetoed?: boolean; detail: string }> {
    const sd = this.s.graph.sd(scope);
    const from: Relation = a.frame === "temporal_to_causal" ? "precedes" : "causes";
    const targets = cand.edges.filter((e) => e.rel === from);
    if (!targets.length) return { committed: false, detail: `reframe: no ${from} edges on the path` };
    const rewritten = targets.map((e) => (a.frame === "temporal_to_causal" ? { src: e.src, dst: e.dst, rel: "causes" as Relation } : a.frame === "causal_to_temporal" ? { src: e.src, dst: e.dst, rel: "precedes" as Relation } : { src: e.dst, dst: e.src, rel: "causes" as Relation }));
    const text = (id: string) => sd.getNode(id)?.text.slice(0, 500) ?? "";
    if (!(await this.check("Is the rewritten path consistent with the node texts?", { rewrite: a.frame, edges: rewritten.map((r) => ({ from: text(r.src), relation: r.rel, to: text(r.dst) })) }, signal))) return { committed: false, vetoed: true, detail: "reframe: vetoed" };
    // node text and node count stay the same; only edge types (or directions) change
    targets.forEach((e, i) => {
      sd.deleteEdge(e.id);
      sd.putEdge({ src: rewritten[i]!.src, dst: rewritten[i]!.dst, rel: rewritten[i]!.rel, w: e.w, evidenceAt: this.s.clock().toISOString(), active: true });
    });
    return { committed: true, detail: `reframe: ${targets.length} edge(s) ${a.frame}` };
  }

  // ───────────── one attempt
  async attempt(scope: ScopeName, ctx: { round: number; used: Record<Operator, number>; recent: Attempt[]; propose?: boolean }, signal?: AbortSignal): Promise<Attempt | null> {
    const g = this.s.graph;
    const hyper = this.s.cfg.evolution.hyper;
    const cands = this.candidates(scope);
    const masks = this.masks(cands);
    if (!masks.operators.some(Boolean)) return null;
    const stBefore = this.stats(scope);
    const qBefore = await this.quality(scope, signal);
    const s = this.features(scope, stBefore, qBefore, cands, ctx.recent);
    const mode = this.s.cfg.evolution.policy;
    let action: Action | null = null;
    let actor: Attempt["actor"] = "rules";
    let ab = false;
    let fallback = false;
    let teacherDist: ActionDist | null = null;
    const policy = mode === "mlp" ? this.policy : null;
    if (mode !== "rules") teacherDist = await this.teacher(scope, stBefore, cands, masks, signal);
    if (policy && this.policy) {
      const own = policy.act(s, masks);
      const turn = own ? policy.teacherTurn(own.entropy, own.maxEntropy) : { teacher: true, ab: false, fallback: true };
      if ((turn.teacher || !own) && teacherDist) {
        action = sampleFromDist(teacherDist, masks, this.rnd);
        actor = "teacher";
      } else if (own) {
        action = own.action;
        actor = "mlp";
      }
      ab = turn.ab;
      fallback = turn.fallback;
    } else if (teacherDist) {
      action = sampleFromDist(teacherDist, masks, this.rnd);
      actor = "teacher";
    }
    if (!action) {
      action = this.ruleAction(stBefore, cands, masks, ctx.round, ctx.used);
      actor = "rules";
    }
    if (!action) return null;
    action.candidate = Math.min(action.candidate, masks.candidates[action.operator] - 1);
    const Uhat = this.policy ? this.policy.predict(s, action) : 0;
    let result: { committed: boolean; vetoed?: boolean; detail: string };
    if (ctx.propose) {
      this.log.propose({ at: this.s.clock().toISOString(), scope, action, summary: this.summarize(action.operator, cands, action.candidate) });
      result = { committed: false, detail: `${action.operator}: proposed for review` };
    } else {
      try {
        if (action.operator === "abstract") result = await this.abstract(scope, cands.abstract[action.candidate]!, action, signal);
        else if (action.operator === "refine") result = await this.refine(scope, cands.refine[action.candidate]!, action, signal);
        else if (action.operator === "bridge") result = await this.bridge(scope, cands.bridge[action.candidate]!, action, signal);
        else result = await this.reframe(scope, cands.reframe[action.candidate]!, action, signal);
      } catch (e) {
        result = { committed: false, detail: `${action.operator}: ${errMsg(e)}` };
      }
    }
    let U = NON_COMMIT_U;
    if (result.committed) {
      g.commit(scope, `evo-${action.operator}`);
      g.syncIndex(scope);
      // both graphs are scored on the same query cache, right after the edit; no rollback whatever the sign
      const qAfter = await this.quality(scope, signal);
      const stAfter = this.stats(scope);
      U = hyper.alpha * (qAfter.Q - qBefore.Q) - hyper.beta * (this.cost(stAfter) - this.cost(stBefore));
    }
    const attempt: Attempt = { at: this.s.clock().toISOString(), scope, s, a: action, actor, ab: ab || undefined, fallback: fallback || undefined, teacher: teacherDist ?? undefined, U, Uhat, committed: result.committed, vetoed: result.vetoed, detail: result.detail };
    if (this.policy) attempt.E = this.policy.record(attempt, masks, hyper, ctx.recent).E;
    this.log.append(attempt);
    this.s.telemetry?.event("evo.attempt", { scope, operator: action.operator, actor, U, committed: result.committed, vetoed: result.vetoed === true });
    return attempt;
  }

  // ───────────── fusion (§6.6.1)
  async fusion(scope: ScopeName, opts: { maxClusters?: number; signal?: AbortSignal } = {}): Promise<FusionReport> {
    const g = this.s.graph;
    const sd = g.sd(scope);
    const report: FusionReport = { clusters: 0, fused: [], rejected: 0 };
    if (!this.s.aux?.available()) return report;
    const nodes = this.active(scope).filter((n) => !n.pinned && n.origin !== "instructions" && n.kind !== "episode");
    const byId = new Map(nodes.map((n) => [n.id, n]));
    // clusters: similarity ≥ θ_fusion, created within 7 days of each other, same kind and layer
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r)!;
      parent.set(x, r);
      return r;
    };
    for (const n of nodes) parent.set(n.id, n.id);
    const minSim = new Map<string, number>();
    for (const a of nodes) {
      for (const b of this.nearest(scope, a, 6)) {
        if (!byId.has(b.id) || a.kind !== b.kind || a.layer !== b.layer) continue;
        if (Math.abs(daysBetween(a.createdAt, b.createdAt)) > FUSION_WINDOW_DAYS) continue;
        const t = this.threshold("fusion", scope, a, b);
        if (!t.ok) continue;
        const ra = find(a.id);
        const rb = find(b.id);
        if (ra !== rb) parent.set(ra, rb);
        const root = find(a.id);
        minSim.set(root, Math.min(minSim.get(root) ?? 1, minSim.get(ra) ?? 1, minSim.get(rb) ?? 1, t.sim));
      }
    }
    const clusters = new Map<string, MemoryNode[]>();
    for (const n of nodes) {
      const r = find(n.id);
      clusters.set(r, [...(clusters.get(r) ?? []), n]);
    }
    const now = this.s.clock();
    for (const [root, members] of clusters) {
      if (members.length < FUSION_MIN_MEMBERS) continue;
      if (opts.signal?.aborted || report.clusters >= (opts.maxClusters ?? 3)) break;
      report.clusters++;
      const cluster = members.slice(0, 8);
      const res = await this.s.aux.run<{ title: string; text: string }>({
        role: "write.merge",
        instructions: "Merge these near-duplicate memory notes into ONE note. Keep every unique fact, value, path and command of every member; drop only repetition. Add nothing that is in none of them. Title of at most 15 words.",
        data: cluster.map((m) => ({ label: `MEMBER ${m.id}`, text: `${m.title}\n${m.text}` })),
        schema: { type: "object", additionalProperties: false, required: ["title", "text"], properties: { title: { type: "string" }, text: { type: "string" } } },
        signal: opts.signal,
      });
      const out = res.output;
      if (!out?.text?.trim()) {
        report.rejected++;
        continue;
      }
      // preservation check; fail-safe: reject the fusion
      let preserves: number | undefined;
      if (this.s.decision.available()) {
        const answers = await this.s.decision.decide({ merged: out.text, members: cluster.map((m) => m.text) }, [{ kind: "binary", name: "preserves", instructions: "Does the merged memory keep every unique fact of the members?" }], { callSite: "evo.fusion", timeoutMs: TIMEOUTS.check, signal: opts.signal });
        preserves = binaryP(answers, "preserves");
      }
      const mode = this.s.sim.thresholdMode();
      if (preserves !== undefined && mode !== "lexical" && minSim.has(root)) this.s.sim.logPair("fusion", minSim.get(root)!, preserves >= PRESERVE_MIN, { mode });
      if (preserves === undefined || preserves < PRESERVE_MIN) {
        report.rejected++;
        continue;
      }
      // fused strength: max member strength + 0.5 · variance; fused decay rate: λ_base / (1 + log|C|)
      const vs = cluster.map((m) => strengthAt(m, now));
      const mean = vs.reduce((a, b) => a + b, 0) / vs.length;
      const variance = vs.reduce((a, b) => a + (b - mean) ** 2, 0) / vs.length;
      const first = cluster[0]!;
      const evidence = cluster.flatMap((m) => m.evidence).slice(0, 12);
      const [w] = await this.writer.write(
        [
          {
            text: out.text,
            title: out.title,
            kind: first.kind,
            origin: "operator",
            scope,
            layer: first.layer,
            urgency: cluster.map((m) => m.urgency).sort((x, y) => ["passive", "caption", "hint", "immediate"].indexOf(y) - ["passive", "caption", "hint", "immediate"].indexOf(x))[0],
            urgencyBy: "default",
            severity: first.severity,
            anchors: cluster.flatMap((m) => m.anchors).filter((x, i, all) => all.findIndex((y) => y.kind === x.kind && y.pathId === x.pathId && y.glob === x.glob && y.symbol === x.symbol) === i),
            evidence: evidence.map((e) => ({ quote: e.quote, source: e.source, time: e.time })),
            sourceTexts: evidence.filter((e) => e.verified).map((e) => e.quote),
            strength: clamp(Math.max(...vs) + 0.5 * variance, 0, 1),
            decayDivisor: 1 + Math.log(cluster.length),
            skipConflicts: true,
            skipDedup: true,
            keep: true,
          },
        ],
        { signal: opts.signal },
      );
      if (w?.status !== "created" || !w.id) {
        report.rejected++;
        continue;
      }
      const fused = { scope, node: sd.getNode(w.id)! };
      const nowIso = now.toISOString();
      for (const m of cluster) {
        // members are archived as part-of the fused node; their use history moves with them
        g.link({ scope, node: m }, "part-of", fused, { w: 0.8 });
        for (const name of ["used", "usedSuccess", "usedFailure", "delivered"] as const) if (m.counters[name] > 0) sd.incCounter(w.id, name, m.counters[name]);
        sd.patchNode(m.id, { status: "archived", statusReason: `fused into m:${w.id}`, statusAt: nowIso });
        g.setEdgesActive({ scope, node: sd.getNode(m.id)! }, false);
      }
      g.commit(scope, "fusion");
      g.syncIndex(scope);
      report.fused.push(w.id);
    }
    return report;
  }

  // ───────────── one maintenance pass over a scope (§6.6.8)
  private overBudget(): string | null {
    const spent = this.s.telemetry?.spentToday();
    if (!spent) return null;
    if (spent.aux >= this.s.cfg.budgets.dailyAuxTokens) return "daily aux budget reached";
    if (spent.decision >= this.s.cfg.budgets.dailyDecisionTokens) return "daily decision budget reached";
    return null;
  }

  /** Hygiene first, then a few strategy attempts. Aborted cleanly on `signal` or when a budget runs out. */
  async pass(scope: ScopeName, opts: { signal?: AbortSignal; attempts?: number; hygiene?: boolean } = {}): Promise<PassReport> {
    const g = this.s.graph;
    const report: PassReport = { scope, hygiene: null, rechecked: 0, fusion: { clusters: 0, fused: [], rejected: 0 }, attempts: [] };
    if (!g.has(scope) || !g.writable(scope)) return report;
    const stop = () => (opts.signal?.aborted ? "aborted" : this.overBudget());
    if (opts.hygiene !== false) report.hygiene = this.lifecycle.hygiene(scope);
    // conflict re-checks left by a judge that was unavailable at write time
    for (const node of this.active(scope).filter((n) => n.flags?.includes("conflict-recheck")).slice(0, 5)) {
      if ((report.stopped = stop() ?? undefined)) return report;
      if (await this.writer.recheck({ scope, node }, opts.signal)) report.rechecked++;
    }
    if ((report.stopped = stop() ?? undefined)) return report;
    report.fusion = await this.fusion(scope, { signal: opts.signal });
    const cfg = this.s.cfg.evolution;
    if (cfg.policy === "off") return report;
    let propose = false;
    if (scope === "shared") {
      if (cfg.sharedStrategy === "off") return report;
      propose = cfg.sharedStrategy === "propose";
      // at most one strategy pass per day per machine on the shared scope
      const last = this.log.lastSharedPass();
      if (last && daysBetween(last, this.s.clock()) < 1) return report;
      this.log.markSharedPass(this.s.clock().toISOString());
    }
    const used: Record<Operator, number> = { abstract: 0, refine: 0, bridge: 0, reframe: 0 };
    const recent = this.log.attempts(64).filter((a) => a.scope === scope);
    const total = opts.attempts ?? cfg.attemptsPerPass;
    for (let round = 0; round < total; round++) {
      if ((report.stopped = stop() ?? undefined)) break;
      const attempt = await this.attempt(scope, { round, used, recent, propose }, opts.signal);
      if (!attempt) break;
      used[attempt.a.operator]++;
      recent.push(attempt);
      report.attempts.push(attempt);
    }
    this.policy?.save();
    return report;
  }
}
