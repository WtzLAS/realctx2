import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { reachableEntries } from "../src/context/archive.ts";
import { checkInvariants, planReplace } from "../src/context/consolidate.ts";
import { GUIDANCE_TYPE, renderDriftReminder, renderEmptyReminder, renderGuidance, renderReminder } from "../src/context/render.ts";
import { alignToUnits, latestRoundStart, tailBudget, toUnits, workingTail } from "../src/context/rounds.ts";
import { SessionState } from "../src/context/state.ts";
import type { Intent } from "../src/core/types.ts";
import { estimateTokens } from "../src/util/text.ts";
import { type Answers, FakeAux, FakeDecision } from "./helpers/fakes.ts";
import { cleanupTmp, testConfig } from "./helpers/fixtures.ts";
import { FakeHarness, filler, Session } from "./helpers/harness.ts";

afterAll(cleanupTmp);
afterEach(() => {
  vi.useRealTimers();
});

const cfg = (over: Record<string, unknown> = {}) =>
  testConfig({
    context: { maxWindow: 32000 },
    janus: { lateWaitMs: 50, debounceMs: 500, driftCooldownRounds: 32, ...(over as Record<string, unknown>) },
  });

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

describe("main-model intent tool (§5.2)", () => {
  it("opens, nests, updates, shifts, and closes intents with clean non-overlapping spans", async () => {
    const s = new Session({ cfg: cfg({ driftCooldownRounds: 0 }) });
    await s.start();
    await s.user("Fix the flaky login test");

    // open root intent
    const r1 = await s.intent({
      action: "open",
      label: "Fix the flaky login test in the auth suite.",
      reason: "the user reported intermittent failures",
      done: "the login suite passes 40 times in a row",
      give_up: "three hypotheses are ruled out",
    });
    expect(r1.isError).toBe(false);
    expect(r1.text).toContain('Opened "Fix the flaky login test in the auth suite".');
    expect(r1.text).toContain("Done when: the login suite passes 40 times in a row");
    const root = s.engine.state.stack[0]!;
    expect(root).toMatchObject({ parentId: null, status: "open", label: "Fix the flaky login test in the auth suite" });
    expect(root.guidanceEntryId).toBeTruthy();

    // open child sub-intent (deepen)
    const r2 = await s.intent({
      action: "open",
      label: "Find the race in TokenCache.refresh",
      reason: "logs show overlapping refreshes",
      done: "failing interleaving pinned to a line",
    });
    expect(r2.isError).toBe(false);
    expect(r2.text).toContain('Opened "Find the race in TokenCache.refresh" (inside: Fix the flaky login test in the auth suite).');
    expect(s.engine.state.stack.map((i) => i.label)).toEqual(["Fix the flaky login test in the auth suite", "Find the race in TokenCache.refresh"]);
    const child = s.engine.state.stack[1]!;
    expect(child.parentId).toBe(root.id);

    // update innermost intent in place without closing it
    const r3 = await s.intent({ action: "update", done: "repro test fails deterministically before fix" });
    expect(r3.isError).toBe(false);
    expect(r3.text).toContain('Updated "Find the race in TokenCache.refresh".');
    expect(s.engine.state.innermost()!.id).toBe(child.id);
    expect(s.engine.state.innermost()!.success).toBe("repro test fails deterministically before fix");

    // do work under child
    await s.round("checking refresh", [{ name: "read", args: { path: "src/auth/tokenCache.ts" }, output: "refresh()" }]);
    const beforeShiftLeaf = (await s.h.listEntries()).at(-1)!.id;

    // shift: atomically close child (failure) and open sibling under root
    const r4 = await s.intent({
      action: "shift",
      outcome: "failure",
      label: "Write a deterministic regression test",
      reason: "first hypothesis ruled out",
      done: "regression test reproduces the race",
    });
    expect(r4.isError).toBe(false);
    expect(r4.text).toContain('Closed "Find the race in TokenCache.refresh" (failed).');
    expect(r4.text).toContain('Opened "Write a deterministic regression test" (inside: Fix the flaky login test in the auth suite).');
    expect(s.engine.state.stack.map((i) => i.label)).toEqual(["Fix the flaky login test in the auth suite", "Write a deterministic regression test"]);
    const closedChild = s.engine.state.intents.get(child.id)!;
    expect(closedChild.status).toBe("failure");
    expect(closedChild.closedEntryId).toBe(beforeShiftLeaf);
    // new sibling starts AT the shift turn, completely disjoint from closedChild
    const sibling = s.engine.state.innermost()!;
    expect(sibling.parentId).toBe(root.id);
    expect(sibling.guidanceEntryId).not.toBe(beforeShiftLeaf);

    // close all remaining intents in one call
    await s.round("test fixed", [{ name: "bash", args: { command: "true" }, output: "ok" }]);
    const r5 = await s.intent({ action: "close", all: true, outcome: "success" });
    expect(r5.isError).toBe(false);
    expect(r5.text).toContain('Closed "Write a deterministic regression test" (succeeded), "Fix the flaky login test in the auth suite" (succeeded).');
    expect(r5.text).toContain("Stack: (empty)");
    expect(s.engine.state.stack).toEqual([]);
  });

  it("enforces duplicate guard, maxDepth, and atomic validation without mutating stack on error", async () => {
    const s = new Session({ cfg: cfg({ maxDepth: 2, driftCooldownRounds: 0 }) });
    await s.start();
    await s.user("task");

    // close/update on empty stack fails cleanly
    expect((await s.intent({ action: "close" })).isError).toBe(true);
    expect((await s.intent({ action: "update", done: "x" })).isError).toBe(true);
    // missing label or done fails
    expect((await s.intent({ action: "open", label: "No done" })).isError).toBe(true);
    expect((await s.intent({ action: "open", done: "no label" })).isError).toBe(true);

    await s.intent({ action: "open", label: "Root task", done: "root done" });
    // duplicate guard (case-insensitive)
    const dup = await s.intent({ action: "open", label: "root task", done: "again" });
    expect(dup.isError).toBe(true);
    expect(dup.text).toContain('duplicates the open intent "Root task"');
    expect(s.engine.state.stack.length).toBe(1);

    // depth cap
    await s.intent({ action: "open", label: "Child task", done: "child done" });
    const tooDeep = await s.intent({ action: "open", label: "Grandchild", done: "too deep" });
    expect(tooDeep.isError).toBe(true);
    expect(tooDeep.text).toContain("maxDepth (2)");
    expect(s.engine.state.stack.length).toBe(2);

    // shift with duplicate of remaining parent fails atomically (child stays open)
    const badShift = await s.intent({ action: "shift", label: "Root task", done: "dup parent" });
    expect(badShift.isError).toBe(true);
    expect(s.engine.state.stack.map((i) => i.label)).toEqual(["Root task", "Child task"]);

    // shift with all:true replaces entire stack even at maxDepth
    const goodShift = await s.intent({ action: "shift", all: true, outcome: "abandoned", label: "Brand new root", done: "new done" });
    expect(goodShift.isError).toBe(false);
    expect(s.engine.state.stack.map((i) => [i.label, i.parentId])).toEqual([["Brand new root", null]]);
  });
});

