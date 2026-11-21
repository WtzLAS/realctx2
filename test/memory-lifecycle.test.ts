import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { MemoryNode } from "../src/core/types.ts";
import { Lifecycle, reviveNode } from "../src/memory/lifecycle.ts";
import { Retriever } from "../src/memory/retrieve.ts";
import { foldPlan, importance, irrelevanceRate, memoryWorth, reinforce, retention, strengthAt, useSignals, worthClass } from "../src/memory/strength.ts";
import { escalation } from "../src/memory/urgency.ts";
import { MemoryWriter } from "../src/memory/write.ts";
import { DAY, world, type World } from "./helpers/fakes.ts";
import { cleanupTmp, initRepo, node, testConfig, treeContains } from "./helpers/fixtures.ts";

afterAll(cleanupTmp);

const T0 = "2026-11-01T00:00:00.000Z";
const at = (days: number) => new Date(Date.parse(T0) + days * DAY);
const mk = (over: Partial<MemoryNode> = {}) => node({ id: "aaaaaaaa", createdAt: T0, lastAccessAt: T0, strength: { base: { v: 1, t: T0 }, events: [] }, ...over });

function put(w: World, scope: "personal" | "shared" | "global", over: Partial<MemoryNode> & { id: string }): MemoryNode {
  const created = over.createdAt ?? new Date(w.now.t).toISOString();
  w.graph.sd(scope).insertNode(node({ createdAt: created, lastAccessAt: created, strength: { base: { v: 0.6, t: created }, events: [] }, ...over }));
  return w.graph.sd(scope).getNode(over.id)!;
}

describe("strength (§6.5.1)", () => {
  it("decays with the documented half-lives and never for pinned nodes", () => {
    expect(strengthAt(mk({ layer: "short" }), at(5.02))).toBeCloseTo(0.5, 2); // β = 1.2 → ≈ 5.0 days
    expect(strengthAt(mk({ layer: "long" }), at(11.25))).toBeCloseTo(0.5, 2); // β = 0.8 → ≈ 11.3 days
    expect(strengthAt(mk({ layer: "short", importance: 1 }), at(5.02))).toBeCloseTo(Math.exp(-0.1 * Math.exp(-1) * 5.02 ** 1.2), 4); // λ = λ_base · exp(−μ·I)
    expect(strengthAt(mk({ layer: "short", decayDivisor: 1 + Math.log(3) }), at(5.02))).toBeGreaterThan(0.7); // fused nodes decay slower
    expect(strengthAt(mk({ pinned: true }), at(1000))).toBe(1);
    expect(strengthAt(mk(), at(-3))).toBe(1); // before creation: nothing has decayed
  });

  it("reinforces on use, with diminishing returns for repeated recent use", () => {
    expect(reinforce(0.4, 1, 0)).toBeCloseTo(0.4 + 0.25 * 0.6);
    expect(reinforce(0.4, 0.5, 0)).toBeCloseTo(0.4 + 0.25 * 0.5 * 0.6);
    expect(reinforce(0.4, 1, 5)).toBeCloseTo(0.4 + 0.25 * 0.6 * Math.exp(-1));
    const n = mk({ layer: "short", strength: { base: { v: 0.6, t: T0 }, events: [{ id: "e1", t: at(3).toISOString(), kind: "reinforce", value: 1, n: 0 }] } });
    const before = 0.6 * Math.exp(-0.1 * 3 ** 1.2);
    expect(strengthAt(n, at(3))).toBeCloseTo(reinforce(before, 1, 0), 6);
    // after the event, decay continues from (v_ref, t_ref) on the same curve
    const later = reinforce(before, 1, 0) * Math.exp(-0.1 * (6 ** 1.2 - 3 ** 1.2));
    expect(strengthAt(n, at(6))).toBeCloseTo(later, 6);
  });

  it("keeps the curve continuous across a layer transition", () => {
    const move = at(4).toISOString();
    const n = mk({ layer: "long", strength: { base: { v: 0.8, t: T0 }, events: [{ id: "l1", t: move, kind: "layer", value: 0, layer: "long" }] } });
    const atMove = 0.8 * Math.exp(-0.1 * 4 ** 1.2); // decayed with the short-term β up to the move
    expect(strengthAt(n, at(4))).toBeCloseTo(atMove, 6);
    expect(strengthAt(n, new Date(Date.parse(move) + 1))).toBeCloseTo(atMove, 4); // no jump at the switch
    expect(strengthAt(n, at(10))).toBeCloseTo(atMove * Math.exp(-0.1 * (10 ** 0.8 - 4 ** 0.8)), 6); // long-term β afterwards
  });

  it("folds only events past the 14-day window, without changing the derived value", () => {
    const events = [3, 10, 20, 28].map((d, i) => ({ id: `e${i}`, t: at(d).toISOString(), kind: "reinforce" as const, value: 1, n: 0 }));
    const n = mk({ layer: "short", strength: { base: { v: 0.6, t: T0 }, events } });
    const now = at(30);
    const before = strengthAt(n, now);
    const plan = foldPlan(n, now)!;
    expect(plan.remove).toEqual(["e0", "e1"]); // days 3 and 10 are older than 14 days; 20 and 28 stay
    expect(plan.base.t).toBe(at(10).toISOString());
    const folded = { ...n, strength: { base: plan.base, events: events.filter((e) => !plan.remove.includes(e.id)) } };
    expect(strengthAt(folded, now)).toBeCloseTo(before, 10);
    // two machines folding concurrently and merging: replay only applies events after base.t
    const merged = { ...n, strength: { base: plan.base, events } };
    expect(strengthAt(merged, now)).toBeCloseTo(before, 10);
    expect(foldPlan(folded, now)).toBeNull();
  });
});

