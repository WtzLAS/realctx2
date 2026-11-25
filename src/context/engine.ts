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
import { toolNames } from "../tools/env.ts";
import { clipWords, estimateTokens, extractPathTokens, headTail, ngramOverlap, sanitize } from "../util/text.ts";
import { type BlobStore, guardToolResult } from "./archive.ts";
import { Attributor } from "./attribution.ts";
import { checkInvariants, Consolidator, planReplace, renderForAux, type ReplacePlan, spanFingerprint } from "./consolidate.ts";
import { Harvester } from "./harvest.ts";
import { type DriftAdvisory, Janus, type JanusInput } from "./janus.ts";
import { Palim } from "./palim.ts";
import { GUIDANCE_TYPE, renderDriftReminder, renderEmptyReminder, renderLateCards, renderPalim, renderPrecip, renderReinjection, renderReminder } from "./render.ts";
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

export type IntentActionInput =
  | { action: "open"; label: string; reason?: string; done: string; giveUp?: string }
  | { action: "close"; outcome?: IntentOutcome; count?: number; all?: boolean }
  | { action: "shift"; label: string; reason?: string; done: string; giveUp?: string; outcome?: IntentOutcome; count?: number; all?: boolean }
  | { action: "update"; label?: string; reason?: string; done?: string; giveUp?: string };

export interface IntentActionResult {
  ok: boolean;
  error?: string;
  action: IntentActionInput["action"];
  closed: Array<{ intent: Intent; outcome: IntentOutcome }>;
  opened: Intent | null;
  updated: Intent | null;
  stack: Intent[];
  cards: string;
  paths: string;
  deliveries: PendingDelivery[];
}

interface PendingDrift {
  advisory: DriftAdvisory;
  gen: number;
  stackVersion: number;
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

/** Proactive cards whose (emulated) gate was still running when their intent was opened. */
interface LateCards {
  intentId: string;
  gen: number;
  done: boolean;
  result: Awaited<ReturnType<Retriever["proactive"]>> | null;
}

/** Where a newly opened intent starts when its round's assistant entry is not in the transcript yet. */
interface KindleStart {
  afterId: string;
  skipUser: boolean;
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
  private janusGen = 0;
  private janusTimer: ReturnType<typeof setTimeout> | null = null;
  private janusCheckInFlight = false;
  /** Last transcript leaf covered by an advisory drift check (or the latest `intent` tool call). */
  private janusLastEvidenceLeafId: string | null = null;
  /** Most recent user message since the last advisory drift check. */
  private janusPendingUserMessage: string | undefined = undefined;
  /** Monotonic version incremented whenever the main model mutates the intent stack. */
  private stackVersion = 0;
  /** Ready drift reminder produced in the background, waiting for the next commit point. */
  private pendingDrift: PendingDrift | null = null;
  /** Proactive cards that missed their `intent` open wait, delivered when they arrive. */
  private lateCards: LateCards[] = [];
  /** Opened intents whose first governed entry is not persisted yet. */
  private pendingStarts = new Map<string, KindleStart>();
  /** Round of the last empty-stack periodic reminder. */
  private lastEmptyReminderRound = 0;
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
    this.janus = new Janus({ cfg: o.cfg, decision: o.decision });
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
    this.clearDriftTimer();
    this.janusCheckInFlight = false;
    this.janusLastEvidenceLeafId = entries.at(-1)?.id ?? null;
    this.janusPendingUserMessage = undefined;
    this.pendingDrift = null;
    this.lateCards = [];
    this.pendingStarts.clear();
    this.janusGen++;
    this.stackVersion++;
    this.closeProb = {};
    this.actions.clear();
    this.turnPathTokens = 0;
    this.gatedThisTurn.clear();
    this.shownThisTurn.clear();
    this.lastReminderRound.clear();
    this.lastEmptyReminderRound = this.round;
    this.statsDirty = false;
    this.savedThisStep = 0;
    this.indexedEntries = null;
    this.pending = emptyBatch();
    this.unresolvedDeliveries = [];
    this.resolveIds();
    await this.palim.refreshOccupancy();
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
      round: where.toolCallId && !(this.units.at(-1)?.round && !this.units.at(-1)!.complete) ? this.round + 1 : this.round,
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

