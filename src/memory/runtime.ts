/**
 * The memory engine as one object: every component of §6 wired together, plus the session
 * registry, the work queue and the model-dependent maintenance loop (§6.6.8).
 */
import { join } from "node:path";
import type { Config, Layout } from "../core/config.ts";
import { machineActorId, type ProjectInfo, resolveProject } from "../core/project.ts";
import type { Telemetry } from "../core/telemetry.ts";
import type { AuxSessionRunner, Clock, DecisionClient, EmbeddingClient, ScopeName } from "../core/types.ts";
import { TurnIndex } from "../storage/turnindex.ts";
import { appendJsonl, ensureDir, listFiles, readJson, removeDir, removeFile, tryLock, writeJson } from "../util/fs.ts";
import { median } from "../util/text.ts";
import { SessionAccounting } from "./accounting.ts";
import { PathDelivery } from "./delivery.ts";
import { Evolution, FEATURE_DIM, type PassReport, QueryCaches } from "./evolution.ts";
import { MemoryGraph } from "./graph.ts";
import { Instructions } from "./instructions.ts";
import { Lifecycle } from "./lifecycle.ts";
import { PathTracker, type ReconcileReport } from "./paths.ts";
import { EvolutionLog, Policy } from "./policy.ts";
import { Retriever, ThoroughSearch } from "./retrieve.ts";
import { Reverifier, type ReverifyReport, ReviewQueue } from "./reverify.ts";
import type { MemoryServices } from "./services.ts";
import { Similarity } from "./similarity.ts";
import { MemoryWriter } from "./write.ts";

export interface RuntimeOptions {
  layout: Layout;
  cfg: Config;
  cwd: string;
  trusted: boolean;
  decision: DecisionClient;
  aux: AuxSessionRunner | null;
  late?: EmbeddingClient<"multivector"> | null;
  dense?: EmbeddingClient<"dense"> | null;
  telemetry?: Telemetry;
  clock?: Clock;
  sessionId?: string;
  harness: "pi" | "claude-code" | "test" | "worker";
  readOnly?: boolean;
  random?: () => number;
  project?: ProjectInfo;
}

export interface SessionEntry {
  id: string;
  harness: string;
  /** pi session file, or Claude Code's transcript path. */
  file?: string;
  startedAt: string;
  endedAt?: string;
  requests?: number;
}

export interface QueuedJob {
  id: string;
  kind: "idle-harvest" | "reslice-imports" | "auto-memory-import" | "reverify" | "maintain";
  projectKey: string | null;
  cwd: string;
  sessionId?: string;
  sessionFile?: string;
  harness?: string;
  at: string;
  data?: Record<string, unknown>;
}

export interface IdleReport {
  embedded: number;
  calibrated: boolean;
  reverify: ReverifyReport | null;
  resliced: number;
  autoMemory: { files: number; items: number } | null;
  passes: PassReport[];
  stopped?: string;
}

export class MemoryRuntime implements MemoryServices {
  readonly cfg: Config;
  readonly layout: Layout;
  readonly project: ProjectInfo;
  readonly graph: MemoryGraph;
  readonly sim: Similarity;
  readonly paths: PathTracker;
  readonly decision: DecisionClient;
  aux: AuxSessionRunner | null;
  readonly turns: TurnIndex | null;
  readonly accounting: SessionAccounting;
  readonly telemetry?: Telemetry;
  readonly clock: Clock;
  sessionId?: string;
  readonly actorId: string;
  readonly harness: RuntimeOptions["harness"];

  readonly writer: MemoryWriter;
  readonly retriever: Retriever;
  readonly thorough: ThoroughSearch;
  readonly lifecycle: Lifecycle;
  readonly delivery: PathDelivery;
  readonly instructions: Instructions;
  readonly review: ReviewQueue;
  readonly reverifier: Reverifier;
  readonly caches: QueryCaches;
  readonly evoLog: EvolutionLog;
  readonly policy: Policy | null;
  readonly evolution: Evolution;
  lastReconcile: ReconcileReport | null = null;
  lastIdle: IdleReport | null = null;
  /** Files an aux session changed although it should not have (change watch, §9.3.2). */
  readonly auxChanges: Array<{ at: string; role: string; files: string[] }> = [];
  /** Aux tool calls the guard refused (§9.3.2). */
  readonly auxBlocked: Array<{ at: string; role: string; call: string; reason: string }> = [];
  private closed = false;
  private lastPeriodicFlush = 0;

