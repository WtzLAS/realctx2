/**
 * The context engine (§5): Janus keeps the intent stack, Precip consolidates closed intents,
 * Palim folds stable prefixes and relieves pressure, and attribution records what was used.
 * It talks to the harness only through `HarnessAdapter`, so the same engine drives pi (L2,
 * persisted edits) and append-only harnesses (L0, shadow consolidation).
 */
import type { Config } from "../core/config.ts";
import { scaledContext } from "../core/config.ts";
import type { Telemetry } from "../core/telemetry.ts";
import type { Clock, CommitBatch, ConsolidationRecord, ContextEdit, DecisionClient, Delivery, DeliveryChannel, EntryView, GuidanceMessage, HarnessAdapter, Intent, IntentOutcome, KnowledgeItem, ScopedNode, ScopeName, SessionRecord } from "../core/types.ts";
import { emptyBatch } from "../core/types.ts";
import { renderCards } from "../memory/cards.ts";
import { commandActions, type PathEvent, type Shown } from "../memory/delivery.ts";
import type { Retriever } from "../memory/retrieve.ts";
import type { MemoryRuntime } from "../memory/runtime.ts";
import type { Candidate } from "../memory/write.ts";
import { rawTurnId } from "../storage/turnindex.ts";
import { randomId8 } from "../util/ids.ts";
import { normalizeCommandParts } from "../util/shell.ts";
import { estimateTokens, extractPathTokens, ngramOverlap, quantile, sha256 } from "../util/text.ts";
import { type BlobStore, guardToolResult } from "./archive.ts";
import { Attributor } from "./attribution.ts";
import { checkInvariants, Consolidator, knowledgeKey, planReplace, renderForAux, type ReplacePlan, spanFingerprint } from "./consolidate.ts";
import { Janus, type JanusInput, type JanusPlan } from "./janus.ts";
import { GUIDANCE_TYPE, renderGuidance, renderLateCards, renderPalim, renderPrecip, renderReinjection, renderReminder } from "./render.ts";
import { alignToUnits, latestRoundStart, roundCount, roundsBefore, sumTokens, toUnits, type Unit, workingTail } from "./rounds.ts";
import { type Region, SessionState } from "./state.ts";

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

interface FoldJob {
  key: string;
  level: number;
  kind: "ordinary" | "prepared" | "cold";
  promise: Promise<ReplacePlan | null>;
  plan: ReplacePlan | null;
  done: boolean;
  startedRound: number;
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

interface FoldSpan {
  level: number;
  from: number;
  to: number;
  tokens: number;
  consolidated: number;
  intent: Intent | null;
}

const ROOT = "root";

export class ContextEngine {
  readonly adapter: HarnessAdapter;
  readonly cfg: Config;
  readonly sessionId: string;
  readonly memory: MemoryRuntime | null;
  readonly blobs: BlobStore;
  readonly janus: Janus;
  readonly consolidator: Consolidator;
  readonly attributor: Attributor;
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
  /** Proactive cards whose (emulated) gate was still running when their intent was kindled. */
  private lateCards: { intentId: string; gen: number; done: boolean; result: Awaited<ReturnType<Retriever["proactive"]>> | null } | null = null;
  private janusStartedThisTurn = false;
  private closeProb: Record<string, number> = {};
  private precipJobs: PrecipJob[] = [];
  private foldJobs = new Map<string, FoldJob>();
  /** Plans applied to a live request through the `context` hook, to be persisted at the next commit point. */
  private appliedNow: ReplacePlan[] = [];
  private actions = new Map<string, PathEvent[]>();
  private turnPathTokens = 0;
  private gatedThisTurn = new Set<string>();
  private shownThisTurn = new Set<string>();
  private lastRequestAt = 0;
  private requests = 0;
  private harvested = new Set<string>();
  private lastEpisode: { scope: ScopeName; id: string } | null = null;
  private episodes = new Map<string, { scope: ScopeName; id: string }>();
  private background = new Set<Promise<unknown>>();
  private lastReminderRound = new Map<string, number>();
  private statsDirty = false;
  private indexedEntries: Set<string> | null = null;
  private projectRuleIds = new Set<string>();
  private exhaustedNotifiedAt = -1;
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
  }

  // ───────────── basics
  get level(): 0 | 1 | 2 {
    return this.adapter.capabilities.level;
  }

  window(): number {
    return scaledContext(this.cfg, this.adapter.maxContextTokens()).W;
  }