describe("importance, Memory Worth and retention", () => {
  it("computes importance from relevance, use rate and recency", () => {
    const n = mk({ lastAccessAt: at(10).toISOString(), strength: { base: { v: 0.6, t: T0 }, events: [{ id: "e", t: at(10).toISOString(), kind: "reinforce", value: 1 }] }, counters: { ...mk().counters, used: 1 } });
    const I = importance(n, 0.5, at(24));
    const f = 0.5; // one use, one 14-day half-life ago
    expect(I).toBeCloseTo(0.4 * 0.5 + 0.3 * (f / (1 + f)) + 0.3 * Math.exp(-0.05 * 14), 6);
  });

  it("classifies Memory Worth and the other use signals", () => {
    const c = (over: object) => ({ ...mk().counters, ...over });
    expect(memoryWorth(c({}))).toEqual({ mw: 0.5, evidence: 0 });
    expect(memoryWorth(c({ usedSuccess: 3, usedFailure: 1 })).mw).toBeCloseTo(4 / 6);
    expect(worthClass(c({ usedSuccess: 1, usedFailure: 1 }))).toBe("uncertain"); // never deprecate on thin data
    expect(worthClass(c({ usedSuccess: 3, usedFailure: 1 }))).toBe("high");
    expect(worthClass(c({ usedSuccess: 0.5, usedFailure: 4.5 }))).toBe("low");
    expect(worthClass(c({ usedSuccess: 1, usedFailure: 2 }))).toBe("mixed");
    expect(useSignals(mk({ counters: c({ delivered: 6, ignoredRelevant: 3 }) })).rewriteCandidate).toBe(true);
    expect(useSignals(mk({ counters: c({ delivered: 10, used: 0.4 }) })).deadWeight).toBe(true);
    expect(useSignals(mk({ kind: "rule", counters: c({ delivered: 10, used: 0 }) })).deadWeight).toBe(false); // preventive rules are exempt
    expect(useSignals(mk({ counters: c({ harm: 1 }) })).harmful).toBe(true);
    expect(irrelevanceRate(mk({ counters: c({ delivered: 2, used: 0 }) }))).toBe(0); // too few deliveries
    expect(irrelevanceRate(mk({ counters: c({ delivered: 4, used: 1 }) }))).toBeCloseTo(0.75);
    expect(irrelevanceRate(mk({ kind: "rule", counters: c({ delivered: 4, used: 0, complied: 3 }) }))).toBeCloseTo(0.25);
  });

  it("scores retention from recency, frequency, centrality and turn decay", () => {
    const n = mk({ lastAccessAt: at(0).toISOString(), createdTurn: 100, counters: { ...mk().counters, used: 2, expanded: 1, delivered: 4 } });
    const R = retention(n, { now: at(90), maxAccess: 8, centrality: 0.5, scopeTurns: 1100 });
    expect(R).toBeCloseTo(0.35 * 0.5 + 0.25 * (Math.log(1 + 4) / Math.log(1 + 8)) + 0.2 * 0.5 + 0.2 * 0.5, 6);
  });

  it("discounts short→long edges in centrality but not in activation", async () => {
    const w = world({ cwd: initRepo() });
    const longNode = put(w, "personal", { id: "longlong", layer: "long", text: "Established architecture knowledge about the queue." });
    for (let i = 0; i < 4; i++) {
      const note = put(w, "personal", { id: `note000${i}`, text: `Fresh note ${i} citing the queue architecture.` });
      w.graph.link({ scope: "personal", node: note }, "derived-from", { scope: "personal", node: longNode }, { w: 1 });
    }
    const peerA = put(w, "personal", { id: "peeraaaa", layer: "long", text: "Another established fact about retries." });
    const peerB = put(w, "personal", { id: "peerbbbb", layer: "long", text: "A third established fact about backoff." });
    w.graph.link({ scope: "personal", node: peerA }, "causes", { scope: "personal", node: peerB }, { w: 1 });
    w.graph.commit("personal");
    const c = w.graph.centrality("personal");
    // four transient citations (4 × 0.25 = 1.0) count no more than one long-term edge
    expect(c.get("longlong")).toBeCloseTo(c.get("peeraaaa")!, 6);
    expect(c.get("longlong")).toBe(1);
    w.graph.syncIndexes();
    // activation still flows at full weight from a recent note to durable knowledge (κ_act = 1)
    const hits = await new Retriever(w).retrieve("Fresh note 0 citing");
    expect(hits.find((h) => h.ref.node.id === "longlong")!.activation).toBeCloseTo(hits[0]!.activation * 1 * 1 * 0.5, 6);
    w.close();
  });
});

