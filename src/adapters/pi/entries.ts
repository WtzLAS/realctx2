/**
 * pi session entries as the engine sees them (§4.3, §5.1): the active branch as projected
 * (context edits applied), the raw archive view, and realctx2's own records.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ContextEditEntry, ProjectedSessionEntry, SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { GUIDANCE_TYPE } from "../../context/render.ts";
import type { ContextEdit, EntryView, SessionRecord, ToolCallView } from "../../core/types.ts";
import { RECORD_TYPES } from "../../core/types.ts";
import { GENERIC_IMAGE_COST, type ImageCost, imageCostFor, type ImageModel, imageTokens } from "../../util/images.ts";
import { estimateTokens } from "../../util/text.ts";

type Part = { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown; data?: unknown };

function partsText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const p of content as Part[]) {
    if (p?.type === "text" && typeof p.text === "string") out.push(p.text);
    else if (p?.type === "image") out.push("[image]");
  }
  return out.join("\n");
}

/** Everything in a message that costs context tokens: text, thinking, tool-call arguments and images. */
function partsTokens(content: unknown, imgCost: ImageCost): number {
  if (typeof content === "string") return estimateTokens(content);
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const p of content as Part[]) {
    if (p?.type === "text" && typeof p.text === "string") n += estimateTokens(p.text);
    else if (p?.type === "thinking" && typeof p.thinking === "string") n += estimateTokens(p.thinking);
    else if (p?.type === "toolCall") n += estimateTokens(`${p.name ?? ""}${JSON.stringify(p.arguments ?? {})}`) + 8;
    else if (p?.type === "image") n += imageTokens(p, imgCost);
  }
  return n;
}

function toolCalls(content: unknown): ToolCallView[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const calls = (content as Part[]).filter((p) => p?.type === "toolCall" && typeof p.id === "string").map((p) => ({ id: p.id!, name: String(p.name ?? ""), args: (p.arguments && typeof p.arguments === "object" ? p.arguments : {}) as Record<string, unknown> }));
  return calls.length ? calls : undefined;
}

