/**
 * Span replacement (§4.3) and the two consolidators: Precip for closed intents (§5.3) and
 * Palim's ripple fold for prefixes (§5.4.4). Generation is done by the aux LLM; planning,
 * anchoring and the invariants are deterministic.
 */
import type { AuxSessionRunner, ConsolidationRecord, ContextEdit, Delivery, EntryView, Intent, IntentOutcome, KnowledgeItem, PrecipSidecar } from "../core/types.ts";
import { freshId8 } from "../util/ids.ts";
import { estimateTokens, sanitize } from "../util/text.ts";
import { GUIDANCE_TYPE, outcomeWord, renderEntry, renderKnowledge, renderPalim, renderPrecip } from "./render.ts";
import type { Unit } from "./rounds.ts";
import type { SessionState } from "./state.ts";

export interface ReplacePlan {
  record: ConsolidationRecord;
  edits: ContextEdit[];
  /** Entry ids of the span, in order: a plan is dropped when the span changed before it commits. */
  spanIds: string[];
  /** What each span entry looked like when the plan was made (id → projected text hash-ish). */
  fingerprint: string;
  text: string;
}

export function spanFingerprint(entries: EntryView[], from: number, to: number): string {
  const parts: string[] = [];
  for (let i = from; i < to; i++) {
    const e = entries[i]!;
    parts.push(`${e.id}:${e.omitted ? "-" : e.edited ? `e${e.text.length}` : "r"}`);
  }
  return parts.join("|");
}

/**
 * REPLACE(span S, message m): pick an anchor inside S, replace its content with `m`, and omit
 * every other entry of S. Earlier consolidations inside S become children of the new record.
 */
export function planReplace(
  entries: EntryView[],
  state: SessionState,
  from: number,
  to: number,
  opts: { id: string; kind: ConsolidationRecord["kind"]; text: string; preferAnchorId?: string; intent?: Intent; outcome?: IntentOutcome; telos: string[]; model: string; now: string; knowledge?: KnowledgeItem[]; sidecar?: PrecipSidecar; shadow?: boolean },
): ReplacePlan | null {
  if (to <= from) return null;
  const span = entries.slice(from, to);
  // entries the harness cannot edit stay where they are; the rest of the span is replaced around them
  const visible = span.filter((e) => !e.omitted && !e.fixed);
  if (!visible.length) return null;
  // anchor preference: the intent's own guidance; the first custom_message or user entry; the first assistant entry
  let anchor = opts.preferAnchorId ? visible.find((e) => e.id === opts.preferAnchorId) : undefined;
  anchor ??= visible.find((e) => e.kind === "custom_message" || e.kind === "user");
  anchor ??= visible.find((e) => e.kind === "assistant");
  if (!anchor) return null;
  const children: ConsolidationRecord["children"] = [];
  const edits: ContextEdit[] = [];
  let tokensBefore = 0;
  for (const e of span) {
    if (e.omitted || e.fixed) continue; // already inside an earlier consolidation, or not editable
    tokensBefore += e.tokens;
    const nested = state.recordAt(e.id);
    // a nested consolidation stays valid for recall; its anchor is simply edited again
    if (nested && e.edited) children.push({ id: nested.id });
    else children.push({ entryId: e.id });
    if (e.id !== anchor.id) edits.push({ targetId: e.id, replacement: null });
  }
  edits.unshift({ targetId: anchor.id, replacement: opts.text });
  const record: ConsolidationRecord = {
    id: opts.id,
    kind: opts.kind,
    anchorId: anchor.id,
    children,
    intentId: opts.intent?.id,
    outcome: opts.outcome,
    telos: opts.telos,
    tokensBefore,
    tokensAfter: estimateTokens(opts.text),
    model: opts.model,
    createdAt: opts.now,
    text: opts.text,
    knowledge: opts.knowledge,
    sidecar: opts.sidecar,
    shadow: opts.shadow,
  };
  return { record, edits: opts.shadow ? [] : edits, spanIds: span.map((e) => e.id), fingerprint: spanFingerprint(entries, from, to), text: opts.text };
}

