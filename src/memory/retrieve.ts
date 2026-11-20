/**
 * Read path (§6.4): the retrieval core (candidates → seeds → spreading activation → score →
 * filters), turn search, the gated proactive path, and thorough mode (QEMem).
 */
import type { DecisionQuestion, ScopedNode, ScopeName } from "../core/types.ts";
import { binaryP } from "../providers/decision.ts";
import type { TurnRow } from "../storage/turnindex.ts";
import { rrf } from "../storage/vectors.ts";
import { bracket } from "../util/ids.ts";
import { clipTokens, estimateTokens, sanitize, verifyQuote } from "../util/text.ts";
import { renderCards } from "./cards.ts";
import { type MemoryServices, TIMEOUTS, UNCALIBRATED } from "./services.ts";
import { irrelevanceRate, memoryWorth, proactiveEligible, strengthAt } from "./strength.ts";
import { effectiveUrgency } from "./urgency.ts";

export const SEEDS = 5;
const MAX_HOPS = 2;
const HOP_DECAY = 0.5;
const NODES_PER_QUERY = 15;
const SCOPE_WEIGHT: Record<ScopeName, number> = { personal: 1.0, shared: 1.0, global: 0.8 };
const PATH_BOOST = 1.5;

export interface RetrieveOptions {
  scopes?: ScopeName[];
  limit?: number;
  /** Repo path for the path boost (the `path` tool argument or the focus directory). */
  path?: string;
  history?: boolean;
  exclude?: Set<string>;
  /** Leave out `passive` memories (they are never pushed, §6.10). */
  pushOnly?: boolean;
  /** False for aux sessions: no retrieval counters (§9.3.2). */
  count?: boolean;
  signal?: AbortSignal;
}

export interface Hit {
  ref: ScopedNode;
  score: number;
  activation: number;
  seed: boolean;
}

export interface TurnHit {
  row: TurnRow;
  score: number;
}

const key = (ref: ScopedNode) => `${ref.scope}:${ref.node.id}`;

export class Retriever {
  private readonly s: MemoryServices;

  constructor(services: MemoryServices) {
    this.s = services;
  }

