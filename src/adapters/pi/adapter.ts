/**
 * The pi harness adapter (§4.1–4.5): level L2, persisted per-message context edits.
 * It reads the session through `ctx.sessionManager`, and writes through boundary returns
 * (`turn_end`, `agent_before_settle`), `pi.appendEntry` and `pi.sendMessage`.
 */
import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { catalogContextWindow } from "../../core/catalog.ts";
import { type Config, effectiveMaxWindow } from "../../core/config.ts";
import type { Telemetry } from "../../core/telemetry.ts";
import type { AuxRole, AuxSessionRunner, CommandDef, CommitBatch, ContextEdit, EntryView, HarnessAdapter, ModelPricing, SessionRecord, ToolDef } from "../../core/types.ts";
import type { MemoryRuntime, SessionEntry as RegisteredSession } from "../../memory/runtime.ts";
import { PiAuxRunner } from "./aux.ts";
import { archiveEntries, branchRecords, projectedEntries, replacementFor } from "./entries.ts";

export const STATUS_KEY = "realctx2";

/** Entry drafts a boundary handler returns (pi `SessionBoundaryDraft`). */
export type Draft =
  | { type: "custom"; customType: string; data?: unknown }
  | { type: "custom_message"; customType: string; content: string; display: boolean; details?: unknown }
  | { type: "context_edit"; targetId: string; replacement: { content: unknown } | null };

export interface PiAdapterOptions {
  pi: ExtensionAPI;
  memory: () => MemoryRuntime | null;
  ownTools: () => ToolDef[];
}

export class PiAdapter implements HarnessAdapter {
  readonly harness = "pi" as const;
  capabilities = { level: 2 as const };
  ctx: ExtensionContext | null = null;
  /** Tool names that could not be registered or were replaced, with the reason. */
  readonly conflicts = new Map<string, string>();
  readonly registered = new Map<string, ToolDef>();
  /** Records and edits waiting for the next boundary (pi persists `context_edit` only there, §4.4). */
  deferred: CommitBatch = { records: [], edits: [], messages: [] };
  private readonly o: PiAdapterOptions;
  private runner: PiAuxRunner | null = null;
  private cfg: Config | null = null;
  private telemetry: Telemetry | undefined;

  constructor(o: PiAdapterOptions) {
    this.o = o;
  }

  /** A new session's host: its configuration, and a fresh aux runner for it. */
  attach(env: { cfg: Config; telemetry: Telemetry }): void {
    this.cfg = env.cfg;
    this.telemetry = env.telemetry;
    this.runner = null;
    this.registered.clear();
    this.conflicts.clear();
    this.deferred = { records: [], edits: [], messages: [] };
  }

  /** Drop records, edits and messages queued for a branch or session that is no longer active. */
  clearDeferred(): void {
    this.deferred = { records: [], edits: [], messages: [] };
  }

  bind(ctx: ExtensionContext): void {
    this.ctx = ctx;
  }

  private need(): ExtensionContext {
    if (!this.ctx) throw new Error("realctx2: no pi context yet");
    return this.ctx;
  }

  // ───────────── reading
  maxContextTokens(): number {
    const ctx = this.ctx;
    if (!ctx) return 0;
    // Context usage carries the resolved physical model's contextWindow (including routed virtual models).
    try {
      const usageWindow = ctx.getContextUsage()?.contextWindow;
      if (typeof usageWindow === "number" && usageWindow > 0) return usageWindow;
    } catch {
      // ignore
    }
    const model = ctx.model;
    if (model && typeof model.contextWindow === "number" && model.contextWindow > 0) return model.contextWindow;
    if (model?.provider && model?.id) {
      try {
        const reg = ctx.modelRegistry.find(model.provider, model.id);
        if (reg && typeof reg.contextWindow === "number" && reg.contextWindow > 0) return reg.contextWindow;
      } catch {
        // ignore
      }
      const fromCatalog = catalogContextWindow(model.id, model.provider);
      if (fromCatalog > 0) return fromCatalog;
    }
    return 0;
  }

  async listEntries(): Promise<EntryView[]> {
    return projectedEntries(this.need().sessionManager);
  }

  async archiveEntries(): Promise<EntryView[]> {
    return archiveEntries(this.need().sessionManager.getBranch());
  }

  async listRecords(): Promise<SessionRecord[]> {
    return branchRecords(this.need().sessionManager.getBranch());
  }

  async requestTokens(): Promise<number | null> {
    try {
      return this.need().getContextUsage()?.tokens ?? null;
    } catch {
      return null;
    }
  }

