/**
 * The memory graph across scopes (§6.1, §6.2): Global, Project Personal and Project Shared,
 * each one Loro document with its own derived index.
 */
import { join } from "node:path";
import type { Config, Layout } from "../core/config.ts";
import type { ProjectInfo } from "../core/project.ts";
import type { Telemetry } from "../core/telemetry.ts";
import type { Clock, MemoryEdge, MemoryNode, PathAnchor, Relation, ScopedNode, ScopeName } from "../core/types.ts";
import { MemoryIndex } from "../storage/index.ts";
import type { ScopeDoc } from "../storage/schema.ts";
import { ScopeStore } from "../storage/store.ts";
import { errMsg } from "../util/errors.ts";
import { freshId8, parseId } from "../util/ids.ts";

export interface ScopeHandle {
  name: ScopeName;
  store: ScopeStore;
  index: MemoryIndex | null;
}

export interface GraphOptions {
  layout: Layout;
  cfg: Config;
  project: ProjectInfo;
  /** Whether the harness trusts the project: the shared store loads only then (§7.12). */
  trusted: boolean;
  actorId: string;
  clock?: Clock;
  telemetry?: Telemetry;
  readOnly?: boolean;
  /** Skip the SQLite indexes (hook fast paths that only need the documents). */
  noIndex?: boolean;
}

/** Precedence when facts conflict: more specific and more private wins (§6.1). */
const SCOPE_PRECEDENCE: ScopeName[] = ["personal", "shared", "global"];

/** Where an edge stored in `src` scope may point (§6.1). */
function edgeAllowed(src: ScopeName, dst: ScopeName): boolean {
  if (src === "personal") return true;
  return src === dst;
}

export function scopeLabel(scope: ScopeName): string {
  return scope === "shared" ? "shared" : scope === "personal" ? "personal" : "global";
}

export interface Neighbor {
  edge: MemoryEdge;
  edgeScope: ScopeName;
  other: ScopedNode;
  direction: "out" | "in";
}

export class MemoryGraph {
  readonly opts: GraphOptions;
  readonly cfg: Config;
  readonly project: ProjectInfo;
  readonly clock: Clock;
  readonly handles = new Map<ScopeName, ScopeHandle>();
  /** Why the shared scope is not visible, when it is not. */
  sharedHidden: string | null = null;
  private centralityCache = new Map<ScopeName, { key: string; values: Map<string, number> }>();
  private unsubscribe: Array<() => void> = [];

  constructor(opts: GraphOptions) {
    this.opts = opts;
    this.cfg = opts.cfg;
    this.project = opts.project;
    this.clock = opts.clock ?? (() => new Date());
  }

  static open(opts: GraphOptions): MemoryGraph {
    const g = new MemoryGraph(opts);
    g.openScopes();
    return g;
  }

  private openScope(name: ScopeName, dir: string, storeId: string, extra: Partial<ConstructorParameters<typeof ScopeStore>[0]> = {}): void {
    const { layout, cfg, actorId } = this.opts;
    try {
      const store = new ScopeStore({
        dir,
        scope: name,
        storeId,
        actorId,
        cfg,
        lockFile: layout.lockFile(`store-${storeId}`),
        peersFile: join(layout.peersDir, `${storeId}.json`),
        stateFile: join(layout.cacheDir(storeId), "store-state.json"),
        clock: this.clock,
        readOnly: this.opts.readOnly,
        ...extra,
      }).open();
      let index: MemoryIndex | null = null;
      if (!this.opts.noIndex && !store.unloaded) {
        try {
          index = new MemoryIndex(layout.indexFile(storeId), { fdeDims: cfg.index.lateInteraction.fdeDims, fdeQuant: cfg.index.lateInteraction.fdeQuant });
          index.sync(store.sd, store.versionKey());
        } catch (e) {
          this.opts.telemetry?.event("index.open_failed", { scope: name, error: errMsg(e) });
          index = null;
        }
      }
      const handle: ScopeHandle = { name, store, index };
      this.handles.set(name, handle);
      this.unsubscribe.push(
        store.onChange(() => {
          this.centralityCache.delete(name);
          this.syncIndex(name);
        }),
      );
    } catch (e) {
      this.opts.telemetry?.event("store.open_failed", { scope: name, error: errMsg(e) });
      if (name === "shared") this.sharedHidden = `shared store failed to open: ${errMsg(e)}`;
    }
  }

