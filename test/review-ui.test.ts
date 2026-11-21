/** The `/realctx2 review` screen in pi's TUI: browsing, details, and two-step confirmation of every action. */
import { describe, expect, it } from "vitest";
import { initialReviewState, Realctx2ReviewComponent, type ReviewScreenExit, type ReviewScreenState, runReviewScreen } from "../src/adapters/pi/review-ui.ts";
import { isEditablePlan, type ReviewPlan, type ReviewActionId, type ReviewActionSpec, type ReviewEditPreview, type ReviewModel, type ReviewOutcome, type ReviewProposal, type ReviewRow } from "../src/commands/review.ts";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const ENTER = "\r";
const ESC = "\x1b";
const CTRL_C = "\x03";

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
const text = (lines: readonly string[]) => lines.join("\n");

/** A scripted review model: three items; approve/dismiss settle an item, pin leaves it. */
class FakeModel implements ReviewModel {
  readonly title = "realctx2 review";
  readonly subtitle = undefined;
  runs: Array<[string, ReviewActionId]> = [];
  edits: Array<[string, string]> = [];
  items: ReviewRow[] = [
    { key: "q:aaaa1111", label: "rule change", tone: "accent", id: "[m:aaaa1111]", title: "Callers must use TokenCache.refresh.", meta: "personal", summary: "suggested: Callers must use TokenCache.renew." },
    { key: "c:bbbb2222|cccc3333", label: "conflict", tone: "warning", id: "[m:bbbb2222]", title: "Deploys run on Fridays.", meta: "shared", summary: "conflicts with [m:cccc3333] Deploys never run on Fridays." },
    { key: "f:dddd4444", label: "harm", tone: "error", id: "[m:dddd4444]", title: "Clean with rm -rf.", meta: "personal · dormant", summary: "acted on with a harmful effect (harm 1.20)" },
  ];
  rows(): ReviewRow[] {
    return [...this.items];
  }
  refresh(): void {}
  details(key: string): string {
    return `Details of ${key}\n\nCurrent text\n  text of ${key}\n${Array.from({ length: 40 }, (_, i) => `  detail line ${i}`).join("\n")}`;
  }
  actions(key: string): ReviewActionSpec[] {
    return [
      { id: "approve", key: "a", label: "approve", confirm: `Approve ${key}?` },
      { id: "dismiss", key: "d", label: "dismiss", confirm: `Dismiss ${key}?` },
      { id: "edit", key: "e", label: "edit", confirm: `Edit ${key}?`, edit: true },
      { id: "pin", key: "p", label: "pin", confirm: `Pin ${key}?` },
    ];
  }
  run(key: string, action: ReviewActionId): ReviewOutcome {
    this.runs.push([key, action]);
    if (action !== "pin") this.items = this.items.filter((x) => x.key !== key);
    return { ok: true, message: `${action} done for ${key}` };
  }
  editForm(key: string) {
    return { title: `Edit ${key}`, prefill: `form of ${key}` };
  }
  planEdit(_key: string, edited: string): ReviewEditPreview {
    return edited.includes("bad") ? { ok: false, message: "Not applied: the form had no text below the --- line." } : { ok: true, summary: "[m:aaaa1111]: text", preview: ["New text", `  ${edited}`] };
  }
  applyEdit(key: string, edited: string): ReviewOutcome {
    this.edits.push([key, edited]);
    this.items = this.items.filter((x) => x.key !== key);
    return { ok: true, message: `Updated ${key}` };
  }
}

/** The same model with "ask model" on its conflict; each answer of the aux model is released by the test. */
class AskingModel extends FakeModel {
  asked: Array<{ key: string; signal?: AbortSignal; answer: (p: ReviewProposal) => void }> = [];
  applied: Array<[string, ReviewPlan]> = [];
  override actions(key: string): ReviewActionSpec[] {
    const base = super.actions(key);
    return key.startsWith("c:") ? [...base, { id: "resolve", key: "m", label: "ask model", confirm: "Let the aux model decide?", ask: true }] : base;
  }
  propose(key: string, signal?: AbortSignal): Promise<ReviewProposal> {
    return new Promise((answer) => this.asked.push({ key, signal, answer }));
  }
  applyProposal(key: string, plan: ReviewPlan): ReviewOutcome {
    this.applied.push([key, plan]);
    this.items = this.items.filter((x) => x.key !== key);
    return { ok: true, message: `Applied the model's suggestion. Merged into ${key}` };
  }
}

