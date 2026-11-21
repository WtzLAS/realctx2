/**
 * The context engine (§5): Janus keeps the intent stack, Precip consolidates closed intents,
 * Palim folds stable prefixes and relieves pressure, and attribution records what was used.
 * It talks to the harness only through `HarnessAdapter`, so the same engine drives pi (L2,
 * persisted edits) and append-only harnesses (L0, shadow consolidation).
 */
import type { Config } from "../core/config.ts";
import { effectiveCacheTtlSeconds, isContextEngineEnabled, scaledContext } from "../core/config.ts";
import type { Telemetry } from "../core/telemetry.ts";
import type { Clock, CommitBatch, ConsolidationRecord, ContextEdit, DecisionClient, Delivery, DeliveryChannel, EntryView, GuidanceMessage, HarnessAdapter, Intent, IntentOutcome, ScopedNode, ScopeName, SessionRecord } from "../core/types.ts";
import { emptyBatch } from "../core/types.ts";
import { renderCards } from "../memory/cards.ts";
import { commandActions, type PathEvent, type Shown } from "../memory/delivery.ts";
import type { Retriever } from "../memory/retrieve.ts";
import type { MemoryRuntime } from "../memory/runtime.ts";
import { rawTurnId } from "../storage/turnindex.ts";
import { raceTimeout } from "../util/async.ts";
import { errMsg } from "../util/errors.ts";
import { randomId8 } from "../util/ids.ts";
import { normalizeCommandParts } from "../util/shell.ts";
import { estimateTokens, extractPathTokens, ngramOverlap } from "../util/text.ts";
import { type BlobStore, guardToolResult } from "./archive.ts";
import { Attributor } from "./attribution.ts";
import { checkInvariants, Consolidator, planReplace, renderForAux, type ReplacePlan, spanFingerprint } from "./consolidate.ts";
import { Harvester } from "./harvest.ts";
import { Janus, type JanusInput, type JanusPlan, type KindlePlan, type ScribedIntent } from "./janus.ts";
import { Palim } from "./palim.ts";
import { GUIDANCE_TYPE, renderGuidance, renderLateCards, renderPalim, renderPrecip, renderReinjection, renderReminder } from "./render.ts";
import { alignToUnits, latestRoundStart, roundCount, sumTokens, toUnits, type Unit, workingTail } from "./rounds.ts";
import { SessionState } from "./state.ts";

export interface EngineOptions {
  adapter: HarnessAdapter;
  cfg: Config;
  decision: DecisionClient;
  sessionId: string;
  memory?: MemoryRuntime | null;
  blobs: BlobStore;
  telemetry?: Telemetry;
  clock?: Clock;
  /** Light mode for sub-sessions and subagents: no Janus, Precip or attribution (§4.6.7). */
  light?: boolean;
}

export interface ToolCallInfo {
  toolCallId: string;
  /** Present for path-relevant tools. */
  event?: PathEvent;
  /** A call made by another tool (pi `parentToolCallId`): gated, but never patched. */
  nested?: boolean;
  subagent?: boolean;
  /** One of realctx2's own tools. */
  own?: boolean;
}

export interface ToolResultInfo extends ToolCallInfo {
  toolName: string;
  text: string;
  isError: boolean;
  /** Deliveries reported by realctx2's own tools (`details.deliveries`). */
  deliveries?: PendingDelivery[];
}

export interface PendingDelivery {
  id: string;
  kind: Delivery["kind"];
  channel: DeliveryChannel;
  nodeIds?: string[];
  scope?: ScopeName;
  text: string;
  signature?: string[];
  full?: boolean;
}

/** One Janus request, from the evidence it saw to the plan it produced. */
interface JanusRun {
  promise: Promise<JanusPlan>;
  input: JanusInput;
  done: boolean;
  plan: JanusPlan | null;
  /** Start order: a newer answer replaces an older one that is still waiting. */
  seq: number;
  /** Branch generation: answers for a branch that was left are dropped. */
  gen: number;
  /** Intents known when the evidence was taken. */
  intents: number;
}

interface PrecipJob {
  intent: Intent;
  outcome: IntentOutcome;
  merged: Intent[];
  promise: Promise<ReplacePlan | null> | null;
  plan: ReplacePlan | null;
  done: boolean;
  /** Closed at agent_before_settle: Precip runs during idle time. */
  deferred: boolean;
  /** An inner closure of the same step: it consolidates and commits first. */
  after: PrecipJob | null;
  committed: boolean;
  /** Merged into its parent's Precip: only its deliveries are attributed here. */
  attributionOnly?: boolean;
}

/** A freshly opened intent and what goes into its guidance. */
interface Kindled {
  intent: Intent;
  cards: string;
  shown: Shown[];
  pathText: string;
  pathShown: Shown[];
}

/** Proactive cards whose (emulated) gate was still running when their intent was kindled. */
interface LateCards {
  intentId: string;
  gen: number;
  done: boolean;
  result: Awaited<ReturnType<Retriever["proactive"]>> | null;
}

/**
 * Where a late intent starts: the entry after `afterId` (the leaf when its kindle was planned),
 * past the user message it answers when it was planned for one.
 */
interface KindleStart {
  afterId: string;
  skipUser: boolean;
}

/** A kindle whose scribe missed its commit point's budget: the intent opens at a later one. */
interface LateKindle {
  kindle: KindlePlan;
  gen: number;
  intents: number;
  done: boolean;
  scribed: ScribedIntent | null;
  settled: Promise<void>;
  start: KindleStart;
}

const ROOT = "root";

