/**
 * Strength, importance, retention and Memory Worth (§6.5.1–§6.5.3, §6.7).
 * Everything here is a pure function of a node, so every machine derives the same values.
 */
import { COUNTER_NAMES, type MemoryNode, type StrengthEvent, type UseCounters } from "../core/types.ts";
import { clamp, daysBetween } from "../util/text.ts";

const LAMBDA_BASE = 0.1; // per day (F)
const MU = 1.0; // importance modulation (ours)
const BETA = { short: 1.2, long: 0.8 } as const; // decay shape (F)
const DELTA_V = 0.25;
const N_REINFORCE = 5;
const FOLD_SAFETY_DAYS = 14;
export const V0 = { normal: 0.6, pinned: 1.0, explicit: 0.8 } as const;
export const THETA_PROMOTE = 0.7;
export const THETA_DEMOTE = 0.3;

function decayRate(importance: number, divisor = 1): number {
  return (LAMBDA_BASE * Math.exp(-MU * clamp(importance, 0, 1))) / Math.max(1, divisor);
}

/** v(t) = v_ref · exp(−λ · [(t − τ)^β − (t_ref − τ)^β]), with times in days since creation. */
function decay(vRef: number, tRef: string, t: string, created: string, lambda: number, beta: number): number {
  const a = Math.max(0, daysBetween(created, t));
  const b = Math.max(0, daysBetween(created, tRef));
  if (a <= b) return vRef;
  return vRef * Math.exp(-lambda * (a ** beta - b ** beta));
}

/** Reinforcement on attributed use (§6.5.1): v ← v + Δv·u·(1 − v)·exp(−n/N). */
export function reinforce(v: number, u: number, n: number): number {
  return clamp(v + DELTA_V * u * (1 - v) * Math.exp(-n / N_REINFORCE), 0, 1);
}

interface Replay {
  v: number;
  t: string;
  layer: "short" | "long";
}

function replay(node: MemoryNode, until: string, lambda: number, stopBefore?: (e: StrengthEvent) => boolean): Replay {
  const events = node.strength.events.filter((e) => e.t > node.strength.base.t && e.t <= until);
  // The layer in force before the first layer event is the other one; with no layer events it is the node's.
  const firstLayer = events.find((e) => e.kind === "layer" && e.layer);
  let layer: "short" | "long" = firstLayer ? (firstLayer.layer === "long" ? "short" : "long") : node.layer;
  let v = node.strength.base.v;
  let t = node.strength.base.t;
  for (const e of events) {
    if (stopBefore?.(e)) break;
    v = decay(v, t, e.t, node.createdAt, lambda, BETA[layer]);
    t = e.t;
    if (e.kind === "reinforce") v = reinforce(v, e.value, e.n ?? 0);
    else if (e.kind === "suppress") v = clamp(v * e.value, 0, 1);
    else if (e.kind === "set") v = clamp(e.value, 0, 1);
    else if (e.kind === "layer" && e.layer) layer = e.layer;
  }
  return { v, t, layer };
}

/**
 * Current strength. Derived from `strength.base` plus the events after it, replayed in time
 * order; never stored as one mutable value (§6.5.1).
 */
export function strengthAt(node: MemoryNode, now: Date | string): number {
  if (node.pinned) return 1.0;
  const t = typeof now === "string" ? now : now.toISOString();
  const lambda = decayRate(node.importance ?? 0, node.decayDivisor);
  const r = replay(node, t, lambda);
  return clamp(decay(r.v, r.t, t, node.createdAt, lambda, BETA[r.layer]), 0, 1);
}

/**
 * Fold events older than the safety window into a new base (§7.3). Returns null when there is
 * nothing to fold. Events inside the window stay, so concurrent folds cannot drop recent ones.
 */
export function foldPlan(node: MemoryNode, now: Date): { base: { v: number; t: string }; remove: string[] } | null {
  const cutoff = new Date(now.getTime() - FOLD_SAFETY_DAYS * 86_400_000).toISOString();
  const old = node.strength.events.filter((e) => e.t <= cutoff);
  const stale = old.filter((e) => e.t <= node.strength.base.t);
  const foldable = old.filter((e) => e.t > node.strength.base.t);
  if (!foldable.length) return stale.length ? { base: node.strength.base, remove: stale.map((e) => e.id) } : null;
  // a layer event must stay replayable so later decay uses the right β: keep the newest one unfolded
  const lastLayerIdx = foldable.map((e) => e.kind).lastIndexOf("layer");
  const upTo = lastLayerIdx >= 0 ? foldable.slice(0, lastLayerIdx) : foldable;
  if (!upTo.length) return stale.length ? { base: node.strength.base, remove: stale.map((e) => e.id) } : null;
  const last = upTo[upTo.length - 1]!;
  const lambda = decayRate(node.importance ?? 0, node.decayDivisor);
  const r = replay(node, last.t, lambda);
  return { base: { v: r.v, t: r.t }, remove: [...stale, ...upTo].map((e) => e.id) };
}

