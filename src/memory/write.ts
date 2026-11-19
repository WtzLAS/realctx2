/**
 * Write path (§6.3): normalize → evidence → signature → safety scan → scope routing and
 * urgency → embed → de-duplicate → resolve conflicts → insert → link.
 */
import type { DecisionAnswer, DecisionQuestion, Evidence, Kind, Layer, MemoryNode, Origin, PathAnchor, Relation, ScopedNode, ScopeName, Severity, SourceRef, StrengthEvent, TriggerAction, Urgency } from "../core/types.ts";
import { KINDS, zeroCounters } from "../core/types.ts";
import { binaryP, choiceProbs } from "../providers/decision.ts";
import { embedHash, embedText } from "../storage/index.ts";
import { rrf } from "../storage/vectors.ts";
import { randomId8 } from "../util/ids.ts";
import { scanSecrets } from "../util/secrets.ts";
import { clamp, contentHash, daysBetween, extractSignature, looksLikePath, makeTitle, sanitize, verifyQuote } from "../util/text.ts";
import { reviveNode } from "./lifecycle.ts";
import { type MemoryServices, TIMEOUTS, UNCALIBRATED } from "./services.ts";
import type { Encoded, SimMode } from "./similarity.ts";
import { recentUses, strengthAt, V0 } from "./strength.ts";
import { capUrgency, defaultUrgency, hasTrigger, pickUrgency, urgencyQuestion } from "./urgency.ts";

export interface Candidate {
  text: string;
  title?: string;
  kind?: Kind;
  origin: Origin;
  /** Scope named by the main model or the user; otherwise the decision model routes. */
  scope?: ScopeName;
  /** Used when routing has no answer (default: personal inside a project, global outside). */
  defaultScope?: ScopeName;
  urgency?: Urgency;
  urgencyBy?: MemoryNode["urgencyBy"];
  severity?: Severity;
  pin?: boolean;
  layer?: Layer;
  /** Repo paths or globs to anchor to. */
  paths?: string[];
  anchors?: PathAnchor[];
  anchorRole?: "applies" | "about";
  commands?: string[];
  triggersOn?: TriggerAction[];
  evidence?: Array<{ quote: string; source: SourceRef; time?: string }>;
  /** Texts the quotes are verified against. */
  sourceTexts?: string[];
  artifacts?: string[];
  evaluation?: "good" | "bad" | "neutral";
  validFrom?: string;
  /** Palim's `supersedes`: a description of the fact this one replaces (§5.4.4). */
  supersedesHint?: string;
  provenance?: { sessionId?: string; turnId?: string; entryIds?: string[] };
  source?: MemoryNode["source"];
  /** Episode node of the same intent (`derived-from` link). */
  episode?: { scope: ScopeName; id: string };
  /** Previous episode of the session (`precedes` link). */
  after?: { scope: ScopeName; id: string };
  confidence?: number;
  /** Initial strength override (operators: fused strength). */
  strength?: number;
  decayDivisor?: number;
  skipConflicts?: boolean;
  skipDedup?: boolean;
  /** Never let the decision model discard it (explicit requests, instruction items). */
  keep?: boolean;
}

export interface WriteResult {
  status: "created" | "merged" | "discarded" | "failed";
  id?: string;
  scope?: ScopeName;
  reason?: string;
  redacted?: boolean;
  sensitivity?: "normal" | "personal";
  superseded?: string[];
  conflicts?: string[];
  subsumed?: string[];
  urgency?: Urgency;
  /** The scope that was asked for, when routing had to change it. */
  reroutedFrom?: ScopeName;
}

interface Prepared {
  c: Candidate;
  text: string;
  title: string;
  kind: Kind;
  evidence: Evidence[];
  signature: string[];
  sensitivity: "normal" | "personal";
  redacted: boolean;
  scope?: ScopeName;
  reroutedFrom?: ScopeName;
  discard?: string;
  urgency?: Urgency;
  urgencyBy?: MemoryNode["urgencyBy"];
  anchors: PathAnchor[];
  triggers?: MemoryNode["triggers"];
}

const BREADTH: Record<ScopeName, number> = { personal: 0, shared: 1, global: 2 };
const OMEGA = 0.5; // importance reduction on compatible overlap
const RHO_S = 1.0; // suppression rate on supersession
const W_AGE_DAYS = 30;
const LEXICAL_CONFLICT_MIN = 0.2; // trigram Jaccard: prunes BM25 hits that only share stop words

/** Narrower scopes never mutate broader ones (§6.3.2 step 9). */
export function mayMutate(writer: ScopeName, target: ScopeName): boolean {
  return BREADTH[target] <= BREADTH[writer];
}

export class MemoryWriter {
  private readonly s: MemoryServices;

  constructor(services: MemoryServices) {
    this.s = services;
  }

