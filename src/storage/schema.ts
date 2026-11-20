/**
 * Loro document schema for one scope (§7.3) and typed accessors over it.
 *
 * LoroDoc
 * ├── meta     LoroMap   schema, minWriter, migrations, scope, projectId, createdAt, peers
 * ├── nodes    LoroMap   nodeId → LoroMap (plain fields + anchors/evidence/counters/strength children)
 * ├── edges    LoroMap   edgeId → LoroMap { src, rel, dst, w, evidenceAt, active }
 * ├── paths    LoroTree  path registry (§6.8.2)
 * ├── sources  LoroMap   instruction file → { sha, mode, sections }
 * └── turns    LoroCounter
 */
import { LoroCounter, LoroDoc, LoroMap, type LoroTree, type LoroTreeNode, type TreeID } from "loro-crdt";
import {
  COUNTER_NAMES,
  type Evidence,
  KINDS,
  type MemoryEdge,
  type MemoryNode,
  type PathAnchor,
  type PathNodeData,
  RELATIONS,
  type StrengthEvent,
  type UseCounters,
  zeroCounters,
} from "../core/types.ts";
import { sha256 } from "../util/text.ts";

const SCHEMA_VERSION = 1;
/** Schema version this build writes. Clients older than meta.minWriter open read-only (§7.13). */
const WRITER_VERSION = 1;
export const REALCTX2_VERSION = "0.6.0";

export const PLAIN_FIELDS = [
  "layer",
  "kind",
  "origin",
  "severity",
  "urgency",
  "urgencyBy",
  "triggers",
  "source",
  "verifiedAt",
  "title",
  "text",
  "evaluation",
  "validFrom",
  "validTo",
  "status",
  "statusReason",
  "statusAt",
  "pinned",
  "sensitivity",
  "signature",
  "confidence",
  "importance",
  "createdAt",
  "createdTurn",
  "lastAccessAt",
  "lastDeliveredAt",
  "provenance",
  "contentHash",
  "flags",
  "violationsBaseline",
  "aliasOf",
  "decayDivisor",
] as const;
export type PlainField = (typeof PLAIN_FIELDS)[number];
const CHILD_FIELDS = new Set(["anchors", "evidence", "counters", "strength"]);
const KNOWN = new Set<string>([...PLAIN_FIELDS, ...CHILD_FIELDS]);

export type NodePatch = Partial<Pick<MemoryNode, PlainField>>;

export function anchorKey(a: PathAnchor): string {
  return sha256([a.kind, a.pathId ?? "", a.glob ?? "", a.symbol ?? "", a.role].join("|")).slice(0, 16);
}

export function evidenceKey(e: Evidence): string {
  return sha256(`${e.quote}|${e.source.type}:${e.source.ref}`).slice(0, 16);
}

function edgeId(src: string, rel: string, dst: string): string {
  return sha256(`${src}|${rel}|${dst}`).slice(0, 24);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, d = ""): string {
  return typeof v === "string" ? v : d;
}

function milli(x: number): number {
  return Math.round(x * 1000);
}

export interface InvalidNode {
  id: string;
  problem: string;
}

