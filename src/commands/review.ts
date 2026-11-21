/**
 * `/realctx2 review` (§6.7, §6.8.4, §6.9.2, §6.10.4): the pending reviews, their details and the
 * actions that settle them. `ReviewSession` is the model behind pi's interactive review screen; the
 * same entries and actions back the plain list and `review approve|dismiss <id>` elsewhere.
 */
import type { Host } from "../core/host.ts";
import { COUNTER_NAMES, type CommandIO, type ScopedNode, URGENCY_ORDER, type UseCounters } from "../core/types.ts";
import { captionLine, day, mid } from "../memory/cards.ts";
import { scopeLabel } from "../memory/graph.ts";
import { reviveNode } from "../memory/lifecycle.ts";
import { isGlob } from "../memory/paths.ts";
import type { ReviewItem } from "../memory/reverify.ts";
import type { MemoryRuntime } from "../memory/runtime.ts";
import { memoryWorth, sinceReview } from "../memory/strength.ts";
import { capUrgency, violationsAtLevel } from "../memory/urgency.ts";
import { anchorKey } from "../storage/schema.ts";
import { inspectMemory } from "../tools/inspect.ts";
import { errMsg } from "../util/errors.ts";
import { globCompiles } from "../util/glob.ts";
import { parseIdLoose } from "../util/ids.ts";
import { contentHash, makeTitle, sanitize } from "../util/text.ts";
import { flagValue, type Parsed } from "./args.ts";
import { describeEdit, flushNow, formAnchors, memoryForm, need, planMemoryEdit, planMemoryFields, splitForm } from "./memory.ts";

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
/** Weakest first. */
const SEVERITY_RANK = ["info", "may", "should", "must"] as const;

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

export type ReviewActionId = "approve" | "dismiss" | "edit" | "forget" | "pin" | "unpin" | "resolve";

/** How the aux model may settle a conflict. "current" is the memory the item lists, "other" the one it conflicts with. */
export const CONFLICT_DECISIONS = ["remove-current", "remove-other", "rewrite-current", "rewrite-other", "merge"] as const;
export type ConflictDecision = (typeof CONFLICT_DECISIONS)[number];

/** How the aux model may settle a flagged memory (low value, harm, stale rule, …). */
export const FLAGGED_DECISIONS = ["keep", "retire", "rewrite"] as const;
export type FlaggedDecision = (typeof FLAGGED_DECISIONS)[number];

/**
 * The aux model's suggestion for a conflict or a flagged memory. Nothing is written until `applyProposal`.
 * Queued re-verification items are not asked about: they already are the aux model's verdict against the code.
 */
export interface ReviewPlan {
  decision: ConflictDecision | FlaggedDecision;
  /** Why, in a sentence or two for the user. */
  reason: string;
  /** The new text of the rewritten memory, or of the merged one (merges go into the current memory). */
  text?: string;
  /** A flagged memory's new paths (rewrite): they replace its live paths. Absent: the paths stay as they are. */
  paths?: string[];
  /** Content hashes of the memories when the model read them ([current, other] for a conflict): a plan for memories that changed since is refused. */
  basis: string[];
  /** The user edited the suggested text or paths (`reviseProposal`) before applying it. */
  edited?: boolean;
}

/**
 * A suggestion, or why there is none. `fixable`: only the user's edit of a suggestion is wrong
 * (`reviseProposal`); the suggestion itself still stands and the edit can be corrected.
 */
export type ReviewProposal = { ok: true; confirm: string; preview: string[]; destructive: boolean; plan: ReviewPlan } | { ok: false; message: string; fixable?: boolean };

/** Whether a suggestion has text (or paths) the user can edit before applying it: a rewrite or a merge. */
export function isEditablePlan(plan: ReviewPlan): boolean {
  return plan.decision === "merge" || plan.decision.startsWith("rewrite");
}

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
  /** Asks the aux model first (`propose`); the confirmation shows what it suggests (`applyProposal`). */
  ask?: boolean;
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
  /** Ask the aux model how to settle an item (an `ask` action). Changes nothing. */
  propose?(key: string, signal?: AbortSignal): Promise<ReviewProposal>;
  /** Carry out a suggestion from `propose`, once the user confirmed it. */
  applyProposal?(key: string, plan: ReviewPlan): ReviewOutcome;
  /** The editor form of a suggestion's text (and a flagged memory's paths); null: nothing to edit. */
  proposalForm?(key: string, plan: ReviewPlan): { title: string; prefill: string } | null;
  /** The suggestion with the user's edit of that form, checked like the model's own answer. Changes nothing. */
  reviseProposal?(key: string, plan: ReviewPlan, edited: string): ReviewProposal;
}

