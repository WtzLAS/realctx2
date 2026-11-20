import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MemoryIndex } from "../src/storage/index.ts";
import { ScopeDoc } from "../src/storage/schema.ts";
import { ftsQuery, openDb } from "../src/storage/sqlite.ts";
import { chunkText, rawTurnId, TurnIndex } from "../src/storage/turnindex.ts";
import { rrf, VectorTables } from "../src/storage/vectors.ts";
import { estimateTokens } from "../src/util/text.ts";
import { cleanupTmp, node, tmp } from "./helpers/fixtures.ts";

afterAll(cleanupTmp);

function unit(v: number[]): Float32Array {
  const n = Math.hypot(...v);
  return Float32Array.from(v.map((x) => x / n));
}

/** A toy "late interaction model": one unit vector per distinct word, by hashing. */
function tokens(text: string, dims = 32): Float32Array[] {
  return text.toLowerCase().split(/\W+/).filter(Boolean).map((w) => {
    let h = 2166136261;
    const v = new Float32Array(dims);
    for (let i = 0; i < dims; i++) {
      for (let j = 0; j < w.length; j++) h = Math.imul(h ^ w.charCodeAt(j), 16777619);
      h = Math.imul(h ^ i, 16777619);
      v[i] = ((h >>> 0) / 4294967296) * 2 - 1;
    }
    return unit(Array.from(v));
  });
}

describe("sqlite shim", () => {
  it("opens a database with FTS5 and nests transactions", () => {
    const db = openDb(join(tmp(), "a", "b.sqlite"));
    expect(db.driver).toMatch(/sqlite/);
    db.exec("CREATE VIRTUAL TABLE f USING fts5(text); CREATE TABLE t (x INTEGER)");
    db.transaction(() => {
      db.prepare("INSERT INTO t (x) VALUES (?)").run(1);
      db.transaction(() => db.prepare("INSERT INTO t (x) VALUES (?)").run(2));
    });
    expect(() => db.transaction(() => {
      db.prepare("INSERT INTO t (x) VALUES (?)").run(3);
      throw new Error("boom");
    })).toThrow("boom");
    expect(db.prepare("SELECT COUNT(*) AS n FROM t").get()!.n).toBe(2);
    expect(ftsQuery('TokenCache.refresh "races" on `pending` — a')).toBe('"tokencache" OR "refresh" OR "races" OR "pending"');
    expect(ftsQuery("how does it do that")).toBe('"how" OR "does" OR "it" OR "do" OR "that"'); // nothing but function words: keep them
    expect(ftsQuery("   ")).toBe("");
    db.close();
  });
});