  // ───────────── Main-model intent tool & advisory Janus (§5.2)
  private intentToolName(): string {
    return toolNames(this.cfg).intent;
  }

  private clearDriftTimer(): void {
    if (this.janusTimer !== null) {
      clearTimeout(this.janusTimer);
      this.janusTimer = null;
    }
  }

  private cancelDriftCheck(): void {
    this.clearDriftTimer();
    this.pendingDrift = null;
    this.janusLastEvidenceLeafId = this.entries.at(-1)?.id ?? null;
    this.janusPendingUserMessage = undefined;
  }

  /** Whether the cooldown window allows another strong drift reminder (0 disables drift checks). */
  private canEmitDrift(): boolean {
    const cd = this.cfg.janus.driftCooldownRounds;
    if (cd <= 0) return false;
    const last = this.state.stats.lastDriftReminderRound;
    return last === undefined || this.round - last >= cd;
  }

  /**
   * Schedule a debounced, nonblocking advisory drift check. When unchecked transcript tokens
   * reach `janus.maxInputTokens` (even while the debounce timer is still counting down), bypass
   * the debounce and prefire immediately once so no context is truncated away before inspection.
   */
  private scheduleDriftCheck(opts: { userMessage?: string; extraTokens?: number; onlyIfCountingDown?: boolean } = {}): void {
    if (this.light || !this.contextEnabled() || !this.janus.available() || !this.canEmitDrift()) return;
    if (opts.userMessage !== undefined) this.janusPendingUserMessage = opts.userMessage;
    if (this.janusCheckInFlight) return;
    const leaf = this.entries.at(-1)?.id ?? null;
    const hasNewEntries = leaf !== null && leaf !== this.janusLastEvidenceLeafId;
    if (!hasNewEntries && !this.janusPendingUserMessage) return;

    const unchecked = this.janus.uncheckedTokens(
      {
        state: this.state,
        entries: this.entries,
        units: this.units,
        userMessage: this.janusPendingUserMessage,
        mode: "full",
        round: this.round,
        sinceEntryId: this.janusLastEvidenceLeafId,
      },
      opts.extraTokens ?? 0,
    );
    if (unchecked >= this.janus.maxInputTokens()) {
      this.clearDriftTimer();
      this.track(this.runDriftCheck("prefire"));
      return;
    }
    if (opts.onlyIfCountingDown && this.janusTimer === null) return;
    this.clearDriftTimer();
    const delay = Math.max(0, this.cfg.janus.debounceMs);
    this.janusTimer = setTimeout(() => {
      this.janusTimer = null;
      this.track(this.runDriftCheck("debounce"));
    }, delay);
    (this.janusTimer as { unref?: () => void }).unref?.();
  }

  private async runDriftCheck(trigger: "debounce" | "prefire"): Promise<void> {
    if (this.light || !this.contextEnabled() || this.janusCheckInFlight || !this.canEmitDrift()) return;
    const gen = this.janusGen;
    const ver = this.stackVersion;
    this.janusCheckInFlight = true;
    try {
      try {
        await this.refresh();
      } catch {
        return;
      }
      if (gen !== this.janusGen || ver !== this.stackVersion || !this.canEmitDrift()) return;
      const leaf = this.entries.at(-1)?.id ?? null;
      const userMessage = this.janusPendingUserMessage;
      const sinceEntryId = this.janusLastEvidenceLeafId;
      if (!this.entries.length && !userMessage) return;
      // Advance the watermark before awaiting the network call so subsequent turns do not re-prefire the same span.
      this.janusLastEvidenceLeafId = leaf;
      this.janusPendingUserMessage = undefined;
      const input: JanusInput = {
        state: this.state,
        entries: this.entries,
        units: this.units,
        userMessage,
        mode: "full",
        round: this.round,
        cacheKey: `${this.sessionId}.janus`,
        sinceEntryId,
      };
      const plan = await this.janus.decide(input);
      if (gen !== this.janusGen || ver !== this.stackVersion) return;
      Object.assign(this.closeProb, plan.closeProb);
      const advisory = this.janus.advisory(plan, this.state.stack, this.intentToolName());
      if (advisory) {
        this.pendingDrift = { advisory, gen, stackVersion: ver };
        this.telemetry?.event("janus.drift_detected", { trigger, kind: advisory.kind, closures: advisory.closures.length, focus: advisory.focus });
      }
    } finally {
      this.janusCheckInFlight = false;
    }
  }

