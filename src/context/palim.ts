/**
 * Palim (§5.4): folds stable prefixes of the context into first-person summaries. Ordinary mode
 * climbs a frontier through the intent regions and folds what pays for itself; pressure mode
 * sweeps when the request would pass ρ·W; append-only harnesses get a shadow fold for harvest
 * and the post-compaction injection. The context engine owns the projection and commits plans;
 * Palim plans folds and keeps the jobs that produce them.
 */
import type { Config, scaledContext } from "../core/config.ts";
import type { Telemetry } from "../core/telemetry.ts";
import type { ConsolidationRecord, EntryView, HarnessAdapter, Intent, KnowledgeItem } from "../core/types.ts";
import { estimateTokens, quantile, sha256 } from "../util/text.ts";
import { type Consolidator, planReplace, renderForAux, type ReplacePlan, spanFingerprint } from "./consolidate.ts";
import { Janus } from "./janus.ts";
import { renderPalim } from "./render.ts";
import { alignToUnits, roundCount, roundsBefore, sumTokens, type Unit, workingTail } from "./rounds.ts";
import type { Region, SessionState } from "./state.ts";

export interface FoldJob {
  key: string;
  level: number;
  kind: "ordinary" | "prepared" | "cold";
  promise: Promise<ReplacePlan | null>;
  plan: ReplacePlan | null;
  done: boolean;
  startedRound: number;
}

interface FoldSpan {
  level: number;
  from: number;
  to: number;
  tokens: number;
  consolidated: number;
  intent: Intent | null;
}

/**
 * What Palim reads from the engine that owns it, and does through it. Accessors are called on
 * every use: committing a plan replaces the engine's entries and units.
 */
export interface PalimHost {
  readonly cfg: Config;
  readonly adapter: HarnessAdapter;
  readonly consolidator: Consolidator;
  readonly telemetry?: Telemetry;
  entries(): EntryView[];
  units(): Unit[];
  state(): SessionState;
  round(): number;
  window(): number;
  scaled(): ReturnType<typeof scaledContext>;
  now(): string;
  /** R̂, the requests the session is still expected to make (§5.4.2). */
  expectedRequests(): number;
  /** Janus's latest closure probability for an intent. */
  closeProb(intentId: string): number;
  /** Tokens saved by edits queued in this step, which the harness's request size does not reflect yet. */
  savedThisStep(): number;
  /** The round statistics changed and need persisting. */
  statsChanged(): void;
  /** Register background work, so shutdown and tests can wait for it. */
  track<T>(p: Promise<T>): Promise<T>;
  /** Check a plan's invariants and queue it for the next commit point; false when it was dropped. */
  commitPlan(plan: ReplacePlan, opts: { allowTail: boolean; minimalTail?: boolean }): boolean;
}

export class Palim {
  /** Fold plans in progress or ready, by span key. */
  readonly jobs = new Map<string, FoldJob>();
  private readonly host: PalimHost;
  private readonly cfg: Config;
  private readonly adapter: HarnessAdapter;
  private readonly consolidator: Consolidator;
  private readonly telemetry?: Telemetry;
  private occupancyNow = 0;
  private contextTokensNow = 0;
  private exhaustedNotifiedAt = -1;

  constructor(host: PalimHost) {
    this.host = host;
    this.cfg = host.cfg;
    this.adapter = host.adapter;
    this.consolidator = host.consolidator;
    this.telemetry = host.telemetry;
  }

  /** P, the predicted next-request occupancy (current context + Q_q headroom) at the last check. */
  get lastOccupancy(): number {
    return this.occupancyNow;
  }

  /** Current context size (without next-round Q_q headroom) at the last check. */
  get lastContextTokens(): number {
    return this.contextTokensNow;
  }

  /** Plans made against another branch are void (`rebuild`). */
  reset(): void {
    this.jobs.clear();
    this.occupancyNow = 0;
    this.contextTokensNow = 0;
    this.exhaustedNotifiedAt = -1;
  }