describe("memory index", () => {
  it("follows the document forwards and backwards, and indexes by status", () => {
    const sd = ScopeDoc.create({ scope: "personal" });
    const pid = sd.ensurePath("src/auth/tokenCache.ts", "file");
    sd.insertNode(node({ id: "aaaaaaaa", title: "single-flight refresh", text: "TokenCache.refresh must be single-flight; concurrent refreshes race on pending.", signature: ["TokenCache.refresh"], anchors: [{ kind: "file", pathId: pid, role: "about", status: "live" }] }));
    sd.insertNode(node({ id: "bbbbbbbb", text: "Run pnpm db:generate after editing the prisma schema.", signature: ["pnpm db:generate"] }));
    sd.insertNode(node({ id: "cccccccc", text: "Old note about prisma that was archived.", status: "archived" }));
    sd.insertNode(node({ id: "dddddddd", text: "A dormant note about refresh tokens.", status: "dormant" }));
    sd.commit();
    const idx = new MemoryIndex(join(tmp(), "index.sqlite"));
    expect(idx.sync(sd, "v1")).toEqual({ upserted: 3, removed: 0 });
    expect(idx.sync(sd, "v1")).toEqual({ upserted: 0, removed: 0 });
    expect(idx.bm25("refresh pending race", { limit: 5 }).map((s) => s.id)).toEqual(["aaaaaaaa"]);
    expect(idx.bm25("tokenCache.ts", { limit: 5 }).map((s) => s.id)).toEqual(["aaaaaaaa"]); // anchored path is searchable
    expect(idx.bm25("prisma", { limit: 5 }).map((s) => s.id)).toEqual(["bbbbbbbb"]); // archived nodes are not indexed
    expect(idx.bm25("refresh", { limit: 5, statuses: ["active", "dormant"] }).map((s) => s.id).sort()).toEqual(["aaaaaaaa", "dddddddd"]);
    expect(idx.bm25('"; DROP TABLE nodes; --', { limit: 5 })).toEqual([]);
    // vectors: pending until embedded; re-embedded when the text changes; dropped when dormant
    expect(idx.pendingEmbeds("dense", "m1").sort()).toEqual(["aaaaaaaa", "bbbbbbbb"]);
    idx.vectors.putDense("aaaaaaaa", "m1", idx.db.prepare("SELECT embed_hash FROM nodes WHERE id = 'aaaaaaaa'").get()!.embed_hash as string, unit([1, 0, 0]));
    expect(idx.pendingEmbeds("dense", "m1")).toEqual(["bbbbbbbb"]);
    sd.patchNode("aaaaaaaa", { text: "TokenCache.refresh is now guarded by a mutex." });
    sd.patchNode("bbbbbbbb", { status: "archived" });
    sd.commit();
    expect(idx.sync(sd, "v2")).toEqual({ upserted: 1, removed: 1 });
    expect(idx.pendingEmbeds("dense", "m1")).toEqual(["aaaaaaaa"]);
    expect(idx.bm25("mutex", { limit: 5 }).map((s) => s.id)).toEqual(["aaaaaaaa"]);
    expect(idx.bm25("pending", { limit: 5 })).toEqual([]);
    // "branch switch": the document goes back to a state without the edit
    const older = ScopeDoc.create({ scope: "personal" });
    older.insertNode(node({ id: "bbbbbbbb", text: "Run pnpm db:generate after editing the prisma schema." }));
    older.commit();
    expect(idx.sync(older, "v0")).toEqual({ upserted: 1, removed: 2 });
    expect(idx.bm25("prisma", { limit: 5 }).map((s) => s.id)).toEqual(["bbbbbbbb"]);
    expect(idx.activeCount()).toBe(1);
    idx.remove("bbbbbbbb");
    expect(idx.activeCount()).toBe(0);
    idx.close();
  });

  it("keeps the last 20 intent purposes", () => {
    const idx = new MemoryIndex(join(tmp(), "index.sqlite"));
    for (let i = 0; i < 25; i++) idx.addPurpose(`p${i}`, `purpose ${i}`, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString());
    const ps = idx.purposes();
    expect(ps.length).toBe(20);
    expect(ps[0]!.id).toBe("p24");
    expect(ps.at(-1)!.id).toBe("p5");
    idx.close();
  });
});

