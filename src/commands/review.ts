/**
 * `/realctx2 review` (§6.7, §6.8.4, §6.9.2, §6.10.4): the pending reviews, their details and the
 * actions that settle them. `ReviewSession` is the model behind pi's interactive review screen; the
 * same entries and actions back the plain list and `review approve|dismiss <id>` elsewhere.
 */
import type { Host } from "../core/host.ts";
import { COUNTER_NAMES, type CommandIO, type ScopedNode, type UseCounters } from "../core/types.ts";
import { captionLine, day, mid } from "../memory/cards.ts";
import { scopeLabel } from "../memory/graph.ts";
import { reviveNode } from "../memory/lifecycle.ts";
import type { ReviewItem } from "../memory/reverify.ts";
import type { MemoryRuntime } from "../memory/runtime.ts";
import { memoryWorth, sinceReview } from "../memory/strength.ts";
import { violationsAtLevel } from "../memory/urgency.ts";
import { inspectMemory } from "../tools/inspect.ts";
import { parseIdLoose } from "../util/ids.ts";
import { contentHash, makeTitle, sanitize } from "../util/text.ts";
import { flagValue, type Parsed } from "./args.ts";
import { describeEdit, flushNow, memoryForm, need, planMemoryEdit } from "./memory.ts";

export const REVIEW_FILTERS = ["low-value", "harm", "conflicts", "escalations", "stale-rules"] as const;
export type ReviewFilter = (typeof REVIEW_FILTERS)[number];

/** Review flags, the filter that selects each, and how the list names it. */
const FLAGS: Record<string, { filter: ReviewFilter | null; label: string; section: string }> = {
  "low-value": { filter: "low-value", label: "low value", section: "Low value (Memory Worth ≤ 0.3 on ≥ 5 outcomes)" },
  "rewrite-candidate": { filter: "low-value", label: "rewrite candidate", section: "Rewrite candidates (relevant but ignored, or still broken at the highest urgency)" },
  harm: { filter: "harm", label: "harm", section: "Harm (acted on with a harmful effect)" },
  escalated: { filter: "escalations", label: "escalated", section: "Escalated urgency" },
  violated: { filter: "escalations", label: "violated", section: "Violated although the user set their urgency" },
  "stale-rule": { filter: "stale-rules", label: "stale rule", section: "Rules whose paths are gone" },
  "conflicts-instruction": { filter: "conflicts", label: "conflicts with an instruction", section: "Conflicts with an ingested instruction" },
  review: { filter: null, label: "flagged for review", section: "Flagged for review (the queued item is on another machine or was dropped)" },
};
const FLAG_ORDER = Object.keys(FLAGS);

const QUEUED: Record<ReviewItem["kind"], string> = {
  "rule-change": "rule change",
  "rule-obsolete": "obsolete rule",
  conflict: "conflict",
  proposal: "proposed change",
};

export type ReviewEntry =
  | { kind: "queued"; key: string; item: ReviewItem; ref: ScopedNode | null }
  | { kind: "conflict"; key: string; ref: ScopedNode; other: ScopedNode }
  | { kind: "flagged"; key: string; ref: ScopedNode; flags: string[] }
  | { kind: "strategy"; key: string; proposal: Record<string, unknown> };

export type ReviewActionId = "approve" | "dismiss" | "edit" | "forget" | "pin" | "unpin";

/** One row of the review screen's list. */
export interface ReviewRow {
  key: string;
  /** What kind of review: `rule change`, `conflict`, `harm, low value`, … */
  label: string;
  tone: "accent" | "warning" | "error";
  /** `[m:…]`, or empty for a strategy proposal. */
  id: string;
  title: string;
  /** Scope and, when not active, status. */
  meta: string;
  /** One line on why the item is pending. */
  summary: string;
}

/** An action on one item. Each runs only after the screen asks for a second, separate confirmation. */
export interface ReviewActionSpec {
  id: ReviewActionId;
  /** The key that selects it. */
  key: string;
  label: string;
  /** The confirmation question: exactly what will happen. */
  confirm: string;
  /** Opens the editor first; the confirmation shows the planned changes afterwards. */
  edit?: boolean;
  /** Retires something or drops a suggestion for good. */
  destructive?: boolean;
}

export interface ReviewOutcome {
  ok: boolean;
  message: string;
}

export type ReviewEditPreview = { ok: true; summary: string; preview: string[] } | { ok: false; message: string };

/** What the interactive review screen needs; `ReviewSession` implements it over the memory runtime. */
export interface ReviewModel {
  readonly title: string;
  readonly subtitle?: string;
  rows(): ReviewRow[];
  /** Re-read the queue, flags and conflicts (after an action, or to pick up background changes). */
  refresh(): void;
  details(key: string): string;
  actions(key: string): ReviewActionSpec[];
  run(key: string, action: ReviewActionId): ReviewOutcome;
  editForm(key: string): { title: string; prefill: string } | null;
  planEdit(key: string, edited: string): ReviewEditPreview;
  applyEdit(key: string, edited: string): ReviewOutcome;
}

