import type { AuxSessionRunner, CommitBatch, EntryView, HarnessAdapter, ModelPricing, SessionRecord, ToolCallView } from "../../src/core/types.ts";
import { BlobStore } from "../../src/context/archive.ts";
import { ContextEngine, type PendingDelivery } from "../../src/context/engine.ts";
import type { PathEvent } from "../../src/memory/delivery.ts";
import { MemoryRuntime } from "../../src/memory/runtime.ts";
import { estimateTokens } from "../../src/util/text.ts";
import { analyzeCommand } from "../../src/util/shell.ts";
import { FakeAux, FakeDecision, type World } from "./fakes.ts";

interface Raw {
  id: string;
  kind: EntryView["kind"];
  text: string;
  toolCalls?: ToolCallView[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  customType?: string;
  details?: unknown;
  timestamp: string;
}

/** An in-memory harness with persisted per-entry edits (level L2, like pi) or append-only (L0). */
export class FakeHarness implements HarnessAdapter {
  readonly harness = "test" as const;
  capabilities: { level: 0 | 1 | 2 };
  raw: Raw[] = [];
  edits = new Map<string, string | null>();
  records: SessionRecord[] = [];
  /** Every committed batch, for assertions on what broke the cache and when. */
  batches: CommitBatch[] = [];
  notices: Array<{ text: string; level?: string }> = [];
  contextWindow = 200_000;
  systemTokens = 3000;
  price: ModelPricing | null = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
  lastCacheWriteAt?: () => number | null;
  readonly auxRunner: AuxSessionRunner;
  private seq = 0;
  private t = Date.parse("2026-11-20T10:00:00.000Z");

  constructor(aux: AuxSessionRunner, level: 0 | 1 | 2 = 2) {
    this.auxRunner = aux;
    this.capabilities = { level };
  }

  private add(r: Omit<Raw, "id" | "timestamp">): string {
    const id = `e${String(++this.seq).padStart(3, "0")}`;
    this.t += 1000;
    this.raw.push({ ...r, id, timestamp: new Date(this.t).toISOString() });
    return id;
  }

  user(text: string): string {
    return this.add({ kind: "user", text });
  }

  assistant(text: string, calls: Array<{ name: string; args: Record<string, unknown> }> = []): { id: string; calls: ToolCallView[] } {
    const toolCalls = calls.map((c, i) => ({ id: `call-${this.seq + 1}-${i}`, name: c.name, args: c.args }));
    const id = this.add({ kind: "assistant", text, toolCalls: toolCalls.length ? toolCalls : undefined });
    return { id, calls: toolCalls };
  }

  result(call: ToolCallView, text: string, isError = false): string {
    return this.add({ kind: "toolResult", text, toolCallId: call.id, toolName: call.name, isError });
  }

  maxContextTokens(): number {
    return this.contextWindow;
  }

  async listEntries(): Promise<EntryView[]> {
    return this.raw.map((r) => {
      const edited = this.edits.has(r.id);
      const replacement = this.edits.get(r.id);
      const omitted = edited && replacement === null;
      const text = omitted ? "" : edited ? (replacement as string) : r.text;
      return {
        id: r.id,
        kind: r.kind,
        role: r.kind === "assistant" ? "assistant" : r.kind === "toolResult" ? "tool" : "user",
        text,
        rawText: r.text,
        omitted,
        edited: edited && !omitted,
        toolCalls: edited ? undefined : r.toolCalls,
        rawToolCalls: r.toolCalls,
        toolCallId: r.toolCallId,
        toolName: r.toolName,
        isError: r.isError,
        customType: r.customType,
        details: r.details,
        timestamp: r.timestamp,
        tokens: omitted ? 0 : estimateTokens(text) + (edited ? 0 : estimateTokens(JSON.stringify(r.toolCalls ?? ""))),
        rawTokens: estimateTokens(r.text),
      };
    });
  }

  async listRecords(): Promise<SessionRecord[]> {
    return [...this.records];
  }

  async requestTokens(): Promise<number> {
    const entries = await this.listEntries();
    return this.systemTokens + entries.reduce((s, e) => s + e.tokens, 0);
  }

  async commit(batch: CommitBatch): Promise<void> {
    this.batches.push(batch);
    this.records.push(...batch.records);
    if (this.capabilities.level > 0) for (const e of batch.edits) this.edits.set(e.targetId, e.replacement);
    for (const m of batch.messages) this.add({ kind: "custom_message", text: m.content, customType: m.customType, details: m.details });
  }

  registerTool(): void {}
  registerCommand(): void {}
  aux(): AuxSessionRunner {
    return this.auxRunner;
  }
  pricing(): ModelPricing | null {
    return this.price;
  }
  auxPrice: ModelPricing | null = null;
  auxPricing(): ModelPricing | null {
    return this.auxPrice;
  }
  modelName(): string {
    return "test/main";
  }
  notify(text: string, level?: "info" | "warning" | "error"): void {
    this.notices.push({ text, level });
  }

  /** What the model would see: projected, non-omitted entries. */
  async visible(): Promise<EntryView[]> {
    return (await this.listEntries()).filter((e) => !e.omitted);
  }

  async contextText(): Promise<string> {
    return (await this.visible()).map((e) => e.text).join("\n");
  }
}

export interface ToolStep {
  name: string;
  args: Record<string, unknown>;
  output: string;
  isError?: boolean;
  /** Deliveries a realctx2 tool would report. */
  deliveries?: PendingDelivery[];
}

/** Drives an engine through a harness the way pi's events would. */
export class Session {
  readonly h: FakeHarness;
  readonly engine: ContextEngine;
  readonly decision: FakeDecision;
  readonly aux: FakeAux;
  readonly cwd: string;
  blocked: string[] = [];