  async write(candidates: Candidate[], opts: { signal?: AbortSignal } = {}): Promise<WriteResult[]> {
    const prepared = candidates.map((c) => this.prepare(c));
    await this.route(prepared, opts.signal);
    const results: WriteResult[] = [];
    let any = false;
    for (const p of prepared) {
      let r: WriteResult;
      const touched = new Set<ScopeName>();
      this.inserted = null;
      try {
        r = p.discard ? { status: "discarded", reason: p.discard } : await this.store(p, opts.signal, touched);
      } catch (e) {
        r = { status: "failed", reason: String((e as Error).message ?? e) };
        this.s.telemetry?.event("write.failed", { error: r.reason });
      }
      if (p.redacted) r.redacted = true;
      r.sensitivity = p.sensitivity;
      if (p.reroutedFrom && r.status !== "discarded") r.reroutedFrom = p.reroutedFrom;
      results.push(r);
      // one commit per memory write (§7.5); later candidates of the batch see this one
      for (const scope of touched) {
        this.s.graph.commit(scope, "memory-write");
        this.s.graph.syncIndex(scope);
        any = true;
      }
      this.keepVectors();
    }
    if (any) this.s.paths.invalidate();
    return results;
  }

  private inserted: { scope: ScopeName; node: MemoryNode; enc: Encoded } | null = null;

  /** The candidate was embedded for de-duplication: keep those vectors instead of embedding again. */
  private keepVectors(): void {
    const ins = this.inserted;
    this.inserted = null;
    if (!ins) return;
    const h = this.s.graph.handle(ins.scope);
    if (!h.index || embedText(ins.node) !== ins.enc.text) return;
    const li = this.s.cfg.index.lateInteraction;
    try {
      const lateKey = this.s.sim.lateKey();
      if (ins.enc.late && lateKey) h.index.vectors.putTokens(ins.node.id, lateKey, embedHash(ins.node), ins.enc.late, li.quantize.memories, li.pool.memories);
      const denseKey = this.s.sim.denseKey();
      if (ins.enc.dense && denseKey) h.index.vectors.putDense(ins.node.id, denseKey, embedHash(ins.node), ins.enc.dense);
    } catch {
      // the embedding backlog picks the node up later
    }
  }

  // ───────────── steps 1–4
  private prepare(c: Candidate): Prepared {
    // 4. safety scan first, so nothing downstream ever sees the secret
    const scan = scanSecrets(sanitize(c.text).trim());
    let personal = scan.findings.length > 0 || scan.pii.length > 0;
    const text = scan.redacted.replace(/\n{3,}/g, "\n\n");
    const kind: Kind = c.kind && KINDS.includes(c.kind) ? c.kind : "fact";
    const titleScan = scanSecrets(sanitize(c.title?.trim() || makeTitle(text)));
    const title = makeTitle(titleScan.redacted);
    // 2. evidence: verbatim quotes, verified with a normalized substring match
    const evidence: Evidence[] = [];
    for (const e of c.evidence ?? []) {
      const q = scanSecrets(sanitize(e.quote).trim());
      if (!q.redacted) continue;
      if (q.findings.length || q.pii.length) personal = true;
      const verified = q.findings.length === 0 && (c.sourceTexts ?? []).some((src) => verifyQuote(e.quote, src));
      evidence.push({ quote: q.redacted, source: { type: e.source.type, ref: sanitize(e.source.ref) }, time: e.time, verified });
    }
    // 3. action signature
    const signature = extractSignature([text, ...evidence.map((e) => e.quote)].join("\n"), [...(c.artifacts ?? []), ...(c.commands ?? [])].map((a) => sanitize(a)));
    const triggers: MemoryNode["triggers"] = {};
    if (c.commands?.length) triggers.commands = [...new Set(c.commands.map((x) => x.trim().replace(/\s+/g, " ")).filter(Boolean))];
    const on = new Set<TriggerAction>(c.triggersOn ?? []);
    if (triggers.commands?.length) on.add("command");
    if (on.size) triggers.on = [...on];
    return {
      c,
      text,
      title,
      kind,
      evidence,
      signature,
      sensitivity: personal ? "personal" : "normal",
      redacted: scan.findings.length > 0 || titleScan.findings.length > 0,
      anchors: [],
      triggers: triggers.on || triggers.commands ? triggers : undefined,
      urgency: c.urgency,
      urgencyBy: c.urgency ? (c.urgencyBy ?? "agent") : undefined,
    };
  }

  // ───────────── step 5: scope routing and urgency
  private fallbackScope(p: Prepared): ScopeName | null {
    const g = this.s.graph;
    const want = p.c.defaultScope ?? (g.has("personal") ? "personal" : "global");
    if (g.has(want) && g.writable(want)) return want;
    for (const s of ["personal", "global"] as ScopeName[]) if (g.has(s) && g.writable(s)) return s;
    return null;
  }