  private openScopes(): void {
    const { layout, project } = this.opts;
    this.openScope("global", layout.globalDir, "global");
    if (!project.projectKey) return;
    const key = project.projectKey;
    this.openScope("personal", layout.projectDir(key), `p-${key}`, { projectId: key, storeJson: { repoRootHint: project.root } });
    if (!project.sharedDir) return;
    if (!this.opts.trusted) {
      this.sharedHidden = "project is not trusted";
      return;
    }
    this.openScope("shared", project.sharedDir, `s-${key}`, {
      projectId: key,
      git: project.git,
      journalFile: join(layout.projectDir(key), "pending-shared.loro"),
      // the shared directory appears in the repo only once there is something to share
      lazyCreate: true,
    });
    const shared = this.handles.get("shared");
    if (shared?.store.unloaded) {
      this.sharedHidden = shared.store.unloadedReason;
      this.handles.delete("shared");
    }
  }

  // ───────────── scopes
  /** Visible scopes in precedence order: personal, shared, global. */
  visible(): ScopeName[] {
    return SCOPE_PRECEDENCE.filter((s) => this.handles.has(s));
  }

  has(scope: ScopeName): boolean {
    return this.handles.has(scope);
  }

  handle(scope: ScopeName): ScopeHandle {
    const h = this.handles.get(scope);
    if (!h) throw new Error(`scope ${scope} is not available here`);
    return h;
  }

  sd(scope: ScopeName): ScopeDoc {
    return this.handle(scope).store.sd;
  }

  writable(scope: ScopeName): boolean {
    const h = this.handles.get(scope);
    return !!h && !h.store.readOnly && !h.store.unloaded;
  }

  private hidden(scope: ScopeName, node: MemoryNode): boolean {
    return scope === "shared" && this.cfg.shared.ignoreActors.length > 0 && this.cfg.shared.ignoreActors.includes(node.provenance.actor);
  }

  // ───────────── nodes
  /** Look a memory up by ID (with or without `m:` and brackets) across visible scopes. */
  get(rawId: string, opts: { includePurged?: boolean } = {}): ScopedNode | null {
    const parsed = parseId(rawId);
    const id = parsed ? (parsed.type === "m" ? parsed.id : null) : /^[0-9a-z]{8}$/.test(rawId) ? rawId : null;
    if (!id) return null;
    for (const scope of this.visible()) {
      const node = this.sd(scope).getNode(id);
      if (!node) continue;
      if (node.status === "purged" && !opts.includePurged) continue;
      if (this.hidden(scope, node)) continue;
      return { scope, node };
    }
    return null;
  }

  getIn(scope: ScopeName, id: string): MemoryNode | null {
    if (!this.handles.has(scope)) return null;
    return this.sd(scope).getNode(id);
  }

  /** Memories whose ID collided with `id` and were re-keyed (§8.1.2). */
  aliasesOf(id: string): ScopedNode[] {
    const out: ScopedNode[] = [];
    for (const scope of this.visible()) for (const node of this.sd(scope).allNodes()) if (node.aliasOf === id && node.status !== "purged") out.push({ scope, node });
    return out;
  }

  all(scopes: ScopeName[] = this.visible(), filter?: (n: MemoryNode, scope: ScopeName) => boolean): ScopedNode[] {
    const out: ScopedNode[] = [];
    for (const scope of scopes) {
      if (!this.handles.has(scope)) continue;
      for (const node of this.sd(scope).allNodes()) {
        if (node.status === "purged" || this.hidden(scope, node)) continue;
        if (filter && !filter(node, scope)) continue;
        out.push({ scope, node });
      }
    }
    return out;
  }

  active(scopes: ScopeName[] = this.visible()): ScopedNode[] {
    return this.all(scopes, (n) => n.status === "active");
  }

  /** A fresh 8-character ID, checked against every visible scope (§8.1.2). */
  newId(): string {
    return freshId8((id) => this.visible().some((s) => this.sd(s).hasNode(id)));
  }

  // ───────────── edges
  private adjacency: { key: string; map: Map<string, Array<{ edge: MemoryEdge; edgeScope: ScopeName; otherScope: ScopeName; otherId: string; direction: "out" | "in" }>> } | null = null;