  constructor(o: RuntimeOptions) {
    this.cfg = o.cfg;
    this.layout = o.layout;
    this.clock = o.clock ?? (() => new Date());
    this.telemetry = o.telemetry;
    this.decision = o.decision;
    this.aux = o.aux;
    this.sessionId = o.sessionId;
    this.harness = o.harness;
    this.project = o.project ?? resolveProject(o.cwd);
    this.lastPeriodicFlush = this.clock().getTime();
    this.actorId = machineActorId(o.layout);
    this.graph = MemoryGraph.open({ layout: o.layout, cfg: o.cfg, project: this.project, trusted: o.trusted, actorId: this.actorId, clock: this.clock, telemetry: o.telemetry, readOnly: o.readOnly });
    this.sim = new Similarity({ cfg: o.cfg, layout: o.layout, late: o.late ?? null, dense: o.dense ?? null, telemetry: o.telemetry, clock: this.clock, random: o.random });
    this.paths = new PathTracker(this.graph);
    let turns: TurnIndex | null = null;
    if (this.project.projectKey && o.cfg.privacy.indexSessions !== "off") {
      try {
        turns = new TurnIndex(o.layout.turnIndexFile(this.project.projectKey), { fdeDims: o.cfg.index.lateInteraction.fdeDims, fdeQuant: o.cfg.index.lateInteraction.fdeQuant });
      } catch (e) {
        o.telemetry?.event("turnindex.open_failed", { error: String((e as Error).message) });
      }
    }
    this.turns = turns;
    this.accounting = new SessionAccounting(this.clock);
    this.writer = new MemoryWriter(this);
    this.retriever = new Retriever(this);
    this.thorough = new ThoroughSearch(this, this.retriever);
    this.lifecycle = new Lifecycle(this);
    this.delivery = new PathDelivery(this);
    this.instructions = new Instructions(this, this.writer);
    this.review = new ReviewQueue(o.layout.queueDir);
    this.reverifier = new Reverifier(this, { writer: this.writer, lifecycle: this.lifecycle, review: this.review });
    this.caches = new QueryCaches(o.layout.globalDir, this.project.projectKey ? o.layout.projectDir(this.project.projectKey) : null);
    this.evoLog = new EvolutionLog(o.layout.evolutionDir);
    this.policy = o.cfg.evolution.policy === "mlp" ? new Policy(o.layout.evolutionDir, FEATURE_DIM, o.random) : null;
    this.evolution = new Evolution(this, { retriever: this.retriever, writer: this.writer, lifecycle: this.lifecycle, caches: this.caches, log: this.evoLog, policy: this.policy, random: o.random });
  }

  // ───────────── session registry (§5.6): sessions started with realctx2 enabled
  private get sessionsFile(): string | null {
    return this.project.projectKey ? join(this.layout.projectDir(this.project.projectKey), "sessions.json") : null;
  }

  sessions(): SessionEntry[] {
    const f = this.sessionsFile;
    return f ? readJson<SessionEntry[]>(f, []) : [];
  }

  registerSession(entry: SessionEntry): void {
    const f = this.sessionsFile;
    if (!f) return;
    const all = this.sessions().filter((s) => s.id !== entry.id);
    const prev = this.sessions().find((s) => s.id === entry.id);
    all.push({ ...prev, ...entry, startedAt: prev?.startedAt ?? entry.startedAt });
    writeJson(f, all.slice(-500));
  }

  /**
   * Sessions whose transcript files are gone: their turn-index rows, session logs and stored
   * outputs are dropped (§4.6.6, §6.6.8). Sessions without a known file are kept, and so are
   * sessions that may still be running: a harness writes the file only once there is something
   * to save.
   */
  dropGoneSessions(exists: (file: string) => boolean): string[] {
    const f = this.sessionsFile;
    if (!f) return [];
    const all = this.sessions();
    const dayAgo = this.clock().getTime() - 86_400_000;
    const over = (s: SessionEntry) => !!s.endedAt || !(Date.parse(s.startedAt) > dayAgo);
    const gone = all.filter((s) => s.file && s.id !== this.sessionId && over(s) && !exists(s.file));
    if (!gone.length) return [];
    for (const s of gone) {
      try {
        this.turns?.removeSession(s.id);
        removeDir(this.layout.sessionDir(s.id));
      } catch (e) {
        this.telemetry?.event("sessions.drop_failed", { error: String((e as Error).message) });
      }
    }
    writeJson(f, all.filter((s) => !gone.includes(s)));
    return gone.map((s) => s.id);
  }

  endSession(id: string, requests: number): void {
    const f = this.sessionsFile;
    if (!f) return;
    const all = this.sessions();
    const s = all.find((x) => x.id === id);
    if (!s) return;
    s.endedAt = this.clock().toISOString();
    s.requests = Math.max(s.requests ?? 0, requests);
    writeJson(f, all);
  }