describe("vector tables", () => {
  it("searches dense vectors by cosine with a floor and a filter", () => {
    const db = openDb(":memory:");
    const vt = new VectorTables(db, "node");
    vt.putDense("a", "m", "h", unit([1, 0, 0]));
    vt.putDense("b", "m", "h", unit([0.9, 0.1, 0]));
    vt.putDense("c", "m", "h", unit([0, 1, 0]));
    vt.putDense("z", "other-model", "h", unit([1, 0, 0]));
    expect(vt.denseSearch(unit([1, 0, 0]), "m", { limit: 5 }).map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(vt.denseSearch(unit([1, 0, 0]), "m", { limit: 5, floor: 0.75 }).map((s) => s.id)).toEqual(["a", "b"]);
    expect(vt.denseSearch(unit([1, 0, 0]), "m", { limit: 5, filter: (id) => id !== "a" })[0]!.id).toBe("b");
    expect(vt.missing("dense", "m", [{ id: "a", hash: "h" }, { id: "b", hash: "changed" }, { id: "q", hash: "h" }])).toEqual(["b", "q"]);
    expect(vt.dropOtherModels(["m"])).toBe(1);
    expect(vt.count("dense")).toBe(3);
  });

  it("ranks by exact MaxSim on small sets and through encodings on large ones", () => {
    const db = openDb(":memory:");
    const vt = new VectorTables(db, "turn", { fdeDims: 512 });
    const docs: Record<string, string> = {
      target: "the token cache refresh must be single flight because concurrent refreshes race on the pending promise",
      near: "token cache entries expire after five minutes unless refreshed",
    };
    for (let i = 0; i < 60; i++) docs[`noise${i}`] = `unrelated note number ${i} about ${["kubernetes", "css grid", "postgres vacuum", "react hooks", "terraform state"][i % 5]} and item${i} detail${i * 7}`;
    for (const [id, text] of Object.entries(docs)) vt.putTokens(id, "late", "h", tokens(text), "int8", 1);
    const q = tokens("why do concurrent token cache refreshes race");
    const exact = vt.lateSearch(q, "late", { limit: 3, exactMax: 2000, candidates: 200 });
    expect(exact[0]!.id).toBe("target");
    expect(exact[1]!.id).toBe("near");
    expect(exact[0]!.score).toBeGreaterThan(0.6);
    expect(exact[2]!.score).toBeLessThan(exact[0]!.score - 0.2);
    // two-stage path: 62 items > exactMax 10, encodings pick 12 candidates, MaxSim ranks them
    const staged = vt.lateSearch(q, "late", { limit: 3, exactMax: 10, candidates: 12 });
    expect(staged[0]!.id).toBe("target");
    expect(staged[0]!.score).toBeCloseTo(exact[0]!.score, 6);
    // restricted scan and filter
    expect(vt.lateSearch(q, "late", { limit: 3, exactMax: 2000, candidates: 200, only: new Set(["near", "noise1"]) })[0]!.id).toBe("near");
    expect(vt.lateSearch(q, "late", { limit: 3, exactMax: 2000, candidates: 200, filter: (id) => id !== "target" })[0]!.id).toBe("near");
    // symmetric similarity for de-dup: a paraphrase with the same words scores ~1, others low
    expect(vt.symmetricWith(tokens(docs.target!), "target", "late")!).toBeGreaterThan(0.97);
    expect(vt.symmetricWith(tokens(docs.target!), "noise3", "late")!).toBeLessThan(0.6);
    // tiers: 1-bit keeps the ranking at an eighth of the int8 size
    const before = vt.bytes().tokens;
    for (const id of Object.keys(docs)) vt.requantize(id, "late", "binary");
    expect(vt.bytes().tokens).toBe(before / 8);
    expect(vt.lateSearch(q, "late", { limit: 1, exactMax: 2000, candidates: 200 })[0]!.id).toBe("target");
  });

  it("fuses rankings with reciprocal ranks", () => {
    const fused = rrf([[{ id: "a", score: 9 }, { id: "b", score: 8 }, { id: "c", score: 1 }], [{ id: "b", score: 0.9 }, { id: "d", score: 0.8 }]]);
    expect(fused.map((s) => s.id)).toEqual(["b", "a", "d", "c"]);
    expect(fused[0]!.score).toBeCloseTo(1 / 62 + 1 / 61);
  });
});

describe("turn index", () => {
  it("chunks raw entries, searches them, and expands neighbors", () => {
    const ti = new TurnIndex(join(tmp(), "turns.sqlite"));
    const long = Array.from({ length: 300 }, (_, i) => `line ${i}: the quick brown fox jumps over the lazy dog ${i === 250 ? "NEEDLE_xyzzy" : ""}`).join("\n");
    const chunks = chunkText(long);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(estimateTokens(c)).toBeLessThanOrEqual(560);
    expect(chunks.join("\n")).toBe(long);
    // Non-ASCII text (1 token per char) and surrogate pairs must still stay under maxTokens without splitting pairs.
    const cjk = "漢".repeat(1200) + "🚀".repeat(200);
    const nonAsciiChunks = chunkText(cjk, 256);
    expect(nonAsciiChunks.length).toBeGreaterThanOrEqual(6);
    expect(nonAsciiChunks.join("")).toBe(cjk);
    for (const c of nonAsciiChunks) expect(estimateTokens(c)).toBeLessThanOrEqual(256);
    for (let i = 0; i < 6; i++) ti.addRaw({ session: "s1", harness: "pi", entryId: `e${i}`, at: `2026-11-01T00:0${i}:00.000Z`, text: i === 3 ? long : `entry ${i} talks about migrations step${i}`, role: i % 2 ? "assistant" : "user", seq: i });
    ti.addRaw({ session: "s2", harness: "claude-code", entryId: "e0", at: "2026-10-01T00:00:00.000Z", text: "an earlier session mentioned NEEDLE_xyzzy too", seq: 0 });
    ti.addConsolidation({ id: "t:c7f3a2e8", session: "s1", harness: "pi", kind: "precip", at: "2026-11-01T01:00:00.000Z", text: "[t:c7f3a2e8] Fixed the migrations ordering bug." });
    const hits = ti.bm25("NEEDLE_xyzzy", { limit: 5, sessions: ["s1"] });
    expect(hits.length).toBe(1);
    const row = ti.get(hits[0]!.id)!;
    expect(row).toMatchObject({ session: "s1", entry: "e3", kind: "raw" });
    expect(row.chunk).toBeGreaterThan(0);
    expect(hits[0]!.id).toBe(rawTurnId("s1", "e3", row.chunk));
    expect(ti.bm25("NEEDLE_xyzzy", { limit: 5 }).length).toBe(2); // where: "project"
    expect(ti.bm25("migrations", { limit: 10, kinds: ["precip"] }).map((s) => s.id)).toEqual(["t:c7f3a2e8"]);
    expect([...new Set(ti.neighbors(row, 2).map((r) => r.entry))]).toEqual(["e1", "e2", "e3", "e4", "e5"]);
    // re-indexing is idempotent, and a shrunken entry leaves no stale chunks
    const n = ti.stats().turns;
    ti.addRaw({ session: "s1", harness: "pi", entryId: "e0", at: "2026-11-01T00:00:00.000Z", text: "entry 0 talks about migrations step0", role: "user", seq: 0 });
    expect(ti.stats().turns).toBe(n);
    ti.addRaw({ session: "s1", harness: "pi", entryId: "e3", at: "2026-11-01T00:03:00.000Z", text: "now short", seq: 3 });
    expect(ti.byEntry("s1", "e3").length).toBe(1);
    expect(ti.bm25("NEEDLE_xyzzy", { limit: 5, sessions: ["s1"] })).toEqual([]);
    expect(ti.removeContaining(["an earlier session mentioned NEEDLE_xyzzy"])).toBe(1);
    expect(ti.bm25("NEEDLE_xyzzy", { limit: 5 })).toEqual([]);
    ti.close();
  });

  it("ages token vectors and evicts raw-turn vectors before anything else", () => {
    const ti = new TurnIndex(join(tmp(), "turns.sqlite"));
    const now = new Date("2026-11-20T00:00:00Z");
    for (let i = 0; i < 40; i++) {
      const at = new Date(now.getTime() - i * 3 * 86_400_000).toISOString();
      const [id] = ti.addRaw({ session: "s", harness: "pi", entryId: `e${i}`, at, text: `entry ${i} ${"word ".repeat(120)}`, seq: i });
      ti.vectors.putTokens(id!, "late", "h", tokens(`entry ${i} ${"word alpha beta gamma ".repeat(30)}`, 64), "int8", 2);
      ti.vectors.putDense(id!, "dense", "h", unit([i + 1, 1, 0]));
    }
    ti.addConsolidation({ id: "t:aaaaaaaa", session: "s", harness: "pi", kind: "palim", at: now.toISOString(), text: "consolidated text" });
    ti.vectors.putTokens("t:aaaaaaaa", "late", "h", tokens("consolidated text about things", 64), "int8", 2);
    expect(ti.ageTokens("late", 30, now, "binary")).toBe(29); // entries older than 30 days
    expect(ti.ageTokens("late", 30, now, "binary")).toBe(0);
    const before = ti.stats();
    const res = ti.evict(before.bytes - 30_000);
    expect(res.tokens).toBeGreaterThan(0);
    // the oldest raw turn lost its matrix first; the consolidated turn keeps its vectors
    expect(ti.vectors.getTokens(rawTurnId("s", "e39"), "late")).toBeNull();
    expect(ti.vectors.getTokens("t:aaaaaaaa", "late")).not.toBeNull();
    expect(ti.bm25("entry", { limit: 50 }).length).toBe(40); // text and BM25 stay
    const all = ti.evict(0);
    expect(all.vectors).toBeGreaterThan(0);
    expect(ti.vectors.count("dense")).toBe(0);
    expect(ti.vectors.getTokens("t:aaaaaaaa", "late")).not.toBeNull();
    ti.close();
  });
});
