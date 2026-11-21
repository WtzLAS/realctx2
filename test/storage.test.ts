import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LoroDoc, LoroMap } from "loro-crdt";
import { afterAll, describe, expect, it } from "vitest";
import { MemoryRuntime } from "../src/memory/runtime.ts";
import { ScopeDoc } from "../src/storage/schema.ts";
import type { ScopeStore } from "../src/storage/store.ts";
import { tryLock } from "../src/util/fs.ts";
import { world } from "./helpers/fakes.ts";
import { cleanupTmp, commitAll, copyDir, git, initRepo, listTree, mergeDirs, node, openStore, rng, sharedStore, stateOf, testConfig, tmp, treeContains } from "./helpers/fixtures.ts";

afterAll(cleanupTmp);

function randomEdits(store: ScopeStore, rand: () => number, tag: string, n: number): void {
  const sd = store.sd;
  for (let i = 0; i < n; i++) {
    const ids = sd.allNodes().map((x) => x.id);
    const pick = () => ids[Math.floor(rand() * ids.length)]!;
    const r = rand();
    if (r < 0.3 || ids.length < 3) {
      sd.insertNode(node({ id: `${tag}${String(i).padStart(4, "0")}x`.slice(0, 8), text: `fact ${tag} ${i} ${rand().toFixed(5)}` }));
    } else if (r < 0.45) {
      sd.patchNode(pick(), { text: `edited by ${tag} at ${i}`, title: `t-${tag}-${i}` });
    } else if (r < 0.6) {
      sd.incCounter(pick(), "used", 0.7);
      sd.incCounter(pick(), "delivered", 1);
    } else if (r < 0.7) {
      sd.addEvidence(pick(), { quote: `quote ${Math.floor(rand() * 4)}`, source: { type: "file", ref: "a.ts:1" }, verified: true });
    } else if (r < 0.8) {
      sd.putEdge({ src: pick(), dst: pick(), rel: "precedes", w: rand(), evidenceAt: "2026-11-01T00:00:00.000Z", active: true });
    } else if (r < 0.88) {
      sd.addStrengthEvent(pick(), { id: `${tag}-${i}`, t: "2026-11-02T00:00:00.000Z", kind: "reinforce", value: 1, n: 1 });
    } else if (r < 0.94) {
      const pid = sd.ensurePath(`src/${tag}/file${Math.floor(rand() * 3)}.ts`, "file");
      sd.setAnchor(pick(), { kind: "file", pathId: pid, role: "about", status: "live" });
    } else if (r < 0.97) {
      sd.patchNode(pick(), { status: "dormant", statusReason: "test" });
    } else {
      sd.incTurns(1);
    }
    store.commit(`edit ${i}`);
  }
}