/** Milliseconds until `deadline` (a `Date.now()` value), never negative. */
function timeLeft(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

export class ContextEngine {
  readonly adapter: HarnessAdapter;
  readonly cfg: Config;
  readonly sessionId: string;
  readonly memory: MemoryRuntime | null;
  readonly blobs: BlobStore;
  readonly janus: Janus;
  readonly consolidator: Consolidator;
  readonly attributor: Attributor;
  /** Folds of stable prefixes and pressure relief (§5.4). */
  readonly palim: Palim;
  /** Episodes and knowledge handed to long-term memory (§5.3.4, §5.4.4). */
  private readonly harvester: Harvester;
  readonly light: boolean;
  private readonly telemetry?: Telemetry;
  private readonly clock: Clock;

  state = new SessionState();
  entries: EntryView[] = [];
  units: Unit[] = [];
  private index = new Map<string, number>();
  /** Records and edits waiting for the next commit point. */
  private pending: CommitBatch = emptyBatch();
  private unresolvedDeliveries: Array<{ d: Delivery; guidanceKey?: string }> = [];
  private janusRun: JanusRun | null = null;
  /** The newest answer that missed its commit point; it applies at the next one (§5.2.1). */
  private lateJanus: JanusRun | null = null;
  private janusSeq = 0;
  private janusGen = 0;
  private janusInFlight = 0;
  /** Proactive cards that missed their kindle, one entry per intent, delivered when they arrive. */
  private lateCards: LateCards[] = [];
  /** A kindle whose scribe missed its commit point's budget: the intent opens at the next one. */
  private lateKindle: LateKindle | null = null;
  /** Kindled intents whose guidance is deferred past the next assistant response (steering/follow-up). */
  private pendingStarts = new Map<string, KindleStart>();
  private janusStartedThisTurn = false;
  private closeProb: Record<string, number> = {};
  private precipJobs: PrecipJob[] = [];
  /** Plans applied to a live request through the `context` hook, to be persisted at the next commit point. */
  private appliedNow: ReplacePlan[] = [];
  private actions = new Map<string, PathEvent[]>();
  private turnPathTokens = 0;
  private gatedThisTurn = new Set<string>();
  private shownThisTurn = new Set<string>();
  private lastRequestAt = 0;
  private requests = 0;
  private background = new Set<Promise<unknown>>();
  private lastReminderRound = new Map<string, number>();
  private statsDirty = false;
  private indexedEntries: Set<string> | null = null;
  private projectRuleIds = new Set<string>();
  /** Tokens saved by edits queued in this step: the harness's request size does not reflect them yet. */
  private savedThisStep = 0;
  problems: string[] = [];

  constructor(o: EngineOptions) {
    this.adapter = o.adapter;
    this.cfg = o.cfg;
    this.sessionId = o.sessionId;
    this.memory = o.memory ?? null;
    this.blobs = o.blobs;
    this.telemetry = o.telemetry;
    this.clock = o.clock ?? (() => new Date());
    this.light = o.light === true;
    const aux = () => {
      try {
        return this.adapter.aux();
      } catch {
        return null;
      }
    };
    this.janus = new Janus({ cfg: o.cfg, decision: o.decision, aux, sim: this.memory?.sim ?? null });
    this.consolidator = new Consolidator({ aux, maxInputTokens: () => Math.max(8000, Math.floor(this.window() * 0.4)) });
    this.attributor = new Attributor({ cfg: o.cfg, decision: o.decision, graph: this.memory?.graph, delivery: this.memory?.delivery, accounting: this.memory?.accounting, log: this.memory?.evoLog });
    this.harvester = new Harvester({
      memory: this.memory,
      sessionId: o.sessionId,
      consolidator: this.consolidator,
      state: () => this.state,
      emit: (record) => this.emit(record),
      track: (p) => this.track(p),
    });
    this.palim = new Palim({
      cfg: o.cfg,
      adapter: o.adapter,
      consolidator: this.consolidator,
      telemetry: o.telemetry,
      entries: () => this.entries,
      units: () => this.units,
      state: () => this.state,
      round: () => this.round,
      window: () => this.window(),
      scaled: () => this.scaled(),
      now: () => this.now(),
      expectedRequests: () => (this.memory ? this.memory.expectedRequests(this.requests) : 20),
      closeProb: (intentId) => this.closeProb[intentId] ?? 0,
      savedThisStep: () => this.savedThisStep,
      statsChanged: () => {
        this.statsDirty = true;
      },
      track: (p) => this.track(p),
      commitPlan: (plan, opts) => this.commitPlan(plan, opts),
    });
  }

  // ───────────── basics
  get level(): 0 | 1 | 2 {
    return this.adapter.capabilities.level;
  }

  /** Whether the context engine is enabled for the active model (`maxWindow === 0` disables it). */
  contextEnabled(): boolean {
    return isContextEngineEnabled(this.cfg, this.adapter.modelName());
  }

  window(): number {
    return scaledContext(this.cfg, this.adapter.maxContextTokens(), this.adapter.modelName()).W;
  }

  private scaled() {
    return scaledContext(this.cfg, this.adapter.maxContextTokens(), this.adapter.modelName());
  }

  private now(): string {
    return this.clock().toISOString();
  }

  get round(): number {
    return roundCount(this.units);
  }

  /** Reload entries and rebuild state from the active branch. All session state is branch-relative. */
  async rebuild(): Promise<void> {
    const [entries, records] = await Promise.all([this.adapter.listEntries(), this.adapter.listRecords()]);
    this.state = SessionState.from(records);
    this.setEntries(entries);
    this.harvester.reset();
    // jobs and ephemeral turn/branch state planned against another branch are void
    this.precipJobs = [];
    this.palim.reset();
    this.appliedNow = [];
    this.janusRun = null;
    this.lateJanus = null;
    this.lateCards = [];
    this.lateKindle = null;
    this.pendingStarts.clear();
    this.janusGen++;
    this.janusStartedThisTurn = false;
    this.closeProb = {};
    this.actions.clear();
    this.turnPathTokens = 0;
    this.gatedThisTurn.clear();
    this.shownThisTurn.clear();
    this.lastReminderRound.clear();
    this.statsDirty = false;
    this.savedThisStep = 0;
    this.indexedEntries = null;
    this.pending = emptyBatch();
    this.unresolvedDeliveries = [];
    this.resolveIds();
  }

  private setEntries(entries: EntryView[]): void {
    this.entries = entries;
    this.units = toUnits(entries);
    this.index = new Map(entries.map((e, i) => [e.id, i]));
  }

  private async refresh(): Promise<void> {
    this.setEntries(await this.adapter.listEntries());
    this.resolveIds();
  }

  /** Fill in entry ids the harness assigned after we handed it guidance and tool results. */
  private resolveIds(): void {
    for (const intent of this.state.stack) {
      if (intent.guidanceEntryId && this.index.has(intent.guidanceEntryId)) {
        this.pendingStarts.delete(intent.id);
        continue;
      }
      const start = this.pendingStarts.get(intent.id);
      if (start) {
        const first = this.entryAfter(start);
        if (first) {
          this.pendingStarts.delete(intent.id);
          intent.guidanceEntryId = first;
          this.emit({ type: "realctx2.intent", intent: { ...intent } }, false);
          continue;
        }
      }
      const e = this.entries.find((x) => x.kind === "custom_message" && x.customType === GUIDANCE_TYPE && (x.details as { intentId?: string } | undefined)?.intentId === intent.id);
      if (e && intent.guidanceEntryId !== e.id) {
        this.pendingStarts.delete(intent.id);
        intent.guidanceEntryId = e.id;
        this.emit({ type: "realctx2.intent", intent: { ...intent } }, false);
      }
    }
    if (!this.unresolvedDeliveries.length) return;
    const still: typeof this.unresolvedDeliveries = [];
    for (const u of this.unresolvedDeliveries) {
      let entry: EntryView | undefined;
      if (u.d.toolCallId) entry = this.entries.find((e) => e.kind === "toolResult" && e.toolCallId === u.d.toolCallId);
      else if (u.guidanceKey) entry = this.entries.find((e) => e.kind === "custom_message" && (e.details as { key?: string } | undefined)?.key === u.guidanceKey);
      if (entry) {
        u.d.entryId = entry.id;
        this.pending.records.push({ type: "realctx2.delivery", delivery: { ...u.d } });
      } else still.push(u);
    }
    this.unresolvedDeliveries = still;
  }

  /** Apply a record to the state and queue it for the next commit point. */
  private emit(record: SessionRecord, apply = true): void {
    if (apply) this.state.apply(record);
    this.pending.records.push(record);
  }

  private take(): CommitBatch {
    const batch = this.pending;
    this.pending = emptyBatch();
    return batch;
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.background.add(p);
    void p.finally(() => this.background.delete(p)).catch(() => undefined);
    return p;
  }

  /** Wait for background work (harvest, episode writes). Used at shutdown and in tests. */
  async settleBackground(): Promise<void> {
    while (this.background.size) await Promise.allSettled([...this.background]);
  }

  private intentKey(): string {
    return this.state.innermost()?.id ?? ROOT;
  }

  // ───────────── deliveries (§5.5.1)
  private visibleText(maxEntries = 40): string {
    const parts: string[] = [];
    for (let i = this.entries.length - 1; i >= 0 && parts.length < maxEntries; i--) if (!this.entries[i]!.omitted) parts.push(this.entries[i]!.text);
    return parts.join("\n");
  }

  /** Record that something entered context. Returns the delivery. */
  deliver(p: PendingDelivery, where: { toolCallId?: string; guidanceKey?: string; entryId?: string; subagent?: boolean }): Delivery {
    const signature = p.signature ?? (p.nodeIds?.length && this.memory ? (this.memory.graph.get(p.nodeIds[0]!)?.node.signature ?? []) : []);
    const d: Delivery = {
      deliveryId: randomId8(),
      id: p.id,
      kind: p.kind,
      nodeIds: p.nodeIds,
      scope: p.scope,
      channel: p.channel,
      entryId: where.entryId ?? "",
      intentId: this.state.innermost()?.id ?? null,
      tokens: estimateTokens(p.text),
      restatedRatio: p.text ? Math.round(ngramOverlap(p.text, this.visibleText()) * 100) / 100 : 0,
      signature,
      round: this.round,
      full: p.full,
      toolCallId: where.toolCallId,
      subagent: where.subagent || undefined,
    };
    this.state.deliveries.push(d);
    if (d.entryId) this.pending.records.push({ type: "realctx2.delivery", delivery: d });
    else this.unresolvedDeliveries.push({ d, guidanceKey: where.guidanceKey });
    if (p.full && p.nodeIds) for (const id of p.nodeIds) this.shownThisTurn.add(id);
    return d;
  }

  /** Whether an earlier delivery of a memory is still visible in context (no repeats, §6.8.5). */
  isVisible(memoryId: string): boolean {
    if (this.projectRuleIds.has(memoryId)) return true;
    for (let i = this.state.deliveries.length - 1; i >= 0; i--) {
      const d = this.state.deliveries[i]!;
      if (!d.nodeIds?.includes(memoryId) || d.channel === "gate" || d.channel === "search") continue;
      if (!d.entryId) return true; // just delivered: the harness has not assigned the entry yet
      const at = this.index.get(d.entryId);
      if (at === undefined) continue;
      const e = this.entries[at]!;
      // once Precip or Palim has consolidated that delivery away, the next touch delivers it again
      if (!e.omitted && !(e.edited && this.state.recordAt(e.id))) return true;
    }
    return false;
  }

  private gateContext() {
    const intentId = this.state.innermost()?.id ?? null;
    const inIntent = (d: Delivery) => (intentId ? d.intentId === intentId : false);
    return {
      // at most once per memory per intent; in the root region, once per user turn
      gated: (id: string) => (intentId ? this.state.deliveries.some((d) => d.channel === "gate" && inIntent(d) && d.nodeIds?.includes(id)) : this.gatedThisTurn.has(id)),
      // not at all if the memory was already shown in full earlier in the same intent
      shownFull: (id: string) => (intentId ? this.state.deliveries.some((d) => d.channel !== "gate" && d.full && inIntent(d) && d.nodeIds?.includes(id)) : this.shownThisTurn.has(id)),
    };
  }

  private deliverShown(shown: Shown[], channel: DeliveryChannel, where: { toolCallId?: string; guidanceKey?: string; subagent?: boolean }): void {
    for (const s of shown) {
      this.deliver({ id: `m:${s.ref.node.id}`, kind: "card", channel, nodeIds: [s.ref.node.id], scope: s.ref.scope, text: s.full ? s.ref.node.text : s.ref.node.title, signature: s.ref.node.signature, full: s.full }, where);
    }
  }

  // ───────────── system prompt pieces
  /** The always-on "Project rules" section (§6.9.5). Its ids count as visible for path delivery. */
  projectRules(): string {
    if (!this.memory) return "";
    const pr = this.memory.delivery.projectRules();
    this.projectRuleIds = new Set(pr.ids);
    return pr.text;
  }

  // ───────────── Janus plumbing
  private janusInput(mode: "full" | "closure", userMessage?: string, scope?: { entries: EntryView[]; units: Unit[] }): JanusInput {
    const entries = scope?.entries ?? this.entries;
    const units = scope?.units ?? this.units;
    return { state: this.state, entries, units, userMessage, mode, round: roundCount(units), cacheKey: `${this.sessionId}.janus` };
  }

  /**
   * Turn a Janus plan into records and at most one guidance message. With a `deadline` (a user
   * message or `turn_end`), the scribe and the proactive cards get only the time left: a late
   * scribe opens its intent at the next commit point, late cards follow. `userMessage` marks a
   * plan for a user message that is not in the transcript yet; when the harness already appended
   * the user message (steering/follow-up), `closeAt`, `kindleStart`, and `deferredGuidance` keep
   * closures before it and the new intent starting after it.
   */
  private async applyPlan(
    plan: JanusPlan,
    input: JanusInput,
    opts: { deferPrecip?: boolean; extraPaths?: string; deadline?: number; userMessage?: boolean; closeAt?: string; kindleStart?: KindleStart; deferredGuidance?: boolean } = {},
  ): Promise<GuidanceMessage | null> {
    Object.assign(this.closeProb, plan.closeProb);
    const leaf = opts.closeAt ?? (this.entries[this.entries.length - 1]?.id ?? "");
    const closedNow: Array<{ intent: Intent; outcome: IntentOutcome }> = [];
    // closures, innermost first; only intents that are still open on this branch
    for (const c of plan.closures) {
      const cur = this.state.intents.get(c.intent.id);
      if (!cur || cur.status !== "open") continue;
      this.pendingStarts.delete(cur.id);
      const closed: Intent = { ...cur, status: c.outcome, closedEntryId: leaf };
      const level = this.state.stack.findIndex((i) => i.id === cur.id) + 1;
      this.emit({ type: "realctx2.intent", intent: closed });
      closedNow.push({ intent: closed, outcome: c.outcome });
      // falling back: the level its consolidation lands in has to become stable again,
      // so the frontier drops below it and the climb's clock starts over
      this.state.stats.frontier = Math.max(0, Math.min(this.state.stats.frontier ?? 0, level - 2));
      this.state.stats.lastClimbRound = this.round;
      this.statsDirty = true;
    }
    if (closedNow.length) this.queuePrecip(closedNow, opts.deferPrecip === true);

    let k: Kindled | null = null;
    // a kindle whose scribe is still running: its intent opens at the next commit point
    let pending = false;
    const start: KindleStart = opts.kindleStart ?? { afterId: leaf, skipUser: opts.userMessage === true };
    if (plan.kindle && input.mode === "full") {
      const scribed = await this.scribeBy(input, plan.kindle, opts.deadline, start);
      if (scribed) {
        k = await this.kindle(scribed, plan.kindle, { signal: input.signal, extraPaths: opts.extraPaths, deadline: opts.deadline });
        if (opts.deferredGuidance) this.pendingStarts.set(k.intent.id, start);
      } else pending = this.lateKindle?.kindle === plan.kindle;
    }
    const pathText = k ? k.pathText : (opts.extraPaths ?? "");
    if (!closedNow.length && !k) {
      if (pathText) return this.guidance(pathText, { key: randomId8() });
      return pending ? null : this.reminder();
    }
    // not "back to" the parent when the next commit point says "now working on" something else
    const backTo = !k && !pending && closedNow.length ? this.state.innermost() : null;
    return this.kindleGuidance(k, { closed: closedNow, backTo, paths: pathText, focus: plan.focus });
  }

  /** The guidance message for closures and a kindle; its proactive cards and path memories are deliveries. */
  private kindleGuidance(k: Kindled | null, o: { closed: Array<{ intent: Intent; outcome: IntentOutcome }>; backTo: Intent | null; paths: string; focus: JanusPlan["focus"] }): GuidanceMessage {
    const key = randomId8();
    const kindled = k?.intent ?? null;
    const parentLabel = kindled?.parentId ? this.state.intents.get(kindled.parentId)?.label : undefined;
    const text = renderGuidance({ closed: o.closed, kindled, parentLabel, backTo: o.backTo, cards: k?.cards ?? "", paths: o.paths });
    const msg = this.guidance(text, { key, ...(kindled ? { intentId: kindled.id } : {}) });
    // recorded against the kindled intent
    if (k?.shown.length) this.deliverShown(k.shown, "proactive", { guidanceKey: key });
    if (k?.pathShown.length) this.deliverShown(k.pathShown, "path", { guidanceKey: key });
    this.telemetry?.step({ kind: "janus", closures: o.closed.length, kindled: !!kindled, focus: o.focus, cards: k?.shown.length ?? 0 });
    return msg;
  }

  /**
   * The scribe for a kindle. Past `deadline` it keeps running and its intent opens at the next
   * commit point, unless another intent was kindled or the branch changed in the meantime.
   */
  private async scribeBy(input: JanusInput, kindle: KindlePlan, deadline: number | undefined, start: KindleStart): Promise<ScribedIntent | null> {
    const scribing = this.janus.scribe(input, kindle, this.state.stack);
    if (deadline === undefined) return scribing;
    const late: LateKindle = { kindle, gen: this.janusGen, intents: this.state.intents.size, done: false, scribed: null, settled: Promise.resolve(), start };
    late.settled = scribing.then(
      (s) => {
        late.scribed = s;
        late.done = true;
      },
      (e) => {
        late.done = true;
        this.telemetry?.event("janus.scribe_failed", { error: errMsg(e) });
      },
    );
    await raceTimeout(late.settled, timeLeft(deadline), input.signal);
    if (late.done) return late.scribed;
    // the user cancelled the prompt: the kindle is dropped, the next commit point decides anew
    if (input.signal?.aborted) return null;
    this.lateKindle = late;
    this.telemetry?.event("janus.kindle_late", {});
    return null;
  }

  /** Open a scribed intent, with its proactive cards and the path memories it names. */
  private async kindle(scribed: ScribedIntent, kindle: KindlePlan, o: { signal?: AbortSignal; extraPaths?: string; deadline?: number; startEntryId?: string }): Promise<Kindled> {
    const parent = kindle.parentId ? this.state.intents.get(kindle.parentId) : undefined;
    const parentId = parent?.status === "open" ? parent.id : kindle.parentId && this.state.stack.length ? this.state.innermost()!.id : null;
    const intent = this.janus.newIntent(scribed, parentId, this.round);
    // a late intent governs from where it was planned, not from its guidance (resolveIds keeps it)
    if (o.startEntryId) intent.guidanceEntryId = o.startEntryId;
    if (parentId === null) {
      // a new root: ordinary folds start again from the root prefix
      this.state.stats.frontier = 0;
      this.statsDirty = true;
    }
    const k: Kindled = { intent, cards: "", shown: [], pathText: o.extraPaths ?? "", pathShown: [] };
    if (this.memory) {
      this.memory.recordPurpose(intent.id, `${intent.label}\n${intent.reason}`);
      try {
        const parentLabel = parentId ? this.state.intents.get(parentId)?.label : undefined;
        const pro = await this.proactiveCards(intent, parentLabel, o.signal, o.deadline === undefined ? undefined : timeLeft(o.deadline));
        k.cards = pro?.text ?? "";
        k.shown = pro?.cards ?? [];
        // path memories for paths named in the intent and touched in the last 2 rounds
        const mentioned = this.memory.paths.resolveMentions(extractPathTokens(`${intent.label} ${intent.reason} ${intent.success}`));
        const recent = this.recentPaths(2);
        const paths = [...new Set([...mentioned, ...recent])].slice(0, 4);
        if (paths.length && !k.pathText) {
          const block = this.memory.delivery.block({ action: "read", paths }, { visible: (id) => this.isVisible(id) || k.shown.some((s) => s.ref.node.id === id), turnTokensLeft: Math.max(0, this.cfg.paths.perTurnTokens - this.turnPathTokens) });
          if (block) {
            k.pathText = block.text;
            k.pathShown = block.shown;
            this.turnPathTokens += block.tokens;
          }
        }
      } catch (e) {
        this.telemetry?.event("proactive.failed", { error: errMsg(e) });
      }
    }
    this.emit({ type: "realctx2.intent", intent: { ...intent } });
    return k;
  }

  /**
   * An intent whose scribe missed its commit point: it opens now, with its own guidance. It
   * governs from where it was planned, so the rounds in between consolidate with it. The scribe
   * gets until `deadline`; one still running then stays pending.
   */
  private async takeLateKindle(deadline: number, signal?: AbortSignal): Promise<GuidanceMessage | null> {
    const late = this.lateKindle;
    if (!late) return null;
    if (!late.done) await raceTimeout(late.settled, timeLeft(deadline));
    if (!late.done || this.lateKindle !== late) return null;
    this.lateKindle = null;
    if (!late.scribed || late.gen !== this.janusGen || this.state.intents.size !== late.intents) return null;
    const k = await this.kindle(late.scribed, late.kindle, { signal, deadline, startEntryId: this.entryAfter(late.start) });
    return this.kindleGuidance(k, { closed: [], backTo: null, paths: k.pathText, focus: null });
  }

  /** The first entry a late intent governs, if the transcript has it. */
  private entryAfter(s: KindleStart): string | undefined {
    let i = s.afterId ? this.index.get(s.afterId) : -1;
    if (i === undefined) return undefined;
    i++;
    if (s.skipUser && this.entries[i]?.kind === "user") i++;
    return this.entries[i]?.id;
  }

  /** How long a user message waits for Janus in all: the decision, the scribe and the proactive cards. */
  private promptBudgetMs(): number {
    return Math.max(0, this.janus.slow() ? this.cfg.janus.lateWaitMs : this.cfg.janus.timeoutMs);
  }

  /**
   * Proactive retrieval for a kindled intent (§6.4.1). With a decision model the gate answers
   * within its own timeout. An aux-emulated gate takes seconds: the kindle does not wait for it,
   * and the cards follow at the next commit point.
   */
  private async proactiveCards(intent: Intent, parentLabel: string | undefined, signal?: AbortSignal, waitMs?: number): Promise<Awaited<ReturnType<Retriever["proactive"]>> | null> {
    const run = this.memory!.retriever.proactive({ label: intent.label, reason: intent.reason, parentLabel }, { signal });
    const wait = waitMs ?? (this.janus.slow() ? this.cfg.janus.lateWaitMs : undefined);
    if (wait === undefined) return run;
    const late: LateCards = { intentId: intent.id, gen: this.janusGen, done: false, result: null };
    const settled = run.then(
      (r) => {
        late.result = r;
        late.done = true;
        return r;
      },
      (e) => {
        late.done = true;
        this.telemetry?.event("proactive.failed", { error: errMsg(e) });
        return null;
      },
    );
    await raceTimeout(settled, wait, signal);
    if (late.done) return late.result;
    if (signal?.aborted) return null;
    this.lateCards.push(late);
    return null;
  }

  /** Cards that arrived after their intent's guidance: one more guidance message per intent that is still open. */
  private takeLateCards(): GuidanceMessage[] {
    const ready = this.lateCards.filter((l) => l.done);
    if (!ready.length) return [];
    this.lateCards = this.lateCards.filter((l) => !l.done);
    const out: GuidanceMessage[] = [];
    for (const late of ready) {
      const intent = this.state.intents.get(late.intentId);
      if (late.gen !== this.janusGen || !intent || intent.status !== "open" || !this.memory) continue;
      // what became visible in the meantime (path memories, search, earlier cards) is not repeated
      const fresh = (late.result?.cards ?? []).filter((c) => !this.isVisible(c.ref.node.id));
      if (!fresh.length) continue;
      const captionIds = new Set(fresh.filter((c) => !c.full).map((c) => c.ref.node.id));
      const rendered = renderCards(fresh.map((c) => c.ref), this.memory.graph, this.memory.paths, { budgetTokens: this.cfg.memory.proactive.maxTokens, captionIds });
      if (!rendered.shown.length) continue;
      const key = randomId8();
      this.deliverShown(rendered.shown, "proactive", { guidanceKey: key });
      out.push(this.guidance(renderLateCards(intent, rendered.text), { key, cardsFor: intent.id }));
    }
    return out;
  }

  private guidance(content: string, details: Record<string, unknown>): GuidanceMessage {
    return { customType: GUIDANCE_TYPE, content, display: true, details };
  }

  /** A compact reminder every `janus.remindEvery` rounds within the same intent (§5.2.4). */
  private reminder(): GuidanceMessage | null {
    const intent = this.state.innermost();
    if (!intent) return null;
    const every = this.cfg.janus.remindEvery;
    const since = Janus.roundsSince(intent, this.entries, this.units);
    const last = this.lastReminderRound.get(intent.id) ?? intent.openedRound;
    if (since < every || this.round - last < every) return null;
    this.lastReminderRound.set(intent.id, this.round);
    const parent = intent.parentId ? this.state.intents.get(intent.parentId)?.label : undefined;
    return { customType: GUIDANCE_TYPE, content: renderReminder(intent, parent), display: false, details: { reminder: intent.id } };
  }

  private recentPaths(rounds: number): string[] {
    const list = this.actions.get(this.intentKey()) ?? [];
    return [...new Set(list.slice(-rounds * 4).flatMap((a) => a.paths))].slice(0, 6);
  }

  // ───────────── events
  /** `session_start`, `session_tree`, fork and resume. */
  async onSessionStart(): Promise<void> {
    await this.rebuild();
    this.lastRequestAt = this.clock().getTime();
  }

  /**
   * A new user message (`before_agent_start`, `UserPromptSubmit`, or pi steering/follow-up):
   * full Janus, synchronously, with the message included. Returns records to append and at most
   * one guidance message. When `opts.inTranscript` is set, that many trailing user entries are
   * already in the transcript (pi persisted steering/follow-up messages before `context`): Janus
   * sees the prior transcript plus `text`, closures end before them, and any kindled intent starts
   * at the first entry after them. An abort of `signal` (the user cancelled the prompt) ends every
   * wait at once: what is not decided by then is dropped, not deferred, and the next commit point
   * decides anew.
   */
  async onUserMessage(text: string, signal?: AbortSignal, opts?: { inTranscript?: number }): Promise<CommitBatch> {
    await this.refresh();
    this.turnPathTokens = 0;
    this.gatedThisTurn.clear();
    this.shownThisTurn.clear();
    this.janusStartedThisTurn = false;
    const batch = emptyBatch();
    // paths the user mentions bring their rules and facts along (§6.8.5)
    let mention = "";
    let mentionShown: Shown[] = [];
    if (this.memory && text) {
      const paths = this.memory.paths.resolveMentions(extractPathTokens(text)).slice(0, 3);
      if (paths.length) {
        const block = this.memory.delivery.block({ action: "read", paths }, { visible: (id) => this.isVisible(id), turnTokensLeft: this.cfg.paths.perTurnTokens });
        if (block) {
          mention = block.text;
          mentionShown = block.shown;
          this.turnPathTokens += block.tokens;
        }
      }
    }
    const inTranscript = opts?.inTranscript ?? 0;
    let priorEntries = this.entries;
    let priorUnits = this.units;
    let priorLeaf = this.entries[this.entries.length - 1]?.id ?? "";
    let userLeaf = priorLeaf;
    if (inTranscript > 0) {
      let cut = this.entries.length;
      for (let n = 0; n < inTranscript && cut > 0 && this.entries[cut - 1]!.kind === "user"; n++) cut--;
      if (cut < this.entries.length) {
        priorEntries = this.entries.slice(0, cut);
        priorUnits = toUnits(priorEntries);
        priorLeaf = priorEntries[priorEntries.length - 1]?.id ?? "";
        userLeaf = this.entries[this.entries.length - 1]!.id;
      }
    }
    let msg: GuidanceMessage | null = null;
    // a kindle for the previous message that never reached a commit point: this message decides anew
    this.lateKindle = null;
    if (!this.light && this.contextEnabled()) {
      // the prompt waits for all of this, with no Working row in pi until the first turn starts:
      // one budget for the decision, the scribe and the cards; what misses it applies later
      const deadline = Date.now() + this.promptBudgetMs();
      const scope = inTranscript > 0 ? { entries: priorEntries, units: priorUnits } : undefined;
      const input = { ...this.janusInput("full", text, scope), signal };
      let plan = await this.janusNow(input, deadline);
      let from: JanusInput = input;
      if (signal?.aborted) plan = null;
      else if (plan?.answered) this.lateJanus = null;
      else if (!plan && this.lateJanus) {
        // an answer that was still on its way at the last commit point applies here
        const late = this.lateJanus;
        this.lateJanus = null;
        plan = this.current(late);
        from = { ...late.input, entries: priorEntries, units: priorUnits, round: roundCount(priorUnits), state: this.state, signal };
      }
      if (plan) {
        msg = await this.applyPlan(
          plan,
          from,
          inTranscript > 0
            ? { extraPaths: mention, deadline, userMessage: true, closeAt: priorLeaf, kindleStart: { afterId: userLeaf, skipUser: false }, deferredGuidance: true }
            : { extraPaths: mention, deadline, userMessage: true },
        );
      } else if (mention) msg = this.guidance(mention, { key: randomId8() });
    } else if (mention) msg = this.guidance(mention, { key: randomId8() });
    if (msg) {
      if (mention && msg.content.includes(mention)) this.deliverShown(mentionShown, "path", { guidanceKey: String(msg.details?.key ?? "") });
      batch.messages.push(msg);
    }
    if (this.contextEnabled()) this.startPrecipJobs(false);
    const taken = this.take();
    batch.records.push(...taken.records);
    batch.edits.push(...taken.edits);
    return batch;
  }

  /**
   * `tool_call` / `PreToolUse`: run the pre-edit gate, and on the turn's first top-level call
   * start Janus in the background, while the tools run.
   */
  async onToolCall(call: ToolCallInfo): Promise<{ block: string } | null> {
    if (!this.janusStartedThisTurn && !call.nested && !call.subagent && !this.light && this.contextEnabled()) {
      this.janusStartedThisTurn = true;
      void this.startJanus();
    }
    if (!this.memory || !call.event || call.own) return null;
    this.enrich(call.event);
    const decision = this.memory.delivery.gate(call.event, this.gateContext());
    if (!decision) return null;
    for (const ref of decision.refs) {
      this.gatedThisTurn.add(ref.node.id);
      this.deliver({ id: `m:${ref.node.id}`, kind: "card", channel: "gate", nodeIds: [ref.node.id], scope: ref.scope, text: ref.node.text, signature: ref.node.signature, full: true }, { toolCallId: call.toolCallId, subagent: call.subagent });
    }
    this.telemetry?.event("gate.block", { memories: decision.refs.length });
    return { block: decision.reason };
  }

  private async startJanus(): Promise<void> {
    // one run in flight is enough: with slow (emulated) decisions, the next round asks again
    if (this.janusInFlight > 0) return;
    try {
      await this.refresh();
    } catch {
      return;
    }
    this.janusRun = this.runJanus(this.janusInput("full"));
  }

  private runJanus(input: JanusInput): JanusRun {
    const run: JanusRun = { promise: this.janus.decide(input), input, done: false, plan: null, seq: ++this.janusSeq, gen: this.janusGen, intents: this.state.intents.size };
    this.janusInFlight++;
    void run.promise.then(
      (plan) => {
        run.plan = plan;
        run.done = true;
        this.janusInFlight--;
      },
      () => {
        run.done = true;
        this.janusInFlight--;
      },
    );
    return run;
  }

  /** A run that missed its commit point: its answer applies at the next one, unless a newer one is waiting. */
  private deferJanus(run: JanusRun): void {
    this.state.stats.janusLate++;
    this.statsDirty = true;
    void run.promise.then(
      () => {
        if (run.gen !== this.janusGen || !run.plan?.answered) return;
        if (!this.lateJanus || this.lateJanus.seq < run.seq) this.lateJanus = run;
      },
      () => undefined,
    );
  }

  /**
   * Janus at a commit point that has no tool calls to hide behind (a user message, settle).
   * A decision model answers within its own timeout. Aux-emulated answers take seconds: the
   * prompt does not wait for them, and the answer applies at the next commit point.
   */
  private async janusNow(input: JanusInput, deadline?: number): Promise<JanusPlan | null> {
    // the request gets the signal too; the race only stops waiting for a client that ignores it
    if (!this.janus.slow()) return (await raceTimeout(this.janus.decide(input), Infinity, input.signal)) ?? null;
    if (this.janusInFlight > 0) return null;
    const run = this.runJanus(input);
    await raceTimeout(run.promise.catch(() => null), deadline === undefined ? this.cfg.janus.lateWaitMs : timeLeft(deadline), input.signal);
    if (run.done) return run.plan;
    if (input.signal?.aborted) return null;
    this.deferJanus(run);
    return null;
  }

  /** A plan made before another intent was kindled must not kindle again from what it saw. */
  private current(run: JanusRun): JanusPlan | null {
    const plan = run.plan;
    if (!plan?.answered) return null;
    return plan.kindle && this.state.intents.size !== run.intents ? { ...plan, kindle: null } : plan;
  }

  /**
   * `tool_result` / `PostToolUse`: record deliveries, track moves and writes, append the path
   * memories for what was touched, and archive an oversized output. Returns the patched text,
   * or null to leave the result alone.
   */
  async onToolResult(res: ToolResultInfo): Promise<{ text: string; block?: string; body?: string } | null> {
    const where = { toolCallId: res.toolCallId, subagent: res.subagent };
    // deliveries reported by search, recall and inspect (top-level calls only create transcript entries)
    if (res.deliveries && !res.nested) for (const d of res.deliveries) this.deliver(d, where);
    let text = res.text;
    let block: string | undefined;
    const mem = this.memory;
    if (mem && res.event && !res.own) {
      const ev = this.enrich(res.event);
      const list = this.actions.get(this.intentKey()) ?? [];
      list.push(ev);
      if (list.length > 200) list.shift();
      this.actions.set(this.intentKey(), list);
      if (!res.isError) {
        try {
          // moves and deletions confirmed by a successful command; fresh hashes for written files
          if (ev.action === "command" && ev.effects) mem.paths.applyEffects(ev.effects);
          if (ev.action === "edit") for (const p of ev.paths) mem.paths.noteWrite(p);
          if (ev.action === "command" && ev.effects) for (const abs of ev.effects.writes) {
            const rel = mem.paths.rel(abs);
            if (rel) mem.paths.noteWrite(rel);
          }
        } catch (e) {
          this.telemetry?.event("paths.track_failed", { error: errMsg(e) });
        }
      }
      // Nested calls skip [paths] injection, so programmatic callers are not corrupted.
      // Rules are collected for every directory from the root down to the path, so moving the
      // focus into a new subtree brings that subtree's rules with the first result from it.
      if (!res.nested) {
        const found = mem.delivery.block(ev, { visible: (id) => this.isVisible(id), turnTokensLeft: Math.max(0, this.cfg.paths.perTurnTokens - this.turnPathTokens) });
        if (found) {
          this.turnPathTokens += found.tokens;
          this.deliverShown(found.shown, "path", where);
          block = found.text;
        }
      }
    }
    // the oversize guard works on the tool's own output; the path block (≤ paths.perResultTokens) follows it
    let body: string | undefined;
    if (!res.nested && this.contextEnabled()) {
      const guarded = guardToolResult(text, this.scaled().maxToolResult, this.blobs, { tool: res.toolName, toolCallId: res.toolCallId, at: this.now() });
      if (guarded) {
        text = guarded.text;
        body = guarded.text;
        this.telemetry?.event("oversize.archived", { tokens: guarded.blob.tokens, tool: res.toolName });
      }
    }
    if (block) text = `${text}\n\n${block}`;
    // `block` and `body` let harnesses that deliver them through separate channels do so (Claude Code)
    return block || body !== undefined ? { text, block, body } : null;
  }

  /**
   * A commit or a test run concerns the files changed in the current piece of work, not only
   * the paths on its command line: those are added, so rules for them come up (§6.8.5).
   */
  private enrich(ev: PathEvent): PathEvent {
    if (ev.action !== "command" || !ev.command || (ev as PathEvent & { enriched?: boolean }).enriched) return ev;
    (ev as PathEvent & { enriched?: boolean }).enriched = true;
    const acts = commandActions(normalizeCommandParts(ev.command));
    if (!acts.has("commit") && !acts.has("test")) return ev;
    const edited = (this.actions.get(this.intentKey()) ?? []).filter((a) => a.action === "edit").flatMap((a) => a.paths);
    ev.paths = [...new Set([...ev.paths, ...edited])].slice(0, 12);
    return ev;
  }

  /** Commands the user runs (`user_bash`): only move and delete tracking. */
  onUserBash(event: PathEvent, ok: boolean): void {
    if (!this.memory || !ok || !event.effects) return;
    try {
      this.memory.paths.applyEffects(event.effects);
    } catch {
      // tracking is best effort
    }
  }

  /**
   * `turn_end` / `PostToolBatch`: the hot loop's commit point.
   * Applies the Janus answer started at the first tool call, commits finished consolidations,
   * starts new ones, and relieves pressure before the next request.
   */
  async onTurnEnd(signal?: AbortSignal): Promise<CommitBatch> {
    await this.refresh();
    this.requests++;
    this.lastRequestAt = this.clock().getTime();
    this.savedThisStep = 0;
    this.noteRound();
    const batch = emptyBatch();
    const ctxOn = this.contextEnabled();
    if (!this.light) {
      if (ctxOn) {
        // one deadline for everything this commit point waits on (§5.2.1): a late intent, the
        // Janus answer, and a kindle's scribe and cards; what misses it applies at the next one
        const deadline = Date.now() + this.cfg.janus.lateWaitMs;
        // an intent whose scribe missed its commit point opens first, so a plan below that was
        // made before it cannot kindle a second one (`current()`)
        const kindled = await this.takeLateKindle(deadline, signal);
        if (kindled) batch.messages.push(kindled);
        // an answer that came too late last step applies now
        const late = this.lateJanus;
        this.lateJanus = null;
        const run = this.janusRun;
        this.janusRun = null;
        this.janusStartedThisTurn = false;
        let plan: JanusPlan | null = null;
        let input: JanusInput | null = null;
        if (run) {
          if (!run.done) await raceTimeout(run.promise.catch(() => null), timeLeft(deadline));
          if (run.done) {
            plan = this.current(run);
            input = run.input;
          } else {
            // the answer applies at the next commit point; a late closure only delays consolidation
            this.deferJanus(run);
          }
        }
        if (!plan && late) {
          plan = this.current(late);
          input = late.input;
        }
        if (plan && input) {
          const fresh = { ...input, entries: this.entries, units: this.units, round: this.round, state: this.state, signal };
          const msg = await this.applyPlan(plan, fresh, { deadline });
          if (msg) batch.messages.push(msg);
        } else if (!this.lateKindle) {
          const r = this.reminder();
          if (r) batch.messages.push(r);
        }
        batch.messages.push(...this.takeLateCards());
      } else {
        this.janusRun = null;
        this.lateJanus = null;
        this.lateCards = [];
        this.lateKindle = null;
        this.janusStartedThisTurn = false;
      }
      await this.windowAttribution(signal);
    }
    if (ctxOn) {
      this.commitReady();
      if (!this.light) {
        this.startPrecipJobs(false);
        if (this.level > 0) {
          this.palim.climb();
          this.palim.startOrdinaryFolds();
          await this.palim.pressure(signal);
        } else this.palim.shadow();
      }
    }
    this.indexTurns();
    this.flushStats(false);
    const taken = this.take();
    batch.records.push(...taken.records);
    batch.edits.push(...taken.edits);
    this.memory?.accounting.turn();
    return batch;
  }

  /** `agent_before_settle` / `Stop`: closure-only Janus, and whatever is already ready. */
  async onBeforeSettle(signal?: AbortSignal): Promise<CommitBatch> {
    await this.refresh();
    const batch = emptyBatch();
    if (!this.contextEnabled()) return batch;
    if (!this.light) {
      // an intent whose scribe missed the last turn_end opens here, before the next message drops it
      const kindled = await this.takeLateKindle(Date.now() + this.cfg.janus.lateWaitMs, signal);
      if (kindled) batch.messages.push(kindled);
    }
    if (!this.light && this.cfg.context.settleConsolidation && this.state.stack.length) {
      const input = { ...this.janusInput("closure"), signal };
      const plan = await this.janusNow(input);
      // Precip for these runs during idle time, so the user's prompt never waits on an aux call
      const msg = plan ? await this.applyPlan(plan, input, { deferPrecip: true }) : null;
      if (msg) batch.messages.push(msg);
    }
    if (!this.light) batch.messages.push(...this.takeLateCards());
    this.commitReady();
    this.flushStats(false);
    const taken = this.take();
    batch.records.push(...taken.records);
    batch.edits.push(...taken.edits);
    return batch;
  }

  /**
   * Idle time (`agent_settled`): run Precip for intents closed at settle, the idle harvest, and
   * prepare folds that only pay off on a cold cache. Aborted through `signal` when the user acts.
   */
  async onIdle(signal?: AbortSignal): Promise<void> {
    if (this.light) return;
    await this.refresh();
    const ctxOn = this.contextEnabled();
    if (ctxOn) {
      this.startPrecipJobs(true, signal);
      await Promise.allSettled(this.precipJobs.map((j) => j.promise).filter(Boolean));
    }
    if (signal?.aborted) return;
    await this.idleHarvest(signal);
    if (signal?.aborted || this.level === 0 || !ctxOn) return;
    this.palim.prepareColdFolds(signal);
  }

  /**
   * The `context` hook (§4.2): normally nothing. Returns edits to apply to this one request when
   * (1) it would go out above capacity and folds are ready, or (2) the provider cache is cold
   * and a cost-deferred fold is ready. They are persisted at the next commit point.
   */
  async onContext(): Promise<ContextEdit[] | null> {
    if (this.light || this.level === 0 || !this.contextEnabled()) return null;
    const now = this.clock().getTime();
    const lastWrite = Math.max(this.lastRequestAt, this.adapter.lastCacheWriteAt?.() ?? 0);
    const cold = lastWrite > 0 && now - lastWrite >= effectiveCacheTtlSeconds(this.cfg, this.adapter.modelName()) * 1000;
    this.lastRequestAt = now;
    const ready = [...this.palim.jobs.values()].filter((j) => j.done && j.plan);
    if (!ready.length) return null;
    const tokens = await this.adapter.requestTokens();
    const over = tokens !== null && tokens > this.window();
    const pick = ready.filter((j) => (cold && j.kind === "cold") || (over && j.kind !== "cold"));
    if (!pick.length) return null;
    await this.refresh();
    const edits: ContextEdit[] = [];
    for (const job of pick.sort((a, b) => a.level - b.level)) {
      const plan = job.plan!;
      this.palim.jobs.delete(job.key);
      if (this.invariants(plan, false)) continue;
      edits.push(...plan.edits);
      this.appliedNow.push(plan);
      this.applyLocal(plan);
    }
    return edits.length ? edits : null;
  }

  /**
   * `session_before_compact`: hand the harness a realctx2 compaction instead of cancelling
   * (cancelling an overflow compaction would suppress the harness's retry, §5.4.5).
   */
  async onBeforeCompact(opts: { instructions?: string; tokensBefore?: number; signal?: AbortSignal }): Promise<{ summary: string; firstKeptEntryId: string; tokensBefore: number; record: ConsolidationRecord } | null> {
    if (!this.contextEnabled()) return null;
    await this.refresh();
    const tail = workingTail(this.entries, this.units, this.cfg, this.window(), this.state.stats.roundTokens, { modelName: this.adapter.modelName() });
    const span = alignToUnits(this.units, 0, tail.start);
    if (!span) return null;
    const [from, to] = span;
    const first = this.entries[to];
    if (!first) return null;
    const carry = this.palim.carried(from, to);
    const out = await this.consolidator.ripple({ text: renderForAux(this.entries, from, to, Math.floor(this.window() * 0.5)), carry, telos: this.state.stack.map((i) => i.label), instructions: opts.instructions, pressure: true }, opts.signal);
    if (!out) return null;
    const id = this.consolidator.newId(this.state);
    const text = renderPalim(id, out.narrative, out.knowledge, "compaction");
    const plan = planReplace(this.entries, this.state, from, to, { id, kind: "compaction", text, telos: this.state.stack.map((i) => i.label), model: this.adapter.modelName(), now: this.now(), knowledge: out.knowledge, shadow: true });
    if (!plan) return null;
    const record: ConsolidationRecord = { ...plan.record, shadow: undefined };
    // open intents whose guidance sits in the compacted part stay visible through the summary
    const cut = this.state.stack.filter((i) => {
      const at = i.guidanceEntryId ? this.index.get(i.guidanceEntryId) : undefined;
      return at === undefined || at < to;
    });
    const purposes = cut.length ? `\n[intent] My open purposes, outermost first:\n${cut.map((i, d) => `${"  ".repeat(d)}- "${i.label}". Done when: ${i.success} Give up when: ${i.failure}`).join("\n")}` : "";
    return { summary: text + purposes, firstKeptEntryId: first.id, tokensBefore: opts.tokensBefore ?? plan.record.tokensBefore, record };
  }

  /**
   * The harness saved the compaction (pi `session_compact`): the record becomes part of the
   * session, anchored at the compaction entry so later folds nest it, and its knowledge is harvested.
   */
  onCompacted(record: ConsolidationRecord, compactionEntryId?: string): CommitBatch {
    const final: ConsolidationRecord = compactionEntryId ? { ...record, anchorId: compactionEntryId } : record;
    this.emit({ type: "realctx2.consolidation", record: final });
    this.harvester.harvest(final);
    // plans made against the old projection are void
    this.palim.jobs.clear();
    this.appliedNow = [];
    return this.take();
  }

  /** Append-only harnesses: the consolidated state to inject after the harness compacted (§4.6.3). */
  reinjection(): string {
    if (!this.contextEnabled()) return "";
    return renderReinjection(this.state, this.cfg.context.reinjectTokens);
  }

  /** Session end: attribute what is still open with deterministic signals, and hand back the last records. */
  async onShutdown(opts: { reload?: boolean } = {}): Promise<CommitBatch> {
    try {
      await this.refresh();
    } catch {
      // the harness may already be tearing down
    }
    // a session that ended before its last round completed is still searchable (§5.6)
    this.indexTurns();
    if (!this.light && !opts.reload) {
      const open = this.state.deliveries.filter((d) => !this.state.attributed.has(d.deliveryId) && !d.subagent);
      if (open.length) {
        const res = await this.attributor.attribute({ deliveries: open, entries: this.entries, from: 0, to: this.entries.length, intent: null, state: this.state, actions: [], deterministicOnly: true });
        for (const r of res.records) this.emit(r);
      }
    }
    this.commitReady();
    this.flushStats(true);
    await this.settleBackground();
    return this.take();
  }

  get requestCount(): number {
    return this.requests;
  }

  /** Idle harvest (§5.4.4) over Precip memories no fold has covered yet; returns the items found. */
  idleHarvest(signal?: AbortSignal, budgetTokens?: number): Promise<number> {
    return this.harvester.idleHarvest(signal, budgetTokens);
  }

  // ───────────── round statistics 𝓡
  private noteRound(): void {
    const rounds = this.units.filter((u) => u.round && u.complete);
    const n = rounds.length;
    const seen = this.state.stats.round ?? 0;
    if (n <= seen) return;
    for (const u of rounds.slice(seen)) this.state.stats.roundTokens.push(u.tokens);
    if (this.state.stats.roundTokens.length > 64) this.state.stats.roundTokens.splice(0, this.state.stats.roundTokens.length - 64);
    this.state.stats.round = n;
    this.statsDirty = true;
  }

  private flushStats(force: boolean): void {
    if (!this.statsDirty) return;
    // a stats record every few rounds is enough to resume the climb after a restart
    if (!force && (this.state.stats.round ?? 0) % 4 !== 0) return;
    this.statsDirty = false;
    this.pending.records.push({ ...this.state.stats, roundTokens: [...this.state.stats.roundTokens] });
  }

  // ───────────── attribution windows (§5.5.2)
  private async windowAttribution(signal?: AbortSignal): Promise<void> {
    // root region: the next `rootWindowRounds` rounds after the delivery
    const due = this.state.deliveries.filter((d) => d.intentId === null && !d.subagent && !this.state.attributed.has(d.deliveryId) && d.entryId && this.round - (d.round ?? 0) >= this.cfg.attribution.rootWindowRounds);
    if (!due.length) return;
    const first = Math.min(...due.map((d) => this.index.get(d.entryId) ?? this.entries.length));
    const res = await this.attributor.attribute({ deliveries: due, entries: this.entries, from: Math.max(0, first), to: this.entries.length, intent: null, state: this.state, actions: this.actions.get(ROOT) ?? [], signal });
    for (const r of res.records) this.emit(r);
    for (const rec of res.updatedRecords) this.emit({ type: "realctx2.consolidation", record: rec });
    // deliveries that produced no record (nothing to attribute) must not be asked about again
    for (const d of due) if (!this.state.attributed.has(d.deliveryId)) this.emit({ type: "realctx2.attribution", deliveryId: d.deliveryId, use: { deterministic: 1 }, u: 0 });
  }

  // ───────────── Precip (§5.3)
  private queuePrecip(closed: Array<{ intent: Intent; outcome: IntentOutcome }>, deferred: boolean): void {
    // Closures arrive innermost first and are processed in that order. An enclosing intent that
    // closed in the same step and holds nothing but its own guidance and the child's span
    // consolidates together with the child (Hippocam's merging of intent-only closures).
    let prev: PrecipJob | null = null;
    let carried: Intent[] = [];
    for (let i = 0; i < closed.length; i++) {
      const c = closed[i]!;
      const outer = closed[i + 1]?.intent;
      if (outer && c.intent.parentId === outer.id) {
        const a = this.index.get(outer.guidanceEntryId);
        const b = this.index.get(c.intent.guidanceEntryId);
        const own = a !== undefined && b !== undefined ? this.entries.slice(a + 1, b).filter((e) => !e.omitted) : [null];
        if (!own.length) {
          // attribution for the inner intent still runs on its own; its span goes to the parent's Precip
          this.precipJobs.push({ intent: c.intent, outcome: c.outcome, merged: [], promise: null, plan: null, done: false, deferred, after: prev, committed: false, attributionOnly: true });
          carried = [...carried, c.intent];
          continue;
        }
      }
      const job: PrecipJob = { intent: c.intent, outcome: c.outcome, merged: carried, promise: null, plan: null, done: false, deferred, after: prev, committed: false };
      carried = [];
      this.precipJobs.push(job);
      prev = job;
    }
  }

  private regionOfClosed(intent: Intent): { from: number; to: number } | null {
    const from = this.index.get(intent.guidanceEntryId);
    if (from === undefined) return null;
    let to = intent.closedEntryId ? (this.index.get(intent.closedEntryId) ?? -1) + 1 : this.entries.length;
    if (to <= from) to = this.entries.length;
    return { from, to };
  }

  private startPrecipJobs(idle: boolean, signal?: AbortSignal): void {
    for (const job of this.precipJobs) {
      if (job.promise || job.done) continue;
      if (job.deferred && !idle) continue;
      // an enclosing closure waits until the inner one has been committed, so it sees the consolidated text
      if (job.after && !job.after.committed) continue;
      job.promise = this.track(this.runPrecip(job, signal)).then(
        (plan) => {
          if (!plan && signal?.aborted) {
            // aborted during idle: leave queued so the next idle or turn can retry it
            job.promise = null;
            job.done = false;
            return null;
          }
          job.plan = plan;
          job.done = true;
          return plan;
        },
        (e) => {
          if (signal?.aborted) {
            job.promise = null;
            job.done = false;
            return null;
          }
          job.done = true;
          this.telemetry?.event("precip.failed", { error: errMsg(e) });
          return null;
        },
      );
    }
  }

  private async runPrecip(job: PrecipJob, signal?: AbortSignal): Promise<ReplacePlan | null> {
    const { intent, outcome } = job;
    const region = this.regionOfClosed(intent);
    if (!region) return null;
    // everything below works on the transcript as it is now; the plan is re-checked when it commits
    const entries = this.entries;
    const units = this.units;
    const state = this.state;
    const deliveries = state.deliveries.filter((d) => d.intentId === intent.id || job.merged.some((m) => m.id === d.intentId));
    // attribution runs in the same pass, on the region before replacement
    try {
      const res = await this.attributor.attribute({ deliveries: deliveries.filter((d) => d.intentId === intent.id), entries, from: region.from, to: region.to, intent, outcome, state, actions: this.actions.get(intent.id) ?? [], signal });
      if (signal?.aborted) return null;
      for (const r of res.records) this.emit(r);
      for (const rec of res.updatedRecords) this.emit({ type: "realctx2.consolidation", record: rec });
      this.actions.delete(intent.id);
    } catch (e) {
      if (signal?.aborted) return null;
      this.telemetry?.event("attribution.failed", { error: errMsg(e) });
    }
    if (job.attributionOnly) return null;
    // the latest round is excluded (invariant 3); it folds into the parent region later
    const latest = latestRoundStart(units, entries.length);
    const span = alignToUnits(units, region.from, Math.min(region.to, latest));
    if (!span) return null;
    const [from, to] = span;
    const tokens = sumTokens(entries, from, to);
    // skip rule: a small span would not pay for the cache break; the parent's consolidation absorbs it later
    if (tokens < this.cfg.context.precipSkipTokens && this.level > 0) {
      this.telemetry?.event("precip.skipped", { tokens });
      return null;
    }
    const telos = state.telos(intent);
    const out = await this.consolidator.precip({ entries, from, to, intent, outcome, telos, deliveries, merged: job.merged }, signal);
    if (!out) return null;
    const id = this.consolidator.newId(state);
    const text = renderPrecip(id, intent, outcome, out.memory);
    // anchored at the intent's guidance, which a late intent has after its first entry
    const guidance = entries.find((e) => e.kind === "custom_message" && e.customType === GUIDANCE_TYPE && (e.details as { intentId?: string } | undefined)?.intentId === intent.id);
    return planReplace(entries, state, from, to, { id, kind: "precip", text, preferAnchorId: guidance?.id ?? intent.guidanceEntryId, intent, outcome, telos, model: this.adapter.modelName(), now: this.now(), sidecar: out.sidecar, shadow: this.level === 0 });
  }

  // ───────────── committing plans
  private invariants(plan: ReplacePlan, allowTail: boolean, minimalTail = false): string | null {
    if (plan.record.shadow) return null;
    const tail = workingTail(this.entries, this.units, this.cfg, this.window(), this.state.stats.roundTokens, { minimal: minimalTail, modelName: this.adapter.modelName() });
    return checkInvariants(plan, { entries: this.entries, units: this.units, tailStart: tail.start, latestRoundStart: latestRoundStart(this.units, this.entries.length), allowTail });
  }

  /** Reflect a committed plan in the local projection, so later planning in the same step sees it. */
  private applyLocal(plan: ReplacePlan): void {
    this.state.apply({ type: "realctx2.consolidation", record: plan.record });
    if (plan.record.shadow) return;
    const edits = new Map(plan.edits.map((e) => [e.targetId, e.replacement]));
    this.setEntries(
      this.entries.map((e) => {
        if (!edits.has(e.id)) return e;
        const r = edits.get(e.id);
        if (r === null) return { ...e, omitted: true, tokens: 0, text: "" };
        return { ...e, omitted: false, edited: true, text: r as string, tokens: estimateTokens(r as string), toolCalls: undefined };
      }),
    );
  }

  private commitPlan(plan: ReplacePlan, opts: { allowTail: boolean; minimalTail?: boolean; applied?: boolean }): boolean {
    if (!opts.applied) {
      const problem = this.invariants(plan, opts.allowTail, opts.minimalTail);
      if (problem) {
        // consolidation is always optional: drop the batch and log it
        this.telemetry?.event("consolidation.dropped", { kind: plan.record.kind, problem });
        this.problems.push(`${plan.record.id}: ${problem}`);
        if (this.problems.length > 50) this.problems.shift();
        return false;
      }
      this.applyLocal(plan);
    }
    if (!plan.record.shadow) this.savedThisStep += Math.max(0, plan.record.tokensBefore - plan.record.tokensAfter);
    this.pending.records.push({ type: "realctx2.consolidation", record: plan.record });
    this.pending.edits.push(...plan.edits);
    this.memory?.turns?.addConsolidation({ id: plan.record.id, session: this.sessionId, harness: this.adapter.harness, kind: plan.record.kind, at: plan.record.createdAt, text: plan.text });
    this.telemetry?.step({ kind: plan.record.kind, id: plan.record.id, before: plan.record.tokensBefore, after: plan.record.tokensAfter });
    if (plan.record.kind === "precip") this.harvester.handOffEpisode(plan.record);
    else this.harvester.harvest(plan.record);
    return true;
  }

  /** Commit every finished consolidation together, so the prompt cache breaks at most once per step. */
  private commitReady(): void {
    for (const plan of this.appliedNow.splice(0)) this.commitPlan(plan, { allowTail: false, applied: true });
    const doneJobs = this.precipJobs.filter((j) => j.done);
    this.precipJobs = this.precipJobs.filter((j) => !j.done);
    for (const job of doneJobs) {
      if (job.plan) this.commitPlan(job.plan, { allowTail: true });
      job.committed = true;
    }
    const folds = this.palim.jobs;
    for (const job of [...folds.values()]) {
      if (!job.done || job.kind !== "ordinary") continue;
      folds.delete(job.key);
      if (job.plan) this.commitPlan(job.plan, { allowTail: false });
    }
    // prepared folds whose span changed, or whose intent closed, are dropped
    for (const job of [...folds.values()]) {
      if (!job.done || !job.plan) continue;
      const from = this.index.get(job.plan.spanIds[0]!);
      if (from === undefined || spanFingerprint(this.entries, from, from + job.plan.spanIds.length) !== job.plan.fingerprint) folds.delete(job.key);
    }
  }

  // ───────────── the turn index (§5.6)
  private indexTurns(): void {
    const turns = this.memory?.turns;
    if (!turns || this.light) return;
    try {
      this.indexedEntries ??= turns.indexedEntries(this.sessionId);
      const seen = this.indexedEntries;
      turns.db.transaction(() => {
        this.entries.forEach((e, seq) => {
          if (seen.has(e.id) || e.id.startsWith("pending:")) return;
          if (e.kind === "custom_message" && e.customType === GUIDANCE_TYPE) return;
          const calls = (e.rawToolCalls ?? e.toolCalls ?? []).map((c) => `→ ${c.name}(${JSON.stringify(c.args).slice(0, 600)})`).join("\n");
          const text = [e.rawText, calls].filter(Boolean).join("\n");
          if (!text.trim()) return;
          turns.addRaw({ session: this.sessionId, harness: this.adapter.harness, entryId: e.id, at: e.timestamp, text, role: e.role, tool: e.toolName, seq });
          seen.add(e.id);
        });
      });
    } catch (e) {
      this.telemetry?.event("turnindex.failed", { error: errMsg(e) });
    }
  }

  /** `r:` ID of an entry of this session. */
  rawId(entryId: string): string {
    return rawTurnId(this.sessionId, entryId);
  }

  /** The memory behind a card, for tools that render deliveries. */
  node(id: string): ScopedNode | null {
    return this.memory?.graph.get(id) ?? null;
  }

  status(): { round: number; requests: number; stack: Intent[]; records: number; deliveries: number; attributed: number; frontier: number; janusLate: number; foldsSkippedByCost: number; occupancy: number; window: number; disabled: boolean; cacheTtlSeconds: number; jobs: { precip: number; folds: number }; problems: string[] } {
    const window = this.window();
    return {
      round: this.round,
      requests: this.requests,
      stack: this.state.stack,
      records: this.state.records.size,
      deliveries: this.state.deliveries.length,
      attributed: this.state.attributed.size,
      frontier: this.state.stats.frontier ?? 0,
      janusLate: this.state.stats.janusLate,
      foldsSkippedByCost: this.state.stats.foldsSkippedByCost,
      occupancy: Math.round(this.palim.lastOccupancy),
      window,
      disabled: !this.contextEnabled(),
      cacheTtlSeconds: effectiveCacheTtlSeconds(this.cfg, this.adapter.modelName()),
      jobs: { precip: this.precipJobs.length, folds: this.palim.jobs.size },
      problems: this.problems.slice(-10),
    };
  }
}