  private async route(prepared: Prepared[], signal?: AbortSignal): Promise<void> {
    const g = this.s.graph;
    const cfg = this.s.cfg.memory.routing;
    const inProject = g.has("personal");
    const questions: DecisionQuestion[] = [];
    const items: Array<{ id: string; kind: string; text: string; paths?: string[] }> = [];
    prepared.forEach((p, i) => {
      if (!p.text) {
        p.discard = "empty";
        return;
      }
      const id = `c${i}`;
      const needScope = p.c.scope === undefined;
      const willHaveTrigger = (p.c.paths?.length ?? 0) > 0 || (p.c.anchors?.length ?? 0) > 0 || (p.triggers?.commands?.length ?? 0) > 0 || p.signature.some(looksLikePath);
      const needUrgency = p.urgency === undefined;
      if (!needScope && !needUrgency) return;
      items.push({ id, kind: p.kind, text: p.text.slice(0, 1200), ...(p.c.paths?.length ? { paths: p.c.paths } : {}) });
      if (needScope) {
        const options = [
          { value: "global", description: "true for the user across projects" },
          ...(inProject ? [{ value: "project_shared", description: "true for anyone working on this repo" }, { value: "project_personal", description: "about this user's setup or work in this repo" }] : []),
          ...(p.c.keep ? [] : [{ value: "discard", description: "not worth remembering" }]),
        ];
        questions.push({ kind: "choice", name: `scope.${id}`, instructions: `Where does memory ${id} belong?`, options });
        questions.push({ kind: "binary", name: `sensitive.${id}`, instructions: `Does memory ${id} contain personal, confidential, or credential-like information?` });
      }
      if (needUrgency) questions.push(urgencyQuestion(`urgency.${id}`, id, willHaveTrigger));
    });
    let answers: Record<string, DecisionAnswer> = {};
    if (questions.length && this.s.decision.available()) {
      answers = await this.s.decision.decide({ task: "Route new long-term memories for a coding agent.", project: g.project.root ? "inside a project" : "outside any project", memories: items }, questions, { callSite: "write.route", timeoutMs: TIMEOUTS.routing, signal });
    }
    prepared.forEach((p, i) => {
      if (p.discard) return;
      const id = `c${i}`;
      if (p.c.scope !== undefined) {
        // the named scope is used as is, except that personal-sensitivity memories never go shared
        let scope: ScopeName | null = p.c.scope;
        if (scope === "shared" && p.sensitivity === "personal") scope = "personal";
        if (!g.has(scope) || !g.writable(scope)) scope = this.fallbackScope(p);
        if (!scope) p.discard = "no writable scope";
        else {
          if (scope !== p.c.scope) p.reroutedFrom = p.c.scope;
          p.scope = scope;
        }
      } else {
        const probs = choiceProbs(answers, `scope.${id}`);
        const sensitive = binaryP(answers, `sensitive.${id}`) ?? null;
        if (sensitive !== null && sensitive >= 0.5) p.sensitivity = "personal";
        const hasRepoPaths = p.signature.some((t) => looksLikePath(t) && !t.startsWith("~") && !/^\/(usr|etc|opt|var|tmp|home|Users)\b/.test(t)) || (p.c.paths?.length ?? 0) > 0;
        if (!probs) {
          const fb = this.fallbackScope(p);
          if (fb) p.scope = fb;
          else p.discard = "no writable scope";
        } else if (!p.c.keep && (probs.discard ?? 0) >= cfg.discard) p.discard = "not worth remembering";
        else if ((probs.project_shared ?? 0) >= (answers[`scope.${id}`]?.calibrated === false ? Math.max(cfg.shared, UNCALIBRATED.sharedRouting) : cfg.shared) && p.sensitivity === "normal" && (sensitive ?? 0) < 0.2 && g.has("shared") && g.writable("shared")) p.scope = "shared";
        else if (p.kind !== "episode" && (probs.global ?? 0) >= cfg.global && !hasRepoPaths && g.writable("global")) p.scope = "global";
        else if (inProject && g.writable("personal")) p.scope = "personal";
        else if ((probs.global ?? 0) >= 0.5 && g.writable("global")) p.scope = "global";
        else if (p.c.keep) {
          const fb = this.fallbackScope(p);
          if (fb) p.scope = fb;
          else p.discard = "no writable scope";
        } else p.discard = "not worth remembering outside a project";
      }
      if (p.discard || !p.scope) return;
      this.anchor(p);
      const triggered = p.anchors.length > 0 || (p.triggers?.commands?.length ?? 0) > 0;
      if (p.urgency !== undefined) p.urgency = capUrgency(p.urgency, triggered);
      else {
        const picked = pickUrgency(answers[`urgency.${id}`], triggered, defaultUrgency(p.kind, p.c.severity));
        p.urgency = picked.urgency;
        p.urgencyBy = picked.by;
      }
    });
  }

