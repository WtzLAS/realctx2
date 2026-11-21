/**
 * The interactive `/realctx2 review` screen in pi's TUI.
 *
 * A list of pending reviews (↑↓ to cycle, Enter for details, ←→ to step through details) with
 * per-item actions. Every action takes two separate keypresses: the first shows exactly what will
 * happen, the second (the same key again, or `y`) carries it out; any other key cancels. An edit
 * opens pi's editor, and the planned changes are confirmed the same way before anything is written.
 */
import type { Component, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { decodeKittyPrintable, getKeybindings, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ReviewActionSpec, ReviewModel, ReviewRow } from "../../commands/review.ts";
import type { ReportTheme } from "./report-ui.ts";

type Tone = "success" | "error" | "warning";

/** Screen state; it outlives one component so the screen can close for the editor and come back as it was. */
export interface ReviewScreenState {
  view: "list" | "detail";
  selected: number;
  scroll: number;
  flash: { text: string; tone: Tone } | null;
  /** The action waiting for its second, separate confirmation. */
  pending: { key: string; action: ReviewActionSpec; edited?: string; summary?: string; preview?: string[] } | null;
}

export type ReviewScreenExit = { kind: "close" } | { kind: "edit"; key: string };

export function initialReviewState(): ReviewScreenState {
  return { view: "list", selected: 0, scroll: 0, flash: null, pending: null };
}

export interface Realctx2ReviewOptions {
  model: ReviewModel;
  state: ReviewScreenState;
  onExit: (exit: ReviewScreenExit) => void;
  theme: ReportTheme;
  tui?: Pick<TUI, "requestRender"> & { terminal?: { rows?: number } };
}

/** A printable key as typed, also under the Kitty keyboard protocol. */
function printable(data: string): string | undefined {
  if (data.length === 1 && data >= " " && data !== "\x7f") return data;
  return decodeKittyPrintable(data);
}

export class Realctx2ReviewComponent implements Component {
  readonly capturesViewportInput = true;
  private readonly model: ReviewModel;
  private readonly state: ReviewScreenState;
  private readonly onExit: (exit: ReviewScreenExit) => void;
  private readonly theme: ReportTheme;
  private readonly tui?: Pick<TUI, "requestRender"> & { terminal?: { rows?: number } };
  private rows: ReviewRow[];
  private exited = false;
  private version = 0;
  private cache: { key: string; lines: readonly string[] } | null = null;
  private lastDetailWidth = 76;
  private detailCache: { key: string; width: number; lines: string[] } | null = null;

  constructor(opts: Realctx2ReviewOptions) {
    this.model = opts.model;
    this.state = opts.state;
    this.onExit = opts.onExit;
    this.theme = opts.theme;
    this.tui = opts.tui;
    this.rows = this.model.rows();
    this.clamp();
  }

  // ───────────── state helpers
  private changed(): void {
    this.version++;
    this.cache = null;
    this.tui?.requestRender();
  }

  private clamp(): void {
    const s = this.state;
    if (!this.rows.length) {
      s.selected = 0;
      s.view = "list";
      s.scroll = 0;
      return;
    }
    s.selected = Math.max(0, Math.min(this.rows.length - 1, s.selected));
  }

  private current(): ReviewRow | undefined {
    return this.rows[this.state.selected];
  }

  private reload(): void {
    this.rows = this.model.rows();
    this.detailCache = null;
    this.clamp();
  }

  private exit(x: ReviewScreenExit): void {
    if (this.exited) return;
    this.exited = true;
    this.onExit(x);
  }

  private bodyRows(): number {
    const rows = this.tui?.terminal?.rows ?? 34;
    return Math.max(6, Math.min(30, rows - 12));
  }

  invalidate(): void {
    this.cache = null;
    this.detailCache = null;
  }

  // ───────────── input
  handleInput(data: string): void {
    if (this.exited) return;
    const s = this.state;
    const kb = getKeybindings();
    const ch = printable(data);
    if (s.pending) {
      this.answerConfirmation(ch);
      this.changed();
      return;
    }
    if (matchesKey(data, Key.ctrl("c"))) return this.exit({ kind: "close" });
    s.flash = null;
    const cancel = kb.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape);
    const up = kb.matches(data, "tui.select.up") || ch === "k";
    const down = kb.matches(data, "tui.select.down") || ch === "j";
    const next = matchesKey(data, Key.right) || matchesKey(data, Key.tab) || ch === "l" || ch === "n";
    const prev = matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab")) || ch === "h" || ch === "N";
    if (s.view === "list") {
      if (cancel || ch === "q" || ch === "Q") return this.exit({ kind: "close" });
      if (up || prev) this.move(-1);
      else if (down || next) this.move(1);
      else if (kb.matches(data, "tui.select.pageUp")) this.move(-this.bodyRows(), false);
      else if (kb.matches(data, "tui.select.pageDown")) this.move(this.bodyRows(), false);
      else if (matchesKey(data, Key.home) || ch === "g") this.state.selected = 0;
      else if (matchesKey(data, Key.end) || ch === "G") this.state.selected = Math.max(0, this.rows.length - 1);
      else if ((kb.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter)) && this.current()) {
        s.view = "detail";
        s.scroll = 0;
      } else if (ch === "r") this.refresh();
      else if (ch) this.startAction(ch);
    } else {
      if (cancel || matchesKey(data, Key.backspace) || kb.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter)) {
        s.view = "list";
        s.scroll = 0;
      } else if (ch === "q" || ch === "Q") return this.exit({ kind: "close" });
      else if (next) this.move(1);
      else if (prev) this.move(-1);
      else if (up) this.scrollTo(s.scroll - 1);
      else if (down) this.scrollTo(s.scroll + 1);
      else if (kb.matches(data, "tui.select.pageUp") || ch === "b") this.scrollTo(s.scroll - Math.max(1, this.bodyRows() - 2));
      else if (kb.matches(data, "tui.select.pageDown") || ch === " ") this.scrollTo(s.scroll + Math.max(1, this.bodyRows() - 2));
      else if (matchesKey(data, Key.home) || ch === "g") this.scrollTo(0);
      else if (matchesKey(data, Key.end) || ch === "G") this.scrollTo(Number.MAX_SAFE_INTEGER);
      else if (ch === "r") this.refresh();
      else if (ch) this.startAction(ch);
    }
    if (!this.exited) this.changed();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.exited || this.state.pending || event.type !== "wheel" || !event.wheelDelta) return undefined;
    if (this.state.view === "list") this.move(event.wheelDelta < 0 ? -1 : 1, false);
    else this.scrollTo(this.state.scroll + event.wheelDelta);
    this.changed();
    return { handled: true, render: true };
  }

  private move(delta: number, wrap = true): void {
    const n = this.rows.length;
    if (!n) return;
    const s = this.state;
    s.selected = wrap ? (((s.selected + delta) % n) + n) % n : Math.max(0, Math.min(n - 1, s.selected + delta));
    s.scroll = 0;
  }

  private scrollTo(next: number): void {
    const total = this.detailLines(this.lastDetailWidth).length;
    this.state.scroll = Math.max(0, Math.min(Math.max(0, total - this.bodyRows()), next));
  }

  private refresh(): void {
    this.model.refresh();
    this.reload();
    this.state.flash = { text: `Refreshed: ${this.rows.length} pending.`, tone: "success" };
  }

  private startAction(ch: string): void {
    const row = this.current();
    if (!row) return;
    const action = this.model.actions(row.key).find((a) => a.key === ch);
    if (!action) return;
    if (action.edit) {
      // the editor opens first; what it would change is confirmed when the screen comes back
      this.exit({ kind: "edit", key: row.key });
      return;
    }
    this.state.pending = { key: row.key, action };
  }

  private answerConfirmation(ch: string | undefined): void {
    const s = this.state;
    const p = s.pending!;
    s.pending = null;
    if (ch !== p.action.key && ch !== "y" && ch !== "Y") {
      s.flash = { text: p.edited !== undefined ? "Edit discarded: nothing changed." : `Cancelled: ${p.action.label} was not applied.`, tone: "warning" };
      return;
    }
    const out = p.edited !== undefined ? this.model.applyEdit(p.key, p.edited) : this.model.run(p.key, p.action.id);
    s.flash = { text: out.message, tone: out.ok ? "success" : "error" };
    s.scroll = 0;
    this.reload();
  }

  // ───────────── rendering
  private detailLines(width: number): string[] {
    const row = this.current();
    if (!row) return [];
    if (this.detailCache && this.detailCache.key === row.key && this.detailCache.width === width) return this.detailCache.lines;
    const t = this.theme;
    const out: string[] = [];
    const raw = this.model.details(row.key).replace(/\r\n?/g, "\n").split("\n");
    raw.forEach((line, i) => {
      if (!line.trim()) return void out.push("");
      // continuation lines keep the indentation of the line they wrap
      const pad = /^\s*/.exec(line)![0];
      const body = line.slice(pad.length);
      const styled = body.startsWith("! ")
        ? `${t.fg("warning", "!")} ${body.slice(2)}`
        : i === 0
          ? t.bold(t.fg("accent", body))
          : pad
            ? body
            : t.bold(body);
      const wrapped = wrapTextWithAnsi(styled, Math.max(10, width - pad.length));
      out.push(...(wrapped.length ? wrapped : [""]).map((l) => pad + l));
    });
    this.detailCache = { key: row.key, width, lines: out };
    return out;
  }

  private spread(left: string, right: string, width: number): string {
    const lw = visibleWidth(left);
    const rw = visibleWidth(right);
    if (lw + rw + 2 <= width) return left + " ".repeat(width - lw - rw) + right;
    const l = truncateToWidth(left, Math.max(10, width - rw - 2));
    return truncateToWidth(l + " ".repeat(Math.max(1, width - visibleWidth(l) - rw)) + right, width);
  }

  private listLines(width: number, budget: number): string[] {
    const t = this.theme;
    if (!this.rows.length) return [t.fg("success", "✓ Nothing to review."), "", t.fg("dim", "Press r to look again, or Esc to close.")];
    const labelW = Math.min(24, Math.max(...this.rows.map((r) => visibleWidth(r.label))));
    const idW = Math.max(0, ...this.rows.map((r) => visibleWidth(r.id)));
    const summaryRows = 2;
    const slots = Math.max(3, budget - summaryRows - 1);
    const s = this.state;
    const start = Math.max(0, Math.min(s.selected - Math.floor(slots / 2), this.rows.length - slots));
    const out: string[] = [];
    for (let i = start; i < Math.min(this.rows.length, start + slots); i++) {
      const r = this.rows[i]!;
      const sel = i === s.selected;
      const label = truncateToWidth(r.label, labelW);
      const labelCell = t.fg(r.tone, label + " ".repeat(Math.max(0, labelW - visibleWidth(label))));
      const idCell = r.id ? t.fg("dim", r.id + " ".repeat(Math.max(0, idW - visibleWidth(r.id)))) : " ".repeat(idW);
      const left = `${sel ? t.fg("accent", "›") : " "} ${labelCell}  ${idCell} ${sel ? t.bold(r.title) : r.title}`;
      out.push(this.spread(left, t.fg("dim", r.meta), width));
    }
    if (this.rows.length > slots) out.push(t.fg("dim", `  ${start + 1}–${Math.min(this.rows.length, start + slots)} of ${this.rows.length}`));
    const cur = this.current();
    if (cur) {
      out.push("");
      const wrapped = wrapTextWithAnsi(t.fg("muted", cur.summary), Math.max(10, width - 2)).slice(0, summaryRows);
      out.push(...wrapped.map((l) => ` ${l}`));
    }
    return out;
  }

  private confirmationLines(width: number): string[] {
    const t = this.theme;
    const p = this.state.pending;
    if (p) {
      const head = p.edited !== undefined ? `Apply edit to ${p.summary ?? "the memory"}?` : p.action.confirm;
      const out = wrapTextWithAnsi(`${t.fg(p.action.destructive ? "warning" : "accent", "?")} ${t.bold(head)}`, width - 2).map((l) => ` ${l}`);
      for (const l of (p.preview ?? []).slice(0, 8)) out.push(truncateToWidth(`   ${l.startsWith("! ") ? t.fg("warning", l) : t.fg("muted", l)}`, width));
      if ((p.preview?.length ?? 0) > 8) out.push(t.fg("dim", `   (+${p.preview!.length - 8} more lines)`));
      out.push(` ${t.fg("accent", `Press ${p.action.key} again or y to ${p.edited !== undefined ? "apply" : "confirm"}`)}${t.fg("dim", ` · any other key ${p.edited !== undefined ? "discards the edit" : "cancels"}`)}`);
      return out;
    }
    const f = this.state.flash;
    if (!f) return [];
    const mark = f.tone === "success" ? "✓" : f.tone === "error" ? "✗" : "!";
    return wrapTextWithAnsi(`${t.fg(f.tone, mark)} ${f.text}`, width - 2).slice(0, 3).map((l) => ` ${l}`);
  }

  render(width: number): readonly string[] {
    const w = Math.max(40, width);
    const rowsBudget = this.bodyRows();
    const key = `${w}|${rowsBudget}|${this.version}`;
    if (this.cache?.key === key) return this.cache.lines;
    const t = this.theme;
    const s = this.state;
    const border = t.fg("border", "─".repeat(w));
    const divider = t.fg("borderMuted", ` ${"┄".repeat(Math.max(1, w - 2))} `);
    const cur = this.current();
    const lines: string[] = [border];
    const position = this.rows.length ? `${s.selected + 1} of ${this.rows.length}` : "nothing pending";
    let body: string[];
    if (s.view === "detail" && cur) {
      const bodyW = Math.max(16, w - 4);
      this.lastDetailWidth = bodyW;
      const all = this.detailLines(bodyW);
      const maxScroll = Math.max(0, all.length - rowsBudget);
      if (s.scroll > maxScroll) s.scroll = maxScroll;
      body = all.slice(s.scroll, s.scroll + rowsBudget).map((l) => `  ${l}`);
      const range = all.length > rowsBudget ? ` · lines ${s.scroll + 1}–${s.scroll + body.length} of ${all.length}` : "";
      lines.push(this.spread(` ${t.bold(t.fg("accent", this.model.title))} ${t.fg("dim", "›")} ${t.fg(cur.tone, cur.label)} ${t.fg("dim", cur.id)}`, `${t.fg("dim", position + range)} `, w));
    } else {
      body = this.listLines(w - 2, rowsBudget).map((l) => ` ${l}`);
      const sub = this.model.subtitle ? `${this.model.subtitle} · ` : "";
      lines.push(this.spread(` ${t.bold(t.fg("accent", this.model.title))}`, `${t.fg("dim", `${sub}${this.rows.length} pending${this.rows.length ? ` · ${position}` : ""}`)} `, w));
    }
    lines.push(divider);
    for (const l of body) lines.push(truncateToWidth(l, w));
    const confirm = this.confirmationLines(w);
    const hints = this.hints();
    lines.push(divider);
    if (confirm.length) {
      for (const l of confirm) lines.push(truncateToWidth(l, w));
      if (hints.length) lines.push(divider);
    }
    for (const hint of hints) lines.push(truncateToWidth(t.fg("dim", ` ${hint}`), w));
    lines.push(border);
    this.cache = { key, lines };
    return lines;
  }

  private hints(): string[] {
    if (this.state.pending) return [];
    const cur = this.current();
    const acts = cur ? this.model.actions(cur.key).map((a) => `${a.key} ${a.label}`) : [];
    const nav =
      this.state.view === "detail"
        ? "←→ previous/next · ↑↓ scroll · PgUp/PgDn page · r refresh · Esc back · q close"
        : this.rows.length
          ? "↑↓ select · Enter details · r refresh · Esc close"
          : "r refresh · Esc close";
    return acts.length ? [`${acts.join(" · ")}   (each asks to confirm)`, nav] : [nav];
  }
}