/** Parse a node's JSON form. Returns a problem string for nodes that fail the schema check (§7.12). */
export function nodeFromJson(id: string, j: unknown): MemoryNode | string {
  if (!isRecord(j)) return "not a map";
  if (typeof j.text !== "string") return "missing text";
  if (typeof j.kind !== "string" || !KINDS.includes(j.kind as MemoryNode["kind"])) return `bad kind ${String(j.kind)}`;
  if (j.layer !== "short" && j.layer !== "long") return `bad layer ${String(j.layer)}`;
  const status = str(j.status, "active");
  if (!["active", "dormant", "archived", "purged"].includes(status)) return `bad status ${status}`;
  const counters = zeroCounters();
  if (isRecord(j.counters)) {
    for (const name of COUNTER_NAMES) {
      const v = j.counters[name];
      if (typeof v === "number") counters[name] = v / 1000;
    }
  }
  const anchors: PathAnchor[] = [];
  if (isRecord(j.anchors)) {
    for (const k of Object.keys(j.anchors).sort()) {
      const a = j.anchors[k];
      if (!isRecord(a) || a.removed === true) continue;
      if (!["subtree", "file", "glob", "symbol"].includes(str(a.kind))) continue;
      anchors.push({
        kind: a.kind as PathAnchor["kind"],
        pathId: typeof a.pathId === "string" ? a.pathId : undefined,
        glob: typeof a.glob === "string" ? a.glob : undefined,
        symbol: typeof a.symbol === "string" ? a.symbol : undefined,
        role: a.role === "applies" ? "applies" : "about",
        seenBlob: typeof a.seenBlob === "string" ? a.seenBlob : undefined,
        status: a.status === "stale" ? "stale" : "live",
        staleAt: typeof a.staleAt === "string" ? a.staleAt : undefined,
      });
    }
  }
  const evidence: Evidence[] = [];
  if (isRecord(j.evidence)) {
    for (const k of Object.keys(j.evidence).sort()) {
      const e = j.evidence[k];
      if (!isRecord(e) || typeof e.quote !== "string") continue;
      const src = isRecord(e.source) ? e.source : {};
      evidence.push({ quote: e.quote, source: { type: str(src.type, "session"), ref: str(src.ref) }, time: typeof e.time === "string" ? e.time : undefined, verified: e.verified === true });
    }
  }
  const createdAt = str(j.createdAt, new Date(0).toISOString());
  let base = { v: 0.6, t: createdAt };
  const events: StrengthEvent[] = [];
  if (isRecord(j.strength)) {
    if (isRecord(j.strength.base) && typeof j.strength.base.v === "number") base = { v: j.strength.base.v, t: str(j.strength.base.t, createdAt) };
    if (isRecord(j.strength.events)) {
      for (const [eid, e] of Object.entries(j.strength.events)) {
        if (!isRecord(e) || typeof e.t !== "string" || typeof e.value !== "number") continue;
        events.push({ id: eid, t: e.t, kind: (["reinforce", "suppress", "layer", "set"].includes(str(e.kind)) ? e.kind : "reinforce") as StrengthEvent["kind"], value: e.value, n: typeof e.n === "number" ? e.n : undefined, layer: e.layer === "long" || e.layer === "short" ? e.layer : undefined });
      }
      events.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.id < b.id ? -1 : 1));
    }
  }
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(j)) if (!KNOWN.has(k)) extra[k] = v;
  const node: MemoryNode = {
    id,
    layer: j.layer,
    kind: j.kind as MemoryNode["kind"],
    origin: (["harvest", "instructions", "explicit", "operator", "auto-memory"].includes(str(j.origin)) ? j.origin : "harvest") as MemoryNode["origin"],
    anchors,
    severity: ["must", "should", "may", "info"].includes(str(j.severity)) ? (j.severity as MemoryNode["severity"]) : undefined,
    urgency: (["immediate", "hint", "caption", "passive"].includes(str(j.urgency)) ? j.urgency : "passive") as MemoryNode["urgency"],
    urgencyBy: (["decision", "agent", "user", "escalation", "default"].includes(str(j.urgencyBy)) ? j.urgencyBy : "default") as MemoryNode["urgencyBy"],
    triggers: isRecord(j.triggers) ? (j.triggers as MemoryNode["triggers"]) : undefined,
    source: isRecord(j.source) && typeof j.source.file === "string" ? (j.source as unknown as MemoryNode["source"]) : undefined,
    verifiedAt: typeof j.verifiedAt === "string" ? j.verifiedAt : undefined,
    title: str(j.title),
    text: j.text,
    evidence,
    evaluation: ["good", "bad", "neutral"].includes(str(j.evaluation)) ? (j.evaluation as MemoryNode["evaluation"]) : undefined,
    validFrom: typeof j.validFrom === "string" ? j.validFrom : undefined,
    validTo: typeof j.validTo === "string" ? j.validTo : undefined,
    status: status as MemoryNode["status"],
    statusReason: typeof j.statusReason === "string" ? j.statusReason : undefined,
    statusAt: typeof j.statusAt === "string" ? j.statusAt : undefined,
    pinned: j.pinned === true,
    sensitivity: j.sensitivity === "personal" ? "personal" : "normal",
    signature: Array.isArray(j.signature) ? j.signature.filter((s): s is string => typeof s === "string") : [],
    confidence: typeof j.confidence === "number" ? j.confidence : 0.5,
    importance: typeof j.importance === "number" ? j.importance : undefined,
    createdAt,
    createdTurn: typeof j.createdTurn === "number" ? j.createdTurn : 0,
    lastAccessAt: str(j.lastAccessAt, createdAt),
    lastDeliveredAt: typeof j.lastDeliveredAt === "string" ? j.lastDeliveredAt : undefined,
    strength: { base, events },
    counters,
    provenance: isRecord(j.provenance) ? { actor: str(j.provenance.actor, "unknown"), sessionId: typeof j.provenance.sessionId === "string" ? j.provenance.sessionId : undefined, turnId: typeof j.provenance.turnId === "string" ? j.provenance.turnId : undefined, entryIds: Array.isArray(j.provenance.entryIds) ? (j.provenance.entryIds as string[]) : undefined } : { actor: "unknown" },
    contentHash: str(j.contentHash),
    flags: Array.isArray(j.flags) ? (j.flags as string[]) : undefined,
    violationsBaseline: isRecord(j.violationsBaseline) ? (j.violationsBaseline as MemoryNode["violationsBaseline"]) : undefined,
    aliasOf: typeof j.aliasOf === "string" ? j.aliasOf : undefined,
    decayDivisor: typeof j.decayDivisor === "number" ? j.decayDivisor : undefined,
  };
  if (Object.keys(extra).length) node.extra = extra;
  return node;
}

