import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { MemoryNode } from "../src/core/types.ts";
import { Evolution, FEATURE_DIM, NON_COMMIT_U, QueryCache, QueryCaches } from "../src/memory/evolution.ts";
import { Lifecycle } from "../src/memory/lifecycle.ts";
import { type Action, type Attempt, efficacy, EvolutionLog, Mlp, Policy, sampleFromDist, softmax } from "../src/memory/policy.ts";
import { Retriever } from "../src/memory/retrieve.ts";
import { strengthAt } from "../src/memory/strength.ts";
import { MemoryWriter } from "../src/memory/write.ts";
import { DAY, world, type World } from "./helpers/fakes.ts";
import { cleanupTmp, initRepo, node, rng, tmp } from "./helpers/fixtures.ts";

afterAll(cleanupTmp);

function put(w: World, over: Partial<MemoryNode> & { id: string }, scope: "personal" | "shared" = "personal"): MemoryNode {
  const created = over.createdAt ?? new Date(w.now.t - 5 * DAY).toISOString();
  w.graph.sd(scope).insertNode(node({ createdAt: created, lastAccessAt: created, strength: { base: { v: 0.6, t: created }, events: [] }, ...over }));
  return w.graph.sd(scope).getNode(over.id)!;
}

function evo(w: World, opts: { policy?: Policy | null; random?: () => number } = {}): Evolution {
  const retriever = new Retriever(w);
  const writer = new MemoryWriter(w);
  const lifecycle = new Lifecycle(w);
  const caches = new QueryCaches(w.layout.globalDir, w.graph.project.projectKey ? w.layout.projectDir(w.graph.project.projectKey) : null);
  return new Evolution(w, { retriever, writer, lifecycle, caches, log: new EvolutionLog(w.layout.evolutionDir), policy: opts.policy ?? null, random: opts.random ?? rng(5) });
}

const yes = (_e: unknown, qs: Array<{ name: string }>) => Object.fromEntries(qs.map((q) => [q.name, 0.9]));
const no = (_e: unknown, qs: Array<{ name: string }>) => Object.fromEntries(qs.map((q) => [q.name, 0.1]));
const act = (over: Partial<Action>): Action => ({ operator: "abstract", candidate: 0, k: 2, p: 0, m: 2, dimension: "categorical", frame: "temporal_to_causal", ...over });

function link(w: World, a: string, rel: Parameters<World["graph"]["link"]>[1], b: string, weight = 0.8): void {
  const sd = w.graph.sd("personal");
  w.graph.link({ scope: "personal", node: sd.getNode(a)! }, rel, { scope: "personal", node: sd.getNode(b)! }, { w: weight });
}

function cluster(w: World): void {
  put(w, { id: "episode1", kind: "episode", text: "Debugged the flaky checkout test for an hour." });
  put(w, { id: "fact0001", text: "The checkout test flakes when navigation is not awaited.", counters: { ...node({ id: "x" }).counters, used: 2 } });
  put(w, { id: "fact0002", text: "The cart test flakes when the network mock resolves late.", layer: "long" });
  put(w, { id: "fact0003", text: "The login test flakes when the session cookie races the redirect.", layer: "long" });
  link(w, "fact0001", "derived-from", "episode1");
  link(w, "fact0002", "derived-from", "episode1");
  link(w, "fact0003", "derived-from", "episode1");
  w.graph.commit("personal");
  w.graph.syncIndexes();
}