describe("hygiene and the forgetting pass (§6.5.2, §6.5.4)", () => {
  it("starts a remembered memory short-term, leaves it there until it earns the long-term layer", async () => {
    const w = world({ cwd: initRepo() });
    const [r] = await new MemoryWriter(w).write([{ text: "The staging database runs Postgres 16.", origin: "explicit", scope: "personal", urgency: "passive" }]);
    const cur = () => w.graph.get(r!.id!)!.node;
    expect(cur()).toMatchObject({ layer: "short", pinned: false, origin: "explicit" });
    // the first hygiene passes move nothing: no demotion seconds after the write, no promotion without use
    const life = new Lifecycle(w);
    expect(life.hygiene("personal")).toMatchObject({ promoted: [], demoted: [] });
    w.now.t += 2 * DAY;
    expect(life.hygiene("personal")).toMatchObject({ promoted: [], demoted: [] });
    expect(cur().layer).toBe("short");
    expect(cur().strength.events.filter((e) => e.kind === "layer")).toEqual([]);
    // attributed use in three sessions, mostly with good outcomes: the fast track promotes it
    for (const [name, by] of [["used", 3], ["usedSuccess", 3], ["useSessions", 3]] as const) w.graph.sd("personal").incCounter(cur().id, name, by);
    w.graph.commit("personal");
    expect(life.hygiene("personal").promoted).toEqual([cur().id]);
    expect(cur().layer).toBe("long");
    expect(cur().strength.events.at(-1)).toMatchObject({ kind: "layer", layer: "long" });
    // a pinned memory is long-term from the start
    const [p] = await new MemoryWriter(w).write([{ text: "Always answer in British English.", kind: "preference", origin: "explicit", scope: "personal", urgency: "hint", pin: true }]);
    expect(w.graph.get(p!.id!)!.node).toMatchObject({ layer: "long", pinned: true });
    w.close();
  });

  it("promotes, demotes with hysteresis, and fast-tracks proven memories", () => {
    const w = world({ cwd: initRepo() });
    const old = new Date(w.now.t - 60 * DAY).toISOString();
    const recentUse = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `u${i}`, t: new Date(w.now.t - i * DAY).toISOString(), kind: "reinforce" as const, value: 1 }));
    put(w, "personal", { id: "promote1", layer: "short", lastAccessAt: new Date(w.now.t).toISOString(), strength: { base: { v: 0.6, t: old }, events: recentUse(8) } }); // I ≈ 0.3·8/9·… + 0.3 → needs relevance too
    put(w, "personal", { id: "demote01", layer: "long", createdAt: old, lastAccessAt: old });
    put(w, "personal", { id: "pinned01", layer: "long", pinned: true, createdAt: old, lastAccessAt: old });
    put(w, "personal", { id: "worthy01", layer: "long", createdAt: old, lastAccessAt: old, counters: { ...mk().counters, usedSuccess: 4, used: 4 } });
    put(w, "personal", { id: "fasttrak", layer: "short", createdAt: old, lastAccessAt: old, counters: { ...mk().counters, usedSuccess: 3, used: 3, useSessions: 3 } });
    put(w, "personal", { id: "middle01", layer: "long", createdAt: old, lastAccessAt: new Date(w.now.t - 2 * DAY).toISOString() }); // 0.3 ≤ I < 0.7: inside the hysteresis band
    // relevance to recent intent purposes lifts importance
    w.graph.handle("personal").index!.addPurpose("p1", `memory promote1`, new Date(w.now.t).toISOString());
    w.graph.commit("personal");
    const report = new Lifecycle(w).hygiene("personal");
    const layer = (id: string) => w.graph.get(id)!.node.layer;
    expect(report.promoted.sort()).toEqual(["fasttrak", "promote1"]);
    expect(report.demoted).toEqual(["demote01"]);
    expect([layer("pinned01"), layer("worthy01")]).toEqual(["long", "long"]); // guards: pinned, MW high-value
    const mid = w.graph.get("middle01")!.node;
    expect(mid.importance).toBeGreaterThanOrEqual(0.3);
    expect(mid.importance).toBeLessThan(0.7);
    expect(mid.layer).toBe("long");
    // the move is written with a layer-transition event, so every machine derives the same curve
    const demoted = w.graph.get("demote01")!.node;
    expect(demoted.strength.events.at(-1)).toMatchObject({ kind: "layer", layer: "short" });
    expect(w.graph.get("promote1")!.node.importance).toBeGreaterThanOrEqual(0.7);
    // a second pass right away changes nothing (hysteresis gap)
    const again = new Lifecycle(w).hygiene("personal");
    expect([...again.promoted, ...again.demoted]).toEqual([]);
    w.close();
  });

  it("forgets weak short-term nodes into dormancy, honouring every guard", async () => {
    const w = world({ cwd: initRepo() });
    const old = new Date(w.now.t - 120 * DAY).toISOString();
    const base = { createdAt: old, lastAccessAt: old, layer: "short" as const, createdTurn: 0 };
    put(w, "personal", { id: "weak0001", ...base, text: "weak note one" });
    put(w, "personal", { id: "pinned01", ...base, pinned: true, layer: "long" });
    put(w, "personal", { id: "longterm", ...base, layer: "long", counters: { ...mk().counters, usedSuccess: 5, used: 5 } }); // LML is never forgotten directly
    put(w, "personal", { id: "highmw01", ...base, counters: { ...mk().counters, usedSuccess: 4, used: 4 } });
    put(w, "personal", { id: "deliverd", ...base, lastDeliveredAt: new Date(w.now.t - 2 * DAY).toISOString() });
    put(w, "personal", { id: "brandnew", layer: "short", strength: { base: { v: 0.01, t: new Date(w.now.t - DAY).toISOString() }, events: [] }, createdAt: new Date(w.now.t - DAY).toISOString() });
    const head = put(w, "personal", { id: "chainhed", ...base });
    const tail = put(w, "personal", { id: "chainold", ...base, text: "superseded fact" });
    w.graph.link({ scope: "personal", node: head }, "supersedes", { scope: "personal", node: tail });
    const member = put(w, "personal", { id: "onlyevid", ...base, evidence: [{ quote: "q", source: { type: "file", ref: "a.ts" }, verified: true }] });
    const concept = put(w, "personal", { id: "concept1", ...base, kind: "concept", layer: "long", pinned: true });
    w.graph.link({ scope: "personal", node: concept }, "generalizes", { scope: "personal", node: member });
    // two verified members under one unverified active concept: when both fall below threshold
    // in the same pass, the first becomes dormant and the last remaining one is archived under it
    const m2a = put(w, "personal", { id: "dual0001", ...base, evidence: [{ quote: "q1", source: { type: "file", ref: "b.ts" }, verified: true }] });
    const m2b = put(w, "personal", { id: "dual0002", ...base, evidence: [{ quote: "q2", source: { type: "file", ref: "c.ts" }, verified: true }] });
    const concept2 = put(w, "personal", { id: "concept2", ...base, kind: "concept", layer: "long", pinned: true });
    w.graph.link({ scope: "personal", node: concept2 }, "generalizes", { scope: "personal", node: m2a });
    w.graph.link({ scope: "personal", node: concept2 }, "generalizes", { scope: "personal", node: m2b });
    const neighbor = put(w, "personal", { id: "neighbor", ...base, layer: "long", pinned: true });
    w.graph.link({ scope: "personal", node: w.graph.get("weak0001")!.node }, "precedes", { scope: "personal", node: neighbor });
    w.graph.sd("personal").incTurns(5000);
    w.graph.commit("personal");
    w.graph.syncIndexes();
    const life = new Lifecycle(w);
    const report = life.hygiene("personal");
    expect(report.forgettingRan).toBe(true);
    expect(report.dormant.sort()).toEqual(["chainold", "dual0001", "weak0001"]);
    expect(report.archived.sort()).toEqual(["dual0002", "onlyevid"]); // archived under its concept instead of going dormant
    expect(w.graph.get("onlyevid")!.node.statusReason).toBe("forgetting: kept under m:concept1");
    expect(w.graph.get("dual0002")!.node.statusReason).toBe("forgetting: kept under m:concept2");
    for (const id of ["pinned01", "longterm", "highmw01", "deliverd", "brandnew", "chainhed"]) expect(w.graph.get(id)!.node.status, id).toBe("active");
    // edges are kept, but inactive; dormant nodes leave default retrieval but stay reachable by ID
    expect(w.graph.sd("personal").allEdges().find((e) => e.src === "weak0001")!.active).toBe(false);
    expect((await new Retriever(w).retrieve("weak note one")).map((h) => h.ref.node.id)).not.toContain("weak0001");
    expect(w.graph.get("weak0001")!.node.status).toBe("dormant");
    // the pass is due daily or every 400 scope turns, whichever comes first
    put(w, "personal", { id: "weak0002", ...base, text: "weak note two" });
    w.graph.commit("personal");
    expect(life.hygiene("personal").forgettingRan).toBe(false);
    w.graph.sd("personal").incTurns(400);
    expect(life.hygiene("personal").dormant).toEqual(["weak0002"]);
    // revived by an exact re-statement: structure comes back, and the revival is counted
    const [merged] = await new MemoryWriter(w).write([{ text: "weak note one", origin: "harvest", scope: "personal", urgency: "passive" }]);
    expect(merged).toMatchObject({ status: "merged", id: "weak0001" });
    expect(w.graph.get("weak0001")!.node.flags).toContain("revived");
    expect(w.graph.sd("personal").allEdges().find((e) => e.src === "weak0001")!.active).toBe(true);
    // dormant → archived after 30 days unrevived
    w.now.t += 31 * DAY;
    expect(life.hygiene("personal").archived).toContain("weak0002");
    expect(w.graph.get("weak0002")!.node.status).toBe("archived");
    w.close();
  });

  it("raises the retention threshold while a scope is over its soft cap", () => {
    const w = world({ cwd: initRepo(), cfg: { memory: { caps: { short: 6 } } } });
    const old = new Date(w.now.t - 20 * DAY).toISOString();
    // ten middling nodes: R ≈ 0.35·0.86 + 0 + 0 + 0.2·turnDecay — spread by creation turn
    for (let i = 0; i < 10; i++) put(w, "personal", { id: `node000${i}`, layer: "short", createdAt: old, lastAccessAt: new Date(w.now.t - (60 + i * 15) * DAY).toISOString(), createdTurn: 0, strength: { base: { v: 1, t: new Date(w.now.t - DAY).toISOString() }, events: [] } });
    w.graph.sd("personal").incTurns(4000);
    w.graph.commit("personal");
    const report = new Lifecycle(w).hygiene("personal");
    expect(report.overCap.short).toBe(true);
    // 0.10 forgets one node, 0.15 four more: five remain, under the cap of six, so 0.20 is never tried
    expect(report.threshold).toBe(0.15);
    expect(report.dormant.length).toBe(5);
    expect(w.graph.active(["personal"]).length).toBe(5);
    w.close();
  });

  it("makes Memory Worth low-value nodes dormant and flags them for review", () => {
    const w = world({ cwd: initRepo() });
    const old = new Date(w.now.t - 10 * DAY).toISOString();
    put(w, "personal", { id: "lowvalue", layer: "short", createdAt: old, lastAccessAt: new Date(w.now.t).toISOString(), strength: { base: { v: 1, t: new Date(w.now.t).toISOString() }, events: [] }, counters: { ...mk().counters, usedSuccess: 0.5, usedFailure: 5, used: 5.5 } });
    w.graph.commit("personal");
    const report = new Lifecycle(w).hygiene("personal");
    expect(report.lowValue).toEqual(["lowvalue"]);
    expect(w.graph.get("lowvalue")!.node).toMatchObject({ status: "dormant", flags: ["low-value"] });
    w.close();
  });
});

