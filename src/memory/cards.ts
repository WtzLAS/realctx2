/** Deterministic memory cards (§6.4.5). Cards are data, never instructions. */
import type { MemoryNode, ScopedNode } from "../core/types.ts";
import { bracket } from "../util/ids.ts";
import { estimateTokens } from "../util/text.ts";
import { type MemoryGraph, scopeLabel } from "./graph.ts";
import type { PathTracker } from "./paths.ts";
import { memoryWorth } from "./strength.ts";

export interface CardOptions {
  /** History queries show supersession markers. */
  history?: boolean;
  /** One-line form: the memory's title (§6.10). */
  caption?: boolean;
  /** Maximum evidence quotes shown. */
  quotes?: number;
  /** Show the full text even when it is long (recall). */
  full?: boolean;
}

export function day(iso: string | undefined): string {
  return iso ? iso.slice(0, 10) : "?";
}

export function mid(node: MemoryNode): string {
  return bracket("m", node.id);
}

export function captionLine(ref: ScopedNode): string {
  return `${mid(ref.node)} ${ref.node.title || ref.node.text.split("\n")[0]}`;
}

export function cardHeader(ref: ScopedNode, graph: MemoryGraph, paths?: PathTracker): string {
  const n = ref.node;
  const parts = [scopeLabel(ref.scope), n.layer === "long" ? "long-term" : "short-term"];
  if (n.kind !== "fact") parts.push(n.kind === "rule" && n.severity ? `rule ${n.severity.toUpperCase()}` : n.kind);
  parts.push(`as of ${day(n.validFrom ?? n.createdAt)}`);
  const used = Math.round(n.counters.used);
  if (used > 0) parts.push(`used ${used}×`);
  const { mw, evidence } = memoryWorth(n.counters);
  if (evidence >= 1) parts.push(`MW ${mw.toFixed(2)}`);
  if (n.evaluation && n.evaluation !== "neutral") parts.push(`[${n.evaluation}]`);
  if (paths) {
    const at = paths.displayAnchors(ref).filter((a) => a.at && a.anchor.status === "live").map((a) => a.at!);
    if (at.length) parts.push(at.slice(0, 2).join(", ") + (at.length > 2 ? ` +${at.length - 2}` : ""));
  } else void graph;
  return `${mid(n)} ${parts.join(" · ")}`;
}

/**
 * ```
 * [m:7f3a9k2d] shared · long-term · as of 2026-10-02 · used 7× · MW 0.78
 * TokenCache.refresh must be single-flight; concurrent refreshes race on `pending`.
 *   "if (!this.pending) this.pending = fetchToken()" — src/auth/tokenCache.ts:88
 * ```
 */
export function renderCard(ref: ScopedNode, graph: MemoryGraph, paths: PathTracker | undefined, opts: CardOptions = {}): string {
  if (opts.caption) return captionLine(ref);
  const n = ref.node;
  const lines = [cardHeader(ref, graph, paths)];
  lines.push(n.text);
  const quotes = n.evidence.slice(0, opts.quotes ?? 1);
  for (const e of quotes) {
    const src = e.source.ref ? ` — ${e.source.ref}` : "";
    lines.push(`  "${e.quote.replace(/\s+/g, " ").slice(0, opts.full ? 600 : 240)}"${src}${e.verified ? "" : " ⚠ quote unverified"}`);
  }
  if (!opts.full && n.evidence.length > quotes.length) lines.push(`  (+${n.evidence.length - quotes.length} more quote${n.evidence.length - quotes.length > 1 ? "s" : ""}: inspect)`);
  const by = graph.supersededBy(ref);
  if (by && opts.history) lines.push(`⟂ superseded by ${mid(by.node)} on ${day(n.validTo ?? by.node.validFrom ?? by.node.createdAt)}`);
  else if (n.validTo && opts.history) lines.push(`⟂ no longer current since ${day(n.validTo)}`);
  for (const other of graph.contradictions(ref)) lines.push(`⚠ conflicts with ${mid(other.node)} (${scopeLabel(other.scope)}, as of ${day(other.node.validFrom ?? other.node.createdAt)})`);
  if (paths?.displayAnchors(ref).some((a) => a.anchor.kind !== "glob" && a.anchor.kind !== "subtree" && a.anchor.seenBlob && a.entry?.data.blob && a.anchor.seenBlob !== a.entry.data.blob)) lines.push("⚠ file changed since this note");
  if (n.status !== "active") lines.push(`(${n.status}${n.statusReason ? `: ${n.statusReason}` : ""})`);
  return lines.join("\n");
}

/** Render cards into a token budget; cards that do not fit fall back to captions, then to a count. */
export function renderCards(refs: ScopedNode[], graph: MemoryGraph, paths: PathTracker | undefined, opts: CardOptions & { budgetTokens: number; captionIds?: Set<string> }): { text: string; shown: Array<{ ref: ScopedNode; full: boolean; tokens: number }>; omitted: number } {
  const blocks: string[] = [];
  const shown: Array<{ ref: ScopedNode; full: boolean; tokens: number }> = [];
  let used = 0;
  let omitted = 0;
  for (const ref of refs) {
    const wantCaption = opts.captionIds?.has(ref.node.id) ?? false;
    let block = renderCard(ref, graph, paths, { ...opts, caption: wantCaption });
    let tokens = estimateTokens(block);
    let full = !wantCaption;
    if (used + tokens > opts.budgetTokens && full) {
      block = captionLine(ref);
      tokens = estimateTokens(block);
      full = false;
    }
    if (used + tokens > opts.budgetTokens) {
      omitted++;
      continue;
    }
    used += tokens;
    blocks.push(block);
    shown.push({ ref, full, tokens });
  }
  return { text: blocks.join("\n\n"), shown, omitted };
}