const oneLine = (s: string, max = 160) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** How a suggestion's confirmation reads: the model's own, or the user's edit of it. */
function planWording(plan: ReviewPlan): { why: string; ask: (what: string) => string } {
  return plan.edited
    ? { why: `The model's reason: ${plan.reason}`, ask: (what) => `Your edit of the model's suggestion: ${what}. Apply it?` }
    : { why: `Why: ${plan.reason}`, ask: (what) => `The model suggests: ${what}. Apply it?` };
}
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

const DECISION_HELP: Record<ConflictDecision, string> = {
  "remove-current": "CURRENT is wrong, obsolete or redundant: retire it and keep OTHER as it is.",
  "remove-other": "OTHER is wrong, obsolete or redundant: retire it and keep CURRENT as it is.",
  "rewrite-current": "Both hold some truth: rewrite CURRENT so it no longer contradicts OTHER (correct the wrong part, or narrow it to where it applies); OTHER stays as it is.",
  "rewrite-other": "Both hold some truth: rewrite OTHER so it no longer contradicts CURRENT (correct the wrong part, or narrow it to where it applies); CURRENT stays as it is.",
  merge: "They are about the same thing: combine them into ONE consistent memory, editing as needed (keep what is still true in either, settle the contradiction, drop what is wrong). The result replaces CURRENT, which also takes over OTHER's paths; OTHER is retired.",
};

const ORIGIN_HELP =
  "Origin `instructions` means it was ingested from an instruction file the user wrote (AGENTS.md, CLAUDE.md, rule files); origin `explicit` means the user stated it; other origins were inferred by the agent.";

/** The role prompt of `review.resolve` for a conflict: only the decisions the stores allow are offered. */
function resolveInstructions(choices: readonly ConflictDecision[]): string {
  return [
    "Two memories in a coding agent's long-term memory contradict each other: CURRENT and OTHER. Decide how to settle the conflict. Choose exactly one decision:",
    ...choices.map((d) => `- ${d}: ${DECISION_HELP[d]}`),
    `Judge by the evidence. When the memories are about this repository's code, configuration or tooling, check the repository with your tools to see which one holds now. ${ORIGIN_HELP} A newer memory may record a change that made an older one obsolete.`,
    "For rewrite-current, rewrite-other and merge, put the complete new text of the memory in `text`: self-contained, in the style and about the length of the originals, stating the facts and rules directly. Do not mention the conflict, the review, the other memory or memory ids. For remove-current and remove-other, leave `text` out.",
    "`reason`: one or two sentences for the user on why this settles the conflict.",
  ].join("\n");
}

const FLAGGED_HELP: Record<FlaggedDecision, string> = {
  keep: "It is correct and worth keeping as it is: its flags are cleared and it counts as verified.",
  retire: "It is wrong, obsolete, harmful or not worth keeping: it is retired (the user can restore it).",
  rewrite: "What it says is worth keeping, but its wording or where it applies is the problem: it gets new text, new paths, or both.",
};

/** What each flag means for the decision. */
const FLAG_HELP: Record<string, string> = {
  "low-value": "Agents got it often but it rarely helped. Retire it if it adds nothing an agent would not know or find at once; rewrite it if the useful part is vague or buried; keep it if it is rarely needed but matters when it is.",
  "rewrite-candidate": "Agents got it where it was relevant but ignored it, or broke it even at the highest urgency. Usually the wording is the problem: rewrite it as a short, direct statement of what to do (and where). Retire it if it no longer holds.",
  harm: "Agents who acted on it ended up worse off. Check whether it is wrong or out of date: correct it with a rewrite, or retire it. Keep it only if the repository shows it holds and the harm came from elsewhere.",
  escalated: "Agents kept breaking it, so its urgency was raised. Check that it still holds: if it does, rewrite it to be clearer and more actionable, or keep it; if it does not, retire it.",
  violated: "Agents keep breaking it although the user set its urgency. Check that it still holds: if it does, rewrite it to be clearer and more actionable, or keep it; if it does not, retire it.",
  "stale-rule": "The paths it applied to were deleted or moved (its stale paths are listed). Look for where that code is now: if it moved, rewrite with `paths` set to the new locations (the text may stay as it is); if the code is gone, retire it.",
  "conflicts-instruction": "It contradicts an instruction the user wrote, and the instruction wins until this is settled. Retire it, or rewrite it so it agrees with the instruction; keep it only if the repository shows the instruction is out of date (say so in the reason).",
  review: "Re-verification against the code flagged it. Check it against the repository: keep, correct or retire it.",
};

