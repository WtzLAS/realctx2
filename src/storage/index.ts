/**
 * Derived index for one scope (§7.6): FTS5 and vectors for memory nodes and intent purposes.
 * It lives in `cache/<storeId>/index.sqlite`, is never synced, and can always be rebuilt
 * from the Loro document. The in-memory `ScopeDoc` caches are the node, edge and path views.
 */
import type { MemoryNode } from "../core/types.ts";
import { sha256 } from "../util/text.ts";
import type { ScopeDoc } from "./schema.ts";
import { type Db, ftsQuery, indexTokens, openDb } from "./sqlite.ts";
import { type Scored, VectorTables } from "./vectors.ts";

const INDEX_SCHEMA = 4;

/** Text that gets embedded for a memory node: title + text + first quote (§9.2.2). */
export function embedText(n: MemoryNode): string {
  const quote = n.evidence[0]?.quote;
  return [n.title && !n.text.startsWith(n.title) ? n.title : "", n.text, quote ? `"${quote}"` : ""].filter(Boolean).join("\n");
}

export function embedHash(n: MemoryNode): string {
  return sha256(embedText(n)).slice(0, 32);
}

function rowHash(n: MemoryNode, paths: string): string {
  return sha256([n.status, n.layer, n.kind, n.title, n.text, n.signature.join(" "), paths, n.evidence[0]?.quote ?? ""].join("\u0001")).slice(0, 24);
}

export interface PurposeRow {
  id: string;
  text: string;
  at: string;
}

export class MemoryIndex {
  readonly db: Db;
  readonly vectors: VectorTables;
  readonly purposeVectors: VectorTables;
  rebuilt = false;