const MERGE: ReviewProposal = {
  ok: true,
  confirm: "The model suggests: merge both into [m:bbbb2222] and retire [m:cccc3333]. Apply it?",
  preview: ["Why: Deploys moved off Fridays in March; only hotfixes still ship then.", "Merged text of [m:bbbb2222]", "  Deploys never run on Fridays, except hotfixes, which may ship on a Friday with on-call approval.", 'Retire [m:cccc3333] "Deploys never run on Fridays" (reversible with /realctx2 restore)'],
  destructive: true,
  plan: { decision: "merge", reason: "Deploys moved off Fridays in March.", text: "Deploys never run on Fridays, except hotfixes.", basis: ["h1", "h2"] },
};
const tick = () => new Promise((r) => setTimeout(r, 0));

/** The asking model whose suggested text can be edited first: `stale` in an edit drops the suggestion, an empty text is fixable. */
class RevisingModel extends AskingModel {
  revisions: string[] = [];
  proposalForm(key: string, plan: ReviewPlan) {
    return isEditablePlan(plan) ? { title: `Edit the suggestion for ${key}`, prefill: `# about ${key}\n---\n${plan.text}` } : null;
  }
  reviseProposal(_key: string, plan: ReviewPlan, edited: string): ReviewProposal {
    this.revisions.push(edited);
    if (edited.includes("stale")) return { ok: false, message: "The memories changed after the model read them: the suggestion was dropped. Ask again." };
    const text = edited.split("---\n")[1]?.trim();
    if (!text) return { ok: false, fixable: true, message: "the text below the --- line is empty" };
    return { ok: true, confirm: "Your edit of the model's suggestion: merge both. Apply it?", preview: ["The model's reason: Fridays are frozen.", "Merged text", `  ${text}`], destructive: true, plan: { ...plan, text, edited: true } };
  }
}

const RETIRE: ReviewProposal = { ok: true, confirm: "The model suggests: retire [m:bbbb2222] and keep [m:cccc3333]. Apply it?", preview: ["Why: Deploys moved off Fridays."], destructive: true, plan: { decision: "remove-current", reason: "Deploys moved off Fridays.", basis: ["h1", "h2"] } };

function screen(model = new FakeModel(), state: ReviewScreenState = initialReviewState()) {
  const exits: ReviewScreenExit[] = [];
  let renders = 0;
  const c = new Realctx2ReviewComponent({ model, state, onExit: (x) => void exits.push(x), theme, tui: { requestRender: () => void renders++, terminal: { rows: 40 } } });
  return { c, model, state, exits, view: () => text(c.render(100)), renders: () => renders };
}