function edgeFromJson(id: string, j: unknown): MemoryEdge | null {
  if (!isRecord(j) || j.removed === true) return null;
  if (typeof j.src !== "string" || typeof j.dst !== "string" || !RELATIONS.includes(j.rel as MemoryEdge["rel"])) return null;
  return {
    id,
    src: j.src,
    dst: j.dst,
    rel: j.rel as MemoryEdge["rel"],
    w: typeof j.w === "number" ? Math.max(0, Math.min(1, j.w)) : 0.5,
    evidenceAt: str(j.evidenceAt, new Date(0).toISOString()),
    active: j.active !== false,
    dstScope: j.dstScope === "global" || j.dstScope === "personal" || j.dstScope === "shared" ? j.dstScope : undefined,
  };
}

export interface SourceSection {
  hash: string;
  itemIds: string[];
}

export interface SourceEntry {
  file: string;
  sha: string;
  /** "ingested": sliced and deleted; "import": reached through @path and kept; "pointer": non-markdown import. */
  mode: string;
  ingestedAt?: string;
  importedBy?: string;
  sections: Record<string, SourceSection>;
}

export interface PathEntry {
  id: string;
  path: string;
  data: PathNodeData;
}

/** Typed access to one scope's Loro document. Local writes are grouped by `commit()`. */
export class ScopeDoc {
  doc: LoroDoc;
  private nodeCache: Map<string, MemoryNode> | null = null;
  private edgeCache: Map<string, MemoryEdge> | null = null;
  private pathCache: { byId: Map<string, PathEntry>; byPath: Map<string, string[]> } | null = null;
  invalid: InvalidNode[] = [];
  /** Bumped on every edge change, so adjacency caches know when to rebuild. */
  edgeEpoch = 0;
  /** Classification of uncommitted-to-disk local writes (§7.5). */
  dirty: "none" | "counters" | "substantive" = "none";
  counterDeltas = 0;

  constructor(doc: LoroDoc) {
    this.doc = doc;
  }

  static create(meta: { scope: string; projectId?: string; createdAt?: string }): ScopeDoc {
    const doc = new LoroDoc();
    doc.setRecordTimestamp(true);
    const sd = new ScopeDoc(doc);
    const m = doc.getMap("meta");
    m.set("schema", SCHEMA_VERSION);
    m.set("minWriter", WRITER_VERSION);
    m.set("scope", meta.scope);
    if (meta.projectId) m.set("projectId", meta.projectId);
    m.set("createdAt", meta.createdAt ?? new Date().toISOString());
    doc.commit({ message: "init" });
    return sd;
  }

  // ───────────── bookkeeping
  /** Swap the underlying document (reload after a purge or a failed refresh). */
  replace(doc: LoroDoc): void {
    this.doc = doc;
    this.invalidate();
  }

  invalidate(): void {
    this.nodeCache = null;
    this.edgeCache = null;
    this.pathCache = null;
    this.edgeEpoch++;
  }

  private touch(kind: "counters" | "substantive"): void {
    if (kind === "substantive") this.dirty = "substantive";
    else {
      if (this.dirty === "none") this.dirty = "counters";
      this.counterDeltas++;
    }
  }

  commit(message?: string): void {
    this.doc.commit(message ? { message } : undefined);
  }

