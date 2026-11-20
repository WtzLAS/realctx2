/**
 * Path anchors and path tracking (§6.8): the registry mirrors only the paths that anchors use,
 * anchors point at tracked tree nodes so memories survive renames and moves, and
 * reconciliation catches changes made outside the session.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { MemoryNode, PathAnchor, ScopedNode, ScopeName } from "../core/types.ts";
import { normalizeRepoPath, type PathEntry } from "../storage/schema.ts";
import { blobHash, fingerprint, fingerprintSimilarity } from "../util/git.ts";
import { globCompiles, pathMatcher } from "../util/glob.ts";
import type { CommandEffects } from "../util/shell.ts";
import { daysBetween } from "../util/text.ts";
import type { MemoryGraph } from "./graph.ts";

export const ROOT_GLOB = "**";
// Square brackets are treated as literal path characters (e.g. Next.js `app/[id]/page.tsx`), not globs.
const GLOB_CHARS = /[*?{}]/;
const STALE_ANCHOR_DAYS = 30;

export interface Covering {
  scope: ScopeName;
  node: MemoryNode;
  anchor: PathAnchor;
  /** Display path or glob of the anchor. */
  at: string;
  /** Directory depth of the anchor (root = 0); globs rank by specificity among equals. */
  depth: number;
  /** True when the anchored file changed since the anchor was made (§6.8.3). */
  changed: boolean;
}

export interface ReconcileReport {
  checked: number;
  moved: Array<{ scope: ScopeName; from: string; to: string }>;
  absent: string[];
  deleted: string[];
  revived: string[];
  changed: string[];
  dormant: string[];
  flagged: string[];
}

interface AnchorIndex {
  key: string;
  byPath: Map<string, Array<{ node: MemoryNode; anchor: PathAnchor }>>;
  globs: Array<{ node: MemoryNode; anchor: PathAnchor; match: (p: string) => boolean }>;
}

// Directory depth a glob is rooted at: its literal leading segments ("src/db/**" → 2, "**/*.go" → 0).
export function globDepth(glob: string): number {
  let n = 0;
  for (const seg of glob.split("/")) {
    if (!seg || GLOB_CHARS.test(seg)) break;
    n++;
  }
  return n;
}

export function isGlob(spec: string): boolean {
  return GLOB_CHARS.test(spec);
}

