/**
 * The Claude Code harness adapter (§4.6): level L0, append-only context. Claude Code offers no
 * edits to earlier messages, so the engine consolidates in shadow and realctx2's guidance, cards
 * and path blocks reach the model as `additionalContext` from hooks.
 *
 * Entries come from the transcript file, which can lag the live conversation by a turn; what
 * hooks have already reported is laid over it under the same ids.
 */
import type { Config } from "../../core/config.ts";
import type { Telemetry } from "../../core/telemetry.ts";
import type { AuxSessionRunner, CommandDef, CommitBatch, EntryView, GuidanceMessage, HarnessAdapter, ModelPricing, SessionRecord, ToolCallView, ToolDef } from "../../core/types.ts";
import { randomId8 } from "../../util/ids.ts";
import { estimateTokens } from "../../util/text.ts";
import type { SessionLog } from "./state.ts";
import { assistantTextId, assistantToolsId, resultId, type TranscriptReader, userId } from "./transcript.ts";

/** What a tool returned, as text. PostToolUse hands over each tool's structured output object. */
export function responseText(toolName: string, response: unknown): string {
  if (typeof response === "string") return response;
  if (Array.isArray(response)) return response.map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : typeof b === "string" ? b : "")).filter(Boolean).join("\n");
  if (!response || typeof response !== "object") return response === undefined || response === null ? "" : String(response);
  const r = response as Record<string, unknown>;
  if (typeof r.stdout === "string" || typeof r.stderr === "string") return [r.stdout, r.stderr].filter((x): x is string => typeof x === "string" && x.length > 0).join("\n");
  const file = r.file as { content?: unknown } | undefined;
  if (file && typeof file.content === "string") return file.content;
  if (typeof r.content === "string") return r.content;
  if (Array.isArray(r.content)) return responseText(toolName, r.content);
  if (Array.isArray(r.filenames)) return (r.filenames as unknown[]).map(String).join("\n");
  if (typeof r.filePath === "string" && typeof r.type === "string") return `${r.type === "create" ? "created" : "updated"} ${r.filePath}`;
  if (typeof r.result === "string") return r.result;
  try {
    return JSON.stringify(response);
  } catch {
    return "";
  }
}

function makeEntry(e: Partial<EntryView> & Pick<EntryView, "id" | "kind" | "role" | "rawText" | "timestamp">): EntryView {
  const tokens = estimateTokens(e.rawText) + (e.toolCalls ? estimateTokens(JSON.stringify(e.toolCalls.map((c) => [c.name, c.args]))) : 0);
  return { text: e.rawText, omitted: false, edited: false, tokens, rawTokens: tokens, rawToolCalls: e.toolCalls, ...e };
}

export interface ClaudeAdapterOptions {
  reader: TranscriptReader;
  /** Builds the aux runner once the host's configuration and telemetry are known. */
  aux: (env: { cfg: Config; telemetry: Telemetry }) => AuxSessionRunner;
  now: () => Date;
}

export class ClaudeAdapter implements HarnessAdapter {
  readonly harness = "claude-code" as const;
  capabilities = { level: 0 as const };
  transcriptPath: string | undefined;
  model = "claude";
  log: SessionLog;
  /** Guidance waiting for the next hook that can add context. */
  outbox: string[] = [];
  /** Warnings for the user (`systemMessage` of the next hook output). */
  notices: string[] = [];
  /** Injected messages the engine has not seen an entry for yet are kept in `log.messages`. */
  private overlay: EntryView[] = [];
  /** The assistant message whose tool calls are arriving. */
  private batch: EntryView | null = null;
  private promptKey = "start";
  private stops = 0;
  private readonly o: ClaudeAdapterOptions;
  private cfg: Config | null = null;
  private telemetry: Telemetry | undefined;
  private runner: AuxSessionRunner | null = null;

  constructor(log: SessionLog, o: ClaudeAdapterOptions) {
    this.log = log;
    this.o = o;
  }

  attach(env: { cfg: Config; telemetry: Telemetry }): void {
    this.cfg = env.cfg;
    this.telemetry = env.telemetry;
    // aux calls are logged and counted against the daily budget like any other (§9.3.5)
    this.runner = this.o.aux(env);
  }

  // ───────────── what hooks report, ahead of the transcript
  private stamp(): string {
    return this.o.now().toISOString();
  }

  noteUser(promptId: string | undefined, text: string): void {
    this.batch = null;
    this.promptKey = promptId ?? `p${randomId8()}`;
    this.stops = 0;
    this.overlay.push(makeEntry({ id: userId(this.promptKey), kind: "user", role: "user", rawText: text, timestamp: this.stamp() }));
  }

  noteToolCall(toolUseId: string, name: string, input: Record<string, unknown>): void {
    const call: ToolCallView = { id: toolUseId, name, args: input };
    if (this.batch) {
      if (!this.batch.toolCalls!.some((c) => c.id === toolUseId)) {
        const calls = [...this.batch.toolCalls!, call];
        Object.assign(this.batch, makeEntry({ ...this.batch, toolCalls: calls }));
      }
      return;
    }
    this.batch = makeEntry({ id: assistantToolsId(toolUseId), kind: "assistant", role: "assistant", rawText: "", timestamp: this.stamp(), toolCalls: [call] });
    this.overlay.push(this.batch);
  }

  noteToolResult(toolUseId: string, name: string, text: string, isError: boolean): void {
    const id = resultId(toolUseId);
    const fresh = makeEntry({ id, kind: "toolResult", role: "tool", rawText: text, timestamp: this.stamp(), toolCallId: toolUseId, toolName: name, isError });
    const at = this.overlay.findIndex((e) => e.id === id);
    if (at >= 0) this.overlay[at] = fresh;
    else this.overlay.push(fresh);
  }

