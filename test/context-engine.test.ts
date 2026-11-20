import { afterAll, describe, expect, it } from "vitest";
import { BlobStore, guardToolResult, paginate, pickPage, reachableEntries, renderLayer } from "../src/context/archive.ts";
import { planReplace } from "../src/context/consolidate.ts";
import { GUIDANCE_TYPE } from "../src/context/render.ts";
import { alignToUnits, toUnits, workingTail } from "../src/context/rounds.ts";
import { SessionState } from "../src/context/state.ts";
import type { AuxTask, ConsolidationRecord, EntryView } from "../src/core/types.ts";
import { MemoryRuntime } from "../src/memory/runtime.ts";
import { MemoryWriter } from "../src/memory/write.ts";
import { estimateTokens } from "../src/util/text.ts";
import { type Answers, FakeAux, FakeDecision, world, type World } from "./helpers/fakes.ts";
import { cleanupTmp, commitAll, initRepo, testConfig, tmp, write } from "./helpers/fixtures.ts";
import { filler, Session } from "./helpers/harness.ts";

afterAll(cleanupTmp);

const cfg = (over: Record<string, unknown> = {}) => testConfig({ context: { maxWindow: 32000, ...over }, janus: { lateWaitMs: 30 } });

/** A Janus that follows a script of focus moves and closures by label. */
function director(decision: FakeDecision, aux: FakeAux) {
  const plan: Array<{ kindle?: string; close?: string[]; focus?: string; redirect?: number; outcome?: string }> = [];
  let pendingLabel = "";
  decision.on("janus", (ev, qs) => {
    const step = plan.shift() ?? {};
    const out: Answers = {};
    for (const q of qs) {
      if (q.name.startsWith("close.")) {
        const label = /"([^"]+)"/.exec(q.instructions)?.[1] ?? "";
        out[q.name] = step.close?.includes(label) ? { open: 0.05, [step.outcome ?? "success"]: 0.9 } : { open: 0.95 };
      }
    }
    if (step.kindle) {
      pendingLabel = step.kindle;
      out.focus = { [step.focus ?? (String(ev.intent_stack).startsWith("(no open") ? "new_root" : step.close?.length ? "successor" : "deepen")]: 0.9 };
    } else out.focus = { continue: 0.95 };
    if (step.redirect !== undefined) out.redirect = step.redirect;
    return out;
  });
  aux.on("janus.scribe", () => ({ label: pendingLabel, reason: `because ${pendingLabel}`, success: `${pendingLabel} is done`, failure: `${pendingLabel} cannot be done` }));
  return plan;
}

function consolidators(aux: FakeAux, log: AuxTask[] = []) {
  aux.on("precip", (task) => {
    log.push(task);
    const purpose = task.data.find((d) => d.label === "PURPOSE")!.text.split("\n")[0];
    return { memory: `I worked on ${purpose}. What worked: the direct approach. What went wrong: nothing much.\n> src/a.ts:1 \`const a = 1\` (from: tool read)`, sidecar: { outcome_summary: `Finished ${purpose}`, state_changes: ["edited src/a.ts"], artifacts: ["src/a.ts", "pnpm test"], open_threads: [] } };
  });
  aux.on("palim", (task) => {
    log.push(task);
    const n = log.filter((t) => t.role === "palim").length;
    return { narrative: `Fold ${n}: set up, investigated and fixed things.`, knowledge: [{ evaluation: "good", fact: `Fact ${n}: \`pnpm test --runInBand\` avoids the port clash.`, subject: "tests", as_of: "2026-11-19" }, { evaluation: "bad", fact: `Fact ${n}b: raising the timeout did not help.`, subject: "tests" }] };
  });
  return log;
}

const work = (i: number, words = 900) => [{ name: "bash", args: { command: `run step ${i}` }, output: filler(words, `o${i}_`) }];

async function hiddenReachable(s: Session): Promise<void> {
  // recall round trip (§12.1): every entry hidden by an edit is reachable from some t: ID
  const entries = await s.h.listEntries();
  const reachable = new Set<string>();
  for (const r of s.engine.state.records.values()) for (const id of reachableEntries(r, s.engine.state)) reachable.add(id);
  for (const r of s.engine.state.records.values()) reachable.add(r.anchorId);
  for (const e of entries) if (e.omitted || e.edited) expect(reachable.has(e.id), `entry ${e.id} is hidden but not reachable`).toBe(true);
}

