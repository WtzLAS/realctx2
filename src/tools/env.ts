/**
 * What the agent-facing tools (§8.1) and the `/realctx2` command (§10) need from their host:
 * the engine of the session, the memory runtime, and a way to read other sessions' transcripts.
 */
import type { Config, Layout } from "../core/config.ts";
import type { Clock, EntryView, SessionRecord, ToolResultPayload } from "../core/types.ts";
import type { ContextEngine, PendingDelivery } from "../context/engine.ts";
import type { MemoryRuntime, SessionEntry } from "../memory/runtime.ts";

export type ToolKey = "search" | "recall" | "inspect" | "remember" | "forget";
export const TOOL_KEYS: ToolKey[] = ["search", "recall", "inspect", "remember", "forget"];
/** Tools an aux session gets: they cannot start aux work of their own (§9.3.2). */
export const AUX_TOOL_KEYS: ToolKey[] = ["search", "recall", "inspect"];

export interface ToolEnv {
  cfg: Config;
  layout: Layout;
  sessionId: string;
  harness: "pi" | "claude-code" | "test";
  memory: MemoryRuntime | null;
  engine: ContextEngine | null;
  clock: Clock;
  /** Entries of this session's active branch. */
  entries(): Promise<EntryView[]>;
  /** An earlier session of this project: its entries and realctx2 records (§5.6). */
  loadSession?(session: SessionEntry): Promise<{ entries: EntryView[]; records: SessionRecord[] } | null>;
}

/** Effective tool names after `tools.names` (§8.1.3). Claude Code adds its own MCP prefix. */
export function toolNames(cfg: Config, prefix = ""): Record<ToolKey, string> {
  const out = {} as Record<ToolKey, string>;
  for (const k of TOOL_KEYS) {
    const n = cfg.tools.names[k];
    out[k] = prefix + (typeof n === "string" && /^[A-Za-z_][\w-]{0,63}$/.test(n) ? n : k);
  }
  return out;
}

export interface ToolDetails {
  /** What entered context: the adapter hands these to the ledger (§5.5.1). */
  deliveries?: PendingDelivery[];
  [key: string]: unknown;
}

export function ok(text: string, details: ToolDetails = {}): ToolResultPayload {
  return { text, details };
}

export function fail(text: string, details: ToolDetails = {}): ToolResultPayload {
  return { text, details, isError: true };
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export function strList(v: unknown, max = 16): string[] {
  if (typeof v === "string") return v.trim() ? [v.trim()] : [];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()).slice(0, max) : [];
}

export function int(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : def;
}

export function oneOf<T extends string>(v: unknown, options: readonly T[]): T | undefined {
  return typeof v === "string" && (options as readonly string[]).includes(v) ? (v as T) : undefined;
}

/** Sessions of this project that started with realctx2 enabled, this one included. */
export function projectSessions(env: ToolEnv): SessionEntry[] {
  const known = env.memory?.sessions() ?? [];
  return known.some((s) => s.id === env.sessionId) ? known : [...known, { id: env.sessionId, harness: env.harness, startedAt: env.clock().toISOString() }];
}