  private get entries(): EntryView[] {
    return this.host.entries();
  }
  private get units(): Unit[] {
    return this.host.units();
  }
  private get state(): SessionState {
    return this.host.state();
  }
  private get round(): number {
    return this.host.round();
  }
  private window(): number {
    return this.host.window();
  }
  private scaled(): ReturnType<typeof scaledContext> {
    return this.host.scaled();
  }
  private now(): string {
    return this.host.now();
  }
  private track<T>(p: Promise<T>): Promise<T> {
    return this.host.track(p);
  }
  private commitPlan(plan: ReplacePlan, opts: { allowTail: boolean; minimalTail?: boolean }): boolean {
    return this.host.commitPlan(plan, opts);
  }

  // ───────────── ordinary mode (§5.4.2)
  private entriesTokens(): number {
    return this.entries.reduce((s, e) => s + (e.omitted ? 0 : e.tokens), 0);
  }

  /**
   * Current context size, accounting for edits queued in this step that the harness's
   * `requestTokens()` does not reflect yet. Scales remaining entry tokens by the pre-edit
   * entry tokenization ratio so estimation error on omitted entries does not linger.
   */
  private baseTokens(req: number | null): number {
    const after = this.entriesTokens();
    const saved = this.host.savedThisStep();
    if (req === null) return after;
    if (saved <= 0) return req;
    const before = after + saved;
    if (before <= 0) return Math.max(0, req - saved);
    const sys = this.adapter.systemPromptTokens?.();
    if (typeof sys === "number" && Number.isFinite(sys) && sys >= 0) {
      const cappedSys = Math.min(sys, req);
      const ratio = (req - cappedSys) / before;
      return cappedSys + after * ratio;
    }
    return req * (after / before);
  }

  private predicted(base: number): number {
    const q = this.state.stats.roundTokens.length ? quantile(this.state.stats.roundTokens, this.cfg.context.q) : 0;
    return base + q;
  }

  /** Refresh current context tokens and predicted occupancy P without running a pressure sweep. */
  async refreshOccupancy(): Promise<void> {
    let req: number | null = null;
    try {
      req = await this.adapter.requestTokens();
    } catch {
      req = null;
    }
    const base = this.baseTokens(req);
    this.contextTokensNow = base;
    this.occupancyNow = this.predicted(base);
  }