/** Attributed uses in the last 7 days (n_i in the reinforcement formula). */
export function recentUses(node: MemoryNode, now: Date, days = 7): number {
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  return node.strength.events.filter((e) => e.kind === "reinforce" && e.t >= cutoff).length;
}

/** Attributed-use rate with a 14-day half-life (f_i in §6.5.2). */
function useRate(node: MemoryNode, now: Date): number {
  let f = 0;
  for (const e of node.strength.events) {
    if (e.kind !== "reinforce") continue;
    f += e.value * 0.5 ** (Math.max(0, daysBetween(e.t, now)) / 14);
  }
  // events already folded into the base still count through the cumulative counter, heavily decayed
  const folded = Math.max(0, node.counters.used - node.strength.events.filter((e) => e.kind === "reinforce").reduce((s, e) => s + e.value, 0));
  if (folded > 0) f += folded * 0.5 ** (Math.max(FOLD_SAFETY_DAYS, daysBetween(node.strength.base.t, now)) / 14);
  return f;
}

/** I = 0.4·rel + 0.3·f/(1+f) + 0.3·recency (F Eq. 2 with our weights). */
export function importance(node: MemoryNode, rel: number, now: Date): number {
  const f = useRate(node, now);
  const recency = Math.exp(-0.05 * Math.max(0, daysBetween(node.lastAccessAt, now)));
  return clamp(0.4 * clamp(rel, 0, 1) + 0.3 * (f / (1 + f)) + 0.3 * recency, 0, 1);
}

// ───────────────────────────── Memory Worth (§6.7)

export function memoryWorth(c: UseCounters): { mw: number; evidence: number } {
  const evidence = c.usedSuccess + c.usedFailure;
  return { mw: (c.usedSuccess + 1) / (evidence + 2), evidence };
}

export type WorthClass = "uncertain" | "high" | "low" | "mixed";

export function worthClass(c: UseCounters): WorthClass {
  const { mw, evidence } = memoryWorth(c);
  if (evidence < 3) return "uncertain";
  if (mw >= 0.6) return "high";
  if (mw <= 0.3 && evidence >= 5) return "low";
  return "mixed";
}

/** 1 − effectiveUsed/delivered once delivered ≥ 3; rules count compliance as use. */
export function irrelevanceRate(node: MemoryNode): number {
  const c = node.counters;
  if (c.delivered < 3) return 0;
  const effective = node.kind === "rule" ? c.used + c.complied : c.used;
  return clamp(1 - effective / c.delivered, 0, 1);
}

export interface UseSignals {
  rewriteCandidate: boolean;
  deadWeight: boolean;
  harmful: boolean;
}

/**
 * The counters since the user last reviewed the memory (`reviewBaseline`): a review that kept the
 * memory starts its review signals over, so an approved or dismissed flag returns only on new evidence.
 */
export function sinceReview(node: MemoryNode): UseCounters {
  const base = node.reviewBaseline?.counters;
  if (!base) return node.counters;
  const c = { ...node.counters };
  for (const k of COUNTER_NAMES) c[k] = Math.max(0, c[k] - (base[k] ?? 0));
  return c;
}

/** Memory Worth class of the evidence since the last review: what flags a memory as low value. */
export function reviewWorthClass(node: MemoryNode): WorthClass {
  return worthClass(sinceReview(node));
}

export function useSignals(node: MemoryNode): UseSignals {
  const c = node.counters;
  const r = sinceReview(node);
  return {
    rewriteCandidate: r.delivered >= 6 && r.ignoredRelevant / r.delivered >= 0.5,
    deadWeight: node.kind !== "rule" && c.delivered >= 10 && c.used < 0.5,
    harmful: r.harm >= 1.0,
  };
}

/** Whether proactive injection may offer this memory (§6.7). */
export function proactiveEligible(node: MemoryNode): boolean {
  const s = useSignals(node);
  return !s.deadWeight && !s.harmful && !node.flags?.includes("conflicts-instruction");
}

// ───────────────────────────── Retention (§6.5.3)

/** a_i = attributed uses + expansions + 0.25 × deliveries. */
export function accessScore(c: UseCounters): number {
  return c.used + c.expanded + 0.25 * c.delivered;
}

export function retention(node: MemoryNode, ctx: { now: Date; maxAccess: number; centrality: number; scopeTurns: number }): number {
  const recency = 0.5 ** (Math.max(0, daysBetween(node.lastAccessAt, ctx.now)) / 90);
  const frequency = ctx.maxAccess > 0 ? Math.log(1 + accessScore(node.counters)) / Math.log(1 + ctx.maxAccess) : 0;
  const turnDecay = 0.5 ** (Math.max(0, ctx.scopeTurns - node.createdTurn) / 1000);
  return 0.35 * recency + 0.25 * frequency + 0.2 * clamp(ctx.centrality, 0, 1) + 0.2 * turnDecay;
}
