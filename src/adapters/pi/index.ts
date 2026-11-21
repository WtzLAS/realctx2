/**
 * realctx2 as a pi extension (§4.1, §4.2). The factory registers handlers and the command only;
 * stores, providers and timers start in `session_start` and stop in an idempotent
 * `session_shutdown`. Every handler fails open: an error in realctx2 never blocks the agent.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, matchesKey } from "@earendil-works/pi-tui";
import { type DecisionProviderConfig, Layout, loadGlobalConfig, normalizeEnvVarName, resolveApiKey, saveConfig } from "../../core/config.ts";
import { Host } from "../../core/host.ts";
import { SETTINGS_CATEGORIES } from "../../core/settings-schema.ts";
import type { CommandIO, CommitBatch, ConsolidationRecord, ContextEdit, DecisionQuestion, SessionRecord } from "../../core/types.ts";
import { SUBCOMMANDS } from "../../commands/index.ts";
import type { ReviewModel } from "../../commands/review.ts";
import type { PendingDelivery } from "../../context/engine.ts";
import { GUIDANCE_TYPE } from "../../context/render.ts";
import type { PathEvent } from "../../memory/delivery.ts";
import { PROMPT_SECTION_ID, RULES_SECTION_ID, type ToolKey } from "../../tools/index.ts";
import { errMsg } from "../../util/errors.ts";
import { pathEventOf, resultPathEventOf } from "../pathevents.ts";
import { loadAnySession } from "../sessions.ts";
import { type Draft, PiAdapter, STATUS_KEY } from "./adapter.ts";
import { guidanceRenderer } from "./guidance-renderer.ts";
import type { ReviewScreenExit } from "./review-ui.ts";

export const DECISION_PROVIDER = "realctx2-decision";
/** pi's Working row while a user message waits for Janus in `before_agent_start`. */
export const WORKING_MESSAGE = "Working · realctx2 is reading the prompt";

/**
 * pi's Working row, shown early. Cosmetic: a mode or pi version whose UI context lacks these
 * methods (rpc, print, older releases) gets no row, and the hook still runs.
 *
 * pi's UI context has setters only, so the row cannot be put back exactly as it was: `restore()`
 * returns the message to pi's default and leaves the row enabled, which overrides a custom message
 * or a hidden row another extension set. pi clears the row at `agent_end`; when it fails to start
 * the run after this hook (a later step of its preparation throws), no `agent_end` comes. So
 * `restore()` watches until the run starts (`started`), and clears the row if pi goes idle first.
 */
export function workingRow(ctx: Pick<ExtensionContext, "hasUI" | "ui" | "isIdle">, o: { started: () => boolean; pollMs?: number; maxWaitMs?: number }): { show(message: string): void; restore(): void } {
  const ui = (ctx.hasUI ? ctx.ui : undefined) as Partial<Pick<ExtensionContext["ui"], "setWorkingMessage" | "setWorkingVisible">> | undefined;
  const call = (f: () => void) => {
    try {
      f();
    } catch {
      // the row is cosmetic
    }
  };
  const visible = (v: boolean) => {
    if (typeof ui?.setWorkingVisible === "function") call(() => ui.setWorkingVisible!(v));
  };
  let shown = false;
  return {
    show(message) {
      if (typeof ui?.setWorkingMessage === "function") call(() => ui.setWorkingMessage!(message));
      visible(true);
      shown = typeof ui?.setWorkingVisible === "function";
    },
    restore() {
      if (typeof ui?.setWorkingMessage === "function") call(() => ui.setWorkingMessage!());
      if (!shown) return;
      const until = Date.now() + (o.maxWaitMs ?? 120_000);
      const timer = setInterval(() => {
        let idle = false;
        try {
          idle = !o.started() && ctx.isIdle();
        } catch {
          // a context gone stale with its session: nothing to clear any more
          clearInterval(timer);
          return;
        }
        if (!idle && !o.started() && Date.now() < until) return;
        clearInterval(timer);
        if (idle) {
          // hidden, then enabled again: no row now, pi's default for the next run
          visible(false);
          visible(true);
        }
      }, o.pollMs ?? 500);
      (timer as { unref?: () => void }).unref?.();
    },
  };
}

/**
 * True when terminal input is pi's interrupt key (`app.interrupt`, escape by default). The
 * keybindings are pi's own when realctx2 shares its pi-tui (the extension loader aliases it);
 * a copy without pi's app keybindings falls back to escape.
 */
export function isInterruptKey(data: string): boolean {
  try {
    const kb = getKeybindings();
    if (kb.getDefinition("app.interrupt")) return kb.matches(data, "app.interrupt");
  } catch {
    // no keybindings: the default key below
  }
  return matchesKey(data, "escape");
}

