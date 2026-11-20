/**
 * Scrollable, ESC-dismissible TUI report screen for `/realctx2 <command>` output in pi.
 *
 * Displayed via `ctx.ui.custom()` instead of appending entries or messages to the chat
 * transcript, so command reports never pollute session history or interfere with chat rendering.
 */
import type { Component, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { getKeybindings, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export interface ReportTheme {
  fg(color: "accent" | "border" | "borderMuted" | "success" | "error" | "warning" | "muted" | "dim" | "text", text: string): string;
  bold(text: string): string;
}

export interface Realctx2ReportOptions {
  /** Header title, e.g. `"realctx2 status"`. */
  title: string;
  /** Optional subtitle shown on the right when the report fits without scrolling. */
  subtitle?: string;
  /** Plain-text report content (multi-line). */
  content: string;
  /** Visual tone for the header accent (default `"accent"`). */
  tone?: "accent" | "error";
  /** Called when the user dismisses the screen (Esc / q / Enter / Ctrl+C). */
  onClose: () => void;
  theme: ReportTheme;
  tui?: Pick<TUI, "requestRender"> & { terminal?: { rows?: number } };
}

export class Realctx2ReportComponent implements Component {
  readonly capturesViewportInput = true;
  private readonly title: string;
  private readonly subtitle?: string;
  private readonly rawLines: string[];
  private readonly tone: "accent" | "error";
  private readonly onClose: () => void;
  private readonly theme: ReportTheme;
  private readonly tui?: Pick<TUI, "requestRender"> & { terminal?: { rows?: number } };

  private scrollOffset = 0;
  private lastBodyWidth = 76;
  private cachedWrapWidth = -1;
  private cachedWrapped: string[] = [];
  private cachedRenderWidth = -1;
  private cachedRenderScroll = -1;
  private cachedRenderRows = -1;
  private cachedLines: readonly string[] | null = null;

  constructor(opts: Realctx2ReportOptions) {
    this.title = opts.title;
    this.subtitle = opts.subtitle;
    this.rawLines = opts.content.replace(/\r\n?/g, "\n").split("\n");
    this.tone = opts.tone ?? "accent";
    this.onClose = opts.onClose;
    this.theme = opts.theme;
    this.tui = opts.tui;
  }

  private maxBodyRows(): number {
    const rows = this.tui?.terminal?.rows ?? 34;
    // Top border + header + divider + bottom divider + footer + bottom border = 6 lines of chrome.
    return Math.max(6, Math.min(28, rows - 10));
  }

  private wrappedLines(bodyWidth: number): string[] {
    if (this.cachedWrapWidth === bodyWidth) return this.cachedWrapped;
    const out: string[] = [];
    for (const raw of this.rawLines) {
      if (raw.length === 0) {
        out.push("");
        continue;
      }
      const wrapped = wrapTextWithAnsi(raw, bodyWidth);
      if (wrapped.length === 0) out.push("");
      else out.push(...wrapped);
    }
    this.cachedWrapWidth = bodyWidth;
    this.cachedWrapped = out;
    return out;
  }

  private maxScroll(bodyWidth = this.lastBodyWidth): number {
    const total = this.wrappedLines(bodyWidth).length;
    return Math.max(0, total - this.maxBodyRows());
  }

  private scrollTo(next: number): void {
    const clamped = Math.max(0, Math.min(this.maxScroll(), next));
    if (clamped === this.scrollOffset) return;
    this.scrollOffset = clamped;
    this.cachedLines = null;
    this.tui?.requestRender();
  }

  invalidate(): void {
    this.cachedWrapWidth = -1;
    this.cachedWrapped = [];
    this.cachedRenderWidth = -1;
    this.cachedRenderScroll = -1;
    this.cachedRenderRows = -1;
    this.cachedLines = null;
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    if (
      kb.matches(data, "tui.select.cancel") ||
      matchesKey(data, Key.escape) ||
      kb.matches(data, "tui.select.confirm") ||
      matchesKey(data, Key.enter) ||
      matchesKey(data, Key.ctrl("c")) ||
      data === "q" ||
      data === "Q"
    ) {
      this.onClose();
      return;
    }

    const pageStep = Math.max(1, this.maxBodyRows() - 2);
    if (kb.matches(data, "tui.select.up") || data === "k") {
      this.scrollTo(this.scrollOffset - 1);
    } else if (kb.matches(data, "tui.select.down") || data === "j") {
      this.scrollTo(this.scrollOffset + 1);
    } else if (kb.matches(data, "tui.select.pageUp") || data === "b" || matchesKey(data, Key.ctrl("u"))) {
      this.scrollTo(this.scrollOffset - pageStep);
    } else if (kb.matches(data, "tui.select.pageDown") || data === " " || matchesKey(data, Key.ctrl("d"))) {
      this.scrollTo(this.scrollOffset + pageStep);
    } else if (matchesKey(data, Key.home) || data === "g") {
      this.scrollTo(0);
    } else if (matchesKey(data, Key.end) || data === "G") {
      this.scrollTo(this.maxScroll());
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "wheel" && event.wheelDelta) {
      this.scrollTo(this.scrollOffset + event.wheelDelta);
      return { handled: true, render: true };
    }
    return undefined;
  }

  private spreadRow(left: string, right: string, width: number): string {
    const lw = visibleWidth(left);
    const rw = visibleWidth(right);
    if (lw + rw + 2 <= width) return left + " ".repeat(width - lw - rw) + right;
    const maxLeft = Math.max(10, width - rw - 2);
    const truncLeft = truncateToWidth(left, maxLeft);
    const gap = Math.max(1, width - visibleWidth(truncLeft) - rw);
    return truncateToWidth(truncLeft + " ".repeat(gap) + right, width);
  }

  private styleLine(line: string): string {
    const t = this.theme;
    if (line.startsWith("✓ ")) return `${t.fg("success", "✓")} ${line.slice(2)}`;
    if (line.startsWith("! ")) return `${t.fg("warning", "!")} ${line.slice(2)}`;
    if (line.startsWith("✗ ")) return `${t.fg("error", "✗")} ${line.slice(2)}`;
    return line;
  }

  render(width: number): readonly string[] {
    const w = Math.max(30, width);
    const bodyWidth = Math.max(16, w - 4);
    this.lastBodyWidth = bodyWidth;
    const maxRows = this.maxBodyRows();
    const wrapped = this.wrappedLines(bodyWidth);
    const maxOffset = Math.max(0, wrapped.length - maxRows);
    if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset;

    if (
      this.cachedLines &&
      this.cachedRenderWidth === w &&
      this.cachedRenderScroll === this.scrollOffset &&
      this.cachedRenderRows === maxRows
    ) {
      return this.cachedLines;
    }

    const t = this.theme;
    const border = t.fg("border", "─".repeat(w));
    const divider = t.fg("borderMuted", ` ${"┄".repeat(Math.max(1, w - 2))} `);
    const scrollable = wrapped.length > maxRows;
    const visible = scrollable ? wrapped.slice(this.scrollOffset, this.scrollOffset + maxRows) : wrapped;

    const rightHeader = scrollable
      ? t.fg("dim", `lines ${this.scrollOffset + 1}–${this.scrollOffset + visible.length} of ${wrapped.length}`)
      : this.subtitle
        ? t.fg("dim", this.subtitle)
        : "";

    const lines: string[] = [
      border,
      this.spreadRow(` ${t.bold(t.fg(this.tone, this.title))}`, rightHeader ? `${rightHeader} ` : "", w),
      divider,
    ];

    for (const line of visible) {
      lines.push(truncateToWidth(`  ${this.styleLine(line)}`, w));
    }

    lines.push(divider);
    const hint = scrollable
      ? " ↑↓/jk scroll · PgUp/PgDn/Space page · g/G top/end · Esc / q / Enter close"
      : " Esc / q / Enter close";
    lines.push(truncateToWidth(t.fg("dim", hint), w));
    lines.push(border);

    this.cachedRenderWidth = w;
    this.cachedRenderScroll = this.scrollOffset;
    this.cachedRenderRows = maxRows;
    this.cachedLines = lines;
    return lines;
  }
}