  /**
   * Steps 1–3 of the retrieval core: candidates, seeds and spreading activation.
   * Also used on its own by EvoDisco's graph quality Q(G; 𝒬) (§6.6.4).
   */
  async spread(query: string, opts: { scopes?: ScopeName[]; path?: string; history?: boolean; signal?: AbortSignal } = {}): Promise<Map<string, { ref: ScopedNode; a: number; seed: boolean }>> {
    const g = this.s.graph;
    const activation = new Map<string, { ref: ScopedNode; a: number; seed: boolean }>();
    const scopes = (opts.scopes ?? g.visible()).filter((s) => g.has(s));
    if (!query.trim() || !scopes.length) return activation;
    const enc = await this.s.sim.encode(query, "query", opts.signal);
    const statuses = opts.history ? ["active", "dormant"] : ["active"];

    // 1. candidates per scope: semantic search with a floor, fused with BM25 by reciprocal rank
    const candidates: Array<{ ref: ScopedNode; rrf: number; sem: number; lex: number }> = [];
    for (const scope of scopes) {
      const h = g.handle(scope);
      if (!h.index) continue;
      const active = (id: string) => {
        const n = h.store.sd.getNode(id);
        return !!n && statuses.includes(n.status);
      };
      const semantic = this.s.sim.searchVectors(h.index.vectors, enc, { limit: 30, floor: true, filter: active }).hits;
      const lexical = h.index.bm25(query, { limit: 30, statuses });
      const sem = new Map(semantic.map((x) => [x.id, x.score]));
      const lex = new Map(lexical.map((x) => [x.id, x.score]));
      for (const hit of rrf([semantic, lexical])) {
        const node = g.getIn(scope, hit.id);
        if (node && g.get(node.id)?.scope === scope) candidates.push({ ref: { scope, node }, rrf: hit.score, sem: sem.get(hit.id) ?? 0, lex: lex.get(hit.id) ?? 0 });
      }
    }
    // memories anchored at the query's path are preferred when seeds are picked
    const pathHits = this.pathHits(opts.path, scopes);
    const rank = (c: { ref: ScopedNode; rrf: number }) => c.rrf * (pathHits.has(key(c.ref)) ? PATH_BOOST : 1.0);
    candidates.sort((a, b) => rank(b) - rank(a));

    // 2. seeds: the top 5. A seed's activation is its fused rank score, scaled by how close its
    // best raw score comes to the best candidate's (reciprocal ranks alone are nearly flat).
    const seeds = candidates.slice(0, SEEDS);
    if (!seeds.length) return activation;
    const top = Math.max(...seeds.map((c) => c.rrf));
    const semTop = Math.max(0, ...candidates.map((c) => c.sem));
    const lexTop = Math.max(0, ...candidates.map((c) => c.lex));
    for (const c of seeds) {
      const relevance = Math.max(semTop > 0 ? c.sem / semTop : 0, lexTop > 0 ? c.lex / lexTop : 0);
      activation.set(key(c.ref), { ref: c.ref, a: (c.rrf / top) * Math.max(0.05, Math.min(1, relevance)), seed: true });
    }

    // 3. spreading activation: up to 2 hops, × w_e · κ_act, hop decay 0.5
    const kappaAct = this.s.cfg.memory.kappaActivation;
    let frontier = [...activation.values()];
    for (let hop = 0; hop < MAX_HOPS && frontier.length; hop++) {
      const next: typeof frontier = [];
      for (const cur of frontier) {
        for (const nb of g.neighbors(cur.ref, { activeOnly: true })) {
          const src = nb.direction === "out" ? cur.ref.node : nb.other.node;
          const dst = nb.direction === "out" ? nb.other.node : cur.ref.node;
          const kappa = src.layer === "short" && dst.layer === "long" ? kappaAct : 1.0;
          const a = cur.a * nb.edge.w * kappa * HOP_DECAY;
          if (a <= 0.01) continue;
          const k = key(nb.other);
          const have = activation.get(k);
          if (have && have.a >= a) continue;
          const entry = { ref: nb.other, a, seed: have?.seed ?? false };
          activation.set(k, entry);
          next.push(entry);
        }
      }
      frontier = next;
    }
    return activation;
  }

  private pathHits(path: string | undefined, scopes: ScopeName[]): Set<string> {
    const out = new Set<string>();
    if (path !== undefined) for (const c of this.s.paths.covering(path, { scopes })) out.add(`${c.scope}:${c.node.id}`);
    return out;
  }

  /** Retrieval core for one query (§6.4.3). */
  async retrieve(query: string, opts: RetrieveOptions = {}): Promise<Hit[]> {
    const g = this.s.graph;
    const scopes = (opts.scopes ?? g.visible()).filter((s) => g.has(s));
    const statuses = opts.history ? ["active", "dormant"] : ["active"];
    const activation = await this.spread(query, opts);
    if (!activation.size) return [];
    const pathHits = this.pathHits(opts.path, scopes);

    // 4. score
    const now = this.s.clock();
    const hits: Hit[] = [];
    for (const { ref, a, seed } of activation.values()) {
      const n = ref.node;
      // 5. filters
      if (!statuses.includes(n.status)) continue;
      if (opts.exclude?.has(n.id)) continue;
      if (!opts.history && !g.isChainHead(ref)) continue;
      if (opts.pushOnly && effectiveUrgency(n, this.s.cfg) === "passive") continue;
      const { mw } = memoryWorth(n.counters);
      const score = a * (0.2 + 0.8 * strengthAt(n, now)) * (0.5 + mw) * (1 - 0.5 * irrelevanceRate(n)) * SCOPE_WEIGHT[ref.scope] * (pathHits.has(key(ref)) ? PATH_BOOST : 1.0);
      hits.push({ ref, score, activation: a, seed });
    }
    hits.sort((a, b) => b.score - a.score || (a.ref.node.id < b.ref.node.id ? -1 : 1));
    let out = hits.slice(0, Math.min(opts.limit ?? NODES_PER_QUERY, NODES_PER_QUERY));

    // contradicting pairs are returned together
    const present = new Set(out.map((h) => key(h.ref)));
    for (const h of [...out]) {
      for (const other of g.contradictions(h.ref)) {
        if (present.has(key(other)) || opts.exclude?.has(other.node.id)) continue;
        present.add(key(other));
        out.push({ ref: other, score: h.score * 0.99, activation: h.activation, seed: false });
      }
    }
    out = out.sort((a, b) => b.score - a.score);

    // 7. bookkeeping: retrieval count r_v (lastAccessAt is not touched here)
    if (opts.count !== false) for (const h of out) this.s.accounting.bump(h.ref.scope, h.ref.node.id, "retrieved", 1);
    return out;
  }