describe("Precip (§5.3)", () => {
  it("consolidates a closed intent asynchronously and commits at the next turn end, anchored on its guidance", async () => {
    const s = new Session({ cfg: cfg() });
    const log = consolidators(s.aux);
    const plan = director(s.decision, s.aux);
    await s.start();
    plan.push({ kindle: "Fix the flaky auth test" });
    await s.user("please fix the flaky auth test");
    plan.push({ kindle: "Find the race in TokenCache" });
    await s.round("first I need to find the race", work(0));
    for (let i = 1; i < 4; i++) {
      plan.push({});
      await s.round(`investigating ${i}`, work(i));
    }
    const child = s.engine.state.stack[1]!;
    // the closure record and guidance commit at once; Precip's aux call runs in the background
    plan.push({ close: ["Find the race in TokenCache"] });
    const b1 = await s.round("found it: two refreshes overlap", work(4));
    const before = await s.h.requestTokens();
    expect(b1.records.some((r) => r.type === "realctx2.intent" && r.intent.status === "success")).toBe(true);
    expect(b1.edits).toEqual([]);
    expect(b1.messages[0]!.content).toBe('[intent] I finished "Find the race in TokenCache": succeeded.\nI\'m back to "Fix the flaky auth test". Done when: Fix the flaky auth test is done');
    await s.drain();
    plan.push({});
    const b2 = await s.round("now fixing", work(5, 50));
    const record = b2.records.find((r) => r.type === "realctx2.consolidation")!.record as ConsolidationRecord;
    expect(record).toMatchObject({ kind: "precip", intentId: child.id, outcome: "success", telos: ["Fix the flaky auth test"], anchorId: child.guidanceEntryId });
    expect(record.id).toMatch(/^t:[0-9a-z]{8}$/);
    // one edit replaces the guidance, the rest omit; all in one batch, so the cache breaks once
    expect(b2.edits[0]).toEqual({ targetId: child.guidanceEntryId, replacement: expect.stringContaining(`[${record.id} · intent "Find the race in TokenCache" · succeeded · details archived]\nI worked on`) });
    expect(b2.edits.slice(1).every((e) => e.replacement === null)).toBe(true);
    expect(b2.edits.length).toBe(record.children.length);
    expect(await s.h.requestTokens()).toBeLessThan(before - 4000); // three rounds of about 1,600 tokens became one short message
    // input contract: the region as projected, the telos chain, the intent and its outcome
    const task = log.find((t) => t.role === "precip")!;
    expect(task.data.map((d) => d.label)).toEqual(["PURPOSE", "ENCLOSING PURPOSES (outermost first)", "WORK TO CONSOLIDATE"]);
    expect(task.data[0]!.text).toContain('"Find the race in TokenCache" — succeeded');
    expect(task.data[2]!.text).toContain("investigating 3");
    // the latest round at closure time was excluded (invariant 3): the closing round is still raw
    const ctx = await s.h.contextText();
    expect(ctx).toContain("found it: two refreshes overlap");
    expect(ctx).not.toContain("investigating 2");
    expect(ctx).toContain('[intent] I\'m now working on "Fix the flaky auth test"'); // the open intent's guidance stays
    await hiddenReachable(s);
    // recall opens one layer: raw entries with r: IDs
    const entries = new Map((await s.h.listEntries()).map((e) => [e.id, e] as [string, EntryView]));
    const layer = renderLayer(record, s.engine.state, entries, "sess-test");
    expect(layer).toMatch(/^\[r:[0-9a-z]{8}\] \[intent\] I'm now working on "Find the race in TokenCache"/);
    expect(layer).toContain("investigating 2");
    expect(layer.match(/\[r:[0-9a-z]{8}\]/g)!.length).toBe(record.children.length);
  });

  it("skips the replacement when the span is small, and consolidates intent-only closures together", async () => {
    const s = new Session({ cfg: cfg() });
    const log = consolidators(s.aux);
    const plan = director(s.decision, s.aux);
    await s.start();
    plan.push({ kindle: "Tidy the README" });
    await s.user("tidy the readme");
    plan.push({});
    await s.round("small edit", work(0, 40));
    plan.push({ close: ["Tidy the README"] });
    await s.round("done", work(1, 40));
    await s.drain();
    plan.push({});
    const b = await s.round("next", work(2, 40));
    // under 1,500 tokens: the closure is recorded, but nothing is replaced and no aux call is spent
    expect(b.edits).toEqual([]);
    expect(log.filter((t) => t.role === "precip")).toEqual([]);
    expect(s.engine.state.records.size).toBe(0);

    // a parent whose region holds only its guidance and the child's span closes together with the child
    const s2 = new Session({ cfg: cfg() });
    const log2 = consolidators(s2.aux);
    const plan2 = director(s2.decision, s2.aux);
    const intent = (id: string, label: string, parentId: string | null) => ({ id, parentId, label, reason: "r", success: "s", failure: "f", guidanceEntryId: "", openedRound: 0, status: "open" as const });
    s2.h.user("do the outer thing, starting with the inner one");
    await s2.h.commit({ records: [{ type: "realctx2.intent", intent: intent("outer001", "Outer purpose", null) }], edits: [], messages: [{ customType: GUIDANCE_TYPE, content: '[intent] I\'m now working on "Outer purpose".', display: true, details: { intentId: "outer001" } }] });
    await s2.h.commit({ records: [{ type: "realctx2.intent", intent: intent("inner001", "Inner purpose", "outer001") }], edits: [], messages: [{ customType: GUIDANCE_TYPE, content: '[intent] I\'m now working on "Inner purpose" (inside: Outer purpose).', display: true, details: { intentId: "inner001" } }] });
    await s2.start();
    expect(s2.engine.state.stack.map((i) => i.label)).toEqual(["Outer purpose", "Inner purpose"]);
    for (let i = 0; i < 4; i++) {
      plan2.push({});
      await s2.round(`inner work ${i}`, work(i));
    }
    plan2.push({ close: ["Inner purpose", "Outer purpose"] });
    await s2.round("all done", work(4, 30));
    await s2.drain();
    plan2.push({});
    const b2 = await s2.round("after", work(5, 30));
    const records = b2.records.filter((r) => r.type === "realctx2.consolidation").map((r) => (r as { record: ConsolidationRecord }).record);
    expect(records.length).toBe(1);
    expect(records[0]).toMatchObject({ kind: "precip", intentId: "outer001" });
    const precips = log2.filter((t) => t.role === "precip");
    expect(precips.length).toBe(1);
    expect(precips[0]!.data[0]!.text).toContain('(closed together with its sub-purpose "Inner purpose")');
    const ctx = await s2.h.contextText();
    expect(ctx).toContain('intent "Outer purpose" · succeeded · details archived]');
    expect(ctx).not.toContain("inner work 2");
    await hiddenReachable(s2);
  });

  it("consolidates nested closures innermost first, so the outer record nests the inner one", async () => {
    const s = new Session({ cfg: cfg() });
    consolidators(s.aux);
    const plan = director(s.decision, s.aux);
    await s.start();
    plan.push({ kindle: "Outer purpose" });
    await s.user("outer");
    plan.push({});
    await s.round("outer work a", work(0));
    plan.push({ kindle: "Inner purpose" });
    await s.round("starting inner", work(1));
    for (let i = 2; i < 5; i++) {
      plan.push({});
      await s.round(`inner work ${i}`, work(i));
    }
    plan.push({ close: ["Inner purpose", "Outer purpose"] });
    await s.round("both done", work(5, 30));
    await s.drain();
    plan.push({});
    const b1 = await s.round("after 1", work(6, 30)); // the inner Precip commits; the outer one starts
    expect(b1.records.filter((r) => r.type === "realctx2.consolidation").map((r) => (r as { record: ConsolidationRecord }).record.intentId)).toEqual([[...s.engine.state.intents.values()].find((i) => i.label === "Inner purpose")!.id]);
    await s.drain();
    plan.push({});
    const b2 = await s.round("after 2", work(7, 30));
    const outer = b2.records.find((r) => r.type === "realctx2.consolidation")!.record as ConsolidationRecord;
    const inner = b1.records.find((r) => r.type === "realctx2.consolidation")!.record as ConsolidationRecord;
    expect(outer.children).toContainEqual({ id: inner.id });
    expect(outer.telos).toEqual([]);
    const ctx = await s.h.contextText();
    expect(ctx).toContain(`[${outer.id} · intent "Outer purpose"`);
    expect(ctx).not.toContain(`[${inner.id} · intent "Inner purpose"`); // re-consolidated: the anchor was edited again
    await hiddenReachable(s);
    // recall descends: the outer layer shows the inner consolidation as text with its own t: ID
    const entries = new Map((await s.h.listEntries()).map((e) => [e.id, e] as [string, EntryView]));
    expect(renderLayer(outer, s.engine.state, entries, "sess-test")).toContain(`[${inner.id} · intent "Inner purpose" · succeeded · details archived]`);
  });

  it("runs Precip for intents closed at settle during idle time, and commits at the next turn end", async () => {
    const s = new Session({ cfg: cfg() });
    const log = consolidators(s.aux);
    const plan = director(s.decision, s.aux);
    await s.start();
    plan.push({ kindle: "Fix the build" });
    await s.user("fix the build");
    for (let i = 0; i < 4; i++) {
      plan.push({});
      await s.round(`build work ${i}`, work(i));
    }
    plan.push({ close: ["Fix the build"] }); // closure-only Janus at settle (the final response made no tool call)
    const settle = await s.finish("The build is green now.");
    expect(settle.messages.at(-1)!.content).toBe('[intent] I finished "Fix the build": succeeded.');
    expect(log.filter((t) => t.role === "precip")).toEqual([]); // the prompt cursor never waits on an aux call
    await s.engine.onIdle();
    expect(log.filter((t) => t.role === "precip").length).toBe(1);
    plan.push({ kindle: "Next task" });
    await s.user("now something else");
    plan.push({});
    const b = await s.round("starting", work(9, 30));
    expect(b.records.some((r) => r.type === "realctx2.consolidation")).toBe(true);
    expect(await s.h.contextText()).toContain('intent "Fix the build" · succeeded · details archived]');
    await hiddenReachable(s);
  });
});

describe("Palim (§5.4)", () => {
  async function twoClosedIntents(s: Session, plan: ReturnType<typeof director>, rounds = 4, words = 1400): Promise<void> {
    for (const [n, label] of ["First task", "Second task"].entries()) {
      plan.push({ kindle: label, focus: "new_root" });
      await s.user(`do ${label}`);
      for (let i = 0; i < rounds; i++) {
        plan.push({});
        await s.round(`${label} step ${i}`, work(n * 10 + i, words));
      }
      plan.push({ close: [label] });
      await s.round(`${label} finished`, work(n * 10 + 9, 30));
      await s.drain();
      plan.push({});
      await s.round(`${label} wrap-up`, work(n * 10 + 8, 30));
    }
  }

  it("folds the root prefix once it holds E_min consolidated messages and T_min tokens, and harvests knowledge", async () => {
    // free cache writes: the cost check passes, so this test is about the size rule
    const s = new Session({ cfg: cfg({ Tmin: 100, deltaMin: 100, climb: { costCheck: false } }) });
    const log = consolidators(s.aux);
    const plan = director(s.decision, s.aux);
    await s.start();
    await twoClosedIntents(s, plan);
    expect(s.engine.state.records.size).toBe(2);
    expect(log.filter((t) => t.role === "palim")).toEqual([]); // T_min is floored at 8,192: two short Precip messages are not enough
    // more material in the root region: once the unfolded part before the working tail passes T_min, it folds
    const palim = () => [...s.engine.state.records.values()].find((r) => r.kind === "palim");
    for (let i = 0; i < 12 && !palim(); i++) {
      plan.push({});
      await s.round(`loose work ${i}`, work(50 + i, 1500));
      await s.drain();
    }
    const fold = palim()!;
    expect(fold).toBeDefined();
    expect(s.h.notices).toEqual([]);
    expect(fold.children.filter((c) => "id" in c).length).toBe(2); // earlier Precip messages are inputs and become children
    const ctx = await s.h.contextText();
    expect(ctx).toContain(`[${fold.id} · consolidated earlier work]\nNarrative: Fold 1: set up, investigated and fixed things.\nKnowledge:\n- [good] Fact 1: \`pnpm test --runInBand\` avoids the port clash. (as of 2026-11-19)\n- [bad] Fact 1b: raising the timeout did not help.`);
    expect(ctx).not.toContain('intent "First task"');
    expect(fold.knowledge!.length).toBe(2);
    // the working tail is never folded: the two latest rounds are still raw
    const rounds = s.h.raw.filter((r) => r.kind === "assistant").map((r) => r.text);
    expect(ctx).toContain(rounds.at(-1)!);
    expect(ctx).toContain(rounds.at(-2)!);
    await hiddenReachable(s);
    const task = log.find((t) => t.role === "palim")!;
    expect(task.data.at(-1)!.text).toContain('intent "First task" · succeeded · details archived]');
  });

  it("skips ordinary folds that do not pay for the cache break, and counts them", async () => {
    const s = new Session({ cfg: cfg() });
    const log = consolidators(s.aux);
    const plan = director(s.decision, s.aux);
    s.h.price = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
    s.h.systemTokens = 500; // stay under climb.fastOccupancy, where every ordinary fold must pay for itself
    await s.start();
    await twoClosedIntents(s, plan, 3, 600);
    for (let i = 0; i < 7; i++) {
      plan.push({});
      await s.round(`loose work ${i}`, work(50 + i, 880));
    }
    await s.drain();
    expect(s.engine.status().occupancy).toBeLessThan(16000);
    // warm cache: Δ̂·p_read·R̂ = 0.65·span·0.1·20 = 1.3·span never covers re-caching the suffix plus the aux call
    expect(log.filter((t) => t.role === "palim")).toEqual([]);
    expect(s.engine.status().foldsSkippedByCost).toBeGreaterThan(0);
    const folds = () => (s.engine as unknown as { foldJobs: Map<string, { kind: string; done: boolean }> }).foldJobs;
    // with the aux model priced like the main model, the fold does not pay off even on a cold cache
    await s.engine.onIdle();
    await s.drain();
    expect(folds().size).toBe(0);
    // a cheaper aux model changes that: Δ̂·(p_write + p_read·(R̂ − 1)) = 2.05·span ≥ C_fold = 1.5·span,
    // while on a warm cache 1.3·span still does not cover C_fold, let alone the suffix
    s.h.auxPrice = { input: 0.8, output: 2, cacheRead: 0.08, cacheWrite: 1 };
    plan.push({});
    await s.round("one more", work(79, 30));
    expect(folds().size).toBe(0); // still not worth breaking a warm cache
    await s.engine.onIdle();
    await s.drain();
    expect([...folds().values()].map((j) => [j.kind, j.done])).toEqual([["cold", true]]);
    expect(await s.engine.onContext()).toBeNull(); // the cache is still warm: nothing is applied
    (s.engine as unknown as { lastRequestAt: number }).lastRequestAt -= 301_000;
    // the first request after the gap: replaying the prompt breaks no warm cache
    const edits = await s.engine.onContext();
    expect(edits!.length).toBeGreaterThan(5);
    expect(edits![0]!.replacement).toContain("consolidated earlier work");
    // …and persisted at the next commit point
    plan.push({});
    const b = await s.round("after the gap", work(80, 30));
    expect(b.edits).toEqual(edits);
    expect(b.records.some((r) => r.type === "realctx2.consolidation" && r.record.kind === "palim")).toBe(true);
    await hiddenReachable(s);
  });

  it("climbs into open intents one stable level at a time, and falls back when an intent closes", async () => {
    const c = cfg({ climb: { costCheck: false, stableRounds: 2, roundsPerLevel: 2 } });
    const s = new Session({ cfg: c });
    const log = consolidators(s.aux);
    const plan = director(s.decision, s.aux);
    await s.start();
    const frontiers: number[] = [];
    const note = () => frontiers.push(s.engine.status().frontier);
    plan.push({ kindle: "Outer" });
    await s.user("outer");
    note();
    for (let i = 0; i < 3; i++) {
      plan.push({});
      await s.round(`outer ${i}`, work(i, 1500));
      note();
    }
    plan.push({ kindle: "Inner" });
    await s.round("starting inner", work(3, 1500));
    note();
    for (let i = 0; i < 12; i++) {
      plan.push({});
      await s.round(`inner ${i}`, work(10 + i, 1500));
      note();
    }
    // the frontier starts at the root and rises one level at a time, at most once every `roundsPerLevel` rounds
    expect(frontiers[0]).toBe(0);
    expect(Math.max(...frontiers)).toBe(2);
    for (let i = 1; i < frontiers.length; i++) expect(frontiers[i]! - frontiers[i - 1]!).toBeLessThanOrEqual(1);
    expect(frontiers.indexOf(2) - frontiers.indexOf(1)).toBeGreaterThanOrEqual(2);
    await s.drain();
    plan.push({});
    await s.round("more inner", work(40, 30));
    const folds = [...s.engine.state.records.values()].filter((r) => r.kind === "palim");
    // the innermost level folds once the part before the working tail holds 2·T_min; guidance is never folded
    expect(folds.length).toBeGreaterThanOrEqual(1);
    const ctx = await s.h.contextText();
    expect(ctx).toContain('[intent] I\'m now working on "Outer"');
    expect(ctx).toContain('[intent] I\'m now working on "Inner" (inside: Outer)');
    expect(log.filter((t) => t.role === "palim")[0]!.data[0]).toMatchObject({ label: "CURRENT PURPOSES (outermost first)" });
    await hiddenReachable(s);
    // an intent at level 2 closes: its consolidation lands in level 1, so the frontier falls back to 0
    plan.push({ close: ["Inner"] });
    await s.round("inner done", work(41, 30));
    expect(s.engine.status().frontier).toBe(0);
    // an intent about to close is not folded: Precip takes it whole
    expect(s.engine.status().stack.map((i) => i.label)).toEqual(["Outer"]);
  });

  it("relieves pressure before the next request: root prefix first, then open intents, guidance kept", async () => {
    const s = new Session({ cfg: cfg({ climb: { enabled: false } }) });
    const log = consolidators(s.aux);
    const plan = director(s.decision, s.aux);
    s.h.contextWindow = 32000;
    await s.start();
    // a long root prefix without any intent, then an open intent that keeps growing
    director(s.decision, s.aux);
    for (let i = 0; i < 5; i++) await s.round(`root work ${i}`, work(i, 1300));
    plan.length = 0;
    const plan2 = director(s.decision, s.aux);
    plan2.push({ kindle: "Long investigation" });
    await s.user("investigate");
    let peak = 0;
    for (let i = 0; i < 16; i++) {
      plan2.push({});
      await s.round(`digging ${i}`, work(20 + i, 1300));
      peak = Math.max(peak, await s.h.requestTokens());
    }
    const W = 32000;
    // occupancy stays bounded: the request never goes out above capacity
    expect(peak).toBeLessThanOrEqual(W);
    expect(await s.h.requestTokens()).toBeLessThan(0.8 * W + 4000);
    const folds = [...s.engine.state.records.values()].filter((r) => r.kind === "palim");
    expect(folds.length).toBeGreaterThanOrEqual(2);
    // each fold saved at least Δ_min
    for (const f of folds) expect(f.tokensBefore - f.tokensAfter).toBeGreaterThanOrEqual(4096);
    const ctx = await s.h.contextText();
    expect(ctx).toContain('[intent] I\'m now working on "Long investigation"'); // the purpose stays visible
    expect(ctx).toContain("digging 15");
    expect(s.h.notices).toEqual([]);
    // under pressure the fold runs with tight limits
    expect(log.filter((t) => t.role === "palim").some((t) => t.budget?.timeoutMs === 30_000 && t.budget.thinking === "low")).toBe(true);
    await hiddenReachable(s);
  });

  it("retries a fold that saves too little, leaves the source intact when it fails, and reports capacity exhaustion", async () => {
    const s = new Session({ cfg: cfg({ climb: { enabled: false } }) });
    s.h.contextWindow = 32000;
    const asked: string[] = [];
    // a consolidator that never gets shorter than its input
    s.aux.on("palim", (task) => {
      asked.push(task.instructions);
      return { narrative: filler(40_000, "n"), knowledge: [] };
    });
    await s.start();
    for (let i = 0; i < 14; i++) await s.round(`work ${i}`, work(i, 1500));
    expect(asked.length).toBeGreaterThanOrEqual(3); // J = 2 retries
    expect(asked[1]).toContain("Be more concise");
    expect(asked[2]).toContain("Be much more concise");
    expect(s.engine.state.records.size).toBe(0);
    expect((await s.h.listEntries()).every((e) => !e.omitted && !e.edited)).toBe(true);
    // never truncate silently: the user is told before the request goes out
    expect(s.h.notices.some((n) => n.level === "warning" && /at capacity/.test(n.text))).toBe(true);
  });

  it("hands the harness a realctx2 compaction instead of cancelling it", async () => {
    const s = new Session({ cfg: cfg() });
    const log = consolidators(s.aux);
    await s.start();
    for (let i = 0; i < 8; i++) await s.round(`work ${i}`, work(i, 1200));
    const res = (await s.engine.onBeforeCompact({ instructions: "keep the port numbers", tokensBefore: 31000 }))!;
    expect(res.tokensBefore).toBe(31000);
    expect(res.summary).toMatch(/^\[t:[0-9a-z]{8} · compacted earlier work\]\nNarrative: /);
    expect(log.at(-1)!.instructions).toContain("The user asked for this when compacting: keep the port numbers");
    // firstKeptEntryId is the first entry of the working tail
    const entries = await s.h.listEntries();
    const kept = entries.findIndex((e) => e.id === res.firstKeptEntryId);
    expect(entries[kept]!.kind).toBe("assistant");
    expect(entries.length - kept).toBeGreaterThanOrEqual(4);
    // a compaction record keeps recall working: the raw entries are still in the file
    expect(res.record).toMatchObject({ kind: "compaction" });
    expect(reachableEntries(res.record, s.engine.state)).toEqual(entries.slice(0, kept).map((e) => e.id));
  });
});

describe("session state (§5.1)", () => {
  it("rebuilds the intent stack, the consolidation map and the ledger from the branch's records", async () => {
    const s = new Session({ cfg: cfg() });
    consolidators(s.aux);
    const plan = director(s.decision, s.aux);
    await s.start();
    plan.push({ kindle: "Outer" });
    await s.user("outer");
    plan.push({ kindle: "Inner" });
    await s.round("go inner", work(0));
    for (let i = 1; i < 4; i++) {
      plan.push({});
      await s.round(`inner ${i}`, work(i));
    }
    plan.push({ close: ["Inner"] });
    await s.round("inner done", work(4, 30));
    await s.drain();
    plan.push({ kindle: "Second inner" });
    await s.round("next inner", work(5, 30));
    plan.push({});
    await s.round("working on it", work(6, 30)); // the harness has assigned the new guidance entry by now
    const before = s.engine.state;
    // a new process: everything comes back from the session's custom records
    const again = SessionState.from(await s.h.listRecords());
    expect(again.stack.map((i) => [i.label, i.guidanceEntryId])).toEqual(before.stack.map((i) => [i.label, i.guidanceEntryId]));
    expect([...again.records.keys()]).toEqual([...before.records.keys()]);
    expect([...again.anchorOf.entries()]).toEqual([...before.anchorOf.entries()]);
    expect(again.closedOrder).toEqual(before.closedOrder);
    const entries = await s.h.listEntries();
    const regions = again.regions(entries);
    expect(regions.map((r) => r.level)).toEqual([0, 1, 2]);
    expect(entries[regions[1]!.from]!.customType).toBe(GUIDANCE_TYPE);
    expect(regions[1]!.to).toBe(regions[2]!.from);
    expect(regions[2]!.to).toBe(entries.length);
    expect(again.telos(again.stack[1]!)).toEqual(["Outer"]);
  });
});

describe("append-only harnesses (level L0, §4.6.3)", () => {
  it("consolidates in shadow and re-injects the state after the harness compacts", async () => {
    const s = new Session({ cfg: cfg({ Tmin: 100 }), level: 0 });
    consolidators(s.aux);
    const plan = director(s.decision, s.aux);
    await s.start();
    for (const label of ["Task one", "Task two", "Task three"]) {
      plan.push({ kindle: label, focus: "new_root" });
      await s.user(`do ${label}`);
      for (let i = 0; i < 3; i++) {
        plan.push({});
        await s.round(`${label} step ${i}`, work(i, 2500));
      }
      plan.push({ close: [label] });
      const b = await s.round(`${label} finished`, work(9, 30));
      expect(b.edits).toEqual([]);
      await s.drain();
      plan.push({});
      expect((await s.round(`${label} wrap`, work(8, 30))).edits).toEqual([]);
    }
    plan.push({ kindle: "Open task", focus: "new_root" });
    await s.user("one more");
    await s.drain();
    plan.push({});
    await s.round("working", work(7, 30));
    await s.drain();
    // the transcript keeps the raw messages
    expect((await s.h.listEntries()).every((e) => !e.omitted && !e.edited)).toBe(true);
    const records = [...s.engine.state.records.values()];
    expect(records.filter((r) => r.kind === "precip").length).toBe(3);
    expect(records.every((r) => r.shadow === true)).toBe(true);
    // shadow Palim only harvests knowledge
    expect(records.filter((r) => r.kind === "palim").length).toBeGreaterThanOrEqual(1);
    const inj = s.engine.reinjection();
    expect(estimateTokens(inj)).toBeLessThanOrEqual(8000);
    expect(inj).toMatch(/^\[intent\] My open purposes, outermost first:\n- "Open task"\. Done when: /);
    expect(inj.indexOf('intent "Task three"')).toBeLessThan(inj.indexOf('intent "Task two"')); // newest first, with their t: IDs
    expect(inj).toMatch(/\[t:[0-9a-z]{8} · intent "Task one" · succeeded · details archived\]/);
    expect(inj).toContain("Knowledge kept from earlier work:\n- [good] Fact 1:");
  });
});

describe("oversized tool results (§5.4.6)", () => {
  it("archives the full output behind an o: ID and keeps head and tail in context", async () => {
    const dir = tmp();
    const blobs = new BlobStore(dir);
    const big = Array.from({ length: 4000 }, (_, i) => `line ${i} ${i === 2500 ? "NEEDLE" : "x"}`).join("\n");
    const g = guardToolResult(big, 4800, blobs, { tool: "bash", toolCallId: "c1", at: "2026-11-20T00:00:00.000Z" })!;
    expect(g.blob.id).toMatch(/^o:[0-9a-z]{8}$/);
    expect(estimateTokens(g.text)).toBeLessThan(3000);
    expect(g.text.startsWith("line 0 x")).toBe(true);
    expect(g.text).toContain("line 3999 x");
    expect(g.text).toContain(`[${g.blob.id} · full output: ${g.blob.tokens} tokens · recall("${g.blob.id}", page) opens it]`);
    expect(blobs.read(g.blob.id)).toBe(big);
    expect(new BlobStore(dir).meta(`[${g.blob.id}]`)).toMatchObject({ tool: "bash", toolCallId: "c1" });
    expect(guardToolResult("short", 4800, blobs, { at: "" })).toBeNull();
    const pages = paginate(big);
    expect(pages.length).toBeGreaterThan(2);
    for (const p of pages) expect(estimateTokens(p)).toBeLessThanOrEqual(4100);
    expect(pages.join("\n")).toBe(big);
    expect(pages[pickPage(pages, undefined, "where is the NEEDLE")! - 1]).toContain("NEEDLE");
    expect(pickPage(pages, 99, undefined)).toBe(pages.length);
    // through the engine: a single round cannot exhaust the window
    const s = new Session({ cfg: cfg() });
    await s.start();
    await s.round("big output", [{ name: "bash", args: { command: "cat huge.log" }, output: big }]);
    const result = (await s.h.listEntries()).find((e) => e.kind === "toolResult")!;
    expect(result.tokens).toBeLessThan(3000);
    expect(result.text).toMatch(/\[o:[0-9a-z]{8} · full output/);
  });
});

describe("memory in the loop", () => {
  async function setup(over: { embeddings?: "none" | "dense"; cfg?: Record<string, unknown> } = {}): Promise<{ w: World; mem: MemoryRuntime; s: Session; plan: ReturnType<typeof director>; repo: string }> {
    const repo = initRepo();
    write(repo, "src/db/schema.ts", "export const users = { deletedAt: null };\n");
    write(repo, "src/db/generated/client.ts", "// generated\n");
    write(repo, "src/auth/tokenCache.ts", "export class TokenCache { refresh() {} }\n");
    commitAll(repo);
    const w = world({ cwd: repo, cfg: { context: { maxWindow: 32000 }, janus: { lateWaitMs: 30 }, ...(over.cfg ?? {}) }, embeddings: over.embeddings });
    w.close();
    const mem = new MemoryRuntime({ layout: w.layout, cfg: w.cfg, cwd: repo, trusted: true, decision: w.decision, aux: w.aux, dense: w.dense, clock: w.clock, sessionId: "sess-test", harness: "test", random: () => 0.99 });
    const s = new Session({ world: w, memory: mem });
    consolidators(s.aux);
    const plan = director(s.decision, s.aux);
    await s.start();
    return { w, mem, s, plan, repo };
  }
  const remember = async (mem: MemoryRuntime, text: string, over: Record<string, unknown> = {}) => (await new MemoryWriter(mem).write([{ text, origin: "explicit", scope: "personal", urgency: "hint", skipConflicts: true, skipDedup: true, ...over }]))[0]!.id!;

  it("delivers path memories with tool results, without repeats while they are visible", async () => {
    const { mem, s } = await setup();
    const fact = await remember(mem, "`users` rows are soft-deleted via `deletedAt`.", { paths: ["src/db/schema.ts"] });
    const rule = await remember(mem, "Database code must go through the repository layer.", { kind: "rule", severity: "must", paths: ["src/db/"] });
    await s.round("reading the schema", [{ name: "read", args: { path: "src/db/schema.ts" }, output: "export const users = …" }]);
    const first = (await s.h.listEntries()).find((e) => e.kind === "toolResult")!;
    expect(first.text).toBe(`export const users = …\n\n[paths] src/db/schema.ts\nsrc/db/**\n- MUST   [m:${rule}] Database code must go through the repository layer.\nsrc/db/schema.ts\n- [m:${fact}] fact · as of 2026-11-20: \`users\` rows are soft-deleted via \`deletedAt\`.`);
    // recorded in the ledger, with the entry they entered context at
    const ds = s.engine.state.deliveries;
    expect(ds.map((d) => [d.id, d.channel, d.full]).sort()).toEqual([[`m:${fact}`, "path", true], [`m:${rule}`, "path", true]].sort());
    expect(ds.every((d) => d.entryId === first.id && d.intentId === null)).toBe(true);
    expect(s.h.records.filter((r) => r.type === "realctx2.delivery").length).toBe(2);
    // touched again: still visible, so nothing is appended
    await s.round("reading again", [{ name: "read", args: { path: "src/db/schema.ts" }, output: "same" }]);
    expect((await s.h.listEntries()).filter((e) => e.kind === "toolResult")[1]!.text).toBe("same");
    // a nested call (another tool made it) is never patched
    const nested = await s.engine.onToolResult({ toolCallId: "n1", toolName: "read", text: "raw", isError: false, nested: true, event: { action: "read", paths: ["src/auth/tokenCache.ts"] } });
    expect(nested).toBeNull();
    mem.shutdown();
  });

  it("gates an edit once per intent, records the block as a delivery, and attributes use when the intent closes", async () => {
    const { mem, s, plan } = await setup();
    const never = await remember(mem, "Never edit files in src/db/generated; they are regenerated by `pnpm db:generate`.", { kind: "rule", severity: "must", urgency: "immediate", paths: ["src/db/generated/"], triggersOn: ["edit"] });
    const helpful = await remember(mem, "Run `pnpm db:generate` after editing src/db/schema.ts.", { kind: "procedure", paths: ["src/db/schema.ts"] });
    const unshown = await remember(mem, "Schema changes need a migration note in docs/migrations.md.", { kind: "rule", severity: "should", urgency: "caption", paths: ["src/db/"], triggersOn: ["commit"] });
    plan.push({ kindle: "Add an email column" });
    await s.user("add an email column to users");
    const intent = s.engine.state.stack[0]!;
    plan.push({});
    await s.round("I'll edit the generated client", [{ name: "edit", args: { path: "src/db/generated/client.ts" }, output: "edited" }]);
    expect(s.blocked).toEqual([`[gate] Before this edit: MUST [m:${never}] Never edit files in src/db/generated; they are regenerated by \`pnpm db:generate\`. If the action still complies, repeat it.`]);
    expect((await s.h.listEntries()).find((e) => e.kind === "toolResult")).toMatchObject({ isError: true });
    // the agent changes course: edit the schema, then run the generator named by the memory
    plan.push({});
    await s.round("Right — I'll edit the schema instead.", [{ name: "edit", args: { path: "src/db/schema.ts" }, output: "edited" }]);
    expect((await s.h.listEntries()).filter((e) => e.kind === "toolResult")[1]!.text).toContain(`[m:${helpful}] procedure · as of 2026-11-20: Run \`pnpm db:generate\``);
    plan.push({});
    await s.round(`Following [m:${helpful}], regenerating the client.`, [{ name: "bash", args: { command: "pnpm db:generate" }, output: "done" }]);
    // a second attempt in the same intent is not gated again
    plan.push({});
    await s.round("one more generated edit", [{ name: "edit", args: { path: "src/db/generated/client.ts" }, output: "edited" }]);
    expect(s.blocked.length).toBe(1);
    // closing the intent runs attribution on the region, in one decision request
    let asked: string[] = [];
    s.decision.on("attribution", (ev, qs) => {
      asked = qs.map((q) => q.name);
      const out: Answers = {};
      for (const q of qs) {
        const d = ev.delivered.find((x: { d: string }) => q.name.endsWith(`.${x.d}`));
        if (q.name.startsWith("use.")) out[q.name] = d.id === `m:${helpful}` ? { acted_on: 0.8, referenced: 0.2 } : d.id === `m:${never}` && d.via === "gate" ? { ignored_relevant: 0.3, contradicted: 0.6, acted_on: 0.1 } : { ignored_irrelevant: 0.9 };
        if (q.name.startsWith("effect.")) out[q.name] = d.id === `m:${helpful}` ? { helpful: 0.9, no_effect: 0.1 } : { no_effect: 1 };
        if (q.name.startsWith("comply.")) {
          const k = ev.rules.find((x: { k: string }) => q.name.endsWith(`.${x.k}`));
          out[q.name] = k.text.startsWith("Never edit") ? { violated: 0.9, complied: 0.1 } : k.text.startsWith("Schema changes") ? { violated: 0.7, not_applicable: 0.3 } : { complied: 0.9 };
        }
      }
      return out;
    });
    plan.push({ close: ["Add an email column"] });
    await s.round("committing", [{ name: "bash", args: { command: "git commit -am 'add email'" }, output: "ok" }]);
    await s.drain();
    expect(asked.filter((n) => n.startsWith("use.")).length).toBe(s.engine.state.deliveries.filter((d) => d.intentId === intent.id).length);
    expect(asked).not.toContain("outcome"); // Janus's outcome (success) is used
    expect(asked.filter((n) => n.startsWith("comply.")).length).toBe(3); // two shown, plus the unshown caption rule whose trigger matched
    const records = s.engine.state.attributed;
    const of = (id: string, channel: string) => records.get(s.engine.state.deliveries.find((d) => d.id === `m:${id}` && d.channel === channel)!.deliveryId)!;
    expect(of(helpful, "path").u).toBeCloseTo(0.9); // P(acted_on) + 0.5·P(referenced)
    expect(of(helpful, "path").use).toMatchObject({ acted_on: 0.8 });
    expect(of(never, "gate").u).toBe(0.5); // deterministic floor: its signature shows in later tool arguments
    // counters are batched for the session and written once
    expect(mem.graph.get(helpful)!.node.counters.used).toBe(0);
    mem.accounting.flush(mem.graph, mem.cfg);
    const h = mem.graph.get(helpful)!.node;
    expect(h.counters.delivered).toBe(1);
    expect(h.counters.used).toBeCloseTo(0.9);
    expect(h.counters.usedSuccess).toBeCloseTo(0.9);
    expect(h.counters.complied).toBeCloseTo(0.9);
    expect(h.strength.events.filter((e) => e.kind === "reinforce").length).toBe(1);
    const n = mem.graph.get(never)!.node;
    expect(n.counters.violated).toBeCloseTo(0.9);
    expect(n.counters.violations_immediate).toBeCloseTo(0.9);
    expect(n.counters.contradicted).toBeGreaterThan(0.5);
    // the rule that was never shown still collects its violation: this is what drives escalation
    expect(mem.graph.get(unshown)!.node.counters.violations_caption).toBeCloseTo(0.7);
    // intent outcomes feed EvoDisco's state
    expect(mem.evoLog.outcomes("personal")).toEqual([1]);
    mem.shutdown();
  });

  it("with emulated decisions, the kindle does not wait for the gate: the cards follow at the next commit point", async () => {
    const { mem, s } = await setup();
    const card = await remember(mem, "TokenCache.refresh must be single-flight; concurrent refreshes race on pending.", {});
    const seen = await remember(mem, "TokenCache keeps one pending promise per key.", { paths: ["src/auth/tokenCache.ts"] });
    // the aux-emulated fallback (§9.1.4): uncalibrated, and slow
    s.decision.isCalibrated = false;
    const gates: Array<() => void> = [];
    const real = s.decision.decide.bind(s.decision);
    s.decision.decide = async (ev, qs, opts) => {
      if (opts.callSite === "janus" || opts.callSite === "proactive.gate") await new Promise<void>((r) => gates.push(r));
      return real(ev, qs, opts);
    };
    const release = async () => {
      gates.shift()!();
      await new Promise((r) => setTimeout(r, 15));
    };
    s.decision.on("janus", () => ({ focus: { new_root: 0.9 } }));
    s.decision.on("proactive.gate", (_e, qs) => Object.fromEntries(qs.map((q) => [q.name, 0.9])));
    s.aux.on("janus.scribe", () => ({ label: "Fix the TokenCache refresh race", reason: "it races", success: "no race", failure: "no cause" }));
    await s.user("the token cache refresh races, please fix");
    await release(); // Janus answers while the model works
    const t0 = Date.now();
    const b1 = await s.round("reading the cache", [{ name: "read", args: { path: "src/auth/tokenCache.ts" }, output: "export class TokenCache { refresh() {} }" }]);
    expect(Date.now() - t0).toBeLessThan(1000);
    // the intent is kindled without cards; the gate is still running
    expect(b1.messages.map((m) => m.content)).toEqual([expect.stringMatching(/^\[intent\] I'm now working on "Fix the TokenCache refresh race"\.\nWhy: it races\nDone when: no race\nGive up when: no cause$/)]);
    expect(s.engine.state.deliveries.map((d) => d.channel)).toEqual(["path"]);
    // the gate answers; the next commit point brings the cards, minus what a path delivery already showed
    while (gates.length) await release();
    const b2 = await s.round("thinking", [{ name: "bash", args: { command: "true" }, output: "ok" }]);
    const late = b2.messages.find((m) => m.content.startsWith("[intent] Memory that may help"))!;
    expect(late.content).toMatch(new RegExp(`^\\[intent\\] Memory that may help with "Fix the TokenCache refresh race":\\n\\[m:${card}\\] personal · short-term · as of 2026-11-20\\nTokenCache\\.refresh must be single-flight`));
    expect(late.content).not.toContain(seen);
    expect(s.engine.state.deliveries.filter((d) => d.channel === "proactive").map((d) => d.id)).toEqual([`m:${card}`]);
    // delivered once
    while (gates.length) await release();
    const b3 = await s.round("more", [{ name: "bash", args: { command: "true" }, output: "ok" }]);
    expect(b3.messages.filter((m) => m.content.includes("Memory that may help"))).toEqual([]);
    while (gates.length) await release();
  });

  it("offers proactive cards only when an intent is kindled, and writes episodes and knowledge on the way out", async () => {
    const { mem, s, plan } = await setup();
    const card = await remember(mem, "TokenCache.refresh must be single-flight; concurrent refreshes race on pending.", {});
    s.decision.on("proactive.gate", (_e, qs) => Object.fromEntries(qs.map((q) => [q.name, 0.9])));
    s.decision.on("write.route", (_e, qs) => Object.fromEntries(qs.map((q): [string, number | Record<string, number>] => [q.name, q.name.startsWith("scope.") ? { project_personal: 0.9 } : q.name.startsWith("urgency.") ? { caption: 0.9 } : 0.01])));
    plan.push({ kindle: "Fix the TokenCache refresh race" });
    const b = await s.user("the token cache refresh races, please fix");
    expect(b.messages[0]!.content).toContain(`Memory that may help:\n[m:${card}] personal · short-term · as of 2026-11-20`);
    expect(s.engine.state.deliveries.map((d) => [d.id, d.channel])).toEqual([[`m:${card}`, "proactive"]]);
    // the purpose is remembered for importance and for EvoDisco's query cache
    expect(mem.graph.handle("personal").index!.purposes().map((p) => p.text)).toEqual(["Fix the TokenCache refresh race\nbecause Fix the TokenCache refresh race"]);
    expect(mem.caches.for("personal")).toEqual(["Fix the TokenCache refresh race because Fix the TokenCache refresh race"]);
    for (let i = 0; i < 4; i++) {
      plan.push({});
      await s.round(`fixing ${i}`, work(i));
    }
    plan.push({ close: ["Fix the TokenCache refresh race"] });
    await s.round("fixed", work(8, 30));
    await s.drain();
    plan.push({});
    await s.round("after", work(9, 30));
    await s.drain();
    // Precip's memory and sidecar became an episode, with provenance pointing back at the t: ID
    const episode = mem.graph.all(["personal"]).find((r) => r.node.kind === "episode")!;
    const record = [...s.engine.state.records.values()][0]!;
    expect(episode.node).toMatchObject({ layer: "short", origin: "harvest", evaluation: "good", provenance: { sessionId: "sess-test", turnId: record.id } });
    expect(episode.node.signature).toEqual(expect.arrayContaining(["src/a.ts", "pnpm test"]));
    expect(episode.node.text).not.toContain("details archived");
    // turns are indexed for search as they happen: raw entries and the consolidated message
    expect(mem.turns!.bm25("fixing", { limit: 5, sessions: ["sess-test"] }).length).toBeGreaterThan(0);
    expect(mem.turns!.get(record.id)).toMatchObject({ kind: "precip" });
    // idle harvest: short sessions still produce knowledge
    expect(await s.engine.idleHarvest()).toBe(2);
    await s.drain();
    const facts = mem.graph.all(["personal"]).filter((r) => r.node.evaluation === "bad" || r.node.text.startsWith("Fact"));
    expect(facts.length).toBe(2);
    expect(s.engine.state.records.get(record.id)!.knowledge!.every((k) => typeof k.memoryId === "string")).toBe(true);
    expect(await s.engine.idleHarvest()).toBe(0);
    expect(s.engine.leftover()).toEqual([]);
    mem.shutdown();
  });

  it("attributes root-region deliveries after six rounds, and leftovers deterministically at shutdown", async () => {
    const { mem, s } = await setup();
    const fact = await remember(mem, "TokenCache lives in src/auth/tokenCache.ts and is a module-level singleton.", { paths: ["src/auth/tokenCache.ts"] });
    s.decision.on("attribution", (_e, qs) => Object.fromEntries(qs.map((q): [string, number | Record<string, number>] => [q.name, q.name.startsWith("use.") ? { referenced: 1 } : { no_effect: 1 }])));
    await s.round("reading", [{ name: "read", args: { path: "src/auth/tokenCache.ts" }, output: "class TokenCache" }]);
    for (let i = 0; i < 5; i++) await s.round(`r${i}`, work(i, 20));
    expect(s.engine.state.attributed.size).toBe(0);
    await s.round("r6", work(6, 20)); // the credit window of 6 rounds closes
    expect([...s.engine.state.attributed.values()].map((a) => a.u)).toEqual([0.5]);
    // a delivery still open at shutdown is attributed from deterministic signals only
    const other = await remember(mem, "The schema file is src/db/schema.ts.", { paths: ["src/db/schema.ts"] });
    await s.round("reading schema", [{ name: "read", args: { path: "src/db/schema.ts" }, output: "x" }]);
    await s.round(`As [m:${other}] says, editing it.`, [{ name: "edit", args: { path: "src/db/schema.ts" }, output: "ok" }]);
    const last = await s.engine.onShutdown();
    const rec = last.records.find((r) => r.type === "realctx2.attribution")!;
    expect(rec).toMatchObject({ u: 1, use: { deterministic: 1 } }); // cited and its signature hit a tool argument
    void fact;
    mem.shutdown();
  });

  it("runs in light mode for sub-sessions: path memories and the gate, but no Janus or attribution", async () => {
    const { mem, w } = await setup();
    const s = new Session({ world: w, memory: mem, light: true });
    await s.start();
    const rule = await remember(mem, "Database code must go through the repository layer.", { kind: "rule", severity: "must", paths: ["src/db/"] });
    const b = await s.user("look at src/db/schema.ts");
    expect(b.messages[0]!.content).toContain(`[m:${rule}]`); // a path the user mentions brings its rules
    await s.round("reading", [{ name: "read", args: { path: "src/db/schema.ts" }, output: "x" }]);
    expect(s.decision.sites().filter((x) => x === "janus")).toEqual([]);
    expect(s.engine.state.stack).toEqual([]);
    mem.shutdown();
  });

  it("disables the context engine when maxWindow is 0 while keeping memory path delivery and gate active", async () => {
    const { mem, w } = await setup({ cfg: { context: { maxWindow: 0 } } });
    const s = new Session({ world: w, memory: mem });
    await s.start();
    const rule = await remember(mem, "Never drop database tables without a backup.", { kind: "rule", severity: "must", urgency: "immediate", paths: ["src/db/"] });

    expect(s.engine.contextEnabled()).toBe(false);
    expect(s.engine.window()).toBe(0);
    expect(s.engine.status().disabled).toBe(true);

    // Path memories mentioned in prompt still deliver, but Janus is not called
    const b = await s.user("inspect src/db/schema.ts");
    expect(b.messages[0]!.content).toContain(`[m:${rule}]`);
    expect(s.decision.sites().filter((x) => x === "janus")).toEqual([]);
    expect(s.engine.state.stack).toEqual([]);

    // Huge tool output is NOT archived by oversize guard when context engine is disabled
    const huge = "x".repeat(60_000);
    await s.round("reading large file", [{ name: "read", args: { path: "src/db/schema.ts" }, output: huge }]);
    const toolEntry = (await s.h.listEntries()).find((e) => e.kind === "toolResult")!;
    expect(toolEntry.text).toContain(huge);
    expect(toolEntry.text).not.toContain("[o:");

    // Pre-edit memory gate still fires when editing a path with an unseen immediate rule
    await remember(mem, "Never modify tokenCache without rotating signing keys.", { kind: "rule", severity: "must", urgency: "immediate", paths: ["src/auth/"] });
    const gate = await s.engine.onToolCall({ toolCallId: "tc-gate", event: { action: "edit", paths: ["src/auth/tokenCache.ts"] }, nested: false, own: false });
    expect(gate).not.toBeNull();

    // Context edits, compaction override, and reinjection are all disabled
    expect(await s.engine.onContext()).toBeNull();
    expect(await s.engine.onBeforeCompact({ tokensBefore: 100_000 })).toBeNull();
    expect(s.engine.reinjection()).toBe("");
    expect(s.decision.sites().filter((x) => x === "janus")).toEqual([]);
    mem.shutdown();
  });

  it("respects per-model cacheTTL overrides in onContext cold-cache detection", async () => {
    const repo = tmp("ctx-model-ttl-");
    const w = world({
      cwd: repo,
      cfg: {
        context: {
          maxWindow: 32000,
          cacheTtlSeconds: 300,
          modelCacheTtlSeconds: { "test/main": 3600 },
        },
      },
    });
    const s = new Session({ world: w });
    await s.start();
    // Seed 3 rounds where rounds 1-2 exceed Bmin so round 0 sits strictly before workingTail
    await s.round("work0", [{ name: "read", args: { path: "a.ts" }, output: "hello" }]);
    await s.round("work1", work(1, 1500));
    await s.round("work2", work(2, 1500));
    const entries = await s.h.listEntries();
    const u0 = s.engine.units[0]!;
    const coldPlan = planReplace(entries, s.engine.state, u0.start, u0.end, {
      id: "t:cold0001",
      kind: "palim",
      text: "summary",
      telos: [],
      model: "test/main",
      now: new Date(w.now.t).toISOString(),
    })!;
    expect(coldPlan).toBeTruthy();
    (s.engine as any).foldJobs.set("cold:0", { key: "cold:0", kind: "cold", level: 0, done: true, plan: coldPlan, promise: Promise.resolve() });
    (s.engine as any).lastRequestAt = w.now.t;

    // At +600s (past global 300s default, but below model override 3600s): cache is still warm -> no fold applied
    w.now.t += 600_000;
    expect(await s.engine.onContext()).toBeNull();
    expect((s.engine as any).foldJobs.has("cold:0")).toBe(true);

    // At +3601s from lastRequestAt: cache is cold under the model override -> cold fold is applied
    (s.engine as any).lastRequestAt = w.now.t - 3_601_000;
    const edits = await s.engine.onContext();
    expect(edits).not.toBeNull();
    expect((s.engine as any).foldJobs.has("cold:0")).toBe(false);
  });

  it("closes orphaned tool calls once a later non-result entry follows, without stalling working tail or alignment", () => {
    const mk = (id: string, kind: "user" | "assistant" | "toolResult", extra: Record<string, unknown> = {}): EntryView => ({
      id,
      kind,
      role: kind === "toolResult" ? "tool" : kind,
      text: "body",
      rawText: "body",
      omitted: false,
      edited: false,
      timestamp: "2026-11-20T00:00:00Z",
      tokens: 400,
      rawTokens: 400,
      ...extra,
    });
    // Mid-transcript assistant made a tool call (c1) whose result never arrived, then a user message followed.
    const entries = [
      mk("e0", "user"),
      mk("e1", "assistant", { toolCalls: [{ id: "c1", name: "bash", args: {} }] }),
      mk("e2", "user"),
      mk("e3", "assistant", { tokens: 2000 }),
      mk("e4", "assistant", { tokens: 2000 }),
      mk("e5", "assistant", { tokens: 2000 }),
    ];
    const units = toUnits(entries);
    expect(units[1]!.complete).toBe(true); // orphaned call c1 is closed because e2 followed and c1 never got a result
    const c = cfg({ K: 2 });
    const tail = workingTail(entries, units, c, 32_000, [400, 2000, 2000]);
    expect(tail.start).toBeGreaterThan(2); // working tail does NOT pin everything back to e1
    expect(alignToUnits(units, 0, tail.start)).toEqual([0, tail.start]);

    // A call at the very end of the transcript (no following non-result entry) stays open (may still be running).
    const running = [...entries, mk("e6", "assistant", { toolCalls: [{ id: "c2", name: "bash", args: {} }] })];
    expect(toUnits(running).at(-1)!.complete).toBe(false);

    // A call whose result arrives out-of-order later stays open so it is never cut from its result.
    const lateResult = [
      mk("a0", "assistant", { toolCalls: [{ id: "c3", name: "read", args: {} }] }),
      mk("a1", "user"),
      mk("a2", "toolResult", { toolCallId: "c3", toolName: "read" }),
    ];
    expect(toUnits(lateResult)[0]!.complete).toBe(false);
  });

  it("counts adapter.lastCacheWriteAt() (e.g. pi cache_warm) so cold folds do not break a warm cache", async () => {
    const repo = tmp("ctx-cache-warm-");
    const w = world({
      cwd: repo,
      cfg: { context: { maxWindow: 32000, cacheTtlSeconds: 300 } },
    });
    const s = new Session({ world: w });
    await s.start();
    await s.round("work0", [{ name: "read", args: { path: "a.ts" }, output: "hello" }]);
    await s.round("work1", work(1, 1500));
    await s.round("work2", work(2, 1500));
    const entries = await s.h.listEntries();
    const u0 = s.engine.units[0]!;
    const coldPlan = planReplace(entries, s.engine.state, u0.start, u0.end, {
      id: "t:warm0001",
      kind: "palim",
      text: "summary",
      telos: [],
      model: "test/main",
      now: new Date(w.now.t).toISOString(),
    })!;
    (s.engine as any).foldJobs.set("cold:0", { key: "cold:0", kind: "cold", level: 0, done: true, plan: coldPlan, promise: Promise.resolve() });
    (s.engine as any).lastRequestAt = w.now.t;

    // 10 minutes pass since lastRequestAt, but the harness kept the cache warm 30s ago -> stay warm
    w.now.t += 600_000;
    s.h.lastCacheWriteAt = () => w.now.t - 30_000;
    expect(await s.engine.onContext()).toBeNull();
    expect((s.engine as any).foldJobs.has("cold:0")).toBe(true);

    // Once the cache_warm refresh is older than TTL (301s), the cold fold applies
    (s.engine as any).lastRequestAt = w.now.t - 600_000;
    s.h.lastCacheWriteAt = () => w.now.t - 301_000;
    const edits = await s.engine.onContext();
    expect(edits).not.toBeNull();
    expect((s.engine as any).foldJobs.has("cold:0")).toBe(false);
  });
});