describe("the review screen (pi TUI)", () => {
  it("cycles through pending reviews and opens details with Enter", () => {
    const s = screen();
    const first = s.c.render(100);
    expect(s.c.render(100)).toBe(first); // cached while nothing changes
    const list = text(first);
    expect(list).toContain("realctx2 review");
    expect(list).toContain("3 pending · 1 of 3");
    expect(list).toContain("› rule change");
    expect(list).toContain("[m:aaaa1111] Callers must use TokenCache.refresh.");
    expect(list).toContain("suggested: Callers must use TokenCache.renew."); // the selected item's reason
    expect(list).toContain("a approve · d dismiss · e edit · p pin   (each asks to confirm)");
    expect(list).toContain("↑↓ select · Enter details");
    s.c.handleInput(DOWN);
    expect(s.view()).toContain("2 of 3");
    expect(s.view()).toContain("› conflict");
    s.c.handleInput(UP);
    s.c.handleInput(UP); // wraps around
    expect(s.view()).toContain("3 of 3");
    expect(s.renders()).toBeGreaterThan(0);
    // details, then step through the items without going back to the list
    s.c.handleInput(ENTER);
    let detail = s.view();
    expect(detail).toContain("realctx2 review › harm [m:dddd4444]");
    expect(detail).toContain("Details of f:dddd4444");
    expect(detail).toMatch(/3 of 3 · lines 1–\d+ of 44/);
    s.c.handleInput(DOWN); // scrolls the details
    expect(s.view()).toMatch(/lines 2–/);
    s.c.handleInput(RIGHT);
    detail = s.view();
    expect(detail).toContain("Details of q:aaaa1111");
    expect(detail).toMatch(/1 of 3 · lines 1–/); // a new item starts at the top
    s.c.handleInput(LEFT);
    expect(s.view()).toContain("Details of f:dddd4444");
    expect(s.view()).toContain("←→ previous/next");
    s.c.handleInput(ESC); // back to the list, not closed
    expect(s.exits).toEqual([]);
    expect(s.view()).toContain("› harm");
    s.c.handleInput(ESC);
    expect(s.exits).toEqual([{ kind: "close" }]);
  });

  it("asks a separate confirmation before every action; any other key cancels", () => {
    const s = screen();
    s.c.handleInput("a");
    let v = s.view();
    expect(v).toContain("? Approve q:aaaa1111?");
    expect(v).toContain("Press a again or y to confirm · any other key cancels");
    expect(s.model.runs).toEqual([]); // nothing happened yet
    s.c.handleInput("x");
    expect(s.model.runs).toEqual([]);
    expect(s.view()).toContain("! Cancelled: approve was not applied.");
    // Esc and Ctrl+C cancel the question without closing the screen
    s.c.handleInput("d");
    s.c.handleInput(ESC);
    s.c.handleInput("d");
    s.c.handleInput(CTRL_C);
    expect(s.model.runs).toEqual([]);
    expect(s.exits).toEqual([]);
    // the same key again confirms
    s.c.handleInput("a");
    s.c.handleInput("a");
    expect(s.model.runs).toEqual([["q:aaaa1111", "approve"]]);
    v = s.view();
    expect(v).toContain("✓ approve done for q:aaaa1111");
    expect(v).toContain("2 pending · 1 of 2");
    expect(v).toContain("› conflict"); // the next item moves up
    // y confirms too; in details, the next item takes the settled one's place
    s.c.handleInput(ENTER);
    s.c.handleInput("d");
    expect(s.view()).toContain("? Dismiss c:bbbb2222|cccc3333?");
    s.c.handleInput("y");
    expect(s.model.runs.at(-1)).toEqual(["c:bbbb2222|cccc3333", "dismiss"]);
    expect(s.view()).toContain("Details of f:dddd4444");
    // an action that leaves the item keeps it selected
    s.c.handleInput("p");
    s.c.handleInput("p");
    expect(s.model.runs.at(-1)).toEqual(["f:dddd4444", "pin"]);
    expect(s.view()).toContain("Details of f:dddd4444");
    s.c.handleInput("a");
    s.c.handleInput("a");
    const done = s.view();
    expect(done).toContain("Nothing to review.");
    expect(done).toContain("0 pending");
    // keys that are no action do nothing
    s.c.handleInput("z");
    expect(s.model.runs).toHaveLength(4);
  });

  it("asks the aux model about a conflict, waits for it, and applies its suggestion only on a second keypress", async () => {
    const model = new AskingModel();
    const s = screen(model);
    // a conflict only: other items have no such action
    expect(s.view()).not.toContain("m ask model");
    s.c.handleInput("m");
    expect(model.asked).toEqual([]);
    s.c.handleInput(DOWN);
    s.c.handleInput(ENTER);
    expect(s.view()).toContain("a approve · d dismiss · e edit · p pin · m ask model   (each asks to confirm)");
    s.c.handleInput("m");
    expect(model.asked.map((x) => x.key)).toEqual(["c:bbbb2222|cccc3333"]);
    let v = s.view();
    expect(v).toContain("… Asking the aux model how to settle this · 0 s · Esc stops");
    expect(v).not.toContain("m ask model"); // no actions while it decides
    // keys wait: no navigation, no second question, nothing runs
    for (const k of ["a", "m", "y", RIGHT, ENTER]) s.c.handleInput(k);
    expect(s.view()).toContain("Details of c:bbbb2222|cccc3333");
    expect(model.asked).toHaveLength(1);
    expect(model.runs).toEqual([]);
    // its suggestion: what would happen, with the reason and the whole merged text
    model.asked[0]!.answer(MERGE);
    await tick();
    v = s.view();
    expect(v).toContain("? The model suggests: merge both into [m:bbbb2222] and retire [m:cccc3333]. Apply it?");
    expect(v).toContain("Why: Deploys moved off Fridays in March; only hotfixes still ship then.");
    expect(v).toContain("Deploys never run on Fridays, except hotfixes, which may ship on a Friday with on-call");
    expect(v).toContain("approval."); // wrapped, not cut off
    expect(v).toContain("Press m again or y to apply · any other key discards the suggestion");
    expect(model.applied).toEqual([]);
    s.c.handleInput("x");
    expect(s.view()).toContain("! Suggestion discarded: nothing changed.");
    expect(model.applied).toEqual([]);
    // ask again; the same key applies it
    s.c.handleInput("m");
    model.asked[1]!.answer(MERGE);
    await tick();
    s.c.handleInput("m");
    expect(model.applied).toEqual([["c:bbbb2222|cccc3333", MERGE.ok ? MERGE.plan : null]]);
    v = s.view();
    expect(v).toContain("✓ Applied the model's suggestion. Merged into c:bbbb2222|cccc3333");
    expect(v).toContain("Details of f:dddd4444"); // the next item takes the settled one's place
    expect(model.runs).toEqual([]);
  });

  it("stops asking on Esc and ignores a late answer; a failed answer is reported", async () => {
    const model = new AskingModel();
    model.items = model.items.filter((x) => x.key.startsWith("c:"));
    const s = screen(model);
    s.c.handleInput("m");
    const first = model.asked[0]!;
    expect(first.signal?.aborted).toBe(false);
    s.c.handleInput(ESC);
    expect(first.signal?.aborted).toBe(true); // the aux session is cancelled
    expect(s.exits).toEqual([]); // the screen stays
    expect(s.view()).toContain("! Stopped asking the model: nothing changed.");
    first.answer(MERGE);
    await tick();
    expect(s.view()).not.toContain("The model suggests");
    s.c.handleInput("m");
    model.asked[1]!.answer({ ok: false, message: "The model gave no usable answer: timeout. Nothing changed." });
    await tick();
    expect(s.view()).toContain("✗ The model gave no usable answer: timeout. Nothing changed.");
    expect(s.view()).toContain("m ask model");
    // closing while it decides cancels it too
    s.c.handleInput("m");
    s.c.handleInput(CTRL_C);
    expect(model.asked[2]!.signal?.aborted).toBe(true);
    s.c.handleInput("q");
    expect(s.exits).toEqual([{ kind: "close" }]);
    expect(model.applied).toEqual([]);
  });

  it("closes for the editor and confirms the planned edit when it comes back", async () => {
    const model = new FakeModel();
    const shown: string[] = [];
    const scripts: Array<(c: Realctx2ReviewComponent) => void> = [
      (c) => {
        c.handleInput(DOWN); // the conflict…
        c.handleInput(UP); // …and back to the rule change
        c.handleInput("e"); // the editor opens at once: editing itself changes nothing
      },
      (c) => {
        shown.push(text(c.render(100)));
        c.handleInput("x"); // not the confirming key: the edit is discarded
        shown.push(text(c.render(100)));
        c.handleInput("e");
      },
      (c) => {
        shown.push(text(c.render(100)));
        c.handleInput("e"); // the second keypress applies it
        shown.push(text(c.render(100)));
        c.handleInput("e"); // the conflict, now selected
      },
      (c) => {
        shown.push(text(c.render(100)));
        c.handleInput("e");
      },
      (c) => {
        shown.push(text(c.render(100)));
        c.handleInput(ESC);
      },
    ];
    const editors = ["first try", "renewed text", undefined, "bad form"];
    const prefills: string[] = [];
    let opened = 0;
    await runReviewScreen(model, {
      custom: async (factory) =>
        new Promise<ReviewScreenExit | undefined>((resolve) => {
          const c = factory({ requestRender: () => undefined, terminal: { rows: 40 } }, theme, resolve) as Realctx2ReviewComponent;
          opened++;
          scripts.shift()!(c);
        }),
      editor: async (_title, prefill) => {
        prefills.push(prefill);
        return editors.shift();
      },
    });
    expect(opened).toBe(5);
    expect(prefills).toEqual(["form of q:aaaa1111", "form of q:aaaa1111", "form of c:bbbb2222|cccc3333", "form of c:bbbb2222|cccc3333"]);
    // after the editor: what would change, waiting for the second keypress
    expect(shown[0]).toContain("? Apply edit to [m:aaaa1111]: text?");
    expect(shown[0]).toContain("New text");
    expect(shown[0]).toContain("first try");
    expect(shown[0]).toContain("Press e again or y to apply · any other key discards the edit");
    expect(shown[1]).toContain("! Edit discarded: nothing changed.");
    expect(shown[2]).toContain("renewed text");
    expect(model.edits).toEqual([["q:aaaa1111", "renewed text"]]);
    expect(shown[3]).toContain("✓ Updated q:aaaa1111");
    expect(shown[4]).toContain("! Edit cancelled: nothing changed."); // the editor was closed without saving
    expect(shown[5]).toContain("✗ Not applied: the form had no text below the --- line.");
    expect(model.runs).toEqual([]);
  });

  it("edits the model's suggested text in the editor before it is applied, and asks again", async () => {
    const model = new RevisingModel();
    model.items = model.items.filter((x) => x.key.startsWith("c:"));
    const shown: Record<string, string> = {};
    const answer = async (c: Realctx2ReviewComponent, p: ReviewProposal) => {
      c.handleInput("m");
      model.asked.at(-1)!.answer(p);
      await tick();
    };
    const scripts: Array<(c: Realctx2ReviewComponent) => Promise<void>> = [
      async (c) => {
        c.handleInput(ENTER);
        await answer(c, MERGE);
        shown.suggested = text(c.render(100));
        c.handleInput("e"); // the screen closes for the editor; the suggestion waits
      },
      async (c) => {
        shown.edited = text(c.render(100));
        c.handleInput("e"); // edit the edit
      },
      async (c) => {
        shown.unsaved = text(c.render(100)); // closed without saving: the edit stands
        c.handleInput("e");
      },
      async (c) => {
        shown.dropped = text(c.render(100));
        // a suggestion without text: e is just another key, which discards it
        await answer(c, RETIRE);
        shown.retire = text(c.render(100));
        c.handleInput("e");
        shown.discarded = text(c.render(100));
        await answer(c, MERGE);
        c.handleInput("e");
      },
      async (c) => {
        shown.final = text(c.render(100));
        expect(model.applied).toEqual([]); // nothing applied while editing
        c.handleInput("m");
        shown.done = text(c.render(100));
        c.handleInput(ESC);
        c.handleInput(ESC);
      },
    ];
    const prefills: string[] = [];
    const editors: Array<string | undefined> = ["# about it\n---\n  ", "---\nDeploys never run on Fridays; hotfixes need on-call approval.", undefined, "stale edit", "---\nNo deploys on Fridays."];
    let opened = 0;
    await runReviewScreen(model, {
      custom: async (factory) =>
        new Promise<ReviewScreenExit | undefined>((resolve) => {
          const c = factory({ requestRender: () => undefined, terminal: { rows: 40 } }, theme, resolve) as Realctx2ReviewComponent;
          opened++;
          void scripts.shift()!(c);
        }),
      editor: async (_title, prefill) => {
        prefills.push(prefill);
        return editors.shift();
      },
    });
    expect(opened).toBe(5);
    expect(shown.suggested).toContain("Press m again or y to apply · e to edit it first · any other key discards the suggestion");
    // the suggested text opens in the editor; an edit that cannot be used opens it again, with the reason on top
    const merged = MERGE.ok ? MERGE.plan.text : "";
    expect(prefills[0]).toBe(`# about c:bbbb2222|cccc3333\n---\n${merged}`);
    expect(prefills[1]).toBe("# ! Not used: the text below the --- line is empty. Fix it and save again, or close without saving to keep the suggestion as it was.\n# about it\n---\n  ");
    expect(model.revisions).toEqual(["# about it\n---\n  ", "---\nDeploys never run on Fridays; hotfixes need on-call approval.", "stale edit", "---\nNo deploys on Fridays."]);
    // the edited suggestion, asked about again
    expect(shown.edited).toContain("? Your edit of the model's suggestion: merge both. Apply it?");
    expect(shown.edited).toContain("Deploys never run on Fridays; hotfixes need on-call approval.");
    expect(shown.edited).toContain("e to edit it first");
    expect(prefills[2]).toBe("# about c:bbbb2222|cccc3333\n---\nDeploys never run on Fridays; hotfixes need on-call approval.");
    expect(shown.unsaved).toContain("! Edit closed without saving: the suggestion is as it was.");
    expect(shown.unsaved).toContain("Deploys never run on Fridays; hotfixes need on-call approval.");
    // an edit of a suggestion that went stale drops it
    expect(shown.dropped).toContain("✗ The memories changed after the model read them: the suggestion was dropped. Ask again.");
    expect(shown.dropped).toContain("m ask model");
    expect(shown.retire).toContain("Press m again or y to apply · any other key discards the suggestion");
    expect(shown.discarded).toContain("! Suggestion discarded: nothing changed.");
    expect(prefills).toHaveLength(5);
    // the second keypress applies the suggestion as edited
    expect(shown.final).toContain("No deploys on Fridays.");
    expect(model.applied).toEqual([["c:bbbb2222|cccc3333", { ...(MERGE.ok ? MERGE.plan : {}), text: "No deploys on Fridays.", edited: true }]]);
    expect(shown.done).toContain("✓ Applied the model's suggestion.");
    expect(shown.done).toContain("Nothing to review.");
    expect(model.runs).toEqual([]);
  });
});