export interface InvariantContext {
  entries: EntryView[];
  units: Unit[];
  /** First entry index of the working tail. */
  tailStart: number;
  /** First entry index of the latest round. */
  latestRoundStart: number;
  /** Precip replaces a closed region wherever it sits; Palim never enters the working tail. */
  allowTail: boolean;
}

/**
 * The invariants of §4.3, checked on the projected message list before every commit.
 * Returns the reason a plan must be dropped, or null when it may commit.
 */
export function checkInvariants(plan: ReplacePlan, ctx: InvariantContext): string | null {
  const index = new Map(ctx.entries.map((e, i) => [e.id, i]));
  const idxs = plan.spanIds.map((id) => index.get(id));
  if (idxs.some((i) => i === undefined)) return "span entries are no longer on this branch";
  const from = idxs[0]!;
  const to = idxs[idxs.length - 1]! + 1;
  if (to - from !== plan.spanIds.length) return "span is no longer contiguous";
  if (spanFingerprint(ctx.entries, from, to) !== plan.fingerprint) return "span changed since the plan was made";
  // 1. only complete rounds: every tool call's result is inside S, and vice versa
  for (const u of ctx.units) {
    const overlaps = u.start < to && u.end > from;
    if (!overlaps) continue;
    if (u.start < from || u.end > to) return "span cuts a round";
    if (!u.complete) return "span holds an unfinished round";
  }
  // 2. no intersection with the working tail (Palim)
  if (!ctx.allowTail && to > ctx.tailStart) return "span intersects the working tail";
  // 3. never the latest round
  if (to > ctx.latestRoundStart) return "span contains the latest round";
  // 4. the projection stays valid: apply the edits and look for orphaned tool exchanges
  const edited = new Map(plan.edits.map((e) => [e.targetId, e.replacement]));
  const after = ctx.entries
    .map((e) => {
      if (!edited.has(e.id)) return e;
      const r = edited.get(e.id);
      return r === null ? { ...e, omitted: true } : { ...e, omitted: false, edited: true, text: r as string, toolCalls: undefined };
    })
    .filter((e) => !e.omitted);
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const e of after) {
    if (e.kind === "assistant") for (const c of e.toolCalls ?? []) calls.add(c.id);
    if (e.kind === "toolResult" && e.toolCallId) results.add(e.toolCallId);
  }
  const hadCall = new Set<string>();
  const hadResult = new Set<string>();
  for (const e of ctx.entries) {
    if (e.omitted) continue;
    if (e.kind === "assistant") for (const c of e.toolCalls ?? []) hadCall.add(c.id);
    if (e.kind === "toolResult" && e.toolCallId) hadResult.add(e.toolCallId);
  }
  for (const id of results) if (!calls.has(id) && hadCall.has(id)) return "a tool result would lose its call";
  for (const id of calls) if (!results.has(id) && hadResult.has(id)) return "a tool call would lose its result";
  return null;
}

// ───────────────────────────── generation

const PRECIP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["memory", "sidecar"],
  properties: {
    memory: { type: "string" },
    sidecar: {
      type: "object",
      additionalProperties: false,
      required: ["outcome_summary", "state_changes", "artifacts", "open_threads"],
      properties: { outcome_summary: { type: "string" }, state_changes: { type: "array", items: { type: "string" } }, artifacts: { type: "array", items: { type: "string" } }, open_threads: { type: "array", items: { type: "string" } } },
    },
  },
};

const PRECIP_RULES = `Consolidate the finished work below into one memory, written by the agent in the first person ("I …").
memory: prose with no headers and no bullets. Order: what I did, then what worked, then what went wrong.
Keep: an impression of each source consulted; state changes (files changed, commands that altered state); conclusions; supporting evidence quoted VERBATIM in code fences or blockquotes, each with its source (file:line or the tool it came from); unspent evidence (things found but not yet used); informative failures.
Omit: step-by-step details and the internals of sub-purposes (they stay recallable). Lines that start with [t:…] are earlier consolidated work: use them as they are, do not summarize them again.
Never include: future plans, summaries of summaries, or filler.
sidecar: outcome_summary (one sentence), state_changes (files and state that changed), artifacts (paths, commands, identifiers, URLs that matter), open_threads (what was left unresolved).`;