  // ───────────── meta
  meta(): { schema: number; minWriter: number; scope: string; projectId?: string; createdAt?: string; migrations: string[]; peers: Record<string, { actorId: string; version: string }> } {
    const j = this.doc.getMap("meta").toJSON() as Record<string, unknown>;
    return {
      schema: typeof j.schema === "number" ? j.schema : SCHEMA_VERSION,
      minWriter: typeof j.minWriter === "number" ? j.minWriter : WRITER_VERSION,
      scope: str(j.scope),
      projectId: typeof j.projectId === "string" ? j.projectId : undefined,
      createdAt: typeof j.createdAt === "string" ? j.createdAt : undefined,
      migrations: isRecord(j.migrations) ? Object.keys(j.migrations) : [],
      peers: isRecord(j.peers) ? (j.peers as Record<string, { actorId: string; version: string }>) : {},
    };
  }

  /** A client older than minWriter, or facing a newer schema, must not write (§7.13). */
  writable(): boolean {
    const m = this.meta();
    return m.schema <= SCHEMA_VERSION && m.minWriter <= WRITER_VERSION;
  }

  registerPeer(actorId: string): void {
    const peers = this.doc.getMap("meta").ensureMergeableMap("peers");
    const id = this.doc.peerIdStr;
    const cur = peers.get(id) as { actorId?: string; version?: string } | undefined;
    if (cur && cur.actorId === actorId && cur.version === REALCTX2_VERSION) return;
    peers.set(id, { actorId, version: REALCTX2_VERSION });
  }

  /** Deterministic, idempotent migrations registered by ID (§7.13). */
  runMigration(id: string, fn: () => void): boolean {
    const migs = this.doc.getMap("meta").ensureMergeableMap("migrations");
    if (migs.get(id)) return false;
    fn();
    migs.set(id, true);
    this.touch("substantive");
    return true;
  }

  actorOfPeer(peer: string): string | undefined {
    return this.meta().peers[peer]?.actorId;
  }

  // ───────────── nodes
  private nodesMap(): LoroMap {
    return this.doc.getMap("nodes");
  }

  private nodeMap(id: string): LoroMap | null {
    const v = this.nodesMap().get(id);
    return v instanceof LoroMap ? v : null;
  }

  private loadNodes(): Map<string, MemoryNode> {
    if (this.nodeCache) return this.nodeCache;
    const cache = new Map<string, MemoryNode>();
    this.invalid = [];
    const json = this.nodesMap().toJSON() as Record<string, unknown>;
    for (const [id, j] of Object.entries(json)) {
      if (j === null || j === undefined) continue;
      const n = nodeFromJson(id, j);
      if (typeof n === "string") this.invalid.push({ id, problem: n });
      else cache.set(id, n);
    }
    this.nodeCache = cache;
    return cache;
  }

  private refreshNode(id: string): void {
    if (!this.nodeCache) return;
    const m = this.nodeMap(id);
    if (!m) {
      this.nodeCache.delete(id);
      return;
    }
    const n = nodeFromJson(id, m.toJSON());
    if (typeof n === "string") this.nodeCache.delete(id);
    else this.nodeCache.set(id, n);
  }

  hasNode(id: string): boolean {
    return this.nodeMap(id) !== null;
  }

  getNode(id: string): MemoryNode | null {
    return this.loadNodes().get(id) ?? null;
  }

  allNodes(): MemoryNode[] {
    return [...this.loadNodes().values()];
  }

  nodeCount(): number {
    return this.loadNodes().size;
  }

  /** Container id per node key, for ID-collision detection (§8.1.2). */
  nodeContainerIds(): Map<string, string> {
    const out = new Map<string, string>();
    const nodes = this.nodesMap();
    for (const key of nodes.keys()) {
      const v = nodes.get(key);
      if (v instanceof LoroMap) out.set(key, v.id);
    }
    return out;
  }

