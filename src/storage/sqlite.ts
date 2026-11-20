/** SQLite driver shim: node:sqlite, then bun:sqlite, then better-sqlite3 (A5). */
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { errMsg } from "../util/errors.ts";
import { ensureDir } from "../util/fs.ts";

export type SqlValue = string | number | bigint | null | Uint8Array;

export interface Stmt {
  run(...params: SqlValue[]): unknown;
  get(...params: SqlValue[]): Record<string, unknown> | undefined;
  all(...params: SqlValue[]): Array<Record<string, unknown>>;
}

export interface Db {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
  close(): void;
  transaction<T>(fn: () => T): T;
  readonly driver: string;
}

const require_ = createRequire(import.meta.url);

function wrap(raw: { exec(sql: string): unknown; prepare(sql: string): unknown; close(): void }, driver: string): Db {
  const cache = new Map<string, Stmt>();
  let depth = 0;
  const db: Db = {
    driver,
    exec: (sql) => void raw.exec(sql),
    prepare(sql) {
      let s = cache.get(sql);
      if (!s) {
        const st = raw.prepare(sql) as { run(...p: unknown[]): unknown; get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] };
        s = {
          run: (...p) => st.run(...p),
          get: (...p) => (st.get(...p) ?? undefined) as Record<string, unknown> | undefined,
          all: (...p) => st.all(...p) as Array<Record<string, unknown>>,
        };
        cache.set(sql, s);
      }
      return s;
    },
    close() {
      cache.clear();
      raw.close();
    },
    /**
     * Run `fn` atomically. A nested call is a savepoint: when it throws, only its own writes roll
     * back, so an outer transaction that catches the error commits its own work, not half of the
     * inner one's.
     */
    transaction<T>(fn: () => T): T {
      const savepoint = depth > 0 ? `realctx2_sp${depth}` : null;
      raw.exec(savepoint ? `SAVEPOINT ${savepoint}` : "BEGIN");
      depth++;
      try {
        const out = fn();
        raw.exec(savepoint ? `RELEASE ${savepoint}` : "COMMIT");
        return out;
      } catch (e) {
        try {
          if (savepoint) {
            raw.exec(`ROLLBACK TO ${savepoint}`);
            raw.exec(`RELEASE ${savepoint}`);
          } else raw.exec("ROLLBACK");
        } catch {
          // the error that got us here is the one to report
        }
        throw e;
      } finally {
        depth--;
      }
    },
  };
  return db;
}

export function openDb(path: string): Db {
  if (path !== ":memory:") ensureDir(dirname(path));
  const errors: string[] = [];
  const pragmas = (db: Db): Db => {
    try {
      db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 3000;");
    } catch {
      // in-memory or read-only database
    }
    return db;
  };
  try {
    const prev = process.emitWarning;
    let mod: { DatabaseSync: new (p: string) => { exec(sql: string): unknown; prepare(sql: string): unknown; close(): void } };
    try {
      // node:sqlite prints an ExperimentalWarning on older Node versions; keep it out of the TUI
      process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
        if (String(w).includes("SQLite")) return;
        (prev as (...a: unknown[]) => void).call(process, w, ...rest);
      }) as typeof process.emitWarning;
      mod = require_("node:sqlite");
    } finally {
      process.emitWarning = prev;
    }
    return pragmas(wrap(new mod.DatabaseSync(path), "node:sqlite"));
  } catch (e) {
    errors.push(`node:sqlite: ${errMsg(e)}`);
  }
  try {
    const mod = require_("bun:sqlite") as { Database: new (p: string) => { exec(sql: string): unknown; prepare(sql: string): unknown; close(): void } };
    return pragmas(wrap(new mod.Database(path), "bun:sqlite"));
  } catch (e) {
    errors.push(`bun:sqlite: ${errMsg(e)}`);
  }
  try {
    const Better = require_("better-sqlite3") as new (p: string) => { exec(sql: string): unknown; prepare(sql: string): unknown; close(): void };
    return pragmas(wrap(new Better(path), "better-sqlite3"));
  } catch (e) {
    errors.push(`better-sqlite3: ${errMsg(e)}`);
  }
  throw new Error(`no SQLite binding available (need Node >= 22.5 for node:sqlite, or install better-sqlite3): ${errors.join("; ")}`);
}