const RIPPLE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["narrative", "knowledge"],
  properties: {
    narrative: { type: "string" },
    knowledge: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["evaluation", "fact", "subject"],
        properties: { evaluation: { type: "string", enum: ["good", "bad", "neutral"] }, fact: { type: "string" }, subject: { type: "string" }, as_of: { type: "string" }, supersedes: { type: "string" } },
      },
    },
  },
};

const RIPPLE_RULES = `Fold the earlier work below into ripple(narrative, knowledge[]).
narrative: what was done, retold one grain coarser than the input. Steps drop out first; then outcomes fold into the undertaking they served. First person, a few sentences.
knowledge[]: one fact per item, { evaluation, fact, subject, as_of?, supersedes? }.
- evaluation: "good" (worked), "bad" (was tried and failed), "neutral" (an observation).
- Write about the subject, not about what the agent learned. Keep identifiers, relations and temporal status.
- Carry earlier knowledge items forward without re-judging them, and merge identical items. Items marked (used) must be carried verbatim.
- Show updates as updates: when a newer fact replaces an older one, give the newer fact with as_of (a date) and supersedes (the older fact in a few words).
- Keep user-supplied records entry by entry.
Lines that start with [t:…] are earlier consolidated work and are inputs like any other.`;

export interface PrecipOutput {
  memory: string;
  sidecar: PrecipSidecar;
}

export interface RippleOutput {
  narrative: string;
  knowledge: KnowledgeItem[];
}

/** Render a span for an aux prompt, tightening tool outputs until it fits the budget. */
export function renderForAux(entries: EntryView[], from: number, to: number, maxTokens: number): string {
  for (const cut of [800, 300, 120]) {
    const parts: string[] = [];
    for (let i = from; i < to; i++) if (!entries[i]!.omitted) parts.push(renderEntry(entries[i]!, { toolOutputTokens: cut }));
    const text = parts.join("\n");
    if (estimateTokens(text) <= maxTokens) return text;
  }
  // still too long: keep the head and the tail of the span
  const parts: string[] = [];
  for (let i = from; i < to; i++) if (!entries[i]!.omitted) parts.push(renderEntry(entries[i]!, { toolOutputTokens: 80, textTokens: 400 }));
  const text = parts.join("\n");
  const keep = maxTokens * 2;
  return text.length > keep * 2 ? `${text.slice(0, keep)}\n[… middle cut …]\n${text.slice(text.length - keep)}` : text;
}

function strings(v: unknown, max = 24): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => sanitize(x.trim())).slice(0, max) : [];
}

function cleanKnowledge(items: unknown): KnowledgeItem[] {
  if (!Array.isArray(items)) return [];
  const out: KnowledgeItem[] = [];
  const seen = new Set<string>();
  for (const k of items) {
    if (!k || typeof k !== "object") continue;
    const r = k as Record<string, unknown>;
    if (typeof r.fact !== "string" || !r.fact.trim()) continue;
    const fact = sanitize(r.fact.trim());
    const key = fact.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      evaluation: r.evaluation === "good" || r.evaluation === "bad" ? r.evaluation : "neutral",
      fact,
      subject: typeof r.subject === "string" ? sanitize(r.subject.trim()) : "",
      as_of: typeof r.as_of === "string" && r.as_of.trim() ? r.as_of.trim().slice(0, 40) : undefined,
      supersedes: typeof r.supersedes === "string" && r.supersedes.trim() ? sanitize(r.supersedes.trim()) : undefined,
    });
  }
  return out;
}

export function knowledgeKey(k: KnowledgeItem): string {
  return k.fact.toLowerCase().replace(/\s+/g, " ").trim();
}

export class Consolidator {
  private readonly aux: () => AuxSessionRunner | null;
  private readonly maxInputTokens: () => number;

  constructor(deps: { aux: () => AuxSessionRunner | null; maxInputTokens: () => number }) {
    this.aux = deps.aux;
    this.maxInputTokens = deps.maxInputTokens;
  }

  newId(state: SessionState): string {
    return `t:${freshId8((id) => state.records.has(`t:${id}`))}`;
  }