  /** Several queries, merged by best score (thorough mode and gap queries). */
  async retrieveMany(queries: string[], opts: RetrieveOptions = {}): Promise<Hit[]> {
    const best = new Map<string, Hit>();
    for (const q of queries) {
      for (const h of await this.retrieve(q, opts)) {
        const k = key(h.ref);
        const cur = best.get(k);
        if (!cur || h.score > cur.score) best.set(k, h);
      }
    }
    return [...best.values()].sort((a, b) => b.score - a.score);
  }

  /** Turn hits (§6.4.3 step 6): consolidated (`t:`) and raw (`r:`) turns from the turn index. */
  async searchTurns(query: string, opts: { sessions?: string[]; limit?: number; signal?: AbortSignal } = {}): Promise<TurnHit[]> {
    const turns = this.s.turns;
    if (!turns || !query.trim()) return [];
    const limit = opts.limit ?? 8;
    const lexical = turns.bm25(query, { limit: 40, sessions: opts.sessions });
    const enc = await this.s.sim.encode(query, "query", opts.signal);
    const only = opts.sessions ? turns.idsIn(opts.sessions) : undefined;
    const semantic = this.s.sim.searchVectors(turns.vectors, enc, { limit: 40, floor: true, only }).hits;
    const out: TurnHit[] = [];
    const seenEntries = new Set<string>();
    for (const hit of rrf([semantic, lexical])) {
      const row = turns.get(hit.id);
      if (!row) continue;
      // one hit per entry: chunks of the same entry collapse onto the best one
      const entryKey = `${row.session}:${row.entry ?? row.id}`;
      if (seenEntries.has(entryKey)) continue;
      seenEntries.add(entryKey);
      out.push({ row, score: hit.score });
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * Proactive path (§6.4.1): top 8 pushable candidates, gated by one decision request.
   * Fail-safe: inject nothing.
   */
  async proactive(purpose: { label: string; reason: string; parentLabel?: string }, opts: { path?: string; exclude?: Set<string>; signal?: AbortSignal } = {}): Promise<{ cards: Array<{ ref: ScopedNode; full: boolean; tokens: number }>; text: string; considered: number }> {
    const cfg = this.s.cfg.memory.proactive;
    const none = { cards: [], text: "", considered: 0 };
    const query = [purpose.label, purpose.reason, purpose.parentLabel ?? ""].filter(Boolean).join("\n");
    const hits = (await this.retrieve(query, { limit: cfg.candidates, pushOnly: true, path: opts.path, exclude: opts.exclude, signal: opts.signal })).filter((h) => proactiveEligible(h.ref.node)).slice(0, cfg.candidates);
    if (!hits.length || !this.s.decision.available()) return { ...none, considered: hits.length };
    const questions: DecisionQuestion[] = [{ kind: "binary", name: "inject_any", instructions: "Would any of these memories help with this purpose?" }];
    hits.forEach((_, k) => questions.push({ kind: "binary", name: `rel.${k}`, instructions: `Would memory ${k} help with this purpose?` }));
    const answers = await this.s.decision.decide(
      { purpose: { label: purpose.label, reason: purpose.reason, parent: purpose.parentLabel ?? null }, memories: hits.map((h, k) => ({ k, kind: h.ref.node.kind, text: `${h.ref.node.title}\n${h.ref.node.text}`.slice(0, 800) })) },
      questions,
      { callSite: "proactive.gate", timeoutMs: TIMEOUTS.gate, signal: opts.signal },
    );
    const any = binaryP(answers, "inject_any");
    if (any === undefined || any < 0.5) return { ...none, considered: hits.length };
    const gate = answers.inject_any?.calibrated === false ? Math.max(cfg.gate, UNCALIBRATED.proactiveGate) : cfg.gate;
    const chosen = hits
      .map((h, k) => ({ h, p: binaryP(answers, `rel.${k}`) ?? 0 }))
      .filter((x) => x.p >= gate)
      .sort((a, b) => b.p - a.p)
      .slice(0, cfg.maxCards)
      .map((x) => x.h.ref);
    if (!chosen.length) return { ...none, considered: hits.length };
    // `immediate` and `hint` memories get full cards; `caption` memories one line each
    const captionIds = new Set(chosen.filter((r) => effectiveUrgency(r.node, this.s.cfg) === "caption").map((r) => r.node.id));
    const rendered = renderCards(chosen, this.s.graph, this.s.paths, { budgetTokens: cfg.maxTokens, captionIds });
    return { cards: rendered.shown, text: rendered.text, considered: hits.length };
  }
}

// ───────────────────────────── thorough mode (§6.4.4)

export interface Plan {
  need: string;
  answer_type: string;
  aggregate: boolean;
  temporal: boolean;
  queries: string[];
}

export type CardRole = "answer_candidate" | "intermediate_fact" | "temporal_constraint" | "inference_support";

export interface ViewCard {
  claim: string;
  role: CardRole;
  sources: string[];
  quote?: string;
  time?: string;
  verified?: boolean;
}

export interface ThoroughResult {
  cards: ViewCard[];
  sufficient: boolean;
  missing: string[];
  rounds: number;
  memoryHits: Hit[];
  turnHits: TurnHit[];
  plan: Plan | null;
  /** True when the aux LLM was unavailable and the result is the quick-mode evidence. */
  degraded: boolean;
}

const ROLE_ORDER: CardRole[] = ["answer_candidate", "temporal_constraint", "intermediate_fact", "inference_support"];

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["need", "answer_type", "aggregate", "temporal", "queries"],
  properties: {
    need: { type: "string" },
    answer_type: { type: "string" },
    aggregate: { type: "boolean" },
    temporal: { type: "boolean" },
    queries: { type: "array", minItems: 1, maxItems: 6, items: { type: "string" } },
  },
};

const CONSTRUCT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["cards", "sufficient", "missing", "gapQueries"],
  properties: {
    cards: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim", "role", "sources"],
        properties: {
          claim: { type: "string" },
          role: { type: "string", enum: ROLE_ORDER },
          sources: { type: "array", items: { type: "string" } },
          quote: { type: "string" },
          time: { type: "string" },
        },
      },
    },
    sufficient: { type: "boolean" },
    missing: { type: "array", items: { type: "string" } },
    gapQueries: { type: "array", maxItems: 4, items: { type: "string" } },
  },
};