const oneLine = (s: string, max = 160) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const indent = (s: string) => s.split("\n").map((l) => `  ${l}`);
const MEMORY_DETAILS = new Set(["anchors", "sources", "evidence", "neighbors", "history", "stats"] as const);

/** Collect the pending reviews: queued items, contradictions, flagged memories and strategy proposals. */
export function collectReviews(mem: MemoryRuntime, only: readonly ReviewFilter[] = []): ReviewEntry[] {
  const want = (f: ReviewFilter | null) => (only.length ? f !== null && only.includes(f) : true);
  const out: ReviewEntry[] = [];
  const queuedIds = new Set<string>();
  if (!only.length) {
    // the latest item per memory: re-verification may have queued the same verdict more than once
    const latest = new Map<string, ReviewItem>();
    for (const it of mem.review.list()) latest.set(it.id, it);
    for (const item of latest.values()) {
      // the queue is shared by every project on this machine: only this project's memories are listed
      const ref = mem.graph.get(item.id, { includePurged: true });
      if (!ref) continue;
      const live = ref.node.status === "active" || ref.node.status === "dormant" ? ref : null;
      out.push({ kind: "queued", key: `q:${item.id}`, item, ref: live });
      queuedIds.add(item.id);
    }
  }
  const all = mem.graph.all(undefined, (n) => n.status === "active" || n.status === "dormant");
  const paired = new Set<string>();
  if (want("conflicts")) {
    const seen = new Set<string>();
    for (const r of all) {
      if (r.node.status !== "active") continue;
      for (const other of mem.graph.contradictions(r)) {
        const pair = [r.node.id, other.node.id].sort().join("|");
        if (seen.has(pair)) continue;
        seen.add(pair);
        // the learned memory first: the instruction (or the older memory) is what it conflicts with
        const [a, b] = primaryFirst(r, other);
        out.push({ kind: "conflict", key: `c:${pair}`, ref: a, other: b });
        paired.add(a.node.id).add(b.node.id);
      }
    }
  }
  for (const r of all) {
    const flags = (r.node.flags ?? []).filter((f) => {
      const info = FLAGS[f];
      if (!info) return false;
      if (f === "review") return !queuedIds.has(r.node.id) && !only.length;
      if (f === "conflicts-instruction" && paired.has(r.node.id)) return false; // the conflict item covers it
      return true;
    });
    if (!flags.length || !flags.some((f) => want(FLAGS[f]!.filter))) continue;
    out.push({ kind: "flagged", key: `f:${r.node.id}`, ref: r, flags: flags.sort((x, y) => FLAG_ORDER.indexOf(x) - FLAG_ORDER.indexOf(y)) });
  }
  if (!only.length) {
    mem.evoLog.proposals().forEach((proposal, i) => out.push({ kind: "strategy", key: `s:${i}:${String(proposal.at ?? "")}`, proposal }));
  }
  return out;
}

function primaryFirst(x: ScopedNode, y: ScopedNode): [ScopedNode, ScopedNode] {
  const score = (r: ScopedNode) => (r.node.flags?.includes("conflicts-instruction") ? 2 : 0) + (r.node.origin !== "instructions" ? 1 : 0);
  if (score(x) !== score(y)) return score(x) > score(y) ? [x, y] : [y, x];
  return x.node.createdAt >= y.node.createdAt ? [x, y] : [y, x];
}

function flagNote(mem: MemoryRuntime, r: ScopedNode, flag: string): string {
  const n = r.node;
  const c = sinceReview(n);
  switch (flag) {
    case "low-value": {
      const { mw, evidence } = memoryWorth(c);
      return `Memory Worth ${mw.toFixed(2)} on ${evidence.toFixed(1)} outcomes${n.status === "dormant" ? "; made dormant" : ""}`;
    }
    case "rewrite-candidate":
      return `ignored while relevant ${c.ignoredRelevant.toFixed(1)} of ${c.delivered.toFixed(0)} deliveries, or still broken at the highest urgency`;
    case "harm":
      return `acted on with a harmful effect (harm ${c.harm.toFixed(2)})`;
    case "escalated":
      return `urgency raised to ${n.urgency}; ${violationsAtLevel(n).toFixed(1)} violation(s) at this level`;
    case "violated":
      return `${n.counters.violated.toFixed(1)} violation(s); urgency ${n.urgency} was set by the user`;
    case "stale-rule":
      return "its anchored path was deleted or moved out of reach";
    case "conflicts-instruction":
      return "contradicts an ingested instruction; the instruction wins in delivery until reviewed";
    case "review":
      return mem.graph.writable(r.scope) ? "re-verification flagged it, but the queued suggestion is not on this machine" : "flagged for review";
    default:
      return flag;
  }
}