  /**
   * Create the node with all of its child containers up front (§7.3).
   * `mergeable` is for deterministic re-creation (ID-collision aliases, §8.1.2): two peers
   * doing the same re-insert then merge instead of colliding again.
   */
  insertNode(node: MemoryNode, opts: { mergeable?: boolean } = {}): void {
    const mk = (parent: LoroMap, key: string): LoroMap => (opts.mergeable ? parent.ensureMergeableMap(key) : parent.setContainer(key, new LoroMap()));
    const m = mk(this.nodesMap(), node.id);
    const rec = node as unknown as Record<string, unknown>;
    for (const f of PLAIN_FIELDS) if (rec[f] !== undefined) m.set(f, rec[f] as never);
    if (node.extra) for (const [k, v] of Object.entries(node.extra)) if (!KNOWN.has(k)) m.set(k, v as never);
    const anchors = mk(m, "anchors");
    for (const a of node.anchors) writeAnchor(anchors.ensureMergeableMap(anchorKey(a)), a);
    const evidence = mk(m, "evidence");
    for (const e of node.evidence) writeEvidence(evidence.ensureMergeableMap(evidenceKey(e)), e);
    const counters = mk(m, "counters");
    for (const name of COUNTER_NAMES) {
      const c = opts.mergeable ? counters.ensureMergeableCounter(name) : counters.setContainer(name, new LoroCounter());
      const v = milli(node.counters?.[name] ?? 0);
      if (v) c.increment(v);
    }
    const strength = mk(m, "strength");
    strength.set("base", { v: node.strength.base.v, t: node.strength.base.t });
    const events = mk(strength, "events");
    for (const e of node.strength.events) writeEvent(events.ensureMergeableMap(e.id), e);
    this.touch("substantive");
    this.refreshNode(node.id);
  }