  private fast(): boolean {
    return this.occupancyNow > this.cfg.context.climb.fastOccupancy * this.window();
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
  climb(): void {
    const c = this.cfg.context.climb;
    if (!c.enabled) return;
    const regions = this.state.regions(this.entries);
    const depth = regions.length - 1;
    const f = Math.min(this.state.stats.frontier ?? 0, depth);
    if (f !== this.state.stats.frontier) {
      this.state.stats.frontier = f;
      this.host.statsChanged();
    }
    if (f >= depth) return;
    const every = Math.max(1, Math.round(c.roundsPerLevel / (this.fast() ? c.fastFactor : 1)));
    if (this.round - (this.state.stats.lastClimbRound ?? 0) < every) return;
    if (!this.stable(regions[f + 1]!, depth)) return;
    this.state.stats.frontier = f + 1;
    this.state.stats.lastClimbRound = this.round;
    this.host.statsChanged();
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
    const R = this.host.expectedRequests();
    if (cold) return saving * (pWrite + pRead * (R - 1)) >= cFold;
    const suffix = sumTokens(this.entries, span.to, this.entries.length);
    return saving * pRead * R >= suffix * (pWrite - pRead) + cFold;
  }

  private dueSpans(): Array<{ span: FoldSpan; passes: boolean; coldOnly: boolean }> {
    const s = this.scaled();
    const c = this.cfg.context.climb;
    const regions = this.state.regions(this.entries);
    const depth = regions.length - 1;
    const tail = workingTail(this.entries, this.units, this.cfg, this.window(), this.state.stats.roundTokens, { modelName: this.adapter.modelName() });
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
      if (region.intent && this.host.closeProb(region.intent.id) >= c.skipCloseProb) continue;
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
  carried(from: number, to: number): KnowledgeItem[] {
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
    const have = this.jobs.get(key);
    if (have) return have;
    // one fold per level at a time
    for (const j of this.jobs.values()) if (j.level === span.level && !j.done) return null;
    const job: FoldJob = { key, level: span.level, kind, promise: Promise.resolve(null), plan: null, done: false, startedRound: this.round };
    job.promise = this.track(this.generateFold(span, { pressure: kind === "prepared", signal })).then(
      (plan) => {
        job.plan = plan;
        job.done = true;
        if (!plan) this.jobs.delete(key);
        return plan;
      },
      () => {
        job.done = true;
        this.jobs.delete(key);
        return null;
      },
    );
    this.jobs.set(key, job);
    return job;
  }

  startOrdinaryFolds(): void {
    for (const d of this.dueSpans()) {
      if (d.passes) this.startFold(d.span, "ordinary");
      else {
        this.state.stats.foldsSkippedByCost++;
        this.host.statsChanged();
      }
    }
  }

  /** Folds that fail the warm-cache check but pay off on a cold cache are prepared during idle time. */
  prepareColdFolds(signal?: AbortSignal): void {
    for (const d of this.dueSpans()) if (d.coldOnly) this.startFold(d.span, "cold", signal);
  }

  // ───────────── pressure mode (§5.4.3)
  private sweepSpans(minimalTail: boolean): FoldSpan[] {
    const tail = workingTail(this.entries, this.units, this.cfg, this.window(), this.state.stats.roundTokens, { minimal: minimalTail, modelName: this.adapter.modelName() });
    const out: FoldSpan[] = [];
    // root prefix, then open-intent regions from outermost to innermost
    for (const region of this.state.regions(this.entries)) {
      const span = this.foldSpan(region, tail.start);
      if (span && sumTokens(this.entries, span.from, span.to) > this.scaled().deltaMin) out.push(span);
    }
    return out;
  }

  async pressure(signal?: AbortSignal): Promise<void> {
    const W = this.window();
    const rho = this.cfg.context.rho * W;
    const measure = async () => {
      const req = await this.adapter.requestTokens();
      const base = this.baseTokens(req);
      this.contextTokensNow = base;
      return this.predicted(base);
    };
    let P = await measure();
    this.occupancyNow = P;
    if (P <= rho) {
      // preparing ahead: work out the folds the sweep would make, without committing them
      if (P > this.cfg.context.prepareFraction * W) for (const span of this.sweepSpans(false).slice(0, 2)) this.startFold(span, "prepared");
      return;
    }
    this.telemetry?.event("pressure", { P, W });
    // ready folds commit at once, so the request does not wait for an aux session
    for (const job of [...this.jobs.values()].sort((a, b) => a.level - b.level)) {
      if (!job.done || !job.plan) continue;
      this.jobs.delete(job.key);
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
          const pending = this.jobs.get(this.foldKey(span));
          const plan = pending && !pending.done ? await pending.promise : await this.generateFold(span, { pressure: true, signal });
          if (pending) this.jobs.delete(pending.key);
          if (!plan) continue;
          if (this.commitPlan(plan, { allowTail: false, minimalTail: minimal })) {
            progress = true;
            P = await measure();
          }
        }
      }
    }
    this.occupancyNow = P;
    if (P > W && this.exhaustedNotifiedAt !== this.round) {
      // capacity exhaustion: report it before the request goes out; never truncate silently
      this.exhaustedNotifiedAt = this.round;
      this.adapter.notify(`realctx2: the context is at capacity (${Math.round(P)} of ${W} tokens) and nothing more can be consolidated. Consider /compact or starting a new session.`, "warning");
      this.telemetry?.event("capacity.exhausted", { P, W });
    }
  }

  // ───────────── append-only harnesses: shadow Palim (§4.6.3)
  /** No in-place fold: knowledge is produced incrementally, for harvest and the post-compaction injection. */
  shadow(): void {
    const s = this.scaled();
    const open = [...this.state.records.values()].filter((r) => r.kind === "precip" && r.text && !this.state.parentOf(r.id));
    const tokens = open.reduce((n, r) => n + r.tokensBefore, 0);
    if (open.length < this.cfg.context.Emin || tokens < s.Tmin) return;
    const key = `shadow:${open.map((r) => r.id).join(",")}`;
    if (this.jobs.has(key)) return;
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
    this.jobs.set(key, job);
  }
}