function strategyText(p: Record<string, unknown>): { op: string; summary: string } {
  const action = p.action && typeof p.action === "object" ? (p.action as Record<string, unknown>) : {};
  return { op: typeof action.operator === "string" ? action.operator : "edit", summary: typeof p.summary === "string" ? p.summary : JSON.stringify(p).slice(0, 200) };
}

export class ReviewSession implements ReviewModel {
  readonly title: string;
  readonly subtitle?: string;
  private entries: ReviewEntry[] = [];
  private readonly host: Host;
  private readonly mem: MemoryRuntime;
  private readonly only: ReviewFilter[];

  constructor(host: Host, mem: MemoryRuntime, opts: { only?: ReviewFilter[] } = {}) {
    this.host = host;
    this.mem = mem;
    this.only = opts.only ?? [];
    this.title = "realctx2 review";
    this.subtitle = this.only.length ? this.only.map((f) => `--${f}`).join(" ") : undefined;
    this.refresh();
  }

  refresh(): void {
    this.entries = collectReviews(this.mem, this.only);
  }

  list(): readonly ReviewEntry[] {
    return this.entries;
  }

  /** The keys of the items about one memory (queued and flagged), for `review approve|dismiss <id>`. */
  keysFor(id: string): string[] {
    return this.entries.filter((e) => (e.kind === "queued" ? e.item.id === id : e.kind === "flagged" ? e.ref.node.id === id : false)).map((e) => e.key);
  }

  private find(key: string): ReviewEntry | undefined {
    return this.entries.find((e) => e.key === key);
  }

  /** A fresh view of a memory: actions run against the store as it is now, not as listed. */
  private fresh(ref: ScopedNode | null): ScopedNode | null {
    if (!ref) return null;
    const node = this.mem.graph.has(ref.scope) ? this.mem.graph.sd(ref.scope).getNode(ref.node.id) : null;
    return node && node.status !== "purged" ? { scope: ref.scope, node } : null;
  }

  rows(): ReviewRow[] {
    return this.entries.map((e) => this.row(e));
  }

  private meta(r: ScopedNode): string {
    return `${scopeLabel(r.scope)}${r.node.status !== "active" ? ` · ${r.node.status}` : ""}`;
  }

  private row(e: ReviewEntry): ReviewRow {
    switch (e.kind) {
      case "queued": {
        const r = e.ref;
        const what = e.item.suggestion ? `suggested: ${oneLine(e.item.suggestion.text, 120)}` : e.item.kind === "rule-obsolete" ? "the code no longer supports it" : oneLine(e.item.note ?? "queued for review");
        return { key: e.key, label: QUEUED[e.item.kind], tone: e.item.kind === "rule-obsolete" ? "warning" : "accent", id: `[m:${e.item.id}]`, title: r?.node.title ?? "(retired)", meta: r ? this.meta(r) : scopeLabel(e.item.scope), summary: what };
      }
      case "conflict":
        return { key: e.key, label: "conflict", tone: "warning", id: mid(e.ref.node), title: e.ref.node.title, meta: this.meta(e.ref), summary: `conflicts with ${mid(e.other.node)} ${oneLine(e.other.node.title, 100)}${e.other.node.origin === "instructions" ? " (instruction)" : ""}` };
      case "flagged":
        return { key: e.key, label: e.flags.map((f) => FLAGS[f]!.label).join(", "), tone: e.flags.includes("harm") ? "error" : "warning", id: mid(e.ref.node), title: e.ref.node.title, meta: this.meta(e.ref), summary: flagNote(this.mem, e.ref, e.flags[0]!) };
      case "strategy": {
        const s = strategyText(e.proposal);
        return { key: e.key, label: "strategy proposal", tone: "accent", id: "", title: `${s.op} in ${String(e.proposal.scope ?? "?")}`, meta: day(String(e.proposal.at ?? "")), summary: oneLine(s.summary) };
      }
    }
  }

  private memoryDetails(r: ScopedNode): string[] {
    return ["", "Memory", ...indent(inspectMemory(this.host.env, this.mem, r, MEMORY_DETAILS).text)];
  }

