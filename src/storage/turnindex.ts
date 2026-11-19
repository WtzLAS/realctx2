/**
 * Turn index (§5.6, Appendix B.4): one SQLite file per project with BM25 and vectors for
 * consolidated turns (`t:`) and raw turns (`r:`). Local to this machine.
 */
import { stableId8 } from "../util/ids.ts";
import { estimateTokens, sha256 } from "../util/text.ts";
import { type Db, ftsQuery, openDb } from "./sqlite.ts";
import { type Scored, VectorTables } from "./vectors.ts";

const TURN_SCHEMA = 2;
export const CHUNK_TOKENS = 512;

export interface TurnRow {
  id: string; // "t:…" or "r:…"
  session: string;
  harness: string;
  entry: string | null;
  chunk: number;
  kind: "raw" | "precip" | "palim" | "compaction";
  at: string;
  text: string;
  contentHash: string;
  role: string | null;
  tool: string | null;
  seq: number;
  tokens: number;
}

export interface RawTurnInput {
  session: string;
  harness: string;
  entryId: string;
  at: string;
  text: string;
  role?: string;
  tool?: string;
  /** Position of the entry in its session, for ±2 neighbor expansion. */
  seq: number;
}

/** `r:` IDs are derived from (session, entry, chunk), so re-indexing a session is idempotent. */
export function rawTurnId(session: string, entryId: string, chunk = 0): string {
  return `r:${stableId8(`${session}\u0000${entryId}\u0000${chunk}`, sha256)}`;
}

/** Split text into chunks of at most `maxTokens`, preferring line boundaries. */
export function chunkText(text: string, maxTokens = CHUNK_TOKENS): string[] {
  if (estimateTokens(text) <= maxTokens) return [text];
  const maxChars = maxTokens * 4;
  const chunks: string[] = [];
  let cur = "";
  const push = () => {
    if (cur.trim()) chunks.push(cur);
    cur = "";
  };
  for (const line of text.split("\n")) {
    let rest = line;
    while (rest.length > maxChars) {
      push();
      chunks.push(rest.slice(0, maxChars));
      rest = rest.slice(maxChars);
    }
    if (cur.length + rest.length + 1 > maxChars) push();
    cur = cur ? `${cur}\n${rest}` : rest;
  }
  push();
  return chunks.length ? chunks : [text.slice(0, maxChars)];
}

function toRow(r: Record<string, unknown>): TurnRow {
  return {
    id: String(r.id),
    session: String(r.session),
    harness: String(r.harness),
    entry: r.entry == null ? null : String(r.entry),
    chunk: Number(r.chunk),
    kind: String(r.kind) as TurnRow["kind"],
    at: String(r.at),
    text: String(r.text),
    contentHash: String(r.content_hash),
    role: r.role == null ? null : String(r.role),
    tool: r.tool == null ? null : String(r.tool),
    seq: Number(r.seq ?? 0),
    tokens: Number(r.tokens ?? 0),
  };
}

export class TurnIndex {
  readonly db: Db;
  readonly vectors: VectorTables;