  /** `paths` become `applies` anchors for rules and `about` anchors for facts; harvested memories get file anchors from their signature (§6.8.1). */
  private anchor(p: Prepared): void {
    const scope = p.scope!;
    const role = p.c.anchorRole ?? (p.kind === "rule" || p.kind === "procedure" || p.kind === "preference" ? "applies" : "about");
    const out: PathAnchor[] = [...(p.c.anchors ?? [])];
    const key = (a: PathAnchor) => `${a.kind}|${a.pathId ?? ""}|${a.glob ?? ""}|${a.symbol ?? ""}`;
    const seen = new Set(out.map(key));
    for (const spec of p.c.paths ?? []) {
      const a = this.s.paths.makeAnchor(scope, spec, role);
      if (a && !seen.has(key(a))) {
        seen.add(key(a));
        out.push(a);
      }
    }
    if (!p.c.paths?.length && !p.c.anchors?.length && p.c.origin !== "instructions") {
      for (const a of this.s.paths.anchorsFromSignature(scope, p.signature, p.kind === "rule" || p.kind === "procedure" ? role : "about")) {
        if (!seen.has(key(a))) {
          seen.add(key(a));
          out.push(a);
        }
      }
    }
    p.anchors = out;
  }

  // ───────────── steps 7–11
  /** Nodes similar to a text, with pair similarity on the active scale (reconciliation after ingest). */
  async similar(text: string, scopes: ScopeName[], limit = 8, signal?: AbortSignal): Promise<Array<{ ref: ScopedNode; sim: number; mode: SimMode }>> {
    const enc = await this.s.sim.encode(text, "document", signal);
    return this.similarIn(scopes, enc, text, ["active"], limit);
  }

  private similarIn(scopes: ScopeName[], enc: Encoded, text: string, statuses: string[], limit: number): Array<{ ref: ScopedNode; sim: number; mode: SimMode }> {
    const g = this.s.graph;
    const out: Array<{ ref: ScopedNode; sim: number; mode: SimMode }> = [];
    for (const scope of scopes) {
      if (!g.has(scope)) continue;
      const h = g.handle(scope);
      if (!h.index) continue;
      const ok = (id: string) => {
        const n = h.store.sd.getNode(id);
        return !!n && statuses.includes(n.status);
      };
      const lists = [this.s.sim.searchVectors(h.index.vectors, enc, { limit: 8, filter: ok }).hits, h.index.bm25(text, { limit: 5, statuses })];
      for (const hit of rrf(lists).slice(0, 10)) {
        const node = h.store.sd.getNode(hit.id);
        if (!node || !statuses.includes(node.status)) continue;
        // without vectors the comparison is lexical, on the memory text itself
        const pair = this.s.sim.pair(h, { ...enc, text }, node.id, node.text);
        out.push({ ref: { scope, node }, ...pair });
      }
    }
    return out.sort((a, b) => b.sim - a.sim).slice(0, limit);
  }

  private reinforceEvent(node: MemoryNode, u = 1): StrengthEvent {
    const now = this.s.clock();
    return { id: `r-${randomId8()}`, t: now.toISOString(), kind: "reinforce", value: u, n: recentUses(node, now) };
  }

  /** Merge a candidate into an existing node: revive, add evidence, reinforce, touch (§6.3.2 step 8). */
  private mergeInto(target: ScopedNode, p: Prepared, touched: Set<ScopeName>): WriteResult {
    const g = this.s.graph;
    const sd = g.sd(target.scope);
    const now = this.s.clock().toISOString();
    const node = target.node;
    if (node.status !== "active") reviveNode(g, target, this.s.clock());
    for (const e of p.evidence) sd.addEvidence(node.id, e);
    for (const a of p.anchors) sd.setAnchor(node.id, a);
    sd.addStrengthEvent(node.id, this.reinforceEvent(node));
    const patch: Parameters<typeof sd.patchNode>[1] = { lastAccessAt: now };
    // an explicit urgency on a merge is an override (§6.10.4: moving down happens only this way)
    if (p.c.urgency !== undefined && p.urgency && p.urgency !== node.urgency) {
      patch.urgency = p.urgency;
      patch.urgencyBy = p.urgencyBy ?? "agent";
      patch.violationsBaseline = { ...(node.violationsBaseline ?? {}), [p.urgency]: node.counters[`violations_${p.urgency}`] };
    }
    if (p.c.pin && !node.pinned) {
      patch.pinned = true;
      patch.layer = "long";
    }
    if (p.c.severity && !node.severity) patch.severity = p.c.severity;
    if (p.triggers?.commands?.length) {
      const commands = [...new Set([...(node.triggers?.commands ?? []), ...p.triggers.commands])];
      const on = [...new Set([...(node.triggers?.on ?? []), ...(p.triggers.on ?? [])])];
      patch.triggers = { ...(on.length ? { on } : {}), commands };
    }
    const sig = [...new Set([...node.signature, ...p.signature])].slice(0, 48);
    if (sig.length !== node.signature.length) patch.signature = sig;
    sd.patchNode(node.id, patch);
    touched.add(target.scope);
    return { status: "merged", id: node.id, scope: target.scope, urgency: sd.getNode(node.id)!.urgency };
  }