  details(key: string): string {
    const e = this.find(key);
    if (!e) return "This item is no longer pending.";
    const out: string[] = [];
    const readOnly = (r: ScopedNode) => (this.mem.graph.writable(r.scope) ? [] : ["", `! The ${r.scope} store is read-only here: only dismissing the queued item is possible.`]);
    switch (e.kind) {
      case "queued": {
        const it = e.item;
        out.push(`${QUEUED[it.kind][0]!.toUpperCase()}${QUEUED[it.kind].slice(1)} · queued ${day(it.at)} by re-verification against the code`);
        if (!e.ref) {
          out.push("", `[m:${it.id}] is retired or purged, so there is nothing left to change. Dismiss the item to drop it.`);
          break;
        }
        out.push("", `${mid(e.ref.node)} ${e.ref.node.title}`, `${this.meta(e.ref)} · ${e.ref.node.kind}${e.ref.node.severity ? ` ${e.ref.node.severity.toUpperCase()}` : ""} · urgency ${e.ref.node.urgency}`);
        out.push(...readOnly(e.ref));
        out.push("", "Current text", ...indent(e.ref.node.text));
        if (it.suggestion) out.push("", "Suggested text", ...indent(it.suggestion.text));
        if (it.kind === "rule-obsolete") out.push("", "Re-verification found that the code no longer supports this rule. Approving retires it (reversible with /realctx2 restore).");
        if (it.evidence?.length) out.push("", "Evidence from the code", ...it.evidence.map((ev) => `  ${ev.path}${ev.lines ? `:${ev.lines}` : ""}  "${oneLine(ev.quote, 300)}"`));
        if (it.note) out.push("", `Note: ${it.note}`);
        out.push(...this.memoryDetails(e.ref));
        break;
      }
      case "conflict": {
        out.push("Conflict · two active memories contradict each other");
        out.push("", `This memory  ${mid(e.ref.node)} (${this.meta(e.ref)}, ${e.ref.node.origin})`, ...indent(e.ref.node.text));
        out.push("", `Conflicts with  ${mid(e.other.node)} (${this.meta(e.other)}, ${e.other.node.origin})`, ...indent(e.other.node.text));
        if (e.ref.node.flags?.includes("conflicts-instruction") || e.other.node.origin === "instructions") out.push("", "The ingested instruction wins in delivery until this is settled.");
        out.push(...this.memoryDetails(e.ref));
        break;
      }
      case "flagged": {
        out.push(`Flagged · ${e.flags.map((f) => FLAGS[f]!.label).join(", ")}`);
        out.push("", `${mid(e.ref.node)} ${e.ref.node.title}`, `${this.meta(e.ref)} · ${e.ref.node.kind}${e.ref.node.severity ? ` ${e.ref.node.severity.toUpperCase()}` : ""} · urgency ${e.ref.node.urgency}${e.ref.node.pinned ? " · pinned" : ""}`);
        out.push(...readOnly(e.ref));
        out.push("", "Why", ...e.flags.map((f) => `  ${FLAGS[f]!.label}: ${flagNote(this.mem, e.ref, f)}`));
        if (e.ref.node.reviewBaseline) out.push(`  (signals count from the last review on ${day(e.ref.node.reviewBaseline.at)})`);
        out.push("", "Text", ...indent(e.ref.node.text));
        out.push(...this.memoryDetails(e.ref));
        break;
      }
      case "strategy": {
        const s = strategyText(e.proposal);
        out.push(`Shared strategy proposal · ${day(String(e.proposal.at ?? ""))}`, "", `Evolution (sharedStrategy "propose") would run ${s.op} on the ${String(e.proposal.scope ?? "?")} store:`, ...indent(s.summary));
        out.push("", "Proposals are not applied from here: set evolution's shared strategy to auto to let it commit such edits. Dismissing drops the proposal.");
        out.push("", "Raw", ...indent(JSON.stringify(e.proposal, null, 2)));
        break;
      }
    }
    return out.join("\n");
  }