/**
 * Run the review screen until the user closes it. It closes for pi's editor when the user edits an
 * item and comes back with the planned changes waiting for confirmation.
 */
export async function runReviewScreen(
  model: ReviewModel,
  ui: {
    custom(factory: (tui: Realctx2ReviewOptions["tui"], theme: ReportTheme, done: (exit: ReviewScreenExit) => void) => Component): Promise<ReviewScreenExit | undefined>;
    editor(title: string, prefill: string): Promise<string | undefined>;
  },
  state: ReviewScreenState = initialReviewState(),
): Promise<void> {
  for (;;) {
    const exit = await ui.custom((tui, theme, done) => new Realctx2ReviewComponent({ model, state, onExit: done, theme, tui }));
    if (!exit || exit.kind === "close") return;
    const form = model.editForm(exit.key);
    const spec = model.actions(exit.key).find((a) => a.edit);
    if (!form || !spec) {
      state.flash = { text: "This item can no longer be edited.", tone: "error" };
      continue;
    }
    const edited = await ui.editor(form.title, form.prefill);
    if (edited === undefined) {
      state.flash = { text: "Edit cancelled: nothing changed.", tone: "warning" };
      continue;
    }
    const plan = model.planEdit(exit.key, edited);
    if (!plan.ok) {
      state.flash = { text: plan.message, tone: "error" };
      continue;
    }
    state.flash = null;
    state.pending = { key: exit.key, action: spec, edited, summary: plan.summary, preview: plan.preview };
  }
}
