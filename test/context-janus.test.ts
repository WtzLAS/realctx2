import { afterAll, describe, expect, it } from "vitest";
import { reachableEntries } from "../src/context/archive.ts";
import { checkInvariants, planReplace } from "../src/context/consolidate.ts";
import { GUIDANCE_TYPE, renderGuidance } from "../src/context/render.ts";
import { alignToUnits, latestRoundStart, tailBudget, toUnits, workingTail } from "../src/context/rounds.ts";
import { SessionState } from "../src/context/state.ts";
import type { Intent } from "../src/core/types.ts";
import { estimateTokens } from "../src/util/text.ts";
import { type Answers, FakeAux, FakeDecision } from "./helpers/fakes.ts";
import { cleanupTmp, testConfig } from "./helpers/fixtures.ts";
import { FakeHarness, filler, Session } from "./helpers/harness.ts";

afterAll(cleanupTmp);

const cfg = () => testConfig({ context: { maxWindow: 32000 }, janus: { lateWaitMs: 50 } });

/** Janus answers scripted per call; `null` means the decision model gave no answer. */
function script(decision: FakeDecision, steps: Array<Answers | null | ((names: string[]) => Answers)>): { calls: () => number; evidence: any[] } {
  let n = 0;
  const evidence: any[] = [];
  decision.on("janus", (ev, qs) => {
    evidence.push(ev);
    const step = steps[n++];
    if (step === null || step === undefined) return undefined;
    return typeof step === "function" ? step(qs.map((q) => q.name)) : step;
  });
  return { calls: () => n, evidence };
}

function scribe(aux: FakeAux, intents: Array<{ label: string; reason?: string; success?: string; failure?: string }>): void {
  let n = 0;
  aux.on("janus.scribe", () => {
    const i = intents[Math.min(n++, intents.length - 1)]!;
    return { label: i.label, reason: i.reason ?? "it is needed now", success: i.success ?? "the check passes", failure: i.failure ?? "three attempts fail" };
  });
}

const closeAll = (outcome: string, focus: Record<string, number> = { continue: 0.9 }) => (names: string[]): Answers => {
  const out: Answers = { focus };
  for (const n of names) if (n.startsWith("close.")) out[n] = { open: 0.05, [outcome]: 0.9 };
  return out;
};
const keepOpen = (focus: Record<string, number> = { continue: 0.9 }) => (names: string[]): Answers => {
  const out: Answers = { focus };
  for (const n of names) if (n.startsWith("close.")) out[n] = { open: 0.9, success: 0.1 };
  return out;
};

describe("rounds and the working tail (§5.4.1)", () => {
  it("groups tool results with their assistant message and protects unfinished and latest rounds", async () => {
    const h = new FakeHarness(new FakeAux());
    h.user("start");
    for (let i = 0; i < 6; i++) {
      const a = h.assistant(`step ${i}`, [{ name: "read", args: { path: `f${i}.ts` } }]);
      h.result(a.calls[0]!, filler(400, `out${i}_`));
    }
    const pending = h.assistant("last", [{ name: "bash", args: { command: "ls" } }, { name: "bash", args: { command: "pwd" } }]);
    h.result(pending.calls[0]!, "a b c");
    const entries = await h.listEntries();
    const units = toUnits(entries);
    expect(units.map((u) => [u.round, u.end - u.start, u.complete])).toEqual([[false, 1, true], ...Array.from({ length: 6 }, () => [true, 2, true]), [true, 2, false]]);
    const c = cfg();
    const roundTokens = units.filter((u) => u.round && u.complete).map((u) => u.tokens);
    // B = min{αW, max{B_min, K·Q_0.95}}: here K·q exceeds B_min and is capped by αW
    expect(tailBudget(c, 200_000, roundTokens)).toBe(Math.min(0.2 * 32000, Math.max(2048, 2 * Math.max(...roundTokens))));
    const tail = workingTail(entries, units, c, 200_000, roundTokens);
    expect(tail.rounds).toBeGreaterThanOrEqual(2);
    expect(tail.tokens).toBeGreaterThanOrEqual(Math.min(6400, tailBudget(c, 200_000, roundTokens)));
    expect(entries[tail.start]!.kind).toBe("assistant");
    // pressure step 3: only unfinished rounds (and the latest) stay protected
    const minimal = workingTail(entries, units, c, 200_000, roundTokens, { minimal: true });
    expect(minimal.start).toBe(units[units.length - 1]!.start);
    expect(latestRoundStart(units, entries.length)).toBe(units[units.length - 1]!.start);
    // spans never cut a round
    expect(alignToUnits(units, 0, 4)).toEqual([0, 3]);
    expect(alignToUnits(units, 2, 9)).toEqual([3, 9]);
    expect(alignToUnits(units, 0, entries.length)).toEqual([0, units[units.length - 1]!.start]); // the unfinished round is left out
  });
});