  actions(key: string): ReviewActionSpec[] {
    const e = this.find(key);
    if (!e) return [];
    const restore = "reversible with /realctx2 restore";
    if (e.kind === "strategy") return [{ id: "dismiss", key: "d", label: "dismiss", confirm: "Drop this strategy proposal? Nothing in memory changes.", destructive: true }];
    if (e.kind === "queued") {
      const r = e.ref;
      const drop: ReviewActionSpec = { id: "dismiss", key: "d", label: "dismiss", confirm: `Drop the queued review of [m:${e.item.id}]? Nothing in memory changes.`, destructive: true };
      if (!r || !this.mem.graph.writable(r.scope)) return [drop];
      const m = mid(r.node);
      const approve: ReviewActionSpec =
        e.item.kind === "rule-obsolete"
          ? { id: "approve", key: "a", label: "approve (retire)", confirm: `Retire ${m} as obsolete (${restore})?`, destructive: true }
          : e.item.suggestion
            ? { id: "approve", key: "a", label: "approve (apply)", confirm: `Replace the text of ${m} with the suggested text?` }
            : { id: "approve", key: "a", label: "approve", confirm: `Keep ${m} as it is, mark it verified and settle this review?` };
      const dismiss: ReviewActionSpec = {
        id: "dismiss",
        key: "d",
        label: e.item.kind === "rule-obsolete" ? "dismiss (keep)" : "dismiss",
        confirm: e.item.suggestion ? `Keep the current text of ${m} and drop the suggestion? It counts as verified against the code as it is now.` : `Keep ${m} as it is and drop this review? It counts as verified against the code as it is now.`,
        destructive: !!e.item.suggestion,
      };
      return [approve, dismiss, { id: "edit", key: "e", label: "edit", confirm: `Apply your edit to ${m} and settle this review?`, edit: true }, ...(e.item.kind === "rule-obsolete" ? [] : [this.forgetSpec(r)]), this.pinSpec(r)];
    }
    if (e.kind === "conflict") {
      const a = e.ref;
      const b = e.other;
      const wa = this.mem.graph.writable(a.scope);
      const wb = this.mem.graph.writable(b.scope);
      const out: ReviewActionSpec[] = [];
      if (wb) out.push({ id: "approve", key: "a", label: "keep this", confirm: `Keep ${mid(a.node)} and retire ${mid(b.node)} "${oneLine(b.node.title, 60)}" (${restore})?`, destructive: true });
      if (wa || wb) out.push({ id: "dismiss", key: "d", label: "dismiss (not a conflict)", confirm: `They do not conflict: remove the contradiction between ${mid(a.node)} and ${mid(b.node)}? Both stay as they are.` });
      if (wa) out.push({ id: "edit", key: "e", label: "edit", confirm: `Apply your edit to ${mid(a.node)}? The conflict stays listed until you settle it.`, edit: true });
      if (wa) out.push({ id: "forget", key: "f", label: "keep other", confirm: `Retire ${mid(a.node)} and keep ${mid(b.node)} (${restore})?`, destructive: true });
      if (wa) out.push(this.pinSpec(a));
      return out;
    }
    const r = e.ref;
    if (!this.mem.graph.writable(r.scope)) return [];
    const m = mid(r.node);
    const flags = e.flags.map((f) => FLAGS[f]!.label).join(", ");
    return [
      { id: "approve", key: "a", label: "approve (keep)", confirm: `Keep ${m}: clear its flags (${flags}), mark it verified${r.node.status === "dormant" ? " and wake it from dormant" : ""}? Its review signals count again from now.` },
      { id: "dismiss", key: "d", label: "dismiss", confirm: `Clear the flags of ${m} (${flags}) without any other change? Its review signals count again from now.` },
      { id: "edit", key: "e", label: "edit", confirm: `Apply your edit to ${m} and clear its flags?`, edit: true },
      this.forgetSpec(r),
      this.pinSpec(r),
    ];
  }

  private forgetSpec(r: ScopedNode): ReviewActionSpec {
    return { id: "forget", key: "f", label: "forget", confirm: `Retire ${mid(r.node)} "${oneLine(r.node.title, 60)}" (reversible with /realctx2 restore)?`, destructive: true };
  }

  private pinSpec(r: ScopedNode): ReviewActionSpec {
    return r.node.pinned
      ? { id: "unpin", key: "p", label: "unpin", confirm: `Unpin ${mid(r.node)}? It follows the normal lifecycle again.` }
      : { id: "pin", key: "p", label: "pin", confirm: `Pin ${mid(r.node)}? It never decays and is never forgotten automatically.` };
  }

  run(key: string, action: ReviewActionId): ReviewOutcome {
    const e = this.find(key);
    if (!e) return { ok: false, message: "This item is no longer pending." };
    if (!this.actions(key).some((a) => a.id === action && !a.edit)) return { ok: false, message: `"${action}" is not available for this item.` };
    try {
      return this.perform(e, action);
    } finally {
      this.refresh();
    }
  }

  private perform(e: ReviewEntry, action: ReviewActionId): ReviewOutcome {
    const mem = this.mem;
    if (action === "pin" || action === "unpin") {
      const r = this.fresh(e.kind === "strategy" ? null : e.ref);
      if (!r) return { ok: false, message: "The memory is no longer visible here." };
      mem.graph.sd(r.scope).patchNode(r.node.id, action === "pin" ? { pinned: true, layer: "long" } : { pinned: false });
      this.commit(r.scope, action);
      return { ok: true, message: action === "pin" ? `Pinned ${mid(r.node)}: it never decays and is never forgotten automatically.` : `Unpinned ${mid(r.node)}: it follows the normal lifecycle again.` };
    }
    switch (e.kind) {
      case "strategy": {
        const n = mem.evoLog.dropProposals((p) => p.at === e.proposal.at && p.scope === e.proposal.scope && p.summary === e.proposal.summary);
        return n ? { ok: true, message: "Dropped the strategy proposal." } : { ok: false, message: "The proposal was already gone." };
      }
      case "queued":
        return this.settleQueued(e, action);
      case "conflict":
        return this.settleConflict(e, action);
      case "flagged": {
        const r = this.fresh(e.ref);
        if (!r) return { ok: false, message: "The memory is no longer visible here." };
        if (action === "forget") return this.forget(r, "forgotten in review");
        this.clearFlags(r, e.flags, action === "approve");
        return { ok: true, message: action === "approve" ? `Approved ${mid(r.node)}: flags cleared${r.node.status === "dormant" ? ", active again" : ""}.` : `Dismissed the flags of ${mid(r.node)}.` };
      }
    }
    return { ok: false, message: "Nothing was done." };
  }