describe("query cache and fitness (§6.6.4–§6.6.5)", () => {
  it("keeps the last 200 unique queries per scope, first in first out, on disk", () => {
    const file = join(tmp(), "querycache.jsonl");
    const qc = new QueryCache(file, 3);
    for (const q of ["a", "b", "a", "c", "d"]) qc.add(q, "personal");
    qc.add("shared one", "shared");
    expect(qc.for("personal")).toEqual(["b", "c", "d"]);
    expect(new QueryCache(file, 3).for("personal")).toEqual(["b", "c", "d"]);
    expect(new QueryCache(file, 3).for("shared")).toEqual(["shared one"]);
  });

  it("scores Q as mean top-3 activation over queries that activate something", async () => {
    const w = world({ cwd: initRepo() });
    cluster(w);
    const e = evo(w);
    expect((await e.quality("personal")).Q).toBe(0); // empty cache
    e.caches.record("navigation awaited", ["personal"]);
    e.caches.record("nothing matches zzzqqq", ["personal"]);
    const q = await e.quality("personal");
    // seed fact0001 = 1; episode1 one hop away = 0.8·0.5; facts 2 and 3 two hops away = 0.16
    expect(q.Q).toBeCloseTo((1 + 0.4 + 0.16) / 3, 6);
    expect(q.hitRate).toBe(0.5);
    const st = e.stats("personal");
    expect(st).toMatchObject({ nodes: 4, edges: 3, short: 2, long: 2, components: 1 });
    expect(st.crossLayerShare).toBeCloseTo(2 / 3);
    expect(e.cost(st)).toBeCloseTo(4 / 1000 + 1.0 * (3 / 12) + 0.1 * st.meanPathLength);
    expect(e.features("personal", st, q, e.candidates("personal"), []).length).toBe(FEATURE_DIM);
    w.close();
  });

  it("computes strategic efficacy from regret, prediction error and diversity", () => {
    const mk = (operator: Action["operator"], U: number, Uhat: number): Attempt => ({ at: "", scope: "personal", s: [], a: act({ operator }), actor: "rules", U, Uhat, committed: true });
    const window = [mk("abstract", 0.2, 0.1), mk("abstract", 0.0, 0.1), mk("bridge", -0.05, 0.0), mk("bridge", -0.05, 0.05)];
    const regret = (Math.max(0, 0.1 - 0.2) + (0.1 - 0.0) + (0.1 + 0.05) + (0.1 + 0.05)) / 4;
    const predErr = (0.1 + 0.1 + 0.05 + 0.1) / 4;
    expect(efficacy(window, { gamma: 1, delta: 0.5, eta: 0.1 })).toBeCloseTo(-regret - 0.5 * predErr + 0.1 * Math.log(2), 10);
  });
});