  /** Field writes: last writer wins per key. `undefined` leaves a field alone; `null` clears it. */
  patchNode(id: string, patch: { [K in keyof NodePatch]?: NodePatch[K] | null }, kind: "substantive" | "counters" = "substantive"): boolean {
    const m = this.nodeMap(id);
    if (!m) return false;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || !PLAIN_FIELDS.includes(k as PlainField)) continue;
      if (v === null) m.delete(k);
      else m.set(k, v as never);
    }
    this.touch(kind);
    this.refreshNode(id);
    return true;
  }

  private child(id: string, name: string): LoroMap | null {
    const m = this.nodeMap(id);
    if (!m) return null;
    const c = m.get(name);
    // children created by a later version, or missing after a partial write, are made mergeable
    return c instanceof LoroMap ? c : m.ensureMergeableMap(name);
  }

  setAnchor(id: string, anchor: PathAnchor): boolean {
    const anchors = this.child(id, "anchors");
    if (!anchors) return false;
    const am = anchors.ensureMergeableMap(anchorKey(anchor));
    am.delete("removed");
    writeAnchor(am, anchor);
    this.touch("substantive");
    this.refreshNode(id);
    return true;
  }

  removeAnchor(id: string, anchor: PathAnchor): boolean {
    const anchors = this.child(id, "anchors");
    if (!anchors) return false;
    const key = anchorKey(anchor);
    if (anchors.get(key) === undefined) return false;
    // a tombstone field rather than a key delete, so a concurrent field write cannot resurrect it half-filled
    anchors.ensureMergeableMap(key).set("removed", true);
    this.touch("substantive");
    this.refreshNode(id);
    return true;
  }

  addEvidence(id: string, e: Evidence): boolean {
    const evidence = this.child(id, "evidence");
    if (!evidence) return false;
    writeEvidence(evidence.ensureMergeableMap(evidenceKey(e)), e);
    this.touch("substantive");
    this.refreshNode(id);
    return true;
  }

  /** Counters are LoroCounters in integer milli-units: concurrent increments add up (§7.3). */
  incCounter(id: string, name: keyof UseCounters, delta: number): boolean {
    const v = milli(delta);
    if (v === 0) return false;
    const counters = this.child(id, "counters");
    if (!counters) return false;
    const existing = counters.get(name);
    const c = existing instanceof LoroCounter ? existing : counters.ensureMergeableCounter(name);
    c.increment(v);
    this.touch("counters");
    this.refreshNode(id);
    return true;
  }

  addStrengthEvent(id: string, e: StrengthEvent): boolean {
    const strength = this.child(id, "strength");
    if (!strength) return false;
    const ev = strength.get("events");
    const events = ev instanceof LoroMap ? ev : strength.ensureMergeableMap("events");
    writeEvent(events.ensureMergeableMap(e.id), e);
    this.touch(e.kind === "reinforce" ? "counters" : "substantive");
    this.refreshNode(id);
    return true;
  }

  /** Fold events into `base` and drop them from the map (only events past the safety window, §7.3). */
  foldStrength(id: string, base: { v: number; t: string }, removeEventIds: string[]): boolean {
    const strength = this.child(id, "strength");
    if (!strength) return false;
    strength.set("base", base);
    const ev = strength.get("events");
    if (ev instanceof LoroMap) for (const eid of removeEventIds) ev.delete(eid);
    this.touch("counters");
    this.refreshNode(id);
    return true;
  }

  /**
   * Purge: only explicit forgetting deletes the key (§7.3). Incident edges go with it.
   * Mergeable child containers keep their state after the parent key is gone, so every
   * descendant map is emptied first: otherwise quotes would survive in later snapshots.
   */
  deleteNode(id: string): boolean {
    const m = this.nodeMap(id);
    if (!m) return false;
    scrub(m);
    this.nodesMap().delete(id);
    for (const e of this.allEdges()) if (e.src === id || e.dst === id) this.deleteEdge(e.id);
    this.touch("substantive");
    this.nodeCache?.delete(id);
    return true;
  }

  // ───────────── edges
  private edgesMap(): LoroMap {
    return this.doc.getMap("edges");
  }

  private loadEdges(): Map<string, MemoryEdge> {
    if (this.edgeCache) return this.edgeCache;
    const cache = new Map<string, MemoryEdge>();
    const json = this.edgesMap().toJSON() as Record<string, unknown>;
    for (const [id, j] of Object.entries(json)) {
      const e = edgeFromJson(id, j);
      if (e) cache.set(id, e);
    }
    this.edgeCache = cache;
    return cache;
  }

  allEdges(): MemoryEdge[] {
    return [...this.loadEdges().values()];
  }

  getEdge(id: string): MemoryEdge | null {
    return this.loadEdges().get(id) ?? null;
  }

  putEdge(edge: Omit<MemoryEdge, "id"> & { id?: string }): MemoryEdge {
    const id = edge.id ?? edgeId(edge.src, edge.rel, edge.dst);
    const m = this.edgesMap().ensureMergeableMap(id);
    m.delete("removed");
    m.set("src", edge.src);
    m.set("dst", edge.dst);
    m.set("rel", edge.rel);
    m.set("w", edge.w);
    m.set("evidenceAt", edge.evidenceAt);
    m.set("active", edge.active);
    if (edge.dstScope) m.set("dstScope", edge.dstScope);
    this.touch("substantive");
    this.edgeEpoch++;
    const full = { ...edge, id } as MemoryEdge;
    this.edgeCache?.set(id, full);
    return full;
  }

  patchEdge(id: string, patch: Partial<Pick<MemoryEdge, "w" | "evidenceAt" | "active" | "rel">>): boolean {
    const cur = this.getEdge(id);
    if (!cur) return false;
    const m = this.edgesMap().ensureMergeableMap(id);
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) m.set(k, v as never);
    this.touch("substantive");
    this.edgeEpoch++;
    this.edgeCache?.set(id, { ...cur, ...patch });
    return true;
  }

  deleteEdge(id: string): boolean {
    const cur = this.edgesMap().get(id);
    if (cur === undefined) return false;
    if (cur instanceof LoroMap) scrub(cur);
    this.edgesMap().delete(id);
    this.touch("substantive");
    this.edgeEpoch++;
    this.edgeCache?.delete(id);
    return true;
  }

  // ───────────── sources (§6.9)
  sources(): SourceEntry[] {
    const json = this.doc.getMap("sources").toJSON() as Record<string, unknown>;
    const out: SourceEntry[] = [];
    for (const [file, j] of Object.entries(json)) {
      if (!isRecord(j) || j.removed === true || typeof j.sha !== "string") continue;
      const sections: Record<string, SourceSection> = {};
      if (isRecord(j.sections)) {
        for (const [k, s] of Object.entries(j.sections)) {
          if (isRecord(s) && typeof s.hash === "string") sections[k] = { hash: s.hash, itemIds: Array.isArray(s.itemIds) ? (s.itemIds as string[]) : [] };
        }
      }
      out.push({ file, sha: j.sha, mode: str(j.mode, "ingested"), ingestedAt: typeof j.ingestedAt === "string" ? j.ingestedAt : undefined, importedBy: typeof j.importedBy === "string" ? j.importedBy : undefined, sections });
    }
    return out.sort((a, b) => (a.file < b.file ? -1 : 1));
  }

  getSource(file: string): SourceEntry | null {
    return this.sources().find((s) => s.file === file) ?? null;
  }

  setSource(file: string, fields: { sha: string; mode: string; ingestedAt?: string; importedBy?: string }, sections?: Record<string, SourceSection>): void {
    const m = this.doc.getMap("sources").ensureMergeableMap(file);
    m.delete("removed");
    m.set("sha", fields.sha);
    m.set("mode", fields.mode);
    if (fields.ingestedAt) m.set("ingestedAt", fields.ingestedAt);
    if (fields.importedBy) m.set("importedBy", fields.importedBy);
    if (sections) {
      const sm = m.ensureMergeableMap("sections");
      const keep = new Set(Object.keys(sections));
      for (const k of sm.keys()) if (!keep.has(k)) sm.delete(k);
      for (const [k, s] of Object.entries(sections)) sm.set(k, { hash: s.hash, itemIds: s.itemIds });
    }
    this.touch("substantive");
  }

  removeSource(file: string): void {
    const sources = this.doc.getMap("sources");
    if (sources.get(file) === undefined) return;
    sources.ensureMergeableMap(file).set("removed", true);
    this.touch("substantive");
  }

  // ───────────── turns
  turns(): number {
    return this.doc.getCounter("turns").value;
  }

  incTurns(n = 1): void {
    if (n <= 0) return;
    this.doc.getCounter("turns").increment(n);
    this.touch("counters");
  }

  // ───────────── path registry (§6.8.2)
  private tree(): LoroTree {
    return this.doc.getTree("paths");
  }

  private loadPaths(): { byId: Map<string, PathEntry>; byPath: Map<string, string[]> } {
    if (this.pathCache) return this.pathCache;
    const byId = new Map<string, PathEntry>();
    const byPath = new Map<string, string[]>();
    const walk = (nodes: Array<{ id: string; meta: Record<string, unknown>; children: unknown[] }>, prefix: string) => {
      for (const n of nodes) {
        const name = str(n.meta?.name);
        if (!name) continue;
        const path = prefix ? `${prefix}/${name}` : name;
        const lastSeen = isRecord(n.meta.lastSeen) ? n.meta.lastSeen : {};
        const entry: PathEntry = {
          id: n.id,
          path,
          data: {
            name,
            kind: n.meta.kind === "dir" ? "dir" : "file",
            status: n.meta.status === "absent" || n.meta.status === "deleted" ? n.meta.status : "live",
            blob: typeof n.meta.blob === "string" ? n.meta.blob : undefined,
            fingerprint: typeof n.meta.fingerprint === "string" ? n.meta.fingerprint : undefined,
            lastSeen: { commit: typeof lastSeen.commit === "string" ? lastSeen.commit : undefined, at: str(lastSeen.at) },
            absentSince: typeof n.meta.absentSince === "string" ? n.meta.absentSince : undefined,
          },
        };
        byId.set(n.id, entry);
        const list = byPath.get(path);
        if (list) list.push(n.id);
        else byPath.set(path, [n.id]);
        walk(n.children as Array<{ id: string; meta: Record<string, unknown>; children: unknown[] }>, path);
      }
    };
    walk(this.tree().toJSON() as Array<{ id: string; meta: Record<string, unknown>; children: unknown[] }>, "");
    // concurrent creations can leave duplicate siblings: live entries first, then stable id order
    for (const list of byPath.values()) {
      list.sort((a, b) => {
        const la = byId.get(a)!.data.status === "live" ? 0 : 1;
        const lb = byId.get(b)!.data.status === "live" ? 0 : 1;
        return la - lb || (a < b ? -1 : 1);
      });
    }
    this.pathCache = { byId, byPath };
    return this.pathCache;
  }

  private treeNode(id: string): LoroTreeNode | null {
    try {
      const t = this.tree();
      if (!t.has(id as TreeID) || t.isNodeDeleted(id as TreeID)) return null;
      return t.getNodeByID(id as TreeID) ?? null;
    } catch {
      return null;
    }
  }

  pathEntries(): PathEntry[] {
    return [...this.loadPaths().byId.values()];
  }

  pathEntry(id: string): PathEntry | null {
    return this.loadPaths().byId.get(id) ?? null;
  }

  /** Display path of a tree node, computed by walking up the tree. */
  pathOf(id: string | undefined): string | null {
    return id ? (this.loadPaths().byId.get(id)?.path ?? null) : null;
  }

  findPaths(path: string): string[] {
    return this.loadPaths().byPath.get(normalizeRepoPath(path)) ?? [];
  }

  findPath(path: string): string | null {
    return this.findPaths(path)[0] ?? null;
  }

  /** Mirror a path (and its ancestor directories) in the registry; idempotent locally. */
  ensurePath(path: string, kind: "dir" | "file", seen?: { blob?: string; fingerprint?: string; commit?: string }, now = new Date().toISOString()): string {
    const norm = normalizeRepoPath(path);
    const existing = this.findPath(norm);
    if (existing) return existing;
    const parts = norm.split("/").filter(Boolean);
    let parent: LoroTreeNode | null = null;
    let prefix = "";
    for (let i = 0; i < parts.length; i++) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i]!;
      const have = this.findPath(prefix);
      if (have) {
        parent = this.treeNode(have);
        continue;
      }
      const node: LoroTreeNode = parent ? parent.createNode() : this.tree().createNode();
      const leaf = i === parts.length - 1;
      node.data.set("name", parts[i]!);
      node.data.set("kind", leaf ? kind : "dir");
      node.data.set("status", "live");
      node.data.set("lastSeen", leaf && seen?.commit ? { commit: seen.commit, at: now } : { at: now });
      if (leaf && seen?.blob) node.data.set("blob", seen.blob);
      if (leaf && seen?.fingerprint) node.data.set("fingerprint", seen.fingerprint);
      parent = node;
      this.pathCache = null;
    }
    this.touch("substantive");
    this.pathCache = null;
    return this.findPath(norm)!;
  }

  patchPath(id: string, patch: Partial<PathNodeData>): boolean {
    const node = this.treeNode(id);
    if (!node) return false;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (v === null) node.data.delete(k);
      else node.data.set(k, v as never);
    }
    this.touch("substantive");
    this.pathCache = null;
    return true;
  }

  clearPathField(id: string, field: keyof PathNodeData): void {
    const node = this.treeNode(id);
    if (!node) return;
    node.data.delete(field);
    this.pathCache = null;
  }

  /** A rename or move is one tree move: every anchor on the node or below it follows. */
  movePath(id: string, newPath: string): boolean {
    const node = this.treeNode(id);
    if (!node) return false;
    const norm = normalizeRepoPath(newPath);
    const cur = this.pathOf(id);
    if (cur === norm) return false;
    // a node already at the destination was overwritten by the move
    for (const other of this.findPaths(norm)) if (other !== id) this.patchPath(other, { status: "deleted" });
    const parts = norm.split("/").filter(Boolean);
    const name = parts.pop()!;
    const parentPath = parts.join("/");
    if (parentPath) {
      const parentId = this.ensurePath(parentPath, "dir");
      const parent = this.treeNode(parentId);
      if (!parent || parentId === id) return false;
      node.move(parent);
    } else node.move();
    node.data.set("name", name);
    node.data.set("status", "live");
    node.data.delete("absentSince");
    this.touch("substantive");
    this.pathCache = null;
    return true;
  }
}