  /** Precip (§5.3): the closed region as currently projected, the telos chain, the intent and its outcome. */
  async precip(input: { entries: EntryView[]; from: number; to: number; intent: Intent; outcome: IntentOutcome; telos: string[]; deliveries: Delivery[]; merged?: Intent[] }, signal?: AbortSignal): Promise<PrecipOutput | null> {
    const aux = this.aux();
    if (!aux?.available()) return null;
    const { intent, outcome } = input;
    const res = await aux.run<PrecipOutput>({
      role: "precip",
      instructions: PRECIP_RULES,
      data: [
        { label: "PURPOSE", text: [`"${intent.label}" — ${outcomeWord(outcome)}`, `why: ${intent.reason}`, `done when: ${intent.success}`, `give up when: ${intent.failure}`, ...(input.merged ?? []).map((m) => `(closed together with its sub-purpose "${m.label}")`)].join("\n") },
        ...(input.telos.length ? [{ label: "ENCLOSING PURPOSES (outermost first)", text: input.telos.join(" > ") }] : []),
        ...(input.deliveries.length ? [{ label: "MEMORY AND ARCHIVE ITEMS DELIVERED DURING THIS WORK", text: input.deliveries.map((d) => `[${d.id}] via ${d.channel}`).join("\n") }] : []),
        { label: "WORK TO CONSOLIDATE", text: renderForAux(input.entries, input.from, input.to, this.maxInputTokens()) },
      ],
      schema: PRECIP_SCHEMA,
      tools: "none",
      signal,
    });
    const out = res.output;
    if (!out || typeof out.memory !== "string" || !out.memory.trim()) return null;
    const sc = (out.sidecar ?? {}) as Partial<PrecipSidecar>;
    return {
      memory: sanitize(out.memory.trim()),
      sidecar: { outcome_summary: typeof sc.outcome_summary === "string" ? sanitize(sc.outcome_summary) : "", state_changes: strings(sc.state_changes), artifacts: strings(sc.artifacts, 32), open_threads: strings(sc.open_threads) },
    };
  }

  /**
   * Palim's ripple fold (§5.4.4). `carry` are knowledge items of earlier folds inside the span;
   * those marked used are carried verbatim. `concise` grows with every retry.
   */
  async ripple(input: { text: string; carry: KnowledgeItem[]; telos: string[]; instructions?: string; pressure?: boolean; concise?: number }, signal?: AbortSignal): Promise<RippleOutput | null> {
    const aux = this.aux();
    if (!aux?.available()) return null;
    const concise = input.concise ? `\nYour previous attempt was too long. Be ${input.concise > 1 ? "much " : ""}more concise: a shorter narrative, and only knowledge that would change a later decision.` : "";
    const res = await aux.run<RippleOutput>({
      role: "palim",
      instructions: `${RIPPLE_RULES}${concise}${input.instructions ? `\nThe user asked for this when compacting: ${input.instructions}` : ""}`,
      data: [
        ...(input.telos.length ? [{ label: "CURRENT PURPOSES (outermost first)", text: input.telos.join(" > ") }] : []),
        ...(input.carry.length ? [{ label: "KNOWLEDGE FROM EARLIER FOLDS", text: input.carry.map((k) => `${renderKnowledge([k])}${k.used ? " (used)" : ""}`).join("\n") }] : []),
        { label: "WORK TO FOLD", text: input.text },
      ],
      schema: RIPPLE_SCHEMA,
      tools: "none",
      budget: input.pressure ? { thinking: "low", timeoutMs: 30_000 } : undefined,
      signal,
    });
    const out = res.output;
    if (!out || typeof out.narrative !== "string" || !out.narrative.trim()) return null;
    const knowledge = cleanKnowledge(out.knowledge);
    // use-and-disuse: items that attribution marked as used are carried verbatim
    const have = new Set(knowledge.map(knowledgeKey));
    for (const k of input.carry) {
      if (!k.used || have.has(knowledgeKey(k))) continue;
      knowledge.push({ ...k });
    }
    for (const k of knowledge) {
      const prev = input.carry.find((c) => knowledgeKey(c) === knowledgeKey(k));
      if (prev?.used) k.used = true;
      if (prev?.memoryId) k.memoryId = prev.memoryId;
    }
    return { narrative: sanitize(out.narrative.trim()), knowledge };
  }
}

export { GUIDANCE_TYPE, renderPalim, renderPrecip };