describe("document schema", () => {
  it("round-trips a node with its child containers", () => {
    const sd = ScopeDoc.create({ scope: "personal" });
    const pid = sd.ensurePath("packages/api/src/db/schema.ts", "file", { blob: "abc" });
    sd.insertNode(
      node({
        id: "7f3a9k2d",
        kind: "rule",
        severity: "must",
        urgency: "immediate",
        urgencyBy: "user",
        triggers: { on: ["edit"], commands: ["prisma migrate reset*"] },
        text: "Never run prisma migrate reset.",
        anchors: [{ kind: "file", pathId: pid, role: "applies", status: "live", seenBlob: "abc" }],
        evidence: [{ quote: "never reset", source: { type: "instruction", ref: "AGENTS.md:12" }, verified: true }],
        signature: ["prisma migrate reset"],
        pinned: true,
        layer: "long",
      }),
    );
    sd.incCounter("7f3a9k2d", "used", 0.7);
    sd.incCounter("7f3a9k2d", "used", 0.2);
    sd.incCounter("7f3a9k2d", "violations_hint", 1);
    sd.addStrengthEvent("7f3a9k2d", { id: "e1", t: "2026-11-03T00:00:00.000Z", kind: "reinforce", value: 0.7, n: 2 });
    sd.commit();
    const n = sd.getNode("7f3a9k2d")!;
    expect(n.counters.used).toBeCloseTo(0.9, 10);
    expect(n.counters.violations_hint).toBe(1);
    expect(n.anchors).toEqual([{ kind: "file", pathId: pid, role: "applies", status: "live", seenBlob: "abc", glob: undefined, symbol: undefined, staleAt: undefined }]);
    expect(n.evidence[0]).toMatchObject({ quote: "never reset", verified: true });
    expect(n.triggers).toEqual({ on: ["edit"], commands: ["prisma migrate reset*"] });
    expect(n.strength.events.map((e) => e.id)).toEqual(["e1"]);
    expect(sd.pathOf(pid)).toBe("packages/api/src/db/schema.ts");
    // a reload from bytes sees the same node
    const again = new LoroDoc();
    again.import(sd.doc.export({ mode: "snapshot" }));
    expect(new ScopeDoc(again).getNode("7f3a9k2d")).toEqual(n);
  });

  it("merges concurrent evidence, anchors, counters and events without duplicates", () => {
    const a = ScopeDoc.create({ scope: "personal" });
    a.insertNode(node({ id: "aaaaaaaa" }));
    a.commit();
    const b = new ScopeDoc(new LoroDoc());
    b.doc.import(a.doc.export({ mode: "snapshot" }));
    const ev = { quote: "same quote", source: { type: "file", ref: "x.ts:3" }, verified: true };
    for (const [sd, tag] of [[a, "a"], [b, "b"]] as const) {
      sd.addEvidence("aaaaaaaa", ev);
      sd.addEvidence("aaaaaaaa", { ...ev, quote: `only ${tag}` });
      sd.incCounter("aaaaaaaa", "delivered", 2);
      sd.addStrengthEvent("aaaaaaaa", { id: `ev-${tag}`, t: "2026-11-04T00:00:00.000Z", kind: "reinforce", value: 1 });
      sd.setAnchor("aaaaaaaa", { kind: "glob", glob: "**/*.sql", role: "applies", status: "live" });
      sd.commit();
    }
    a.doc.import(b.doc.export({ mode: "update" }));
    b.doc.import(a.doc.export({ mode: "update" }));
    a.invalidate();
    b.invalidate();
    const na = a.getNode("aaaaaaaa")!;
    expect(na).toEqual(b.getNode("aaaaaaaa"));
    expect(na.evidence.map((e) => e.quote).sort()).toEqual(["only a", "only b", "same quote"]);
    expect(na.counters.delivered).toBe(4);
    expect(na.strength.events.length).toBe(2);
    expect(na.anchors.length).toBe(1);
  });

  it("moves a directory with everything below it, and keeps ids across concurrent moves", () => {
    const a = ScopeDoc.create({ scope: "personal" });
    const f1 = a.ensurePath("src/auth/tokenCache.ts", "file");
    const f2 = a.ensurePath("src/auth/session/store.ts", "file");
    const dir = a.findPath("src/auth")!;
    a.commit();
    const b = new ScopeDoc(new LoroDoc());
    b.doc.import(a.doc.export({ mode: "snapshot" }));
    a.movePath(dir, "packages/core/auth");
    a.commit();
    b.movePath(f1, "src/auth/cache.ts");
    b.commit();
    a.doc.import(b.doc.export({ mode: "update" }));
    b.doc.import(a.doc.export({ mode: "update" }));
    a.invalidate();
    b.invalidate();
    expect(a.pathOf(f1)).toBe("packages/core/auth/cache.ts");
    expect(b.pathOf(f1)).toBe("packages/core/auth/cache.ts");
    expect(a.pathOf(f2)).toBe("packages/core/auth/session/store.ts");
    expect(a.findPath("src/auth/tokenCache.ts")).toBeNull();
  });

  it("an older client keeps fields it does not know (§7.13)", () => {
    const sd = ScopeDoc.create({ scope: "shared" });
    sd.insertNode(node({ id: "bbbbbbbb", text: "original" }));
    // a newer version adds a field and a child container this build has never heard of
    const raw = sd.doc.getMap("nodes").get("bbbbbbbb") as LoroMap;
    raw.set("futureField", { nested: [1, 2, 3] });
    raw.setContainer("futureChild", new LoroMap()).set("k", "v");
    sd.commit();
    sd.invalidate();
    const n = sd.getNode("bbbbbbbb")!;
    expect(n.extra).toEqual({ futureField: { nested: [1, 2, 3] }, futureChild: { k: "v" } });
    // this build edits the node through its normal write paths
    sd.patchNode("bbbbbbbb", { text: "edited", status: "dormant" });
    sd.incCounter("bbbbbbbb", "used", 1);
    sd.commit();
    const after = sd.doc.getMap("nodes").toJSON() as Record<string, Record<string, unknown>>;
    expect(after.bbbbbbbb!.futureField).toEqual({ nested: [1, 2, 3] });
    expect(after.bbbbbbbb!.futureChild).toEqual({ k: "v" });
    expect(after.bbbbbbbb!.text).toBe("edited");
    // a node of a kind this build cannot read is skipped and reported, not deleted
    const odd = sd.doc.getMap("nodes").setContainer("cccccccc", new LoroMap());
    odd.set("kind", "hologram");
    odd.set("text", "from the future");
    odd.set("layer", "short");
    sd.commit();
    sd.invalidate();
    expect(sd.getNode("cccccccc")).toBeNull();
    expect(sd.invalid).toEqual([{ id: "cccccccc", problem: "bad kind hologram" }]);
    expect(sd.hasNode("cccccccc")).toBe(true);
  });

  it("opens read-only when the document needs a newer writer", () => {
    const dir = join(tmp(), "store");
    const s = openStore(dir);
    s.sd.insertNode(node({ id: "dddddddd" }));
    s.sd.doc.getMap("meta").set("minWriter", 99);
    s.commit();
    s.flush();
    const older = openStore(dir);
    expect(older.readOnly).toBe(true);
    expect(older.sd.getNode("dddddddd")).not.toBeNull();
    older.sd.patchNode("dddddddd", { text: "should not be written" });
    expect(older.flush().kind).toBe("none");
    expect(older.problems.some((p) => /read-only/.test(p.problem))).toBe(true);
  });
});

