import { afterAll, describe, expect, it } from "vitest";
import { renderCard } from "../src/memory/cards.ts";
import { Retriever, renderViewCard, ThoroughSearch } from "../src/memory/retrieve.ts";
import { fitThreshold, Similarity } from "../src/memory/similarity.ts";
import { MemoryWriter } from "../src/memory/write.ts";
import { DAY, FakeLate, world, type World } from "./helpers/fakes.ts";
import { cleanupTmp, initRepo, testConfig, write } from "./helpers/fixtures.ts";

afterAll(cleanupTmp);

async function seed(w: World, items: Array<Record<string, unknown> & { text: string }>): Promise<string[]> {
  const res = await new MemoryWriter(w).write(items.map((it) => ({ origin: "explicit" as const, scope: "personal" as const, urgency: "hint" as const, skipConflicts: true, skipDedup: true, ...it })));
  await w.sim.embedNodes(w.graph);
  return res.map((r) => r.id!);
}

describe("retrieval core (§6.4.3)", () => {
  it("fuses semantic and lexical candidates and spreads activation along edges", async () => {
    const w = world({ cwd: initRepo(), embeddings: "dense" });
    const [cache, ttl, deploy, hop2, far] = await seed(w, [
      { text: "TokenCache.refresh must be single-flight; concurrent refreshes race on pending." },
      { text: "Feature flag evaluation is memoized per request." },
      { text: "Staging deploys need the VPN connected." },
      { text: "Memoization keys include the tenant id." },
      { text: "Completely unrelated note about office plants." },
    ]);
    const g = w.graph;
    const ref = (id: string) => g.get(id)!;
    g.link(ref(cache!), "causes", ref(ttl!), { w: 0.8 });
    g.link(ref(ttl!), "precedes", ref(hop2!), { w: 0.8 });
    g.link(ref(hop2!), "precedes", ref(far!), { w: 0.8 }); // three hops away: out of reach
    g.commit("personal");
    const hits = await new Retriever(w).retrieve("why do concurrent token cache refreshes race");
    const ids = hits.map((h) => h.ref.node.id);
    expect(ids[0]).toBe(cache);
    expect(ids).toContain(ttl); // one hop
    expect(ids).toContain(hop2); // two hops
    expect(ids).not.toContain(far);
    expect(ids).not.toContain(deploy);
    const byId = Object.fromEntries(hits.map((h) => [h.ref.node.id, h]));
    expect(byId[cache!]!.seed).toBe(true);
    expect(byId[ttl!]!.activation).toBeCloseTo(1 * 0.8 * 0.5);
    expect(byId[hop2!]!.activation).toBeCloseTo(0.4 * 0.8 * 0.5);
    // bookkeeping: retrieval counts are batched, and aux calls do not count
    w.accounting.flush(g, w.cfg);
    expect(g.get(cache!)!.node.counters.retrieved).toBe(1);
    expect(g.get(cache!)!.node.lastAccessAt).toBe(g.get(cache!)!.node.createdAt);
    await new Retriever(w).retrieve("token cache refreshes", { count: false });
    expect(w.accounting.size()).toBe(0);
    // an identifier matches lexically even when the embedding does not help
    expect((await new Retriever(w).retrieve("TokenCache.refresh"))[0]!.ref.node.id).toBe(cache);
    w.close();
  });

  it("scores by strength (floored), Memory Worth, irrelevance, scope and path", async () => {
    const repo = initRepo();
    write(repo, "src/db/schema.ts", "export const users = {}\n");
    const w = world({ cwd: repo });
    const base = "The users table soft-deletes rows via deletedAt";
    const [fresh, old, worthy, ignored, global, anchored, pinnedOld] = await seed(w, [
      { text: `${base} (fresh).` },
      { text: `${base} (old).` },
      { text: `${base} (worthy).` },
      { text: `${base} (ignored).` },
      { text: `${base} (global).`, scope: "global" },
      { text: `${base} (anchored).`, paths: ["src/db/schema.ts"] },
      { text: `${base} (pinned).`, pin: true },
    ]);
    const sd = w.graph.sd("personal");
    sd.patchNode(old!, { layer: "short" });
    for (const id of [fresh, worthy, ignored, anchored]) sd.patchNode(id!, { layer: "short" });
    // "old" has decayed far below the others; "pinned" is just as old but never decays
    const longAgo = new Date(w.now.t - 300 * DAY).toISOString();
    sd.foldStrength(old!, { v: 0.6, t: longAgo }, []);
    sd.patchNode(old!, { createdAt: longAgo });
    sd.patchNode(pinnedOld!, { createdAt: longAgo });
    sd.incCounter(worthy!, "usedSuccess", 6);
    sd.incCounter(worthy!, "used", 6);
    sd.incCounter(worthy!, "delivered", 6);
    sd.incCounter(ignored!, "delivered", 8);
    w.graph.commit("personal");
    w.graph.syncIndexes();
    const r = new Retriever(w);
    const score: Record<string, number> = {};
    for (const [id, tag] of [[fresh, "fresh"], [old, "old"], [worthy, "worthy"], [ignored, "ignored"], [global, "global"], [anchored, "anchored"], [pinnedOld, "pinned"]] as const) {
      const hit = (await r.retrieve(`${base} ${tag}`, { path: "src/db/schema.ts" })).find((h) => h.ref.node.id === id)!;
      score[id!] = hit.score / hit.activation;
    }
    const v = 0.8; // explicit memories start at 0.8
    expect(score[fresh!]).toBeCloseTo((0.2 + 0.8 * v) * 1.0, 2);
    expect(score[old!]).toBeCloseTo(0.2 * 1.0, 2); // floored at 0.2: still retrievable
    expect(score[worthy!]).toBeCloseTo((0.2 + 0.8 * v) * (0.5 + 7 / 8), 2);
    expect(score[ignored!]).toBeCloseTo((0.2 + 0.8 * v) * 1.0 * 0.5, 2); // irrelevance rate 1 halves it
    expect(score[global!]).toBeCloseTo((0.2 + 0.8 * v) * 0.8, 2);
    expect(score[anchored!]).toBeCloseTo((0.2 + 0.8 * v) * 1.5, 2);
    expect(score[pinnedOld!]).toBeCloseTo(1.0, 2);
    w.close();
  });

  it("returns chain heads only, contradicting pairs together, and nothing dormant", async () => {
    const w = world({ cwd: initRepo() });
    const [oldPort, newPort, a, b, dormant] = await seed(w, [
      { text: "The API server listens on port 3000." },
      { text: "The API server listens on port 4000." },
      { text: "Docker is required for the integration suite." },
      { text: "Completely different wording: containers are optional when running e2e." },
      { text: "The API server port used to be configurable through PORT." },
    ]);
    const g = w.graph;
    g.link(g.get(newPort!)!, "supersedes", g.get(oldPort!)!);
    g.link(g.get(a!)!, "contradicts", g.get(b!)!);
    g.link(g.get(b!)!, "contradicts", g.get(a!)!);
    g.sd("personal").patchNode(dormant!, { status: "dormant" });
    g.commit("personal");
    g.syncIndexes();
    const r = new Retriever(w);
    expect((await r.retrieve("API server port")).map((h) => h.ref.node.id)).toEqual([newPort]);
    const hist = (await r.retrieve("API server port", { history: true })).map((h) => h.ref.node.id);
    expect(hist).toEqual(expect.arrayContaining([oldPort, newPort, dormant]));
    // `b` shares no words with the query: it arrives because its contradiction was retrieved
    const pair = (await r.retrieve("Docker integration suite")).map((h) => h.ref.node.id);
    expect(pair).toEqual(expect.arrayContaining([a, b]));
    // cards show the markers
    const card = renderCard(g.get(a!)!, g, w.paths);
    expect(card).toMatch(new RegExp(`^\\[m:${a}\\] personal · long-term · as of 2026-11-20`));
    expect(card).toContain(`⚠ conflicts with [m:${b}]`);
    expect(renderCard(g.get(oldPort!)!, g, w.paths, { history: true })).toContain(`⟂ superseded by [m:${newPort}] on 2026-11-20`);
    expect(renderCard(g.get(oldPort!)!, g, w.paths)).not.toContain("⟂");
    expect(renderCard(g.get(a!)!, g, w.paths, { caption: true })).toBe(`[m:${a}] Docker is required for the integration suite`);
    w.close();
  });

  it("falls back from late interaction to dense to BM25 as endpoints go down", async () => {
    const w = world({ cwd: initRepo(), embeddings: "both" });
    await w.sim.calibrate();
    const [target] = await seed(w, [{ text: "Webpack builds take four minutes; prefer the Vite dev server locally." }, { text: "Unrelated: the cafeteria closes at three." }]);
    const r = new Retriever(w);
    expect(w.sim.searchMode()).toBe("late");
    expect((await r.retrieve("vite dev server"))[0]!.ref.node.id).toBe(target);
    w.late!.up = false;
    expect(w.sim.searchMode()).toBe("dense");
    expect(w.sim.thresholdMode()).toBe("dense");
    expect((await r.retrieve("webpack build minutes"))[0]!.ref.node.id).toBe(target);
    w.dense!.up = false;
    expect(w.sim.searchMode()).toBe("lexical");
    expect((await r.retrieve("webpack vite"))[0]!.ref.node.id).toBe(target);
    w.late!.up = true; // and back when it recovers
    expect(w.sim.searchMode()).toBe("late");
    w.close();
  });
});