  /** Consume a ready background drift advisory if still valid and outside cooldown. */
  private takeDriftReminder(): GuidanceMessage | null {
    const pending = this.pendingDrift;
    if (!pending) return null;
    this.pendingDrift = null;
    if (pending.gen !== this.janusGen || pending.stackVersion !== this.stackVersion || !this.canEmitDrift()) return null;
    this.state.stats.lastDriftReminderRound = this.round;
    this.state.stats.driftReminders = (this.state.stats.driftReminders ?? 0) + 1;
    this.statsDirty = true;
    const innermost = this.state.innermost();
    if (innermost) this.lastReminderRound.set(innermost.id, this.round);
    else this.lastEmptyReminderRound = this.round;
    return this.guidance(renderDriftReminder(pending.advisory.summary, this.state.stack), { drift: pending.advisory.kind });
  }

  private async findDuplicateOpen(label: string, open: Intent[], signal?: AbortSignal): Promise<Intent | null> {
    const lower = label.toLowerCase();
    for (const i of open) {
      if (i.label.toLowerCase() === lower) return i;
      if (this.memory?.sim) {
        const pair = await this.memory.sim.textPair(label, i.label, signal);
        if (pair.sim >= this.memory.sim.threshold("intentDuplicate", pair.mode)) return i;
      }
    }
    return null;
  }