describe("strategy operators (§6.6.2)", () => {
  it("Abstract creates a concept with generalizes edges, placed by the layer rule; p archives redundant members", async () => {
    const w = world({ cwd: initRepo() });
    cluster(w);
    const e = evo(w);
    e.caches.record("why do tests flake", ["personal"]);
    w.decision.fallback = yes;
    w.aux.on("evo.operator", (task) => ({ kind: "concept", title: "UI tests flake on unawaited async work", text: "UI tests flake when asynchronous work (navigation, network, cookies) is not awaited before asserting.", redundant: [task.data[1]!.label.split(" ")[1], "nonexistent"] }));
    const cands = e.candidates("personal");
    expect(cands.abstract.map((c) => c.seed.id)).toContain("episode1");
    const a = await e.attempt("personal", { round: 0, used: { abstract: 0, refine: 0, bridge: 0, reframe: 0 }, recent: [] });
    expect(a).toMatchObject({ actor: "rules", committed: true });
    expect(a!.a.operator).toBe("abstract");
    const concept = w.graph.active(["personal"]).find((r) => r.node.kind === "concept")!;
    expect(concept.node).toMatchObject({ origin: "operator", layer: "long" }); // total attributed use of members ≥ 3? no: 2 — but half the members are long-term
    const members = w.graph.neighbors(concept, { rels: ["generalizes"] }).map((n) => n.other.node.id).sort();
    expect(members.length).toBeGreaterThanOrEqual(3);
    expect(a!.U).not.toBe(NON_COMMIT_U);
    // p = 0.5: redundant members are archived as children of the concept, not deleted
    const w2 = world({ cwd: initRepo() });
    cluster(w2);
    const e2 = evo(w2);
    w2.decision.fallback = yes;
    w2.aux.on("evo.operator", () => ({ kind: "concept", title: "Flaky UI tests", text: "UI tests flake on unawaited async work.", redundant: ["fact0002", "fact0003", "fact0001"] }));
    const c2 = e2.candidates("personal");
    const idx = c2.abstract.findIndex((c) => c.seed.id === "episode1");
    const res = await (e2 as any).abstract("personal", c2.abstract[idx], act({ p: 0.5, k: 2 }));
    expect(res.committed).toBe(true);
    const archived = w2.graph.all(["personal"]).filter((r) => r.node.status === "archived");
    expect(archived.length).toBe(2); // at most half of the four members
    expect(archived[0]!.node.statusReason).toMatch(/^abstracted into m:/);
    w.close();
    w2.close();
  });

  it("vetoes an edit that fails the semantic check and scores it as a non-commit", async () => {
    const w = world({ cwd: initRepo() });
    cluster(w);
    const e = evo(w);
    w.decision.on("evo.check", no);
    w.aux.on("evo.operator", () => ({ kind: "concept", title: "Wrong", text: "All tests are slow because of Docker." }));
    const before = w.graph.active(["personal"]).length;
    const a = await e.attempt("personal", { round: 0, used: { abstract: 0, refine: 0, bridge: 0, reframe: 0 }, recent: [] });
    expect(a).toMatchObject({ committed: false, vetoed: true, U: NON_COMMIT_U });
    expect(w.graph.active(["personal"]).length).toBe(before);
    // fail-safe without a decision model: veto
    w.decision.isAvailable = false;
    const b = await e.attempt("personal", { round: 0, used: { abstract: 0, refine: 0, bridge: 0, reframe: 0 }, recent: [] });
    expect(b).toMatchObject({ committed: false, vetoed: true });
    expect(new EvolutionLog(w.layout.evolutionDir).attempts().length).toBe(2);
    w.close();
  });

  it("Refine splits a hub into children along a dimension and maps past uses to layers", async () => {
    const w = world({ cwd: initRepo() });
    const hubText = "Deploying the API: first build the image, then run the migrations, then roll the pods; if the migration fails, roll back the image and page the on-call engineer.";
    put(w, { id: "hub00001", kind: "procedure", layer: "long", text: hubText, counters: { ...node({ id: "x" }).counters, used: 3 } });
    put(w, { id: "leaf0001", text: "Image builds take six minutes." });
    put(w, { id: "leaf0002", text: "Migrations are in packages/api/migrations." });
    put(w, { id: "leaf0003", text: "The on-call rota is in PagerDuty." });
    for (const leaf of ["leaf0001", "leaf0002", "leaf0003"]) link(w, leaf, "part-of", "hub00001", 0.9);
    w.graph.commit("personal");
    w.graph.syncIndexes();
    const e = evo(w);
    e.caches.record("how to deploying the API build image migrations", ["personal"]);
    const c = e.candidates("personal");
    expect(c.refine).toEqual([]); // already has part-of children: not refined again
    // remove the structural marker and try again
    for (const edge of w.graph.sd("personal").allEdges()) w.graph.sd("personal").patchEdge(edge.id, { rel: "analogous-to" });
    const c2 = e.candidates("personal");
    expect(c2.refine[0]!.hub.id).toBe("hub00001");
    w.aux.on("evo.operator", () => ({ children: [{ title: "Build the image", text: "Deploying the API starts by building the image." }, { title: "Run the migrations", text: "After the build, run the migrations; if they fail, roll back the image and page the on-call engineer." }, { title: "Roll the pods", text: "Finally roll the pods." }] }));
    w.decision.on("evo.check", yes);
    w.decision.on("evo.refine_map", (_e, qs) => Object.fromEntries(qs.map((q) => [q.name, { child1: 0.8, child0: 0.1 }])));
    const res = await (e as any).refine("personal", c2.refine[0], act({ operator: "refine", m: 3, dimension: "temporal" }));
    expect(res).toMatchObject({ committed: true });
    const sd = w.graph.sd("personal");
    const kids = sd.allEdges().filter((x) => x.rel === "part-of" && x.dst === "hub00001").map((x) => sd.getNode(x.src)!);
    expect(kids.length).toBe(3);
    expect(sd.allEdges().filter((x) => x.rel === "precedes").length).toBe(2); // temporal: an ordered chain
    // the child that covers a past use inherits the parent's layer; the others go short-term
    expect(kids.map((k) => [k.title, k.layer]).sort()).toEqual([["Build the image", "short"], ["Roll the pods", "short"], ["Run the migrations", "long"]]);
    expect(sd.getNode("hub00001")!.status).toBe("active"); // kept as a summary: it has attributed use
    w.close();
  });

  it("Bridge links related, unconnected memories with a typed, checked edge", async () => {
    const w = world({ cwd: initRepo(), embeddings: "dense" });
    put(w, { id: "bridge0a", text: "The payments worker retries failed Stripe charges with backoff." });
    put(w, { id: "bridge0b", text: "The payments worker retries failed Stripe refunds with backoff." });
    put(w, { id: "bridge0c", text: "Office plants need watering on Mondays." });
    w.graph.commit("personal");
    w.graph.syncIndexes();
    await w.sim.embedNodes(w.graph);
    const e = evo(w);
    const c = e.candidates("personal");
    expect(c.bridge.length).toBe(1);
    expect([c.bridge[0]!.a.id, c.bridge[0]!.b.id].sort()).toEqual(["bridge0a", "bridge0b"]);
    w.aux.on("evo.operator", () => ({ rel: "analogous-to", direction: "a_to_b" }));
    w.decision.on("evo.check", yes);
    const res = await (e as any).bridge("personal", c.bridge[0], act({ operator: "bridge" }));
    expect(res.committed).toBe(true);
    expect(w.graph.sd("personal").allEdges().map((x) => x.rel)).toEqual(["analogous-to"]);
    expect(e.candidates("personal").bridge).toEqual([]); // now adjacent
    w.close();
  });

  it("Reframe rewrites edge types along a path without touching nodes", async () => {
    const w = world({ cwd: initRepo() });
    put(w, { id: "step0001", text: "The cache was disabled." });
    put(w, { id: "step0002", text: "Latency tripled." });
    put(w, { id: "step0003", text: "The autoscaler added pods." });
    link(w, "step0001", "precedes", "step0002");
    link(w, "step0002", "precedes", "step0003");
    w.graph.commit("personal");
    const e = evo(w);
    const c = e.candidates("personal");
    expect(c.reframe[0]!.path.map((n) => n.id)).toEqual(["step0001", "step0002", "step0003"]);
    w.decision.on("evo.check", yes);
    const nodesBefore = w.graph.sd("personal").nodeCount();
    expect((await (e as any).reframe("personal", c.reframe[0], act({ operator: "reframe", frame: "causal_to_temporal" }))).committed).toBe(false); // no causes edges to rewrite
    expect((await (e as any).reframe("personal", c.reframe[0], act({ operator: "reframe", frame: "temporal_to_causal" }))).committed).toBe(true);
    expect(w.graph.sd("personal").allEdges().map((x) => `${x.src} ${x.rel} ${x.dst}`).sort()).toEqual(["step0001 causes step0002", "step0002 causes step0003"]);
    const c2 = e.candidates("personal");
    await (e as any).reframe("personal", c2.reframe[0], act({ operator: "reframe", frame: "effect_cause" }));
    expect(w.graph.sd("personal").allEdges().map((x) => `${x.src} ${x.rel} ${x.dst}`).sort()).toEqual(["step0002 causes step0001", "step0003 causes step0002"]);
    expect(w.graph.sd("personal").nodeCount()).toBe(nodesBefore);
    w.close();
  });
});