describe("proactive path (§6.4.1)", () => {
  it("is gated by the decision model and never pushes passive or dead-weight memories", async () => {
    const w = world({ cwd: initRepo() });
    const [rule, cap, passive, dead] = await seed(w, [
      { text: "Database migrations must be backward compatible for one release.", kind: "rule", severity: "must" },
      { text: "Database migration files are numbered sequentially.", urgency: "caption" },
      { text: "Database migrations were introduced in 2021.", urgency: "passive" },
      { text: "Database migration tooling was evaluated: flyway vs prisma." },
    ]);
    const sd = w.graph.sd("personal");
    sd.incCounter(dead!, "delivered", 12);
    w.graph.commit("personal");
    const r = new Retriever(w);
    const purpose = { label: "Add a database migration for the orders table", reason: "the user asked for a new column", parentLabel: "Ship the orders feature" };
    // fail-safe: no decision model → inject nothing
    w.decision.isAvailable = false;
    expect((await r.proactive(purpose)).cards).toEqual([]);
    w.decision.isAvailable = true;
    let seen: string[] = [];
    w.decision.on("proactive.gate", (ev, qs) => {
      seen = ev.memories.map((m: { text: string }) => m.text);
      return Object.fromEntries(qs.map((q) => [q.name, q.name === "inject_any" ? 0.9 : q.name === "rel.0" ? 0.9 : 0.65]));
    });
    const res = await r.proactive(purpose);
    expect(seen.some((t) => t.includes("introduced in 2021"))).toBe(false); // passive
    expect(seen.some((t) => t.includes("flyway"))).toBe(false); // dead weight: delivered ≥ 10, used < 0.5
    expect(res.cards.map((c) => [c.ref.node.id, c.full]).sort()).toEqual([[rule, true], [cap, false]].sort());
    expect(res.text).toContain(`[m:${cap}] Database migration files are numbered sequentially`);
    expect(res.text).toContain("rule MUST");
    // inject_any below 0.5 → nothing, whatever the per-card answers say
    w.decision.on("proactive.gate", (_e, qs) => Object.fromEntries(qs.map((q) => [q.name, q.name === "inject_any" ? 0.4 : 0.99])));
    expect((await r.proactive(purpose)).cards).toEqual([]);
    // emulated answers need 0.7
    w.decision.isCalibrated = false;
    w.decision.on("proactive.gate", (_e, qs) => Object.fromEntries(qs.map((q) => [q.name, q.name === "inject_any" ? 0.9 : 0.65])));
    expect((await r.proactive(purpose)).cards).toEqual([]);
    void passive;
    w.close();
  });
});