  private cleanLabel(raw: string): string {
    return clipWords(sanitize(raw).replace(/\s+/g, " ").trim(), 12).replace(/[."]+$/, "");
  }

  /**
   * Execute an `intent` tool action from the main model: open, close, shift, or update.
   * Opening fetches proactive memory cards and path memories; closing queues Precip consolidation.
   */
  async applyIntentAction(input: IntentActionInput, opts: { toolCallId?: string; signal?: AbortSignal } = {}): Promise<IntentActionResult> {
    const err = (message: string): IntentActionResult => ({
      ok: false,
      error: message,
      action: input.action,
      closed: [],
      opened: null,
      updated: null,
      stack: this.state.stack,
      cards: "",
      paths: "",
      deliveries: [],
    });
    if (this.light) return err("Intent tracking is disabled in light mode (sub-sessions).");
    if (!this.contextEnabled()) return err("The context engine is disabled for this model (maxWindow = 0).");
    await this.refresh();

    // Locate the current active assistant round (if already recorded) so closures end before it
    // and newly opened intents begin cleanly at it without overlapping spans.
    const lastUnit = this.units.at(-1);
    const inActiveRound =
      !!lastUnit &&
      lastUnit.round &&
      (!lastUnit.complete || (opts.toolCallId ? this.entries[lastUnit.start]?.toolCalls?.some((c) => c.id === opts.toolCallId) === true : false));
    const priorLeaf = inActiveRound ? (lastUnit!.start > 0 ? this.entries[lastUnit!.start - 1]!.id : "") : (this.entries.at(-1)?.id ?? "");
    const openStartId = inActiveRound ? this.entries[lastUnit!.start]!.id : undefined;

    if (input.action === "update") {
      const cur = this.state.innermost();
      if (!cur) return err("There is no open intent to update. Use action \"open\" first.");
      const nextLabel = input.label !== undefined ? this.cleanLabel(input.label) : cur.label;
      const nextReason = input.reason !== undefined ? sanitize(input.reason).trim() : cur.reason;
      const nextDone = input.done !== undefined ? sanitize(input.done).trim() : cur.success;
      const nextGiveUp = input.giveUp !== undefined ? sanitize(input.giveUp).trim() : cur.failure;
      if (input.label === undefined && input.reason === undefined && input.done === undefined && input.giveUp === undefined) {
        return err("update requires at least one of label, reason, done, or give_up.");
      }
      if (!nextLabel) return err("label must be non-empty.");
      if (!nextDone) return err("done must be non-empty.");
      if (nextLabel.toLowerCase() !== cur.label.toLowerCase()) {
        const dup = await this.findDuplicateOpen(nextLabel, this.state.stack.slice(0, -1), opts.signal);
        if (dup) return err(`"${nextLabel}" duplicates the open intent "${dup.label}".`);
      }
      const updated: Intent = { ...cur, label: nextLabel, reason: nextReason, success: nextDone, failure: nextGiveUp };
      this.emit({ type: "realctx2.intent", intent: updated });
      if (this.memory) this.memory.recordPurpose(updated.id, `${updated.label}\n${updated.reason}`);
      this.stackVersion++;
      this.cancelDriftCheck();
      this.lastReminderRound.set(updated.id, this.round);
      this.telemetry?.step({ kind: "intent.tool", action: "update", closures: 0, opened: false, updated: true, cards: 0 });
      return { ok: true, action: "update", closed: [], opened: null, updated, stack: this.state.stack, cards: "", paths: "", deliveries: [] };
    }

    if (input.action === "close" && !this.state.stack.length) {
      return err("There is no open intent to close.");
    }

    // Pre-validate open / shift fields before mutating the stack so failures are atomic.
    let popCount = 0;
    if (input.action === "close" || input.action === "shift") {
      if (this.state.stack.length) {
        popCount = input.all ? this.state.stack.length : Math.min(this.state.stack.length, Math.max(1, Math.floor(input.count ?? 1)));
      }
    }
    const remainingAfterPop = this.state.stack.slice(0, this.state.stack.length - popCount);

    let cleanLbl = "";
    let cleanReason = "";
    let cleanDone = "";
    let cleanGiveUp = "";
    if (input.action === "open" || input.action === "shift") {
      cleanLbl = this.cleanLabel(input.label ?? "");
      cleanReason = sanitize(input.reason ?? "").trim();
      cleanDone = sanitize(input.done ?? "").trim();
      cleanGiveUp = sanitize(input.giveUp ?? "").trim();
      if (!cleanLbl) return err(`${input.action} requires a non-empty label (≤12 words).`);
      if (!cleanDone) return err(`${input.action} requires a non-empty done condition.`);
      if (remainingAfterPop.length >= this.cfg.janus.maxDepth) {
        return err(`Intent stack is at maxDepth (${this.cfg.janus.maxDepth}). Close or shift an intent before opening another.`);
      }
      const dup = await this.findDuplicateOpen(cleanLbl, remainingAfterPop, opts.signal);
      if (dup) return err(`"${cleanLbl}" duplicates the open intent "${dup.label}".`);
    }

    // 1. Apply closures (innermost first)
    const closedNow: Array<{ intent: Intent; outcome: IntentOutcome }> = [];
    if (popCount > 0) {
      const outcome: IntentOutcome = (input.action === "close" || input.action === "shift" ? input.outcome : undefined) ?? "success";
      const toClose = this.state.stack.slice(this.state.stack.length - popCount).reverse();
      const priorIdx = priorLeaf ? (this.index.get(priorLeaf) ?? -1) : -1;
      for (const cur of toClose) {
        this.pendingStarts.delete(cur.id);
        const startIdx = cur.guidanceEntryId ? (this.index.get(cur.guidanceEntryId) ?? -1) : -1;
        const closeLeaf = priorIdx >= 0 && (startIdx < 0 || priorIdx >= startIdx) ? priorLeaf : (this.entries.at(-1)?.id ?? "");
        const closed: Intent = { ...cur, status: outcome, closedEntryId: closeLeaf };
        const level = this.state.stack.findIndex((i) => i.id === cur.id) + 1;
        this.emit({ type: "realctx2.intent", intent: closed });
        closedNow.push({ intent: closed, outcome });
        // Falling back: the level its consolidation lands in has to become stable again.
        this.state.stats.frontier = Math.max(0, Math.min(this.state.stats.frontier ?? 0, level - 2));
        this.state.stats.lastClimbRound = this.round;
        this.statsDirty = true;
      }
      this.queuePrecip(closedNow, false);
    }

    // 2. Apply open (for `open` and `shift`)
    let opened: Intent | null = null;
    let cards = "";
    let paths = "";
    const deliveries: PendingDelivery[] = [];
    if (input.action === "open" || input.action === "shift") {
      const parentId = this.state.innermost()?.id ?? null;
      const intent: Intent = {
        id: randomId8(),
        parentId,
        label: cleanLbl,
        reason: cleanReason,
        success: cleanDone,
        failure: cleanGiveUp,
        guidanceEntryId: openStartId ?? "",
        openedRound: this.round,
        status: "open",
      };
      if (!openStartId) this.pendingStarts.set(intent.id, { afterId: priorLeaf, skipUser: false });
      if (parentId === null) {
        this.state.stats.frontier = 0;
        this.statsDirty = true;
      }
      this.emit({ type: "realctx2.intent", intent: { ...intent } });
      opened = intent;
      let shown: Shown[] = [];
      let pathShown: Shown[] = [];
      if (this.memory) {
        this.memory.recordPurpose(intent.id, `${intent.label}\n${intent.reason}`);
        try {
          const parentLabel = parentId ? this.state.intents.get(parentId)?.label : undefined;
          const pro = await this.proactiveCards(intent, parentLabel, opts.signal, this.cfg.janus.lateWaitMs);
          cards = pro?.text ?? "";
          shown = pro?.cards ?? [];
          const mentioned = this.memory.paths.resolveMentions(extractPathTokens(`${intent.label} ${intent.reason} ${intent.success}`));
          const recent = this.recentPaths(2);
          const allPaths = [...new Set([...mentioned, ...recent])].slice(0, 4);
          if (allPaths.length) {
            const block = this.memory.delivery.block(
              { action: "read", paths: allPaths },
              { visible: (id) => this.isVisible(id) || shown.some((s) => s.ref.node.id === id), turnTokensLeft: Math.max(0, this.cfg.paths.perTurnTokens - this.turnPathTokens) },
            );
            if (block) {
              paths = block.text;
              pathShown = block.shown;
              this.turnPathTokens += block.tokens;
            }
          }
        } catch (e) {
          this.telemetry?.event("proactive.failed", { error: errMsg(e) });
        }
      }
      for (const s of shown) {
        deliveries.push({ id: `m:${s.ref.node.id}`, kind: "card", channel: "proactive", nodeIds: [s.ref.node.id], scope: s.ref.scope, text: s.full ? s.ref.node.text : s.ref.node.title, signature: s.ref.node.signature, full: s.full });
      }
      for (const s of pathShown) {
        deliveries.push({ id: `m:${s.ref.node.id}`, kind: "card", channel: "path", nodeIds: [s.ref.node.id], scope: s.ref.scope, text: s.full ? s.ref.node.text : s.ref.node.title, signature: s.ref.node.signature, full: s.full });
      }
    }

    this.stackVersion++;
    this.cancelDriftCheck();
    const innermost = this.state.innermost();
    if (innermost) this.lastReminderRound.set(innermost.id, this.round);
    else this.lastEmptyReminderRound = this.round;
    this.telemetry?.step({ kind: "intent.tool", action: input.action, closures: closedNow.length, opened: !!opened, updated: false, cards: deliveries.filter((d) => d.channel === "proactive").length });
    return { ok: true, action: input.action, closed: closedNow, opened, updated: null, stack: this.state.stack, cards, paths, deliveries };
  }

  /** The first entry a deferred intent governs, if the transcript has it. */
  private entryAfter(s: KindleStart): string | undefined {
    let i = s.afterId ? this.index.get(s.afterId) : -1;
    if (i === undefined) return undefined;
    i++;
    if (s.skipUser && this.entries[i]?.kind === "user") i++;
    return this.entries[i]?.id;
  }

  /**
   * Proactive retrieval for a newly opened intent (§6.4.1). With a decision model the gate answers
   * within its own timeout. An aux-emulated gate takes seconds: the tool waits at most `waitMs`,
   * and cards that miss it follow at the next commit point.
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

  /** Cards that arrived after their intent opened: one guidance message per intent that is still open. */
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

  /** A compact periodic `[intent]` marker every `janus.remindEvery` rounds (§5.2). */
  private reminder(): GuidanceMessage | null {
    const every = this.cfg.janus.remindEvery;
    if (every <= 0) return null;
    const intent = this.state.innermost();
    if (!intent) {
      if (this.round <= 0 || this.round - this.lastEmptyReminderRound < every) return null;
      this.lastEmptyReminderRound = this.round;
      return { customType: GUIDANCE_TYPE, content: renderEmptyReminder(this.round, this.intentToolName()), display: false, details: { reminder: "empty" } };
    }
    const since = intent.guidanceEntryId && this.index.has(intent.guidanceEntryId) ? Janus.roundsSince(intent, this.entries, this.units) : Math.max(0, this.round - intent.openedRound);
    const last = this.lastReminderRound.get(intent.id) ?? intent.openedRound;
    if (since < every || this.round - last < every) return null;
    this.lastReminderRound.set(intent.id, this.round);
    const parent = intent.parentId ? this.state.intents.get(intent.parentId)?.label : undefined;
    return { customType: GUIDANCE_TYPE, content: renderReminder(intent, parent, this.intentToolName()), display: false, details: { reminder: intent.id } };
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
   * resolves mentioned paths immediately without blocking on the decision model, delivers any
   * ready drift reminder from the prior break, and schedules a debounced advisory drift check.
   */
  async onUserMessage(text: string, _signal?: AbortSignal, _opts?: { inTranscript?: number }): Promise<CommitBatch> {
    await this.refresh();
    this.turnPathTokens = 0;
    this.gatedThisTurn.clear();
    this.shownThisTurn.clear();
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
    const drift = !this.light && this.contextEnabled() ? this.takeDriftReminder() : null;
    let msg: GuidanceMessage | null = null;
    if (drift && mention) {
      const key = randomId8();
      msg = this.guidance(`${drift.content}\n\n${mention}`, { ...(drift.details ?? {}), key });
      this.deliverShown(mentionShown, "path", { guidanceKey: key });
    } else if (drift) {
      msg = drift;
    } else if (mention) {
      const key = randomId8();
      msg = this.guidance(mention, { key });
      this.deliverShown(mentionShown, "path", { guidanceKey: key });
    }
    if (msg) batch.messages.push(msg);
    if (!this.light && this.contextEnabled() && text) {
      this.scheduleDriftCheck({ userMessage: text });
    }
    this.savedThisStep = 0;
    if (this.contextEnabled()) {
      // Idle ended when the user acted: any settle-deferred Precip that has not started or was
      // aborted during idle is now eligible to run in the background on this turn.
      for (const job of this.precipJobs) job.deferred = false;
      this.startPrecipJobs(false);
    }
    await this.palim.refreshOccupancy();
    const taken = this.take();
    batch.records.push(...taken.records);
    batch.edits.push(...taken.edits);
    return batch;
  }

  /**
   * `tool_call` / `PreToolUse`: run the pre-edit gate, and delay any pending advisory drift
   * debounce while the agent is actively invoking tools (unless prefire hits `maxInputTokens`).
   */
  async onToolCall(call: ToolCallInfo): Promise<{ block: string } | null> {
    if (!call.nested && !call.subagent && !call.own && !this.light && this.contextEnabled()) {
      this.scheduleDriftCheck({ onlyIfCountingDown: true });
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

  /**
   * `tool_result` / `PostToolUse`: record deliveries, track moves and writes, append the path
   * memories for what was touched, archive an oversized output, and prefire advisory Janus if
   * unchecked evidence hits `maxInputTokens` while a debounce is counting down.
   */
  async onToolResult(res: ToolResultInfo): Promise<{ text: string; block?: string; body?: string } | null> {
    const where = { toolCallId: res.toolCallId, subagent: res.subagent };
    // deliveries reported by search, recall, inspect and intent (top-level calls only create transcript entries)
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
    if (!res.nested && !res.subagent && !res.own && !this.light && this.contextEnabled() && this.janusTimer !== null) {
      // Mid-turn prefire check: if this result pushes unchecked evidence over maxInputTokens while
      // the debounce timer is counting down, fire immediately once so info is not truncated.
      const extra = estimateTokens(headTail(text, 300, 300));
      this.scheduleDriftCheck({ extraTokens: extra, onlyIfCountingDown: true });
    }
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
   * Never blocks on Janus: emits any ready drift reminder or periodic `[intent]` marker, schedules
   * (or prefires) the debounced advisory drift check, commits finished consolidations, starts new
   * ones, and relieves pressure before the next request.
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
        const drift = this.takeDriftReminder();
        if (drift) batch.messages.push(drift);
        else {
          const r = this.reminder();
          if (r) batch.messages.push(r);
        }
        batch.messages.push(...this.takeLateCards());
        this.scheduleDriftCheck();
      } else {
        this.clearDriftTimer();
        this.pendingDrift = null;
        this.lateCards = [];
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
        } else {
          this.palim.shadow();
          await this.palim.refreshOccupancy();
        }
      } else {
        await this.palim.refreshOccupancy();
      }
    } else {
      await this.palim.refreshOccupancy();
    }
    this.indexTurns();
    this.flushStats(false);
    const taken = this.take();
    batch.records.push(...taken.records);
    batch.edits.push(...taken.edits);
    this.memory?.accounting.turn();
    return batch;
  }

  /** `agent_before_settle` / `Stop`: commit ready consolidations and let debounced drift check run on break. */
  async onBeforeSettle(_signal?: AbortSignal): Promise<CommitBatch> {
    await this.refresh();
    this.savedThisStep = 0;
    const batch = emptyBatch();
    if (!this.contextEnabled()) {
      await this.palim.refreshOccupancy();
      return batch;
    }
    if (!this.light) {
      batch.messages.push(...this.takeLateCards());
      this.scheduleDriftCheck();
    }
    this.commitReady();
    this.flushStats(false);
    await this.palim.refreshOccupancy();
    const taken = this.take();
    batch.records.push(...taken.records);
    batch.edits.push(...taken.edits);
    return batch;
  }

  /** Refresh cached occupancy from the harness's current projection (e.g. after boundary drafts commit). */
  async refreshOccupancy(): Promise<void> {
    this.savedThisStep = 0;
    await this.palim.refreshOccupancy();
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
   * (1) a finished Precip (e.g. completed during idle) is ready, (2) the request would go out
   * above capacity and folds are ready, or (3) the provider cache is cold and a cost-deferred
   * fold is ready. They are persisted at the next commit point.
   */
  async onContext(): Promise<ContextEdit[] | null> {
    if (this.light || this.level === 0 || !this.contextEnabled()) return null;
    const now = this.clock().getTime();
    const lastWrite = Math.max(this.lastRequestAt, this.adapter.lastCacheWriteAt?.() ?? 0);
    const cold = lastWrite > 0 && now - lastWrite >= effectiveCacheTtlSeconds(this.cfg, this.adapter.modelName()) * 1000;
    this.lastRequestAt = now;
    const readyPrecip = this.precipJobs.filter((j) => j.done && j.plan);
    const readyFolds = [...this.palim.jobs.values()].filter((j) => j.done && j.plan);
    let pickFolds: typeof readyFolds = [];
    if (readyFolds.length) {
      const tokens = await this.adapter.requestTokens();
      const over = tokens !== null && tokens > this.window();
      pickFolds = readyFolds.filter((j) => (cold && j.kind === "cold") || (over && j.kind !== "cold"));
    }
    if (!this.appliedNow.length && !readyPrecip.length && !pickFolds.length) return null;
    await this.refresh();
    const edits: ContextEdit[] = [];
    // Re-apply plans already applied on an earlier `context` call of this turn (e.g. retries).
    for (const plan of this.appliedNow) {
      this.applyLocal(plan);
      edits.push(...plan.edits);
    }
    if (readyPrecip.length) {
      const readySet = new Set(readyPrecip);
      this.precipJobs = this.precipJobs.filter((j) => !readySet.has(j));
      for (const job of readyPrecip) {
        const plan = job.plan!;
        const problem = this.invariants(plan, true);
        job.committed = true;
        if (problem) {
          this.telemetry?.event("consolidation.dropped", { kind: plan.record.kind, problem });
          this.problems.push(`${plan.record.id}: ${problem}`);
          if (this.problems.length > 50) this.problems.shift();
          continue;
        }
        edits.push(...plan.edits);
        this.appliedNow.push(plan);
        this.applyLocal(plan);
      }
    }
    for (const job of pickFolds.sort((a, b) => a.level - b.level)) {
      const plan = job.plan!;
      this.palim.jobs.delete(job.key);
      if (this.invariants(plan, false)) continue;
      edits.push(...plan.edits);
      this.appliedNow.push(plan);
      this.applyLocal(plan);
    }
    if (!edits.length) return null;
    this.savedThisStep = this.appliedNow.reduce((s, p) => s + (p.record.shadow ? 0 : Math.max(0, p.record.tokensBefore - p.record.tokensAfter)), 0);
    await this.palim.refreshOccupancy();
    return edits;
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
  async onShutdown(opts: { reload?: boolean; persistEdits?: boolean } = {}): Promise<CommitBatch> {
    this.clearDriftTimer();
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
    this.commitReady({ allowEdits: opts.persistEdits !== false });
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
            job.deferred = false;
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
            job.deferred = false;
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
    }
    // Always update the local projection (onTurnEnd refreshed raw entries before commitReady, so
    // plans already applied in `context` need their local edits re-applied for Palim planning).
    this.applyLocal(plan);
    // Plans already applied in `context` were already reflected in the turn's provider usage, so
    // only newly committed plans contribute to `savedThisStep`.
    if (!plan.record.shadow && !opts.applied) this.savedThisStep += Math.max(0, plan.record.tokensBefore - plan.record.tokensAfter);
    this.pending.records.push({ type: "realctx2.consolidation", record: plan.record });
    this.pending.edits.push(...plan.edits);
    this.memory?.turns?.addConsolidation({ id: plan.record.id, session: this.sessionId, harness: this.adapter.harness, kind: plan.record.kind, at: plan.record.createdAt, text: plan.text });
    this.telemetry?.step({ kind: plan.record.kind, id: plan.record.id, before: plan.record.tokensBefore, after: plan.record.tokensAfter });
    if (plan.record.kind === "precip") this.harvester.handOffEpisode(plan.record);
    else this.harvester.harvest(plan.record);
    return true;
  }

  /** Commit every finished consolidation together, so the prompt cache breaks at most once per step. */
  private commitReady(opts: { allowEdits?: boolean } = {}): void {
    // When the harness cannot persist context_edit entries (e.g. pi `session_shutdown`), keep the
    // consolidation as a shadow record so episodes/knowledge still harvest without claiming edits
    // that never landed in the transcript.
    const normalize = (plan: ReplacePlan): ReplacePlan =>
      opts.allowEdits === false && !plan.record.shadow && plan.edits.length > 0
        ? { ...plan, record: { ...plan.record, shadow: true }, edits: [] }
        : plan;
    for (const plan of this.appliedNow.splice(0)) this.commitPlan(normalize(plan), { allowTail: false, applied: true });
    const doneJobs = this.precipJobs.filter((j) => j.done);
    this.precipJobs = this.precipJobs.filter((j) => !j.done);
    for (const job of doneJobs) {
      if (job.plan) this.commitPlan(normalize(job.plan), { allowTail: true });
      job.committed = true;
    }
    const folds = this.palim.jobs;
    for (const job of [...folds.values()]) {
      if (!job.done || job.kind !== "ordinary") continue;
      folds.delete(job.key);
      if (job.plan) this.commitPlan(normalize(job.plan), { allowTail: false });
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

  status(): { round: number; requests: number; stack: Intent[]; records: number; deliveries: number; attributed: number; frontier: number; janusLate: number; driftReminders: number; foldsSkippedByCost: number; occupancy: number; predictedOccupancy: number; window: number; disabled: boolean; cacheTtlSeconds: number; jobs: { precip: number; folds: number }; problems: string[] } {
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
      driftReminders: this.state.stats.driftReminders ?? 0,
      foldsSkippedByCost: this.state.stats.foldsSkippedByCost,
      occupancy: Math.round(this.palim.lastContextTokens),
      predictedOccupancy: Math.round(this.palim.lastOccupancy),
      window,
      disabled: !this.contextEnabled(),
      cacheTtlSeconds: effectiveCacheTtlSeconds(this.cfg, this.adapter.modelName()),
      jobs: { precip: this.precipJobs.length, folds: this.palim.jobs.size },
      problems: this.problems.slice(-10),
    };
  }
}