describe("fusion (§6.6.1)", () => {
  it("merges a cluster of near-duplicates when the merge preserves every fact", async () => {
    const w = world({ cwd: initRepo(), embeddings: "dense" });
    const created = (d: number) => new Date(w.now.t - d * DAY).toISOString();
    put(w, { id: "dup00001", text: "The staging database lives on host db-staging port 5433.", createdAt: created(6), strength: { base: { v: 0.9, t: new Date(w.now.t).toISOString() }, events: [] }, counters: { ...node({ id: "x" }).counters, used: 2, usedSuccess: 2 } });
    put(w, { id: "dup00002", text: "The staging database lives on host db-staging port 5433 today.", createdAt: created(5), strength: { base: { v: 0.5, t: new Date(w.now.t).toISOString() }, events: [] } });
    put(w, { id: "dup00003", text: "The staging database lives on host db-staging port 5433 now.", createdAt: created(4), strength: { base: { v: 0.7, t: new Date(w.now.t).toISOString() }, events: [] } });
    put(w, { id: "tooold01", text: "The staging database lives on host db-staging port 5433 always.", createdAt: created(40) }); // outside the 7-day window
    put(w, { id: "other001", text: "Completely different topic about fonts." });
    w.graph.commit("personal");
    w.graph.syncIndexes();
    await w.sim.embedNodes(w.graph);
    const e = evo(w);
    w.aux.on("write.merge", () => ({ title: "Staging database host and port", text: "The staging database lives on host db-staging, port 5433." }));
    // preservation below 0.8 rejects the fusion
    w.decision.on("evo.fusion", () => ({ preserves: 0.7 }));
    expect(await e.fusion("personal")).toMatchObject({ clusters: 1, fused: [], rejected: 1 });
    expect(w.graph.active(["personal"]).length).toBe(5);
    w.decision.on("evo.fusion", () => ({ preserves: 0.95 }));
    const report = await e.fusion("personal");
    expect(report.fused.length).toBe(1);
    const fused = w.graph.get(report.fused[0]!)!.node;
    // fused strength: max + 0.5·variance; fused decay: λ_base / (1 + log|C|)
    const vs = [0.9, 0.5, 0.7];
    const variance = vs.reduce((s, v) => s + (v - 0.7) ** 2, 0) / 3;
    expect(strengthAt(fused, w.clock())).toBeCloseTo(0.9 + 0.5 * variance, 6);
    expect(fused.decayDivisor).toBeCloseTo(1 + Math.log(3));
    expect(fused.counters.used).toBe(2); // use history moves with the members
    for (const id of ["dup00001", "dup00002", "dup00003"]) expect(w.graph.get(id)!.node).toMatchObject({ status: "archived", statusReason: `fused into m:${fused.id}` });
    expect(w.graph.get("tooold01")!.node.status).toBe("active");
    expect(w.graph.sd("personal").allEdges().filter((x) => x.rel === "part-of" && x.dst === fused.id).length).toBe(3);
    // verdicts feed threshold calibration
    expect(w.sim.calibration("dense")!.pairs.filter((p) => p.name === "fusion").map((p) => p.ok)).toEqual([false, true]);
    w.close();
  });
});

