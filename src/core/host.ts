/**
 * One engine host per session (§3.1): configuration, providers, the memory runtime, the context
 * engine, the agent tools and the `/realctx2` command, wired for whichever harness adapter
 * opened it. Adapters translate harness events into calls on `host.engine` and `host.memory`.
 */
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildCommand } from "../commands/index.ts";
import { BlobStore } from "../context/archive.ts";
import { ContextEngine } from "../context/engine.ts";
import { MemoryRuntime, type QueuedJob, type SessionEntry } from "../memory/runtime.ts";
import type { Candidate } from "../memory/write.ts";
import { EmulatedDecisionClient, type FetchLike, HttpDecisionClient, ResilientDecisionClient } from "../providers/decision.ts";
import { createEmbeddingClients } from "../providers/embedding.ts";
import { buildTools, promptSection, type ToolEnv, type ToolKey } from "../tools/index.ts";
import { errMsg } from "../util/errors.ts";
import { ensureDir } from "../util/fs.ts";
import { warmModelCatalog } from "./catalog.ts";
import { type Config, type DecisionProviderConfig, Layout, loadConfig, type ProjectOverrideReport } from "./config.ts";
import { type ProjectInfo, resolveProject } from "./project.ts";
import { Telemetry } from "./telemetry.ts";
import type { AuxSessionRunner, Clock, CommandDef, CommitBatch, DecisionClient, EmbeddingClient, EntryView, HarnessAdapter, SessionRecord, ToolDef } from "./types.ts";
import { emptyBatch } from "./types.ts";

export interface HostOptions {
  adapter: HarnessAdapter;
  cwd: string;
  sessionId: string;
  /** pi session file or Claude Code transcript path (registered for `where: "project"` search). */
  sessionFile?: string;
  /** Ancestor session blob directories (for `/fork` sessions so `recall(o:…)` finds parent blobs). */
  parentBlobDirs?: string[];
  /** Whether project-local files may be loaded: the shared store and project config (§7.12). */
  trusted: boolean;
  /** Sub-sessions and subagents: path memories, the gate and the tools, but no Janus or Precip (§4.6.7). */
  light?: boolean;
  layout?: Layout;
  fetch?: FetchLike;
  clock?: Clock;
  random?: () => number;
  /** Prefix the harness puts in front of tool names (Claude Code's `mcp__realctx2__`). */
  toolPrefix?: string;
  loadSession?: ToolEnv["loadSession"];
  /** Test seams. */
  decision?: DecisionClient;
  late?: EmbeddingClient<"multivector"> | null;
  dense?: EmbeddingClient<"dense"> | null;
  cfg?: Config;
  /** Called when the decision endpoint in the configuration changes (pi re-registers its provider). */
  onDecisionConfig?: (cfg: DecisionProviderConfig | null) => void;
}