  private buildNode(p: Prepared, id: string): MemoryNode {
    const now = this.s.clock().toISOString();
    const c = p.c;
    const pinned = c.pin === true || c.origin === "instructions";
    const explicit = c.origin === "explicit";
    const layer: Layer = c.layer ?? (pinned || explicit ? "long" : "short");
    const v0 = c.strength ?? (pinned ? V0.pinned : explicit ? V0.explicit : V0.normal);
    return {
      id,
      layer,
      kind: p.kind,
      origin: c.origin,
      anchors: p.anchors,
      severity: p.kind === "rule" ? (c.severity ?? "should") : c.severity,
      urgency: p.urgency ?? "passive",
      urgencyBy: p.urgencyBy ?? "default",
      triggers: p.triggers,
      source: c.source,
      title: p.title,
      text: p.text,
      evidence: p.evidence,
      evaluation: c.evaluation,
      validFrom: c.validFrom ?? now,
      status: "active",
      pinned,
      sensitivity: p.sensitivity,
      signature: p.signature,
      confidence: clamp(c.confidence ?? (p.evidence.some((e) => e.verified) ? 0.8 : explicit || pinned ? 0.7 : 0.5), 0, 1),
      createdAt: now,
      createdTurn: this.s.graph.sd(p.scope!).turns(),
      lastAccessAt: now,
      strength: { base: { v: clamp(v0, 0, 1), t: now }, events: [] },
      counters: zeroCounters(),
      provenance: { actor: this.s.actorId, sessionId: c.provenance?.sessionId ?? this.s.sessionId, turnId: c.provenance?.turnId, entryIds: c.provenance?.entryIds },
      contentHash: contentHash(p.text),
      decayDivisor: c.decayDivisor,
    };
  }

