/**
 * Compact TUI-only renderers for realctx2's five agent tools in pi.
 * Display-only: the complete tool text still reaches the model unchanged.
 */
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";

// Untrusted terminal data (queries, memory text, ids): strip ANSI escape and control sequences.
function clean(value: unknown, max = 200): string {
  return String(value ?? "")
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function compact(v: unknown, maxItems = 3): string {
  const items = arr(v);
  const shown = items.slice(0, maxItems).map((x) => clean(x, 64));
  return shown.join(", ") + (items.length > maxItems ? ` +${items.length - maxItems}` : "");
}

class SummaryComponent implements Component {
  private lines: string[];

  constructor(lines: string[]) {
    this.lines = lines;
  }

  set(lines: string[]): this {
    this.lines = lines;
    return this;
  }

  render(width: number): string[] {
    const w = Math.max(1, width);
    return this.lines.map((line) => truncateToWidth(line, w));
  }

  invalidate(): void {}
}

function callSummary(key: string, a: Record<string, unknown>): string {
  const parts: string[] = [];
  if (key === "search") {
    if (a.query) parts.push(clean(a.query, 120));
    if (a.mode === "thorough") parts.push("thorough");
    if (a.where === "project") parts.push("project");
    if (a.path) parts.push(`path ${clean(a.path, 80)}`);
    if (arr(a.scopes).length) parts.push(compact(a.scopes));
    if (arr(a.in).length) parts.push(`in ${compact(a.in)}`);
    if (a.history) parts.push("history");
  } else if (key === "recall") {
    if (a.id) parts.push(clean(a.id, 40));
    if (a.page) parts.push(`page ${clean(a.page, 12)}`);
    if (a.looking_for) parts.push(`for "${clean(a.looking_for, 80)}"`);
  } else if (key === "inspect") {
    if (a.id) parts.push(clean(a.id, 40));
    if (arr(a.include).length) parts.push(compact(a.include, 4));
  } else if (key === "remember") {
    if (a.text) parts.push(clean(a.text, 100));
    if (a.kind) parts.push(clean(a.kind, 24));
    if (a.scope) parts.push(clean(a.scope, 24));
    if (a.urgency) parts.push(clean(a.urgency, 24));
    if (arr(a.paths).length) parts.push(compact(a.paths, 2));
    if (a.pin) parts.push("pin");
  } else if (key === "forget") {
    if (a.target) parts.push(clean(a.target, 80));
    if (a.reason) parts.push(clean(a.reason, 80));
    if (a.purge) parts.push("purge");
  }
  return parts.filter(Boolean).join(" · ");
}

/** Extract `[m:…]` / `[t:…]` / `[r:…]` title lines from raw search text as a fallback when details lack titles. */
function cardTitles(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^\[([mtro]:[0-9a-z]{8})\]\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const id = m[1]!;
    if (map.has(id)) continue;
    const rest = m[2]!.trim();
    const next = (lines[i + 1] ?? "").trim();
    // Memory cards put metadata on the `[m:…]` header line and body on the next line;
    // caption-only hits put the caption right after the ID.
    const looksLikeMeta = /^(?:global|personal|shared)\s*·/.test(rest);
    map.set(id, clean(looksLikeMeta ? next || rest : rest || next, 140));
  }
  return map;
}