describe("periodic intent markers (§5.2)", () => {
  it("appends a compact reminder every janus.remindEvery rounds on an open intent and when the stack is empty", async () => {
    const s = new Session({ cfg: cfg({ remindEvery: 8, driftCooldownRounds: 0 }) });
    await s.start();
    await s.user("fix auth");

    // Empty stack: nudges after 8 rounds
    const emptyMsgs: string[] = [];
    for (let i = 0; i < 9; i++) {
      const b = await s.round(`explore ${i}`, [{ name: "bash", args: { command: "true" }, output: "" }]);
      emptyMsgs.push(...b.messages.map((m) => m.content));
    }
    expect(emptyMsgs).toEqual([renderEmptyReminder(8, "intent")]);

    // Open an intent: reminds every 8 rounds within it
    await s.intent({ action: "open", label: "Fix flaky auth test", done: "the check passes", give_up: "three attempts fail" });
    const openMsgs: string[] = [];
    for (let i = 0; i < 17; i++) {
      const b = await s.round(`step ${i}`, [{ name: "bash", args: { command: "true" }, output: "" }]);
      openMsgs.push(...b.messages.map((m) => m.content));
    }
    const intent = s.engine.state.innermost()!;
    expect(openMsgs).toEqual([renderReminder(intent, undefined, "intent"), renderReminder(intent, undefined, "intent")]);
  });
});