  private adjacencyMap(): Map<string, Array<{ edge: MemoryEdge; edgeScope: ScopeName; otherScope: ScopeName; otherId: string; direction: "out" | "in" }>> {
    const scopes = this.visible();
    const key = scopes.map((s) => `${s}:${this.sd(s).edgeEpoch}`).join("|");
    if (this.adjacency?.key === key) return this.adjacency.map;
    const map = new Map<string, Array<{ edge: MemoryEdge; edgeScope: ScopeName; otherScope: ScopeName; otherId: string; direction: "out" | "in" }>>();
    const add = (k: string, v: { edge: MemoryEdge; edgeScope: ScopeName; otherScope: ScopeName; otherId: string; direction: "out" | "in" }) => {
      const list = map.get(k);
      if (list) list.push(v);
      else map.set(k, [v]);
    };
    for (const scope of scopes) {
      for (const edge of this.sd(scope).allEdges()) {
        const dstScope = edge.dstScope ?? scope;
        add(`${scope}:${edge.src}`, { edge, edgeScope: scope, otherScope: dstScope, otherId: edge.dst, direction: "out" });
        add(`${dstScope}:${edge.dst}`, { edge, edgeScope: scope, otherScope: scope, otherId: edge.src, direction: "in" });
      }
    }
    this.adjacency = { key, map };
    return map;
  }

  /** Edges touching a node: those stored in its own scope, plus personal edges pointing into it. */
  neighbors(ref: ScopedNode, opts: { activeOnly?: boolean; rels?: Relation[] } = {}): Neighbor[] {
    const out: Neighbor[] = [];
    for (const a of this.adjacencyMap().get(`${ref.scope}:${ref.node.id}`) ?? []) {
      if (opts.activeOnly && !a.edge.active) continue;
      if (opts.rels && !opts.rels.includes(a.edge.rel)) continue;
      const other = this.getIn(a.otherScope, a.otherId);
      if (!other || other.status === "purged") continue;
      out.push({ edge: a.edge, edgeScope: a.edgeScope, other: { scope: a.otherScope, node: other }, direction: a.direction });
    }
    return out;
  }

  /**
   * Add or update an edge. It lives in the source node's scope and may only point where that
   * scope is visible (§6.1); disallowed edges are refused.
   */
  link(src: ScopedNode, rel: Relation, dst: ScopedNode, opts: { w?: number; evidenceAt?: string } = {}): MemoryEdge | null {
    if (!edgeAllowed(src.scope, dst.scope) || !this.writable(src.scope)) return null;
    if (src.scope === dst.scope && src.node.id === dst.node.id) return null;
    const active = src.node.status === "active" && dst.node.status === "active";
    return this.sd(src.scope).putEdge({
      src: src.node.id,
      dst: dst.node.id,
      rel,
      w: opts.w ?? 0.5,
      evidenceAt: opts.evidenceAt ?? this.clock().toISOString(),
      active,
      dstScope: dst.scope === src.scope ? undefined : dst.scope,
    });
  }

  /** The node that supersedes this one, if any (so default retrieval returns chain heads only, §6.5.5). */
  supersededBy(ref: ScopedNode): ScopedNode | null {
    for (const n of this.neighbors(ref, { rels: ["supersedes"] })) {
      if (n.direction === "in" && n.other.node.status === "active") return n.other;
    }
    return null;
  }

  isChainHead(ref: ScopedNode): boolean {
    return this.supersededBy(ref) === null && !ref.node.validTo;
  }

  /** Whether the node heads a supersession chain (a forgetting guard, §6.5.4). */
  headsChain(ref: ScopedNode): boolean {
    return this.neighbors(ref, { rels: ["supersedes"] }).some((n) => n.direction === "out") && this.supersededBy(ref) === null;
  }

  contradictions(ref: ScopedNode): ScopedNode[] {
    const seen = new Set<string>();
    const out: ScopedNode[] = [];
    for (const n of this.neighbors(ref, { rels: ["contradicts"] })) {
      const key = `${n.other.scope}:${n.other.node.id}`;
      if (seen.has(key) || n.other.node.status !== "active") continue;
      seen.add(key);
      out.push(n.other);
    }
    return out;
  }

  /** Activate or deactivate the edges of a node when its status changes (§6.5.4: edges are kept, inactive). */
  setEdgesActive(ref: ScopedNode, active: boolean): void {
    for (const n of this.neighbors(ref)) {
      if (!this.writable(n.edgeScope)) continue;
      const want = active && n.other.node.status === "active";
      if (n.edge.active !== want) this.sd(n.edgeScope).patchEdge(n.edge.id, { active: want });
    }
  }

