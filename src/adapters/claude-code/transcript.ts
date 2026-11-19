/**
 * Claude Code's transcript file as session entries (§4.6.3): the archive that `t:` and `r:` IDs
 * point at. Entry ids are derived from keys that hooks carry too (prompt id, tool-use id), so
 * an entry seen first through a hook and later in the file keeps one id; the file can lag the
 * live conversation by a turn.
 */
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import type { EntryView, ToolCallView } from "../../core/types.ts";
import { estimateTokens } from "../../util/text.ts";

type Block = { type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };

interface Line {
  type?: string;
  uuid?: string;
  timestamp?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  promptId?: string;
  sessionId?: string;
  message?: { id?: string; role?: string; content?: string | Block[]; usage?: Record<string, number> };
}

export const userId = (promptId: string) => `up_${promptId}`;
export const assistantToolsId = (firstToolUseId: string) => `as_${firstToolUseId}`;
export const assistantTextId = (promptKey: string, k: number) => `at_${promptKey}_${k}`;
export const resultId = (toolUseId: string) => `tr_${toolUseId}`;

function blocksText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Block[]).map((b) => (b?.type === "text" && typeof b.text === "string" ? b.text : b?.type === "image" ? "[image]" : "")).filter(Boolean).join("\n");
}

function entry(e: Partial<EntryView> & Pick<EntryView, "id" | "kind" | "role" | "rawText" | "timestamp">, extraTokens = 0): EntryView {
  const tokens = estimateTokens(e.rawText) + extraTokens;
  return { text: e.rawText, omitted: false, edited: false, tokens, rawTokens: tokens, rawToolCalls: e.toolCalls, ...e };
}

export interface ParsedTranscript {
  /** Every main-thread entry in the file, in order. */
  entries: EntryView[];
  /** Index into `entries` of the latest compaction summary, or -1. */
  compactedAt: number;
  /** Context size of the last request, from the last assistant message's usage. */
  lastRequestTokens: number | null;
  /** Session ids seen on lines of the file (a fork starts with its parent's entries). */
  sessionIds: string[];
}

/** Parse transcript text. Subagent lines (`isSidechain`) and bookkeeping lines are skipped. */
export function parseTranscript(text: string): ParsedTranscript {
  const out: EntryView[] = [];
  let lastRequestTokens: number | null = null;
  const sessionIds: string[] = [];
  let promptKey = "start";
  let textOnly = 0;
  // an assistant message is written one content block per line: group lines by message id
  let group: { msgId: string; uuid: string; timestamp: string; text: string[]; thinking: number; calls: ToolCallView[] } | null = null;
  const flush = () => {
    if (!group) return;
    const g = group;
    group = null;
    const extra = g.thinking + estimateTokens(JSON.stringify(g.calls.map((c) => [c.name, c.args])));
    const id = g.calls.length ? assistantToolsId(g.calls[0]!.id) : assistantTextId(promptKey, textOnly++);
    if (!g.text.length && !g.calls.length) return; // thinking only: nothing the model reads back as text
    out.push(entry({ id, kind: "assistant", role: "assistant", rawText: g.text.join("\n"), timestamp: g.timestamp, toolCalls: g.calls.length ? g.calls : undefined }, g.calls.length ? extra : g.thinking));
  };
  for (const raw of text.split("\n")) {
    if (!raw) continue;
    let line: Line;
    try {
      line = JSON.parse(raw) as Line;
    } catch {
      continue; // a line still being written
    }
    if (line.sessionId && !sessionIds.includes(line.sessionId)) sessionIds.push(line.sessionId);
    if (line.isSidechain || (line.type !== "user" && line.type !== "assistant") || !line.message) continue;
    const ts = line.timestamp ?? "";
    const content = line.message.content;
    if (line.type === "assistant") {
      const msgId = line.message.id ?? line.uuid ?? "";
      if (!group || group.msgId !== msgId) {
        flush();
        group = { msgId, uuid: line.uuid ?? "", timestamp: ts, text: [], thinking: 0, calls: [] };
      }
      const u = line.message.usage;
      if (u) lastRequestTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
      for (const b of Array.isArray(content) ? content : []) {
        if (b.type === "text" && b.text) group.text.push(b.text);
        else if (b.type === "thinking" && b.thinking) group.thinking += estimateTokens(b.thinking);
        else if (b.type === "tool_use" && b.id) group.calls.push({ id: b.id, name: String(b.name ?? ""), args: (b.input && typeof b.input === "object" ? b.input : {}) as Record<string, unknown> });
      }
      continue;
    }
    flush();
    const results = Array.isArray(content) ? content.filter((b) => b.type === "tool_result" && b.tool_use_id) : [];
    if (results.length) {
      for (const b of results) out.push(entry({ id: resultId(b.tool_use_id!), kind: "toolResult", role: "tool", rawText: blocksText(b.content), timestamp: ts, toolCallId: b.tool_use_id, isError: b.is_error === true }));
      continue;
    }
    const body = blocksText(content);
    if (line.isCompactSummary) {
      out.push(entry({ id: `cs_${line.uuid ?? out.length}`, kind: "summary", role: "user", rawText: body, timestamp: ts, fixed: true }));
      continue;
    }
    if (line.isMeta || !body.trim()) continue;
    // local command output and other synthetic user lines are not prompts
    if (/^<(local-command-|command-name|command-message|system-reminder)/.test(body.trim())) continue;
    promptKey = line.promptId ?? line.uuid ?? promptKey;
    textOnly = 0;
    out.push(entry({ id: userId(promptKey), kind: "user", role: "user", rawText: body, timestamp: ts }));
  }
  flush();
  // tool names for results: taken from the call that asked for them
  const names = new Map<string, string>();
  for (const e of out) for (const c of e.toolCalls ?? []) names.set(c.id, c.name);
  for (const e of out) if (e.kind === "toolResult" && e.toolCallId) e.toolName = names.get(e.toolCallId);
  // duplicate ids (a resumed file can repeat a line): the last occurrence keeps its place
  const last = new Map<string, number>();
  out.forEach((e, i) => last.set(e.id, i));
  const unique = out.filter((e, i) => last.get(e.id) === i);
  let at = -1;
  unique.forEach((e, i) => {
    if (e.kind === "summary") at = i;
  });
  return { entries: unique, compactedAt: at, lastRequestTokens, sessionIds };
}

/** Reads a transcript file, re-parsing only when it changed. */
export class TranscriptReader {
  private cache: { path: string; size: number; mtimeMs: number; parsed: ParsedTranscript } | null = null;

  read(path: string | undefined): ParsedTranscript {
    const empty: ParsedTranscript = { entries: [], compactedAt: -1, lastRequestTokens: null, sessionIds: [] };
    if (!path) return empty;
    let st: { size: number; mtimeMs: number };
    try {
      st = statSync(path);
    } catch {
      return empty;
    }
    if (this.cache && this.cache.path === path && this.cache.size === st.size && this.cache.mtimeMs === st.mtimeMs) return this.cache.parsed;
    let text = "";
    try {
      const fd = openSync(path, "r");
      try {
        const size = fstatSync(fd).size;
        const buf = Buffer.alloc(size);
        readSync(fd, buf, 0, size, 0);
        text = buf.toString("utf8");
      } finally {
        closeSync(fd);
      }
    } catch {
      return empty;
    }
    const parsed = parseTranscript(text);
    this.cache = { path, size: st.size, mtimeMs: st.mtimeMs, parsed };
    return parsed;
  }
}