  private async store(p: Prepared, signal: AbortSignal | undefined, touched: Set<ScopeName>): Promise<WriteResult> {
    const g = this.s.graph;
    const sim = this.s.sim;
    const scope = p.scope!;
    const sd = g.sd(scope);
    const h = g.handle(scope);
    const probe: MemoryNode = this.buildNode(p, "00000000");
    const text = embedText(probe);
    // 7. embed (cached by content); 8. de-duplicate
    const enc = await sim.encode(text, "document", signal);
    if (!p.c.skipDedup) {
      // dormant nodes revive on an exact content match or a high-confidence lexical hit (§6.5.4)
      const exact = sd.allNodes().find((n) => n.contentHash === probe.contentHash && n.kind === p.kind && (n.status === "active" || n.status === "dormant"));
      if (exact) return this.mergeInto({ scope, node: exact }, p, touched);
      if (h.index) {
        for (const hit of h.index.bm25(p.text, { limit: 3, statuses: ["dormant"] })) {
          const n = sd.getNode(hit.id);
          if (n && n.kind === p.kind && sim.pair(h, { text: p.text }, n.id, n.text).sim >= sim.threshold("dedup", "lexical")) return this.mergeInto({ scope, node: n }, p, touched);
        }
      }
    }
    // candidates for de-dup (same scope) and for conflicts (visible scopes)
    const near = this.similarIn(g.visible(), enc, p.text, ["active"], 12);
    const dedupT = (m: SimMode) => sim.threshold("dedup", m);
    const conflictT = (m: SimMode) => sim.threshold("conflict", m);
    const dup = p.c.skipDedup ? undefined : near.find((x) => x.ref.scope === scope && x.ref.node.kind === p.kind && x.sim >= dedupT(x.mode));
    // without an embedding model, conflict candidates are the BM25 top-5 that share real wording
    let conflicts = p.c.skipConflicts ? [] : near.filter((x) => x !== dup && x.sim >= (x.mode === "lexical" ? LEXICAL_CONFLICT_MIN : conflictT(x.mode))).slice(0, 5);
    // learning from use: a few pairs just below the threshold are judged too (§9.2.4)
    const below = p.c.skipConflicts ? undefined : near.find((x) => x.mode !== "lexical" && x.sim < conflictT(x.mode) && x.sim >= conflictT(x.mode) - 0.1);
    const sampled = below && sim.sampleBelow() ? below : undefined;

    // 9. one decision request judges every pair
    const judged = [...(dup ? [dup] : []), ...conflicts, ...(sampled ? [sampled] : [])];
    let answers: Record<string, DecisionAnswer> = {};
    if (judged.length && this.s.decision.available()) {
      const questions: DecisionQuestion[] = [];
      judged.forEach((x, j) => {
        if (x === dup) {
          questions.push({ kind: "binary", name: `same.${j}`, instructions: `Do the new memory and existing memory ${j} state the same thing, so that keeping both would be redundant?` });
          return;
        }
        questions.push({
          kind: "choice",
          name: `rel.${j}`,
          instructions: `How does the new memory relate to existing memory ${j}?`,
          options: [
            { value: "compatible", description: "both can be true; they overlap or complement each other" },
            { value: "contradictory", description: "they cannot both be true now" },
            { value: "subsumes", description: "the new memory is more general and covers the existing one" },
            { value: "subsumed", description: "the existing memory is more general and already covers the new one" },
            { value: "unrelated", description: "they are about different things" },
          ],
        });
        questions.push({ kind: "binary", name: `newer.${j}`, instructions: `Does the new memory describe the current state and replace existing memory ${j}?` });
      });
      answers = await this.s.decision.decide(
        { new: { kind: p.kind, text: p.text, as_of: p.c.validFrom ?? this.s.clock().toISOString() }, existing: judged.map((x, j) => ({ j, kind: x.ref.node.kind, scope: x.ref.scope, text: x.ref.node.text.slice(0, 1200), as_of: x.ref.node.validFrom ?? x.ref.node.createdAt })) },
        questions,
        { callSite: "write.conflict", timeoutMs: TIMEOUTS.conflict, signal },
      );
    }
    const verdict = (x: (typeof judged)[number]): { rel: string; newer: number } => {
      const j = judged.indexOf(x);
      const probs = choiceProbs(answers, `rel.${j}`);
      let rel = "unrelated";
      if (probs) rel = Object.entries(probs).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unrelated";
      else if (x.mode !== "lexical") rel = "compatible"; // no judge: above the threshold means related, nothing more
      return { rel, newer: binaryP(answers, `newer.${j}`) ?? 0 };
    };
    if (dup) {
      const same = binaryP(answers, `same.${judged.indexOf(dup)}`);
      if (same !== undefined) sim.logPair("dedup", dup.sim, same >= 0.5, { mode: dup.mode });
      return this.mergeInto(dup.ref, p, touched);
    }
    if (sampled && answers[`rel.${judged.indexOf(sampled)}`]) sim.logPair("conflict", sampled.sim, verdict(sampled).rel !== "unrelated", { below: true, mode: sampled.mode });
    conflicts = conflicts.filter((x) => x !== sampled);
    const verdicts = conflicts.map((x) => ({ x, ...verdict(x) }));
    for (const v of verdicts) if (answers[`rel.${judged.indexOf(v.x)}`] && v.x.mode !== "lexical") sim.logPair("conflict", v.x.sim, v.rel !== "unrelated", { mode: v.x.mode });

    // subsumed: the existing memory already covers this one — merge the evidence, no new node
    const subsumedBy = verdicts.find((v) => v.rel === "subsumed" && mayMutate(scope, v.x.ref.scope) && g.writable(v.x.ref.scope));
    // anchors point into the candidate's scope registry: they only carry over within one scope
    if (subsumedBy) return this.mergeInto(subsumedBy.x.ref, { ...p, anchors: subsumedBy.x.ref.scope === scope ? p.anchors : [] }, touched);

    // 10. insert
    const id = g.newId();
    let node = this.buildNode(p, id);
    // fail-safe when the conflict judge gave no answer: insert, and let hygiene re-check (§9.1.6)
    if (conflicts.length && !verdicts.some((v) => answers[`rel.${judged.indexOf(v.x)}`])) node.flags = ["conflict-recheck"];
    const result: WriteResult = { status: "created", id, scope, urgency: node.urgency, superseded: [], conflicts: [], subsumed: [] };

    // subsumes: the aux LLM folds the older node's unique content into the new one
    const absorbed: ScopedNode[] = [];
    for (const v of verdicts.filter((v) => v.rel === "subsumes")) {
      const old = v.x.ref;
      if (!mayMutate(scope, old.scope) || !g.writable(old.scope) || old.node.pinned) continue;
      const merged = await this.mergeTexts(node, old.node, signal);
      if (!merged) continue; // fail-safe: both stay, as compatible
      node = { ...node, title: merged.title, text: merged.text, contentHash: contentHash(merged.text), evidence: dedupeEvidence([...node.evidence, ...old.node.evidence]), signature: [...new Set([...node.signature, ...old.node.signature])].slice(0, 48) };
      absorbed.push(old);
    }
    sd.insertNode(node);
    touched.add(scope);
    this.inserted = { scope, node, enc };
    const self: ScopedNode = { scope, node };
    const now = this.s.clock().toISOString();

    for (const old of absorbed) {
      const osd = g.sd(old.scope);
      osd.patchNode(old.node.id, { status: "archived", statusReason: `subsumed by m:${id}`, statusAt: now });
      g.setEdgesActive({ scope: old.scope, node: osd.getNode(old.node.id)! }, false);
      this.linkOutward({ scope: old.scope, node: old.node }, "part-of", self, 0.8);
      touched.add(old.scope);
      result.subsumed!.push(old.node.id);
    }
    for (const v of verdicts) {
      const old = v.x.ref;
      if (absorbed.includes(old)) continue;
      const canMutate = mayMutate(scope, old.scope) && g.writable(old.scope);
      if (v.rel === "contradictory" && v.newer >= 0.7) {
        this.supersede(self, old, canMutate, touched);
        result.superseded!.push(old.node.id);
      } else if (v.rel === "contradictory") {
        this.linkOutward(self, "contradicts", old, 0.6);
        this.linkOutward(old, "contradicts", self, 0.6);
        touched.add(old.scope);
        result.conflicts!.push(old.node.id);
      } else if (v.rel === "compatible" || v.rel === "subsumes" || v.rel === "subsumed") {
        // overlapping knowledge: the existing node matters a little less (F form)
        if (canMutate && old.node.importance !== undefined) {
          g.sd(old.scope).patchNode(old.node.id, { importance: clamp(old.node.importance * (1 - OMEGA * clamp(sim.toUnit(v.x.sim, v.x.mode), 0, 1)), 0, 1) }, "counters");
          touched.add(old.scope);
        }
        if (v.x.mode !== "lexical" && v.x.sim >= sim.threshold("analogous", v.x.mode)) this.linkOutward(self, "analogous-to", old, clamp(sim.toUnit(v.x.sim, v.x.mode), 0, 1));
      }
    }
    // Palim's `supersedes` hint names the fact this one replaces
    if (p.c.supersedesHint && !result.superseded!.length) {
      const old = await this.findByHint(p.c.supersedesHint, self, signal);
      if (old) {
        this.supersede(self, old, mayMutate(scope, old.scope) && g.writable(old.scope), touched);
        result.superseded!.push(old.node.id);
      }
    }
    // 11. link
    if (p.c.episode) {
      const ep = g.getIn(p.c.episode.scope, p.c.episode.id);
      if (ep) this.linkOutward(self, "derived-from", { scope: p.c.episode.scope, node: ep }, 0.7);
    }
    if (p.c.after && p.kind === "episode") {
      const prev = g.getIn(p.c.after.scope, p.c.after.id);
      if (prev) this.linkOutward({ scope: p.c.after.scope, node: prev }, "precedes", self, 0.5);
    }
    for (const k of ["superseded", "conflicts", "subsumed"] as const) if (!result[k]!.length) delete result[k];
    return result;
  }

