/**
 * realctx2 as a pi extension (§4.1, §4.2). The factory registers handlers and the command only;
 * stores, providers and timers start in `session_start` and stop in an idempotent
 * `session_shutdown`. Every handler fails open: an error in realctx2 never blocks the agent.
 */
import { resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type DecisionProviderConfig, loadGlobalConfig, normalizeEnvVarName, resolveApiKey, saveConfig } from "../../core/config.ts";
import { Host } from "../../core/host.ts";
import { SETTINGS_CATEGORIES } from "../../core/settings-schema.ts";
import type { CommandIO, ConsolidationRecord, ContextEdit, DecisionQuestion, SessionRecord } from "../../core/types.ts";
import { SUBCOMMANDS } from "../../commands/index.ts";
import type { PendingDelivery } from "../../context/engine.ts";
import type { PathEvent } from "../../memory/delivery.ts";
import { PROMPT_SECTION_ID, RULES_SECTION_ID, type ToolKey } from "../../tools/index.ts";
import { pathEventOf } from "../pathevents.ts";
import { loadAnySession } from "../sessions.ts";
import { type Draft, OUTPUT_ENTRY, PiAdapter, STATUS_KEY } from "./adapter.ts";

export const DECISION_PROVIDER = "realctx2-decision";

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

class PiExtension {
  private readonly pi: ExtensionAPI;
  private readonly adapter: PiAdapter;
  host: Host | null = null;
  private readonly events = new Map<string, PathEvent | undefined>();
  private pendingBash: PathEvent[] = [];
  private pendingCompaction: ConsolidationRecord | null = null;
  private rechecked = false;
  private providerRegistered = false;
  private rendererReady = false;
  private notified = new Set<string>();

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
      this.host?.telemetry.event("pi.handler_failed", { handler: where, error: String((err as Error)?.message ?? err) });
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
          return { ...base, answers: {}, stopReason: options?.signal?.aborted ? ("aborted" as const) : ("error" as const), errorMessage: String((e as Error).message ?? e) };
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
  private async onSessionStart(_event: { reason: string }, ctx: ExtensionContext): Promise<void> {
    const sm = ctx.sessionManager;
    const sessionFile = sm.getSessionFile();
    if (this.host && !this.host.isClosed) await this.host.shutdown({ spawnWorker: false }).catch(() => undefined);
    // sub-sessions started through pi's SDK (no UI and no session file) run in light mode (§4.6.7)
    const light = !ctx.hasUI && !sessionFile;
    const host: Host = new Host({
      adapter: this.adapter,
      cwd: ctx.cwd,
      sessionId: sm.getSessionId(),
      sessionFile,
      trusted: ctx.isProjectTrusted(),
      light,
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
    const batch = await host.engine.onUserMessage(event.prompt ?? "", ctx.signal);
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

  private async onToolResult(event: { toolName: string; toolCallId: string; parentToolCallId?: string; content: Part[]; details?: unknown; structuredContent?: unknown; isError: boolean }) {
    const host = this.host;
    if (!host) return undefined;
    const own = this.isOwn(event.toolName);
    const pathEvent = this.events.get(event.toolCallId);
    this.events.delete(event.toolCallId);
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

  private async onShutdown(): Promise<void> {
    const host = this.host;
    if (!host) return;
    this.host = null;
    const batch = await host.shutdown();
    await this.adapter.commit({ records: [...this.adapter.deferred.records, ...batch.records], edits: [], messages: [] }).catch(() => undefined);
    this.adapter.deferred = { records: [], edits: [], messages: [] };
    this.adapter.setStatus(undefined);
    this.events.clear();
  }

  // ───────────── the command
  private print(ctx: ExtensionCommandContext, text: string): void {
    if (ctx.mode === "tui" && this.rendererReady) {
      try {
        this.pi.appendEntry(OUTPUT_ENTRY, { text });
        return;
      } catch {
        // fall through
      }
    }
    if (ctx.hasUI) ctx.ui.notify(text, "info");
    else process.stderr.write(`${text}\n`);
  }

  private async openSettings(ctx: ExtensionCommandContext, host: Host, category?: string): Promise<void> {
    const { Realctx2SettingsComponent } = await import("./settings-ui.ts");
    let availableModels: Array<{ id: string; provider: string; name?: string }> = [];
    try {
      const reg = ctx.modelRegistry;
      const list = reg.getAvailable();
      const models = list.length ? list : reg.getAll();
      availableModels = models.map((m) => ({ id: m.id, provider: m.provider, name: m.name }));
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
    const io: CommandIO = {
      hasUI: ctx.hasUI,
      print: (text) => this.print(ctx, text),
      notify: (text, level) => ctx.ui.notify(text, level ?? "info"),
      confirm: (title, message) => (ctx.hasUI ? ctx.ui.confirm(title, message) : Promise.resolve(false)),
      edit: ctx.hasUI ? (title, prefill) => ctx.ui.editor(title, prefill) : undefined,
      openSettings: host && ctx.hasUI && ctx.mode === "tui" ? (category) => this.openSettings(ctx, host, category) : undefined,
    };
    if (!host) return io.print("realctx2 is not running in this session (it starts with the session; see the extension errors pi reported at startup).");
    await host.command().handler(args, io);
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
    pi.on("context", this.safe("context", (e, ctx) => this.onContext(e, ctx)));
    pi.on("tool_call", this.safe("tool_call", (e, ctx) => this.onToolCall(e, ctx)));
    pi.on("tool_result", this.safe("tool_result", (e) => this.onToolResult(e)));
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
      "session_tree",
      this.safe("session_tree", async () => {
        // all session state is branch-relative: rebuild it from the new active branch
        await this.host?.engine.rebuild();
        this.host?.updateStatus();
        return undefined;
      }),
    );
    pi.on(
      "model_select",
      this.safe("model_select", () => {
        this.host?.updateStatus(); // W follows the new model's context window
        return undefined;
      }),
    );
    pi.on("session_shutdown", this.safe("session_shutdown", () => this.onShutdown()));

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
          ctx.ui.notify(`/realctx2 failed: ${String((e as Error).message ?? e)}`, "error");
        }
      },
    });

    // command output is TUI-only: a custom entry with a renderer never reaches the model
    try {
      const tui = (await import("@earendil-works/pi-tui")) as unknown as { Text: new (text: string, paddingX?: number, paddingY?: number) => unknown };
      pi.registerEntryRenderer(OUTPUT_ENTRY, ((entry: { data?: unknown }, _options: unknown, theme: { fg(color: string, text: string): string }) => {
        const text = String((entry.data as { text?: unknown } | undefined)?.text ?? "");
        return new tui.Text(`${theme.fg("accent", "realctx2")}\n${text}`, 1, 0);
      }) as never);
      this.rendererReady = true;
    } catch {
      // no TUI package in this host: output goes through notifications
    }
  }
}

export default async function realctx2(pi: ExtensionAPI): Promise<void> {
  // processes realctx2 starts itself never load realctx2 again
  if (process.env.REALCTX2_CHILD === "1" || process.env.REALCTX2_DISABLE === "1") return;
  await new PiExtension(pi).install();
}

export { PiAdapter, STATUS_KEY };
