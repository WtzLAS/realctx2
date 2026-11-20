/**
 * Rounds and the working tail (§5.4.1).
 * A round is one assistant message with the results of its tool calls. Other entries (user
 * messages, guidance, consolidated messages) are units of their own.
 */
import type { Config } from "../core/config.ts";
import { scaledContext } from "../core/config.ts";
import type { EntryView } from "../core/types.ts";
import { quantile } from "../util/text.ts";

export interface Unit {
  /** Index of the first entry of the unit in the entry list. */
  start: number;
  /** Index one past the last entry. */
  end: number;
  /** True for an assistant message with its tool results. */
  round: boolean;
  /** False while some tool call has no result yet. */
  complete: boolean;
  tokens: number;
}

/** Split the entry list into units. Tool results always stay with the assistant message that called them. */
export function toUnits(entries: EntryView[]): Unit[] {
  const answered = new Set<string>();
  for (const e of entries) if (e.kind === "toolResult" && e.toolCallId) answered.add(e.toolCallId);
  const units: Unit[] = [];
  let i = 0;
  while (i < entries.length) {
    const e = entries[i]!;
    if (e.kind === "assistant") {
      const want = new Set((e.toolCalls ?? []).map((c) => c.id));
      let j = i + 1;
      let tokens = e.tokens;
      while (j < entries.length && entries[j]!.kind === "toolResult") {
        if (entries[j]!.toolCallId) want.delete(entries[j]!.toolCallId!);
        tokens += entries[j]!.tokens;
        j++;
      }
      // A tool call that never gets a result anywhere in the transcript (harness restarted or
      // aborted mid-call) is closed by the next non-result entry, matching pi-ai's synthetic
      // "No result provided" result. Calls at the end of the transcript stay open (still running),
      // and calls answered out-of-order later stay open so they are not cut from their result.
      if (want.size > 0 && j < entries.length) {
        for (const id of want) if (!answered.has(id)) want.delete(id);
      }
      units.push({ start: i, end: j, round: true, complete: want.size === 0, tokens });
      i = j;
    } else if (e.kind === "toolResult") {
      // an orphan tool result (its call was compacted away): keep it with the previous unit when there is one
      const prev = units[units.length - 1];
      if (prev) {
        prev.end = i + 1;
        prev.tokens += e.tokens;
      } else units.push({ start: i, end: i + 1, round: false, complete: true, tokens: e.tokens });
      i++;
    } else {
      units.push({ start: i, end: i + 1, round: false, complete: true, tokens: e.tokens });
      i++;
    }
  }
  return units;
}

export function roundCount(units: Unit[]): number {
  let n = 0;
  for (const u of units) if (u.round) n++;
  return n;
}

/** Number of rounds that end at or before entry index `idx`. */
export function roundsBefore(units: Unit[], idx: number): number {
  let n = 0;
  for (const u of units) if (u.round && u.end <= idx) n++;
  return n;
}

/** B = min{ αW, max{ B_min, K · Quantile_q(𝓡) } }. */
export function tailBudget(cfg: Config, window: number, roundTokens: number[], modelName?: string): number {
  const s = scaledContext(cfg, window, modelName);
  const q = roundTokens.length ? quantile(roundTokens, cfg.context.q) : 0;
  return Math.min(cfg.context.alpha * s.W, Math.max(s.Bmin, cfg.context.K * q));
}

export interface Tail {
  /** Index of the first entry of the working tail. */
  start: number;
  tokens: number;
  rounds: number;
}

/**
 * The working tail: the shortest suffix holding at least K rounds and at least B tokens.
 * Unfinished rounds and the latest round are always protected.
 * `minimal` shrinks it to unfinished rounds and the latest round only (pressure step 3).
 */
export function workingTail(entries: EntryView[], units: Unit[], cfg: Config, window: number, roundTokens: number[], opts: { minimal?: boolean; modelName?: string } = {}): Tail {
  if (!units.length) return { start: entries.length, tokens: 0, rounds: 0 };
  const B = opts.minimal ? 0 : tailBudget(cfg, window, roundTokens, opts.modelName);
  const K = opts.minimal ? 1 : cfg.context.K;
  let start = entries.length;
  let tokens = 0;
  let rounds = 0;
  // an unfinished round, and everything after it, is always protected
  const firstUnfinished = units.findIndex((x) => x.round && !x.complete);
  for (let u = units.length - 1; u >= 0; u--) {
    const unit = units[u]!;
    const need = rounds < K || tokens < B || (firstUnfinished >= 0 && u >= firstUnfinished);
    if (!need) break;
    start = unit.start;
    tokens += unit.tokens;
    if (unit.round) rounds++;
  }
  return { start, tokens, rounds };
}

/** Index of the first entry of the latest round (it may carry reasoning the provider needs back unmodified). */
export function latestRoundStart(units: Unit[], total: number): number {
  for (let u = units.length - 1; u >= 0; u--) if (units[u]!.round) return units[u]!.start;
  return total;
}

/**
 * Restrict [from, to) to complete units: no round is cut, and every tool call keeps its result.
 * Returns null when nothing is left.
 */
export function alignToUnits(units: Unit[], from: number, to: number): [number, number] | null {
  let a = -1;
  let b = -1;
  for (const u of units) {
    if (u.start >= from && u.end <= to && u.complete) {
      if (a < 0) a = u.start;
      b = u.end;
    } else if (a >= 0 && u.start < to) {
      // a unit that does not fit ends the span: spans are contiguous
      if (u.start >= b) break;
    }
  }
  return a >= 0 && b > a ? [a, b] : null;
}

export function sumTokens(entries: EntryView[], from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i++) if (!entries[i]!.omitted) n += entries[i]!.tokens;
  return n;
}