  private commit(scope: ScopedNode["scope"], why: string): void {
    this.mem.graph.commit(scope, why);
    this.mem.graph.syncIndex(scope);
    flushNow(this.mem, scope);
  }

  private forget(r: ScopedNode, reason: string): ReviewOutcome {
    const out = this.mem.lifecycle.forget(r, reason, { byAgent: false });
    if (out.status === "refused") return { ok: false, message: `Not retired: ${out.message ?? "refused"}.` };
    flushNow(this.mem, r.scope);
    return { ok: true, message: `Retired ${mid(r.node)} "${oneLine(r.node.title, 60)}" (restore with /realctx2 restore ${r.node.id}).` };
  }

  /** Remove review flags; a kept memory's review signals count from now (`reviewBaseline`). */
  private clearFlags(r: ScopedNode, flags: readonly string[], approve: boolean): void {
    const mem = this.mem;
    const now = mem.clock();
    let ref = r;
    if (approve && ref.node.status === "dormant" && reviveNode(mem.graph, ref, now)) ref = this.fresh(ref) ?? ref;
    const counters: Partial<UseCounters> = {};
    for (const k of COUNTER_NAMES) counters[k] = ref.node.counters[k] + mem.accounting.pendingOf(ref.scope, ref.node.id, k);
    const drop = new Set(flags);
    mem.graph.sd(ref.scope).patchNode(ref.node.id, {
      flags: (ref.node.flags ?? []).filter((f) => !drop.has(f)),
      reviewBaseline: { at: now.toISOString(), counters },
      ...(approve ? { verifiedAt: now.toISOString() } : {}),
    });
    this.commit(ref.scope, "review");
  }

  private settleQueued(e: Extract<ReviewEntry, { kind: "queued" }>, action: ReviewActionId): ReviewOutcome {
    const mem = this.mem;
    const it = e.item;
    const r = this.fresh(e.ref);
    if (action === "dismiss" && (!r || !mem.graph.writable(r.scope))) {
      mem.review.remove(it.id);
      return { ok: true, message: `Dropped the queued review of [m:${it.id}].` };
    }
    if (!r) return { ok: false, message: `[m:${it.id}] is no longer visible here.` };
    if (action === "forget") {
      mem.review.remove(it.id);
      return this.forget(r, "forgotten in review");
    }
    if (action === "approve" && it.kind === "rule-obsolete") {
      mem.review.remove(it.id);
      this.dropReviewFlag(r);
      const out = mem.lifecycle.forget(this.fresh(r) ?? r, "obsolete: confirmed in review", { byAgent: false });
      flushNow(mem, r.scope);
      return out.status === "refused" ? { ok: false, message: `Not retired: ${out.message ?? "refused"}.` } : { ok: true, message: `Approved ${mid(r.node)}: retired as obsolete.` };
    }
    let ref = r;
    const now = mem.clock().toISOString();
    if (action === "approve" && ref.node.status === "dormant" && reviveNode(mem.graph, ref, mem.clock())) ref = this.fresh(ref) ?? ref;
    const patch: Parameters<ReturnType<typeof mem.graph.sd>["patchNode"]>[1] = { flags: (ref.node.flags ?? []).filter((f) => f !== "review"), verifiedAt: now };
    const applies = action === "approve" && !!it.suggestion && (it.kind === "rule-change" || it.kind === "proposal");
    if (applies) {
      const text = sanitize(it.suggestion!.text);
      Object.assign(patch, { text, title: makeTitle(it.suggestion!.title ?? text), contentHash: contentHash(text) });
    }
    mem.graph.sd(ref.scope).patchNode(ref.node.id, patch);
    mem.review.remove(it.id);
    // settled against the code as it is now: the same verdict is not queued again until the file changes
    mem.reverifier.acknowledge(ref);
    this.commit(ref.scope, "review");
    if (applies) mem.paths.invalidate();
    return { ok: true, message: action === "approve" ? `Approved ${mid(ref.node)}${applies ? ": the suggested text was applied" : ": marked verified"}.` : `Dismissed the review of ${mid(ref.node)}: its text stays as it is.` };
  }