  private scaled() {
    return scaledContext(this.cfg, this.adapter.maxContextTokens());
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
    this.resolveIds();
    this.harvested = new Set();
    for (const r of this.state.records.values()) for (const k of r.knowledge ?? []) this.harvested.add(knowledgeKey(k));
    // jobs planned against another branch are void
    this.precipJobs = [];
    this.foldJobs.clear();
    this.appliedNow = [];
    this.janusRun = null;
    this.lateJanus = null;
    this.lateCards = null;
    this.janusGen++;
    this.pending = emptyBatch();
    this.unresolvedDeliveries = [];
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
      if (intent.guidanceEntryId && this.index.has(intent.guidanceEntryId)) continue;
      const e = this.entries.find((x) => x.kind === "custom_message" && x.customType === GUIDANCE_TYPE && (x.details as { intentId?: string } | undefined)?.intentId === intent.id);
      if (e && intent.guidanceEntryId !== e.id) {
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
  private janusInput(mode: "full" | "closure", userMessage?: string): JanusInput {
    return { state: this.state, entries: this.entries, units: this.units, userMessage, mode, round: this.round, cacheKey: `${this.sessionId}.janus` };
  }

  /** Turn a Janus plan into records and at most one guidance message. */
  private async applyPlan(plan: JanusPlan, input: JanusInput, opts: { deferPrecip?: boolean; extraPaths?: string } = {}): Promise<GuidanceMessage | null> {
    Object.assign(this.closeProb, plan.closeProb);
    const leaf = this.entries[this.entries.length - 1]?.id ?? "";
    const closedNow: Array<{ intent: Intent; outcome: IntentOutcome }> = [];
    // closures, innermost first; only intents that are still open on this branch
    for (const c of plan.closures) {
      const cur = this.state.intents.get(c.intent.id);
      if (!cur || cur.status !== "open") continue;
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

    let kindled: Intent | null = null;
    let cards = "";
    let shown: Shown[] = [];
    let pathText = opts.extraPaths ?? "";
    let pathShown: Shown[] = [];
    const key = randomId8();
    if (plan.kindle && input.mode === "full") {
      const scribed = await this.janus.scribe(input, plan.kindle, this.state.stack);
      if (scribed) {
        const parent = plan.kindle.parentId ? this.state.intents.get(plan.kindle.parentId) : undefined;
        const parentId = parent?.status === "open" ? parent.id : plan.kindle.parentId && this.state.stack.length ? this.state.innermost()!.id : null;
        kindled = this.janus.newIntent(scribed, parentId, this.round);
        if (parentId === null) {
          // a new root: ordinary folds start again from the root prefix
          this.state.stats.frontier = 0;
          this.statsDirty = true;
        }
        if (this.memory) {
          this.memory.recordPurpose(kindled.id, `${kindled.label}\n${kindled.reason}`);
          try {
            const parentLabel = parentId ? this.state.intents.get(parentId)?.label : undefined;
            const pro = await this.proactiveCards(kindled, parentLabel, input.signal);
            cards = pro?.text ?? "";
            shown = pro?.cards ?? [];
            // path memories for paths named in the intent and touched in the last 2 rounds
            const mentioned = this.memory.paths.resolveMentions(extractPathTokens(`${kindled.label} ${kindled.reason} ${kindled.success}`));
            const recent = this.recentPaths(2);
            const paths = [...new Set([...mentioned, ...recent])].slice(0, 4);
            if (paths.length && !pathText) {
              const block = this.memory.delivery.block({ action: "read", paths }, { visible: (id) => this.isVisible(id) || shown.some((s) => s.ref.node.id === id), turnTokensLeft: Math.max(0, this.cfg.paths.perTurnTokens - this.turnPathTokens) });
              if (block) {
                pathText = block.text;
                pathShown = block.shown;
                this.turnPathTokens += block.tokens;
              }
            }
          } catch (e) {
            this.telemetry?.event("proactive.failed", { error: String((e as Error).message) });
          }
        }
        this.emit({ type: "realctx2.intent", intent: { ...kindled } });
      }
    }
    if (!closedNow.length && !kindled) {
      if (pathText) return this.guidance(pathText, { key });
      return this.reminder();
    }
    const backTo = !kindled && closedNow.length ? this.state.innermost() : null;
    const parentLabel = kindled?.parentId ? this.state.intents.get(kindled.parentId)?.label : undefined;
    const text = renderGuidance({ closed: closedNow, kindled, parentLabel, backTo, cards, paths: pathText });
    const msg = this.guidance(text, { key, ...(kindled ? { intentId: kindled.id } : {}) });
    // proactive cards and path memories are deliveries, recorded against the kindled intent
    if (shown.length) this.deliverShown(shown, "proactive", { guidanceKey: key });
    if (pathShown.length) this.deliverShown(pathShown, "path", { guidanceKey: key });
    this.telemetry?.step({ kind: "janus", closures: closedNow.length, kindled: !!kindled, focus: plan.focus, cards: shown.length });
    return msg;
  }

  /**
   * Proactive retrieval for a kindled intent (§6.4.1). With a decision model the gate answers
   * within its own timeout. An aux-emulated gate takes seconds: the kindle does not wait for it,
   * and the cards follow at the next commit point.
   */
  private async proactiveCards(intent: Intent, parentLabel: string | undefined, signal?: AbortSignal): Promise<Awaited<ReturnType<Retriever["proactive"]>> | null> {
    const run = this.memory!.retriever.proactive({ label: intent.label, reason: intent.reason, parentLabel }, { signal });
    if (!this.janus.slow()) return run;
    const late: NonNullable<ContextEngine["lateCards"]> = { intentId: intent.id, gen: this.janusGen, done: false, result: null };
    const settled = run.then(
      (r) => {
        late.result = r;
        late.done = true;
        return r;
      },
      (e) => {
        late.done = true;
        this.telemetry?.event("proactive.failed", { error: String((e as Error).message) });
        return null;
      },
    );
    await Promise.race([settled, new Promise((r) => setTimeout(r, this.cfg.janus.lateWaitMs))]);
    if (late.done) return late.result;
    this.lateCards = late;
    return null;
  }

  /** Cards that arrived after their intent's guidance: one more guidance message, if the intent is still open. */
  private takeLateCards(): GuidanceMessage | null {
    const late = this.lateCards;
    if (!late?.done) return null;
    this.lateCards = null;
    const intent = this.state.intents.get(late.intentId);
    if (late.gen !== this.janusGen || !intent || intent.status !== "open" || !this.memory) return null;
    // what became visible in the meantime (path memories, search) is not repeated
    const fresh = (late.result?.cards ?? []).filter((c) => !this.isVisible(c.ref.node.id));
    if (!fresh.length) return null;
    const captionIds = new Set(fresh.filter((c) => !c.full).map((c) => c.ref.node.id));
    const rendered = renderCards(fresh.map((c) => c.ref), this.memory.graph, this.memory.paths, { budgetTokens: this.cfg.memory.proactive.maxTokens, captionIds });
    if (!rendered.shown.length) return null;
    const key = randomId8();
    this.deliverShown(rendered.shown, "proactive", { guidanceKey: key });
    return this.guidance(renderLateCards(intent, rendered.text), { key, cardsFor: intent.id });
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
   * A new user message (`before_agent_start`, `UserPromptSubmit`): full Janus, synchronously,
   * with the message included. Returns records to append and at most one guidance message.
   */
  async onUserMessage(text: string, signal?: AbortSignal): Promise<CommitBatch> {
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
    let msg: GuidanceMessage | null = null;
    if (!this.light) {
      const input = { ...this.janusInput("full", text), signal };
      let plan = await this.janusNow(input);
      let from: JanusInput = input;
      if (!plan && this.lateJanus) {
        // an answer that was still on its way at the last commit point applies here
        const late = this.lateJanus;
        this.lateJanus = null;
        plan = this.current(late);
        from = { ...late.input, entries: this.entries, units: this.units, round: this.round, state: this.state, signal };
      }
      if (plan) msg = await this.applyPlan(plan, from, { extraPaths: mention });
      else if (mention) msg = this.guidance(mention, { key: randomId8() });
    } else if (mention) msg = this.guidance(mention, { key: randomId8() });
    if (msg) {
      if (mention && msg.content.includes(mention)) this.deliverShown(mentionShown, "path", { guidanceKey: String(msg.details?.key ?? "") });
      batch.messages.push(msg);
    }
    this.startPrecipJobs(false);
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
    if (!this.janusStartedThisTurn && !call.nested && !call.subagent && !this.light) {
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
  private async janusNow(input: JanusInput): Promise<JanusPlan | null> {
    if (!this.janus.slow()) return this.janus.decide(input);
    if (this.janusInFlight > 0) return null;
    const run = this.runJanus(input);
    await Promise.race([run.promise.catch(() => null), new Promise((r) => setTimeout(r, this.cfg.janus.lateWaitMs))]);
    if (run.done) return run.plan;
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
          this.telemetry?.event("paths.track_failed", { error: String((e as Error).message) });
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
    if (!res.nested) {
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
    if (!this.light) {
      // an answer that came too late last step applies now
      const late = this.lateJanus;
      this.lateJanus = null;
      const run = this.janusRun;
      this.janusRun = null;
      this.janusStartedThisTurn = false;
      let plan: JanusPlan | null = null;
      let input: JanusInput | null = null;
      if (run) {
        if (!run.done) await Promise.race([run.promise.catch(() => null), new Promise((r) => setTimeout(r, this.cfg.janus.lateWaitMs))]);
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
        const msg = await this.applyPlan(plan, fresh);
        if (msg) batch.messages.push(msg);
      } else {
        const r = this.reminder();
        if (r) batch.messages.push(r);
      }
      const cards = this.takeLateCards();
      if (cards) batch.messages.push(cards);
      await this.windowAttribution(signal);
    }
    this.commitReady();
    if (!this.light) {
      this.startPrecipJobs(false);
      if (this.level > 0) {
        this.climb();
        this.startOrdinaryFolds();
        await this.pressure(signal);
      } else this.shadowPalim();
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
    if (!this.light && this.cfg.context.settleConsolidation && this.state.stack.length) {
      const input = { ...this.janusInput("closure"), signal };
      const plan = await this.janusNow(input);
      // Precip for these runs during idle time, so the user's prompt never waits on an aux call
      const msg = plan ? await this.applyPlan(plan, input, { deferPrecip: true }) : null;
      if (msg) batch.messages.push(msg);
    }
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
    this.startPrecipJobs(true, signal);
    await Promise.allSettled(this.precipJobs.map((j) => j.promise).filter(Boolean));
    if (signal?.aborted) return;
    await this.idleHarvest(signal);
    if (signal?.aborted || this.level === 0) return;
    this.prepareColdFolds(signal);
  }

  /**
   * The `context` hook (§4.2): normally nothing. Returns edits to apply to this one request when
   * (1) it would go out above capacity and folds are ready, or (2) the provider cache is cold
   * and a cost-deferred fold is ready. They are persisted at the next commit point.
   */
  async onContext(): Promise<ContextEdit[] | null> {
    if (this.light || this.level === 0) return null;
    const now = this.clock().getTime();
    const cold = this.lastRequestAt > 0 && now - this.lastRequestAt >= this.cfg.context.cacheTtlSeconds * 1000;
    this.lastRequestAt = now;
    const ready = [...this.foldJobs.values()].filter((j) => j.done && j.plan);
    if (!ready.length) return null;
    const tokens = await this.adapter.requestTokens();
    const over = tokens !== null && tokens > this.window();
    const pick = ready.filter((j) => (cold && j.kind === "cold") || (over && j.kind !== "cold"));
    if (!pick.length) return null;
    await this.refresh();
    const edits: ContextEdit[] = [];
    for (const job of pick.sort((a, b) => a.level - b.level)) {
      const plan = job.plan!;
      this.foldJobs.delete(job.key);
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
    await this.refresh();
    const tail = workingTail(this.entries, this.units, this.cfg, this.window(), this.state.stats.roundTokens);
    const span = alignToUnits(this.units, 0, tail.start);
    if (!span) return null;
    const [from, to] = span;
    const first = this.entries[to];
    if (!first) return null;
    const carry = this.carried(from, to);
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
    this.harvest(final);
    // plans made against the old projection are void
    this.foldJobs.clear();
    this.appliedNow = [];
    return this.take();
  }

  /** Append-only harnesses: the consolidated state to inject after the harness compacted (§4.6.3). */
  reinjection(): string {
    return renderReinjection(this.state, this.cfg.context.reinjectTokens);
  }

  /** Session end: attribute what is still open with deterministic signals, and hand back the last records. */
  async onShutdown(): Promise<CommitBatch> {
    try {
      await this.refresh();
    } catch {
      // the harness may already be tearing down
    }
    // a session that ended before its last round completed is still searchable (§5.6)
    this.indexTurns();
    if (!this.light) {
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

  /** Work that needs a model and was not done: queued for the next session's idle time (§6.6.8). */
  leftover(): Array<{ kind: "idle-harvest"; records: string[] }> {
    const unharvested = [...this.state.records.values()].filter((r) => r.kind === "precip" && !r.knowledge && !this.state.parentOf(r.id)).map((r) => r.id);
    return unharvested.length ? [{ kind: "idle-harvest", records: unharvested }] : [];
  }

  get requestCount(): number {
    return this.requests;
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
          job.plan = plan;
          job.done = true;
          return plan;
        },
        (e) => {
          job.done = true;
          this.telemetry?.event("precip.failed", { error: String((e as Error)?.message ?? e) });
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
      for (const r of res.records) this.emit(r);
      for (const rec of res.updatedRecords) this.emit({ type: "realctx2.consolidation", record: rec });
      this.actions.delete(intent.id);
    } catch (e) {
      this.telemetry?.event("attribution.failed", { error: String((e as Error).message) });
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
    return planReplace(entries, state, from, to, { id, kind: "precip", text, preferAnchorId: intent.guidanceEntryId, intent, outcome, telos, model: this.adapter.modelName(), now: this.now(), sidecar: out.sidecar, shadow: this.level === 0 });
  }

  // ───────────── committing plans
  private invariants(plan: ReplacePlan, allowTail: boolean, minimalTail = false): string | null {
    if (plan.record.shadow) return null;
    const tail = workingTail(this.entries, this.units, this.cfg, this.window(), this.state.stats.roundTokens, { minimal: minimalTail });
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
    if (plan.record.kind === "precip") this.handOffEpisode(plan.record);
    else this.harvest(plan.record);
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
    for (const job of [...this.foldJobs.values()]) {
      if (!job.done || job.kind !== "ordinary") continue;
      this.foldJobs.delete(job.key);
      if (job.plan) this.commitPlan(job.plan, { allowTail: false });
    }
    // prepared folds whose span changed, or whose intent closed, are dropped
    for (const job of [...this.foldJobs.values()]) {
      if (!job.done || !job.plan) continue;
      const from = this.index.get(job.plan.spanIds[0]!);
      if (from === undefined || spanFingerprint(this.entries, from, from + job.plan.spanIds.length) !== job.plan.fingerprint) this.foldJobs.delete(job.key);
    }
  }

  // ───────────── memory hand-off (§5.3.4, §5.4.4)
  private handOffEpisode(record: ConsolidationRecord): void {
    const mem = this.memory;
    if (!mem || !record.text || !record.sidecar) return;
    const intentId = record.intentId;
    const entryIds = record.children.filter((c): c is { entryId: string } => "entryId" in c).map((c) => c.entryId).slice(0, 64);
    const body = record.text.split("\n").slice(1).join("\n");
    const candidate: Candidate = {
      text: body,
      title: record.sidecar.outcome_summary || undefined,
      kind: "episode",
      origin: "harvest",
      defaultScope: "personal",
      artifacts: [...record.sidecar.artifacts, ...record.sidecar.state_changes].slice(0, 32),
      evaluation: record.outcome === "success" ? "good" : record.outcome === "failure" ? "bad" : "neutral",
      provenance: { sessionId: this.sessionId, turnId: record.id, entryIds },
      after: this.lastEpisode ?? undefined,
      sourceTexts: [body],
    };
    void this.track(
      mem.writer.write([candidate]).then((res) => {
        const r = res[0];
        if (r?.id && r.scope && (r.status === "created" || r.status === "merged")) {
          this.lastEpisode = { scope: r.scope, id: r.id };
          if (intentId) this.episodes.set(intentId, this.lastEpisode);
        }
      }),
    ).catch(() => undefined);
  }

  /** Each committed fold sends its knowledge items to the write path, de-duplicated by item hash. */
  private harvest(record: ConsolidationRecord, source?: string): void {
    const mem = this.memory;
    const items = (record.knowledge ?? []).filter((k) => !this.harvested.has(knowledgeKey(k)) && !k.memoryId);
    if (!mem || !items.length) return;
    for (const k of items) this.harvested.add(knowledgeKey(k));
    const episode = record.intentId ? this.episodes.get(record.intentId) : undefined;
    const candidates: Candidate[] = items.map((k) => ({
      text: k.fact,
      kind: /^(run|use|pass|set|call|avoid|add|install|restart|always|never)\b/i.test(k.fact.replace(/^[`"']/, "")) ? "procedure" : "fact",
      origin: "harvest",
      evaluation: k.evaluation,
      validFrom: k.as_of && !Number.isNaN(Date.parse(k.as_of)) ? new Date(k.as_of).toISOString() : undefined,
      supersedesHint: k.supersedes,
      provenance: { sessionId: this.sessionId, turnId: record.id },
      evidence: source ? [] : [{ quote: k.fact, source: { type: "session", ref: record.id } }],
      sourceTexts: [record.text ?? ""],
      episode,
    }));
    void this.track(
      mem.writer.write(candidates).then((res) => {
        let any = false;
        const knowledge = (record.knowledge ?? []).map((k) => {
          const i = items.indexOf(k);
          const id = i >= 0 ? res[i]?.id : undefined;
          if (!id) return k;
          any = true;
          return { ...k, memoryId: id };
        });
        // the record learns which memories its knowledge went into (for `inspect`)
        if (any) this.emit({ type: "realctx2.consolidation", record: { ...(this.state.records.get(record.id) ?? record), knowledge } });
      }),
    ).catch(() => undefined);
  }

  /** Idle harvest (§5.4.4): one ripple-style extraction over Precip memories no fold has covered yet. */
  async idleHarvest(signal?: AbortSignal, budgetTokens = 12_000): Promise<number> {
    const open = [...this.state.records.values()].filter((r) => r.kind === "precip" && r.text && !r.knowledge && !this.state.parentOf(r.id)).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    if (!open.length) return 0;
    const picked: ConsolidationRecord[] = [];
    let tokens = 0;
    for (const r of open) {
      const t = estimateTokens(r.text!);
      if (tokens + t > budgetTokens && picked.length) break;
      picked.push(r);
      tokens += t;
    }
    const out = await this.consolidator.ripple({ text: picked.map((r) => r.text!).join("\n\n"), carry: [], telos: [] }, signal);
    if (!out || signal?.aborted) return 0;
    // it edits no context: the knowledge is attached to the Precip records and harvested
    picked.forEach((r, i) => {
      // the first record carries the items; the others are marked as covered
      const knowledge: KnowledgeItem[] = i === 0 ? out.knowledge : [];
      const updated: ConsolidationRecord = { ...r, knowledge };
      this.emit({ type: "realctx2.consolidation", record: updated });
      if (knowledge.length) this.harvest(updated);
    });
    return out.knowledge.length;
  }

  // ───────────── Palim: ordinary mode (§5.4.2)
  private occupancy(requestTokens: number | null): number {
    const base = requestTokens ?? this.entries.reduce((s, e) => s + (e.omitted ? 0 : e.tokens), 0);
    const q = this.state.stats.roundTokens.length ? quantile(this.state.stats.roundTokens, this.cfg.context.q) : 0;
    return base + q;
  }

  private lastOccupancy = 0;

  private fast(): boolean {
    return this.lastOccupancy > this.cfg.context.climb.fastOccupancy * this.window();
  }

  private stable(region: Region, depth: number): boolean {
    const c = this.cfg.context.climb;
    const need = Math.max(1, Math.round(c.stableRounds / (this.fast() ? c.fastFactor : 1)));
    if (region.level === depth && region.intent) {
      // the innermost level keeps growing: it counts as stable once its intent has run long enough
      return Janus.roundsSince(region.intent, this.entries, this.units) >= need;
    }
    return roundCount(this.units) - roundsBefore(this.units, region.to) >= need;
  }

  /** At most once every `roundsPerLevel` rounds, the frontier rises by one level if the next one is stable. */
  private climb(): void {
    const c = this.cfg.context.climb;
    if (!c.enabled) return;
    const regions = this.state.regions(this.entries);
    const depth = regions.length - 1;
    const f = Math.min(this.state.stats.frontier ?? 0, depth);
    if (f !== this.state.stats.frontier) {
      this.state.stats.frontier = f;
      this.statsDirty = true;
    }
    if (f >= depth) return;
    const every = Math.max(1, Math.round(c.roundsPerLevel / (this.fast() ? c.fastFactor : 1)));
    if (this.round - (this.state.stats.lastClimbRound ?? 0) < every) return;
    if (!this.stable(regions[f + 1]!, depth)) return;
    this.state.stats.frontier = f + 1;
    this.state.stats.lastClimbRound = this.round;
    this.statsDirty = true;
  }

  /** The span a fold of a level would cover: its body before the working tail, from the last fold on. */
  private foldSpan(region: Region, tailStart: number): FoldSpan | null {
    // guidance messages of open intents are never folded
    const bodyFrom = region.intent ? region.from + 1 : region.from;
    const bodyTo = Math.min(region.to, tailStart);
    if (bodyTo <= bodyFrom) return null;
    // the unfolded part starts after the last Palim message of this body; that message is an input of the next fold
    let from = bodyFrom;
    let unfoldedFrom = bodyFrom;
    for (let i = bodyTo - 1; i >= bodyFrom; i--) {
      const e = this.entries[i]!;
      const rec = !e.omitted && e.edited ? this.state.recordAt(e.id) : null;
      if (rec && (rec.kind === "palim" || rec.kind === "compaction")) {
        from = i;
        unfoldedFrom = i + 1;
        break;
      }
    }
    const span = alignToUnits(this.units, from, bodyTo);
    if (!span) return null;
    let consolidated = 0;
    for (let i = Math.max(span[0], unfoldedFrom); i < span[1]; i++) {
      const e = this.entries[i]!;
      if (!e.omitted && e.edited && this.state.recordAt(e.id)) consolidated++;
    }
    const tokens = sumTokens(this.entries, Math.max(span[0], unfoldedFrom), span[1]);
    return { level: region.level, from: span[0], to: span[1], tokens, consolidated, intent: region.intent };
  }

  /** Fold only if it pays for itself: Δ̂·p_read·R̂ ≥ S·(p_write − p_read) + C_fold (§5.4.2). */
  private costCheck(span: FoldSpan, cold: boolean): boolean {
    const price = this.adapter.pricing();
    const input = price?.input && price.input > 0 ? price.input : 1;
    const pRead = price?.cacheRead && price.cacheRead > 0 ? price.cacheRead : 0.1 * input;
    const pWrite = price?.cacheWrite && price.cacheWrite > 0 ? price.cacheWrite : 1.25 * input;
    const output = price?.output && price.output > 0 ? price.output : 5 * input;
    const spanTokens = sumTokens(this.entries, span.from, span.to);
    const saving = 0.65 * spanTokens;
    // C_fold: the aux call that writes the fold, in the same units (the main model's prices when the aux model's are unknown)
    const auxPrice = this.adapter.auxPricing?.("palim") ?? null;
    const auxIn = auxPrice?.input && auxPrice.input > 0 ? auxPrice.input : input;
    const auxOut = auxPrice?.output && auxPrice.output > 0 ? auxPrice.output : output;
    const cFold = spanTokens * auxIn + 0.35 * spanTokens * auxOut;
    const R = this.memory ? this.memory.expectedRequests(this.requests) : 20;
    if (cold) return saving * (pWrite + pRead * (R - 1)) >= cFold;
    const suffix = sumTokens(this.entries, span.to, this.entries.length);
    return saving * pRead * R >= suffix * (pWrite - pRead) + cFold;
  }

  private dueSpans(): Array<{ span: FoldSpan; passes: boolean; coldOnly: boolean }> {
    const s = this.scaled();
    const c = this.cfg.context.climb;
    const regions = this.state.regions(this.entries);
    const depth = regions.length - 1;
    const tail = workingTail(this.entries, this.units, this.cfg, this.window(), this.state.stats.roundTokens);
    const f = c.enabled ? Math.min(this.state.stats.frontier ?? 0, depth) : 0;
    const out: Array<{ span: FoldSpan; passes: boolean; coldOnly: boolean }> = [];
    for (const region of regions) {
      if (region.level > f) break;
      const span = this.foldSpan(region, tail.start);
      if (!span) continue;
      const innermost = region.level === depth && depth > 0;
      // size: below the innermost level, E_min consolidated messages and T_min tokens; at the innermost, more
      if (innermost ? span.tokens < s.innermostMin : span.consolidated < this.cfg.context.Emin || span.tokens < s.Tmin) continue;
      // no closure expected: an intent about to close is consolidated whole by Precip anyway
      if (region.intent && (this.closeProb[region.intent.id] ?? 0) >= c.skipCloseProb) continue;
      const check = c.costCheck && !this.fast();
      const warm = !check || this.costCheck(span, false);
      const cold = warm || this.costCheck(span, true);
      out.push({ span, passes: warm, coldOnly: !warm && cold });
    }
    return out;
  }

  private foldKey(span: FoldSpan): string {
    return `${span.level}:${sha256(spanFingerprint(this.entries, span.from, span.to)).slice(0, 16)}`;
  }

  /** Knowledge items of earlier folds inside a span: carried forward without re-judging them. */
  private carried(from: number, to: number): KnowledgeItem[] {
    const out: KnowledgeItem[] = [];
    for (let i = from; i < to; i++) {
      const e = this.entries[i]!;
      if (e.omitted) continue;
      const rec = this.state.recordAt(e.id);
      if (rec?.knowledge) out.push(...rec.knowledge);
    }
    return out;
  }

  private async generateFold(span: FoldSpan, opts: { pressure: boolean; signal?: AbortSignal }): Promise<ReplacePlan | null> {
    const entries = this.entries;
    const state = this.state;
    const before = sumTokens(entries, span.from, span.to);
    const telos = [...(span.intent ? state.telos(span.intent) : []), ...(span.intent ? [span.intent.label] : [])];
    const carry = this.carried(span.from, span.to);
    const text = renderForAux(entries, span.from, span.to, Math.max(8000, Math.floor(this.window() * 0.4)));
    const deltaMin = this.scaled().deltaMin;
    // keep the fold only if it saves at least Δ_min; otherwise retry with an instruction to be more concise
    for (let attempt = 0; attempt <= this.cfg.context.foldRetries; attempt++) {
      if (opts.signal?.aborted) return null;
      const out = await this.consolidator.ripple({ text, carry, telos, pressure: opts.pressure, concise: attempt }, opts.signal);
      if (!out) return null;
      const id = this.consolidator.newId(state);
      const rendered = renderPalim(id, out.narrative, out.knowledge);
      if (before - estimateTokens(rendered) < deltaMin) continue;
      return planReplace(entries, state, span.from, span.to, { id, kind: "palim", text: rendered, intent: span.intent ?? undefined, telos, model: this.adapter.modelName(), now: this.now(), knowledge: out.knowledge });
    }
    // a failed fold leaves its source intact
    return null;
  }

  private startFold(span: FoldSpan, kind: FoldJob["kind"], signal?: AbortSignal): FoldJob | null {
    const key = this.foldKey(span);
    const have = this.foldJobs.get(key);
    if (have) return have;
    // one fold per level at a time
    for (const j of this.foldJobs.values()) if (j.level === span.level && !j.done) return null;
    const job: FoldJob = { key, level: span.level, kind, promise: Promise.resolve(null), plan: null, done: false, startedRound: this.round };
    job.promise = this.track(this.generateFold(span, { pressure: kind === "prepared", signal })).then(
      (plan) => {
        job.plan = plan;
        job.done = true;
        if (!plan) this.foldJobs.delete(key);
        return plan;
      },
      () => {
        job.done = true;
        this.foldJobs.delete(key);
        return null;
      },
    );
    this.foldJobs.set(key, job);
    return job;
  }

  private startOrdinaryFolds(): void {
    for (const d of this.dueSpans()) {
      if (d.passes) this.startFold(d.span, "ordinary");
      else {
        this.state.stats.foldsSkippedByCost++;
        this.statsDirty = true;
      }
    }
  }

  /** Folds that fail the warm-cache check but pay off on a cold cache are prepared during idle time. */
  private prepareColdFolds(signal?: AbortSignal): void {
    for (const d of this.dueSpans()) if (d.coldOnly) this.startFold(d.span, "cold", signal);
  }

  // ───────────── Palim: pressure mode (§5.4.3)
  private sweepSpans(minimalTail: boolean): FoldSpan[] {
    const tail = workingTail(this.entries, this.units, this.cfg, this.window(), this.state.stats.roundTokens, { minimal: minimalTail });
    const out: FoldSpan[] = [];
    // root prefix, then open-intent regions from outermost to innermost
    for (const region of this.state.regions(this.entries)) {
      const span = this.foldSpan(region, tail.start);
      if (span && sumTokens(this.entries, span.from, span.to) > this.scaled().deltaMin) out.push(span);
    }
    return out;
  }

  private async pressure(signal?: AbortSignal): Promise<void> {
    const W = this.window();
    const rho = this.cfg.context.rho * W;
    const measure = async () => {
      const req = await this.adapter.requestTokens();
      // the harness reports the size before this step's edits: subtract what they save
      return this.occupancy(req === null ? null : Math.max(0, req - this.savedThisStep));
    };
    let P = await measure();
    this.lastOccupancy = P;
    if (P <= rho) {
      // preparing ahead: work out the folds the sweep would make, without committing them
      if (P > this.cfg.context.prepareFraction * W) for (const span of this.sweepSpans(false).slice(0, 2)) this.startFold(span, "prepared");
      return;
    }
    this.telemetry?.event("pressure", { P, W });
    // ready folds commit at once, so the request does not wait for an aux session
    for (const job of [...this.foldJobs.values()].sort((a, b) => a.level - b.level)) {
      if (!job.done || !job.plan) continue;
      this.foldJobs.delete(job.key);
      this.commitPlan(job.plan, { allowTail: false });
    }
    P = await measure();
    // SWEEP: root prefix, open-intent regions outermost to innermost; then with the tail shrunk to unfinished rounds
    for (const minimal of [false, true]) {
      if (P <= rho) break;
      let progress = true;
      while (P > rho && progress && !signal?.aborted) {
        progress = false;
        for (const span of this.sweepSpans(minimal)) {
          if (P <= rho || signal?.aborted) break;
          const pending = this.foldJobs.get(this.foldKey(span));
          const plan = pending && !pending.done ? await pending.promise : await this.generateFold(span, { pressure: true, signal });
          if (pending) this.foldJobs.delete(pending.key);
          if (!plan) continue;
          if (this.commitPlan(plan, { allowTail: false, minimalTail: minimal })) {
            progress = true;
            P = await measure();
          }
        }
      }
    }
    this.lastOccupancy = P;
    if (P > W && this.exhaustedNotifiedAt !== this.round) {
      // capacity exhaustion: report it before the request goes out; never truncate silently
      this.exhaustedNotifiedAt = this.round;
      this.adapter.notify(`realctx2: the context is at capacity (${Math.round(P)} of ${W} tokens) and nothing more can be consolidated. Consider /compact or starting a new session.`, "warning");
      this.telemetry?.event("capacity.exhausted", { P, W });
    }
  }

  // ───────────── append-only harnesses: shadow Palim (§4.6.3)
  /** No in-place fold: knowledge is produced incrementally, for harvest and the post-compaction injection. */
  private shadowPalim(): void {
    const s = this.scaled();
    const open = [...this.state.records.values()].filter((r) => r.kind === "precip" && r.text && !this.state.parentOf(r.id));
    const tokens = open.reduce((n, r) => n + r.tokensBefore, 0);
    if (open.length < this.cfg.context.Emin || tokens < s.Tmin) return;
    const key = `shadow:${open.map((r) => r.id).join(",")}`;
    if (this.foldJobs.has(key)) return;
    const job: FoldJob = { key, level: 0, kind: "ordinary", promise: Promise.resolve(null), plan: null, done: false, startedRound: this.round };
    const state = this.state;
    job.promise = this.track(
      (async () => {
        const out = await this.consolidator.ripple({ text: open.map((r) => r.text!).join("\n\n"), carry: open.flatMap((r) => r.knowledge ?? []), telos: state.stack.map((i) => i.label) });
        if (!out) return null;
        const id = this.consolidator.newId(state);
        const text = renderPalim(id, out.narrative, out.knowledge);
        const record: ConsolidationRecord = { id, kind: "palim", anchorId: open[0]!.anchorId, children: open.map((r) => ({ id: r.id })), telos: state.stack.map((i) => i.label), tokensBefore: tokens, tokensAfter: estimateTokens(text), model: this.adapter.modelName(), createdAt: this.now(), text, knowledge: out.knowledge, shadow: true };
        return { record, edits: [], spanIds: [], fingerprint: "", text } satisfies ReplacePlan;
      })(),
    ).then(
      (plan) => {
        job.plan = plan;
        job.done = true;
        return plan;
      },
      () => {
        job.done = true;
        return null;
      },
    );
    this.foldJobs.set(key, job);
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
      this.telemetry?.event("turnindex.failed", { error: String((e as Error).message) });
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

  status(): { round: number; requests: number; stack: Intent[]; records: number; deliveries: number; attributed: number; frontier: number; janusLate: number; foldsSkippedByCost: number; occupancy: number; window: number; jobs: { precip: number; folds: number }; problems: string[] } {
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
      occupancy: Math.round(this.lastOccupancy),
      window: this.window(),
      jobs: { precip: this.precipJobs.length, folds: this.foldJobs.size },
      problems: this.problems.slice(-10),
    };
  }
}
