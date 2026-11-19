/** SQLite driver shim: node:sqlite, then bun:sqlite, then better-sqlite3 (A5). */
import { createRequire } from "node:module";
import { dirname } from "node:path";
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
    transaction<T>(fn: () => T): T {
      if (depth > 0) return fn();
      raw.exec("BEGIN");
      depth++;
      try {
        const out = fn();
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        try {
          raw.exec("ROLLBACK");
        } catch {
          // ignore
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
    errors.push(`node:sqlite: ${(e as Error).message}`);
  }
  try {
    const mod = require_("bun:sqlite") as { Database: new (p: string) => { exec(sql: string): unknown; prepare(sql: string): unknown; close(): void } };
    return pragmas(wrap(new mod.Database(path), "bun:sqlite"));
  } catch (e) {
    errors.push(`bun:sqlite: ${(e as Error).message}`);
  }
  try {
    const Better = require_("better-sqlite3") as new (p: string) => { exec(sql: string): unknown; prepare(sql: string): unknown; close(): void };
    return pragmas(wrap(new Better(path), "better-sqlite3"));
  } catch (e) {
    errors.push(`better-sqlite3: ${(e as Error).message}`);
  }
  throw new Error(`no SQLite binding available (need Node >= 22.5 for node:sqlite, or install better-sqlite3): ${errors.join("; ")}`);
}

const STOP_WORDS = new Set(
  "the a an of to in on is are was were be been being and or for with that this these those it its as at by from do does did done how what why when where which who whom not no nor if then than so but can could should would will shall may might must i we you they he she me us them our my your their his her has have had having there here into onto about after before over under again also just only very too any all some each per via vs etc".split(" "),
);

/**
 * Quote free text as an FTS5 query: every content token becomes a quoted term, OR-ed.
 * Function words are dropped (they match everything and drown rank fusion) unless nothing else is left.
 */
export function ftsQuery(text: string, maxTerms = 24): string {
  const all: string[] = [];
  for (const m of text.toLowerCase().matchAll(/[\p{L}\p{N}_]+/gu)) if (m[0].length >= 2 && !all.includes(m[0])) all.push(m[0]);
  const content = all.filter((t) => !STOP_WORDS.has(t));
  return (content.length ? content : all).slice(0, maxTerms).map((t) => `"${t}"`).join(" OR ");
}