  private dropReviewFlag(r: ScopedNode): void {
    const fresh = this.fresh(r);
    if (fresh?.node.flags?.includes("review")) this.mem.graph.sd(r.scope).patchNode(r.node.id, { flags: fresh.node.flags.filter((f) => f !== "review") });
  }

  private settleConflict(e: Extract<ReviewEntry, { kind: "conflict" }>, action: ReviewActionId): ReviewOutcome {
    const mem = this.mem;
    const a = this.fresh(e.ref);
    const b = this.fresh(e.other);
    if (!a || !b) return { ok: false, message: "One of the two memories is no longer visible here." };
    const release = (r: ScopedNode) => {
      // the instruction no longer wins over this memory once nothing it contradicts is left
      const cur = this.fresh(r);
      if (cur && mem.graph.writable(r.scope) && cur.node.flags?.includes("conflicts-instruction") && !mem.graph.contradictions(cur).length) {
        mem.graph.sd(r.scope).patchNode(r.node.id, { flags: cur.node.flags.filter((f) => f !== "conflicts-instruction") });
        this.commit(r.scope, "review");
      }
    };
    if (action === "approve" || action === "forget") {
      const [keep, drop] = action === "approve" ? [a, b] : [b, a];
      const out = this.forget(drop, `conflict settled in review: kept [m:${keep.node.id}]`);
      if (out.ok) release(keep);
      return out.ok ? { ok: true, message: `Kept ${mid(keep.node)}; ${out.message}` } : out;
    }
    // dismiss: not a conflict, so the contradiction edges between the two go
    const scopes = new Set<ScopedNode["scope"]>();
    let removed = 0;
    for (const nb of mem.graph.neighbors(a, { rels: ["contradicts"] })) {
      if (nb.other.scope !== b.scope || nb.other.node.id !== b.node.id || !mem.graph.writable(nb.edgeScope)) continue;
      if (mem.graph.sd(nb.edgeScope).deleteEdge(nb.edge.id)) {
        removed++;
        scopes.add(nb.edgeScope);
      }
    }
    for (const s of scopes) this.commit(s, "review");
    release(a);
    release(b);
    const left = mem.graph.contradictions(a).some((x) => x.scope === b.scope && x.node.id === b.node.id);
    if (!removed) return { ok: false, message: "The contradiction is stored where it cannot be changed here." };
    return { ok: true, message: `Removed the contradiction between ${mid(a.node)} and ${mid(b.node)}${left ? " here; the rest lives in a read-only store" : ""}.` };
  }

  editForm(key: string): { title: string; prefill: string } | null {
    const e = this.find(key);
    if (!e || e.kind === "strategy") return null;
    const r = this.fresh(e.ref);
    if (!r || !this.mem.graph.writable(r.scope)) return null;
    const suggestion = e.kind === "queued" && e.item.suggestion ? e.item.suggestion.text : undefined;
    return {
      title: `Edit ${mid(r.node)}${suggestion ? " (prefilled with the suggested text)" : ""}`,
      prefill: memoryForm(this.mem, r, suggestion ? { text: suggestion, note: "The text below the --- line is the suggested rewrite; adjust it before saving." } : {}),
    };
  }

  private editTarget(key: string): { e: ReviewEntry; r: ScopedNode } | null {
    const e = this.find(key);
    if (!e || e.kind === "strategy") return null;
    const r = this.fresh(e.ref);
    return r && this.mem.graph.writable(r.scope) ? { e, r } : null;
  }

  planEdit(key: string, edited: string): ReviewEditPreview {
    const t = this.editTarget(key);
    if (!t) return { ok: false, message: "This item can no longer be edited." };
    const plan = planMemoryEdit(this.mem, t.r, edited);
    if ("error" in plan) return { ok: false, message: `Not applied: ${plan.error}.` };
    if (!plan.changes.length) return { ok: false, message: `No changes to ${mid(t.r.node)}: nothing to apply.` };
    const preview = plan.changes.includes("text") ? ["New text", ...indent(plan.text)] : [];
    if (plan.bad.length) preview.push(`! Ignored paths that do not resolve: ${plan.bad.join(", ")}`);
    return { ok: true, summary: `${mid(t.r.node)}: ${plan.changes.join(", ")}`, preview };
  }