  // ───────────── centrality (§6.2.4)
  /** Layer-weighted centrality in [0, 1] for every node of a scope. */
  centrality(scope: ScopeName): Map<string, number> {
    const h = this.handles.get(scope);
    if (!h) return new Map();
    const key = h.store.versionKey();
    const cached = this.centralityCache.get(scope);
    if (cached?.key === key) return cached.values;
    const sd = h.store.sd;
    const kappaSL = this.cfg.memory.kappaShortToLong;
    const sums = new Map<string, number>();
    for (const e of sd.allEdges()) {
      if (!e.active) continue;
      const src = sd.getNode(e.src);
      const dst = e.dstScope && e.dstScope !== scope ? this.getIn(e.dstScope, e.dst) : sd.getNode(e.dst);
      if (!src || !dst) continue;
      const kappa = src.layer === "short" && dst.layer === "long" ? kappaSL : 1.0;
      const x = e.w * kappa;
      sums.set(e.src, (sums.get(e.src) ?? 0) + x);
      if (!e.dstScope || e.dstScope === scope) sums.set(e.dst, (sums.get(e.dst) ?? 0) + x);
    }
    let max = 0;
    for (const v of sums.values()) if (v > max) max = v;
    const values = new Map<string, number>();
    if (max > 0) for (const [id, v] of sums) values.set(id, Math.log(1 + v) / Math.log(1 + max));
    this.centralityCache.set(scope, { key, values });
    return values;
  }

  /** Raw layer-weighted degree (Refine's hub ranking). */
  weightedDegree(scope: ScopeName): Map<string, number> {
    const sd = this.sd(scope);
    const kappaSL = this.cfg.memory.kappaShortToLong;
    const sums = new Map<string, number>();
    for (const e of sd.allEdges()) {
      if (!e.active) continue;
      const src = sd.getNode(e.src);
      const dst = sd.getNode(e.dst);
      if (!src || !dst) continue;
      const x = e.w * (src.layer === "short" && dst.layer === "long" ? kappaSL : 1.0);
      sums.set(e.src, (sums.get(e.src) ?? 0) + x);
      sums.set(e.dst, (sums.get(e.dst) ?? 0) + x);
    }
    return sums;
  }

  // ───────────── anchors
  /** Display path of an anchor, derived from the scope's registry (§6.8.1). */
  anchorPath(scope: ScopeName, a: PathAnchor): string | null {
    if (a.kind === "glob") return a.glob ?? null;
    return this.handles.has(scope) ? this.sd(scope).pathOf(a.pathId) : null;
  }

  // ───────────── persistence
  commit(scope: ScopeName, message?: string): void {
    const h = this.handles.get(scope);
    if (!h) return;
    h.store.commit(message);
    this.centralityCache.delete(scope);
  }

  commitAll(message?: string): void {
    for (const scope of this.handles.keys()) this.commit(scope, message);
  }

  syncIndex(scope: ScopeName): void {
    const h = this.handles.get(scope);
    if (!h?.index) return;
    try {
      h.index.sync(h.store.sd, h.store.versionKey());
    } catch (e) {
      this.opts.telemetry?.event("index.sync_failed", { scope, error: errMsg(e) });
    }
  }

  syncIndexes(): void {
    for (const scope of this.handles.keys()) this.syncIndex(scope);
  }

  /** Pick up files written by other sessions, machines or git (§7.5). */
  refresh(): boolean {
    let changed = false;
    for (const h of this.handles.values()) {
      try {
        if (h.store.refresh()) changed = true;
      } catch (e) {
        this.opts.telemetry?.event("store.refresh_failed", { scope: h.name, error: errMsg(e) });
      }
    }
    return changed;
  }

  /**
   * Flush every scope. `force` also flushes buffered shared counter deltas (`/realctx2 share`);
   * `wait: false` defers a scope whose store lock another process holds (`ScopeStore.flush`).
   */
  flush(opts: { force?: boolean; scopes?: ScopeName[]; keepPurges?: boolean; wait?: boolean } = {}): Array<{ scope: ScopeName; kind: string; file: string | null; bytes: number }> {
    const out: Array<{ scope: ScopeName; kind: string; file: string | null; bytes: number }> = [];
    for (const h of this.handles.values()) {
      if (opts.scopes && !opts.scopes.includes(h.name)) continue;
      try {
        const r = h.store.flush({ force: opts.force, keepPurges: opts.keepPurges, wait: opts.wait });
        out.push({ scope: h.name, ...r });
        if (r.kind === "snapshot") this.syncIndex(h.name);
      } catch (e) {
        this.opts.telemetry?.event("store.flush_failed", { scope: h.name, error: errMsg(e) });
      }
    }
    return out;
  }

  close(opts: { force?: boolean } = {}): void {
    for (const off of this.unsubscribe.splice(0)) off();
    for (const h of this.handles.values()) {
      try {
        h.store.close(opts);
      } catch {
        // closing must not throw
      }
      h.index?.close();
    }
    this.handles.clear();
  }
}