/** pi's interrupt key as pi shows it in its own Working row ("escape" by default). */
export function interruptKeyText(): string {
  try {
    const kb = getKeybindings();
    if (kb.getDefinition("app.interrupt")) return kb.getKeys("app.interrupt").join("/");
  } catch {
    // no keybindings: the default key below
  }
  return "escape";
}

/**
 * The interrupt key while a user message waits for Janus in `before_agent_start`. pi already
 * takes the key as an abort of the run, but only acts on it at `agent_start`, and `ctx.signal` is
 * undefined until the run exists. So the hook watches the terminal itself and stops waiting at
 * once; the key is not consumed, pi still aborts the run. Interactive mode only (`active` false
 * elsewhere): an RPC abort has no terminal input to watch.
 */
export function interruptWatch(ctx: Pick<ExtensionContext, "hasUI" | "ui" | "mode">, isInterrupt: (data: string) => boolean = isInterruptKey): { signal: AbortSignal; active: boolean; dispose(): void } {
  const ctl = new AbortController();
  const ui = (ctx.hasUI && ctx.mode === "tui" ? ctx.ui : undefined) as Partial<Pick<ExtensionContext["ui"], "onTerminalInput">> | undefined;
  let off: (() => void) | undefined;
  if (typeof ui?.onTerminalInput === "function") {
    try {
      off = ui.onTerminalInput((data) => {
        try {
          if (!ctl.signal.aborted && isInterrupt(data)) ctl.abort();
        } catch {
          // never break the terminal
        }
        return undefined;
      });
    } catch {
      off = undefined;
    }
  }
  return {
    signal: ctl.signal,
    active: typeof off === "function",
    dispose() {
      try {
        off?.();
      } catch {
        // already gone with the UI
      }
      off = undefined;
    },
  };
}

type Part = { type: string; text?: string };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? (content as Part[]).filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n") : "";
}

/**
 * Apply context edits to the messages of one request (the `context` hook). The messages carry
 * no entry ids, so they are aligned with the session projection first; when the two do not line
 * up, nothing is changed.
 */
export function applyEditsToMessages(messages: AgentMessage[], projection: Array<{ id: string; messages: AgentMessage[] }>, edits: ContextEdit[]): AgentMessage[] | null {
  const byId = new Map(edits.map((e) => [e.targetId, e]));
  const role = (m: AgentMessage) => (m as { role: string }).role;
  const out: AgentMessage[] = [];
  let i = 0;
  let changed = false;
  const skipSystem = () => {
    while (i < messages.length && role(messages[i]!) === "system") out.push(messages[i++]!);
  };
  for (const p of projection) {
    const own = p.messages.filter((m) => role(m) !== "system");
    if (!own.length) continue;
    skipSystem();
    const slice = messages.slice(i, i + own.length);
    if (slice.length !== own.length || slice.some((m, k) => role(m) !== role(own[k]!) || ((m as { timestamp?: number }).timestamp !== undefined && (own[k] as { timestamp?: number }).timestamp !== undefined && (m as { timestamp?: number }).timestamp !== (own[k] as { timestamp?: number }).timestamp))) return null;
    i += own.length;
    const edit = byId.get(p.id);
    if (!edit) {
      out.push(...slice);
      continue;
    }
    changed = true;
    if (edit.replacement === null) continue;
    const first = slice[0]!;
    const r = role(first);
    const content = r === "assistant" || r === "toolResult" ? [{ type: "text", text: edit.replacement }] : edit.replacement;
    out.push({ ...(first as object), content } as AgentMessage);
  }
  // whatever follows the projection (queued or steering messages) is kept as it is
  out.push(...messages.slice(i));
  return changed ? out : null;
}

/** Walk parentSession links in session file headers so `/fork` sessions can still recall parent `o:` blobs. */
function ancestorBlobDirs(layout: Layout, sessionManager: ExtensionContext["sessionManager"]): string[] {
  const dirs: string[] = [];
  const seenFiles = new Set<string>();
  const seenIds = new Set<string>([sessionManager.getSessionId()]);
  let parentFile = sessionManager.getHeader?.()?.parentSession;
  for (let depth = 0; depth < 8 && parentFile && !seenFiles.has(parentFile); depth++) {
    seenFiles.add(parentFile);
    try {
      const raw = readFileSync(parentFile, "utf8");
      const nl = raw.indexOf("\n");
      const firstLine = (nl >= 0 ? raw.slice(0, nl) : raw).trim();
      if (!firstLine) break;
      const header = JSON.parse(firstLine) as { type?: string; id?: unknown; parentSession?: unknown };
      if (header.type !== "session" || typeof header.id !== "string" || !header.id) break;
      if (!seenIds.has(header.id)) {
        seenIds.add(header.id);
        dirs.push(layout.blobDir(header.id));
      }
      parentFile = typeof header.parentSession === "string" ? header.parentSession : undefined;
    } catch {
      break;
    }
  }
  return dirs;
}