describe("store files", () => {
  it("writes immutable, uniquely named update files and reloads them", () => {
    const dir = join(tmp(), "store");
    const s = openStore(dir);
    expect(JSON.parse(readFileSync(join(dir, "store.json"), "utf8"))).toMatchObject({ format: 2, scope: "project-personal" });
    expect(s.flush().kind).toBe("none"); // nothing but bookkeeping
    s.sd.insertNode(node({ id: "aaaaaaaa", text: "first" }));
    s.commit("write");
    const r1 = s.flush();
    expect(r1.kind).toBe("update");
    expect(r1.file).toMatch(/updates\/\d{8}T\d{9}Z-\d+-[0-9a-f]{8}\.loro$/);
    expect(s.flush().kind).toBe("none");
    s.sd.patchNode("aaaaaaaa", { text: "second" });
    s.commit();
    s.flush();
    expect(s.updateFiles().length).toBe(2);
    const again = openStore(dir);
    expect(again.sd.getNode("aaaaaaaa")!.text).toBe("second");
    expect(stateOf(again)).toEqual(stateOf(s));
  });

  it("does not wait for a store lock another process holds when told not to", () => {
    const s = openStore(join(tmp(), "store"));
    s.sd.insertNode(node({ id: "aaaaaaaa", text: "first" }));
    s.commit("write");
    const held = tryLock(s.opts.lockFile)!; // another process, compacting
    const started = Date.now();
    expect(s.flush({ wait: false }).kind).toBe("deferred");
    expect(Date.now() - started).toBeLessThan(500);
    expect(s.hasUnflushed()).toBe(true);
    expect(s.updateFiles()).toEqual([]);
    held.release();
    expect(s.flush({ wait: false }).kind).toBe("update");
    expect(s.hasUnflushed()).toBe(false);
  });

  it("keeps a deferred periodic flush due, and retries it at the next commit point", () => {
    const repo = initRepo();
    const w = world({ cwd: repo });
    const mem = new MemoryRuntime({ layout: w.layout, cfg: w.cfg, cwd: repo, trusted: true, decision: w.decision, aux: w.aux, clock: w.clock, sessionId: "sess-test", harness: "test" });
    const store = mem.graph.handle("personal").store;
    store.sd.insertNode(node({ id: "aaaaaaaa", text: "first" }));
    store.commit("write");
    w.now.t += (w.cfg.storage.flushMinutes + 1) * 60_000;
    const held = tryLock(store.opts.lockFile)!;
    const started = Date.now();
    mem.flushIfDue();
    expect(Date.now() - started).toBeLessThan(1000); // the harness's thread was not held for the lock
    expect(store.hasUnflushed()).toBe(true);
    held.release();
    mem.flushIfDue(); // same clock: still due
    expect(store.hasUnflushed()).toBe(false);
    store.sd.patchNode("aaaaaaaa", { text: "second" });
    store.commit();
    mem.flushIfDue(); // flushed now: due again only after flushMinutes
    expect(store.hasUnflushed()).toBe(true);
    mem.shutdown();
    w.close();
  });

  it("lets a second process see new files on refresh", () => {
    const dir = join(tmp(), "store");
    const a = openStore(dir);
    const b = openStore(dir);
    let notified = 0;
    b.onChange(() => notified++);
    a.sd.insertNode(node({ id: "aaaaaaaa" }));
    a.commit();
    a.flush();
    expect(b.sd.getNode("aaaaaaaa")).toBeNull();
    expect(b.refresh()).toBe(true);
    expect(notified).toBe(1);
    expect(b.sd.getNode("aaaaaaaa")).not.toBeNull();
    expect(b.refresh()).toBe(false);
    // what b imported is already on disk: b has nothing of its own to flush
    expect(b.flush().kind).toBe("none");
    b.sd.incCounter("aaaaaaaa", "used", 1);
    b.commit();
    const res = b.flush();
    expect(res.kind).toBe("update");
    expect(res.bytes).toBeLessThan(600);
  });

  it("caps file sizes and reports oversized files instead of loading them", () => {
    const dir = join(tmp(), "store");
    const cfg = testConfig({ storage: { maxUpdateBytes: 2000 } });
    const s = openStore(dir, {}, { home: join(dir, "..", ".home"), cfg: testConfig() });
    s.sd.insertNode(node({ id: "aaaaaaaa", text: "x".repeat(6000) }));
    s.commit();
    s.flush();
    const capped = openStore(dir, {}, { home: join(dir, "..", ".home"), cfg });
    expect(capped.sd.getNode("aaaaaaaa")).toBeNull();
    expect(capped.problems.some((p) => /over the 2000-byte cap/.test(p.problem))).toBe(true);
  });

  it("leaves the store unloaded when files are LFS pointers and git-lfs cannot fetch them", () => {
    const dir = join(tmp(), "store");
    const s = openStore(dir);
    s.sd.insertNode(node({ id: "aaaaaaaa" }));
    s.commit();
    const f = s.flush().file!;
    writeFileSync(f, "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n");
    const again = openStore(dir);
    expect(again.unloaded).toBe(true);
    expect(again.unloadedReason).toMatch(/git lfs pull/);
    expect(again.flush().kind).toBe("none");

    // pulling an LFS pointer mid-session during refresh() also records a problem instead of silently skipping
    const dir2 = join(tmp(), "store-refresh-lfs");
    const live = openStore(dir2);
    live.sd.insertNode(node({ id: "bbbbbbbb" }));
    live.commit();
    live.flush();
    writeFileSync(join(dir2, "updates", "20261121T000000000Z-999-deadbeef.loro"), "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n");
    expect(live.refresh()).toBe(false);
    expect(live.problems.some((p) => /git lfs pull/.test(p.problem))).toBe(true);
  });

  it("reuses a released PeerID only when the document still contains its operations", () => {
    const root = tmp();
    const dir = join(root, "store");
    const cfg = testConfig({ storage: { peerReuse: true } });
    const env = { home: join(root, ".home"), cfg };
    const peersFile = join(root, ".home", "peers", "s.json");
    const a = openStore(dir, { peersFile }, env);
    const peerA = a.sd.doc.peerIdStr;
    a.sd.insertNode(node({ id: "aaaaaaaa" }));
    a.commit();
    a.close();
    const b = openStore(dir, { peersFile }, env);
    expect(b.sd.doc.peerIdStr).toBe(peerA);
    // while b holds the lease, a concurrent process gets its own id
    const c = openStore(dir, { peersFile }, env);
    expect(c.sd.doc.peerIdStr).not.toBe(peerA);
    b.sd.insertNode(node({ id: "bbbbbbbb" }));
    b.commit();
    b.close();
    c.close();
    // "branch switch": the files b wrote are gone, so its released id must not be reused
    const other = join(root, "other");
    copyDir(dir, other);
    const newest = listTree(join(other, "updates")).sort().at(-1)!;
    writeFileSync(join(other, "updates", newest), readFileSync(join(dir, "updates", listTree(join(dir, "updates")).sort()[0]!)));
    const d = openStore(other, { peersFile }, env);
    expect(d.sd.getNode("bbbbbbbb")).toBeNull();
    expect(d.sd.doc.peerIdStr).not.toBe(peerA);
  });
});