describe("explicit forgetting (§6.5.6, §7.10)", () => {
  it("retires at once and restores", async () => {
    const w = world({ cwd: initRepo() });
    put(w, "personal", { id: "retireme", text: "The legacy importer uses XML." });
    w.graph.commit("personal");
    w.graph.syncIndexes();
    const life = new Lifecycle(w);
    const out = life.forget(w.graph.get("retireme")!, "obsolete since the JSON importer");
    expect(out.status).toBe("retired");
    expect(w.graph.get("retireme")!.node).toMatchObject({ status: "archived", statusReason: "retired: obsolete since the JSON importer" });
    expect(await new Retriever(w).retrieve("legacy importer XML")).toEqual([]);
    expect(life.restore("m:retireme").message).toBe("restored");
    expect((await new Retriever(w).retrieve("legacy importer XML")).map((h) => h.ref.node.id)).toEqual(["retireme"]);
    w.close();
  });

  it("purges: out of retrieval and indexes at once, out of the files at the flush, undoable until then", async () => {
    const w = world({ cwd: initRepo() });
    const secret = "the admin passphrase is correct-horse-battery";
    const target = put(w, "personal", { id: "purgeme1", text: secret, evidence: [{ quote: "passphrase correct-horse-battery was pasted", source: { type: "session", ref: "r:aaaaaaaa" }, verified: true }] });
    const derived = put(w, "personal", { id: "derived1", text: "A fact derived only from the purged note." });
    const independent = put(w, "personal", { id: "indep001", text: "Derived, but with its own verified evidence.", evidence: [{ quote: "own", source: { type: "file", ref: "x" }, verified: true }] });
    w.graph.link({ scope: "personal", node: derived }, "derived-from", { scope: "personal", node: target });
    w.graph.link({ scope: "personal", node: independent }, "derived-from", { scope: "personal", node: target });
    w.turns!.addRaw({ session: "s", harness: "pi", entryId: "e1", at: T0, text: "user: the passphrase correct-horse-battery was pasted here", seq: 0 });
    w.graph.commit("personal");
    w.graph.flush();
    w.graph.syncIndexes();
    expect(treeContains(w.home, "correct-horse-battery").length).toBeGreaterThan(0);
    const life = new Lifecycle(w);
    const out = life.forget(w.graph.get("purgeme1")!, "pasted by mistake", { purge: true });
    expect(out).toMatchObject({ status: "purged", cascade: ["derived1"] });
    expect(w.graph.get("purgeme1")).toBeNull();
    expect(w.graph.get("derived1")).toBeNull();
    expect(w.graph.get("indep001")).not.toBeNull();
    expect(await new Retriever(w).retrieve("admin passphrase")).toEqual([]);
    expect(w.turns!.bm25("passphrase", { limit: 5 })).toEqual([]);
    // undo within the session
    expect(life.restore("purgeme1").message).toBe("restored");
    expect(w.graph.get("purgeme1")!.node.status).toBe("active");
    life.forget(w.graph.get("purgeme1")!, "really", { purge: true });
    w.graph.flush();
    w.close();
    expect(treeContains(join(w.home, "projects"), "correct-horse-battery")).toEqual([]);
    const again = w.reopen();
    expect(again.graph.get("purgeme1", { includePurged: true })).toBeNull();
    expect(new Lifecycle(again).restore("purgeme1").status).toBe("not-found");
    again.close();
  });

  it("refuses an agent's purge of shared memory and retires instead", () => {
    const w = world({ cwd: initRepo() });
    put(w, "shared", { id: "sharedmm", text: "A shared convention." });
    w.graph.commit("shared");
    const life = new Lifecycle(w);
    const out = life.forget(w.graph.get("sharedmm")!, "wrong", { purge: true, byAgent: true });
    expect(out.status).toBe("retired");
    expect(out.message).toMatch(/\/realctx2 forget m:sharedmm --purge/);
    expect(w.graph.handle("shared").store.pendingPurge.size).toBe(0);
    // the user's own command may purge shared memory
    life.restore("sharedmm");
    expect(life.forget(w.graph.get("sharedmm")!, "wrong", { purge: true }).status).toBe("purged");
    w.close();
  });
});