export interface ProviderHealth {
  decision: { configured: boolean; healthy: boolean; format?: string; model?: string; lastError?: string; emulated: boolean };
  late: { configured: boolean; healthy: boolean; model?: string; problem?: string } | null;
  dense: { configured: boolean; healthy: boolean; model?: string; problem?: string } | null;
  aux: { available: boolean };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export class Host {
  readonly adapter: HarnessAdapter;
  readonly layout: Layout;
  readonly project: ProjectInfo;
  readonly cfg: Config;
  readonly overrides: ProjectOverrideReport;
  readonly telemetry: Telemetry;
  readonly decision: DecisionClient;
  readonly late: EmbeddingClient<"multivector"> | null;
  readonly dense: EmbeddingClient<"dense"> | null;
  readonly memory: MemoryRuntime | null;
  readonly engine: ContextEngine;
  readonly blobs: BlobStore;
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly light: boolean;
  readonly trusted: boolean;
  readonly env: ToolEnv;
  readonly clock: Clock;
  toolPrefix: string;
  /** Tool-name conflicts and other start-up problems, for `status` and `doctor` (§8.1.3). */
  readonly problems: string[] = [];
  /** Tools actually registered under their own source (the others were skipped); null: all of them. */
  registered: Set<ToolKey> | null = null;
  probes: { late?: { ok: boolean; problem?: string }; dense?: { ok: boolean; problem?: string } } = {};
  http: HttpDecisionClient | null = null;
  memoryError: string | null = null;
  private readonly fetchImpl?: FetchLike;
  private readonly onDecisionConfig?: (cfg: DecisionProviderConfig | null) => void;
  private configMtime = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleAbort: AbortController | null = null;
  private idleRunning: Promise<void> | null = null;
  private started = false;
  private closed = false;
  private sectionCache: { key: string; text: string } | null = null;

  constructor(o: HostOptions) {
    this.adapter = o.adapter;
    this.sessionId = o.sessionId;
    this.sessionFile = o.sessionFile;
    this.light = o.light === true;
    this.trusted = o.trusted;
    this.clock = o.clock ?? (() => new Date());
    this.toolPrefix = o.toolPrefix ?? "";
    this.fetchImpl = o.fetch;
    this.onDecisionConfig = o.onDecisionConfig;
    this.layout = o.layout ?? new Layout();
    this.project = resolveProject(o.cwd);
    const loaded = o.cfg ? { config: o.cfg, overrides: { applied: [], ignored: [] } as ProjectOverrideReport } : loadConfig(this.layout, this.project.sharedDir, o.trusted);
    this.cfg = loaded.config;
    this.overrides = loaded.overrides;
    this.configMtime = this.mtime();
    this.telemetry = new Telemetry(this.layout, this.cfg.privacy.telemetryContent);
    o.adapter.attach?.({ cfg: this.cfg, telemetry: this.telemetry, layout: this.layout });

    // providers: the decision model and the embedding models are the user's own endpoints (§9.1, §9.2)
    const aux = this.aux();
    if (o.decision) this.decision = o.decision;
    else {
      this.http = this.makeHttp(this.cfg.providers.decision);
      this.decision = new ResilientDecisionClient(this.http, aux ? new EmulatedDecisionClient(aux, this.cfg.providers.aux.emulateTimeoutMs) : null);
    }
    const emb = o.late !== undefined || o.dense !== undefined ? { late: o.late ?? null, dense: o.dense ?? null } : createEmbeddingClients(this.cfg.providers.embedding, { fetch: o.fetch, telemetry: this.telemetry });
    this.late = emb.late;
    this.dense = emb.dense;

    let memory: MemoryRuntime | null = null;
    try {
      memory = new MemoryRuntime({
        layout: this.layout,
        cfg: this.cfg,
        cwd: o.cwd,
        trusted: o.trusted,
        decision: this.decision,
        aux,
        late: this.late,
        dense: this.dense,
        telemetry: this.telemetry,
        clock: this.clock,
        sessionId: o.sessionId,
        harness: o.adapter.harness,
        random: o.random,
        project: this.project,
      });
    } catch (e) {
      // context management still works without the stores
      this.memoryError = errMsg(e);
      this.problems.push(`memory stores could not be opened: ${this.memoryError}`);
      this.telemetry.event("memory.open_failed", { error: this.memoryError });
    }
    this.memory = memory;
    this.blobs = new BlobStore(this.layout.blobDir(o.sessionId), o.parentBlobDirs);
    this.engine = new ContextEngine({ adapter: o.adapter, cfg: this.cfg, decision: this.decision, sessionId: o.sessionId, memory, blobs: this.blobs, telemetry: this.telemetry, clock: this.clock, light: this.light });
    this.env = {
      cfg: this.cfg,
      layout: this.layout,
      sessionId: o.sessionId,
      harness: o.adapter.harness,
      memory,
      engine: this.engine,
      clock: this.clock,
      entries: () => (o.adapter.archiveEntries ? o.adapter.archiveEntries() : o.adapter.listEntries()),
      loadSession: o.loadSession,
    };
  }

  private aux(): AuxSessionRunner | null {
    try {
      return this.adapter.aux();
    } catch {
      return null;
    }
  }

  private mtime(): number {
    try {
      return statSync(this.layout.configFile).mtimeMs;
    } catch {
      return 0;
    }
  }

  private makeHttp(cfg: DecisionProviderConfig | null): HttpDecisionClient | null {
    if (!cfg?.url) return null;
    return new HttpDecisionClient(cfg, { fetch: this.fetchImpl, telemetry: this.telemetry, dailyTokenBudget: this.cfg.budgets.dailyDecisionTokens });
  }

  /**
   * A changed decision endpoint takes effect at once (§9.1.2). Everything else in the
   * configuration is read at session start.
   */
  refreshConfig(): boolean {
    const m = this.mtime();
    if (m === this.configMtime) return false;
    this.configMtime = m;
    const next = loadConfig(this.layout, this.project.sharedDir, this.trusted).config.providers.decision;
    if (sameJson(next, this.cfg.providers.decision)) return false;
    this.cfg.providers.decision = next;
    if (this.decision instanceof ResilientDecisionClient) {
      this.http = this.makeHttp(next);
      this.decision.setPrimary(this.http);
    }
    this.onDecisionConfig?.(next);
    return true;
  }

  /**
   * Reload the full configuration after `/realctx2 settings` writes `config.json`.
   * Mutates `this.cfg` in place so live subsystems see threshold changes immediately,
   * and re-syncs the decision endpoint and pi classifier registration when changed.
   */
  reloadConfig(): void {
    const loaded = loadConfig(this.layout, this.project.sharedDir, this.trusted);
    const prevDecision = this.cfg.providers.decision;
    this.configMtime = this.mtime();
    for (const k of Object.keys(loaded.config) as Array<keyof Config>) {
      (this.cfg as unknown as Record<string, unknown>)[k] = loaded.config[k];
    }
    this.overrides.applied.splice(0, this.overrides.applied.length, ...loaded.overrides.applied);
    this.overrides.ignored.splice(0, this.overrides.ignored.length, ...loaded.overrides.ignored);
    if (!sameJson(prevDecision, this.cfg.providers.decision)) {
      if (this.decision instanceof ResilientDecisionClient) {
        this.http = this.makeHttp(this.cfg.providers.decision);
        this.decision.setPrimary(this.http);
      }
      this.onDecisionConfig?.(this.cfg.providers.decision);
    }
    this.sectionCache = null;
    this.updateStatus();
  }

  // ───────────── session start (§4.2)
  async start(): Promise<void> {
    await warmModelCatalog();
    if (this.started) {
      await this.engine.rebuild();
      return;
    }
    this.started = true;
    const mem = this.memory;
    if (mem) {
      mem.startSession();
      if (!this.light) mem.registerSession({ id: this.sessionId, harness: this.adapter.harness, file: this.sessionFile, startedAt: this.clock().toISOString() });
      for (const scope of mem.graph.visible()) {
        const h = mem.graph.handle(scope);
        if (h.store.unloaded) this.problems.push(`${scope} store is not loaded: ${h.store.unloadedReason}`);
      }
    }
    await this.engine.onSessionStart();
    // provider health checks, including the shape of each embedding model's output (§9.2)
    void this.probe();
    this.updateStatus();
  }

  async probe(): Promise<void> {
    const run = async (c: EmbeddingClient<"dense"> | EmbeddingClient<"multivector"> | null, kind: "late" | "dense") => {
      if (!c) return;
      try {
        this.probes[kind] = await c.probe();
      } catch (e) {
        this.probes[kind] = { ok: false, problem: errMsg(e) };
      }
      if (this.probes[kind] && !this.probes[kind]!.ok) this.telemetry.event("embedding.probe_failed", { kind, problem: this.probes[kind]!.problem });
    };
    await Promise.all([run(this.late, "late"), run(this.dense, "dense")]);
  }

  health(): ProviderHealth {
    const d = this.cfg.providers.decision;
    const aux = this.aux();
    return {
      decision: { configured: !!d?.url, healthy: this.http ? this.http.available() : false, format: d?.format, model: d?.model, lastError: this.http?.lastError, emulated: !this.http?.available() && !!aux?.available() },
      late: this.late ? { configured: true, healthy: this.late.healthy() && this.probes.late?.ok !== false, model: this.late.model, problem: this.probes.late?.problem } : null,
      dense: this.dense ? { configured: true, healthy: this.dense.healthy() && this.probes.dense?.ok !== false, model: this.dense.model, problem: this.probes.dense?.problem } : null,
      aux: { available: !!aux?.available() },
    };
  }

  // ───────────── tools, command, prompt
  tools(opts: { aux?: boolean } = {}): ToolDef[] {
    return buildTools(() => (this.closed ? null : this.env), this.cfg, { aux: opts.aux, displayPrefix: this.toolPrefix });
  }

  command(): CommandDef {
    return buildCommand(this);
  }

  /** The realctx2 system-prompt section (§8.2). The string changes only when the tool set does. */
  promptSection(): string {
    const available = this.registered ?? undefined;
    const key = `${[...(available ?? [])].sort().join(",")}|${this.cfg.urgency.gate}|${this.memory ? 1 : 0}|${this.toolPrefix}`;
    if (this.sectionCache?.key !== key) this.sectionCache = { key, text: promptSection(this.cfg, { prefix: this.toolPrefix, available, memory: !!this.memory }) };
    return this.sectionCache.text;
  }

  /** The always-on "Project rules" section (§6.9.5); empty when nothing was ingested. */
  projectRules(): string {
    try {
      return this.engine.projectRules();
    } catch {
      return "";
    }
  }

  /** Whether an instruction file was ingested and must not be loaded by the harness again (§6.9.5). */
  ignoresInstructionFile(absPath: string): boolean {
    try {
      return this.cfg.instructions.ignoreAfterIngest && !!this.memory?.instructions.shouldIgnore(absPath);
    } catch {
      return false;
    }
  }

  updateStatus(): void {
    try {
      const s = this.engine.status();
      const parts = [s.disabled ? "ctx off" : `ctx ${s.window > 0 ? Math.round((s.occupancy / s.window) * 100) : 0}%`];
      if (s.stack.length) parts.push(`${s.stack.length} intent${s.stack.length > 1 ? "s" : ""}`);
      const cards = this.engine.state.deliveries.filter((d) => d.kind === "card" && !this.engine.state.attributed.has(d.deliveryId)).length;
      if (cards) parts.push(`${cards} card${cards > 1 ? "s" : ""}`);
      if (this.problems.length) parts.push(`${this.problems.length} problem${this.problems.length > 1 ? "s" : ""}`);
      this.adapter.setStatus?.(parts.join(" · "));
    } catch {
      // the status line is cosmetic
    }
  }

  // ───────────── idle time (§6.6.8)
  /** The user acted: abort any running idle step. An aborted step is retried later. */
  noteInput(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.idleAbort?.abort();
    this.idleAbort = null;
  }

  /**
   * The agent settled: queued post-settle Precip runs at once, in the background; model-dependent
   * maintenance starts after the idle period.
   */
  noteSettled(): void {
    if (this.closed || this.light) return;
    this.noteInput();
    const abort = new AbortController();
    this.idleAbort = abort;
    const first = this.engine.onIdle(abort.signal).catch((e) => this.telemetry.event("idle.engine_failed", { error: errMsg(e) }));
    this.idleRunning = first.then(() => undefined);
    const wait = Math.max(0, this.cfg.maintenance.idleMinutes) * 60_000;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (abort.signal.aborted || this.closed) return;
      // maintenance follows the engine's idle step, never runs beside it, and `settle()` waits for both
      this.idleRunning = first.then(() => (abort.signal.aborted || this.closed ? undefined : this.maintain({ signal: abort.signal }))).then(() => undefined, () => undefined);
    }, wait);
    // never keep the process alive for maintenance
    (this.idleTimer as { unref?: () => void }).unref?.();
  }

  /** Model-dependent maintenance in this process (idle time, or `/realctx2 maintain`). */
  async maintain(opts: { signal?: AbortSignal; force?: boolean; scopes?: NonNullable<Parameters<MemoryRuntime["idle"]>[0]>["scopes"] } = {}): Promise<{ harvested: number; idle: Awaited<ReturnType<MemoryRuntime["idle"]>> | null }> {
    const mem = this.memory;
    if (!mem) return { harvested: 0, idle: null };
    let harvested = 0;
    try {
      harvested += await this.engine.idleHarvest(opts.signal);
      harvested += await this.queuedHarvests(opts.signal);
    } catch (e) {
      this.telemetry.event("idle.harvest_failed", { error: errMsg(e) });
    }
    if (opts.signal?.aborted) return { harvested, idle: null };
    const idle = await mem.idle({ signal: opts.signal, force: opts.force, scopes: opts.scopes });
    for (const p of idle.passes) this.telemetry.event("maintain.pass", { scope: p.scope, attempts: p.attempts?.length ?? 0, stopped: p.stopped });
    return { harvested, idle };
  }

  /** Idle harvests left behind by earlier sessions (§6.6.8): their Precip memories are in the job. */
  private async queuedHarvests(signal?: AbortSignal): Promise<number> {
    const mem = this.memory;
    if (!mem) return 0;
    let n = 0;
    for (const job of mem.queued()) {
      if (signal?.aborted) break;
      if (job.kind !== "idle-harvest" || job.sessionId === this.sessionId) continue;
      const records = (Array.isArray(job.data?.records) ? job.data!.records : []) as Array<{ id?: unknown; text?: unknown }>;
      const texts = records.filter((r): r is { id: string; text: string } => typeof r.id === "string" && typeof r.text === "string");
      if (!texts.length) {
        mem.dequeue(job);
        continue;
      }
      const out = await this.engine.consolidator.ripple({ text: texts.map((r) => r.text).join("\n\n"), carry: [], telos: [] }, signal);
      if (signal?.aborted) break;
      if (!out) continue; // no aux model right now: the job stays queued
      const candidates: Candidate[] = out.knowledge.map((k) => ({
        text: k.fact,
        kind: "fact",
        origin: "harvest",
        evaluation: k.evaluation,
        validFrom: k.as_of && !Number.isNaN(Date.parse(k.as_of)) ? new Date(k.as_of).toISOString() : undefined,
        supersedesHint: k.supersedes,
        provenance: { sessionId: job.sessionId, turnId: texts[0]!.id },
        sourceTexts: texts.map((r) => r.text),
      }));
      if (candidates.length) n += (await mem.writer.write(candidates, { signal })).filter((r) => r.status === "created" || r.status === "merged").length;
      mem.dequeue(job);
    }
    return n;
  }

  /** Wait for background work (tests and `/realctx2 maintain`). */
  async settle(): Promise<void> {
    await this.idleRunning?.catch(() => undefined);
    await this.engine.settleBackground();
  }

  // ───────────── session end (§4.2)
  /**
   * 1. flush counter aggregates, 2. write pending changes as update files, 3. queue
   * model-dependent work that has not run, 4. spawn the model-free worker, detached.
   * Returns the last records for the adapter to persist. Idempotent.
   */
  async shutdown(opts: { spawnWorker?: boolean; reload?: boolean } = {}): Promise<CommitBatch> {
    if (this.closed) return emptyBatch();
    this.noteInput();
    let batch = emptyBatch();
    try {
      batch = await this.engine.onShutdown({ reload: opts.reload });
    } catch (e) {
      this.telemetry.event("shutdown.engine_failed", { error: errMsg(e) });
    }
    this.closed = true;
    const mem = this.memory;
    const s = this.engine.status();
    if (mem) {
      try {
        if (!this.light && !opts.reload) {
          const state = this.engine.state;
          const pending = [...state.records.values()].filter((r) => r.kind === "precip" && r.text && !r.knowledge && !state.parentOf(r.id));
          if (pending.length) mem.enqueue({ kind: "idle-harvest", sessionId: this.sessionId, sessionFile: this.sessionFile, harness: this.adapter.harness, data: { records: pending.slice(-12).map((r) => ({ id: r.id, text: r.text })) } });
          if (mem.reverifier.pending({ sessionEnding: true }).groups.length) mem.enqueue({ kind: "reverify", sessionId: this.sessionId });
        }
      } catch (e) {
        this.telemetry.event("shutdown.queue_failed", { error: errMsg(e) });
      }
      if (!opts.reload) {
        const deliveries = this.engine.state.deliveries.filter((d) => !d.subagent);
        const attributed = deliveries.map((d) => this.engine.state.attributed.get(d.deliveryId)).filter((a): a is NonNullable<typeof a> => !!a);
        this.telemetry.session({
          session: this.sessionId,
          harness: this.adapter.harness,
          requests: s.requests,
          deliveries: deliveries.length,
          uses: Math.round(attributed.reduce((sum, a) => sum + a.u, 0) * 100) / 100,
          irrelevantRate: attributed.length ? Math.round((attributed.reduce((sum, a) => sum + (a.use.ignored_irrelevant ?? 0), 0) / attributed.length) * 100) / 100 : null,
          closures: this.engine.state.closedOrder.length,
          consolidations: s.records,
          janusLate: s.janusLate,
          foldsSkippedByCost: s.foldsSkippedByCost,
        });
      }
      try {
        mem.shutdown({ requests: s.requests });
      } catch (e) {
        this.telemetry.event("shutdown.memory_failed", { error: errMsg(e) });
      }
      if (opts.spawnWorker !== false && !opts.reload && !this.light) this.spawnWorker();
    }
    return batch;
  }

  /** The model-free worker (§6.6.8): a detached process that outlives the session. */
  spawnWorker(): boolean {
    if (process.env.REALCTX2_NO_WORKER === "1") return false;
    try {
      const bin = fileURLToPath(new URL("../../bin/realctx2-worker.js", import.meta.url));
      if (!existsSync(bin)) return false;
      ensureDir(this.layout.logsDir);
      const args = [bin, "--cwd", this.project.cwd, ...(this.project.projectKey ? ["--project", this.project.projectKey] : []), ...(this.trusted ? ["--trusted"] : [])];
      const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", env: { ...process.env, REALCTX2_CHILD: "1", REALCTX2_HOME: this.layout.home } });
      child.on("error", () => undefined);
      child.unref();
      return true;
    } catch (e) {
      this.telemetry.event("worker.spawn_failed", { error: errMsg(e) });
      return false;
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

export type { EntryView, QueuedJob, SessionEntry, SessionRecord };