describe("convergence through file exchange only (§12.1)", () => {
  it("random concurrent edits on simulated branches converge", () => {
    for (const seed of [1, 2, 3]) {
      const rand = rng(seed);
      const root = tmp();
      const base = join(root, "base");
      const s0 = openStore(base);
      randomEdits(s0, rand, "s", 12);
      s0.flush();
      // three branches fork from the base; each has two "machines" sharing the branch directory
      const branches = ["a", "b", "c"].map((name) => copyDir(base, join(root, name)));
      for (let round = 0; round < 3; round++) {
        for (const [bi, dir] of branches.entries()) {
          const m1 = openStore(dir);
          const m2 = openStore(dir);
          randomEdits(m1, rand, `p${bi}${round}`, 8);
          randomEdits(m2, rand, `q${bi}${round}`, 8);
          m1.flush();
          m2.flush();
        }
      }
      // merge a+b, then (a+b)+c, with nothing but file additions and deletions
      const ab = join(root, "ab");
      mergeDirs(base, branches[0]!, branches[1]!, ab);
      const abc = join(root, "abc");
      mergeDirs(base, ab, branches[2]!, abc);
      const cba = join(root, "cba");
      const cb = join(root, "cb");
      mergeDirs(base, branches[2]!, branches[1]!, cb);
      mergeDirs(base, cb, branches[0]!, cba);
      const x = openStore(abc);
      const y = openStore(cba);
      expect(x.problems).toEqual([]);
      expect(stateOf(x)).toEqual(stateOf(y));
      expect(x.sd.nodeCount()).toBeGreaterThan(20);
      // every branch's nodes made it
      for (const dir of branches) for (const n of openStore(dir).sd.allNodes()) expect(x.sd.hasNode(n.id)).toBe(true);
    }
  });
});