  /**
   * Hygiene's conflict re-check (§9.1.6): a node that was inserted while the judge was
   * unavailable is compared with its neighbours again. Returns false when there is still no answer.
   */
  async recheck(self: ScopedNode, signal?: AbortSignal): Promise<boolean> {
    const g = this.s.graph;
    const sim = this.s.sim;
    const sd = g.sd(self.scope);
    const clear = () => sd.patchNode(self.node.id, { flags: (self.node.flags ?? []).filter((f) => f !== "conflict-recheck") });
    const enc = await sim.encode(embedText(self.node), "document", signal);
    const near = this.similarIn(g.visible(), enc, self.node.text, ["active"], 8)
      .filter((x) => !(x.ref.scope === self.scope && x.ref.node.id === self.node.id))
      .filter((x) => x.sim >= (x.mode === "lexical" ? LEXICAL_CONFLICT_MIN : sim.threshold("conflict", x.mode)))
      .filter((x) => !g.neighbors(self).some((n) => n.other.node.id === x.ref.node.id && ["supersedes", "contradicts", "part-of"].includes(n.edge.rel)))
      .slice(0, 5);
    if (!near.length) {
      clear();
      g.commit(self.scope, "conflict-recheck");
      return true;
    }
    if (!this.s.decision.available()) return false;
    const questions: DecisionQuestion[] = [];
    near.forEach((_, j) => {
      questions.push({ kind: "choice", name: `rel.${j}`, instructions: `How does memory A relate to memory ${j}?`, options: [{ value: "compatible" }, { value: "contradictory", description: "they cannot both be true now" }, { value: "unrelated" }] });
      questions.push({ kind: "binary", name: `newer.${j}`, instructions: `Does memory A describe the current state and replace memory ${j}?` });
    });
    const answers = await this.s.decision.decide({ A: { text: self.node.text, as_of: self.node.validFrom ?? self.node.createdAt }, others: near.map((x, j) => ({ j, text: x.ref.node.text.slice(0, 1200), as_of: x.ref.node.validFrom ?? x.ref.node.createdAt })) }, questions, { callSite: "write.conflict", timeoutMs: TIMEOUTS.conflict, signal });
    if (!Object.keys(answers).length) return false;
    const touched = new Set<ScopeName>([self.scope]);
    near.forEach((x, j) => {
      const probs = choiceProbs(answers, `rel.${j}`);
      if (!probs) return;
      const rel = Object.entries(probs).sort((a, b) => b[1] - a[1])[0]?.[0];
      if (x.mode !== "lexical") sim.logPair("conflict", x.sim, rel !== "unrelated", { mode: x.mode });
      if (rel !== "contradictory") return;
      const newer = binaryP(answers, `newer.${j}`) ?? 0;
      const selfNewer = (self.node.validFrom ?? self.node.createdAt) >= (x.ref.node.validFrom ?? x.ref.node.createdAt);
      if (newer >= 0.7 && selfNewer) this.supersede(self, x.ref, mayMutate(self.scope, x.ref.scope) && g.writable(x.ref.scope), touched);
      else {
        this.linkOutward(self, "contradicts", x.ref, 0.6);
        this.linkOutward(x.ref, "contradicts", self, 0.6);
        touched.add(x.ref.scope);
      }
    });
    clear();
    for (const scope of touched) g.commit(scope, "conflict-recheck");
    return true;
  }