export function toolRenderers(key: string, displayName?: string): Pick<ToolDefinition, "renderCall" | "renderResult"> {
  const label = clean(displayName || key, 48);
  return {
    renderCall(args, theme, context) {
      const title = theme.fg("toolTitle", theme.bold(`realctx2 ${label}`));
      const detail = callSummary(key, rec(args));
      const lines = [title + (detail ? `  ${theme.fg("muted", detail)}` : "")];
      return context?.lastComponent instanceof SummaryComponent ? context.lastComponent.set(lines) : new SummaryComponent(lines);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const d = rec(result.details);
      const raw = result.content
        .filter((c) => c.type === "text")
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("\n");
      const muted = (s: string) => theme.fg("muted", s);
      let lines: string[];

      if (context?.isError || (result as { isError?: boolean }).isError || d.error) {
        lines = [theme.fg("error", `✗ ${clean(d.error ?? raw, 240) || "Tool failed"}`)];
      } else if (isPartial) {
        lines = [muted(`⟳ ${clean(raw, 160) || "Working…"}`)];
      } else if (key === "search") {
        const mems = arr(d.memory).map(rec);
        const turns = arr(d.turns).map(rec);
        const titles = cardTitles(raw);
        const mode = d.mode === "thorough" ? "thorough · " : "";
        if (!mems.length && !turns.length) {
          lines = [muted(`${mode}${clean(raw, 160) || "Nothing relevant was found."}`)];
        } else {
          const head: string[] = [];
          if (mems.length) head.push(`${mems.length} memor${mems.length === 1 ? "y" : "ies"}`);
          if (turns.length) head.push(`${turns.length} turn${turns.length === 1 ? "" : "s"}`);
          lines = [muted(`${mode}${head.join(" · ")}`)];
          const entries = [
            ...mems.map((m) => ({ id: clean(m.id, 32), meta: [m.scope, m.kind].filter(Boolean).map((x) => clean(x, 24)).join(" "), preview: titles.get(String(m.id ?? "")) ?? "" })),
            ...turns.map((t) => ({ id: clean(t.id, 32), meta: clean(t.kind, 24), preview: titles.get(String(t.id ?? "")) ?? "" })),
          ];
          const shown = expanded ? entries : entries.slice(0, 6);
          for (const e of shown) {
            const tail = e.preview ? `  ${theme.fg("text", e.preview)}` : e.meta ? `  ${theme.fg("dim", e.meta)}` : "";
            lines.push(`  ${theme.fg("accent", e.id)}${tail}`);
          }
          if (shown.length < entries.length) lines.push(theme.fg("dim", `  +${entries.length - shown.length} more · expand to view all`));
        }
      } else if (key === "recall") {
        const meta: string[] = [];
        if (d.type) meta.push(clean(d.type, 24));
        if (d.scope) meta.push(clean(d.scope, 24));
        if (d.tool) meta.push(clean(d.tool, 32));
        if (typeof d.tokens === "number") meta.push(`${d.tokens} tok`);
        if (typeof d.children === "number") meta.push(`${d.children} items`);
        if (typeof d.page === "number" && typeof d.pages === "number" && d.pages > 1) meta.push(`page ${d.page}/${d.pages}`);
        lines = [`${theme.fg("accent", clean(d.id, 32))}${meta.length ? `  ${muted(meta.join(" · "))}` : ""}`];
        if (expanded) lines.push(...raw.split("\n").slice(0, 80).map((l) => muted(clean(l, 400))));
        else lines.push(theme.fg("dim", "Content sent to model · expand to preview"));
      } else if (key === "inspect") {
        const meta = [d.type, d.scope, d.layer, d.kind, d.status, d.urgency].filter(Boolean).map((x) => clean(x, 24));
        lines = [`${theme.fg("accent", clean(d.id, 32))}${meta.length ? `  ${muted(meta.join(" · "))}` : ""}`];
        if (expanded) lines.push(...raw.split("\n").slice(0, 80).map((l) => muted(clean(l, 400))));
        else lines.push(theme.fg("dim", "Metadata sent to model · expand to preview"));
      } else if (key === "remember") {
        const status = clean(d.status) || "saved";
        const warn = ["skipped", "queued", "conflict", "rejected"].includes(status);
        const head =
          theme.fg(warn ? "warning" : "success", `${warn ? "•" : "✓"} ${status}`) +
          (d.id ? `  ${theme.fg("accent", clean(d.id, 32))}` : "") +
          (d.scope ? `  ${muted(clean(d.scope, 24))}` : "");
        lines = [head];
        if (d.redacted) lines.push(theme.fg("warning", "Secrets were redacted before storing"));
        if (expanded && raw) lines.push(...raw.split("\n").slice(0, 20).map((l) => muted(clean(l, 300))));
      } else if (key === "forget") {
        const status = clean(d.status) || "retired";
        const warn = ["ambiguous", "refused", "missing"].includes(status);
        const head =
          theme.fg(warn ? "warning" : "success", `${warn ? "•" : "✓"} ${status}`) +
          (d.id ? `  ${theme.fg("accent", clean(d.id, 32))}` : "") +
          (d.scope ? `  ${muted(clean(d.scope, 24))}` : "");
        lines = [head];
        if (arr(d.cascade).length) lines.push(muted(`Also retired ${arr(d.cascade).length} dependent memor${arr(d.cascade).length === 1 ? "y" : "ies"}`));
        if (expanded && raw) lines.push(...raw.split("\n").slice(0, 20).map((l) => muted(clean(l, 300))));
      } else {
        lines = [muted(clean(raw, 200) || "Done")];
      }

      return context?.lastComponent instanceof SummaryComponent ? context.lastComponent.set(lines) : new SummaryComponent(lines);
    },
  };
}