  /** PostToolBatch: every call of the assistant message has resolved; the next call starts a new message. */
  endBatch(calls: Array<{ tool_use_id: string; tool_name: string; tool_input?: Record<string, unknown>; tool_response?: unknown }>): void {
    for (const c of calls) {
      if (!c.tool_use_id) continue;
      this.noteToolCall(c.tool_use_id, c.tool_name, c.tool_input ?? {});
      // the serialized result is what the model receives
      if (c.tool_response !== undefined) this.noteToolResult(c.tool_use_id, c.tool_name, responseText(c.tool_name, c.tool_response), this.overlay.find((e) => e.id === resultId(c.tool_use_id))?.isError === true);
    }
    this.batch = null;
  }

  noteStop(text: string | undefined): void {
    this.batch = null;
    if (text?.trim()) this.overlay.push(makeEntry({ id: assistantTextId(this.promptKey, this.stops), kind: "assistant", role: "assistant", rawText: text, timestamp: this.stamp() }));
    this.stops++;
  }

  // ───────────── reading
  private merged(): { entries: EntryView[]; compactedAt: number; requestTokens: number | null } {
    const t = this.o.reader.read(this.transcriptPath);
    const ids = new Set(t.entries.map((e) => e.id));
    const calls = new Set(t.entries.flatMap((e) => (e.toolCalls ?? []).map((c) => c.id)));
    // what the file holds now no longer needs the overlay; text-only prompts match by content too
    const prompts = new Set(t.entries.filter((e) => e.kind === "user").map((e) => e.rawText.trim()));
    this.overlay = this.overlay.filter((o) => {
      if (ids.has(o.id)) return false;
      if (o.kind === "assistant" && o.toolCalls?.some((c) => calls.has(c.id))) return false;
      if (o.kind === "user" && prompts.has(o.rawText.trim()) && o !== this.overlay.at(-1)) return false;
      return true;
    });
    const entries = [...t.entries, ...this.overlay];
    // guidance realctx2 injected sits right after the entry that was last at the time
    const index = new Map(entries.map((e, i) => [e.id, i]));
    const placed: Array<{ at: number; seq: number; e: EntryView }> = [];
    this.log.messages.forEach((m, seq) => {
      const at = m.after === "" ? -1 : (index.get(m.after) ?? entries.length);
      placed.push({ at, seq, e: makeEntry({ id: m.id, kind: "custom_message", role: "user", rawText: m.content, timestamp: m.timestamp, customType: m.customType, details: m.details }) });
    });
    const out: EntryView[] = [];
    let compactedAt = -1;
    const before = placed.filter((p) => p.at === -1).sort((a, b) => a.seq - b.seq);
    for (const p of before) out.push(p.e);
    entries.forEach((e, i) => {
      if (i === t.compactedAt) compactedAt = out.length;
      out.push(e);
      for (const p of placed) if (p.at === i) out.push(p.e);
    });
    for (const p of placed) if (p.at >= entries.length) out.push(p.e);
    return { entries: out, compactedAt, requestTokens: t.lastRequestTokens };
  }

  /** The context as Claude Code holds it: from its latest compaction summary on. */
  async listEntries(): Promise<EntryView[]> {
    const m = this.merged();
    return m.compactedAt > 0 ? m.entries.slice(m.compactedAt) : m.entries;
  }

  async archiveEntries(): Promise<EntryView[]> {
    return this.merged().entries;
  }

  async listRecords(): Promise<SessionRecord[]> {
    return [...this.log.records];
  }

  async requestTokens(): Promise<number | null> {
    return this.o.reader.read(this.transcriptPath).lastRequestTokens;
  }

  maxContextTokens(): number {
    return /\[1m\]|-1m\b/i.test(this.model) ? 1_000_000 : 200_000;
  }

  pricing(): ModelPricing | null {
    return null; // Claude Code does not expose prices; nothing here depends on them (no in-place folds)
  }

  modelName(): string {
    return this.model;
  }

  // ───────────── writing: records to the session log, guidance to the next hook output
  async commit(batch: CommitBatch): Promise<void> {
    for (const r of batch.records) this.log.append(r);
    for (const m of batch.messages) this.injectMessage(m);
    // edits are not applied: consolidation takes effect when Claude Code compacts (§4.6.3)
  }

  injectMessage(m: GuidanceMessage): void {
    const last = this.merged().entries.at(-1);
    this.log.inject({ type: "realctx2.message", id: `gd_${randomId8()}`, after: last?.id ?? "", customType: m.customType, content: m.content, details: m.details, timestamp: this.stamp() });
    this.outbox.push(m.content);
  }

  /** Text for `additionalContext`, phrased as facts about the session's state (§4.6.2). */
  takeOutbox(): string | undefined {
    if (!this.outbox.length) return undefined;
    return this.outbox.splice(0).join("\n\n");
  }

  takeNotices(): string | undefined {
    if (!this.notices.length) return undefined;
    return this.notices.splice(0).join("\n");
  }

  registerTool(_def: ToolDef): void {
    // tools are listed by the MCP server; Claude Code prefixes their names, so they cannot clash (§8.1.3)
  }

  registerCommand(_def: CommandDef): void {
    // commands are plugin skills (`/realctx2:<command>`)
  }

  aux(): AuxSessionRunner {
    if (!this.runner) throw new Error("the aux runner is created when the host attaches");
    return this.runner;
  }

  notify(text: string, level: "info" | "warning" | "error" = "info"): void {
    if (level !== "info") this.notices.push(text);
    this.telemetry?.event("cc.notice", { level });
  }

  setStatus(): void {
    // no status line API for plugins
  }

  get config(): Config | null {
    return this.cfg;
  }
}