const STOP_WORDS = new Set(
  "the a an of to in on is are was were be been being and or for with that this these those it its as at by from do does did done how what why when where which who whom not no nor if then than so but can could should would will shall may might must i we you they he she me us them our my your their his her has have had having there here into onto about after before over under again also just only very too any all some each per via vs etc".split(" "),
);

const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3005\u30fc]+/gu;
const HAS_CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

let wordSegmenter: Intl.Segmenter | null | undefined;
function getSegmenter(): Intl.Segmenter | null {
  if (wordSegmenter !== undefined) return wordSegmenter;
  try {
    wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });
  } catch {
    wordSegmenter = null;
  }
  return wordSegmenter;
}

function segmentWords(text: string): string[] {
  const seg = getSegmenter();
  if (!seg) return text.split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
  const out: string[] = [];
  for (const s of seg.segment(text)) {
    if (!s.isWordLike) continue;
    // Intl.Segmenter keeps dotted words like `TokenCache.refresh` together; split on
    // non-word punctuation so each component is indexed and queried as its own FTS5 token.
    for (const part of s.segment.split(/[^\p{L}\p{N}_]+/u)) if (part) out.push(part);
  }
  return out;
}

/** Split identifiers like `usedCount`, `HTTPServer2`, and `cache_ttl` into searchable sub-words. */
function identifierSubWords(word: string): string[] {
  if (HAS_CJK.test(word)) return [];
  const parts = word
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((p) => p.length > 1);
  return parts.length > 1 ? parts.map((p) => p.toLowerCase()) : [];
}

function cjkGrams(text: string, withUnigrams: boolean): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(CJK_RUN)) {
    const chars = [...m[0]];
    if (chars.length === 1 || withUnigrams) out.push(...chars);
    for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i]! + chars[i + 1]!);
  }
  return out;
}

/**
 * Pre-tokenize a document field for FTS5 (`unicode61`):
 * - ICU word segmentation via `Intl.Segmenter` across scripts;
 * - camelCase / PascalCase / snake_case sub-words alongside the original identifier;
 * - overlapping CJK character bigrams and unigrams so CJK search never fails on segmentation mismatches.
 */
export function indexTokens(text: string): string {
  if (!text) return "";
  const raw = text.normalize("NFKC");
  const tokens: string[] = [];
  for (const w of segmentWords(raw)) {
    tokens.push(w.toLowerCase());
    for (const sub of identifierSubWords(w)) tokens.push(sub);
  }
  for (const g of cjkGrams(raw.toLowerCase(), true)) tokens.push(g);
  return tokens.join(" ");
}

/**
 * Quote free text as an FTS5 query: every content token becomes a quoted term, OR-ed.
 * Handles CJK bigrams and camelCase/snake_case sub-words to match `indexTokens`.
 * Function words are dropped (they match everything and drown rank fusion) unless nothing else is left.
 */
export function ftsQuery(text: string, maxTerms = 32): string {
  const raw = text.normalize("NFKC");
  const all: string[] = [];
  const seen = new Set<string>();
  const add = (t: string) => {
    if (!t || seen.has(t)) return;
    seen.add(t);
    all.push(t);
  };
  for (const w of segmentWords(raw)) {
    const lw = w.toLowerCase();
    if (HAS_CJK.test(lw)) {
      if ([...lw].length <= 4) add(lw);
      continue;
    }
    if (lw.length < 2 && !/\d/.test(lw)) continue;
    add(lw);
    for (const sub of identifierSubWords(w)) add(sub);
  }
  for (const g of cjkGrams(raw.toLowerCase(), false)) add(g);
  const content = all.filter((t) => !STOP_WORDS.has(t));
  return (content.length ? content : all)
    .slice(0, maxTerms)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" OR ");
}