interface Shape {
  kind: EntryView["kind"];
  role: EntryView["role"];
  text: string;
  tokens: number;
  toolCalls?: ToolCallView[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  customType?: string;
  details?: unknown;
}

const COMPACTION_PREFIX = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";

function messageShape(m: AgentMessage, imgCost: ImageCost): Shape | null {
  const msg = m as { role: string; content?: unknown; [k: string]: unknown };
  switch (msg.role) {
    case "user":
      return { kind: "user", role: "user", text: partsText(msg.content), tokens: partsTokens(msg.content, imgCost) };
    case "assistant":
      return { kind: "assistant", role: "assistant", text: partsText(msg.content), tokens: partsTokens(msg.content, imgCost), toolCalls: toolCalls(msg.content) };
    case "toolResult":
      return { kind: "toolResult", role: "tool", text: partsText(msg.content), tokens: partsTokens(msg.content, imgCost), toolCallId: String(msg.toolCallId ?? ""), toolName: typeof msg.toolName === "string" ? msg.toolName : undefined, isError: msg.isError === true };
    case "custom":
      return { kind: "custom_message", role: "user", text: partsText(msg.content), tokens: partsTokens(msg.content, imgCost), customType: typeof msg.customType === "string" ? msg.customType : undefined, details: msg.details };
    case "bashExecution": {
      if (msg.excludeFromContext === true) return null;
      const text = `Ran \`${String(msg.command ?? "")}\`\n${String(msg.output ?? "")}`;
      return { kind: "other", role: "user", text, tokens: estimateTokens(text) };
    }
    case "compactionSummary": {
      const text = `${COMPACTION_PREFIX}${String(msg.summary ?? "")}\n</summary>`;
      return { kind: "summary", role: "user", text, tokens: estimateTokens(text) };
    }
    case "branchSummary": {
      const text = String(msg.summary ?? "");
      return { kind: "summary", role: "user", text, tokens: estimateTokens(text) };
    }
    default:
      return null;
  }
}

/** The raw contribution of a session entry, before any context edit. Null for state-only entries. */
function rawShape(entry: SessionEntry, imgCost: ImageCost = GENERIC_IMAGE_COST): Shape | null {
  switch (entry.type) {
    case "message":
      return messageShape(entry.message, imgCost);
    case "custom_message":
      return { kind: "custom_message", role: "user", text: partsText(entry.content), tokens: partsTokens(entry.content, imgCost), customType: entry.customType, details: entry.details };
    case "compaction":
      return { kind: "summary", role: "user", text: entry.summary, tokens: estimateTokens(entry.summary) + 30 };
    case "branch_summary":
      return { kind: "summary", role: "user", text: entry.summary, tokens: estimateTokens(entry.summary) + 30 };
    default:
      return null;
  }
}

function latestEdits(branch: SessionEntry[]): Map<string, ContextEditEntry> {
  const edits = new Map<string, ContextEditEntry>();
  for (const e of branch) if (e.type === "context_edit") edits.set(e.targetId, e);
  return edits;
}

function view(entry: SessionEntry, raw: Shape, projected: AgentMessage[] | null, edit: ContextEditEntry | undefined, imgCost: ImageCost): EntryView {
  const omitted = projected !== null ? projected.length === 0 : edit?.replacement === null;
  const edited = !omitted && !!edit && edit.replacement !== null;
  let text = raw.text;
  let tokens = raw.tokens;
  let calls = raw.toolCalls;
  if (omitted) {
    text = "";
    tokens = 0;
    calls = undefined;
  } else if (projected && (edited || projected.length !== 1)) {
    const shapes = projected.map((m) => messageShape(m, imgCost)).filter((s): s is Shape => s !== null);
    text = shapes.map((s) => s.text).join("\n");
    tokens = shapes.reduce((n, s) => n + s.tokens, 0);
    calls = shapes.flatMap((s) => s.toolCalls ?? []);
    if (!calls.length) calls = undefined;
  } else if (edited && edit?.replacement) {
    // no projection at hand (archive view): read the replacement itself
    text = partsText(edit.replacement.content);
    tokens = partsTokens(edit.replacement.content, imgCost);
    calls = toolCalls(edit.replacement.content);
  }
  return {
    id: entry.id,
    kind: raw.kind,
    role: raw.role,
    text,
    rawText: raw.text,
    omitted,
    edited,
    // pi edits user, assistant, tool-result and custom messages only
    fixed: raw.kind === "summary" || raw.kind === "other" ? true : undefined,
    toolCalls: calls,
    rawToolCalls: raw.toolCalls,
    toolCallId: raw.toolCallId,
    toolName: raw.toolName,
    isError: raw.isError,
    customType: raw.customType,
    details: raw.details,
    timestamp: entry.timestamp,
    tokens,
    rawTokens: raw.tokens,
  };
}

/** The active branch as the model sees it: compaction applied, context edits applied. */
export function projectedEntries(sm: Pick<SessionManager, "buildSessionProjection" | "getBranch">, model?: ImageModel): EntryView[] {
  const imgCost = model ? imageCostFor(model) : GENERIC_IMAGE_COST;
  const projection = sm.buildSessionProjection();
  const edits = latestEdits(sm.getBranch());
  const out: EntryView[] = [];
  for (const p of projection.entries as ProjectedSessionEntry[]) {
    const raw = rawShape(p.sourceEntry, imgCost);
    if (!raw) continue;
    out.push(view(p.sourceEntry, raw, p.messages, edits.get(p.sourceEntry.id), imgCost));
  }
  return out;
}

/** Every context-producing entry of the branch, raw: what `recall` opens, compactions included. */
export function archiveEntries(branch: SessionEntry[], model?: ImageModel): EntryView[] {
  const imgCost = model ? imageCostFor(model) : GENERIC_IMAGE_COST;
  const edits = latestEdits(branch);
  const out: EntryView[] = [];
  for (const e of branch) {
    const raw = rawShape(e, imgCost);
    if (raw) out.push(view(e, raw, null, edits.get(e.id), imgCost));
  }
  return out;
}

const RECORDS = new Set<string>(RECORD_TYPES);

/**
 * realctx2's records on the branch, in order: `custom` entries, plus records carried in the
 * details of a guidance message (the ones decided at `before_agent_start`, which has no
 * boundary to return entries from).
 */
export function branchRecords(branch: SessionEntry[]): SessionRecord[] {
  const out: SessionRecord[] = [];
  for (const e of branch) {
    if (e.type === "custom" && RECORDS.has(e.customType) && e.data && typeof e.data === "object") out.push({ type: e.customType, ...(e.data as object) } as SessionRecord);
    else if (e.type === "custom_message" && e.customType === GUIDANCE_TYPE) {
      const carried = (e.details as { records?: unknown } | undefined)?.records;
      if (Array.isArray(carried)) for (const r of carried) if (r && typeof r === "object" && RECORDS.has((r as { type?: string }).type ?? "")) out.push(r as SessionRecord);
    }
  }
  return out;
}

/** The content a `context_edit` puts in place of an entry: it keeps the entry's role (§4.3). */
export function replacementFor(target: SessionEntry | undefined, edit: ContextEdit): ContextEditEntry["replacement"] {
  if (edit.replacement === null) return null;
  const text = edit.replacement;
  if (target?.type === "message") {
    const role = (target.message as { role: string }).role;
    if (role === "assistant" || role === "toolResult") return { content: [{ type: "text", text }] };
  }
  return { content: text };
}