export class ThoroughSearch {
  private readonly s: MemoryServices;
  private readonly retriever: Retriever;

  constructor(services: MemoryServices, retriever: Retriever) {
    this.s = services;
    this.retriever = retriever;
  }

  private evidenceBlocks(memory: Hit[], turns: TurnHit[], budgetTokens: number): { text: string; sources: Map<string, string> } {
    const sources = new Map<string, string>();
    const blocks: string[] = [];
    let used = 0;
    const add = (id: string, header: string, body: string) => {
      const block = `${header}\n${body}`;
      const t = estimateTokens(block);
      if (used + t > budgetTokens) return;
      used += t;
      blocks.push(block);
      sources.set(id, body);
    };
    for (const h of memory) {
      const n = h.ref.node;
      const quotes = n.evidence.map((e) => `"${e.quote}"`).join("\n");
      add(`m:${n.id}`, `${bracket("m", n.id)} ${h.ref.scope} · ${n.kind} · as of ${(n.validFrom ?? n.createdAt).slice(0, 10)}${n.validTo ? ` · superseded ${n.validTo.slice(0, 10)}` : ""}`, [n.text, quotes].filter(Boolean).join("\n"));
    }
    for (const t of turns) add(t.row.id, `[${t.row.id}] ${t.row.kind} turn · ${t.row.at.slice(0, 16)}`, clipTokens(t.row.text, 500));
    return { text: blocks.join("\n\n"), sources };
  }