/** Best-effort check that a file still declares a symbol such as `TokenCache.refresh`. */
export function declaresSymbol(content: string, symbol: string): boolean {
  const parts = symbol.split(/[.#:]+/).filter(Boolean);
  if (!parts.length) return false;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const last = esc(parts[parts.length - 1]!);
  const decl = new RegExp(`(?:\\b(?:function|def|fn|func|class|interface|type|struct|enum|trait|impl|const|let|var|val|public|private|protected|static|async|export|get|set)\\s+[\\w<>\\[\\],\\s*&]*?\\b${last}\\b)|(?:\\b${last}\\s*(?:[=:(<]|\\{))`);
  if (!decl.test(content)) return false;
  for (const p of parts.slice(0, -1)) if (!new RegExp(`\\b${esc(p)}\\b`).test(content)) return false;
  return true;
}

export class PathTracker {
  readonly graph: MemoryGraph;
  readonly root: string | null;
  private readonly realRoot: string | null;
  private anchorIndexes = new Map<ScopeName, AnchorIndex>();
  /** Memories whose text mentions a path that moved or vanished: queued for re-verification (§6.8.6). */
  readonly reverifyQueue = new Set<string>();

  constructor(graph: MemoryGraph) {
    this.graph = graph;
    this.root = graph.project.root;
    let real: string | null = null;
    if (this.root) {
      try {
        real = realpathSync(this.root);
      } catch {
        real = this.root;
      }
    }
    this.realRoot = real;
  }

  // ───────────── normalization (§6.8.2)
  abs(rel: string): string {
    return join(this.root ?? process.cwd(), rel);
  }

  /**
   * Repo-relative POSIX path, or null when the path lies outside the repo. Symlinks resolve to
   * their target inside the repo; targets outside are not anchored.
   */
  rel(pathLike: string, cwd?: string): string | null {
    if (!this.root || !this.realRoot) return null;
    const cleaned = pathLike.replace(/^@/, "").trim();
    if (!cleaned) return null;
    let abs = isAbsolute(cleaned) ? cleaned : resolve(cwd ?? this.graph.project.cwd, cleaned);
    try {
      abs = realpathSync(abs);
    } catch {
      // a missing path keeps its lexical form, resolved through its nearest existing parent
      let dir = resolve(abs, "..");
      const tail: string[] = [abs.slice(dir.length + 1)];
      for (let i = 0; i < 64 && !existsSync(dir); i++) {
        const up = resolve(dir, "..");
        if (up === dir) break;
        tail.unshift(dir.slice(up.length + 1));
        dir = up;
      }
      try {
        abs = join(realpathSync(dir), ...tail);
      } catch {
        // keep abs
      }
    }
    for (const base of [this.realRoot, this.root]) {
      const r = relative(base, abs);
      if (r === "") return "";
      if (!r.startsWith("..") && !isAbsolute(r)) return r.split(sep).join("/");
    }
    return null;
  }

  exists(rel: string): boolean {
    return existsSync(this.abs(rel));
  }

  isDir(rel: string): boolean {
    try {
      return statSync(this.abs(rel)).isDirectory();
    } catch {
      return false;
    }
  }

  private read(rel: string): Buffer | null {
    try {
      const st = statSync(this.abs(rel));
      if (!st.isFile() || st.size > 4 * 1024 * 1024) return null;
      return readFileSync(this.abs(rel));
    } catch {
      return null;
    }
  }

  blobOf(rel: string): string | null {
    const b = this.read(rel);
    return b ? blobHash(b) : null;
  }

  // ───────────── making anchors (§6.8.1)
  /**
   * Build an anchor from a repo path, glob or `path#Symbol` spec. Project scopes use all four
   * kinds; the Global scope has no repository and uses globs only.
   */
  makeAnchor(scope: ScopeName, spec: string, role: "applies" | "about", opts: { subtree?: boolean; cwd?: string } = {}): PathAnchor | null {
    const raw = spec.trim();
    if (!raw) return null;
    if (isGlob(raw)) {
      const glob = raw.replace(/^\.\//, "");
      return globCompiles(glob) ? { kind: "glob", glob, role, status: "live" } : null;
    }
    if (scope === "global") {
      // a plain path has no meaning without a repository: keep it as a suffix pattern
      const tail = normalizeRepoPath(raw);
      return tail ? { kind: "glob", glob: `**/${tail}`, role, status: "live" } : null;
    }
    if (!this.graph.has(scope) || !this.graph.writable(scope)) return null;
    const hash = raw.indexOf("#");
    const symbol = hash > 0 ? raw.slice(hash + 1).trim() : "";
    const rel = this.rel(hash > 0 ? raw.slice(0, hash) : raw, opts.cwd);
    if (rel === null) return null;
    if (rel === "") return { kind: "glob", glob: ROOT_GLOB, role, status: "live" };
    const dir = opts.subtree ?? (this.isDir(rel) || /\/$/.test(raw));
    const sd = this.graph.sd(scope);
    if (dir) {
      const pathId = sd.ensurePath(rel, "dir", {}, this.graph.clock().toISOString());
      return { kind: "subtree", pathId, role, status: "live" };
    }
    const content = this.read(rel);
    const blob = content ? blobHash(content) : undefined;
    const head = this.graph.project.git?.head() ?? undefined;
    const pathId = sd.ensurePath(rel, "file", { blob, fingerprint: content ? fingerprint(content.toString("utf8")) : undefined, commit: head }, this.graph.clock().toISOString());
    if (symbol) return { kind: "symbol", pathId, symbol, role, seenBlob: blob, status: "live" };
    return { kind: "file", pathId, role, seenBlob: blob, status: "live" };
  }

  /**
   * Anchors for a harvested memory: repo paths in its action signature become `file` anchors
   * with role `about`, plus a symbol anchor when the file declares an identifier it names.
   */
  anchorsFromSignature(scope: ScopeName, signature: string[], role: "applies" | "about" = "about", max = 4): PathAnchor[] {
    if (scope === "global" || !this.root) return [];
    const out: PathAnchor[] = [];
    const seen = new Set<string>();
    const idents = signature.filter((s) => /^[A-Za-z_$][\w$]*(?:[.#:]{1,2}[A-Za-z_$][\w$]*)+$/.test(s) && !s.includes("/"));
    for (const token of signature) {
      if (out.length >= max) break;
      if (!token.includes("/") && !/\.[A-Za-z0-9]{1,6}$/.test(token)) continue;
      if (/^[a-z]+:\/\//i.test(token) || /\s/.test(token)) continue;
      const bare = token.replace(/:\d+(?::\d+)?$/, "");
      const rel = this.rel(bare, this.root);
      if (rel === null || rel === "" || seen.has(rel) || !this.exists(rel)) continue;
      seen.add(rel);
      const isDir = this.isDir(rel);
      const content = isDir ? null : this.read(rel);
      const sym = content ? idents.find((s) => declaresSymbol(content.toString("utf8"), s)) : undefined;
      const a = this.makeAnchor(scope, sym ? `${rel}#${sym}` : rel, role, { cwd: this.root, subtree: isDir });
      if (a) out.push(a);
    }
    return out;
  }

  // ───────────── which memories cover a path
  private anchorIndex(scope: ScopeName): AnchorIndex {
    const h = this.graph.handle(scope);
    const key = h.store.versionKey();
    const cached = this.anchorIndexes.get(scope);
    if (cached?.key === key) return cached;
    const idx: AnchorIndex = { key, byPath: new Map(), globs: [] };
    for (const { node } of this.graph.active([scope])) {
      for (const anchor of node.anchors) {
        if (anchor.status !== "live") continue;
        if (anchor.kind === "glob") {
          if (anchor.glob) idx.globs.push({ node, anchor, match: anchor.glob === ROOT_GLOB ? () => true : pathMatcher(anchor.glob) });
          continue;
        }
        if (!anchor.pathId) continue;
        const list = idx.byPath.get(anchor.pathId);
        if (list) list.push({ node, anchor });
        else idx.byPath.set(anchor.pathId, [{ node, anchor }]);
      }
    }
    this.anchorIndexes.set(scope, idx);
    return idx;
  }

  /**
   * Memories whose anchors cover `rel`, from the root down to the path itself:
   * subtree anchors on its ancestor directories, file and symbol anchors on the file, and globs.
   */
  covering(rel: string, opts: { scopes?: ScopeName[]; roles?: Array<"applies" | "about"> } = {}): Covering[] {
    const path = normalizeRepoPath(rel);
    const out: Covering[] = [];
    const parts = path.split("/").filter(Boolean);
    for (const scope of opts.scopes ?? this.graph.visible()) {
      if (!this.graph.has(scope)) continue;
      const idx = this.anchorIndex(scope);
      const sd = this.graph.sd(scope);
      for (const g of idx.globs) {
        if (opts.roles && !opts.roles.includes(g.anchor.role)) continue;
        if (!g.match(path)) continue;
        out.push({ scope, node: g.node, anchor: g.anchor, at: g.anchor.glob!, depth: globDepth(g.anchor.glob!), changed: false });
      }
      if (scope === "global") continue;
      let prefix = "";
      for (let i = 0; i < parts.length; i++) {
        prefix = prefix ? `${prefix}/${parts[i]}` : parts[i]!;
        const last = i === parts.length - 1;
        for (const pid of sd.findPaths(prefix)) {
          const entry = sd.pathEntry(pid);
          if (!entry || entry.data.status !== "live") continue;
          for (const { node, anchor } of idx.byPath.get(pid) ?? []) {
            if (opts.roles && !opts.roles.includes(anchor.role)) continue;
            if (anchor.kind === "subtree" || last) {
              const changed = anchor.kind !== "subtree" && !!anchor.seenBlob && !!entry.data.blob && anchor.seenBlob !== entry.data.blob;
              out.push({ scope, node, anchor, at: anchor.kind === "subtree" ? `${prefix}/**` : prefix, depth: i + 1, changed });
            }
          }
        }
      }
    }
    return out;
  }

  /** Anchored directories at or above a path (focus tracking and the Project rules section). */
  displayAnchors(ref: ScopedNode): Array<{ anchor: PathAnchor; at: string | null; entry: PathEntry | null }> {
    return ref.node.anchors.map((anchor) => {
      if (anchor.kind === "glob") return { anchor, at: anchor.glob ?? null, entry: null };
      const entry = anchor.pathId && this.graph.has(ref.scope) ? this.graph.sd(ref.scope).pathEntry(anchor.pathId) : null;
      const base = entry?.path ?? null;
      const at = base === null ? null : anchor.kind === "subtree" ? `${base}/**` : anchor.kind === "symbol" ? `${base}#${anchor.symbol}` : base;
      return { anchor, at, entry };
    });
  }

  // ───────────── moves and deletes seen in the session (§6.8.3)
  /**
   * Apply the effects of a shell command after it succeeded. A move or delete counts only when
   * `stat` confirms it: the source is gone and (for moves) the target exists.
   */
  applyEffects(effects: Pick<CommandEffects, "moves" | "deletes">): { moved: number; deleted: number } {
    let moved = 0;
    let deleted = 0;
    for (const m of effects.moves) {
      const from = this.rel(m.from);
      const to = this.rel(m.to);
      if (from === null || to === null || !from || !to) continue;
      if (this.exists(from) || !this.exists(to)) continue;
      if (this.move(from, to)) moved++;
    }
    for (const d of effects.deletes) {
      const rel = this.rel(d);
      if (rel === null || !rel || this.exists(rel)) continue;
      if (this.markAbsent(rel)) deleted++;
    }
    if (moved || deleted) this.commit("paths");
    return { moved, deleted };
  }

  private projectScopes(): ScopeName[] {
    return (["personal", "shared"] as ScopeName[]).filter((s) => this.graph.has(s) && this.graph.writable(s));
  }

  private commit(message: string): void {
    for (const scope of this.projectScopes()) this.graph.commit(scope, message);
    this.anchorIndexes.clear();
  }

  /** One tree move per scope: every anchor on the node or below it follows. */
  move(from: string, to: string): boolean {
    let any = false;
    const now = this.graph.clock().toISOString();
    for (const scope of this.projectScopes()) {
      const sd = this.graph.sd(scope);
      const id = sd.findPath(from);
      if (!id) continue;
      if (!sd.movePath(id, to)) continue;
      sd.patchPath(id, { lastSeen: { commit: this.graph.project.git?.head() ?? undefined, at: now } });
      any = true;
      this.rewriteSignatures(scope, from, to);
    }
    if (any) this.anchorIndexes.clear();
    return any;
  }

  /**
   * After a move, the old path is rewritten as a whole token in `signature`. Text is never
   * search-and-replaced (it would corrupt prose and quotes): nodes whose text still mentions
   * the old path are queued for re-verification instead.
   */
  private rewriteSignatures(scope: ScopeName, from: string, to: string): void {
    const sd = this.graph.sd(scope);
    const esc = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const mention = new RegExp(`(^|[^\\w./-])${esc}(?![\\w-])`);
    for (const node of sd.allNodes()) {
      if (node.status === "purged") continue;
      let touched = false;
      const sig = node.signature.map((tok) => {
        if (tok === from) {
          touched = true;
          return to;
        }
        if (tok.startsWith(`${from}/`)) {
          touched = true;
          return to + tok.slice(from.length);
        }
        return tok;
      });
      if (touched) sd.patchNode(node.id, { signature: sig });
      if (mention.test(node.text)) this.queueReverify(scope, node);
    }
  }

  queueReverify(scope: ScopeName, node: MemoryNode): void {
    this.reverifyQueue.add(`${scope}:${node.id}`);
    if (!node.flags?.includes("reverify") && this.graph.writable(scope)) this.graph.sd(scope).patchNode(node.id, { flags: [...(node.flags ?? []), "reverify"] });
  }

  /** A path that is gone without a known destination: `absent` changes no memory (§6.8.3). */
  markAbsent(rel: string): boolean {
    let any = false;
    const now = this.graph.clock().toISOString();
    for (const scope of this.projectScopes()) {
      const sd = this.graph.sd(scope);
      for (const id of sd.findPaths(rel)) {
        const entry = sd.pathEntry(id);
        if (!entry || entry.data.status !== "live") continue;
        sd.patchPath(id, { status: "absent", absentSince: now });
        any = true;
      }
    }
    if (any) this.anchorIndexes.clear();
    return any;
  }

  /** Refresh blob and fingerprint after the session wrote a tracked file. */
  noteWrite(rel: string): void {
    const now = this.graph.clock().toISOString();
    for (const scope of this.projectScopes()) {
      const sd = this.graph.sd(scope);
      const id = sd.findPath(rel);
      if (!id) continue;
      const entry = sd.pathEntry(id)!;
      if (entry.data.kind !== "file") continue;
      const content = this.read(rel);
      if (!content) continue;
      const blob = blobHash(content);
      if (blob === entry.data.blob && entry.data.status === "live") continue;
      sd.patchPath(id, { blob, fingerprint: fingerprint(content.toString("utf8")), status: "live", lastSeen: { commit: entry.data.lastSeen.commit, at: now } });
      this.anchorIndexes.clear();
    }
  }

  // ───────────── reconciliation with the working tree (§6.8.3)
  /**
   * `full: false` checks only paths whose status is uncertain (seen at another commit, or
   * absent); `full: true` is `/realctx2 paths sync`.
   */
  reconcile(opts: { full?: boolean } = {}): ReconcileReport {
    const report: ReconcileReport = { checked: 0, moved: [], absent: [], deleted: [], revived: [], changed: [], dormant: [], flagged: [] };
    if (!this.root) return report;
    const git = this.graph.project.git?.isRepo() ? this.graph.project.git : null;
    const head = git?.head() ?? undefined;
    const now = this.graph.clock();
    const nowIso = now.toISOString();
    const cfg = this.graph.cfg.paths;
    let status: ReturnType<NonNullable<typeof git>["statusV2"]> | null = null;
    const renameCache = new Map<string, Map<string, string>>();
    const committedRenames = (commit: string | undefined): Map<string, string> => {
      if (!git || !commit || commit === head) return new Map();
      let m = renameCache.get(commit);
      if (!m) {
        m = new Map(renameCache.size < 16 ? git.renamesSince(commit).map((r) => [r.from, r.to]) : []);
        renameCache.set(commit, m);
      }
      return m;
    };
    let dirtySet: Set<string> | null = null;
    const dirty = (): Set<string> => {
      if (dirtySet) return dirtySet;
      status ??= git ? git.statusV2() : null;
      dirtySet = new Set([...(status?.modified ?? []), ...(status?.untracked ?? []), ...(status?.renames.map((r) => r.to) ?? [])]);
      return dirtySet;
    };
    let untracked: Array<{ path: string; blob: string | null; fp: string | null }> | null = null;
    const untrackedFiles = () => {
      if (untracked) return untracked;
      status ??= git ? git.statusV2() : null;
      untracked = (status?.untracked ?? []).slice(0, 400).map((p) => ({ path: p, blob: null, fp: null }));
      return untracked;
    };

    for (const scope of this.projectScopes()) {
      const sd = this.graph.sd(scope);
      // The commit this checkout was last reconciled at is kept in the local index, not in the
      // document: a session that finds nothing changed writes nothing, so pulling a teammate's
      // commits never dirties the shared store (§7.5).
      const index = this.graph.handle(scope).index;
      const headKey = `paths.head:${this.root}`;
      let seenHead: string | undefined;
      try {
        seenHead = index?.getMeta(headKey) ?? undefined;
      } catch {
        seenHead = undefined;
      }
      const entries = sd.pathEntries().sort((a, b) => a.path.length - b.path.length);
      const movedDirs: Array<{ from: string; to: string }> = [];
      const fileMoves = new Map<string, string>(); // id → new path
      const missing: PathEntry[] = [];
      for (const entry of entries) {
        report.checked++;
        if (this.exists(entry.path)) {
          const patch: Record<string, unknown> = {};
          if (entry.data.status !== "live") {
            patch.status = "live";
            report.revived.push(entry.path);
          }
          // Hashing is the expensive part: it runs only where the content may have changed —
          // the path was last seen at another commit, git reports it modified or untracked, or
          // there is no git to ask.
          const uncertain = opts.full || entry.data.status !== "live" || !git || (seenHead ?? entry.data.lastSeen.commit) !== head || dirty().has(entry.path);
          if (entry.data.kind === "file" && uncertain) {
            const content = this.read(entry.path);
            if (content) {
              const blob = blobHash(content);
              if (blob !== entry.data.blob) {
                patch.blob = blob;
                patch.fingerprint = fingerprint(content.toString("utf8"));
                if (entry.data.blob) report.changed.push(entry.path);
              }
            }
          }
          // same content: nothing is written (§6.8.3)
          if (Object.keys(patch).length) {
            sd.patchPath(entry.id, { ...patch, lastSeen: { commit: head, at: nowIso } });
            if (patch.status === "live") {
              sd.clearPathField(entry.id, "absentSince");
              this.reviveFor(scope, entry.id, report);
            }
          }
          continue;
        }
        if (entry.data.status === "deleted") continue;
        missing.push(entry);
      }

      // missing files: committed renames, uncommitted renames, then content matches
      for (const entry of missing) {
        if (entry.data.kind !== "file") continue;
        // the commit the content was last recorded at; else the one this checkout last saw it at
        let to = committedRenames(entry.data.lastSeen.commit).get(entry.path) ?? committedRenames(seenHead).get(entry.path);
        if (!to && git) {
          status ??= git.statusV2();
          to = status.renames.find((r) => r.from === entry.path)?.to;
        }
        if (!to && (entry.data.blob || entry.data.fingerprint)) {
          let best: { path: string; score: number } | null = null;
          const pool = git ? untrackedFiles() : [];
          for (const cand of pool) {
            if (cand.blob === null) {
              const content = this.read(cand.path);
              cand.blob = content ? blobHash(content) : "";
              cand.fp = content ? fingerprint(content.toString("utf8")) : "";
            }
            if (entry.data.blob && cand.blob === entry.data.blob) {
              best = { path: cand.path, score: 1 };
              break;
            }
            const s = entry.data.fingerprint && cand.fp ? fingerprintSimilarity(entry.data.fingerprint, cand.fp) : 0;
            if (s >= cfg.moveSimilarity && (!best || s > best.score)) best = { path: cand.path, score: s };
          }
          to = best?.path;
        }
        if (to && this.exists(to)) fileMoves.set(entry.id, normalizeRepoPath(to));
      }

      // a directory whose tracked children mostly moved under one new parent moves as a whole
      const dirs = missing.filter((e) => e.data.kind === "dir").sort((a, b) => a.path.length - b.path.length);
      for (const dir of dirs) {
        if (movedDirs.some((m) => dir.path.startsWith(`${m.from}/`))) continue;
        const children = entries.filter((e) => e.data.kind === "file" && e.path.startsWith(`${dir.path}/`));
        if (!children.length) continue;
        const votes = new Map<string, number>();
        for (const child of children) {
          const to = fileMoves.get(child.id);
          if (!to) continue;
          const tail = child.path.slice(dir.path.length);
          if (to.endsWith(tail)) {
            const parent = to.slice(0, to.length - tail.length);
            if (parent) votes.set(parent, (votes.get(parent) ?? 0) + 1);
          }
        }
        const top = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
        if (top && top[1] / children.length >= cfg.dirMoveShare && this.isDir(top[0])) movedDirs.push({ from: dir.path, to: top[0] });
      }
      for (const m of movedDirs) {
        const id = sd.findPath(m.from);
        if (id && sd.movePath(id, m.to)) {
          sd.patchPath(id, { lastSeen: { commit: head, at: nowIso } });
          this.rewriteSignatures(scope, m.from, m.to);
          report.moved.push({ scope, ...m });
        }
      }
      for (const [id, to] of fileMoves) {
        const cur = sd.pathOf(id);
        if (cur === null) continue;
        if (cur !== to) {
          if (!sd.movePath(id, to)) continue;
          if (!movedDirs.some((m) => to.startsWith(`${m.to}/`))) report.moved.push({ scope, from: cur, to });
          this.rewriteSignatures(scope, cur, to);
        }
        const content = this.read(to);
        sd.patchPath(id, { status: "live", blob: content ? blobHash(content) : undefined, fingerprint: content ? fingerprint(content.toString("utf8")) : undefined, lastSeen: { commit: head, at: nowIso } });
      }

      // whatever is still missing becomes absent, and deleted after 14 days off the default branch
      for (const entry of missing) {
        const cur = sd.pathEntry(entry.id);
        if (!cur || this.exists(cur.path)) {
          if (cur && cur.data.status !== "live") sd.patchPath(cur.id, { status: "live", lastSeen: { commit: head, at: nowIso } });
          continue;
        }
        if (cur.data.status === "live") {
          sd.patchPath(cur.id, { status: "absent", absentSince: nowIso });
          report.absent.push(cur.path);
          continue;
        }
        if (cur.data.status === "absent") {
          const since = cur.data.absentSince ?? cur.data.lastSeen.at;
          if (!since || daysBetween(since, now) < cfg.absentToDeletedDays) continue;
          if (git) {
            const def = git.defaultBranch(this.graph.cfg.shared.defaultBranch);
            if (def && git.existsAt(def, cur.path)) continue;
          }
          sd.patchPath(cur.id, { status: "deleted" });
          report.deleted.push(cur.path);
          this.applyDeletion(scope, cur.id, report);
        }
      }
      this.checkSymbols(scope);
      if (head && head !== seenHead) {
        try {
          index?.setMeta(headKey, head);
        } catch {
          // the index is a cache: the next session checks again
        }
      }
    }
    this.commit("paths-reconcile");
    return report;
  }

  /** §6.8.4: what happens to memories when a path becomes `deleted` (recursively for a directory). */
  private applyDeletion(scope: ScopeName, pathId: string, report: ReconcileReport): void {
    const sd = this.graph.sd(scope);
    const base = sd.pathOf(pathId);
    if (base === null) return;
    const ids = new Set(sd.pathEntries().filter((e) => e.id === pathId || e.path.startsWith(`${base}/`)).map((e) => e.id));
    const now = this.graph.clock().toISOString();
    for (const node of sd.allNodes()) {
      if (node.status === "purged" || !node.anchors.length) continue;
      let hit = false;
      for (const a of node.anchors) {
        if (a.pathId && ids.has(a.pathId) && a.status === "live") {
          sd.setAnchor(node.id, { ...a, status: "stale", staleAt: now });
          hit = true;
        }
      }
      if (!hit) continue;
      const fresh = sd.getNode(node.id)!;
      if (fresh.anchors.some((a) => a.status === "live")) continue; // some anchors still live: kept
      if (fresh.origin === "instructions" && fresh.kind === "rule") {
        // usually a missed move: flag for review, do not hide (§6.8.4)
        if (!fresh.flags?.includes("stale-rule")) sd.patchNode(node.id, { flags: [...(fresh.flags ?? []), "stale-rule"] });
        report.flagged.push(node.id);
      } else if (fresh.status === "active" && !fresh.pinned) {
        sd.patchNode(node.id, { status: "dormant", statusReason: "path-deleted", statusAt: now });
        this.graph.setEdgesActive({ scope, node: fresh }, false);
        report.dormant.push(node.id);
      } else if (fresh.status === "active") {
        if (!fresh.flags?.includes("stale-rule")) sd.patchNode(node.id, { flags: [...(fresh.flags ?? []), "stale-rule"] });
        report.flagged.push(node.id);
      }
    }
  }

  /** A path that returns brings its anchors and its path-deleted memories back. */
  private reviveFor(scope: ScopeName, pathId: string, report: ReconcileReport): void {
    const sd = this.graph.sd(scope);
    const base = sd.pathOf(pathId);
    if (base === null) return;
    const ids = new Set(sd.pathEntries().filter((e) => e.id === pathId || e.path.startsWith(`${base}/`)).map((e) => e.id));
    const now = this.graph.clock().toISOString();
    for (const node of sd.allNodes()) {
      let hit = false;
      for (const a of node.anchors) {
        if (a.pathId && ids.has(a.pathId) && a.status === "stale") {
          sd.setAnchor(node.id, { ...a, status: "live", staleAt: undefined });
          hit = true;
        }
      }
      if (!hit) continue;
      if (node.status === "dormant" && node.statusReason === "path-deleted") {
        sd.patchNode(node.id, { status: "active", statusReason: null, statusAt: now });
        this.graph.setEdgesActive({ scope, node: sd.getNode(node.id)! }, true);
        report.revived.push(`m:${node.id}`);
      }
      if (node.flags?.includes("stale-rule")) sd.patchNode(node.id, { flags: node.flags.filter((f) => f !== "stale-rule") });
    }
  }

  /** Symbols (best effort): follow a declaration that moved to one other file, else mark the anchor stale. */
  private checkSymbols(scope: ScopeName): void {
    const sd = this.graph.sd(scope);
    const git = this.graph.project.git?.isRepo() ? this.graph.project.git : null;
    const now = this.graph.clock().toISOString();
    for (const node of sd.allNodes()) {
      if (node.status !== "active") continue;
      for (const a of node.anchors) {
        if (a.kind !== "symbol" || !a.symbol || !a.pathId || a.status !== "live") continue;
        const path = sd.pathOf(a.pathId);
        if (!path) continue;
        const content = this.read(path);
        if (!content) continue;
        if (declaresSymbol(content.toString("utf8"), a.symbol)) continue;
        const name = a.symbol.split(/[.#:]+/).filter(Boolean).pop()!;
        let target: string | null = null;
        if (git && /^[\w$]+$/.test(name)) {
          const r = git.git(["grep", "-l", "-w", "-F", "--", name], 8000);
          const files = r.code === 0 ? r.stdout.split("\n").filter(Boolean).slice(0, 40) : [];
          const declaring = files.filter((f) => {
            const c = this.read(f);
            return c ? declaresSymbol(c.toString("utf8"), a.symbol!) : false;
          });
          if (declaring.length === 1) target = declaring[0]!;
        }
        sd.removeAnchor(node.id, a);
        if (target) {
          const moved = this.makeAnchor(scope, `${target}#${a.symbol}`, a.role, { cwd: this.root! });
          if (moved) sd.setAnchor(node.id, moved);
          this.queueReverify(scope, node);
        } else {
          sd.setAnchor(node.id, { ...a, status: "stale", staleAt: now });
          this.queueReverify(scope, node);
        }
      }
    }
  }

  /** Hygiene: stale anchors are dropped after 30 days when the memory still has live ones (§6.8.4). */
  dropStaleAnchors(): number {
    let n = 0;
    const now = this.graph.clock();
    for (const scope of this.projectScopes()) {
      const sd = this.graph.sd(scope);
      for (const node of sd.allNodes()) {
        if (!node.anchors.some((a) => a.status === "live")) continue;
        for (const a of node.anchors) {
          if (a.status === "stale" && a.staleAt && daysBetween(a.staleAt, now) >= STALE_ANCHOR_DAYS && sd.removeAnchor(node.id, a)) n++;
        }
      }
    }
    if (n) this.commit("drop-stale-anchors");
    return n;
  }

  /** Path-like tokens in free text that resolve to something in the working tree or the registry. */
  resolveMentions(tokens: string[]): string[] {
    const out: string[] = [];
    for (const tok of tokens) {
      const rel = this.rel(tok.replace(/:\d+(?::\d+)?$/, ""), this.root ?? undefined);
      if (rel === null || rel === "") continue;
      const known = this.exists(rel) || this.projectScopes().some((s) => this.graph.sd(s).findPath(rel) !== null);
      if (known && !out.includes(rel)) out.push(rel);
    }
    return out;
  }

  invalidate(): void {
    this.anchorIndexes.clear();
  }
}

/** Deepest common directory of a set of repo-relative paths ("" = repo root). */
export function commonDir(paths: string[]): string {
  if (!paths.length) return "";
  const split = paths.map((p) => p.split("/").slice(0, -1));
  const first = split[0]!;
  let n = first.length;
  for (const parts of split.slice(1)) {
    let i = 0;
    while (i < n && i < parts.length && parts[i] === first[i]) i++;
    n = i;
  }
  return first.slice(0, n).join("/");
}