describe("advisory Janus decision rules, debounce, prefire, and cooldown (§5.2)", () => {
  it("evaluates closure and focus rules (including uncalibrated τ_close=0.9, min-round guard, redirect, and fail-safe)", async () => {
    const s = new Session({ cfg: cfg({ driftCooldownRounds: 0 }) });
    await s.start();
    await s.user("fix auth");
    await s.intent({ action: "open", label: "Fix flaky auth test", done: "suite passes", give_up: "blocked" });
    const root = s.engine.state.stack[0]!;
    await s.intent({ action: "open", label: "Find the race", done: "race pinned" });
    const child = s.engine.state.stack[1]!;

    // Minimum evidence: before any round completes under child (wait: intent() itself is 1 complete round,
    // so open a grandchild without completing another round and test rules directly)
    const entries = await s.h.listEntries();
    const units = toUnits(entries);
    const input = { state: s.engine.state, entries, units, mode: "full" as const, round: s.engine.round };

    // P(closed) = 0.75 < 0.8 → stays open → no drift advisory
    const pStay = s.engine.janus.rules(
      input,
      { [`close.${child.id}`]: { name: `close.${child.id}`, kind: "choice", probs: { open: 0.25, success: 0.75 }, calibrated: true }, [`close.${root.id}`]: { name: `close.${root.id}`, kind: "choice", probs: { open: 0.9, success: 0.1 }, calibrated: true }, focus: { name: "focus", kind: "choice", probs: { continue: 0.9 }, calibrated: true } },
      { answered: true, closures: [], kindle: null, closeProb: {}, focus: null, focusP: 0, redirect: null, evidenceLeafId: null },
    );
    expect(pStay.closures).toEqual([]);
    expect(s.engine.janus.advisory(pStay, s.engine.state.stack)).toBeNull();

    // Uncalibrated 0.85 < 0.9 → stays open
    const pUncal = s.engine.janus.rules(
      input,
      { [`close.${child.id}`]: { name: `close.${child.id}`, kind: "choice", probs: { open: 0.15, success: 0.85 }, calibrated: false }, focus: { name: "focus", kind: "choice", probs: { continue: 0.9 }, calibrated: false } },
      { answered: true, closures: [], kindle: null, closeProb: {}, focus: null, focusP: 0, redirect: null, evidenceLeafId: null },
    );
    expect(pUncal.closures).toEqual([]);

    // Outer wants to close but inner stays open → top-down stops at inner
    const pBlocked = s.engine.janus.rules(
      input,
      { [`close.${child.id}`]: { name: `close.${child.id}`, kind: "choice", probs: { open: 0.5, success: 0.5 }, calibrated: true }, [`close.${root.id}`]: { name: `close.${root.id}`, kind: "choice", probs: { open: 0.05, success: 0.95 }, calibrated: true }, focus: { name: "focus", kind: "choice", probs: { continue: 0.9 }, calibrated: true } },
      { answered: true, closures: [], kindle: null, closeProb: {}, focus: null, focusP: 0, redirect: null, evidenceLeafId: null },
    );
    expect(pBlocked.closures).toEqual([]);

    // Inner closes + successor → shift advisory
    const pShift = s.engine.janus.rules(
      input,
      { [`close.${child.id}`]: { name: `close.${child.id}`, kind: "choice", probs: { open: 0.05, failure: 0.8, success: 0.15 }, calibrated: true }, [`close.${root.id}`]: { name: `close.${root.id}`, kind: "choice", probs: { open: 0.9, success: 0.1 }, calibrated: true }, focus: { name: "focus", kind: "choice", probs: { successor: 0.85, continue: 0.15 }, calibrated: true } },
      { answered: true, closures: [], kindle: null, closeProb: {}, focus: null, focusP: 0, redirect: null, evidenceLeafId: null },
    );
    const advShift = s.engine.janus.advisory(pShift, s.engine.state.stack, "intent");
    expect(advShift?.kind).toBe("shift");
    expect(advShift?.summary).toContain('action "shift"');
    expect(advShift?.summary).toContain('outcome: "failure"');

    // new_root + redirect >= 0.8 → redirect advisory
    const pRedirect = s.engine.janus.rules(
      { ...input, userMessage: "Forget that, update the changelog" },
      { [`close.${child.id}`]: { name: `close.${child.id}`, kind: "choice", probs: { open: 0.9 }, calibrated: true }, [`close.${root.id}`]: { name: `close.${root.id}`, kind: "choice", probs: { open: 0.9 }, calibrated: true }, focus: { name: "focus", kind: "choice", probs: { new_root: 0.9 }, calibrated: true }, redirect: { name: "redirect", kind: "binary", p: 0.9, calibrated: true } },
      { answered: true, closures: [], kindle: null, closeProb: {}, focus: null, focusP: 0, redirect: null, evidenceLeafId: null },
    );
    const advRedirect = s.engine.janus.advisory(pRedirect, s.engine.state.stack, "intent");
    expect(advRedirect?.kind).toBe("redirect");
    expect(advRedirect?.summary).toContain("all: true");
  });

  it("debounces nonblocking drift checks (waits for quiet break), never mutates stack, and rate-limits drift reminders by cooldown", async () => {
    vi.useFakeTimers();
    const s = new Session({ cfg: cfg({ debounceMs: 500, driftCooldownRounds: 32, remindEvery: 0 }) });
    await s.start();
    const run = script(s.decision, [closeAll("success"), closeAll("success")]);
    await s.user("fix auth");
    await s.intent({ action: "open", label: "Fix flaky auth test", done: "suite passes" });

    // Round 1: returns immediately without calling decision API
    const b1 = await s.round("checking", [{ name: "bash", args: { command: "true" }, output: "ok" }]);
    expect(b1.messages).toEqual([]);
    expect(run.calls()).toBe(0);

    // Advance 300ms (< 500ms debounce) and do Round 2 → timer resets, still 0 decision calls!
    vi.advanceTimersByTime(300);
    const b2 = await s.round("still working", [{ name: "bash", args: { command: "true" }, output: "ok" }]);
    expect(b2.messages).toEqual([]);
    expect(run.calls()).toBe(0);

    // Advance 300ms again (< 500ms since round 2) → still 0 calls
    vi.advanceTimersByTime(300);
    expect(run.calls()).toBe(0);

    // Now let the quiet break pass (+250ms → 550ms since round 2) → fires once in background!
    vi.advanceTimersByTime(250);
    await s.drain();
    expect(run.calls()).toBe(1);
    // Advisory Janus NEVER mutates the stack itself
    expect(s.engine.state.stack.map((i) => i.label)).toEqual(["Fix flaky auth test"]);

    // Next turn immediately gets the strong drift reminder marker
    const b3 = await s.round("continuing without closing", [{ name: "bash", args: { command: "true" }, output: "ok" }]);
    expect(b3.messages.length).toBe(1);
    expect(b3.messages[0]!.customType).toBe(GUIDANCE_TYPE);
    expect(b3.messages[0]!.content).toContain("[intent] Drift check:");
    expect(b3.messages[0]!.content).toContain('action "close"');
    expect(s.engine.status().driftReminders).toBe(1);

    // Cooldown (32 rounds): during the next 31 rounds, even after breaks, no decision call or drift marker fires!
    for (let i = 0; i < 31; i++) {
      const b = await s.round(`cooldown step ${i}`, [{ name: "bash", args: { command: "true" }, output: "ok" }]);
      expect(b.messages).toEqual([]);
      vi.advanceTimersByTime(1000);
      await s.drain();
    }
    expect(run.calls()).toBe(1);

    // Round +32 after the drift reminder: cooldown elapsed → check fires again on break and emits marker on next turn
    await s.round("past cooldown", [{ name: "bash", args: { command: "true" }, output: "ok" }]);
    vi.advanceTimersByTime(600);
    await s.drain();
    expect(run.calls()).toBe(2);
    const bAfter = await s.round("next after cooldown", [{ name: "bash", args: { command: "true" }, output: "ok" }]);
    expect(bAfter.messages[0]?.content).toContain("[intent] Drift check:");
    expect(s.engine.status().driftReminders).toBe(2);
  });

  it("prefires immediately once when unchecked evidence hits janus.maxInputTokens while debounce is counting down", async () => {
    vi.useFakeTimers();
    // Small maxInputTokens cap + long 10s debounce so only prefire can trigger
    const s = new Session({ cfg: cfg({ debounceMs: 10_000, maxInputTokens: 700, driftCooldownRounds: 32, remindEvery: 0 }) });
    await s.start();
    const run = script(s.decision, [keepOpen({ deepen: 0.9 }), keepOpen()]);
    await s.user("investigate");
    await s.intent({ action: "open", label: "Investigate auth", done: "cause found" });

    // Small round: starts 10s debounce countdown, well below 700 tokens → 0 calls
    await s.round("small step", [{ name: "read", args: { path: "a.ts" }, output: "short output" }]);
    expect(run.calls()).toBe(0);

    // Large round pushes unchecked evidence over maxInputTokens (700) while 10s debounce is still counting down → prefires immediately!
    vi.advanceTimersByTime(100);
    const bBig = await s.round("big step", [{ name: "read", args: { path: "big.ts" }, output: filler(600, "tok") }]);
    await s.drain();
    expect(run.calls()).toBe(1);
    // Mid-turn prefire flushed the earlier unchecked context before the huge result could truncate it
    expect(run.evidence[0].recent_rounds).toContain("small step");
    expect(run.evidence[0].recent_rounds).not.toContain("[… earlier part cut …]");

    // Either big step's turn_end (if prefire finished in time) or the next turn surfaces the drift reminder
    const bNext = bBig.messages.length ? bBig : await s.round("next", [{ name: "bash", args: { command: "true" }, output: "ok" }]);
    expect(bNext.messages[0]?.content).toContain("[intent] Drift check:");
    expect(bNext.messages[0]?.content).toContain('action "open"');
  });

  it("defaults janus.maxInputTokens to min(decision model maxInputTokens, 64K) when auto", async () => {
    vi.useFakeTimers();
    const s = new Session({
      cfg: testConfig({
        context: { maxWindow: 32000 },
        providers: { decision: { format: "systemone", url: "https://example.test/v1/systemone", model: "jev", maxInputTokens: 700 } },
        janus: { lateWaitMs: 50, debounceMs: 10_000, maxInputTokens: "auto", driftCooldownRounds: 32, remindEvery: 0 },
      }),
    });
    await s.start();
    const run = script(s.decision, [keepOpen({ deepen: 0.9 })]);
    await s.user("investigate");
    await s.intent({ action: "open", label: "Investigate auth", done: "cause found" });

    // Small round stays under the 700-token decision cap (0 calls); large round hits 700 and prefires.
    await s.round("small step", [{ name: "read", args: { path: "a.ts" }, output: "short output" }]);
    expect(run.calls()).toBe(0);

    vi.advanceTimersByTime(100);
    await s.round("big step", [{ name: "read", args: { path: "big.ts" }, output: filler(600, "tok") }]);
    await s.drain();
    expect(run.calls()).toBe(1);
  });

  it("discards pending or in-flight drift checks when the main model calls intent", async () => {
    vi.useFakeTimers();
    const s = new Session({ cfg: cfg({ debounceMs: 500, driftCooldownRounds: 32, remindEvery: 0 }) });
    await s.start();
    const run = script(s.decision, [closeAll("success")]);
    await s.user("fix auth");
    await s.intent({ action: "open", label: "Fix auth", done: "fixed" });

    await s.round("done fixing", [{ name: "bash", args: { command: "true" }, output: "pass" }]);
    // Let debounce fire so pendingDrift is queued
    vi.advanceTimersByTime(600);
    await s.drain();
    expect(run.calls()).toBe(1);

    // Main model proactively closes the intent before the next ordinary turn → pendingDrift is cleared!
    await s.intent({ action: "close", outcome: "success" });
    const b = await s.round("summary", [{ name: "bash", args: { command: "true" }, output: "ok" }]);
    expect(b.messages).toEqual([]);
    expect(s.engine.status().driftReminders).toBe(0);
  });

  it("formats evidence with stack and head/tail clipped tool outputs, and renders guidance templates", async () => {
    vi.useFakeTimers();
    const s = new Session({ cfg: cfg({ debounceMs: 200, remindEvery: 0 }) });
    await s.start();
    const run = script(s.decision, [keepOpen()]);
    await s.user("fix auth");
    await s.intent({ action: "open", label: "Fix flaky auth test", reason: "reported", done: "suite passes", give_up: "blocked" });
    await s.round("reading a big file", [{ name: "read", args: { path: "big.txt" }, output: filler(3000, "tok") }]);
    vi.advanceTimersByTime(250);
    await s.drain();

    const ev = run.evidence[0];
    expect(ev.intent_stack).toMatch(/^- \[[0-9a-z]{8}\] Fix flaky auth test \(open for \d+ rounds\)\n {2}why: /);
    expect(estimateTokens(ev.recent_rounds)).toBeLessThan(1500);
    expect(ev.recent_rounds).toContain("tok0 tok1");
    expect(ev.recent_rounds).toContain("tok2999");
    expect(ev.recent_rounds).not.toContain("tok1500");

    const i = (label: string): Intent => ({ id: "x", parentId: null, label, reason: "r", success: "s.", failure: "f.", guidanceEntryId: "", openedRound: 0, status: "open" });
    expect(renderGuidance({ closed: [{ intent: i("A"), outcome: "success" }], backTo: i("Parent") })).toBe('[intent] I finished "A": succeeded.\nI\'m back to "Parent". Done when: s.');
    expect(renderDriftReminder('Focus shifted. Call `intent` with action "shift".', [i("A")])).toBe('[intent] Drift check: Focus shifted. Call `intent` with action "shift".\nCurrent stack: "A"');
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