describe("compaction (§7.7)", () => {
  it("preserves state, deletes what it covers, and trims history with a lag", () => {
    const dir = join(tmp(), "store");
    const s = openStore(dir);
    const rand = rng(7);
    for (let i = 0; i < 5; i++) {
      randomEdits(s, rand, `a${i}`, 6);
      s.flush();
    }
    const before = stateOf(s);
    const r1 = s.compact()!;
    expect(r1.kind).toBe("snapshot");
    expect(s.updateFiles()).toEqual([]);
    const m1 = s.liveSnapshots();
    expect(m1.length).toBe(1);
    expect(m1[0]!.parents).toEqual([]);
    expect(m1[0]!.covers.length).toBe(5);
    expect(m1[0]!.shallowRoot).toEqual([]); // first snapshot: nothing older to drop
    expect(stateOf(openStore(dir))).toEqual(before);
    // second epoch
    randomEdits(s, rand, "b", 10);
    s.flush();
    const mid = stateOf(s);
    s.compact();
    const m2 = s.liveSnapshots();
    expect(m2.length).toBe(1);
    expect(m2[0]!.parents).toEqual([m1[0]!.epoch]);
    expect(m2[0]!.shallowRoot).toEqual(m1[0]!.head); // lagged: history since the previous head is kept
    expect(listTree(join(dir, "snapshots")).length).toBe(2); // one .loro and its manifest
    const reloaded = openStore(dir);
    expect(stateOf(reloaded)).toEqual(mid);
    expect(reloaded.sd.doc.isShallow()).toBe(true);
    expect(reloaded.problems).toEqual([]);
  });

  it("fires on the documented triggers", () => {
    const dir = join(tmp(), "store");
    let now = Date.parse("2026-11-01T00:00:00Z");
    const cfg = testConfig({ storage: { compact: { maxUpdateFiles: 4 } } });
    const s = openStore(dir, { clock: () => new Date(now) }, { home: join(dir, "..", ".home"), cfg });
    expect(s.compactionDue()).toBeNull();
    for (let i = 0; i < 4; i++) {
      s.sd.insertNode(node({ id: `aaaaaaa${i}`, text: `n${i} ${"pad ".repeat(200)}` }));
      s.commit();
      s.flush();
      now += 1000;
    }
    expect(s.compactionDue()).toMatch(/4 update files/);
    expect(s.maybeCompact()!.kind).toBe("snapshot");
    expect(s.compactionDue()).toBeNull();
    // one small update: below 25% of the snapshot, and the snapshot is fresh
    s.sd.incCounter("aaaaaaa0", "used", 1);
    s.commit();
    s.flush();
    expect(s.compactionDue()).toBeNull();
    now += 31 * 86_400_000;
    expect(s.compactionDue()).toMatch(/days old/);
    now -= 31 * 86_400_000;
    // updates reaching 25% of the snapshot
    for (let i = 0; i < 2; i++) {
      s.sd.insertNode(node({ id: `bbbbbbb${i}`, text: `big ${"lorem ipsum ".repeat(300)}${i}` }));
      s.commit();
      s.flush();
    }
    expect(s.compactionDue()).toMatch(/25%/);
  });

  it("a branch spanning one compaction merges directly", () => {
    const root = tmp();
    const main = join(root, "main");
    const m = openStore(main);
    const rand = rng(11);
    randomEdits(m, rand, "m0", 10);
    m.flush();
    m.compact(); // S1
    randomEdits(m, rand, "m1", 6);
    m.flush();
    // the branch forks here, after S1
    const forkPoint = copyDir(main, join(root, "fork"));
    const branch = copyDir(main, join(root, "branch"));
    const b = openStore(branch);
    randomEdits(b, rand, "br", 10);
    b.flush();
    // main moves on and compacts once (S2, lagged root = S1.head)
    randomEdits(m, rand, "m2", 6);
    m.flush();
    m.compact();
    expect(m.liveSnapshots()[0]!.parents.length).toBe(1);
    const merged = join(root, "merged");
    mergeDirs(forkPoint, main, branch, merged);
    const x = openStore(merged);
    expect(x.problems).toEqual([]);
    expect(x.recovered).toEqual([]);
    for (const n of b.sd.allNodes()) expect(x.sd.getNode(n.id)).toEqual(n.id.startsWith("br") ? n : expect.anything());
    for (const n of m.sd.allNodes()) expect(x.sd.hasNode(n.id)).toBe(true);
    // and the merge is symmetric
    const merged2 = join(root, "merged2");
    mergeDirs(forkPoint, branch, main, merged2);
    expect(stateOf(openStore(merged2))).toEqual(stateOf(x));
  });

  it("two branches that both compact share a shallow root and load together", () => {
    const root = tmp();
    const main = join(root, "main");
    const m = openStore(main);
    const rand = rng(13);
    randomEdits(m, rand, "m0", 10);
    m.flush();
    m.compact();
    randomEdits(m, rand, "m1", 4);
    m.flush();
    const a = openStore(copyDir(main, join(root, "a")));
    const b = openStore(copyDir(main, join(root, "b")));
    randomEdits(a, rand, "aa", 8);
    randomEdits(b, rand, "bb", 8);
    a.flush();
    b.flush();
    a.compact();
    b.compact();
    expect(a.liveSnapshots()[0]!.shallowRoot).toEqual(b.liveSnapshots()[0]!.shallowRoot);
    const merged = join(root, "merged");
    mergeDirs(main, a.dir, b.dir, merged);
    const x = openStore(merged);
    expect(x.problems).toEqual([]);
    expect(x.liveSnapshots().length).toBe(2);
    for (const n of [...a.sd.allNodes(), ...b.sd.allNodes()]) expect(x.sd.hasNode(n.id)).toBe(true);
    // the next compaction folds both, listing both as parents
    expect(x.compactionDue()).toMatch(/2 live snapshots/);
    x.compact();
    const folded = x.liveSnapshots();
    expect(folded.length).toBe(1);
    expect(folded[0]!.parents.length).toBe(2);
    expect(stateOf(openStore(merged))).toEqual(stateOf(x));
  });
});