describe("Janus decision rules (§5.2.4)", () => {
  it("kindles a root intent on a new user task and writes first-person guidance", async () => {
    const s = new Session({ cfg: cfg() });
    await s.start();
    const run = script(s.decision, [{ focus: { new_root: 0.8, continue: 0.2 }, redirect: 0.1 }]);
    scribe(s.aux, [{ label: "Fix the flaky login test in the auth suite.", reason: "the user reported it", success: "the login suite passes 40 times in a row", failure: "three hypotheses are ruled out" }]);
    const batch = await s.user("The login test is flaky, can you fix it?");
    expect(run.evidence[0]).toMatchObject({ intent_stack: "(no open intent)", user_message: "The login test is flaky, can you fix it?" });
    expect(batch.messages.length).toBe(1);
    expect(batch.messages[0]!.customType).toBe(GUIDANCE_TYPE);
    expect(batch.messages[0]!.content).toBe(
      ['[intent] I\'m now working on "Fix the flaky login test in the auth suite".', "Why: the user reported it", "Done when: the login suite passes 40 times in a row", "Give up when: three hypotheses are ruled out"].join("\n"),
    );
    const intent = s.engine.state.stack[0]!;
    expect(intent).toMatchObject({ parentId: null, status: "open", label: "Fix the flaky login test in the auth suite" });
    expect(batch.records).toEqual([{ type: "realctx2.intent", intent: expect.objectContaining({ id: intent.id, guidanceEntryId: "" }) }]);
    // the harness assigned the guidance entry; the next event resolves b_j and records it
    await s.round("looking", [{ name: "bash", args: { command: "ls" }, output: "a" }]);
    const guidance = s.h.raw.find((r) => r.customType === GUIDANCE_TYPE)!;
    expect(s.engine.state.stack[0]!.guidanceEntryId).toBe(guidance.id);
    expect(s.h.records.filter((r) => r.type === "realctx2.intent").at(-1)).toMatchObject({ intent: { guidanceEntryId: guidance.id } });
    // a small-talk message with an empty stack kindles nothing
    const s2 = new Session({ cfg: cfg() });
    await s2.start();
    script(s2.decision, [{ focus: { continue: 0.95 } }]);
    expect((await s2.user("thanks!")).messages).toEqual([]);
    expect(s2.aux.calls).toEqual([]);
  });

  async function withIntent(over: { cfg?: ReturnType<typeof cfg> } = {}) {
    const s = new Session({ cfg: over.cfg ?? cfg() });
    await s.start();
    const steps: Array<Answers | null | ((names: string[]) => Answers)> = [{ focus: { new_root: 0.9 } }];
    script(s.decision, steps);
    scribe(s.aux, [{ label: "Fix flaky auth test" }, { label: "Find the race in TokenCache.refresh" }, { label: "Write a regression test" }, { label: "Update the changelog" }]);
    await s.user("fix the flaky auth test");
    return { s, steps };
  }

  it("deepens, then closes top-down only above τ_close and after one complete round", async () => {
    const { s, steps } = await withIntent();
    // step 2 (first round): the model says it will look for the race → deepen
    steps.push(keepOpen({ deepen: 0.7, continue: 0.3 }));
    const b1 = await s.round("I'll look for the race in the token cache.", [{ name: "bash", args: { command: "grep -rn refresh src" }, output: "src/auth/tokenCache.ts:88" }]);
    expect(s.engine.state.stack.map((i) => i.label)).toEqual(["Fix flaky auth test", "Find the race in TokenCache.refresh"]);
    expect(b1.messages[0]!.content).toContain('I\'m now working on "Find the race in TokenCache.refresh" (inside: Fix flaky auth test).');
    const [root, child] = s.engine.state.stack as [Intent, Intent];
    expect(child.parentId).toBe(root.id);
    // P(closed) = 0.75 < 0.8 → stays open; and nothing is appended (the cache stays intact)
    steps.push(() => ({ [`close.${child.id}`]: { open: 0.25, success: 0.75 }, [`close.${root.id}`]: { open: 0.9 }, focus: { continue: 0.9 } }));
    const b2 = await s.round("still looking", [{ name: "read", args: { path: "src/auth/tokenCache.ts" }, output: "code" }]);
    expect(b2.messages).toEqual([]);
    expect(s.engine.state.stack.length).toBe(2);
    // the outer intent would close (0.95) but the inner one stays open → nothing closes
    steps.push(() => ({ [`close.${child.id}`]: { open: 0.5, success: 0.5 }, [`close.${root.id}`]: { open: 0.05, success: 0.95 }, focus: { continue: 0.9 } }));
    await s.round("hm", [{ name: "bash", args: { command: "true" }, output: "" }]);
    expect(s.engine.state.stack.length).toBe(2);
    // the inner intent closes as a failure; `successor` then kindles a sibling under the same parent
    steps.push(() => ({ [`close.${child.id}`]: { open: 0.1, failure: 0.6, success: 0.3 }, [`close.${root.id}`]: { open: 0.9 }, focus: { successor: 0.8, continue: 0.2 } }));
    const b4 = await s.round("That hypothesis is ruled out; I'll write a regression test instead.", [{ name: "bash", args: { command: "true" }, output: "" }]);
    expect(b4.messages[0]!.content.split("\n").slice(0, 2)).toEqual(['[intent] I finished "Find the race in TokenCache.refresh": failed.', 'I\'m now working on "Write a regression test" (inside: Fix flaky auth test).']);
    expect(s.engine.state.stack.map((i) => i.label)).toEqual(["Fix flaky auth test", "Write a regression test"]);
    expect(s.engine.state.intents.get(child.id)).toMatchObject({ status: "failure" });
    expect(s.engine.state.intents.get(child.id)!.closedEntryId).toBeDefined();
    // `successor` without a closure in the same step is treated as `continue`: it never bypasses τ_close
    steps.push(keepOpen({ successor: 0.9 }));
    const b5 = await s.round("more", [{ name: "bash", args: { command: "true" }, output: "" }]);
    expect(b5.messages).toEqual([]);
    expect(s.engine.state.stack.length).toBe(2);
    // everything closes in one step, innermost first; focus returns to nothing
    steps.push(closeAll("success"));
    const b6 = await s.round("done", [{ name: "bash", args: { command: "true" }, output: "ok" }]);
    expect(b6.messages[0]!.content).toBe('[intent] I finished "Write a regression test": succeeded. I finished "Fix flaky auth test": succeeded.');
    expect(s.engine.state.stack).toEqual([]);
  });

  it("needs one complete round since the guidance before an intent can close", async () => {
    const { s, steps } = await withIntent();
    const root = s.engine.state.stack[0]!;
    // closure-only Janus at settle, right after the kindle: no round has completed under this intent
    steps.push(closeAll("success"));
    s.h.assistant("I can't do anything yet.");
    await s.h.commit(await s.engine.onTurnEnd());
    expect(s.engine.state.intents.get(root.id)!.status).toBe("open");
  });

  it("treats new_root as a replacement only when the user redirects; otherwise as an interruption", async () => {
    const a = await withIntent();
    a.steps.push(keepOpen());
    await a.s.round("working", [{ name: "bash", args: { command: "true" }, output: "" }]);
    const root = a.s.engine.state.stack[0]!;
    // redirect ≥ 0.8: what is open is abandoned, and a root intent starts
    a.steps.push(() => ({ [`close.${root.id}`]: { open: 0.9 }, focus: { new_root: 0.9 }, redirect: 0.9 }));
    const b = await a.s.user("Forget that. Update the changelog instead.");
    expect(b.messages[0]!.content.split("\n")[0]).toBe('[intent] I finished "Fix flaky auth test": set aside.');
    expect(a.s.engine.state.stack.map((i) => [i.label, i.parentId])).toEqual([["Find the race in TokenCache.refresh", null]]);
    expect(a.s.engine.state.intents.get(root.id)!.status).toBe("abandoned");
    // redirect < 0.8: an interruption becomes a child; the parent is untouched
    const c = await withIntent();
    c.steps.push(keepOpen());
    await c.s.round("working", [{ name: "bash", args: { command: "true" }, output: "" }]);
    const root2 = c.s.engine.state.stack[0]!;
    c.steps.push(() => ({ [`close.${root2.id}`]: { open: 0.9 }, focus: { new_root: 0.9 }, redirect: 0.3 }));
    await c.s.user("By the way, what does this env var do?");
    expect(c.s.engine.state.stack.map((i) => i.parentId)).toEqual([null, root2.id]);
  });

  it("fails safe: a timeout means continue, an emulated model needs 0.9, and duplicates are not kindled", async () => {
    const { s, steps } = await withIntent();
    const root = s.engine.state.stack[0]!;
    steps.push(null); // no answer at all
    const b = await s.round("working", [{ name: "bash", args: { command: "true" }, output: "" }]);
    expect(b.messages).toEqual([]);
    expect(s.engine.state.stack.length).toBe(1);
    // uncalibrated answers: τ_close rises to 0.9
    s.decision.isCalibrated = false;
    steps.push(() => ({ [`close.${root.id}`]: { open: 0.15, success: 0.85 }, focus: { continue: 0.9 } }));
    await s.round("working", [{ name: "bash", args: { command: "true" }, output: "" }]);
    expect(s.engine.state.stack.length).toBe(1);
    s.decision.isCalibrated = true;
    // duplicate guard: the scribe proposes the open purpose again, twice → the kindle is skipped
    s.aux.on("janus.scribe", () => ({ label: "Fix flaky auth test", reason: "r", success: "s", failure: "f" }));
    steps.push(keepOpen({ deepen: 0.9 }));
    const before = s.aux.calls.length;
    const b3 = await s.round("working", [{ name: "bash", args: { command: "true" }, output: "" }]);
    expect(s.aux.calls.length - before).toBe(2); // one retry
    expect(s.aux.calls.at(-1)!.instructions).toContain('duplicates the open purpose "Fix flaky auth test"');
    expect(b3.messages).toEqual([]);
    expect(s.engine.state.stack.length).toBe(1);
    // an invalid scribe answer also skips the kindle
    s.aux.on("janus.scribe", () => ({ label: "", reason: "r", success: "s", failure: "f" }));
    steps.push(keepOpen({ deepen: 0.9 }));
    await s.round("working", [{ name: "bash", args: { command: "true" }, output: "" }]);
    expect(s.engine.state.stack.length).toBe(1);
  });

  it("runs off the critical path: a late answer applies at the next commit point", async () => {
    const s = new Session({ cfg: cfg() });
    await s.start();
    scribe(s.aux, [{ label: "Fix flaky auth test" }]);
    let release: (() => void) | null = null;
    let calls = 0;
    const real = s.decision.decide.bind(s.decision);
    s.decision.on("janus", () => ({ focus: { new_root: 0.9 } }));
    s.decision.decide = async (ev, qs, opts) => {
      if (opts.callSite === "janus" && ++calls === 3) await new Promise<void>((r) => (release = r));
      return real(ev, qs, opts);
    };
    await s.user("fix the flaky auth test"); // call 1: synchronous, answered
    const root = s.engine.state.stack[0]!;
    s.decision.on("janus", (_e, qs) => keepOpen()(qs.map((q) => q.name)));
    await s.round("working", [{ name: "bash", args: { command: "true" }, output: "ok" }]); // call 2
    s.decision.on("janus", (_e, qs) => closeAll("success")(qs.map((q) => q.name)));
    const t0 = Date.now();
    const b1 = await s.round("the suite passes now", [{ name: "bash", args: { command: "true" }, output: "ok" }]); // call 3 hangs
    expect(Date.now() - t0).toBeLessThan(1000); // turn_end waited only janus.lateWaitMs
    expect(b1.messages).toEqual([]);
    expect(s.engine.state.intents.get(root.id)!.status).toBe("open");
    expect(s.engine.status().janusLate).toBe(1);
    release!();
    await new Promise((r) => setTimeout(r, 20));
    s.decision.on("janus", () => undefined); // this step's own run gives nothing
    const b2 = await s.round("more", [{ name: "bash", args: { command: "true" }, output: "ok" }]);
    expect(b2.messages[0]!.content).toContain('I finished "Fix flaky auth test": succeeded.');
    expect(s.engine.state.stack).toEqual([]);
  });

  it("never holds a commit point for emulated decisions: they apply one step late, and a stale kindle is dropped", async () => {
    const s = new Session({ cfg: cfg() });
    await s.start();
    scribe(s.aux, [{ label: "Fix flaky auth test" }, { label: "A duplicate that must not appear" }]);
    // the aux-emulated fallback (§9.1.4): uncalibrated, and seconds per answer
    s.decision.isCalibrated = false;
    const gates: Array<() => void> = [];
    const real = s.decision.decide.bind(s.decision);
    s.decision.decide = async (ev, qs, opts) => {
      if (opts.callSite === "janus") await new Promise<void>((r) => gates.push(r));
      return real(ev, qs, opts);
    };
    const release = async () => {
      gates.shift()!();
      await new Promise((r) => setTimeout(r, 15));
    };
    const tools = [{ name: "bash", args: { command: "true" }, output: "ok" }];
    s.decision.on("janus", (_e, qs) => ({ ...keepOpen({ new_root: 0.9 })(qs.map((q) => q.name)) }));
    // the user's prompt does not wait for the answer
    const t0 = Date.now();
    const b0 = await s.user("fix the flaky auth test");
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(b0.messages).toEqual([]);
    expect(s.engine.state.stack).toEqual([]);
    expect(s.engine.status().janusLate).toBe(1);
    await release(); // the answer for the user's message arrives while the model works
    // the first round starts its own run, which saw an empty stack too
    const b1 = await s.round("looking at the test", tools);
    expect(gates.length).toBe(1);
    expect(b1.messages.map((m) => m.content)).toEqual([expect.stringContaining('[intent] I\'m now working on "Fix flaky auth test".')]);
    expect(s.engine.state.stack.map((i) => i.label)).toEqual(["Fix flaky auth test"]);
    await release();
    // its answer says "new root" as well: applied one step late, it must not kindle a second intent
    const b2 = await s.round("still looking", tools);
    expect(b2.messages).toEqual([]);
    expect(s.engine.state.stack.map((i) => i.label)).toEqual(["Fix flaky auth test"]);
    // one request in flight is enough: while it runs, the next round does not ask again
    expect(gates.length).toBe(1);
    await s.round("and looking", tools);
    expect(gates.length).toBe(1);
    s.decision.on("janus", (_e, qs) => keepOpen()(qs.map((q) => q.name)));
    await release();
    // a closure is seen by the run that starts now, and applies at the commit point after it;
    // uncalibrated answers close at τ_close 0.9
    s.decision.on("janus", (_e, qs) => closeAll("success")(qs.map((q) => q.name)));
    const b4 = await s.round("the suite passes now", tools);
    expect(b4.messages).toEqual([]);
    await release();
    const b5 = await s.round("wrapping up", tools);
    expect(b5.messages[0]!.content).toContain('I finished "Fix flaky auth test": succeeded.');
    expect(s.engine.state.stack).toEqual([]);
    expect(s.engine.state.intents.size).toBe(1);
    // settle asks for closures only, and does not wait either
    while (gates.length) await release();
    const t1 = Date.now();
    await s.engine.onBeforeSettle();
    expect(Date.now() - t1).toBeLessThan(1000);
    while (gates.length) await release();
  });

  it("puts stable evidence first and trims tool outputs", async () => {
    const { s, steps } = await withIntent();
    const run = script(s.decision, [keepOpen(), keepOpen()]);
    void steps;
    await s.round("reading a big file", [{ name: "read", args: { path: "big.txt" }, output: filler(3000, "tok") }]);
    // Janus starts at the first tool call, while the tools run: its evidence ends at the new assistant message
    expect(Object.keys(run.evidence[0])).toEqual(["intent_stack", "recent_rounds"]);
    expect(run.evidence[0].recent_rounds).toContain('→ read({"path":"big.txt"})');
    expect(run.evidence[0].recent_rounds).not.toContain("tok0 tok1");
    await s.round("next", [{ name: "bash", args: { command: "true" }, output: "ok" }]);
    const ev = run.evidence[1];
    expect(ev.intent_stack).toMatch(/^- \[[0-9a-z]{8}\] Fix flaky auth test \(open for \d+ rounds\)\n {2}why: /);
    expect(estimateTokens(ev.recent_rounds)).toBeLessThan(1200); // tool output cut to its first and last 300 tokens
    expect(ev.recent_rounds).toContain("tok0 tok1");
    expect(ev.recent_rounds).toContain("tok2999");
    expect(ev.recent_rounds).not.toContain("tok1500");
  });

  it("appends a compact reminder every 8 rounds within the same intent", async () => {
    const { s, steps } = await withIntent();
    const contents: string[] = [];
    for (let i = 0; i < 17; i++) {
      steps.push(keepOpen());
      const b = await s.round(`step ${i}`, [{ name: "bash", args: { command: "true" }, output: "" }]);
      contents.push(...b.messages.map((m) => m.content));
    }
    expect(contents).toEqual(['[intent] Still working on "Fix flaky auth test". Done when: the check passes Give up when: three attempts fail', '[intent] Still working on "Fix flaky auth test". Done when: the check passes Give up when: three attempts fail']);
  });

  it("renders closures, returns and cards in guidance", () => {
    const i = (label: string): Intent => ({ id: "x", parentId: null, label, reason: "r", success: "s.", failure: "f.", guidanceEntryId: "", openedRound: 0, status: "open" });
    expect(renderGuidance({ closed: [{ intent: i("A"), outcome: "success" }], backTo: i("Parent") })).toBe('[intent] I finished "A": succeeded.\nI\'m back to "Parent". Done when: s.');
    expect(renderGuidance({ closed: [], kindled: i("B"), cards: "[m:7f3a9k2d] card" })).toBe('[intent] I\'m now working on "B".\nWhy: r\nDone when: s.\nGive up when: f.\nMemory that may help:\n[m:7f3a9k2d] card');
  });
});