  constructor(path: string, opts: { fdeDims?: number; fdeQuant?: "int8" | "float32" } = {}) {
    this.db = openDb(path);
    this.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
    const have = Number(this.db.prepare("SELECT value FROM meta WHERE key = 'schema'").get()?.value ?? 0);
    if (have !== TURN_SCHEMA) {
      this.db.exec("DROP TABLE IF EXISTS turns; DROP TABLE IF EXISTS turns_fts; DROP TABLE IF EXISTS turn_dense; DROP TABLE IF EXISTS turn_tokens; DROP TABLE IF EXISTS turn_fde;");
      this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)").run(String(TURN_SCHEMA));
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS turns (
        rid          INTEGER PRIMARY KEY AUTOINCREMENT,
        id           TEXT UNIQUE NOT NULL,
        session      TEXT NOT NULL,
        harness      TEXT NOT NULL,
        entry        TEXT,
        chunk        INTEGER NOT NULL DEFAULT 0,
        kind         TEXT NOT NULL,
        at           TEXT NOT NULL,
        text         TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        role         TEXT,
        tool         TEXT,
        seq          INTEGER NOT NULL DEFAULT 0,
        tokens       INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS turns_session ON turns (session, seq, chunk);
      CREATE INDEX IF NOT EXISTS turns_entry ON turns (session, entry);
      CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(text, tokenize = "unicode61 tokenchars '_'");
    `);
    this.vectors = new VectorTables(this.db, "turn", opts);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }

  private put(row: Omit<TurnRow, "contentHash" | "tokens">): boolean {
    const hash = sha256(row.text).slice(0, 32);
    const cur = this.db.prepare("SELECT rid, content_hash FROM turns WHERE id = ?").get(row.id);
    if (cur && String(cur.content_hash) === hash) return false;
    const tokens = estimateTokens(row.text);
    if (cur) {
      const rid = Number(cur.rid);
      this.db.prepare("UPDATE turns SET session = ?, harness = ?, entry = ?, chunk = ?, kind = ?, at = ?, text = ?, content_hash = ?, role = ?, tool = ?, seq = ?, tokens = ? WHERE rid = ?").run(row.session, row.harness, row.entry, row.chunk, row.kind, row.at, row.text, hash, row.role, row.tool, row.seq, tokens, rid);
      this.db.prepare("DELETE FROM turns_fts WHERE rowid = ?").run(rid);
      this.db.prepare("INSERT INTO turns_fts (rowid, text) VALUES (?, ?)").run(rid, row.text);
      this.vectors.delete(row.id);
    } else {
      this.db.prepare("INSERT INTO turns (id, session, harness, entry, chunk, kind, at, text, content_hash, role, tool, seq, tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(row.id, row.session, row.harness, row.entry, row.chunk, row.kind, row.at, row.text, hash, row.role, row.tool, row.seq, tokens);
      const rid = Number(this.db.prepare("SELECT rid FROM turns WHERE id = ?").get(row.id)!.rid);
      this.db.prepare("INSERT INTO turns_fts (rowid, text) VALUES (?, ?)").run(rid, row.text);
    }
    return true;
  }

  /** Index one raw entry in chunks of up to 512 tokens. Returns the chunk IDs. */
  addRaw(input: RawTurnInput): string[] {
    const text = input.text.trim();
    if (!text) return [];
    const chunks = chunkText(text);
    const ids: string[] = [];
    this.db.transaction(() => {
      chunks.forEach((chunk, i) => {
        const id = rawTurnId(input.session, input.entryId, i);
        ids.push(id);
        this.put({ id, session: input.session, harness: input.harness, entry: input.entryId, chunk: i, kind: "raw", at: input.at, text: chunk, role: input.role ?? null, tool: input.tool ?? null, seq: input.seq });
      });
      // an entry that shrank leaves no stale chunks behind
      const stale = this.db.prepare("SELECT id, rid FROM turns WHERE session = ? AND entry = ? AND kind = 'raw' AND chunk >= ?").all(input.session, input.entryId, chunks.length);
      for (const r of stale) this.removeRid(Number(r.rid), String(r.id));
    });
    return ids;
  }

  addConsolidation(input: { id: string; session: string; harness: string; kind: "precip" | "palim" | "compaction"; at: string; text: string; seq?: number }): void {
    if (!input.text.trim()) return;
    this.put({ id: input.id, session: input.session, harness: input.harness, entry: input.id, chunk: 0, kind: input.kind, at: input.at, text: input.text, role: null, tool: null, seq: input.seq ?? 0 });
  }

  private removeRid(rid: number, id: string): void {
    this.db.prepare("DELETE FROM turns_fts WHERE rowid = ?").run(rid);
    this.db.prepare("DELETE FROM turns WHERE rid = ?").run(rid);
    this.vectors.delete(id);
  }

  remove(id: string): void {
    const r = this.db.prepare("SELECT rid FROM turns WHERE id = ?").get(id);
    if (r) this.removeRid(Number(r.rid), id);
  }

  /** Drop every row of a session whose transcript is gone (the worker's clean-up, §6.6.8). */
  removeSession(session: string): number {
    const rows = this.db.prepare("SELECT rid, id FROM turns WHERE session = ?").all(session);
    this.db.transaction(() => {
      for (const r of rows) this.removeRid(Number(r.rid), String(r.id));
    });
    return rows.length;
  }

  /** Purge support (§6.5.6): drop raw-turn chunks that contain any of these quotes. */
  removeContaining(quotes: string[]): number {
    let n = 0;
    for (const quote of quotes) {
      const q = quote.trim();
      if (q.length < 12) continue;
      const rows = this.db.prepare("SELECT rid, id FROM turns WHERE instr(text, ?) > 0").all(q);
      for (const r of rows) {
        this.removeRid(Number(r.rid), String(r.id));
        n++;
      }
    }
    return n;
  }

  get(id: string): TurnRow | null {
    const r = this.db.prepare("SELECT * FROM turns WHERE id = ?").get(id);
    return r ? toRow(r) : null;
  }

  has(id: string): boolean {
    return this.db.prepare("SELECT 1 AS x FROM turns WHERE id = ?").get(id) !== undefined;
  }

  byEntry(session: string, entryId: string): TurnRow[] {
    return this.db.prepare("SELECT * FROM turns WHERE session = ? AND entry = ? ORDER BY chunk").all(session, entryId).map(toRow);
  }

  /** Entries around a raw turn (±n by session order), first chunk of each. */
  neighbors(row: TurnRow, n = 2): TurnRow[] {
    return this.db
      .prepare("SELECT * FROM turns WHERE session = ? AND kind = 'raw' AND seq BETWEEN ? AND ? ORDER BY seq, chunk")
      .all(row.session, row.seq - n, row.seq + n)
      .map(toRow);
  }

  sessionCount(session: string): number {
    return Number(this.db.prepare("SELECT COUNT(*) AS n FROM turns WHERE session = ?").get(session)?.n ?? 0);
  }

  maxSeq(session: string): number {
    return Number(this.db.prepare("SELECT COALESCE(MAX(seq), -1) AS n FROM turns WHERE session = ? AND kind = 'raw'").get(session)?.n ?? -1);
  }

  indexedEntries(session: string): Set<string> {
    return new Set(this.db.prepare("SELECT DISTINCT entry FROM turns WHERE session = ? AND kind = 'raw'").all(session).map((r) => String(r.entry)));
  }

  /** BM25 over turn text; `sessions` restricts the search (where: "session"). */
  bm25(query: string, opts: { limit: number; sessions?: string[]; kinds?: string[] }): Scored[] {
    const q = ftsQuery(query);
    if (!q) return [];
    const where: string[] = ["turns_fts MATCH ?"];
    const params: Array<string | number> = [q];
    if (opts.sessions?.length) {
      where.push(`t.session IN (${opts.sessions.map(() => "?").join(",")})`);
      params.push(...opts.sessions);
    }
    if (opts.kinds?.length) {
      where.push(`t.kind IN (${opts.kinds.map(() => "?").join(",")})`);
      params.push(...opts.kinds);
    }
    try {
      return this.db
        .prepare(`SELECT t.id AS id, bm25(turns_fts) AS rank FROM turns_fts JOIN turns t ON t.rid = turns_fts.rowid WHERE ${where.join(" AND ")} ORDER BY rank LIMIT ?`)
        .all(...params, opts.limit)
        .map((r) => ({ id: String(r.id), score: -Number(r.rank) }));
    } catch {
      return [];
    }
  }

  /** IDs in a set of sessions (vector-search filter). */
  idsIn(sessions: string[]): Set<string> {
    if (!sessions.length) return new Set();
    return new Set(this.db.prepare(`SELECT id FROM turns WHERE session IN (${sessions.map(() => "?").join(",")})`).all(...sessions).map((r) => String(r.id)));
  }

  pendingEmbeds(kind: "dense" | "tokens", model: string, limit = 128): TurnRow[] {
    const items = this.db.prepare("SELECT id, content_hash FROM turns ORDER BY at DESC LIMIT 20000").all().map((r) => ({ id: String(r.id), hash: String(r.content_hash) }));
    const ids = this.vectors.missing(kind, model, items).slice(0, limit);
    return ids.map((id) => this.get(id)).filter((r): r is TurnRow => r !== null);
  }

  /** Raw turns older than `recentDays` drop from int8 to 1-bit token vectors (§9.2.2). */
  ageTokens(model: string, recentDays: number, now: Date, olderQuant: "binary" | "int8"): number {
    if (olderQuant === "int8") return 0;
    const cutoff = new Date(now.getTime() - recentDays * 86_400_000).toISOString();
    const rows = this.db.prepare("SELECT t.id AS id FROM turns t JOIN turn_tokens v ON v.id = t.id WHERE t.kind = 'raw' AND t.at < ? AND v.model = ? AND v.quant != 'binary' LIMIT 2000").all(cutoff, model);
    let n = 0;
    for (const r of rows) if (this.vectors.requantize(String(r.id), model, "binary")) n++;
    return n;
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

  /**
   * Eviction (§9.2.2): over `maxBytes`, the oldest raw turns lose their token matrices first,
   * then their encodings and dense vectors. Consolidated turns are never evicted.
   */
  evict(maxBytes: number): { tokens: number; vectors: number } {
    const out = { tokens: 0, vectors: 0 };
    let over = this.sizeBytes() - maxBytes;
    if (over <= 0) return out;
    const tokenRows = this.db.prepare("SELECT t.id AS id, LENGTH(v.data) AS n FROM turns t JOIN turn_tokens v ON v.id = t.id WHERE t.kind = 'raw' ORDER BY t.at ASC").all();
    for (const r of tokenRows) {
      if (over <= 0) break;
      this.vectors.deleteTokens(String(r.id));
      over -= Number(r.n);
      out.tokens++;
    }
    if (over > 0) {
      const rows = this.db.prepare("SELECT t.id AS id, COALESCE(LENGTH(f.vec), 0) + COALESCE(LENGTH(d.vec), 0) AS n FROM turns t LEFT JOIN turn_fde f ON f.id = t.id LEFT JOIN turn_dense d ON d.id = t.id WHERE t.kind = 'raw' AND (f.id IS NOT NULL OR d.id IS NOT NULL) ORDER BY t.at ASC").all();
      for (const r of rows) {
        if (over <= 0) break;
        this.vectors.deleteFdeAndDense(String(r.id));
        over -= Number(r.n);
        out.vectors++;
      }
    }
    if (out.tokens || out.vectors) {
      try {
        this.db.exec("PRAGMA incremental_vacuum");
      } catch {
        // space is reused by later writes either way
      }
    }
    return out;
  }

  stats(): { turns: number; raw: number; consolidated: number; bytes: number; vectors: { dense: number; tokens: number; fde: number } } {
    const raw = Number(this.db.prepare("SELECT COUNT(*) AS n FROM turns WHERE kind = 'raw'").get()?.n ?? 0);
    const all = Number(this.db.prepare("SELECT COUNT(*) AS n FROM turns").get()?.n ?? 0);
    return { turns: all, raw, consolidated: all - raw, bytes: this.sizeBytes(), vectors: this.vectors.bytes() };
  }
}