  pricing(): ModelPricing | null {
    const c = this.ctx?.model?.cost;
    return c ? { input: c.input, output: c.output, cacheRead: c.cacheRead, cacheWrite: c.cacheWrite } : null;
  }

  auxPricing(role: AuxRole): ModelPricing | null {
    return this.runner?.pricing(role) ?? null;
  }

  modelName(): string {
    const m = this.ctx?.model;
    return m ? `${m.provider}/${m.id}` : "unknown";
  }

  // ───────────── writing
  /** Entry drafts for a boundary return, including what was deferred since the last one. */
  drafts(batch: CommitBatch): Draft[] {
    const sm = this.need().sessionManager;
    const all: CommitBatch = { records: [...this.deferred.records, ...batch.records], edits: [...this.deferred.edits, ...batch.edits], messages: [...this.deferred.messages, ...batch.messages] };
    this.deferred = { records: [], edits: [], messages: [] };
    const out: Draft[] = [];
    for (const r of all.records) {
      const { type, ...data } = r;
      out.push({ type: "custom", customType: type, data });
    }
    // the latest edit per target wins; a target that is not on the active branch is skipped, so
    // one bad or stale-branch edit cannot make pi reject the whole proposal or mutate another branch
    const branchIds = new Set(sm.getBranch().map((x) => x.id));
    const edits = new Map<string, ContextEdit>();
    for (const e of all.edits) edits.set(e.targetId, e);
    for (const e of edits.values()) {
      if (!branchIds.has(e.targetId)) {
        this.telemetry?.event("pi.edit_skipped", { reason: "target not on active branch" });
        continue;
      }
      const target = sm.getEntry(e.targetId) as SessionEntry | undefined;
      const role = target?.type === "message" ? (target.message as { role: string }).role : null;
      const editable = target?.type === "custom_message" || role === "user" || role === "assistant" || role === "toolResult";
      if (!editable) {
        this.telemetry?.event("pi.edit_skipped", { reason: target ? `entry type ${target.type}${role ? `/${role}` : ""}` : "no such entry" });
        continue;
      }
      out.push({ type: "context_edit", targetId: e.targetId, replacement: replacementFor(target, e) });
    }
    for (const m of all.messages) out.push({ type: "custom_message", customType: m.customType, content: m.content, display: m.display, details: m.details });
    return out;
  }

  /** Outside a boundary: records and guidance are appended at once; edits wait for the next boundary. */
  async commit(batch: CommitBatch): Promise<void> {
    const pi = this.o.pi;
    for (const r of batch.records) {
      const { type, ...data } = r;
      try {
        pi.appendEntry(type, data);
      } catch (e) {
        this.deferred.records.push(r);
        this.telemetry?.event("pi.append_failed", { error: String((e as Error).message ?? e) });
      }
    }
    this.deferred.edits.push(...batch.edits);
    for (const m of batch.messages) {
      try {
        pi.sendMessage({ customType: m.customType, content: m.content, display: m.display, details: m.details }, { deliverAs: "nextTurn" });
      } catch {
        this.deferred.messages.push(m);
      }
    }
  }

  // ───────────── tools and commands (§8.1.3)
  /** The source pi reports for tools this extension instance registered (learned from the first one). */
  private ownSource: string | null = null;

  private allTools(): ReturnType<ExtensionAPI["getAllTools"]> | null {
    try {
      return this.o.pi.getAllTools();
    } catch {
      return null; // during extension loading pi cannot tell yet
    }
  }

  /** Who else uses a tool name, or null when it is free or ours. */
  private takenBy(name: string, registeredByUs: boolean): string | null {
    const tool = this.allTools()?.find((t) => t.name === name);
    if (!tool) return null;
    const path = tool.sourceInfo?.path ?? "";
    // If we already know our own extension source path, a tool registered under that same path is ours
    // (e.g. if `session_start` runs again on the same extension instance).
    if (this.ownSource !== null && path === this.ownSource) return null;
    // before we register a name, whoever holds it is someone else; afterwards, a different source replaced ours
    if (registeredByUs && this.ownSource === null) return null;
    return tool.sourceInfo?.source === "builtin" ? `pi's built-in tool (${path})` : `another extension (${path || tool.sourceInfo?.source || "unknown"})`;
  }