  constructor(path: string, opts: { fdeDims?: number; fdeQuant?: "int8" | "float32" } = {}) {
    this.db = openDb(path);
    this.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
    const have = Number(this.getMeta("schema") ?? 0);
    if (have !== INDEX_SCHEMA) {
      // derived data only: a schema change rebuilds from the document
      this.db.exec(`
        DROP TABLE IF EXISTS nodes; DROP TABLE IF EXISTS nodes_fts; DROP TABLE IF EXISTS purposes;
        DROP TABLE IF EXISTS node_dense; DROP TABLE IF EXISTS node_tokens; DROP TABLE IF EXISTS node_fde;
        DROP TABLE IF EXISTS purpose_dense; DROP TABLE IF EXISTS purpose_tokens; DROP TABLE IF EXISTS purpose_fde;
        DELETE FROM meta;
      `);
      this.setMeta("schema", String(INDEX_SCHEMA));
      this.rebuilt = have !== 0;
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        rid INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT UNIQUE NOT NULL, rowhash TEXT NOT NULL, status TEXT NOT NULL, layer TEXT NOT NULL,
        kind TEXT NOT NULL, content_hash TEXT NOT NULL, embed_hash TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(title, text, signature, paths, tokenize = "unicode61 tokenchars '_'");
      CREATE TABLE IF NOT EXISTS purposes (id TEXT PRIMARY KEY, text TEXT NOT NULL, at TEXT NOT NULL);
    `);
    this.vectors = new VectorTables(this.db, "node", opts);
    this.purposeVectors = new VectorTables(this.db, "purpose", opts);
    const fdeKey = `${this.vectors.fdeDims}:${this.vectors.fdeQuant}`;
    const savedFde = this.getMeta("fde_config");
    if (savedFde && savedFde !== fdeKey) {
      this.vectors.rebuildFde();
      this.purposeVectors.rebuildFde();
    }
    if (savedFde !== fdeKey) this.setMeta("fde_config", fdeKey);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }

  getMeta(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return r ? String(r.value) : null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
  }

  /**
   * Catch up with the document. Rows are compared by a per-node hash, so only changed nodes
   * are rewritten, and a document that went backwards (branch switch, revert) is handled the
   * same way as one that moved forwards.
   */
  sync(sd: ScopeDoc, versionKey: string): { upserted: number; removed: number } {
    if (this.getMeta("version") === versionKey) return { upserted: 0, removed: 0 };
    let upserted = 0;
    let removed = 0;
    this.db.transaction(() => {
      const have = new Map<string, { rid: number; rowhash: string }>();
      for (const r of this.db.prepare("SELECT rid, id, rowhash FROM nodes").all()) have.set(String(r.id), { rid: Number(r.rid), rowhash: String(r.rowhash) });
      const seen = new Set<string>();
      for (const n of sd.allNodes()) {
        // archived and purged nodes are not indexed at all (§6.5.4)
        if (n.status === "archived" || n.status === "purged") continue;
        seen.add(n.id);
        const paths = n.anchors.map((a) => (a.kind === "glob" ? a.glob : sd.pathOf(a.pathId)) ?? "").filter(Boolean).join(" ");
        const hash = rowHash(n, paths);
        const cur = have.get(n.id);
        if (cur?.rowhash === hash) continue;
        let rid = cur?.rid;
        if (rid === undefined) {
          this.db.prepare("INSERT INTO nodes (id, rowhash, status, layer, kind, content_hash, embed_hash) VALUES (?, ?, ?, ?, ?, ?, ?)").run(n.id, hash, n.status, n.layer, n.kind, n.contentHash, embedHash(n));
          rid = Number(this.db.prepare("SELECT rid FROM nodes WHERE id = ?").get(n.id)!.rid);
        } else {
          this.db.prepare("UPDATE nodes SET rowhash = ?, status = ?, layer = ?, kind = ?, content_hash = ?, embed_hash = ? WHERE rid = ?").run(hash, n.status, n.layer, n.kind, n.contentHash, embedHash(n), rid);
          this.db.prepare("DELETE FROM nodes_fts WHERE rowid = ?").run(rid);
        }
        this.db.prepare("INSERT INTO nodes_fts (rowid, title, text, signature, paths) VALUES (?, ?, ?, ?, ?)").run(rid, indexTokens(n.title), indexTokens(n.text), indexTokens(n.signature.join(" ")), indexTokens(paths));
        // dormant nodes keep FTS only
        if (n.status !== "active") this.vectors.delete(n.id);
        upserted++;
      }
      for (const [id, row] of have) {
        if (seen.has(id)) continue;
        this.db.prepare("DELETE FROM nodes_fts WHERE rowid = ?").run(row.rid);
        this.db.prepare("DELETE FROM nodes WHERE rid = ?").run(row.rid);
        this.vectors.delete(id);
        removed++;
      }
      this.setMeta("version", versionKey);
    });
    return { upserted, removed };
  }

  /** Remove one node at once (purge, §6.5.6), without waiting for the next sync. */
  remove(id: string): void {
    const r = this.db.prepare("SELECT rid FROM nodes WHERE id = ?").get(id);
    if (r) {
      this.db.prepare("DELETE FROM nodes_fts WHERE rowid = ?").run(Number(r.rid));
      this.db.prepare("DELETE FROM nodes WHERE rid = ?").run(Number(r.rid));
    }
    this.vectors.delete(id);
    this.setMeta("version", "");
  }

  /** BM25 over title, text, signature and anchored paths. Higher scores are better. */
  bm25(query: string, opts: { limit: number; statuses?: string[] } = { limit: 20 }): Scored[] {
    const q = ftsQuery(query);
    if (!q) return [];
    const statuses = opts.statuses ?? ["active"];
    const marks = statuses.map(() => "?").join(",");
    try {
      const rows = this.db
        .prepare(`SELECT n.id AS id, bm25(nodes_fts, 2.0, 1.0, 3.0, 2.0) AS rank FROM nodes_fts JOIN nodes n ON n.rid = nodes_fts.rowid WHERE nodes_fts MATCH ? AND n.status IN (${marks}) ORDER BY rank LIMIT ?`)
        .all(q, ...statuses, opts.limit);
      return rows.map((r) => ({ id: String(r.id), score: -Number(r.rank) }));
    } catch {
      return [];
    }
  }

  /** Nodes whose vectors are missing or stale for a model (new content is embedded off the hot loop). */
  pendingEmbeds(kind: "dense" | "tokens", model: string, limit = 256): string[] {
    const items = this.db.prepare("SELECT id, embed_hash FROM nodes WHERE status = 'active'").all().map((r) => ({ id: String(r.id), hash: String(r.embed_hash) }));
    return this.vectors.missing(kind, model, items).slice(0, limit);
  }

  activeCount(): number {
    return Number(this.db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE status = 'active'").get()?.n ?? 0);
  }

  byContentHash(hash: string, statuses: string[]): string[] {
    const marks = statuses.map(() => "?").join(",");
    return this.db.prepare(`SELECT id FROM nodes WHERE content_hash = ? AND status IN (${marks})`).all(hash, ...statuses).map((r) => String(r.id));
  }

  // ───────────── intent purposes (Janus duplicate guard and importance, §6.5.2)
  addPurpose(id: string, text: string, at: string, keep = 20): void {
    this.db.prepare("INSERT OR REPLACE INTO purposes (id, text, at) VALUES (?, ?, ?)").run(id, text, at);
    const old = this.db.prepare("SELECT id FROM purposes ORDER BY at DESC LIMIT -1 OFFSET ?").all(keep);
    for (const r of old) {
      this.db.prepare("DELETE FROM purposes WHERE id = ?").run(String(r.id));
      this.purposeVectors.delete(String(r.id));
    }
  }

  purposes(): PurposeRow[] {
    return this.db.prepare("SELECT id, text, at FROM purposes ORDER BY at DESC").all().map((r) => ({ id: String(r.id), text: String(r.text), at: String(r.at) }));
  }

  sizeBytes(): number {
    try {
      const pages = Number(this.db.prepare("PRAGMA page_count").get()?.page_count ?? 0);
      const size = Number(this.db.prepare("PRAGMA page_size").get()?.page_size ?? 0);
      return pages * size;
    } catch {
      return 0;
    }
  }
}
