/** The `/realctx2 review` screen in pi's TUI: browsing, details, and two-step confirmation of every action. */
import { describe, expect, it } from "vitest";
import { initialReviewState, Realctx2ReviewComponent, type ReviewScreenExit, type ReviewScreenState, runReviewScreen } from "../src/adapters/pi/review-ui.ts";
import type { ReviewActionId, ReviewActionSpec, ReviewEditPreview, ReviewModel, ReviewOutcome, ReviewRow } from "../src/commands/review.ts";

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
});