describe("span replacement and invariants (§4.3)", () => {
  it("anchors, omits, nests earlier consolidations, and refuses invalid spans", async () => {
    const h = new FakeHarness(new FakeAux());
    h.user("task");
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const a = h.assistant(`step ${i}`, [{ name: "read", args: { path: `f${i}` } }]);
      ids.push(a.id, h.result(a.calls[0]!, `out ${i}`));
    }
    const state = new SessionState();
    let entries = await h.listEntries();
    const units = toUnits(entries);
    const mk = (from: number, to: number, id: string, es = entries) => planReplace(es, state, from, to, { id, kind: "palim", text: `[${id}] folded`, telos: [], model: "m", now: "2026-11-20T00:00:00.000Z" });
    // anchor preference: the first user or custom message in the span, else the first assistant entry
    const p1 = mk(0, 5, "t:aaaaaaaa")!;
    expect(p1.record.anchorId).toBe(entries[0]!.id);
    expect(p1.edits[0]).toEqual({ targetId: entries[0]!.id, replacement: "[t:aaaaaaaa] folded" });
    expect(p1.edits.slice(1).every((e) => e.replacement === null)).toBe(true);
    expect(p1.record.children).toEqual(entries.slice(0, 5).map((e) => ({ entryId: e.id })));
    const ctx = { entries, units, tailStart: 7, latestRoundStart: 9, allowTail: false };
    expect(checkInvariants(p1, ctx)).toBeNull();
    expect(checkInvariants(mk(1, 4, "t:bbbbbbbb")!, ctx)).toBe("span cuts a round"); // invariant 1
    expect(checkInvariants(mk(1, 9, "t:cccccccc")!, ctx)).toBe("span intersects the working tail"); // invariant 2
    expect(checkInvariants(mk(1, 9, "t:cccccccc")!, { ...ctx, allowTail: true })).toBeNull(); // Precip may
    expect(checkInvariants(mk(1, 11, "t:dddddddd")!, { ...ctx, allowTail: true })).toBe("span contains the latest round"); // invariant 3
    // commit p1, then fold a longer span: the earlier consolidation becomes a nested child
    await h.commit({ records: [{ type: "realctx2.consolidation", record: p1.record }], edits: p1.edits, messages: [] });
    state.apply({ type: "realctx2.consolidation", record: p1.record });
    const stale = mk(1, 7, "t:eeeeeeee")!; // planned on the transcript as it was before the commit
    entries = await h.listEntries();
    expect(checkInvariants(stale, { ...ctx, entries, units: toUnits(entries) })).toBe("span changed since the plan was made");
    const p2 = mk(0, 7, "t:ffffffff", entries)!;
    expect(p2.record.children).toEqual([{ id: "t:aaaaaaaa" }, { entryId: entries[5]!.id }, { entryId: entries[6]!.id }]);
    expect(p2.record.tokensBefore).toBeLessThan(40);
    state.apply({ type: "realctx2.consolidation", record: p2.record });
    // recall round trip: every hidden entry is reachable from the outer record
    expect(reachableEntries(p2.record, state)).toEqual(entries.slice(0, 7).map((e) => e.id));
    // a span with no possible anchor is refused
    expect(planReplace(entries, state, 0, 0, { id: "t:gggggggg", kind: "palim", text: "x", telos: [], model: "m", now: "" })).toBeNull();
  });
});