/** The role prompt of `review.resolve` for a flagged memory. */
function flaggedInstructions(flags: readonly string[]): string {
  return [
    "A memory in a coding agent's long-term memory was flagged for review: MEMORY is the memory, WHY FLAGGED the signals behind its flags. Decide what to do with it. Choose exactly one decision:",
    ...FLAGGED_DECISIONS.map((d) => `- ${d}: ${FLAGGED_HELP[d]}`),
    "What its flags mean:",
    ...flags.filter((f) => FLAG_HELP[f]).map((f) => `- ${f}: ${FLAG_HELP[f]}`),
    `Judge by the evidence. When the memory is about this repository's code, configuration or tooling, check the repository with your tools to see whether it holds now. ${ORIGIN_HELP}`,
    "For rewrite, put the complete new text of the memory in `text`: self-contained, in the style and about the length of the original, stating the facts and rules directly. Do not mention the review, the flags or memory ids. Leave `text` out to keep the text as it is (when only its paths change).",
    "`paths`, for rewrite only, and only to change where the memory applies: the complete list of repository paths or globs, relative to the repository root (a trailing / covers a directory). It replaces the current paths; every plain path must exist. Leave it out to keep the paths as they are.",
    "For keep and retire, leave `text` and `paths` out. `reason`: one or two sentences for the user on why.",
  ].join("\n");
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
      if (this.mem.aux && this.conflictChoices(a, b).length) {
        out.push({ id: "resolve", key: "m", label: "ask model", confirm: `Let the aux model decide: retire, rewrite or merge ${mid(a.node)} and ${mid(b.node)}? Nothing changes until you confirm its suggestion.`, ask: true });
      }
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
      ...(this.mem.aux ? [{ id: "resolve", key: "m", label: "ask model", confirm: `Let the aux model decide: keep, retire or rewrite ${m}? Nothing changes until you confirm its suggestion.`, ask: true } satisfies ReviewActionSpec] : []),
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
    if (!this.actions(key).some((a) => a.id === action && !a.edit && !a.ask)) return { ok: false, message: `"${action}" is not available for this item.` };
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
    const a = this.fresh(e.ref);
    const b = this.fresh(e.other);
    if (!a || !b) return { ok: false, message: "One of the two memories is no longer visible here." };
    if (action === "approve" || action === "forget") {
      const [keep, drop] = action === "approve" ? [a, b] : [b, a];
      const out = this.forget(drop, `conflict settled in review: kept [m:${keep.node.id}]`);
      if (out.ok) this.release(keep);
      return out.ok ? { ok: true, message: `Kept ${mid(keep.node)}; ${out.message}` } : out;
    }
    // dismiss: not a conflict, so the contradiction edges between the two go
    const { removed, left } = this.unlink(a, b);
    if (!removed) return { ok: false, message: "The contradiction is stored where it cannot be changed here." };
    return { ok: true, message: `Removed the contradiction between ${mid(a.node)} and ${mid(b.node)}${left ? " here; the rest lives in a read-only store" : ""}.` };
  }

  /** The instruction no longer wins over this memory once nothing it contradicts is left. */
  private release(r: ScopedNode): void {
    const mem = this.mem;
    const cur = this.fresh(r);
    if (cur && mem.graph.writable(r.scope) && cur.node.flags?.includes("conflicts-instruction") && !mem.graph.contradictions(cur).length) {
      mem.graph.sd(r.scope).patchNode(r.node.id, { flags: cur.node.flags.filter((f) => f !== "conflicts-instruction") });
      this.commit(r.scope, "review");
    }
  }

  /** Delete the contradiction edges between two memories (where writable), then release both. */
  private unlink(a: ScopedNode, b: ScopedNode): { removed: number; left: boolean } {
    const mem = this.mem;
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
    this.release(a);
    this.release(b);
    const left = mem.graph.contradictions(this.fresh(a) ?? a).some((x) => x.scope === b.scope && x.node.id === b.node.id);
    return { removed, left };
  }

  // ───────────── the aux model settles a conflict or a flagged memory
  /** What the stores allow: retiring or rewriting needs that memory's store writable, a merge both. */
  private conflictChoices(a: ScopedNode, b: ScopedNode): ConflictDecision[] {
    const wa = this.mem.graph.writable(a.scope);
    const wb = this.mem.graph.writable(b.scope);
    return CONFLICT_DECISIONS.filter((d) => (d === "merge" ? wa && wb : d.endsWith("current") ? wa : wb));
  }

  /** One memory as the model sees it: provenance, use and paths help it judge which one holds. */
  private resolveCard(r: ScopedNode): string {
    const n = r.node;
    const { mw, evidence } = memoryWorth(sinceReview(n));
    const paths = formAnchors(this.mem, r).map((x) => x.spec);
    const stale = this.mem.paths.displayAnchors(r).flatMap((x) => (x.anchor.status !== "live" && x.at ? [x.at] : []));
    return [
      `id: m:${n.id}`,
      `scope: ${scopeLabel(r.scope)}${this.mem.graph.writable(r.scope) ? "" : " (read-only here)"}`,
      `kind: ${n.kind}${n.severity ? ` (${n.severity.toUpperCase()})` : ""}; urgency ${n.urgency}${n.pinned ? "; pinned by the user" : ""}`,
      `origin: ${n.origin}; written by ${n.provenance.actor}`,
      `created ${day(n.createdAt)}${n.verifiedAt ? `; last verified ${day(n.verifiedAt)}` : ""}; Memory Worth ${mw.toFixed(2)} on ${evidence.toFixed(1)} outcomes`,
      ...(paths.length ? [`paths: ${paths.join(", ")}`] : []),
      ...(stale.length ? [`stale paths (deleted or moved): ${stale.join(", ")}`] : []),
      ...(n.source ? [`source: ${n.source.file}${n.source.section ? ` § ${n.source.section}` : ""}, lines ${n.source.lines.join("-")}`] : []),
      ...n.evidence.slice(0, 3).map((ev) => `evidence${ev.verified ? " (verified)" : ""}: "${oneLine(ev.quote, 240)}"`),
      `title: ${n.title}`,
      "text:",
      n.text,
    ].join("\n");
  }

  /** Why a flagged memory is flagged, with the signals since its last review. */
  private flagCard(r: ScopedNode, flags: readonly string[]): string {
    const c = sinceReview(r.node);
    const f = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
    return [
      ...flags.map((x) => `${x}: ${flagNote(this.mem, r, x)}`),
      `signals since ${r.node.reviewBaseline ? `the last review on ${day(r.node.reviewBaseline.at)}` : "it was written"}: delivered ${f(c.delivered)}, used ${f(c.used)} (succeeded ${f(c.usedSuccess)}, failed ${f(c.usedFailure)}), ignored while relevant ${f(c.ignoredRelevant)}, contradicted ${f(c.contradicted)}, harm ${f(c.harm)}, complied ${f(c.complied)}, violated ${f(c.violated)}`,
      `status: ${r.node.status}${r.node.statusReason ? ` (${r.node.statusReason})` : ""}`,
    ].join("\n");
  }

  async propose(key: string, signal?: AbortSignal): Promise<ReviewProposal> {
    const e = this.find(key);
    if (e?.kind === "conflict") return this.proposeConflict(e, signal);
    if (e?.kind === "flagged") return this.proposeFlagged(e, signal);
    return { ok: false, message: "Only a conflict or a flagged memory can be settled by the model." };
  }

  /** One `review.resolve` call; the answer's decision is one of `choices`. */
  private async askModel(task: { instructions: string; data: Array<{ label: string; text: string }>; choices: readonly string[]; fields: Record<string, unknown> }, signal?: AbortSignal): Promise<{ ok: true; out: { decision: string; reason?: string; text?: string; paths?: unknown } } | { ok: false; message: string }> {
    const aux = this.mem.aux;
    if (!aux?.available()) return { ok: false, message: "No aux model is available right now: nothing changed." };
    type Answer = { decision: string; reason?: string; text?: string; paths?: unknown };
    let res: Awaited<ReturnType<typeof aux.run<Answer>>>;
    try {
      res = await aux.run<Answer>({
        role: "review.resolve",
        instructions: task.instructions,
        data: task.data,
        schema: { type: "object", additionalProperties: false, required: ["decision", "reason"], properties: { decision: { type: "string", enum: [...task.choices] }, reason: { type: "string" }, ...task.fields } },
        signal,
      });
    } catch (err) {
      return { ok: false, message: `The model could not decide: ${oneLine(errMsg(err), 200)}.` };
    }
    if (signal?.aborted) return { ok: false, message: "Stopped asking the model: nothing changed." };
    const out = res.output;
    if (!out) return { ok: false, message: `The model gave no usable answer${res.error ? `: ${oneLine(res.error, 200)}` : ""}. Nothing changed.` };
    if (!task.choices.includes(out.decision)) return { ok: false, message: `The model chose "${oneLine(String(out.decision), 40)}", which is not possible here. Nothing changed.` };
    return { ok: true, out };
  }

  private async proposeConflict(e: Extract<ReviewEntry, { kind: "conflict" }>, signal?: AbortSignal): Promise<ReviewProposal> {
    const a = this.fresh(e.ref);
    const b = this.fresh(e.other);
    if (!a || !b) return { ok: false, message: "One of the two memories is no longer visible here." };
    const choices = this.conflictChoices(a, b);
    if (!choices.length) return { ok: false, message: "Both memories are in read-only stores: nothing can be changed here." };
    const asked = await this.askModel(
      {
        instructions: resolveInstructions(choices),
        data: [
          { label: "CURRENT", text: this.resolveCard(a) },
          { label: "OTHER", text: this.resolveCard(b) },
        ],
        choices,
        fields: { text: { type: "string" } },
      },
      signal,
    );
    if (!asked.ok) return asked;
    const out = asked.out;
    const decision = out.decision as ConflictDecision;
    const plan: ReviewPlan = { decision, reason: oneLine(sanitize(out.reason ?? ""), 500) || "(no reason given)", basis: [contentHash(a.node.text), contentHash(b.node.text)] };
    if (decision.startsWith("rewrite") || decision === "merge") {
      const text = sanitize(out.text ?? "").trim();
      const target = decision === "rewrite-other" ? b : a;
      if (!text) return { ok: false, message: `The model chose ${decision} but gave no new text. Nothing changed.` };
      if (decision !== "merge" && contentHash(text) === contentHash(target.node.text)) return { ok: false, message: `The model chose ${decision} but left the text of ${mid(target.node)} as it is. Nothing changed.` };
      plan.text = text;
    }
    return { ok: true, ...this.describeConflictPlan(a, b, plan), plan };
  }

  private async proposeFlagged(e: Extract<ReviewEntry, { kind: "flagged" }>, signal?: AbortSignal): Promise<ReviewProposal> {
    const r = this.fresh(e.ref);
    if (!r) return { ok: false, message: "The memory is no longer visible here." };
    if (!this.mem.graph.writable(r.scope)) return { ok: false, message: `The ${r.scope} store is read-only here: nothing can be changed.` };
    const asked = await this.askModel(
      {
        instructions: flaggedInstructions(e.flags),
        data: [
          { label: "MEMORY", text: this.resolveCard(r) },
          { label: "WHY FLAGGED", text: this.flagCard(r, e.flags) },
        ],
        choices: FLAGGED_DECISIONS,
        fields: { text: { type: "string" }, paths: { type: "array", items: { type: "string" } } },
      },
      signal,
    );
    if (!asked.ok) return asked;
    const out = asked.out;
    const decision = out.decision as FlaggedDecision;
    const plan: ReviewPlan = { decision, reason: oneLine(sanitize(out.reason ?? ""), 500) || "(no reason given)", basis: [contentHash(r.node.text)] };
    if (decision === "rewrite") {
      const text = sanitize(out.text ?? "").trim();
      if (text && contentHash(text) !== contentHash(r.node.text)) plan.text = text;
      const paths = Array.isArray(out.paths) ? [...new Set(out.paths.filter((p): p is string => typeof p === "string").map((p) => p.trim()).filter(Boolean))] : [];
      // an empty list from the model means "the paths stay"; it does not strip them all
      const moved = paths.length ? this.newPaths(r, paths) : null;
      if (moved?.bad.length) return { ok: false, message: `The model chose rewrite with paths that do not exist here (${oneLine(moved.bad.join(", "), 200)}). Nothing changed.` };
      if (moved?.changed) plan.paths = paths;
      if (!plan.text && !plan.paths) return { ok: false, message: `The model chose rewrite but changed neither the text nor the paths of ${mid(r.node)}. Nothing changed.` };
    }
    return { ok: true, ...this.describeFlaggedPlan(r, e.flags, plan), plan };
  }

  /** Whether `paths` differ from a memory's live paths, and which new ones would not anchor here. */
  private newPaths(r: ScopedNode, paths: readonly string[]): { changed: boolean; bad: string[] } {
    const current = formAnchors(this.mem, r).map((x) => x.spec);
    const changed = paths.length !== current.length || paths.some((p) => !current.includes(p));
    return { changed, bad: changed ? paths.filter((p) => !current.includes(p) && !this.resolves(r, p)) : [] };
  }

  proposalForm(key: string, plan: ReviewPlan): { title: string; prefill: string } | null {
    const e = this.find(key);
    if (!e || !isEditablePlan(plan)) return null;
    const help = ["# Lines above the --- line that start with # are ignored.", "# Save to see your edit before anything is applied; close without saving to keep the suggestion as it was."];
    if (e.kind === "conflict") {
      const a = this.fresh(e.ref);
      const b = this.fresh(e.other);
      if (!a || !b || plan.text === undefined) return null;
      const target = plan.decision === "rewrite-other" ? b : a;
      const what = plan.decision === "merge" ? `the merged text that goes into ${mid(a.node)} (${mid(b.node)} is retired)` : `the new text of ${mid(target.node)} (${mid(target === a ? b.node : a.node)} stays as it is)`;
      return { title: `Edit the model's suggestion for ${mid(target.node)}`, prefill: [`# Editing ${what}, as the aux model suggested it.`, ...help, "---", plan.text].join("\n") };
    }
    if (e.kind === "flagged") {
      const r = this.fresh(e.ref);
      if (!r) return null;
      return {
        title: `Edit the model's suggestion for ${mid(r.node)}`,
        prefill: [
          `# Editing the aux model's suggested rewrite of ${mid(r.node)}: its paths and its text.`,
          ...help,
          "# repository paths or globs, comma-separated; a trailing / covers the subtree; empty: no paths",
          `paths: ${(plan.paths ?? formAnchors(this.mem, r).map((x) => x.spec)).join(", ")}`,
          "---",
          plan.text ?? r.node.text,
        ].join("\n"),
      };
    }
    return null;
  }

  reviseProposal(key: string, plan: ReviewPlan, edited: string): ReviewProposal {
    const e = this.find(key);
    if (!e || (e.kind !== "conflict" && e.kind !== "flagged")) return { ok: false, message: "This item is no longer pending: the suggestion was dropped." };
    if (!isEditablePlan(plan)) return { ok: false, message: `A suggestion to ${plan.decision} has no text to edit.` };
    const fix = (message: string): ReviewProposal => ({ ok: false, fixable: true, message });
    const form = splitForm(edited);
    const text = form ? sanitize(form.text).trim() : "";
    const revised: ReviewPlan = { decision: plan.decision, reason: plan.reason, basis: plan.basis, edited: true };
    if (e.kind === "conflict") {
      const a = this.fresh(e.ref);
      const b = this.fresh(e.other);
      if (!a || !b) return { ok: false, message: "One of the two memories is no longer visible here: the suggestion was dropped." };
      if (contentHash(a.node.text) !== plan.basis[0] || contentHash(b.node.text) !== plan.basis[1]) return { ok: false, message: "The memories changed after the model read them: the suggestion was dropped. Ask again." };
      if (!form) return fix("the form has no --- line above the text");
      if (!text) return fix("the text below the --- line is empty");
      const target = plan.decision === "rewrite-other" ? b : a;
      if (plan.decision !== "merge" && contentHash(text) === contentHash(target.node.text)) return fix(`the text is the current text of ${mid(target.node)}, so nothing would be rewritten`);
      revised.text = text;
      return { ok: true, ...this.describeConflictPlan(a, b, revised), plan: revised };
    }
    const r = this.fresh(e.ref);
    if (!r) return { ok: false, message: "The memory is no longer visible here: the suggestion was dropped." };
    if (contentHash(r.node.text) !== plan.basis[0]) return { ok: false, message: "The memory changed after the model read it: the suggestion was dropped. Ask again." };
    if (!form) return fix("the form has no --- line above the text");
    if (!text) return fix("the text below the --- line is empty");
    if (contentHash(text) !== contentHash(r.node.text)) revised.text = text;
    const paths = form.list("paths");
    const moved = this.newPaths(r, paths);
    if (moved.bad.length) return fix(`these paths do not exist here: ${oneLine(moved.bad.join(", "), 200)}`);
    if (moved.changed) revised.paths = paths;
    if (!revised.text && !revised.paths) return fix(`it changes neither the text nor the paths of ${mid(r.node)}, so nothing would be rewritten`);
    return { ok: true, ...this.describeFlaggedPlan(r, e.flags, revised), plan: revised };
  }

  /** Whether a path spec the model gave would anchor here; checked without writing anything. */
  private resolves(r: ScopedNode, spec: string): boolean {
    if (isGlob(spec)) return globCompiles(spec.replace(/^\.\//, ""));
    if (r.scope === "global") return true; // kept as a suffix pattern
    const hash = spec.indexOf("#");
    const rel = this.mem.paths.rel(hash > 0 ? spec.slice(0, hash) : spec);
    return rel !== null && (rel === "" || this.mem.paths.exists(rel));
  }

  private describeFlaggedPlan(r: ScopedNode, flags: readonly string[], plan: ReviewPlan): { confirm: string; preview: string[]; destructive: boolean } {
    const m = mid(r.node);
    const { why, ask } = planWording(plan);
    const settle = `Its flags (${flags.map((f) => FLAGS[f]!.label).join(", ")}) are cleared and it counts as verified${r.node.status === "dormant" ? "; it becomes active again" : ""}`;
    switch (plan.decision) {
      case "retire":
        return { confirm: ask(`retire ${m}`), preview: [why, `Retire ${m} "${oneLine(r.node.title, 80)}" (reversible with /realctx2 restore)`], destructive: true };
      case "rewrite": {
        const was = this.mem.paths.displayAnchors(r).flatMap((x) => (x.at ? [x.at] : []));
        const preview = [why];
        if (plan.text) preview.push(`New text of ${m}`, ...indent(plan.text));
        if (plan.paths) preview.push(`${plan.paths.length ? `New paths: ${plan.paths.join(", ")}` : "No paths: it applies everywhere in its store"}${was.length ? ` (instead of ${was.join(", ")})` : ""}`);
        return { confirm: ask(`rewrite ${m}`), preview: [...preview, settle], destructive: false };
      }
      default:
        return { confirm: ask(`keep ${m} as it is`), preview: [why, settle], destructive: false };
    }
  }

  private describeConflictPlan(a: ScopedNode, b: ScopedNode, plan: ReviewPlan): { confirm: string; preview: string[]; destructive: boolean } {
    const retire = (r: ScopedNode) => `Retire ${mid(r.node)} "${oneLine(r.node.title, 80)}" (reversible with /realctx2 restore)`;
    const { why, ask } = planWording(plan);
    switch (plan.decision) {
      case "remove-current":
        return { confirm: ask(`retire ${mid(a.node)} and keep ${mid(b.node)}`), preview: [why, retire(a)], destructive: true };
      case "remove-other":
        return { confirm: ask(`retire ${mid(b.node)} and keep ${mid(a.node)}`), preview: [why, retire(b)], destructive: true };
      case "rewrite-current":
      case "rewrite-other": {
        const [target, peer] = plan.decision === "rewrite-current" ? [a, b] : [b, a];
        return { confirm: ask(`rewrite ${mid(target.node)}; ${mid(peer.node)} stays as it is`), preview: [why, `New text of ${mid(target.node)}`, ...indent(plan.text!)], destructive: false };
      }
      case "merge":
        return { confirm: ask(`merge both into ${mid(a.node)} and retire ${mid(b.node)}`), preview: [why, `Merged text of ${mid(a.node)}`, ...indent(plan.text!), retire(b)], destructive: true };
      default:
        return { confirm: ask(plan.decision), preview: [why], destructive: true };
    }
  }

  applyProposal(key: string, plan: ReviewPlan): ReviewOutcome {
    const e = this.find(key);
    if (!e || (e.kind !== "conflict" && e.kind !== "flagged")) return { ok: false, message: "This item is no longer pending." };
    try {
      return e.kind === "conflict" ? this.applyConflictPlan(e, plan) : this.applyFlaggedPlan(e, plan);
    } finally {
      this.refresh();
    }
  }

  private applyFlaggedPlan(e: Extract<ReviewEntry, { kind: "flagged" }>, plan: ReviewPlan): ReviewOutcome {
    const r = this.fresh(e.ref);
    if (!r) return { ok: false, message: "The memory is no longer visible here." };
    if (contentHash(r.node.text) !== plan.basis[0]) return { ok: false, message: "The memory changed after the model read it: nothing was applied. Ask again." };
    if (!(FLAGGED_DECISIONS as readonly string[]).includes(plan.decision) || !this.mem.graph.writable(r.scope)) return { ok: false, message: `${plan.decision} is not possible here.` };
    const done = plan.edited ? "Applied the model's suggestion as you edited it." : "Applied the model's suggestion.";
    if (plan.decision === "retire") {
      const out = this.forget(r, "retired in review on the aux model's suggestion");
      return out.ok ? { ok: true, message: `${done} ${out.message}` } : out;
    }
    if (plan.decision === "keep") {
      const out = this.perform(e, "approve");
      return out.ok ? { ok: true, message: `${done} ${out.message}` } : out;
    }
    const edit = planMemoryFields(this.mem, r, { text: plan.text ?? r.node.text, paths: plan.paths ?? formAnchors(this.mem, r).map((x) => x.spec) });
    if (!edit.changes.length) return { ok: false, message: `No changes to ${mid(r.node)}: nothing was applied.` };
    edit.apply();
    const after = this.fresh(r) ?? r;
    this.clearFlags(after, e.flags, true);
    return { ok: true, message: `${done} ${describeEdit(edit)} Its flags are cleared${r.node.status === "dormant" ? "; it is active again" : ""}.` };
  }

  private applyConflictPlan(e: Extract<ReviewEntry, { kind: "conflict" }>, plan: ReviewPlan): ReviewOutcome {
    const a = this.fresh(e.ref);
    const b = this.fresh(e.other);
    if (!a || !b) return { ok: false, message: "One of the two memories is no longer visible here." };
    if (contentHash(a.node.text) !== plan.basis[0] || contentHash(b.node.text) !== plan.basis[1]) return { ok: false, message: "The memories changed after the model read them: nothing was applied. Ask again." };
    if (!(this.conflictChoices(a, b) as string[]).includes(plan.decision)) return { ok: false, message: `${plan.decision} is not possible here: a store it needs is read-only.` };
    const done = plan.edited ? "Applied the model's suggestion as you edited it." : "Applied the model's suggestion.";
    switch (plan.decision) {
      case "remove-current":
      case "remove-other": {
        const out = this.settleConflict(e, plan.decision === "remove-other" ? "approve" : "forget");
        return out.ok ? { ok: true, message: `${done} ${out.message}` } : out;
      }
      case "rewrite-current":
      case "rewrite-other": {
        const [target, peer] = plan.decision === "rewrite-current" ? [a, b] : [b, a];
        this.rewrite(target, plan.text!);
        const { left } = this.unlink(a, b);
        return { ok: true, message: `${done} Rewrote ${mid(target.node)}; ${mid(peer.node)} stays as it is.${left ? " The contradiction is also stored in a read-only store, so the item stays listed there." : ""}` };
      }
      case "merge": {
        this.rewrite(a, plan.text!, b);
        const out = this.forget(this.fresh(b) ?? b, `merged into [m:${a.node.id}] in review`);
        if (!out.ok) return { ok: false, message: `Rewrote ${mid(a.node)} with the merged text, but ${mid(b.node)} stays: ${out.message}` };
        this.release(a);
        return { ok: true, message: `${done} Merged ${mid(b.node)} into ${mid(a.node)}; ${mid(b.node)} is retired (restore with /realctx2 restore ${b.node.id}).` };
      }
      default:
        return { ok: false, message: `${plan.decision} is not possible here.` };
    }
  }

  /**
   * New text for a memory. A merge also takes over the other memory's paths and command triggers, and
   * keeps the stronger gate of the two: a rule stays a rule, with the stronger severity and urgency.
   */
  private rewrite(r: ScopedNode, raw: string, merged?: ScopedNode): void {
    const mem = this.mem;
    const sd = mem.graph.sd(r.scope);
    const text = sanitize(raw);
    const patch: Parameters<typeof sd.patchNode>[1] = { text, title: makeTitle(text), contentHash: contentHash(text), verifiedAt: mem.clock().toISOString() };
    if (merged) {
      const have = new Set(r.node.anchors.filter((x) => x.status === "live").map(anchorKey));
      for (const { spec, anchor } of formAnchors(mem, merged)) {
        const a = mem.paths.makeAnchor(r.scope, spec, anchor.role);
        if (a && !have.has(anchorKey(a))) {
          sd.setAnchor(r.node.id, a);
          have.add(anchorKey(a));
        }
      }
      const t = merged.node.triggers;
      let commands = r.node.triggers?.commands ?? [];
      if (t?.on?.length || t?.commands?.length) {
        const on = [...new Set([...(r.node.triggers?.on ?? []), ...(t.on ?? [])])];
        commands = [...new Set([...commands, ...(t.commands ?? [])])];
        patch.triggers = { ...(on.length ? { on } : {}), ...(commands.length ? { commands } : {}) };
      }
      const m = merged.node;
      if (m.kind === "rule" && r.node.kind !== "rule") patch.kind = "rule";
      const sev = (s?: string) => (s ? SEVERITY_RANK.indexOf(s as (typeof SEVERITY_RANK)[number]) : -1);
      if (m.severity && sev(m.severity) > sev(r.node.severity)) patch.severity = m.severity;
      if (URGENCY_ORDER.indexOf(m.urgency) > URGENCY_ORDER.indexOf(r.node.urgency)) {
        const urgency = capUrgency(m.urgency, have.size > 0 || commands.length > 0);
        if (urgency !== r.node.urgency) Object.assign(patch, { urgency, urgencyBy: m.urgencyBy });
      }
    }
    sd.patchNode(r.node.id, patch);
    this.commit(r.scope, "review");
    mem.paths.invalidate();
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
    // settling one item can settle the others (approving an obsolete rule retires it, which ends its flags too)
    const out = keys.flatMap((k) => (session.list().some((e) => e.key === k) ? [session.run(k, action)] : []));
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