  registerTool(def: ToolDef): void {
    const taken = this.takenBy(def.name, false);
    if (taken) {
      // registering would silently replace someone's tool: skip ours and say so
      this.conflicts.set(def.key, `tool name "${def.name}" is already used by ${taken}: realctx2's ${def.key} tool was not registered (rename it with tools.names in config.json)`);
      return;
    }
    this.conflicts.delete(def.key);
    this.registered.set(def.key, def);
    this.o.pi.registerTool({
      name: def.name,
      label: def.label,
      description: def.description,
      promptSnippet: def.promptSnippet,
      promptGuidelines: def.promptGuidelines,
      // plain JSON Schema: pi validates tool arguments as JSON Schema, whatever built the schema
      parameters: def.parameters as never,
      annotations: { readOnlyHint: def.readOnly, destructiveHint: def.key === "forget", openWorldHint: false },
      execute: async (toolCallId, params, signal) => {
        const res = await def.execute((params ?? {}) as Record<string, unknown>, { toolCallId, signal, nested: toolCallId.includes("/") });
        return { content: [{ type: "text" as const, text: res.text }], details: res.details as never, isError: res.isError };
      },
    });
    this.ownSource ??= this.allTools()?.find((t) => t.name === def.name)?.sourceInfo?.path ?? null;
  }

  /** After every extension has loaded: a name that now belongs to another source was replaced. */
  recheckTools(): string[] {
    const fresh: string[] = [];
    for (const [key, def] of this.registered) {
      const taken = this.takenBy(def.name, true);
      if (taken && !this.conflicts.has(key)) {
        const msg = `tool name "${def.name}" now belongs to ${taken}: it replaced realctx2's ${key} tool (rename ours with tools.names in config.json)`;
        this.conflicts.set(key, msg);
        fresh.push(msg);
      }
    }
    return fresh;
  }

  registerCommand(_def: CommandDef): void {
    // the command is registered once by the extension factory; nothing to do per session
  }

  // ───────────── aux sessions (§9.3)
  aux(): AuxSessionRunner {
    const cfg = this.cfg;
    if (!cfg) throw new Error("realctx2: configuration not loaded yet");
    this.runner ??= new PiAuxRunner(
      cfg,
      {
        registry: () => this.ctx?.modelRegistry ?? null,
        model: () => this.ctx?.model,
        cwd: () => this.ctx?.cwd ?? process.cwd(),
        root: () => this.o.memory()?.project.root ?? null,
        memory: () => this.o.memory(),
        ownTools: () => this.o.ownTools(),
      },
      this.telemetry,
    );
    return this.runner;
  }

  // ───────────── UI
  notify(text: string, level: "info" | "warning" | "error" = "info"): void {
    try {
      this.ctx?.ui.notify(text, level);
    } catch {
      // no UI in this mode
    }
  }

  setStatus(text: string | undefined): void {
    try {
      this.ctx?.ui.setStatus(STATUS_KEY, text);
    } catch {
      // no UI in this mode
    }
  }

  /** pi's auto-compaction threshold against ρW: realctx2 has to act first (§5.4.5). */
  compactionNote(): string | null {
    const cfg = this.cfg;
    const window = this.maxContextTokens();
    if (!cfg || !window) return null;
    let settings: { compaction?: { enabled?: boolean; reserveTokens?: number } } = {};
    try {
      settings = this.o.pi.getSettings() as typeof settings;
    } catch {
      return null;
    }
    if (settings.compaction?.enabled === false) return null;
    const threshold = window - (settings.compaction?.reserveTokens ?? 16384);
    const W = effectiveMaxWindow(cfg, window, this.modelName());
    if (W <= 0) return null;
    const pressure = cfg.context.rho * W;
    return threshold < pressure ? `pi's auto-compaction starts at ${threshold} tokens, below realctx2's pressure threshold of ${Math.round(pressure)} (ρW): pi would compact before realctx2 folds. Lower context.maxWindow or context.rho, or raise pi's compaction.reserveTokens headroom.` : null;
  }
}

/**
 * An earlier session of this project, read from its pi session file (§5.6): the branch that
 * ends at the last entry of the file.
 */
export function loadPiSession(session: RegisteredSession): { entries: EntryView[]; records: SessionRecord[] } | null {
  if (!session.file) return null;
  let text: string;
  try {
    text = readFileSync(session.file, "utf8");
  } catch {
    return null;
  }
  const byId = new Map<string, SessionEntry>();
  let last: SessionEntry | null = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { type?: string; id?: unknown };
      if (e.type === "session" || typeof e.id !== "string") continue;
      byId.set(e.id, e as SessionEntry);
      last = e as SessionEntry;
    } catch {
      // a torn last line
    }
  }
  if (!last) return null;
  const branch: SessionEntry[] = [];
  const seen = new Set<string>();
  for (let cur: SessionEntry | undefined = last; cur && !seen.has(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
    seen.add(cur.id);
    branch.unshift(cur);
  }
  return { entries: archiveEntries(branch), records: branchRecords(branch) };
}