  constructor(o: { world?: World; level?: 0 | 1 | 2; cfg?: World["cfg"]; decision?: FakeDecision; aux?: FakeAux; memory?: MemoryRuntime | null; light?: boolean; sessionId?: string; engine?: ContextEngine; harness?: FakeHarness; cwd?: string }) {
    this.decision = o.decision ?? o.world?.decision ?? new FakeDecision();
    this.aux = o.aux ?? o.world?.aux ?? new FakeAux();
    this.h = o.harness ?? new FakeHarness(this.aux, o.level ?? 2);
    this.cwd = o.cwd ?? o.world?.cwd ?? process.cwd();
    // an engine built elsewhere (a Host) is driven as is
    if (o.engine) {
      this.engine = o.engine;
      return;
    }
    const cfg = o.cfg ?? o.world!.cfg;
    this.engine = new ContextEngine({ adapter: this.h, cfg, decision: this.decision, sessionId: o.sessionId ?? "sess-test", memory: o.memory === undefined ? null : o.memory, blobs: new BlobStore(null), light: o.light, clock: o.world?.clock });
  }

  /** Run one of realctx2's own tools as a harness would: execute, then report its deliveries with the result. */
  async tool(def: { name: string; execute(params: Record<string, unknown>, ctx: { toolCallId?: string }): Promise<{ text: string; details?: unknown; isError?: boolean }> }, params: Record<string, unknown>, say = "using a tool"): Promise<{ text: string; details: Record<string, unknown>; isError: boolean; batch: CommitBatch }> {
    const a = this.h.assistant(say, [{ name: def.name, args: params }]);
    const call = a.calls[0]!;
    await this.engine.onToolCall({ toolCallId: call.id, own: true });
    const res = await def.execute(params, { toolCallId: call.id });
    const details = (res.details ?? {}) as Record<string, unknown>;
    const patched = await this.engine.onToolResult({ toolCallId: call.id, toolName: def.name, text: res.text, isError: res.isError === true, own: true, deliveries: details.deliveries as PendingDelivery[] | undefined });
    this.h.result(call, patched?.text ?? res.text, res.isError);
    const batch = await this.engine.onTurnEnd();
    await this.h.commit(batch);
    return { text: res.text, details, isError: res.isError === true, batch };
  }

  async start(): Promise<void> {
    await this.engine.onSessionStart();
  }

  /** A user message: Janus runs first, then the message and the guidance land in the transcript. */
  async user(text: string): Promise<CommitBatch> {
    const batch = await this.engine.onUserMessage(text);
    this.h.user(text);
    await this.h.commit(batch);
    return batch;
  }

  eventFor(name: string, args: Record<string, unknown>): PathEvent | undefined {
    const mem = this.engine.memory;
    const rel = (p: unknown) => (typeof p === "string" && mem ? (mem.paths.rel(p) ?? undefined) : undefined);
    if (name === "read") return rel(args.path) !== undefined ? { action: "read", paths: [rel(args.path)!] } : undefined;
    if (name === "edit" || name === "write") return rel(args.path) !== undefined ? { action: "edit", paths: [rel(args.path)!] } : undefined;
    if (name === "bash" && typeof args.command === "string") {
      const effects = analyzeCommand(args.command, { cwd: this.cwd });
      const paths = mem ? [...effects.touched, ...effects.cds].map((p) => mem.paths.rel(p)).filter((p): p is string => !!p) : [];
      return { action: "command", paths: [...new Set(paths)], command: args.command, effects };
    }
    return undefined;
  }

  /** One model response with tool calls: gate, tools, results, then the turn-end commit point. */
  async round(text: string, tools: ToolStep[], opts: { beforeTurnEnd?: () => Promise<void> | void } = {}): Promise<CommitBatch> {
    const a = this.h.assistant(text, tools.map((t) => ({ name: t.name, args: t.args })));
    for (let i = 0; i < tools.length; i++) {
      const t = tools[i]!;
      const call = a.calls[i]!;
      const event = this.eventFor(t.name, t.args);
      const own = ["search", "recall", "inspect", "remember", "forget"].includes(t.name);
      const gate = await this.engine.onToolCall({ toolCallId: call.id, event, own });
      if (gate) {
        this.blocked.push(gate.block);
        this.h.result(call, gate.block, true);
        continue;
      }
      const patched = await this.engine.onToolResult({ toolCallId: call.id, toolName: t.name, text: t.output, isError: t.isError === true, event, own, deliveries: t.deliveries });
      this.h.result(call, patched?.text ?? t.output, t.isError);
    }
    await opts.beforeTurnEnd?.();
    const batch = await this.engine.onTurnEnd();
    await this.h.commit(batch);
    return batch;
  }

  /** The model's final response of a run (no tool calls), then settle. */
  async finish(text: string): Promise<CommitBatch> {
    this.h.assistant(text);
    const end = await this.engine.onTurnEnd();
    await this.h.commit(end);
    const settle = await this.engine.onBeforeSettle();
    await this.h.commit(settle);
    return { records: [...end.records, ...settle.records], edits: [...end.edits, ...settle.edits], messages: [...end.messages, ...settle.messages] };
  }

  /** Let background consolidation finish, then pass one commit point. */
  async drain(): Promise<void> {
    await this.engine.settleBackground();
  }
}

export function filler(words: number, tag: string): string {
  return Array.from({ length: words }, (_, i) => `${tag}${i}`).join(" ");
}