class PiExtension {
  private readonly pi: ExtensionAPI;
  private readonly adapter: PiAdapter;
  host: Host | null = null;
  private readonly events = new Map<string, PathEvent | undefined>();
  private pendingBash: PathEvent[] = [];
  private pendingCompaction: ConsolidationRecord | null = null;
  private rechecked = false;
  private providerRegistered = false;
  private notified = new Set<string>();
  /** `agent_start` events seen: tells the Working row whether pi started the run it waited for. */
  private runsStarted = 0;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
    this.adapter = new PiAdapter({
      pi,
      memory: () => this.host?.memory ?? null,
      ownTools: () => this.host?.tools({ aux: true }) ?? [],
    });
  }

  private fail(where: string, err: unknown): void {
    try {
      this.host?.telemetry.event("pi.handler_failed", { handler: where, error: errMsg(err) });
    } catch {
      // nothing left to do
    }
  }

  /** Wrap a handler so that it fails open (pi's `tool_call` is fail-closed on uncaught errors). */
  // biome-ignore lint/suspicious/noExplicitAny: one wrapper for every pi event shape
  private safe(name: string, fn: (event: any, ctx: ExtensionContext) => unknown): (event: any, ctx: ExtensionContext) => Promise<any> {
    return async (event, ctx) => {
      try {
        this.adapter.bind(ctx);
        return await fn(event, ctx);
      } catch (err) {
        this.fail(name, err);
        return undefined;
      }
    };
  }

  private isOwn(toolName: string): boolean {
    for (const def of this.adapter.registered.values()) if (def.name === toolName) return true;
    return false;
  }

  private report(problems: string[]): void {
    for (const p of problems) {
      if (this.notified.has(p)) continue;
      this.notified.add(p);
      if (this.host && !this.host.problems.includes(p)) this.host.problems.push(p);
      this.adapter.notify(`realctx2: ${p}`, "error");
    }
  }

  // ───────────── the decision endpoint as a pi classifier provider (§9.1.2)
  private syncProvider(cfg: DecisionProviderConfig | null): void {
    const want = !!cfg?.url && cfg.registerInPi !== false;
    try {
      if (!want) {
        if (this.providerRegistered) this.pi.unregisterProvider(DECISION_PROVIDER);
        this.providerRegistered = false;
        return;
      }
      const api = cfg!.format === "systemone" ? "typesafe-system-one" : "openai-decisions";
      const classify = async (model: { id: string }, context: { state: unknown; questions: Record<string, { type: string; instructions: string; criteria: unknown }> }, options?: { signal?: AbortSignal; timeoutMs?: number }) => {
        const base = { api, provider: DECISION_PROVIDER, model: model.id, timestamp: Date.now() };
        const http = this.host?.http;
        if (!http) return { ...base, answers: {}, stopReason: "error" as const, errorMessage: "realctx2 has no decision endpoint configured" };
        const names = Object.keys(context.questions);
        const questions: DecisionQuestion[] = names.map((name) => {
          const q = context.questions[name]!;
          if (q.type === "bool") {
            const c = (q.criteria ?? {}) as { true?: string; false?: string };
            return { kind: "binary", name, instructions: q.instructions, yes: c.true, no: c.false };
          }
          if (q.type === "score") return { kind: "score", name, instructions: q.instructions, levels: ((q.criteria as string[]) ?? []).map((label) => ({ label })) };
          return { kind: "choice", name, instructions: q.instructions, options: Object.entries((q.criteria as Record<string, string>) ?? {}).map(([value, description]) => ({ value, description })) };
        });
        try {
          const got = await http.decide(context.state as object, questions, { callSite: "pi.classify", timeoutMs: options?.timeoutMs ?? 10_000, signal: options?.signal });
          const answers: Record<string, unknown> = {};
          for (const q of questions) {
            const a = got[q.name];
            if (!a) continue;
            if (q.kind === "binary") answers[q.name] = { type: "bool", probability: a.p ?? 0 };
            else if (q.kind === "choice") answers[q.name] = { type: "choice", choice: a.choice ?? "", probabilities: a.probs ?? {}, confidence: a.confidence ?? (a.choice ? (a.probs?.[a.choice] ?? 0) : 0) };
            else {
              const labels = q.levels.map((l) => l.label);
              const probs = labels.map((l) => a.probs?.[l] ?? 0);
              const top = probs.indexOf(Math.max(...probs));
              answers[q.name] = { type: "score", score: top >= 0 ? top : Math.round((a.score01 ?? 0) * Math.max(1, labels.length - 1)), confidence: a.confidence ?? (top >= 0 ? probs[top]! : 0) };
            }
          }
          return { ...base, answers, stopReason: "stop" as const };
        } catch (e) {
          return { ...base, answers: {}, stopReason: options?.signal?.aborted ? ("aborted" as const) : ("error" as const), errorMessage: errMsg(e) };
        }
      };
      this.pi.registerProvider(DECISION_PROVIDER, {
        name: "realctx2 decision endpoint",
        baseUrl: cfg!.url,
        apiKey: normalizeEnvVarName(cfg!.apiKeyEnv) ? `$${normalizeEnvVarName(cfg!.apiKeyEnv)}` : (resolveApiKey(cfg) ?? "none"),
        classifiers: { [api]: { classify } } as never,
        models: [{ type: "classifier", id: cfg!.model, name: `${cfg!.model} (realctx2)`, api, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: cfg!.maxInputTokens ?? 32_000 }] as never,
      });
      this.providerRegistered = true;
    } catch (e) {
      this.fail("registerProvider", e);
    }
  }

  // ───────────── session lifecycle
  private resetEphemeral(): void {
    this.events.clear();
    this.pendingBash = [];
    this.pendingCompaction = null;
    this.adapter.clearDeferred();
  }

  private async onSessionStart(_event: { reason?: string; previousSessionFile?: string }, ctx: ExtensionContext): Promise<void> {
    const sm = ctx.sessionManager;
    const sessionFile = sm.getSessionFile();
    if (this.host && !this.host.isClosed) await this.host.shutdown({ spawnWorker: false }).catch(() => undefined);
    this.resetEphemeral();
    this.rechecked = false;
    this.notified.clear();
    // sub-sessions started through pi's SDK (no UI and no session file) run in light mode (§4.6.7)
    const light = !ctx.hasUI && !sessionFile;
    const layout = new Layout();
    const parentBlobDirs = ancestorBlobDirs(layout, sm);
    const host: Host = new Host({
      adapter: this.adapter,
      cwd: ctx.cwd,
      sessionId: sm.getSessionId(),
      sessionFile,
      parentBlobDirs,
      trusted: ctx.isProjectTrusted(),
      light,
      layout,
      loadSession: (s) => loadAnySession(host.layout, s),
      onDecisionConfig: (cfg) => this.syncProvider(cfg),
    });
    this.host = host;
    // tools: each name is checked against every other tool first (§8.1.3)
    for (const def of host.tools()) this.adapter.registerTool(def);
    host.registered = new Set([...this.adapter.registered.keys()] as ToolKey[]);
    this.syncProvider(host.cfg.providers.decision);
    await host.start();
    this.report([...this.adapter.conflicts.values()]);
    if (host.memoryError) this.adapter.notify(`realctx2: memory stores could not be opened (${host.memoryError}). Context management still works.`, "warning");
  }

  private flushBash(): void {
    const host = this.host;
    if (!host || !this.pendingBash.length) return;
    // moves and deletions count only when the file system confirms them, so applying late is safe
    for (const ev of this.pendingBash.splice(0)) host.engine.onUserBash(ev, true);
  }

  private async onBeforeAgentStart(event: { messageType: string; prompt?: string; systemPromptOptions: { sections: Record<string, string>; contextFiles: Array<{ path: string; content: string }> } }, ctx: ExtensionContext) {
    const host = this.host;
    if (!host) return undefined;
    host.noteInput();
    host.refreshConfig();
    this.flushBash();
    if (!this.rechecked) {
      // after every extension has loaded: a later one may have replaced one of our tools
      this.rechecked = true;
      this.report(this.adapter.recheckTools());
      host.registered = new Set([...this.adapter.registered.keys()].filter((k) => !this.adapter.conflicts.has(k)) as ToolKey[]);
    }
    // applied on every run: pi rebuilds systemPromptOptions from its base inputs each time. The
    // strings only change when rules change, so pi's section diff emits no patch (§4.4).
    const opts = event.systemPromptOptions;
    opts.sections[PROMPT_SECTION_ID] = host.promptSection();
    const rules = host.projectRules();
    if (rules) opts.sections[RULES_SECTION_ID] = rules;
    else delete opts.sections[RULES_SECTION_ID];
    if (opts.contextFiles?.length) {
      const kept = opts.contextFiles.filter((f) => !host.ignoresInstructionFile(resolve(ctx.cwd, f.path)));
      if (kept.length !== opts.contextFiles.length) opts.contextFiles.splice(0, opts.contextFiles.length, ...kept);
    }
    // extension-triggered custom runs skip user-turn Janus
    if (event.messageType !== "user") return undefined;
    // pi shows its Working row only at the first turn_start, after every before_agent_start
    // handler; until then the prompt has left the editor and nothing says the run is waiting
    const runs = this.runsStarted;
    const working = workingRow(ctx, { started: () => this.runsStarted !== runs });
    // Esc cancels the wait: Janus stops, pi aborts the run when it starts
    const interrupt = interruptWatch(ctx);
    working.show(interrupt.active ? `${WORKING_MESSAGE} (${interruptKeyText()} to interrupt)` : WORKING_MESSAGE);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, interrupt.signal]) : interrupt.signal;
    let batch: CommitBatch;
    try {
      batch = await host.engine.onUserMessage(event.prompt ?? "", signal);
    } finally {
      interrupt.dispose();
      working.restore();
    }
    if (interrupt.signal.aborted) host.telemetry.event("pi.prompt_interrupted", {});
    this.adapter.deferred.edits.push(...batch.edits);
    host.updateStatus();
    const msg = batch.messages[0];
    if (!msg) {
      this.adapter.deferred.records.push(...batch.records);
      return undefined;
    }
    // this hook has no boundary to return entries from: the records ride in the guidance
    // message's details, right after the user message they belong to
    const records: SessionRecord[] = batch.records;
    return { message: { customType: msg.customType, content: msg.content, display: msg.display, details: { ...(msg.details ?? {}), ...(records.length ? { records } : {}) } } };
  }

  private async onToolCall(event: { toolName: string; toolCallId: string; parentToolCallId?: string; input: Record<string, unknown> }, ctx: ExtensionContext) {
    const host = this.host;
    if (!host) return undefined;
    this.flushBash();
    const own = this.isOwn(event.toolName);
    const mem = host.memory;
    const pathEvent = own || !mem ? undefined : pathEventOf(event.toolName, event.input, { cwd: ctx.cwd, rel: (p, cwd) => mem.paths.rel(p, cwd) });
    if (this.events.size > 500) this.events.clear();
    this.events.set(event.toolCallId, pathEvent);
    const res = await host.engine.onToolCall({ toolCallId: event.toolCallId, event: pathEvent, nested: !!event.parentToolCallId, own });
    return res ? { block: true, reason: res.block } : undefined;
  }

  private async onToolResult(event: { toolName: string; toolCallId: string; parentToolCallId?: string; content: Part[]; details?: unknown; structuredContent?: unknown; isError: boolean }, ctx: ExtensionContext) {
    const host = this.host;
    if (!host) return undefined;
    const own = this.isOwn(event.toolName);
    let pathEvent = this.events.get(event.toolCallId);
    this.events.delete(event.toolCallId);
    const mem = host.memory;
    if (!own && !pathEvent && mem && event.details) {
      pathEvent = resultPathEventOf(event.toolName, event.details, {
        cwd: ctx.cwd,
        rel: (p, cwd) => mem.paths.rel(p, cwd),
        exists: (rel) => mem.paths.exists(rel),
      });
    }
    const deliveries = own ? ((event.details as { deliveries?: PendingDelivery[] } | undefined)?.deliveries ?? undefined) : undefined;
    const patch = await host.engine.onToolResult({ toolCallId: event.toolCallId, toolName: event.toolName, text: textOf(event.content), isError: event.isError, event: pathEvent, nested: !!event.parentToolCallId, own, deliveries });
    if (!patch) return undefined;
    // text is replaced as one part; images stay. structuredContent is forwarded, so structured
    // tool outputs are not dropped when the content is patched.
    const others = event.content.filter((p) => p.type !== "text");
    return { content: [{ type: "text", text: patch.text }, ...others], structuredContent: event.structuredContent };
  }

  private async boundary(kind: "turn_end" | "agent_before_settle", event: { entries: Draft[]; outcome?: string; message?: AgentMessage }, ctx: ExtensionContext) {
    const host = this.host;
    if (!host) return undefined;
    this.flushBash();
    const batch = kind === "turn_end" ? await host.engine.onTurnEnd(ctx.signal) : host.cfg.context.settleConsolidation ? await host.engine.onBeforeSettle(ctx.signal) : { records: [], edits: [], messages: [] };
    const drafts = this.adapter.drafts(batch);
    if (kind === "turn_end") {
      const usage = (event.message as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } } | undefined)?.usage;
      host.telemetry.step({ session: host.sessionId, requestTokens: ctx.getContextUsage()?.tokens ?? null, input: usage?.input, output: usage?.output, cacheRead: usage?.cacheRead, cacheWrite: usage?.cacheWrite, consolidations: batch.records.filter((r) => r.type === "realctx2.consolidation").length, edits: batch.edits.length });
      host.memory?.flushIfDue();
    }
    host.updateStatus();
    // earlier extensions' proposals are preserved
    return drafts.length ? { entries: [...event.entries, ...drafts] } : undefined;
  }

  private async onContext(event: { messages: AgentMessage[] }, ctx: ExtensionContext) {
    const host = this.host;
    if (!host) return undefined;
    // normally nothing: an unchanged list keeps pi's cache-friendly path (§4.4)
    const edits = await host.engine.onContext();
    if (!edits?.length) return undefined;
    const projection = ctx.sessionManager.buildSessionProjection().entries.map((p) => ({ id: p.sourceEntry.id, messages: p.messages }));
    const messages = applyEditsToMessages(event.messages, projection, edits);
    if (!messages) host.telemetry.event("pi.context_unaligned", { edits: edits.length });
    return messages ? { messages } : undefined;
  }

  private async onBeforeCompact(event: { preparation: { tokensBefore: number }; customInstructions?: string; reason: string; signal: AbortSignal }) {
    const host = this.host;
    if (!host || host.light) return undefined;
    this.pendingCompaction = null;
    // never `{ cancel: true }`: cancelling an overflow compaction would suppress pi's retry (§5.4.5)
    const res = await host.engine.onBeforeCompact({ instructions: event.customInstructions, tokensBefore: event.preparation.tokensBefore, signal: event.signal });
    if (!res) return undefined; // no aux model: pi compacts on its own
    this.pendingCompaction = res.record;
    host.telemetry.event("pi.compaction", { reason: event.reason, tokensBefore: res.tokensBefore });
    return { compaction: { summary: res.summary, firstKeptEntryId: res.firstKeptEntryId, tokensBefore: res.tokensBefore, details: { realctx2: res.record.id } } };
  }

  private async onCompact(event: { compactionEntry: { id: string }; fromExtension: boolean }): Promise<void> {
    const host = this.host;
    const record = this.pendingCompaction;
    this.pendingCompaction = null;
    if (!host) return;
    if (record && event.fromExtension) {
      // the record goes in through pi.appendEntry, so recall keeps working: raw entries stay in the file
      await this.adapter.commit(host.engine.onCompacted(record, event.compactionEntry.id));
    }
    await host.engine.rebuild().catch(() => undefined);
  }

  private async onShutdown(event?: { reason?: "quit" | "reload" | "new" | "resume" | "fork" }): Promise<void> {
    const host = this.host;
    if (!host) return;
    this.host = null;
    const reason = event?.reason;
    const isReload = reason === "reload";
    // On /new, /resume, /fork and /reload pi is immediately starting the next session in this process,
    // so skip spawning a competing detached worker; full detached maintenance runs on quit.
    const spawnWorker = !reason || reason === "quit";
    const batch = await host.shutdown({ spawnWorker, reload: isReload });
    await this.adapter.commit({ records: [...this.adapter.deferred.records, ...batch.records], edits: [], messages: [] }).catch(() => undefined);
    this.resetEphemeral();
    this.rechecked = false;
    this.notified.clear();
    this.syncProvider(null);
    this.adapter.setStatus(undefined);
  }

  // ───────────── the command
  private reportHeader(args: string): { title: string; subtitle?: string } {
    const trimmed = args.trim();
    if (!trimmed) return { title: "realctx2 help" };
    const space = trimmed.search(/\s/);
    if (space < 0) return { title: `realctx2 ${trimmed}` };
    const sub = trimmed.slice(0, space);
    const rest = trimmed.slice(space + 1).trim();
    return { title: `realctx2 ${sub}`, subtitle: rest ? (rest.length > 48 ? `${rest.slice(0, 47)}…` : rest) : undefined };
  }

  private async showReport(ctx: ExtensionCommandContext, title: string, content: string, opts?: { subtitle?: string; tone?: "accent" | "error" }): Promise<void> {
    if (ctx.mode === "tui" && ctx.hasUI) {
      const { Realctx2ReportComponent } = await import("./report-ui.ts");
      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) =>
          new Realctx2ReportComponent({
            title,
            subtitle: opts?.subtitle,
            content,
            tone: opts?.tone,
            onClose: () => done(undefined),
            theme,
            tui,
          }),
      );
      return;
    }
    if (ctx.hasUI) ctx.ui.notify(content, opts?.tone === "error" ? "error" : "info");
    else process.stderr.write(`${content}\n`);
  }

  /** The interactive review screen; it closes for pi's editor during an edit and reopens as it was. */
  private async openReview(ctx: ExtensionCommandContext, model: ReviewModel): Promise<void> {
    const { runReviewScreen } = await import("./review-ui.ts");
    await runReviewScreen(model, {
      custom: (factory) => ctx.ui.custom<ReviewScreenExit>((tui, theme, _keybindings, done) => factory(tui, theme, done)),
      editor: (title, prefill) => ctx.ui.editor(title, prefill),
    });
  }

  private async openSettings(ctx: ExtensionCommandContext, host: Host, category?: string): Promise<void> {
    const { Realctx2SettingsComponent } = await import("./settings-ui.ts");
    let availableModels: Array<{ id: string; provider: string; name?: string; contextWindow?: number }> = [];
    let knownModels: Array<{ id: string; provider: string; name?: string; contextWindow?: number }> = [];
    try {
      const reg = ctx.modelRegistry;
      const avail = reg.getAvailable();
      const all = reg.getAll();
      const toChoice = (m: { id: string; provider: string; name?: string; contextWindow?: number }) => ({
        id: m.id,
        provider: m.provider,
        name: m.name,
        contextWindow: typeof m.contextWindow === "number" && m.contextWindow > 0 ? m.contextWindow : undefined,
      });
      availableModels = (avail.length ? avail : all).map(toChoice);
      const seen = new Set<string>();
      const pushUnique = (m: { id: string; provider: string; name?: string; contextWindow?: number } | undefined) => {
        if (!m?.provider || !m?.id) return;
        const key = `${m.provider}/${m.id}`;
        if (seen.has(key)) return;
        seen.add(key);
        knownModels.push(toChoice(m));
      };
      // Put active model and configured/available models first, then all remaining registry models.
      pushUnique(ctx.model);
      for (const m of avail) pushUnique(m);
      for (const m of all) pushUnique(m);
    } catch {
      // model registry unavailable
    }
    const globalCfg = loadGlobalConfig(host.layout);
    await ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) =>
        new Realctx2SettingsComponent({
          config: globalCfg,
          effectiveConfig: host.cfg,
          projectOverrides: host.overrides.applied,
          configPath: host.layout.configFile,
          displayContext: { health: host.health() },
          availableModels,
          knownModels,
          initialCategory: category,
          onSave: (next) => {
            saveConfig(host.layout, next);
            host.reloadConfig();
          },
          onClose: () => done(undefined),
          theme,
          tui,
        }),
    );
  }

  private async onCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    this.adapter.bind(ctx);
    const host = this.host;
    const isTui = ctx.mode === "tui" && ctx.hasUI;
    const header = this.reportHeader(args);
    const buffered: string[] = [];
    let hasError = false;
    let statusOverridden = false;
    const flushReport = async (suffix?: string): Promise<void> => {
      if (!buffered.length) return;
      const text = buffered.splice(0).join("\n\n");
      const tone = hasError ? "error" : "accent";
      hasError = false;
      const title = suffix ? `${header.title} · ${suffix}` : header.title;
      await this.showReport(ctx, title, text, { subtitle: header.subtitle, tone });
    };
    const io: CommandIO = {
      hasUI: ctx.hasUI,
      print: (text) => {
        if (isTui) buffered.push(text);
        else if (ctx.hasUI) ctx.ui.notify(text, "info");
        else process.stderr.write(`${text}\n`);
      },
      notify: (text, level) => {
        if (!isTui) {
          ctx.ui.notify(text, level ?? "info");
          return;
        }
        if (level === "error") {
          hasError = true;
          buffered.push(text);
          return;
        }
        // Keep transient progress notices out of the chat transcript in TUI mode.
        statusOverridden = true;
        this.adapter.setStatus(text);
      },
      confirm: async (title, message) => {
        if (isTui) await flushReport("preview");
        return ctx.hasUI ? ctx.ui.confirm(title, message) : false;
      },
      edit: ctx.hasUI
        ? async (title, prefill) => {
            if (isTui) await flushReport();
            return ctx.ui.editor(title, prefill);
          }
        : undefined,
      openSettings: host && isTui ? (category) => this.openSettings(ctx, host, category) : undefined,
      review: host && isTui ? (model) => this.openReview(ctx, model) : undefined,
    };
    if (!host) {
      io.print("realctx2 is not running in this session (it starts with the session; see the extension errors pi reported at startup).");
      await flushReport();
      return;
    }
    try {
      await host.command().handler(args, io);
    } finally {
      if (statusOverridden) host.updateStatus();
      await flushReport();
    }
  }

  async install(): Promise<void> {
    const pi = this.pi;
    pi.on("session_start", this.safe("session_start", (e, ctx) => this.onSessionStart(e, ctx)));
    pi.on(
      "input",
      this.safe("input", () => {
        this.host?.noteInput(); // aborts idle maintenance
        return undefined;
      }),
    );
    pi.on("before_agent_start", this.safe("before_agent_start", (e, ctx) => this.onBeforeAgentStart(e, ctx)));
    pi.on("agent_start", () => {
      this.runsStarted++;
    });
    pi.on("context", this.safe("context", (e, ctx) => this.onContext(e, ctx)));
    pi.on("tool_call", this.safe("tool_call", (e, ctx) => this.onToolCall(e, ctx)));
    pi.on("tool_result", this.safe("tool_result", (e, ctx) => this.onToolResult(e, ctx)));
    pi.on(
      "user_bash",
      this.safe("user_bash", (e, ctx) => {
        const mem = this.host?.memory;
        const ev = mem ? pathEventOf("bash", { command: e.command }, { cwd: e.cwd || ctx.cwd, rel: (p, cwd) => mem.paths.rel(p, cwd) }) : undefined;
        if (ev) this.pendingBash.push(ev);
        return undefined; // never intercepts: pi runs the command
      }),
    );
    pi.on("turn_end", this.safe("turn_end", (e, ctx) => this.boundary("turn_end", e, ctx)));
    pi.on("agent_before_settle", this.safe("agent_before_settle", (e, ctx) => this.boundary("agent_before_settle", e, ctx)));
    pi.on(
      "agent_settled",
      this.safe("agent_settled", () => {
        this.flushBash();
        this.host?.noteSettled(); // queued Precip now, maintenance after the idle period
        return undefined;
      }),
    );
    pi.on("session_before_compact", this.safe("session_before_compact", (e) => this.onBeforeCompact(e)));
    pi.on("session_compact", this.safe("session_compact", (e) => this.onCompact(e)));
    pi.on(
      "session_compact_failed",
      this.safe("session_compact_failed", () => {
        this.pendingCompaction = null;
        return undefined;
      }),
    );
    pi.on(
      "session_before_switch",
      this.safe("session_before_switch", () => {
        this.host?.noteInput();
        this.pendingCompaction = null;
        return undefined;
      }),
    );
    pi.on(
      "session_before_fork",
      this.safe("session_before_fork", () => {
        this.host?.noteInput();
        this.pendingCompaction = null;
        return undefined;
      }),
    );
    pi.on(
      "session_before_tree",
      this.safe("session_before_tree", () => {
        // Abort idle maintenance/Precip before navigating so nothing writes to the outgoing branch.
        this.host?.noteInput();
        this.pendingCompaction = null;
        return undefined;
      }),
    );
    pi.on(
      "session_tree",
      this.safe("session_tree", async () => {
        // All session state is branch-relative: drop any stale pending state from the old branch,
        // then rebuild cleanly from the new active branch.
        this.host?.noteInput();
        this.resetEphemeral();
        await this.host?.engine.rebuild();
        this.host?.updateStatus();
        return undefined;
      }),
    );
    pi.on(
      "model_select",
      this.safe("model_select", () => {
        this.host?.updateStatus(); // W follows the new model's context window from catalog metadata
        return undefined;
      }),
    );
    pi.on("session_shutdown", this.safe("session_shutdown", (e) => this.onShutdown(e)));
    // guidance messages are shown like realctx2's tools; older pi versions without the API keep the default box
    if (typeof pi.registerMessageRenderer === "function") pi.registerMessageRenderer(GUIDANCE_TYPE, guidanceRenderer());

    pi.registerCommand("realctx2", {
      description: "Context and memory manager: status, settings, search, review, ingest, forget, doctor…",
      getArgumentCompletions: (prefix: string) => {
        const p = prefix.trimStart();
        if (!p.includes(" ")) {
          const items = Object.entries(SUBCOMMANDS).filter(([k]) => k.startsWith(p)).map(([k, v]) => ({ value: k, label: k, description: v.help }));
          return items.length ? items : null;
        }
        const m = /^settings\s+(\S*)$/.exec(p);
        if (m) {
          const sub = m[1]!.toLowerCase();
          const items = SETTINGS_CATEGORIES.filter((c) => c.id.startsWith(sub) || c.aliases?.some((a) => a.startsWith(sub))).map((c) => ({
            value: `settings ${c.id}`,
            label: c.id,
            description: `${c.title} — ${c.description}`,
          }));
          return items.length ? items : null;
        }
        return null;
      },
      handler: async (args, ctx) => {
        try {
          await this.onCommand(args, ctx);
        } catch (e) {
          this.fail("command", e);
          await this.showReport(ctx, "realctx2 error", `/realctx2 failed: ${errMsg(e)}`, { tone: "error" });
        }
      },
    });
  }
}

export default async function realctx2(pi: ExtensionAPI): Promise<void> {
  // processes realctx2 starts itself never load realctx2 again
  if (process.env.REALCTX2_CHILD === "1" || process.env.REALCTX2_DISABLE === "1") return;
  await new PiExtension(pi).install();
}

export { PiAdapter, STATUS_KEY };