describe("thorough search (§6.4.4)", () => {
  it("plans, constructs cards with verified quotes, and refines on gaps", async () => {
    const w = world({ cwd: initRepo() });
    const [m1, m2] = await seed(w, [
      { text: "The payments service retries Stripe calls three times with exponential backoff starting at 200 ms." },
      { text: "Stripe webhooks are verified with the signing secret in STRIPE_WEBHOOK_SECRET." },
      { text: "Duplicate charge protection derives a key from the order id." },
    ]);
    w.turns!.addRaw({ session: "sess-test", harness: "pi", entryId: "e1", at: "2026-11-19T00:00:00.000Z", text: "We changed the backoff ceiling to 5 seconds after the outage.", role: "assistant", seq: 1 });
    w.aux.on("qemem.planner", () => ({ need: "retry policy", answer_type: "fact", aggregate: false, temporal: false, queries: ["Stripe retries backoff", "payments service retry count"] }));
    let round = 0;
    w.aux.on("qemem.constructor", (task) => {
      const sources = task.data.find((d) => d.label === "SOURCES")!.text;
      round++;
      if (round === 1) {
        expect(sources).toContain(`[m:${m1}]`);
        return {
          cards: [
            { claim: "Stripe calls are retried three times.", role: "answer_candidate", sources: [`m:${m1}`], quote: "retries Stripe calls three times" },
            { claim: "Made-up claim.", role: "inference_support", sources: ["m:zzzzzzzz"], quote: "this quote is nowhere" },
          ],
          sufficient: false,
          missing: ["how idempotency is handled"],
          gapQueries: ["duplicate charge protection key order id"],
        };
      }
      expect(sources).not.toContain(`[m:${m1}]`); // already seen candidates are excluded
      return { cards: [{ claim: "Idempotency keys come from the order id.", role: "intermediate_fact", sources: [], quote: "derives a key from the order id" }], sufficient: true, missing: [], gapQueries: [] };
    });
    const t = new ThoroughSearch(w, new Retriever(w));
    const res = await t.run("How does the payments service retry Stripe calls?", { memory: true, turns: true, budgetTokens: 3000 });
    expect(res.rounds).toBe(1);
    expect(res.sufficient).toBe(true);
    expect(res.cards.map((c) => c.role)).toEqual(["answer_candidate", "intermediate_fact", "inference_support"]); // evidence first
    expect(res.cards[0]).toMatchObject({ verified: true, sources: [`m:${m1}`] });
    expect(res.cards[2]).toMatchObject({ verified: false, sources: [] }); // unknown source dropped, quote flagged not dropped
    expect(renderViewCard(res.cards[2]!)).toContain("⚠ quote unverified");
    expect(renderViewCard(res.cards[0]!)).toBe(`(answer candidate) Stripe calls are retried three times. [m:${m1}]\n  "retries Stripe calls three times"`);
    expect(w.aux.roles()).toEqual(["qemem.planner", "qemem.constructor", "qemem.constructor"]);
    // refinement stops after the configured rounds even if never sufficient
    round = -10;
    const w2cfg = w.cfg.memory.search.refineRounds;
    expect(w2cfg).toBe(2);
    // without the aux LLM, thorough mode degrades to the retrieved evidence
    w.aux.isAvailable = false;
    const degraded = await t.run("Stripe webhooks", { memory: true, turns: false, budgetTokens: 3000 });
    expect(degraded.degraded).toBe(true);
    expect(degraded.memoryHits.map((h) => h.ref.node.id)).toContain(m2);
    w.close();
  });
});