/** Empty a map and every map below it. */
function scrub(m: LoroMap): void {
  for (const key of m.keys()) {
    const v = m.get(key);
    if (v instanceof LoroMap) scrub(v);
    m.delete(key);
  }
}

function writeAnchor(m: LoroMap, a: PathAnchor): void {
  m.set("kind", a.kind);
  m.set("role", a.role);
  m.set("status", a.status);
  if (a.pathId !== undefined) m.set("pathId", a.pathId);
  if (a.glob !== undefined) m.set("glob", a.glob);
  if (a.symbol !== undefined) m.set("symbol", a.symbol);
  if (a.seenBlob !== undefined) m.set("seenBlob", a.seenBlob);
  if (a.staleAt !== undefined) m.set("staleAt", a.staleAt);
  else if (a.status === "live") m.delete("staleAt");
}

function writeEvidence(m: LoroMap, e: Evidence): void {
  m.set("quote", e.quote);
  m.set("source", { type: e.source.type, ref: e.source.ref });
  if (e.time) m.set("time", e.time);
  m.set("verified", e.verified);
}

function writeEvent(m: LoroMap, e: StrengthEvent): void {
  m.set("t", e.t);
  m.set("kind", e.kind);
  m.set("value", e.value);
  if (e.n !== undefined) m.set("n", e.n);
  if (e.layer) m.set("layer", e.layer);
}

/** Repo-relative POSIX path without leading "./" or trailing "/". */
export function normalizeRepoPath(path: string): string {
  const parts: string[] = [];
  for (const seg of path.replace(/\\/g, "/").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}