  /** Store an edge in the narrower scope, directed outward from it, where §6.1 allows it. */
  private linkOutward(src: ScopedNode, rel: Relation, dst: ScopedNode, w: number): void {
    this.s.graph.link(src, rel, dst, { w });
  }

  private supersede(next: ScopedNode, old: ScopedNode, canMutate: boolean, touched: Set<ScopeName>): void {
    const g = this.s.graph;
    this.linkOutward(next, "supersedes", old, 0.9);
    if (!canMutate) return;
    const now = this.s.clock();
    const osd = g.sd(old.scope);
    const validFrom = next.node.validFrom ?? now.toISOString();
    const ageGap = Math.max(0, daysBetween(old.node.validFrom ?? old.node.createdAt, validFrom));
    osd.patchNode(old.node.id, { validTo: validFrom });
    if (!old.node.pinned && strengthAt(old.node, now) > 0) {
      osd.addStrengthEvent(old.node.id, { id: `s-${randomId8()}`, t: now.toISOString(), kind: "suppress", value: Math.exp(-RHO_S * Math.min(1, ageGap / W_AGE_DAYS)) });
    }
    touched.add(old.scope);
  }

  private async findByHint(hint: string, self: ScopedNode, signal?: AbortSignal): Promise<ScopedNode | null> {
    const enc = await this.s.sim.encode(hint, "document", signal);
    const hits = this.similarIn(this.s.graph.visible(), enc, hint, ["active"], 4).filter((x) => !(x.ref.scope === self.scope && x.ref.node.id === self.node.id));
    const best = hits[0];
    if (!best) return null;
    const ok = best.mode === "lexical" ? best.sim >= 0.45 : best.sim >= this.s.sim.threshold("conflict", best.mode);
    return ok ? best.ref : null;
  }

  private async mergeTexts(next: MemoryNode, old: MemoryNode, signal?: AbortSignal): Promise<{ title: string; text: string } | null> {
    const aux = this.s.aux;
    if (!aux?.available()) return null;
    const res = await aux.run<{ title: string; text: string }>({
      role: "write.merge",
      instructions:
        "Merge two memory notes into one. The NEW note is more general and stays the frame; fold in every unique fact, value, path and command of the OLD note. Add nothing that is in neither note. Keep it to one memory: a title of at most 15 words and a compact text.",
      data: [
        { label: "NEW", text: `${next.title}\n${next.text}` },
        { label: "OLD", text: `${old.title}\n${old.text}` },
      ],
      schema: { type: "object", additionalProperties: false, required: ["title", "text"], properties: { title: { type: "string" }, text: { type: "string" } } },
      tools: "none",
      signal,
    });
    const out = res.output;
    if (!out || typeof out.text !== "string" || !out.text.trim()) return null;
    const scan = scanSecrets(sanitize(out.text).trim());
    return { title: makeTitle(sanitize(out.title || scan.redacted)), text: scan.redacted };
  }
}

function dedupeEvidence(list: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  return list.filter((e) => {
    const k = `${e.quote}|${e.source.type}:${e.source.ref}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