describe("accounting and escalation (§6.7, §6.10.4)", () => {
  it("writes the session's batch once, with reinforcement and review flags", () => {
    const w = world({ cwd: initRepo() });
    const n = put(w, "personal", { id: "usedmem1", text: "A useful procedure.", kind: "procedure" });
    w.graph.commit("personal");
    const acc = w.accounting;
    acc.bump("personal", "usedmem1", "delivered", 1);
    acc.use("personal", n, 0.7, "success");
    acc.use("personal", n, 0.9, "failure");
    acc.bump("personal", "usedmem1", "harm", 1.2);
    acc.turn();
    acc.turn();
    expect(w.graph.get("usedmem1")!.node.counters.used).toBe(0); // nothing written before the flush
    acc.flush(w.graph, w.cfg);
    const after = w.graph.get("usedmem1")!.node;
    expect(after.counters).toMatchObject({ delivered: 1, usedSuccess: 0.7, usedFailure: 0.9, useSessions: 1 });
    expect(after.counters.used).toBeCloseTo(1.6);
    expect(after.strength.events.filter((e) => e.kind === "reinforce").map((e) => e.n).sort()).toEqual([0, 1]);
    expect(after.lastAccessAt).toBe(new Date(w.now.t).toISOString());
    expect(after.lastDeliveredAt).toBe(new Date(w.now.t).toISOString());
    expect(after.flags).toContain("harm");
    expect(w.graph.sd("personal").turns()).toBe(2);
    expect(w.graph.sd("global").turns()).toBe(2);
    w.close();
  });

  it("escalates one level per two violations, needs a trigger for immediate, and respects user overrides", () => {
    const w = world({ cwd: initRepo() });
    const rule = (id: string, over: Partial<MemoryNode> = {}) => put(w, "personal", { id, kind: "rule", severity: "must", urgency: "caption", urgencyBy: "decision", text: `rule ${id}`, ...over });
    rule("rule0001", { triggers: { commands: ["git push --force*"] } });
    rule("rule0002", { urgency: "hint" }); // no trigger: cannot become immediate
    rule("rule0003", { urgencyBy: "user" });
    put(w, "personal", { id: "fact0001", kind: "fact", urgency: "caption", text: "facts cannot be broken" });
    w.graph.commit("personal");
    const violate = (id: string, level: "caption" | "hint" | "immediate", p: number) => {
      w.accounting.bump("personal", id, `violations_${level}`, p);
      w.accounting.bump("personal", id, "violated", p);
      return w.accounting.flush(w.graph, w.cfg).escalations;
    };
    expect(violate("rule0001", "caption", 0.9)).toEqual([]); // 0.9 < 2
    expect(violate("rule0001", "caption", 1.2)).toEqual([{ scope: "personal", id: "rule0001", from: "caption", to: "hint", action: "escalate" }]);
    let n = w.graph.get("rule0001")!.node;
    expect(n).toMatchObject({ urgency: "hint", urgencyBy: "escalation" });
    expect(n.flags).toContain("escalated");
    expect(escalation(n, w.cfg).action).toBe("none"); // the count starts again at the new level
    violate("rule0001", "hint", 2);
    n = w.graph.get("rule0001")!.node;
    expect(n.urgency).toBe("immediate");
    // still broken at immediate: two more violations flag it as a rewrite candidate
    expect(violate("rule0001", "immediate", 2)[0]).toMatchObject({ action: "flag-rewrite" });
    expect(w.graph.get("rule0001")!.node.flags).toContain("rewrite-candidate");
    expect(violate("rule0002", "hint", 2)[0]).toMatchObject({ action: "flag-rewrite" });
    expect(w.graph.get("rule0002")!.node.urgency).toBe("hint");
    expect(violate("rule0003", "caption", 3)[0]).toMatchObject({ action: "list-for-review" });
    expect(w.graph.get("rule0003")!.node).toMatchObject({ urgency: "caption", urgencyBy: "user" });
    expect(violate("fact0001", "caption", 5)).toEqual([]);
    // a user override that lowers urgency to a visited level starts from a baseline, not from the old count
    const sd = w.graph.sd("personal");
    const cur = w.graph.get("rule0001")!.node;
    sd.patchNode("rule0001", { urgency: "caption", urgencyBy: "user", violationsBaseline: { ...cur.violationsBaseline, caption: cur.counters.violations_caption } });
    expect(escalation(w.graph.get("rule0001")!.node, w.cfg).action).toBe("none");
    w.close();
  });

  it("revives archived nodes into the short-term layer", () => {
    const w = world({ cwd: initRepo() });
    put(w, "personal", { id: "archived", layer: "long", status: "archived", statusReason: "retired: test" });
    expect(reviveNode(w.graph, w.graph.get("archived")!, new Date(w.now.t))).toBe(true);
    expect(w.graph.get("archived")!.node).toMatchObject({ status: "active", layer: "short" });
    void testConfig;
    w.close();
  });
});