describe("shared store in git", () => {
  it("creates the skeleton, never dirties the tree for counter-only sessions, and journals them", () => {
    const repo = initRepo();
    const s = sharedStore(repo, { lazyCreate: true });
    expect(existsSync(join(repo, ".pi"))).toBe(false); // nothing written before the first shared memory
    s.sd.insertNode(node({ id: "aaaaaaaa", text: "shared fact" }));
    s.commit();
    expect(existsSync(s.opts.journalFile!)).toBe(true); // crash journal
    expect(s.flush().kind).toBe("update");
    expect(existsSync(s.opts.journalFile!)).toBe(false);
    expect(JSON.parse(readFileSync(join(s.dir, "store.json"), "utf8"))).toMatchObject({ format: 2, scope: "project-shared" });
    expect(readFileSync(join(s.dir, ".gitattributes"), "utf8")).toMatch(/\*\.loro (binary|filter=lfs)/);
    expect(existsSync(join(s.dir, "README.md"))).toBe(true);
    commitAll(repo, "memory");
    // a read-only session only bumps counters
    const reader = sharedStore(repo);
    reader.sd.incCounter("aaaaaaaa", "delivered", 1);
    reader.sd.incCounter("aaaaaaaa", "retrieved", 1);
    reader.commit();
    expect(reader.close().kind).toBe("journal");
    expect(git(repo, "status", "--porcelain")).toBe("");
    // the next session picks the journal up; a substantive write carries the counters along
    const writer = sharedStore(repo);
    expect(writer.sd.getNode("aaaaaaaa")!.counters.delivered).toBe(1);
    writer.sd.patchNode("aaaaaaaa", { text: "shared fact, edited" });
    writer.commit();
    expect(writer.close().kind).toBe("update");
    const check = sharedStore(repo);
    expect(check.sd.getNode("aaaaaaaa")!.counters.delivered).toBe(1);
    expect(check.sd.getNode("aaaaaaaa")!.text).toBe("shared fact, edited");
  });

  it("flushes buffered counters once the threshold is crossed, or on demand", () => {
    const repo = initRepo();
    const cfg = testConfig({ shared: { counterFlushThreshold: 5 } });
    const home = join(tmp(), "home");
    const s = sharedStore(repo, {}, { home, cfg });
    s.sd.insertNode(node({ id: "aaaaaaaa" }));
    s.commit();
    s.flush();
    for (let i = 0; i < 4; i++) s.sd.incCounter("aaaaaaaa", "delivered", 1);
    s.commit();
    expect(s.flush().kind).toBe("journal");
    expect(s.flush({ force: true }).kind).toBe("update"); // `/realctx2 share`, pre-commit
    for (let i = 0; i < 5; i++) s.sd.incCounter("aaaaaaaa", "delivered", 1);
    s.commit();
    expect(s.flush().kind).toBe("update");
  });

  it("survives a crash: journaled shared writes come back in the next session", () => {
    const repo = initRepo();
    const s = sharedStore(repo);
    s.sd.insertNode(node({ id: "aaaaaaaa", text: "written just before the crash" }));
    s.commit();
    // no flush, no close
    const next = sharedStore(repo);
    expect(next.sd.getNode("aaaaaaaa")!.text).toBe("written just before the crash");
    expect(next.flush().kind).toBe("update");
  });

  it("compacts off the default branch back to the default branch's newest snapshot", () => {
    const repo = initRepo();
    const rand = rng(17);
    let now = Date.parse("2026-10-01T00:00:00Z");
    const clock = () => new Date((now += 1000));
    const main = sharedStore(repo, { clock });
    randomEdits(main, rand, "m0", 8);
    main.flush();
    main.compact(); // S1 on main
    const s1 = main.liveSnapshots()[0]!;
    randomEdits(main, rand, "m1", 4);
    main.flush();
    commitAll(repo, "main memory");
    // two feature branches fork from main and each compacts
    const states: unknown[] = [];
    for (const name of ["feat-a", "feat-b"]) {
      git(repo, "checkout", "-q", "-b", name, "main");
      const s = sharedStore(repo, { clock });
      randomEdits(s, rand, name.slice(-1) + "x", 8);
      s.flush();
      commitAll(repo, `${name} memory`);
      now += 8 * 86_400_000;
      s.compact();
      const live = s.liveSnapshots();
      expect(live.length).toBe(1);
      expect(live[0]!.shallowRoot).toEqual(s1.head);
      states.push(stateOf(s));
      commitAll(repo, `${name} compaction`);
    }
    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "-q", "--no-edit", "feat-a");
    git(repo, "merge", "-q", "--no-edit", "feat-b"); // git only sees additions and deletions
    expect(git(repo, "status", "--porcelain")).toBe("");
    const merged = sharedStore(repo, { clock });
    expect(merged.problems).toEqual([]);
    expect(merged.liveSnapshots().length).toBe(2);
    const ids = merged.sd.allNodes().map((n) => n.id);
    expect(ids.some((i) => i.startsWith("ax"))).toBe(true);
    expect(ids.some((i) => i.startsWith("bx"))).toBe(true);
  });

  it("recovers updates stranded by two compactions from git history (§7.9)", () => {
    const repo = initRepo();
    const rand = rng(19);
    let now = Date.parse("2026-09-01T00:00:00Z");
    const clock = () => new Date((now += 1000));
    const main = sharedStore(repo, { clock });
    randomEdits(main, rand, "m0", 8);
    main.sd.insertNode(node({ id: "keepme01", text: "before the branch" }));
    main.commit();
    main.flush();
    main.compact(); // S1
    commitAll(repo, "S1");
    // long-lived branch: writes one update based on S1 and then sleeps
    git(repo, "checkout", "-q", "-b", "long-lived");
    const b = sharedStore(repo, { clock });
    b.sd.insertNode(node({ id: "stranded", text: "written on the long-lived branch" }));
    b.sd.patchNode("keepme01", { text: "edited on the long-lived branch" });
    b.sd.incCounter("keepme01", "used", 2);
    const pid = b.sd.ensurePath("src/long/lived.ts", "file");
    b.sd.setAnchor("stranded", { kind: "file", pathId: pid, role: "about", status: "live" });
    b.commit();
    b.flush();
    commitAll(repo, "branch memory");
    // main compacts twice: the second one trims the history the branch update depends on
    git(repo, "checkout", "-q", "main");
    for (const tag of ["m1", "m2"]) {
      const s = sharedStore(repo, { clock });
      randomEdits(s, rand, tag, 6);
      s.flush();
      now += 8 * 86_400_000;
      s.compact();
      commitAll(repo, `compaction ${tag}`);
    }
    git(repo, "merge", "-q", "--no-edit", "long-lived");
    const merged = sharedStore(repo, { clock });
    expect(merged.recovered.length).toBe(1);
    expect(merged.recovered[0]).toMatchObject({ nodesAdded: 1, nodesPatched: 1 });
    expect(merged.sd.getNode("stranded")!.text).toBe("written on the long-lived branch");
    expect(merged.sd.getNode("keepme01")!.text).toBe("edited on the long-lived branch");
    expect(merged.sd.getNode("keepme01")!.counters.used).toBe(2);
    expect(merged.sd.pathOf(merged.sd.getNode("stranded")!.anchors[0]!.pathId)).toBe("src/long/lived.ts");
    expect(merged.strandedFiles()).toEqual([]);
    // the stranded file was replaced by one new update, and the store now loads cleanly
    const again = sharedStore(repo, { clock });
    expect(again.recovered).toEqual([]);
    expect(again.problems).toEqual([]);
    expect(again.sd.getNode("stranded")).not.toBeNull();
  });

  it("parks stranded updates when history is not available", () => {
    const root = tmp();
    const main = join(root, "main");
    const m = openStore(main);
    m.sd.insertNode(node({ id: "aaaaaaaa" }));
    m.commit();
    m.flush();
    m.compact();
    const branch = openStore(copyDir(main, join(root, "branch")));
    branch.sd.insertNode(node({ id: "stranded" }));
    branch.commit();
    const file = branch.flush().file!;
    for (let i = 0; i < 2; i++) {
      m.sd.insertNode(node({ id: `bbbbbbb${i}` }));
      m.commit();
      m.flush();
      m.compact();
    }
    writeFileSync(join(main, "updates", file.split("/").pop()!), readFileSync(file));
    const x = openStore(main); // not a git repo: no history to recover from
    expect(x.sd.getNode("stranded")).toBeNull();
    expect(x.strandedFiles().length).toBe(1);
    expect(x.problems.some((p) => /stranded/.test(p.problem))).toBe(true);
    expect(x.sd.getNode("bbbbbbb1")).not.toBeNull();
    expect(openStore(main).problems).toEqual([]); // parked files no longer block loading
  });
});