  applyEdit(key: string, edited: string): ReviewOutcome {
    const t = this.editTarget(key);
    if (!t) return { ok: false, message: "This item can no longer be edited." };
    try {
      const plan = planMemoryEdit(this.mem, t.r, edited);
      if ("error" in plan) return { ok: false, message: `Not applied: ${plan.error}.` };
      if (!plan.changes.length) return { ok: false, message: `No changes to ${mid(t.r.node)}: nothing was applied.` };
      plan.apply();
      const { e } = t;
      let settled = "";
      if (e.kind === "queued") {
        const r = this.fresh(t.r)!;
        this.mem.graph.sd(r.scope).patchNode(r.node.id, { flags: (r.node.flags ?? []).filter((f) => f !== "review") });
        this.mem.review.remove(e.item.id);
        this.mem.reverifier.acknowledge(r);
        this.commit(r.scope, "review");
        settled = " The review is settled.";
      } else if (e.kind === "flagged") {
        this.clearFlags(this.fresh(t.r)!, e.flags, false);
        settled = " Its flags are cleared.";
      }
      return { ok: true, message: `${describeEdit(plan)}${settled}` };
    } finally {
      this.refresh();
    }
  }
}

// ───────────── the command
export async function review(host: Host, io: CommandIO, p: Parsed): Promise<void> {
  const mem = need(host, io);
  if (!mem) return;
  const [action, rawId] = p.positional;
  if ((action === "approve" || action === "dismiss") && rawId) {
    const id = parseIdLoose(rawId)?.id ?? rawId;
    const session = new ReviewSession(host, mem);
    const keys = session.keysFor(id);
    if (!keys.length) return io.print(mem.graph.get(id) ? `Nothing to review for [m:${id}].` : `No memory ${rawId} is visible here.`);
    const out = keys.map((k) => session.run(k, action));
    const failed = out.find((o) => !o.ok);
    if (failed) return io.print(failed.message);
    return io.print(action === "dismiss" ? `Dismissed the review item for ${rawId}.` : out.map((o) => o.message).join("\n"));
  }
  const only = REVIEW_FILTERS.filter((f) => p.flags.has(f));
  const actor = flagValue(p, "actor");
  if (actor) return io.print(byActor(mem, actor));
  const session = new ReviewSession(host, mem, { only });
  if (io.review) return io.review(session);
  io.print(listText(mem, session.list(), only));
}

function line(r: ScopedNode, note: string): string {
  return `  ${captionLine(r)} (${scopeLabel(r.scope)}${r.node.status !== "active" ? `, ${r.node.status}` : ""}) — ${note}`;
}

function byActor(mem: MemoryRuntime, actor: string): string {
  const all = mem.graph.all(undefined, (n) => n.status !== "purged");
  const rows = all.filter((r) => r.node.provenance.actor === actor).map((r) => line(r, `${r.node.kind}, created ${day(r.node.createdAt)}`));
  if (!rows.length) return `No memories by actor ${actor}. Actors seen: ${[...new Set(all.map((r) => r.node.provenance.actor))].join(", ") || "none"}`;
  return `Memories written by ${actor} (${rows.length}):\n${rows.slice(0, 50).join("\n")}${rows.length > 50 ? `\n  (+${rows.length - 50} more)` : ""}`;
}

/** The plain list, for harnesses without the interactive screen. */
export function listText(mem: MemoryRuntime, entries: readonly ReviewEntry[], only: readonly ReviewFilter[] = []): string {
  const sections: string[] = [];
  const add = (title: string, rows: string[]) => {
    if (rows.length) sections.push(`${title} (${rows.length}):\n${rows.slice(0, 25).join("\n")}${rows.length > 25 ? `\n  (+${rows.length - 25} more)` : ""}`);
  };
  add(
    "Re-verification and proposals",
    entries.flatMap((e) => (e.kind === "queued" ? [`  [m:${e.item.id}] ${e.ref?.node.title ?? "(gone)"} — ${e.item.kind}${e.item.note ? `: ${e.item.note}` : ""}${e.item.suggestion ? `\n    suggested: ${oneLine(e.item.suggestion.text, 200)}` : ""}`] : [])),
  );
  add("Conflicts", entries.flatMap((e) => (e.kind === "conflict" ? [`  ${mid(e.ref.node)} ${e.ref.node.title}\n    ⚠ conflicts with ${mid(e.other.node)} ${e.other.node.title}`] : [])));
  for (const flag of FLAG_ORDER) {
    const info = FLAGS[flag]!;
    if (only.length && (info.filter === null || !only.includes(info.filter))) continue;
    add(info.section, entries.flatMap((e) => (e.kind === "flagged" && e.flags.includes(flag) ? [line(e.ref, flagNote(mem, e.ref, flag))] : [])));
  }
  add("Shared strategy proposals", entries.flatMap((e) => (e.kind === "strategy" ? [`  ${strategyText(e.proposal).op} in ${String(e.proposal.scope ?? "?")}: ${oneLine(strategyText(e.proposal).summary, 200)}`] : [])));
  if (!sections.length) return "Nothing to review.";
  sections.push("Act on an item with: /realctx2 review approve <id> · review dismiss <id> · pin <id> · rules edit <id> · urgency <id> <level> · forget <id>. In pi, /realctx2 review opens an interactive screen.");
  return sections.join("\n\n");
}