describe("calibration (§9.2.4)", () => {
  it("fits the lowest threshold that reaches the precision target, with weights", () => {
    const items = [
      { score: 0.95, positive: true },
      { score: 0.9, positive: true },
      { score: 0.85, positive: true },
      { score: 0.8, positive: false },
      { score: 0.7, positive: true },
      { score: 0.6, positive: false },
    ];
    expect(fitThreshold(items, 1.0)).toBe(0.85);
    expect(fitThreshold(items, 0.75)).toBe(0.7); // 4 of 5 at ≥ 0.7
    expect(fitThreshold(items, 0.75, 5)).toBeNull();
    // a sampled below-threshold negative weighs 20×
    expect(fitThreshold([...items.slice(0, 3), { score: 0.8, positive: false, w: 20 }, items[4]!], 0.75)).toBe(0.85);
  });

  it("calibrates a late-interaction model reproducibly and maps scores onto the dense scale", async () => {
    const mk = () => new Similarity({ cfg: testConfig(), layout: null, late: new FakeLate(), dense: null });
    const a = mk();
    expect(a.thresholdMode()).toBe("lexical"); // not calibrated yet: late thresholds are not trusted
    expect(a.needsCalibration()).toBe(true);
    expect((await a.calibrate()).ok).toBe(true);
    const b = mk();
    await b.calibrate();
    const ta = a.calibration("late")!.thresholds;
    expect(ta).toEqual(b.calibration("late")!.thresholds);
    expect(a.thresholdMode()).toBe("late");
    // ordering of the thresholds is preserved on the model's own scale
    expect(ta.dedup).toBeGreaterThanOrEqual(ta.intentDuplicate);
    expect(ta.intentDuplicate).toBeGreaterThanOrEqual(ta.analogous);
    expect(ta.analogous).toBeGreaterThanOrEqual(ta.floor);
    expect(ta.dedup).not.toBe(0.92); // MaxSim lives on another scale than cosine
    expect(a.toUnit(ta.floor)).toBeCloseTo(0.75);
    expect(a.toUnit(ta.dedup)).toBeCloseTo(0.92);
    expect(a.toUnit(1)).toBe(1);
    expect(a.toUnit(0)).toBe(0);
    expect(a.calibration("late")!.samples.dedup).toBe(360);
  });

  it("persists calibration per model and learns from use within the step limit", async () => {
    const w = world({ cwd: initRepo(), embeddings: "dense", cfg: { memory: { similarity: { learn: { refitEvery: 40, maxStep: 0.05 } } } } });
    expect(w.sim.threshold("dedup")).toBe(0.92); // dense starts from the documented values
    // verdicts say pairs above 0.80 are all true duplicates: the threshold may come down, but only by 0.05
    for (let i = 0; i < 40; i++) w.sim.logPair("dedup", 0.8 + (i % 20) / 100, true);
    expect(w.sim.threshold("dedup")).toBeCloseTo(0.87);
    expect(w.sim.calibration("dense")!.source).toBe("learned");
    const again = w.reopen();
    expect(again.sim.threshold("dedup")).toBeCloseTo(0.87);
    expect(again.sim.status()[0]).toMatchObject({ kind: "dense", model: "fake-dense", source: "learned" });
    again.close();
  });
});