describe("policy (§6.6.3, §6.6.6)", () => {
  it("lets the teacher act from its full distribution and falls back to the rule schedule", async () => {
    const w = world({ cwd: initRepo() });
    cluster(w);
    put(w, { id: "step0001", text: "The cache was disabled." });
    put(w, { id: "step0002", text: "Latency tripled." });
    link(w, "step0001", "precedes", "step0002");
    w.graph.commit("personal");
    w.graph.syncIndexes();
    const e = evo(w);
    let asked: string[] = [];
    w.decision.on("evo.teacher", (_ev, qs) => {
      asked = qs.map((q) => q.name);
      return { operator: { reframe: 0.97, abstract: 0.03 }, "cand.reframe": { c0: 1 }, "cand.abstract": { c0: 1 }, k: { "1": 1 }, p: { "0": 1 }, m: { "2": 1 }, dimension: { causal: 1 }, frame: { temporal_to_causal: 1 } };
    });
    w.decision.on("evo.check", yes);
    const a = await e.attempt("personal", { round: 0, used: { abstract: 0, refine: 0, bridge: 0, reframe: 0 }, recent: [] });
    expect(asked).toEqual(["operator", "cand.abstract", "cand.bridge", "cand.reframe", "k", "p", "m", "dimension", "frame"]); // refine has no candidate: it is masked out
    expect(a).toMatchObject({ actor: "teacher", committed: true });
    expect(a!.a).toMatchObject({ operator: "reframe", frame: "temporal_to_causal", dimension: "causal" });
    expect(a!.teacher!.operator).toEqual([0.03, 0, 0, 0.97]);
    expect(a!.s.length).toBe(FEATURE_DIM);
    // an emulated (uncalibrated) decision model is not a teacher: the rule schedule takes over
    w.decision.isCalibrated = false;
    w.aux.on("evo.operator", () => ({ kind: "concept", title: "t", text: "Tests flake on unawaited async work." }));
    const b = await e.attempt("personal", { round: 0, used: { abstract: 0, refine: 0, bridge: 0, reframe: 0 }, recent: [] });
    expect(b!.actor).toBe("rules");
    w.close();
  });

  it("runs hygiene, then attempts; shared scope at most once a day; propose mode commits nothing", async () => {
    const repo = initRepo();
    const w = world({ cwd: repo, cfg: { evolution: { attemptsPerPass: 3 } } });
    for (const scope of ["personal", "shared"] as const) {
      put(w, { id: `step000${scope === "shared" ? 3 : 1}`, text: "The cache was disabled." }, scope);
      put(w, { id: `step000${scope === "shared" ? 4 : 2}`, text: "Latency tripled." }, scope);
      const sd = w.graph.sd(scope);
      const ids = sd.allNodes().map((n) => n.id).sort();
      w.graph.link({ scope, node: sd.getNode(ids[0]!)! }, "precedes", { scope, node: sd.getNode(ids[1]!)! }, { w: 0.8 });
      w.graph.commit(scope);
    }
    w.decision.isCalibrated = false; // rule schedule
    w.decision.fallback = yes;
    const e = evo(w);
    const p = await e.pass("personal");
    expect(p.hygiene!.scope).toBe("personal");
    expect(p.attempts.map((a) => [a.a.operator, a.committed])).toEqual([["reframe", true]]); // one candidate, used once
    const s1 = await e.pass("shared");
    expect(s1.attempts.length).toBe(1);
    put(w, { id: "step0005", text: "Pods were added." }, "shared");
    const sd = w.graph.sd("shared");
    w.graph.link({ scope: "shared", node: sd.getNode("step0004")! }, "precedes", { scope: "shared", node: sd.getNode("step0005")! });
    w.graph.commit("shared");
    expect((await e.pass("shared")).attempts).toEqual([]); // second strategy pass the same day
    w.now.t += DAY + 1000;
    const w2cfg = w.cfg.evolution;
    w2cfg.sharedStrategy = "propose";
    const edgesBefore = sd.allEdges().map((x) => x.rel).sort();
    const s3 = await e.pass("shared");
    expect(s3.attempts[0]).toMatchObject({ committed: false, U: NON_COMMIT_U });
    expect(sd.allEdges().map((x) => x.rel).sort()).toEqual(edgesBefore);
    expect(e.log.proposals().length).toBeGreaterThan(0);
    w2cfg.sharedStrategy = "off";
    w.now.t += DAY + 1000;
    expect((await e.pass("shared")).attempts).toEqual([]);
    // an aborted pass stops cleanly
    const ac = new AbortController();
    ac.abort();
    expect((await e.pass("personal", { signal: ac.signal, hygiene: false })).stopped).toBe("aborted");
    w.close();
  });

  it("trains the MLP toward the teacher in T0 and moves through the phases", () => {
    const rand = rng(3);
    const policy = new Policy(null, 6, rand);
    const masks = { operators: [true, true, true, true], candidates: { abstract: 3, refine: 2, bridge: 2, reframe: 1 } };
    const s = [1, 0, 0.5, 0.2, 0, 1];
    const teacher = { operator: [0.05, 0.05, 0.85, 0.05], candidate: { bridge: [0.1, 0.9] }, heads: { k: [0, 0, 1], frame: [0, 1, 0] } };
    const before = policy.dist(s, masks);
    expect(before.operator.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(before.candidate.reframe).toEqual([1, 0, 0, 0, 0, 0, 0, 0]); // masked candidates get no probability
    const hyper = { K: 16, N: 8, gamma: 1, delta: 0.5, eta: 0.1 };
    const window: Attempt[] = [];
    for (let i = 0; i < 400; i++) {
      const a = sampleFromDist(teacher, masks, rand)!;
      const attempt: Attempt = { at: "", scope: "personal", s, a, actor: "teacher", teacher, U: a.operator === "bridge" ? 0.2 : -0.05, Uhat: policy.predict(s, a), committed: true };
      policy.record(attempt, masks, hyper, window);
      window.push(attempt);
      if (i === 250) expect(policy.state.phase).toBe("T0");
    }
    const after = policy.dist(s, masks);
    expect(after.operator[2]).toBeGreaterThan(0.6); // imitation: cross-entropy to the teacher's probabilities
    expect(after.operator[2]).toBeGreaterThan(before.operator[2]!);
    expect(after.candidate.bridge[1]).toBeGreaterThan(0.7);
    expect(after.heads.k[2]).toBeGreaterThan(0.7);
    expect(policy.state.phase).toBe("T1"); // 300 logged attempts end T0
    // the utility predictor learned which action pays
    expect(policy.predict(s, act({ operator: "bridge", candidate: 1, k: 3, frame: "causal_to_temporal" }))).toBeGreaterThan(policy.predict(s, act({ operator: "abstract" })));
    // T1: randomized A/B split, plus the safety fallback when the policy is undecided
    const turns = Array.from({ length: 400 }, () => policy.teacherTurn(0.1, Math.log(4)));
    const share = turns.filter((t) => t.teacher).length / turns.length;
    expect(share).toBeGreaterThan(0.12);
    expect(share).toBeLessThan(0.28);
    expect(policy.teacherTurn(Math.log(4) * 0.95, Math.log(4))).toEqual({ teacher: true, ab: false, fallback: true });
    // graduation: over randomized A/B decisions the MLP beats the teacher with separated intervals
    const ab = (actor: "mlp" | "teacher", U: number): Attempt => ({ at: "", scope: "personal", s, a: act({ operator: "bridge" }), actor, ab: true, U, Uhat: U, committed: true });
    const w2: Attempt[] = [];
    for (let i = 0; i < 200; i++) w2.push(i % 2 ? ab("mlp", 0.3 + (i % 5) * 0.01) : ab("teacher", 0.1 + (i % 5) * 0.01));
    for (let i = 0; i < 8; i++) policy.record(ab("mlp", 0.3), masks, hyper, w2);
    expect(policy.state.phase).toBe("T2");
    // and back to T1 if the MLP's mean U drops below the teacher's
    const w3: Attempt[] = [];
    for (let i = 0; i < 200; i++) w3.push(i % 2 ? ab("mlp", 0.0) : ab("teacher", 0.2));
    for (let i = 0; i < 8; i++) policy.record(ab("mlp", 0.0), masks, hyper, w3);
    expect(policy.state.phase).toBe("T1");
  });

  it("has a working MLP and softmax", () => {
    const net = new Mlp({ inDim: 2, hidden: 16, outDim: 1, seed: 1 }, 0.02);
    const data = [[0, 0, 0], [0, 1, 1], [1, 0, 1], [1, 1, 0]];
    for (let epoch = 0; epoch < 3000; epoch++) net.step(data.map(([a, b, y]) => ({ x: [a!, b!], dOut: [2 * (net.forward([a!, b!]).out[0]! - y!)] })));
    for (const [a, b, y] of data) expect(net.forward([a!, b!]).out[0]).toBeCloseTo(y!, 0);
    expect(softmax([1, 2, 3], [true, false, true])[1]).toBe(0);
    expect(softmax([0, 0]).map((x) => x.toFixed(2))).toEqual(["0.50", "0.50"]);
  });
});