describe("purge (§7.10)", () => {
  it("removes the text from every current file at the flush, and not before", () => {
    const dir = join(tmp(), "store");
    const s = openStore(dir);
    const secret = "the launch code is 7-ALPHA-TANGO-9931";
    s.sd.insertNode(node({ id: "secret01", text: secret, evidence: [{ quote: `pasted: ${secret}`, source: { type: "session", ref: "r:aaaaaaaa" }, verified: true }] }));
    s.sd.addEvidence("secret01", { quote: `again ${secret}`, source: { type: "tool", ref: "bash" }, verified: false });
    s.sd.insertNode(node({ id: "keeper01", text: "harmless" }));
    s.sd.putEdge({ src: "keeper01", dst: "secret01", rel: "derived-from", w: 0.5, evidenceAt: "2026-11-01T00:00:00.000Z", active: true });
    s.commit();
    s.flush();
    s.sd.patchNode("secret01", { title: "launch" });
    s.commit();
    s.flush();
    s.compact();
    s.sd.incCounter("secret01", "used", 1);
    s.commit();
    s.flush();
    expect(treeContains(dir, secret).length).toBeGreaterThan(0);
    // the purge takes effect in memory at once, but files change only at the flush (so it can be undone)
    s.sd.patchNode("secret01", { status: "purged" });
    s.pendingPurge.add("secret01");
    s.commit();
    expect(treeContains(dir, secret).length).toBeGreaterThan(0);
    const res = s.flush();
    expect(res.kind).toBe("snapshot");
    expect(treeContains(dir, secret)).toEqual([]);
    expect(s.sd.getNode("secret01")).toBeNull();
    expect(s.sd.allEdges()).toEqual([]);
    expect(s.sd.getNode("keeper01")!.text).toBe("harmless");
    // the in-memory document no longer carries the purged operations either
    expect(Buffer.from(s.sd.doc.export({ mode: "snapshot" })).includes(Buffer.from(secret))).toBe(false);
    const again = openStore(dir);
    expect(again.sd.getNode("secret01")).toBeNull();
    expect(again.sd.getNode("keeper01")).not.toBeNull();
    // later writes keep working on the purged store
    again.sd.insertNode(node({ id: "later001" }));
    again.commit();
    again.flush();
    expect(openStore(dir).sd.getNode("later001")).not.toBeNull();
  });

  it("finishes a purge that a crashed session left behind", () => {
    const dir = join(tmp(), "store");
    const s = openStore(dir);
    s.sd.insertNode(node({ id: "secret01", text: "forget me entirely please" }));
    s.sd.patchNode("secret01", { status: "purged" });
    s.commit();
    // the status write reached disk through an ordinary flush, then the process died
    s.pendingPurge.clear();
    s.flush();
    const next = openStore(dir);
    expect(next.pendingPurge.has("secret01")).toBe(true);
    next.flush();
    expect(treeContains(dir, "forget me entirely please")).toEqual([]);
  });

  it("retains pendingPurge and reports a problem if the purge snapshot exceeds maxSnapshotBytes", () => {
    const dir = join(tmp(), "store");
    const s = openStore(dir);
    s.sd.insertNode(node({ id: "secret01", text: "sensitive value to purge" }));
    s.sd.insertNode(node({ id: "keeper01", text: "x".repeat(400) }));
    s.commit();
    s.flush();
    // Force snapshot cap below the snapshot size so compactLocked skips writing.
    const capped = openStore(dir, { cfg: testConfig({ storage: { maxSnapshotBytes: 10 } }) });
    capped.sd.patchNode("secret01", { status: "purged" });
    capped.pendingPurge.add("secret01");
    capped.commit();
    const res = capped.flush();
    expect(res.kind).toBe("none");
    expect(capped.pendingPurge.has("secret01")).toBe(true);
    expect(capped.problems.some((p) => p.problem.includes("pending purge retained"))).toBe(true);
  });
});