  async run(query: string, opts: { memory: boolean; turns: boolean; scopes?: ScopeName[]; sessions?: string[]; path?: string; history?: boolean; count?: boolean; budgetTokens: number; signal?: AbortSignal }): Promise<ThoroughResult> {
    const aux = this.s.aux;
    const usable = !!aux?.available();
    // 1. plan
    let plan: Plan | null = null;
    if (usable) {
      const res = await aux!.run<Plan>({
        role: "qemem.planner",
        instructions:
          "Plan a memory search. State what is needed, the type of answer, whether the question aggregates over several items, whether it depends on time or history, and write 4 to 6 short, diverse search queries (different wording, entities and angles; no near-duplicates).",
        data: [{ label: "QUESTION", text: query }],
        schema: PLAN_SCHEMA,
        tools: "none",
        signal: opts.signal,
      });
      const p = res.output;
      if (p && Array.isArray(p.queries)) plan = { need: String(p.need ?? ""), answer_type: String(p.answer_type ?? ""), aggregate: p.aggregate === true, temporal: p.temporal === true, queries: p.queries.filter((q): q is string => typeof q === "string" && q.trim().length > 0).slice(0, 6) };
    }
    const history = opts.history || plan?.temporal === true;
    const wide = plan?.aggregate === true;
    const queries = [query, ...(plan?.queries ?? [])];
    const rOpts = { scopes: opts.scopes, path: opts.path, history, count: opts.count, signal: opts.signal, limit: 15 };
    const seenM = new Set<string>();
    const seenT = new Set<string>();
    let memoryHits: Hit[] = [];
    let turnHits: TurnHit[] = [];
    const gather = async (qs: string[]) => {
      const fresh: { m: Hit[]; t: TurnHit[] } = { m: [], t: [] };
      if (opts.memory) {
        for (const h of await this.retriever.retrieveMany(qs, { ...rOpts, exclude: seenM })) {
          if (seenM.has(h.ref.node.id)) continue;
          seenM.add(h.ref.node.id);
          fresh.m.push(h);
        }
      }
      if (opts.turns) {
        for (const q of qs) {
          for (const t of await this.retriever.searchTurns(q, { sessions: opts.sessions, limit: wide ? 8 : 5, signal: opts.signal })) {
            if (seenT.has(t.row.id)) continue;
            seenT.add(t.row.id);
            fresh.t.push(t);
          }
        }
      }
      return fresh;
    };
    const first = await gather(queries);
    memoryHits = first.m.slice(0, wide ? 30 : 20);
    turnHits = first.t.slice(0, wide ? 16 : 10);
    if (!usable) return { cards: [], sufficient: true, missing: [], rounds: 0, memoryHits, turnHits, plan, degraded: true };

    // 2. construct, 3. refine
    const cards: ViewCard[] = [];
    let sufficient = false;
    let missing: string[] = [];
    let rounds = 0;
    let batchM = memoryHits;
    let batchT = turnHits;
    const allSources = new Map<string, string>();
    const maxRounds = this.s.cfg.memory.search.refineRounds;
    for (;;) {
      const ev = this.evidenceBlocks(batchM, batchT, wide ? 16_000 : 10_000);
      for (const [k, v] of ev.sources) allSources.set(k, v);
      if (!ev.text) break;
      const res = await aux!.run<{ cards: ViewCard[]; sufficient: boolean; missing: string[]; gapQueries: string[] }>({
        role: "qemem.constructor",
        instructions:
          "Build evidence cards that answer the question from the numbered sources only. Each card states one claim, its role (answer_candidate, intermediate_fact, temporal_constraint or inference_support), the source IDs it rests on (copy them exactly, e.g. m:7f3a9k2d, t:c7f3a2e8, r:5d2f0abc), and a verbatim quote from one of those sources. Then judge whether the cards are sufficient to answer; if not, list what is missing and up to 4 search queries that could fill the gaps. Never invent facts or sources.",
        data: [
          { label: "QUESTION", text: query },
          ...(cards.length ? [{ label: "CARDS SO FAR", text: cards.map((c) => `- (${c.role}) ${c.claim}`).join("\n") }] : []),
          { label: "SOURCES", text: ev.text },
        ],
        schema: CONSTRUCT_SCHEMA,
        signal: opts.signal,
      });
      const out = res.output;
      if (!out || !Array.isArray(out.cards)) {
        // fail-safe: the retrieved evidence stands on its own
        if (!cards.length) return { cards: [], sufficient: true, missing: [], rounds, memoryHits, turnHits, plan, degraded: true };
        break;
      }
      for (const c of out.cards) {
        if (!c || typeof c.claim !== "string" || !c.claim.trim()) continue;
        const sources = (Array.isArray(c.sources) ? c.sources : []).map((s) => String(s).replace(/^\[|\]$/g, "")).filter((s) => allSources.has(s));
        const role: CardRole = ROLE_ORDER.includes(c.role) ? c.role : "intermediate_fact";
        // quote verification: normalized, segment by segment; unverified quotes are flagged, not dropped
        const quote = typeof c.quote === "string" && c.quote.trim() ? sanitize(c.quote.trim()) : undefined;
        const verified = quote ? sources.some((s) => verifyQuote(quote, allSources.get(s)!)) || [...allSources.values()].some((src) => verifyQuote(quote, src)) : undefined;
        cards.push({ claim: sanitize(c.claim.trim()), role, sources, quote, time: typeof c.time === "string" ? c.time : undefined, verified });
      }
      sufficient = out.sufficient === true;
      missing = Array.isArray(out.missing) ? out.missing.filter((m): m is string => typeof m === "string").map((m) => sanitize(m)) : [];
      if (sufficient || rounds >= maxRounds) break;
      const gaps = (Array.isArray(out.gapQueries) ? out.gapQueries : []).filter((q): q is string => typeof q === "string" && q.trim().length > 0).slice(0, 4);
      if (!gaps.length) break;
      const more = await gather(gaps);
      if (!more.m.length && !more.t.length) break; // nothing new turned up
      rounds++;
      batchM = more.m.slice(0, 12);
      batchT = more.t.slice(0, 8);
      memoryHits = [...memoryHits, ...batchM];
      turnHits = [...turnHits, ...batchT];
    }
    // 4. output order: answer candidates, temporal constraints, intermediate facts, inference support
    cards.sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
    return { cards: fitCards(cards, opts.budgetTokens), sufficient, missing, rounds, memoryHits, turnHits, plan, degraded: false };
  }
}

export function renderViewCard(c: ViewCard): string {
  const src = c.sources.map((s) => `[${s}]`).join(" ");
  const lines = [`(${c.role.replace(/_/g, " ")}) ${c.claim}${src ? ` ${src}` : ""}${c.time ? ` · ${c.time}` : ""}`];
  if (c.quote) lines.push(`  "${c.quote.replace(/\s+/g, " ").slice(0, 300)}"${c.verified === false ? " ⚠ quote unverified" : ""}`);
  return lines.join("\n");
}

function fitCards(cards: ViewCard[], budgetTokens: number): ViewCard[] {
  const out: ViewCard[] = [];
  let used = 0;
  for (const c of cards) {
    const t = estimateTokens(renderViewCard(c));
    if (used + t > budgetTokens) break;
    used += t;
    out.push(c);
  }
  return out;
}