  /**
   * R̂ for the fold cost check (§5.4.2): the median remaining length of this project's recent
   * sessions, at least 10, or 20 without history.
   */
  expectedRequests(soFar: number): number {
    const fixed = this.cfg.context.climb.expectedRequests;
    if (typeof fixed === "number") return Math.max(1, fixed);
    const lengths = this.sessions().filter((s) => s.id !== this.sessionId && typeof s.requests === "number" && s.requests > 0).slice(-20).map((s) => s.requests!);
    if (lengths.length < 3) return 20;
    const remaining = lengths.filter((n) => n > soFar).map((n) => n - soFar);
    return Math.max(10, remaining.length ? Math.round(median(remaining)) : 10);
  }

  // ───────────── work queue (§6.6.8): model-dependent work left for the next session
  enqueue(job: Omit<QueuedJob, "id" | "at" | "projectKey" | "cwd">): void {
    try {
      ensureDir(this.layout.queueDir);
      const id = `${this.clock().getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      writeJson(join(this.layout.queueDir, `job-${id}.json`), { ...job, id, at: this.clock().toISOString(), projectKey: this.project.projectKey, cwd: this.project.cwd } satisfies QueuedJob);
    } catch {
      // queued work is best effort
    }
  }

  /** Jobs this session can run: its own project's, or project-less ones. */
  queued(): QueuedJob[] {
    return listFiles(this.layout.queueDir, ".json")
      .filter((f) => f.startsWith("job-"))
      .map((f) => readJson<QueuedJob | null>(join(this.layout.queueDir, f), null))
      .filter((j): j is QueuedJob => j !== null && (j.projectKey === null || j.projectKey === this.project.projectKey));
  }

  dequeue(job: QueuedJob): void {
    removeFile(join(this.layout.queueDir, `job-${job.id}.json`));
  }

  // ───────────── start-up work
  /** Session start (§4.2): reconcile uncertain paths and pick up files written elsewhere. */
  startSession(): void {
    try {
      this.graph.refresh();
      if (this.project.root) this.lastReconcile = this.paths.reconcile();
    } catch (e) {
      this.telemetry?.event("session.start_failed", { error: String((e as Error).message) });
    }
  }

  /** Embedding and calibration backlog; runs off the hot loop. */
  async warm(signal?: AbortSignal): Promise<{ embedded: number; calibrated: boolean }> {
    let calibrated = false;
    if (this.sim.needsCalibration()) calibrated = (await this.sim.calibrate()).ok;
    if (signal?.aborted) return { embedded: 0, calibrated };
    let embedded = await this.sim.embedNodes(this.graph, { signal });
    for (const scope of this.graph.visible()) await this.sim.embedPurposes(this.graph.handle(scope), signal);
    if (this.turns && !signal?.aborted) embedded += await this.sim.embedTurns(this.turns, { signal });
    return { embedded, calibrated };
  }

  /** The periodic flush of long sessions (§7.5): every `storage.flushMinutes`, checked at commit points. */
  flushIfDue(): number {
    const every = this.cfg.storage.flushMinutes * 60_000;
    if (!(every > 0)) return 0;
    const now = this.clock().getTime();
    if (now - this.lastPeriodicFlush < every) return 0;
    this.lastPeriodicFlush = now;
    try {
      return this.graph.flush({ keepPurges: true }).filter((r) => r.kind === "update" || r.kind === "snapshot").length;
    } catch (e) {
      this.telemetry?.event("flush.failed", { error: String((e as Error).message) });
      return 0;
    }
  }

  /** A kindled intent's purpose: remembered for importance (§6.5.2) and for the query cache (§6.6.5). */
  recordPurpose(id: string, text: string): void {
    const at = this.clock().toISOString();
    for (const scope of this.graph.visible()) this.graph.handle(scope).index?.addPurpose(id, text, at);
    this.caches.record(text, this.graph.visible());
  }

  // ───────────── model-dependent maintenance, in small abortable steps (§6.6.8)
  async idle(opts: { signal?: AbortSignal; force?: boolean; scopes?: ScopeName[] } = {}): Promise<IdleReport> {
    const report: IdleReport = { embedded: 0, calibrated: false, reverify: null, resliced: 0, autoMemory: null, passes: [] };
    const aborted = () => opts.signal?.aborted === true;
    const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
      if (aborted()) {
        report.stopped = "aborted";
        return null;
      }
      try {
        return await fn();
      } catch (e) {
        this.telemetry?.event("idle.step_failed", { step: name, error: String((e as Error).message) });
        return null;
      }
    };
    const warm = await step("warm", () => this.warm(opts.signal));
    if (warm) Object.assign(report, warm);
    report.reverify = await step("reverify", () => this.reverifier.run({ signal: opts.signal }));
    report.resliced = (await step("reslice", () => this.instructions.resliceImports(opts.signal))) ?? 0;
    for (const job of this.queued()) {
      if (aborted()) break;
      if (job.kind === "auto-memory-import" && this.harness === "claude-code") {
        report.autoMemory = await step("auto-memory", () => this.instructions.importAutoMemory(opts.signal));
        if (!aborted()) this.dequeue(job);
      } else if (job.kind === "reslice-imports" || job.kind === "reverify" || job.kind === "maintain") this.dequeue(job); // covered by the steps above and below
    }
    // one scope at a time; a scope another process is maintaining is skipped (one worker per scope)
    for (const scope of opts.scopes ?? this.graph.visible()) {
      if (aborted()) break;
      if (!this.graph.writable(scope)) continue;
      const storeId = this.graph.handle(scope).store.storeId;
      const lock = tryLock(this.layout.lockFile(`maintain-${storeId}`), 30 * 60_000);
      if (!lock) continue;
      try {
        const due = opts.force || this.maintenanceDue(scope);
        if (!due) continue;
        this.accounting.flush(this.graph, this.cfg);
        const pass = await step(`pass-${scope}`, () => this.evolution.pass(scope, { signal: opts.signal }));
        if (pass) {
          report.passes.push(pass);
          if (!pass.stopped) this.markMaintained(scope);
        }
      } finally {
        lock.release();
      }
    }
    if (aborted()) report.stopped = "aborted";
    this.lastIdle = report;
    return report;
  }

  private maintenanceDue(scope: ScopeName): boolean {
    const last = this.graph.handle(scope).index?.getMeta("maintain.lastAt");
    return !last || this.clock().getTime() - Date.parse(last) >= 6 * 3_600_000;
  }

  private markMaintained(scope: ScopeName): void {
    this.graph.handle(scope).index?.setMeta("maintain.lastAt", this.clock().toISOString());
  }

  /** Model-free maintenance (the detached worker's job, also `/realctx2 maintain`). */
  maintainModelFree(opts: { inSession?: boolean } = {}): { reconcile: ReconcileReport | null; hygiene: Array<ReturnType<Lifecycle["hygiene"]>>; compacted: string[]; flushed: number; staleAnchors: number } {
    const out = { reconcile: null as ReconcileReport | null, hygiene: [] as Array<ReturnType<Lifecycle["hygiene"]>>, compacted: [] as string[], flushed: 0, staleAnchors: 0 };
    this.graph.refresh();
    if (this.project.root) out.reconcile = this.paths.reconcile({ full: true });
    out.staleAnchors = this.paths.dropStaleAnchors();
    for (const scope of this.graph.visible()) {
      if (!this.graph.writable(scope)) continue;
      out.hygiene.push(this.lifecycle.hygiene(scope));
    }
    // inside a session, purges stay undoable until it ends (§7.10)
    out.flushed = this.graph.flush({ keepPurges: opts.inSession }).filter((r) => r.kind === "update" || r.kind === "snapshot").length;
    for (const scope of this.graph.visible()) {
      const store = this.graph.handle(scope).store;
      if (opts.inSession && store.pendingPurge.size) continue;
      try {
        const r = store.maybeCompact();
        if (r?.kind === "snapshot") {
          out.compacted.push(scope);
          this.graph.syncIndex(scope);
        }
      } catch (e) {
        this.telemetry?.event("compact.failed", { scope, error: String((e as Error).message) });
      }
    }
    if (this.turns) this.turns.evict(this.cfg.index.maxBytes);
    return out;
  }

  noteAuxBlocked(role: string, call: string, reason: string): void {
    this.auxBlocked.push({ at: this.clock().toISOString(), role, call: call.slice(0, 200), reason });
    if (this.auxBlocked.length > 50) this.auxBlocked.shift();
    this.telemetry?.event("aux.blocked", { role, reason });
  }

  noteAuxChanges(role: string, files: string[]): void {
    if (!files.length) return;
    this.auxChanges.push({ at: this.clock().toISOString(), role, files });
    if (this.layout) appendJsonl(join(this.layout.logsDir, "aux-changes.jsonl"), { at: this.clock().toISOString(), role, files });
  }

  /**
   * Session end (§4.2): flush the per-session counter aggregates, then write pending changes as
   * update files — shared ones included, without review.
   */
  shutdown(opts: { requests?: number } = {}): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.accounting.flush(this.graph, this.cfg);
    } catch (e) {
      this.telemetry?.event("accounting.flush_failed", { error: String((e as Error).message) });
    }
    if (this.sessionId) this.endSession(this.sessionId, opts.requests ?? 0);
    this.policy?.save();
    this.graph.close();
    this.turns?.close();
  }
}