describe("ID collisions (§8.1.2)", () => {
  it("re-keys the overwritten node under the same fresh ID on every machine, with an alias", () => {
    const root = tmp();
    const base = join(root, "base");
    const s0 = openStore(base);
    s0.sd.insertNode(node({ id: "seed0000" }));
    s0.commit();
    s0.flush();
    // two machines draw the same ID at the same time
    const a = openStore(copyDir(base, join(root, "a")));
    const b = openStore(copyDir(base, join(root, "b")));
    a.sd.insertNode(node({ id: "clash001", text: "written on machine A" }));
    a.sd.incCounter("clash001", "used", 3);
    a.commit();
    a.flush();
    b.sd.insertNode(node({ id: "clash001", text: "written on machine B" }));
    b.commit();
    b.flush();
    const merged = join(root, "merged");
    mergeDirs(base, a.dir, b.dir, merged);
    // both machines load the merged files independently
    const x = openStore(copyDir(merged, join(root, "x")), { stateFile: join(root, "x-state.json") });
    const y = openStore(copyDir(merged, join(root, "y")));
    expect(x.collisions.length).toBe(1);
    expect(y.collisions).toEqual(x.collisions);
    const rekeyed = x.collisions[0]!.rekeyed;
    expect(rekeyed).toMatch(/^[0-9a-z]{8}$/);
    const texts = [x.sd.getNode("clash001")!.text, x.sd.getNode(rekeyed)!.text].sort();
    expect(texts).toEqual(["written on machine A", "written on machine B"]);
    expect(x.sd.getNode(rekeyed)!.aliasOf).toBe("clash001");
    // both write the re-keyed node; their files merge into one node, not a second collision
    x.flush();
    y.flush();
    const again = join(root, "again");
    mergeDirs(merged, x.dir, y.dir, again);
    const z = openStore(again);
    expect(z.collisions).toEqual([]);
    expect(z.sd.allNodes().filter((n) => n.aliasOf === "clash001").length).toBe(1);
    expect(z.sd.nodeCount()).toBe(3);
    // a later load with the saved bookkeeping does not look again
    const x2 = openStore(x.dir, { stateFile: join(root, "x-state.json") });
    expect(x2.collisions).toEqual([]);
    expect(x2.sd.getNode(rekeyed)).not.toBeNull();
  });

  it("detects a collision when a running session imports the other machine's file", () => {
    const dir = join(tmp(), "store");
    const a = openStore(dir);
    const b = openStore(dir);
    a.sd.insertNode(node({ id: "clash002", text: "from A" }));
    a.commit();
    b.sd.insertNode(node({ id: "clash002", text: "from B" }));
    b.commit();
    a.flush();
    expect(b.refresh()).toBe(true);
    expect(b.collisions.length).toBe(1);
    const all = b.sd.allNodes().map((n) => n.text).sort();
    expect(all).toEqual(["from A", "from B"]);
    // a purge is not a collision: the purged node must not come back under a new ID
    const c = openStore(join(tmp(), "store2"));
    c.sd.insertNode(node({ id: "gone0001", text: "purged for good" }));
    c.commit();
    c.flush();
    c.sd.deleteNode("gone0001");
    c.commit();
    c.flush();
    const c2 = openStore(c.dir);
    expect(c2.collisions).toEqual([]);
    expect(c2.sd.nodeCount()).toBe(0);
  });
});
