/** Deterministic rendering: transcript excerpts for model evidence, guidance and consolidated messages. */
import type { EntryView, Intent, IntentOutcome, KnowledgeItem } from "../core/types.ts";
import { clipTokens, estimateTokens, headTail } from "../util/text.ts";
import type { Unit } from "./rounds.ts";
import type { SessionState } from "./state.ts";

export const GUIDANCE_TYPE = "realctx2.guidance";

function args(a: Record<string, unknown>, max = 400): string {
  let s: string;
  try {
    s = JSON.stringify(a);
  } catch {
    s = String(a);
  }
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** One entry as transcript text. Tool outputs are cut to their head and tail. */
export function renderEntry(e: EntryView, opts: { toolOutputTokens?: number; textTokens?: number; ids?: boolean; raw?: boolean } = {}): string {
  const text = opts.raw ? e.rawText : e.text;
  const cut = opts.toolOutputTokens ?? 300;
  const tag = opts.ids ? `[${e.id}] ` : "";
  if (e.kind === "assistant") {
    const calls = ((opts.raw ? e.rawToolCalls : undefined) ?? e.toolCalls ?? []).map((c) => `→ ${c.name}(${args(c.args)})`).join("\n");
    const body = opts.textTokens ? clipTokens(text, opts.textTokens) : text;
    return `${tag}assistant: ${[body.trim(), calls].filter(Boolean).join("\n")}`;
  }
  if (e.kind === "toolResult") return `${tag}tool ${e.toolName ?? "result"}${e.isError ? " (error)" : ""}: ${headTail(text, cut, cut)}`;
  if (e.kind === "user") return `${tag}user: ${opts.textTokens ? clipTokens(text, opts.textTokens) : text}`;
  if (e.kind === "custom_message") return `${tag}${text}`;
  return `${tag}${e.kind}: ${opts.textTokens ? clipTokens(text, opts.textTokens) : text}`;
}

/** A span of entries as transcript text, skipping entries that are omitted from context. */
export function renderSpan(entries: EntryView[], from: number, to: number, opts: { toolOutputTokens?: number; textTokens?: number; ids?: boolean; maxTokens?: number } = {}): string {
  const parts: string[] = [];
  for (let i = from; i < to; i++) {
    const e = entries[i]!;
    if (e.omitted) continue;
    parts.push(renderEntry(e, opts));
  }
  let text = parts.join("\n");
  if (opts.maxTokens && estimateTokens(text) > opts.maxTokens) {
    // drop older material first: keep the tail, where the evidence that matters usually is
    const keep = opts.maxTokens * 4;
    text = `[… earlier part cut …]\n${text.slice(text.length - keep)}`;
  }
  return text;
}

/** The last `n` rounds (with whatever sits between them), for Janus and the scribe. */
export function lastRounds(entries: EntryView[], units: Unit[], n: number): { from: number; to: number } {
  let rounds = 0;
  let from = entries.length;
  for (let u = units.length - 1; u >= 0; u--) {
    from = units[u]!.start;
    if (units[u]!.round) rounds++;
    if (rounds >= n) break;
  }
  return { from, to: entries.length };
}

/** The intent stack as an indented hierarchy, with conditions and age in rounds. */
export function renderStack(stack: Intent[], round: number): string {
  if (!stack.length) return "(no open intent)";
  return stack
    .map((i, d) => {
      const pad = "  ".repeat(d);
      return [`${pad}- [${i.id}] ${i.label} (open for ${Math.max(0, round - i.openedRound)} rounds)`, `${pad}  why: ${i.reason}`, `${pad}  done when: ${i.success}`, `${pad}  give up when: ${i.failure}`].join("\n");
    })
    .join("\n");
}

const OUTCOME_WORD: Record<IntentOutcome, string> = { success: "succeeded", failure: "failed", abandoned: "set aside" };

export function outcomeWord(o: IntentOutcome): string {
  return OUTCOME_WORD[o];
}

/**
 * Guidance message (§5.2.6): a template, no LLM call, in the first person.
 * Phrased as facts about my own state rather than commands.
 */
export function renderGuidance(g: { closed: Array<{ intent: Intent; outcome: IntentOutcome }>; kindled?: Intent | null; parentLabel?: string; backTo?: Intent | null; cards?: string; paths?: string }): string {
  const lines: string[] = [];
  const closed = g.closed.map((c) => `I finished "${c.intent.label}": ${OUTCOME_WORD[c.outcome]}.`);
  lines.push(`[intent] ${closed.join(" ")}`.trimEnd());
  if (g.kindled) {
    const k = g.kindled;
    lines.push(`I'm now working on "${k.label}"${g.parentLabel ? ` (inside: ${g.parentLabel})` : ""}.`);
    if (k.reason) lines.push(`Why: ${k.reason}`);
    if (k.success) lines.push(`Done when: ${k.success}`);
    if (k.failure) lines.push(`Give up when: ${k.failure}`);
  } else if (g.backTo) lines.push(`I'm back to "${g.backTo.label}". Done when: ${g.backTo.success}`);
  if (lines[0] === "[intent]") lines[0] = `[intent] ${lines.splice(1, 1)[0] ?? ""}`.trimEnd();
  if (g.cards) lines.push(`Memory that may help:\n${g.cards}`);
  if (g.paths) lines.push(g.paths);
  return lines.join("\n");
}

/** Proactive cards that were not ready when their intent was kindled (aux-emulated gate, §9.1.4). */
export function renderLateCards(i: Intent, cards: string): string {
  return `[intent] Memory that may help with "${i.label}":\n${cards}`;
}

export function renderReminder(i: Intent, parentLabel?: string): string {
  return `[intent] Still working on "${i.label}"${parentLabel ? ` (inside: ${parentLabel})` : ""}. Done when: ${i.success} Give up when: ${i.failure}`;
}

/** `[t:c7f3a2e8 · intent "…" · succeeded · details archived]` + first-person prose. */
export function renderPrecip(id: string, intent: Intent, outcome: IntentOutcome, memory: string): string {
  return `[${id} · intent "${intent.label}" · ${OUTCOME_WORD[outcome]} · details archived]\n${memory.trim()}`;
}

export function renderKnowledge(items: KnowledgeItem[]): string {
  return items.map((k) => `- [${k.evaluation}] ${k.fact}${k.as_of ? ` (as of ${k.as_of})` : ""}${k.supersedes ? ` (replaces: ${k.supersedes})` : ""}`).join("\n");
}

/** `[t:19b2c0mk · consolidated earlier work]` + narrative + knowledge. */
export function renderPalim(id: string, narrative: string, knowledge: KnowledgeItem[], kind: "palim" | "compaction" = "palim"): string {
  const head = `[${id} · ${kind === "compaction" ? "compacted earlier work" : "consolidated earlier work"}]`;
  return [head, `Narrative: ${narrative.trim()}`, ...(knowledge.length ? ["Knowledge:", renderKnowledge(knowledge)] : [])].join("\n");
}

/**
 * Post-compaction injection for append-only harnesses (§4.6.3), within a token budget:
 * open intents with their conditions, consolidated memories of closed intents (newest first,
 * with their `t:` IDs), then Palim's knowledge items.
 */
export function renderReinjection(state: SessionState, budgetTokens: number): string {
  const parts: string[] = [];
  let used = 0;
  const push = (text: string): boolean => {
    const t = estimateTokens(text);
    if (used + t > budgetTokens) return false;
    used += t;
    parts.push(text);
    return true;
  };
  if (state.stack.length) {
    push(`[intent] My open purposes, outermost first:\n${state.stack.map((i, d) => `${"  ".repeat(d)}- "${i.label}". Done when: ${i.success} Give up when: ${i.failure}`).join("\n")}`);
  }
  // consolidated memories of closed intents, newest first, each with its t: ID
  const all = [...state.records.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1));
  for (const r of all.filter((x) => x.kind === "precip" && x.text)) if (!push(r.text!)) break;
  const seen = new Set<string>();
  const knowledge: KnowledgeItem[] = [];
  for (const r of all) for (const k of r.knowledge ?? []) {
    const key = k.fact.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    knowledge.push(k);
  }
  if (knowledge.length) {
    const lines: string[] = [];
    let t = estimateTokens("Knowledge kept from earlier work:");
    for (const k of knowledge) {
      const line = renderKnowledge([k]);
      const lt = estimateTokens(line);
      if (used + t + lt > budgetTokens) break;
      t += lt;
      lines.push(line);
    }
    if (lines.length) push(`Knowledge kept from earlier work:\n${lines.join("\n")}`);
  }
  return parts.join("\n\n");
}
