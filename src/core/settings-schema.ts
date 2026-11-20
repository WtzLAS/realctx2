/**
 * Complete declarative schema for `/realctx2 settings`: categories, separated sections,
 * every configuration parameter, endpoints, aux harness/role overrides, validation,
 * formatting, and human-readable descriptions grounded in docs/realctx2-design.md.
 */
import { describeEndpointAuth, type EndpointKind, type EndpointTestResult } from "../providers/test-endpoint.ts";
import { ROLE_DEFAULTS } from "./aux.ts";
import { type Config, DEFAULT_CONFIG, type DecisionProviderConfig, type EmbeddingProviderConfig } from "./config.ts";
import type { AuxRole, AuxTools, ThinkingLevel } from "./types.ts";

export interface EnumOption {
  value: string;
  label?: string;
  description?: string;
}

export type ScalarKind =
  | "boolean"
  | "number"
  | "integer"
  | "nullable-number"
  | "number-or-auto"
  | "enum"
  | "string"
  | "optional-string"
  | "secret";

export interface ScalarSetting {
  kind: ScalarKind;
  path: string;
  label: string;
  description: string;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: EnumOption[];
  placeholder?: string;
  nullLabel?: string;
  /** When set, `0` is accepted even when `min > 0` and displayed with this label (e.g. `"0 (disabled)"`). */
  zeroLabel?: string;
  /** True when the setting takes effect on the next session rather than live. */
  restart?: boolean;
  /** True when pi's model registry picker should be offered for this field. */
  modelPicker?: boolean;
  /** Endpoint kind whose `/v1/models` list should be fetched for interactive model selection. */
  endpointModels?: EndpointKind;
  /** True when the string holds an environment variable name whose presence should be shown live. */
  envVar?: boolean;
  /** True when the string holds a path to a secret/env file whose readability should be shown live. */
  secretFile?: boolean;
  /** Optional custom getter/setter for special virtual fields (e.g. endpoint enabled toggle). */
  get?: (cfg: Config) => unknown;
  set?: (cfg: Config, value: unknown) => Config;
  defaultValue?: unknown;
}

export interface StringListSetting {
  kind: "string-list" | "multi-enum";
  path: string;
  label: string;
  description: string;
  options?: EnumOption[];
  itemPlaceholder?: string;
  restart?: boolean;
}

export interface StringMapSetting {
  kind: "string-map";
  path: string;
  label: string;
  description: string;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  restart?: boolean;
}

export interface ModelOverridesSetting {
  kind: "model-overrides";
  path: string;
  label: string;
  description: string;
  /** Unit displayed after numeric values (e.g. `"tokens"`, `"sec"`). */
  unit?: string;
  /** Minimum positive numeric value (e.g. `8192` for maxWindow, `0` for cacheTTL). */
  min: number;
  /** Maximum numeric value. */
  max: number;
  /** When set, `0` is accepted even when `min > 0` and displayed with this label (e.g. `"0 (disabled)"`). */
  zeroLabel?: string;
  /** Human-readable summary of the global default value shown on the dedicated screen. */
  defaultSummary: (cfg: Config) => string;
  /** Show each model's catalog context window next to its name when available. */
  showContextWindow?: boolean;
  restart?: boolean;
}

export interface SubscreenEntry {
  kind: "subscreen";
  id: string;
  label: string;
  description: string;
  summary: (cfg: Config, ctx?: SettingsDisplayContext) => string;
  build: (cfg: Config, ctx?: SettingsDisplayContext) => SettingScreenSpec;
}

export interface ActionEntry {
  kind: "action";
  id: string;
  action: "test-endpoint";
  endpoint: EndpointKind;
  label: string;
  buttonText?: string;
  description: string;
}

export type EditableSetting = ScalarSetting | StringListSetting | StringMapSetting | ModelOverridesSetting;
export type SettingEntry = EditableSetting | SubscreenEntry | ActionEntry;

export interface SettingSection {
  id: string;
  title: string;
  description?: string;
  items: SettingEntry[];
}

export interface SettingScreenSpec {
  id: string;
  title: string;
  subtitle?: string;
  sections: SettingSection[];
}

export interface SettingCategory {
  id: string;
  title: string;
  aliases?: string[];
  description: string;
  summary: (cfg: Config, ctx?: SettingsDisplayContext) => string;
  build: (cfg: Config, ctx?: SettingsDisplayContext) => SettingScreenSpec;
}

export interface SettingsDisplayContext {
  health?: {
    decision: { configured: boolean; healthy: boolean; emulated: boolean; model?: string; format?: string };
    late: { configured: boolean; healthy: boolean; model?: string } | null;
    dense: { configured: boolean; healthy: boolean; model?: string } | null;
    aux: { available: boolean };
  };
  endpointTests?: Partial<Record<EndpointKind, { status: "running" } | { status: "done"; result: EndpointTestResult }>>;
}

export const AUX_ROLES: Array<{ role: AuxRole; label: string; description: string; transcriptOnly: boolean }> = [
  { role: "janus.scribe", label: "janus.scribe", description: "Names newly kindled intents with a short label, reason, and observable success/failure criteria. Runs single-turn without tools.", transcriptOnly: true },
  { role: "precip", label: "precip", description: "Consolidates closed intents into concise prose memories and structured sidecars. Runs single-turn without tools.", transcriptOnly: true },
  { role: "palim", label: "palim", description: "Folds older prefix consolidations and harvests durable knowledge items into memory. Runs single-turn without tools.", transcriptOnly: true },
  { role: "qemem.planner", label: "qemem.planner", description: "Decomposes thorough memory searches into targeted sub-queries. Runs single-turn without tools.", transcriptOnly: true },
  { role: "qemem.constructor", label: "qemem.constructor", description: "Builds quote-verified evidence cards and gap feedback during thorough memory search. Runs with read-only tools.", transcriptOnly: false },
  { role: "write.merge", label: "write.merge", description: "Merges subsumed or near-duplicate memories while preserving every fact. Runs single-turn without tools.", transcriptOnly: true },
  { role: "evo.operator", label: "evo.operator", description: "Executes EvoDisco memory graph evolution operators (Abstract, Refine, Bridge). Runs with read-only tools.", transcriptOnly: false },
  { role: "ingest.slicer", label: "ingest.slicer", description: "Slices AGENTS.md, CLAUDE.md, and rule files into path-anchored memories during /realctx2 ingest. Runs with read-only tools.", transcriptOnly: false },
  { role: "reverify", label: "reverify", description: "Re-verifies stale path-anchored memories against changed repository files. Runs with read-only tools.", transcriptOnly: false },
  { role: "decision.emulate", label: "decision.emulate", description: "Emulates decision-model probability answers when no decision endpoint is available. Runs single-turn without tools.", transcriptOnly: true },
];

export const THINKING_OPTIONS: EnumOption[] = [
  { value: "off", label: "off", description: "No reasoning tokens (fastest, runs at temperature 0)" },
  { value: "minimal", label: "minimal", description: "Very brief reasoning (~1k tokens)" },
  { value: "low", label: "low", description: "Light reasoning (~2k tokens)" },
  { value: "medium", label: "medium", description: "Moderate reasoning (~8k tokens)" },
  { value: "high", label: "high", description: "Deep reasoning (~16k tokens)" },
  { value: "xhigh", label: "xhigh", description: "Extra-high reasoning (~32k tokens)" },
  { value: "max", label: "max", description: "Maximum reasoning effort supported by the model" },
];

const AUX_TOOLS_OPTIONS: EnumOption[] = [
  { value: "none", label: "none", description: "No tool access; single-turn structured output only" },
  { value: "read-only", label: "read-only", description: "Read-only repository tools (read, grep, find, ls) and read-only realctx2 tools" },
  { value: "read-only+bash", label: "read-only+bash", description: "Read-only tools plus guarded bash (checked against deny patterns, repo boundary, and immediate rules)" },
];

const INSTRUCTION_INCLUDE_OPTIONS: EnumOption[] = [
  { value: "agents", label: "agents", description: "AGENTS.md files across the repository" },
  { value: "claude", label: "claude", description: "CLAUDE.md files across the repository" },
  { value: "local", label: "local", description: "Local personal instruction files (e.g. CLAUDE.local.md)" },
  { value: "rules", label: "rules", description: "Directory rule files (.claude/rules/*.md, .pi/rules/*.md)" },
];

// ───────────────────────────── Path accessors

const ROLE_NAMES = new Set<string>(AUX_ROLES.map((r) => r.role));

/**
 * Split a config path into property segments, keeping dotted AuxRole keys
 * (like `janus.scribe` or `ingest.slicer`) intact as a single segment.
 */
export function splitConfigPath(path: string): string[] {
  const m = /^(providers\.aux\.(?:pi|claudeCode)\.roles)\.(.+)$/.exec(path);
  if (m) {
    const prefix = m[1]!.split(".");
    const rest = m[2]!;
    for (const role of ROLE_NAMES) {
      if (rest === role) return [...prefix, role];
      if (rest.startsWith(`${role}.`)) return [...prefix, role, ...rest.slice(role.length + 1).split(".")];
    }
  }
  return path.split(".");
}

/** Read a dot-separated path (supports array indices like `evolution.hyper.lambda.0` and dotted AuxRole keys). */
export function getConfigPath(cfg: Config, path: string): unknown {
  let cur: unknown = cfg;
  for (const seg of splitConfigPath(path)) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      cur = Number.isInteger(idx) ? cur[idx] : undefined;
    } else if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** Immutably set a dot-separated path on a cloned Config. Passing `undefined` deletes an optional property. */
export function setConfigPath(cfg: Config, path: string, value: unknown): Config {
  const next = structuredClone(cfg);
  const segs = splitConfigPath(path);
  let cur: unknown = next;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]!;
    if (Array.isArray(cur)) {
      cur = cur[Number(seg)];
    } else if (cur && typeof cur === "object") {
      const rec = cur as Record<string, unknown>;
      if (rec[seg] === undefined || rec[seg] === null || typeof rec[seg] !== "object") {
        rec[seg] = {};
      }
      cur = rec[seg];
    }
  }
  const leaf = segs[segs.length - 1]!;
  if (Array.isArray(cur)) {
    cur[Number(leaf)] = value;
  } else if (cur && typeof cur === "object") {
    const rec = cur as Record<string, unknown>;
    if (value === undefined) delete rec[leaf];
    else rec[leaf] = value;
  }
  return next;
}

export function getSettingValue(cfg: Config, entry: EditableSetting): unknown {
  if ("get" in entry && entry.get) return entry.get(cfg);
  return getConfigPath(cfg, entry.path);
}

export function setSettingValue(cfg: Config, entry: EditableSetting, value: unknown): Config {
  if ("set" in entry && entry.set) return entry.set(cfg, value);
  return setConfigPath(cfg, entry.path, value);
}

export function getSettingDefault(entry: EditableSetting): unknown {
  if ("defaultValue" in entry && entry.defaultValue !== undefined) return entry.defaultValue;
  return getConfigPath(DEFAULT_CONFIG, entry.path);
}

function shallowEqualValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if ((a === undefined || a === null) && (b === undefined || b === null)) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => shallowEqualValue(v, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as Record<string, unknown>).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
    const kb = Object.keys(b as Record<string, unknown>).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => kb.includes(k) && shallowEqualValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

export function isSettingModified(cfg: Config, entry: EditableSetting): boolean {
  const cur = getSettingValue(cfg, entry);
  const def = getSettingDefault(entry);
  if ((cur === undefined || cur === null) && (def === undefined || def === null)) return false;
  return !shallowEqualValue(cur, def);
}

// ───────────────────────────── Formatting & parsing

export function maskSecret(value: string | undefined): string {
  if (!value) return "(not set)";
  if (value.length <= 4) return "••••";
  return `••••${value.slice(-4)}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return String(bytes);
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(bytes % 1024 ** 3 === 0 ? 0 : 1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(bytes % 1024 ** 2 === 0 ? 0 : 1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${bytes} B`;
}

function formatNum(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) >= 10_000) return n.toLocaleString("en-US");
  return String(Number(n.toFixed(6)));
}

export function isScalarSetting(entry: SettingEntry): entry is ScalarSetting {
  return (
    entry.kind !== "subscreen" &&
    entry.kind !== "action" &&
    entry.kind !== "string-list" &&
    entry.kind !== "multi-enum" &&
    entry.kind !== "string-map" &&
    entry.kind !== "model-overrides"
  );
}

export function formatModelOverrideValue(entry: ModelOverridesSetting, value: "auto" | number | undefined): string {
  if (value === undefined || value === "auto") return "auto";
  if (value === 0 && entry.zeroLabel) return entry.zeroLabel;
  return entry.unit ? `${formatNum(value)} ${entry.unit}` : formatNum(value);
}

export function parseModelOverrideInput(
  entry: ModelOverridesSetting,
  raw: string,
): { ok: true; value: "auto" | number } | { ok: false; error: string } {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (trimmed === "" || lower === "auto" || lower === "default") return { ok: true, value: "auto" };
  if (entry.zeroLabel && (lower === "off" || lower === "disable" || lower === "disabled")) return { ok: true, value: 0 };
  const n = Number(trimmed.replace(/,/g, ""));
  if (!Number.isFinite(n)) {
    return {
      ok: false,
      error: entry.zeroLabel ? 'Enter "auto", 0 (disable), or a whole number' : 'Enter "auto" or a whole number',
    };
  }
  if (!Number.isInteger(n)) return { ok: false, error: "Must be a whole integer" };
  if (n === 0 && entry.zeroLabel) return { ok: true, value: 0 };
  if (n < entry.min) {
    return {
      ok: false,
      error: entry.zeroLabel ? `Must be 0 (disable) or ≥ ${entry.min}` : `Must be ≥ ${entry.min}`,
    };
  }
  if (n > entry.max) return { ok: false, error: `Must be ≤ ${entry.max}` };
  return { ok: true, value: n };
}

export function formatSettingValue(entry: EditableSetting, value: unknown): string {
  if (entry.kind === "string-list" || entry.kind === "multi-enum") {
    const arr = Array.isArray(value) ? (value as string[]) : [];
    if (!arr.length) return "(empty)";
    if (entry.kind === "multi-enum") return arr.join(", ");
    return arr.length <= 2 ? arr.join(", ") : `${arr.length} items`;
  }
  if (entry.kind === "string-map") {
    const map = value && typeof value === "object" ? (value as Record<string, string>) : {};
    const n = Object.keys(map).length;
    return n === 0 ? "(none)" : `${n} header${n === 1 ? "" : "s"}`;
  }
  if (entry.kind === "model-overrides") {
    const map = value && typeof value === "object" ? (value as Record<string, "auto" | number>) : {};
    const n = Object.values(map).filter((v) => v !== "auto" && v !== undefined).length;
    return n === 0 ? "auto (all models)" : `${n} override${n === 1 ? "" : "s"}`;
  }
  if (!isScalarSetting(entry)) return String(value ?? "");
  const scalar = entry;
  if (scalar.kind === "boolean") return value ? "true" : "false";
  if (scalar.kind === "secret") return maskSecret(typeof value === "string" ? value : undefined);
  if (value === null || value === undefined || value === "") {
    return scalar.nullLabel ?? "(not set)";
  }
  if (scalar.kind === "enum") {
    const opt = scalar.options?.find((o) => o.value === String(value));
    return opt?.label ?? String(value);
  }
  if (scalar.kind === "number-or-auto") {
    if (value === "auto") return "auto";
    if (value === 0 && scalar.zeroLabel) return scalar.zeroLabel;
    if (typeof value === "number") return scalar.unit ? `${formatNum(value)} ${scalar.unit}` : formatNum(value);
    return String(value);
  }
  if (typeof value === "number") {
    if (scalar.unit === "bytes") return `${formatNum(value)} (${formatBytes(value)})`;
    return scalar.unit ? `${formatNum(value)} ${scalar.unit}` : formatNum(value);
  }
  return String(value);
}

export function rawInputValue(entry: ScalarSetting, value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

export function parseSettingInput(entry: ScalarSetting, raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (entry.kind === "boolean") {
    if (trimmed === "true" || trimmed === "on" || trimmed === "1" || trimmed === "yes") return { ok: true, value: true };
    if (trimmed === "false" || trimmed === "off" || trimmed === "0" || trimmed === "no") return { ok: true, value: false };
    return { ok: false, error: "Expected true or false" };
  }
  if (entry.kind === "string") {
    return { ok: true, value: trimmed };
  }
  if (entry.kind === "optional-string" || entry.kind === "secret") {
    return { ok: true, value: trimmed.length ? trimmed : undefined };
  }
  if (entry.kind === "enum") {
    if (trimmed === "" && entry.nullLabel) return { ok: true, value: undefined };
    const valid = entry.options?.map((o) => o.value) ?? [];
    if (!valid.includes(trimmed)) return { ok: false, error: `Expected one of: ${valid.join(", ")}` };
    return { ok: true, value: trimmed };
  }
  if (entry.kind === "number-or-auto") {
    const lower = trimmed.toLowerCase();
    if (trimmed === "" || lower === "auto") return { ok: true, value: "auto" };
    if (entry.zeroLabel && (lower === "off" || lower === "disable" || lower === "disabled")) return { ok: true, value: 0 };
    const n = Number(trimmed.replace(/,/g, ""));
    if (!Number.isFinite(n)) {
      return { ok: false, error: entry.zeroLabel ? 'Enter "auto", 0 (disable), or a valid number' : 'Enter "auto" or a valid number' };
    }
    if (n === 0 && entry.zeroLabel) return { ok: true, value: 0 };
    if (entry.min !== undefined && n < entry.min) {
      return { ok: false, error: entry.zeroLabel ? `Must be 0 (disable) or ≥ ${entry.min}` : `Must be ≥ ${entry.min}` };
    }
    if (entry.max !== undefined && n > entry.max) return { ok: false, error: `Must be ≤ ${entry.max}` };
    return { ok: true, value: n };
  }
  if (entry.kind === "nullable-number") {
    if (trimmed === "" || trimmed.toLowerCase() === "null" || trimmed.toLowerCase() === "none" || trimmed.toLowerCase() === "default") {
      return { ok: true, value: null };
    }
    const n = Number(trimmed.replace(/,/g, ""));
    if (!Number.isFinite(n)) return { ok: false, error: "Enter a number or leave blank for default" };
    if (entry.min !== undefined && n < entry.min) return { ok: false, error: `Must be ≥ ${entry.min}` };
    if (entry.max !== undefined && n > entry.max) return { ok: false, error: `Must be ≤ ${entry.max}` };
    return { ok: true, value: n };
  }
  if (entry.kind === "integer" || entry.kind === "number") {
    if (trimmed === "" && entry.nullLabel) return { ok: true, value: undefined };
    const n = Number(trimmed.replace(/,/g, ""));
    if (!Number.isFinite(n)) return { ok: false, error: "Enter a valid number" };
    if (entry.kind === "integer" && !Number.isInteger(n)) return { ok: false, error: "Must be a whole integer" };
    if (entry.min !== undefined && n < entry.min) return { ok: false, error: `Must be ≥ ${entry.min}` };
    if (entry.max !== undefined && n > entry.max) return { ok: false, error: `Must be ≤ ${entry.max}` };
    return { ok: true, value: n };
  }
  return { ok: true, value: trimmed };
}

/** Step a numeric/enum/boolean value left (-1) or right (+1) for quick arrow-key tweaking. */
export function stepSettingValue(cfg: Config, entry: ScalarSetting, dir: -1 | 1): { changed: boolean; next: Config } {
  const cur = getSettingValue(cfg, entry);
  if (entry.kind === "boolean") {
    return { changed: true, next: setSettingValue(cfg, entry, !cur) };
  }
  if (entry.kind === "enum" && entry.options?.length) {
    const hasNull = Boolean(entry.nullLabel);
    const values: Array<string | undefined> = hasNull ? [undefined, ...entry.options.map((o) => o.value)] : entry.options.map((o) => o.value);
    const curVal = cur === null || cur === undefined || cur === "" ? undefined : String(cur);
    const idx = Math.max(0, values.indexOf(curVal));
    const nextIdx = (idx + dir + values.length) % values.length;
    return { changed: true, next: setSettingValue(cfg, entry, values[nextIdx]) };
  }
  if (entry.kind === "number-or-auto" && entry.step) {
    if (cur === "auto") {
      const base = entry.path === "context.maxWindow" ? 128000 : (entry.min ?? 0);
      let v = Math.round(base + dir * entry.step);
      if (entry.min !== undefined) v = Math.max(entry.min, v);
      if (entry.max !== undefined) v = Math.min(entry.max, v);
      return { changed: true, next: setSettingValue(cfg, entry, v) };
    }
    if (typeof cur === "number") {
      if (cur === 0 && entry.zeroLabel) {
        if (dir < 0) return { changed: true, next: setSettingValue(cfg, entry, "auto") };
        return { changed: true, next: setSettingValue(cfg, entry, entry.min ?? entry.step) };
      }
      const raw = Number((cur + dir * entry.step).toFixed(6));
      if (dir < 0 && entry.min !== undefined && raw < entry.min) {
        return { changed: true, next: setSettingValue(cfg, entry, entry.zeroLabel ? 0 : "auto") };
      }
      let v = entry.step >= 1 ? Math.round(raw) : raw;
      if (entry.min !== undefined) v = Math.max(entry.min, v);
      if (entry.max !== undefined) v = Math.min(entry.max, v);
      if (v === cur) return { changed: false, next: cfg };
      return { changed: true, next: setSettingValue(cfg, entry, v) };
    }
  }
  if ((entry.kind === "number" || entry.kind === "integer") && typeof cur === "number" && entry.step) {
    let v = Number((cur + dir * entry.step).toFixed(6));
    if (entry.kind === "integer") v = Math.round(v);
    if (entry.min !== undefined) v = Math.max(entry.min, v);
    if (entry.max !== undefined) v = Math.min(entry.max, v);
    if (v === cur) return { changed: false, next: cfg };
    return { changed: true, next: setSettingValue(cfg, entry, v) };
  }
  return { changed: false, next: cfg };
}

// ───────────────────────────── Endpoint & Harness sub-screens

function defaultDecisionEndpoint(): DecisionProviderConfig {
  return {
    format: "systemone",
    url: "",
    model: "",
    registerInPi: true,
  };
}

function defaultEmbeddingEndpoint(kind: "late" | "dense"): EmbeddingProviderConfig {
  return kind === "late"
    ? { url: "", model: "", kind: "multivector", dims: 128, role: "prefix", queryPrefix: "[Q] ", documentPrefix: "[D] ", maxInputTokens: 512, batchSize: 16, transport: "embeddings" }
    : { url: "", model: "", kind: "dense", dimensions: 1024, batchSize: 128, transport: "embeddings" };
}

export function buildDecisionEndpointScreen(cfg: Config, ctx?: SettingsDisplayContext): SettingScreenSpec {
  const d = cfg.providers.decision;
  const h = ctx?.health?.decision;
  const authNote = d ? ` · Auth: ${describeEndpointAuth(d).summary}` : "";
  const statusNote = d
    ? h
      ? `Status: ${h.healthy ? "healthy" : h.emulated ? "unavailable (aux emulated)" : "configured"}${authNote}`
      : `Configured${authNote}`
    : "Disabled — aux LLM emulation or fail-safe defaults will be used";

  const enabledEntry: ScalarSetting = {
    kind: "boolean",
    path: "providers.decision",
    label: "Enable decision endpoint",
    description: "Enable an external HTTP decision/classifier endpoint (SystemOne or Decisions API). When disabled, realctx2 falls back to aux-emulated decisions with stricter thresholds.",
    defaultValue: false,
    get: (c) => c.providers.decision !== null,
    set: (c, v) => {
      const next = structuredClone(c);
      next.providers.decision = v ? (next.providers.decision ?? defaultDecisionEndpoint()) : null;
      return next;
    },
  };

  if (!d) {
    return {
      id: "providers.decision",
      title: "Decision Model Endpoint",
      subtitle: statusNote,
      sections: [{ id: "status", title: "Endpoint Status", items: [enabledEntry] }],
    };
  }

  const testEntry: ActionEntry = {
    kind: "action",
    id: "providers.decision.test",
    action: "test-endpoint",
    endpoint: "decision",
    label: "Test endpoint",
    buttonText: "[ Test endpoint ]",
    description: "Send a live decision probe using the current URL, wire format, model ID, Bearer secret (apiKey / apiKeyEnv / apiKeyFile), and custom headers to verify connectivity and authentication.",
  };

  return {
    id: "providers.decision",
    title: "Decision Model Endpoint",
    subtitle: statusNote,
    sections: [
      {
        id: "status",
        title: "Endpoint Status",
        items: [enabledEntry, testEntry],
      },
      {
        id: "connection",
        title: "Connection & Authentication",
        items: [
          {
            kind: "enum",
            path: "providers.decision.format",
            label: "Wire format",
            description: "HTTP wire protocol spoken by the decision endpoint: SystemOne (POST …/v1/systemone) or OpenAI-style Decisions API (POST …/v1/decisions).",
            options: [
              { value: "systemone", label: "systemone", description: "SystemOne wire format (e.g. pplx-decider / Jev / POST …/v1/systemone)" },
              { value: "decisions", label: "decisions", description: "Decisions API wire format (e.g. pplx-decider / POST …/v1/decisions)" },
            ],
            defaultValue: "systemone",
          },
          {
            kind: "string",
            path: "providers.decision.url",
            label: "Endpoint URL",
            description: "Full HTTP(S) URL for decision requests (for example http://127.0.0.1:8891/v1/systemone or https://api.typesafe.ai/v1/systemone). Applies immediately on save.",
            placeholder: "http://127.0.0.1:8891/v1/systemone",
            defaultValue: "",
          },
          {
            kind: "string",
            path: "providers.decision.model",
            label: "Model ID",
            description: "Model identifier sent to the decision endpoint (for example pplx-decider-v1.3 or jev-latest). Retrieved from /v1/models when available, with manual input as fallback.",
            placeholder: "pplx-decider-v1.3",
            defaultValue: "",
            endpointModels: "decision",
          },
          {
            kind: "optional-string",
            path: "providers.decision.apiKeyEnv",
            label: "API key env var",
            description: "Environment variable name holding the Bearer token for this endpoint (for example DECIDER_API_KEY or TYPESAFE_API_KEY). Preferred over storing a literal key in config.json.",
            placeholder: "DECIDER_API_KEY",
            nullLabel: "(none)",
            envVar: true,
          },
          {
            kind: "secret",
            path: "providers.decision.apiKey",
            label: "API key (literal)",
            description: "Literal Bearer secret sent in the Authorization header. Masked on screen and while typing; config.json is saved mode 0600. Prefer apiKeyEnv or apiKeyFile to keep secrets out of config.json.",
            placeholder: "Bearer token or secret",
            nullLabel: "(not set)",
          },
          {
            kind: "optional-string",
            path: "providers.decision.apiKeyFile",
            label: "API key file",
            description: "Optional path to a secret file holding a raw token or KEY=VALUE env assignment (for example /etc/pplx-decider-v1.3-exl3/env or ~/.secrets/decider.key). Used if literal apiKey and apiKeyEnv are unset.",
            placeholder: "/etc/pplx-decider-v1.3-exl3/env",
            nullLabel: "(none)",
            secretFile: true,
          },
          {
            kind: "string-map",
            path: "providers.decision.headers",
            label: "Custom HTTP headers",
            description: "Additional HTTP headers sent with every decision request (e.g. custom auth or proxy routing headers). Sensitive header values are masked on screen.",
            keyPlaceholder: "X-Custom-Header",
            valuePlaceholder: "header value",
          },
        ],
      },
      {
        id: "limits",
        title: "Limits & Pi Integration",
        items: [
          {
            kind: "integer",
            path: "providers.decision.maxInputTokens",
            label: "Max input tokens",
            description: "Evidence token cap per decision request (default 30,000). Longer evidence trims tool outputs first, then drops older rounds.",
            unit: "tokens",
            min: 512,
            step: 2000,
            nullLabel: "default (30,000)",
          },
          {
            kind: "integer",
            path: "providers.decision.maxQuestions",
            label: "Max questions per request",
            description: "Maximum questions bundled in a single HTTP request before splitting (default 100 for SystemOne, 400 for Decisions API).",
            min: 1,
            max: 1000,
            step: 10,
            nullLabel: "default (100/400)",
          },
          {
            kind: "boolean",
            path: "providers.decision.registerInPi",
            label: "Register classifier in pi",
            description: "Expose this decision endpoint to pi and codemode as the realctx2-decision classifier provider so extensions can call models.classify(). Applies immediately.",
            defaultValue: true,
            get: (c) => c.providers.decision?.registerInPi !== false,
            set: (c, v) => setConfigPath(c, "providers.decision.registerInPi", Boolean(v)),
          },
        ],
      },
    ],
  };
}

export function buildEmbeddingEndpointScreen(kind: "late" | "dense", cfg: Config, ctx?: SettingsDisplayContext): SettingScreenSpec {
  const basePath = `providers.embedding.${kind}`;
  const ep = cfg.providers.embedding[kind];
  const labelTitle = kind === "late" ? "Late-Interaction Embedding Endpoint" : "Dense Embedding Endpoint";
  const h = kind === "late" ? ctx?.health?.late : ctx?.health?.dense;
  const authNote = ep ? ` · Auth: ${describeEndpointAuth(ep).summary}` : "";
  const statusNote = ep
    ? h
      ? `Status: ${h.healthy ? "healthy" : "down"}${authNote} · changes take effect next session`
      : `Configured${authNote} · changes take effect next session`
    : kind === "late"
      ? "Disabled — dense embeddings or BM25 will be used"
      : "Disabled — late-interaction embeddings or BM25 will be used";

  const enabledEntry: ScalarSetting = {
    kind: "boolean",
    path: basePath,
    label: `Enable ${kind === "late" ? "late-interaction" : "dense"} endpoint`,
    description:
      kind === "late"
        ? "Enable a multi-vector ColBERT/late-interaction embedding endpoint (OpenAI /v1/embeddings token_embed format) for MaxSim retrieval."
        : "Enable a standard dense embedding endpoint (OpenAI /v1/embeddings format). Used directly or as automatic fallback if late-interaction is down.",
    defaultValue: false,
    restart: true,
    get: (c) => c.providers.embedding[kind] !== null,
    set: (c, v) => {
      const next = structuredClone(c);
      next.providers.embedding[kind] = v ? (next.providers.embedding[kind] ?? defaultEmbeddingEndpoint(kind)) : null;
      return next;
    },
  };

  if (!ep) {
    return {
      id: basePath,
      title: labelTitle,
      subtitle: statusNote,
      sections: [{ id: "status", title: "Endpoint Status", items: [enabledEntry] }],
    };
  }

  const testEntry: ActionEntry = {
    kind: "action",
    id: `${basePath}.test`,
    action: "test-endpoint",
    endpoint: kind,
    label: "Test endpoint",
    buttonText: "[ Test endpoint ]",
    description:
      kind === "late"
        ? "Send a live multi-vector embedding probe using the current URL, model ID, Bearer secret, role, and transport settings to verify connectivity, auth, and token-matrix shape."
        : "Send a live dense embedding probe using the current URL, model ID, Bearer secret, dimensions, and custom headers to verify connectivity, auth, and vector shape.",
  };

  return {
    id: basePath,
    title: labelTitle,
    subtitle: statusNote,
    sections: [
      { id: "status", title: "Endpoint Status", items: [enabledEntry, testEntry] },
      {
        id: "connection",
        title: "Connection & Authentication",
        items: [
          {
            kind: "string",
            path: `${basePath}.url`,
            label: "Endpoint URL",
            description:
              kind === "late"
                ? "Full HTTP(S) URL for multi-vector embedding requests (for example http://127.0.0.1:8890/v1/embeddings or /pooling)."
                : "Full HTTP(S) URL for embedding requests (for example https://api.openai.com/v1/embeddings).",
            placeholder: kind === "late" ? "http://127.0.0.1:8890/v1/embeddings" : "https://api.openai.com/v1/embeddings",
            restart: true,
            defaultValue: "",
          },
          {
            kind: "string",
            path: `${basePath}.model`,
            label: "Model ID",
            description:
              kind === "late"
                ? "Multi-vector model identifier requested from the server (e.g. perplexity-ai/pplx-embed-v2-late-9b or lightonai/GTE-ModernColBERT-v1). Retrieved from /v1/models when available, with manual input as fallback."
                : "Embedding model identifier requested from the server (e.g. text-embedding-3-small). Retrieved from /v1/models when available, with manual input as fallback.",
            placeholder: kind === "late" ? "perplexity-ai/pplx-embed-v2-late-9b" : "text-embedding-3-small",
            restart: true,
            defaultValue: "",
            endpointModels: kind,
          },
          {
            kind: "enum",
            path: `${basePath}.kind`,
            label: "Vector kind",
            description: "Output vector format returned by the server: multivector (one vector per token) or dense (one vector per text).",
            options: [
              { value: "multivector", label: "multivector", description: "Matrix of per-token vectors for MaxSim late interaction" },
              { value: "dense", label: "dense", description: "Single dense vector per text for cosine similarity" },
            ],
            nullLabel: kind === "late" ? "default (multivector)" : "default (dense)",
            restart: true,
          },
          {
            kind: "enum",
            path: `${basePath}.transport`,
            label: "HTTP transport",
            description: "Server endpoint flavor: standard OpenAI embeddings (/v1/embeddings) or vLLM pooling endpoint (/pooling).",
            options: [
              { value: "embeddings", label: "embeddings", description: "Standard OpenAI /v1/embeddings request/response schema" },
              { value: "pooling", label: "pooling", description: "vLLM /pooling transport compatibility alias" },
            ],
            nullLabel: "default (embeddings)",
            restart: true,
          },
          {
            kind: "optional-string",
            path: `${basePath}.apiKeyEnv`,
            label: "API key env var",
            description:
              kind === "late"
                ? "Environment variable containing the Bearer token for this embedding endpoint (e.g. EMBED_API_KEY)."
                : "Environment variable containing the API key for this embedding endpoint (e.g. OPENAI_API_KEY).",
            placeholder: kind === "late" ? "EMBED_API_KEY" : "OPENAI_API_KEY",
            nullLabel: "(none)",
            restart: true,
            envVar: true,
          },
          {
            kind: "secret",
            path: `${basePath}.apiKey`,
            label: "API key (literal)",
            description: "Literal Bearer token for this embedding endpoint. Masked on screen and while typing; config.json is saved mode 0600. Prefer apiKeyEnv or apiKeyFile to keep credentials out of config.json.",
            placeholder: "Bearer token or secret",
            nullLabel: "(not set)",
            restart: true,
          },
          {
            kind: "optional-string",
            path: `${basePath}.apiKeyFile`,
            label: "API key file",
            description:
              kind === "late"
                ? "Optional path to a secret file holding a raw token or KEY=VALUE env assignment (for example /etc/pplx-embed-v2-exl3/env or ~/.secrets/embed.key). Used if literal apiKey and apiKeyEnv are unset."
                : "Optional path to a secret file holding a raw token or KEY=VALUE env assignment (for example ~/.secrets/openai.key). Used if literal apiKey and apiKeyEnv are unset.",
            placeholder: kind === "late" ? "/etc/pplx-embed-v2-exl3/env" : "~/.secrets/openai.key",
            nullLabel: "(none)",
            restart: true,
            secretFile: true,
          },
          {
            kind: "string-map",
            path: `${basePath}.headers`,
            label: "Custom HTTP headers",
            description: "Extra HTTP headers included on every embedding request. Sensitive header values are masked on screen.",
            keyPlaceholder: "X-Custom-Header",
            valuePlaceholder: "header value",
            restart: true,
          },
        ],
      },
      {
        id: "vectors",
        title: kind === "late" ? "Token Vectors, Roles & Batching" : "Dimensions, Roles & Batching",
        items: [
          {
            kind: "integer",
            path: `${basePath}.dims`,
            label: "Token vector width (dims)",
            description: "Expected per-token vector dimension d for multivector models (e.g. 128). Used to validate server responses and cache keys.",
            min: 1,
            step: 32,
            nullLabel: "(auto)",
            restart: true,
          },
          {
            kind: "integer",
            path: `${basePath}.dimensions`,
            label: "Requested dimensions",
            description: "Dense models only: Matryoshka output width sent as `dimensions` in the request body (never sent for multivector models).",
            min: 1,
            step: 128,
            nullLabel: "(model default)",
            restart: true,
          },
          {
            kind: "enum",
            path: `${basePath}.role`,
            label: "Query/document role mode",
            description: "How queries and documents are distinguished: send `input_type` field, prepend configured prefixes, or send raw text.",
            options: [
              { value: "none", label: "none", description: "Do not differentiate query and document inputs" },
              { value: "input_type", label: "input_type", description: "Pass input_type: 'query' | 'document' in the JSON payload" },
              { value: "prefix", label: "prefix", description: "Prepend queryPrefix / documentPrefix to input strings" },
            ],
            nullLabel: "default (none)",
            restart: true,
          },
          {
            kind: "optional-string",
            path: `${basePath}.queryPrefix`,
            label: "Query prefix",
            description: "Prefix prepended to search queries when role is 'prefix' (for example '[Q] ' for PyLate ColBERT models).",
            placeholder: "[Q] ",
            nullLabel: "(none)",
            restart: true,
          },
          {
            kind: "optional-string",
            path: `${basePath}.documentPrefix`,
            label: "Document prefix",
            description: "Prefix prepended to stored memories and turns when role is 'prefix' (for example '[D] ' for PyLate ColBERT models).",
            placeholder: "[D] ",
            nullLabel: "(none)",
            restart: true,
          },
          {
            kind: "integer",
            path: `${basePath}.maxInputTokens`,
            label: "Max input tokens",
            description: "Maximum input token length per embedded text before truncation/chunking (e.g. 512 for ColBERT models).",
            unit: "tokens",
            min: 32,
            step: 128,
            nullLabel: "(model default)",
            restart: true,
          },
          {
            kind: "integer",
            path: `${basePath}.batchSize`,
            label: "Batch size",
            description: "Maximum texts sent in one HTTP request (default 16 for late interaction because matrices are large; 128 for dense).",
            min: 1,
            max: 512,
            step: 8,
            nullLabel: kind === "late" ? "default (16)" : "default (128)",
            restart: true,
          },
        ],
      },
    ],
  };
}

export function buildAuxRoleScreen(harness: "pi" | "claudeCode", role: AuxRole, cfg: Config): SettingScreenSpec {
  const roleMeta = AUX_ROLES.find((r) => r.role === role)!;
  const baseDefaults = ROLE_DEFAULTS[role];
  const basePath = `providers.aux.${harness}.roles.${role}`;
  const harnessModel = cfg.providers.aux[harness].model;
  const harnessThinking = cfg.providers.aux[harness].thinking;
  const effectiveDefaultThinking = roleMeta.transcriptOnly ? baseDefaults.thinking : (harnessThinking ?? baseDefaults.thinking);

  return {
    id: basePath,
    title: `${harness === "pi" ? "Pi" : "Claude Code"} Role · ${role}`,
    subtitle: roleMeta.description,
    sections: [
      {
        id: "override",
        title: "Role Overrides",
        items: [
          {
            kind: "optional-string",
            path: `${basePath}.model`,
            label: "Model override",
            description:
              harness === "pi"
                ? `Model for ${role} in <provider>/<model-id> format. Leave blank to inherit the pi harness default (${harnessModel ?? "active session model"}).`
                : `Model alias or ID for ${role} (e.g. sonnet, haiku). Leave blank to inherit the Claude Code default (${harnessModel ?? "haiku"}).`,
            placeholder: harness === "pi" ? "anthropic/claude-sonnet-4-5" : "sonnet",
            nullLabel: `inherit (${harnessModel ?? (harness === "pi" ? "session model" : "haiku")})`,
            modelPicker: harness === "pi",
          },
          {
            kind: "enum",
            path: `${basePath}.thinking`,
            label: "Thinking level",
            description: `Reasoning effort for ${role}. Leave unset to inherit the default (${effectiveDefaultThinking}).`,
            options: THINKING_OPTIONS,
            nullLabel: `inherit (${effectiveDefaultThinking})`,
          },
          {
            kind: "enum",
            path: `${basePath}.tools`,
            label: "Tool access",
            description: roleMeta.transcriptOnly
              ? `${role} is transcript-only and always runs with tools: none (overrides cannot widen transcript-only roles).`
              : `Tool access granted to ${role} (default: ${baseDefaults.tools}). Opt into read-only+bash only if shell inspection is needed.`,
            options: AUX_TOOLS_OPTIONS,
            nullLabel: `inherit (${baseDefaults.tools})`,
          },
          {
            kind: "integer",
            path: `${basePath}.maxTurns`,
            label: "Max turns",
            description: `Maximum agent loop turns for ${role} before requesting the final structured result (default: ${baseDefaults.maxTurns}).`,
            min: 1,
            max: 50,
            step: 1,
            nullLabel: `default (${baseDefaults.maxTurns})`,
          },
          {
            kind: "integer",
            path: `${basePath}.timeoutMs`,
            label: "Timeout",
            description: `Per-run wall-clock timeout in milliseconds for ${role} (default: ${baseDefaults.timeoutMs.toLocaleString("en-US")} ms).`,
            unit: "ms",
            min: 1000,
            step: 5000,
            nullLabel: `default (${baseDefaults.timeoutMs.toLocaleString("en-US")} ms)`,
          },
        ],
      },
    ],
  };
}

function summarizeRole(harness: "pi" | "claudeCode", role: AuxRole, cfg: Config): string {
  const over = cfg.providers.aux[harness].roles?.[role];
  const base = ROLE_DEFAULTS[role];
  const parts: string[] = [];
  if (over?.model) parts.push(over.model);
  if (over?.thinking) parts.push(`think:${over.thinking}`);
  if (over?.tools) parts.push(`tools:${over.tools}`);
  if (over?.maxTurns !== undefined) parts.push(`${over.maxTurns}t`);
  if (over?.timeoutMs !== undefined) parts.push(`${Math.round(over.timeoutMs / 1000)}s`);
  if (parts.length) return parts.join(" · ");
  return `default (${base.thinking}, ${base.maxTurns}t, ${Math.round(base.timeoutMs / 1000)}s)`;
}

export function buildAuxHarnessScreen(harness: "pi" | "claudeCode", cfg: Config): SettingScreenSpec {
  const basePath = `providers.aux.${harness}`;
  const isPi = harness === "pi";
  return {
    id: basePath,
    title: isPi ? "Aux Harness · pi" : "Aux Harness · Claude Code",
    subtitle: isPi
      ? "Defaults and per-role overrides for aux sessions running inside pi's modelRegistry"
      : "Defaults and per-role overrides for aux sessions running via `claude -p`",
    sections: [
      {
        id: "defaults",
        title: "Harness Defaults",
        items: [
          {
            kind: "optional-string",
            path: `${basePath}.model`,
            label: "Default aux model",
            description: isPi
              ? "Default model (<provider>/<model-id>) for pi aux roles without their own override. Leave unset to use the active session's model."
              : "Default model alias or ID passed to `claude -p --model` (default: haiku).",
            placeholder: isPi ? "provider/model-id" : "haiku",
            nullLabel: isPi ? "(active session model)" : "(default)",
            modelPicker: isPi,
          },
          {
            kind: "enum",
            path: `${basePath}.thinking`,
            label: "Default thinking level",
            description: "Default reasoning effort inherited by repo-checking aux roles unless overridden per role.",
            options: THINKING_OPTIONS,
            nullLabel: "default (medium)",
          },
          {
            kind: "string-list",
            path: `${basePath}.extensions`,
            label: "Aux extensions",
            description: "Optional list of extension paths/identifiers made available to aux sessions.",
            itemPlaceholder: "extension path or name",
          },
        ],
      },
      {
        id: "roles",
        title: "Per-Role Overrides",
        items: AUX_ROLES.map<SubscreenEntry>((r) => ({
          kind: "subscreen",
          id: `${basePath}.roles.${r.role}`,
          label: r.label,
          description: r.description,
          summary: (c) => summarizeRole(harness, r.role, c),
          build: (c) => buildAuxRoleScreen(harness, r.role, c),
        })),
      },
    ],
  };
}

// ───────────────────────────── Top-level Categories

function endpointShortSummary(
  ep: { model?: string; url?: string } | null,
  health?: { healthy: boolean; emulated?: boolean } | null,
  testState?: { status: "running" } | { status: "done"; result: EndpointTestResult },
): string {
  if (!ep) return "off";
  const name = ep.model || ep.url || "configured";
  if (testState?.status === "running") return `${name} · testing…`;
  if (testState?.status === "done") return `${name} · ${testState.result.ok ? "✓" : "✗"} ${testState.result.summary}`;
  if (!health) return name;
  return `${name} · ${health.healthy ? "healthy" : health.emulated ? "emulated" : "down"}`;
}

export const SETTINGS_CATEGORIES: SettingCategory[] = [
  // ═══════════════════════════════════════════════════════════ 1. Endpoints & Providers
  {
    id: "providers",
    title: "Endpoints & Providers",
    aliases: ["endpoints", "endpoint", "provider", "aux"],
    description: "Configure HTTP endpoints for the decision model and late-interaction / dense embeddings, plus auxiliary LLM concurrency, bash guards, and per-role model overrides.",
    summary: (cfg, ctx) => {
      const d = cfg.providers.decision ? (cfg.providers.decision.model || cfg.providers.decision.format) : "off";
      const l = cfg.providers.embedding.late ? (cfg.providers.embedding.late.model || "on") : "off";
      const dn = cfg.providers.embedding.dense ? (cfg.providers.embedding.dense.model || "on") : "off";
      const aux = ctx?.health?.aux.available ? "ready" : `${cfg.providers.aux.maxConcurrent} conc.`;
      return `decision: ${d} · late: ${l} · dense: ${dn} · aux: ${aux}`;
    },
    build: (_cfg, _ctx) => ({
      id: "providers",
      title: "Endpoints & Providers",
      subtitle: "External decision/embedding endpoints and auxiliary LLM settings",
      sections: [
        {
          id: "endpoints",
          title: "Endpoints",
          items: [
            {
              kind: "subscreen",
              id: "providers.decision",
              label: "Decision model endpoint",
              description: "Fast classifier/decision endpoint (SystemOne or Decisions API) used for Janus intent tracking, proactive gating, attribution, routing, and conflict checks. Applies immediately.",
              summary: (c, x) => endpointShortSummary(c.providers.decision, x?.health?.decision ?? null, x?.endpointTests?.decision),
              build: (c, x) => buildDecisionEndpointScreen(c, x),
            },
            {
              kind: "subscreen",
              id: "providers.embedding.late",
              label: "Late-interaction embedding endpoint",
              description: "Multi-vector ColBERT embedding endpoint (/v1/embeddings with token vectors) for MaxSim first-stage retrieval and calibrated similarity checks.",
              summary: (c, x) => endpointShortSummary(c.providers.embedding.late, x?.health?.late ?? null, x?.endpointTests?.late),
              build: (c, x) => buildEmbeddingEndpointScreen("late", c, x),
            },
            {
              kind: "subscreen",
              id: "providers.embedding.dense",
              label: "Dense embedding endpoint",
              description: "Standard dense embedding endpoint (/v1/embeddings). Used for cosine search when late-interaction is absent or unavailable.",
              summary: (c, x) => endpointShortSummary(c.providers.embedding.dense, x?.health?.dense ?? null, x?.endpointTests?.dense),
              build: (c, x) => buildEmbeddingEndpointScreen("dense", c, x),
            },
          ],
        },
        {
          id: "aux-general",
          title: "Auxiliary LLM",
          items: [
            {
              kind: "integer",
              path: "providers.aux.maxConcurrent",
              label: "Max concurrent aux sessions",
              description: "Maximum number of auxiliary LLM sessions allowed to run simultaneously per engine host; additional tasks wait in a FIFO queue.",
              min: 1,
              max: 16,
              step: 1,
              restart: true,
            },
            {
              kind: "enum",
              path: "providers.aux.defaultTools",
              label: "Default aux tools",
              description: "Fallback tool access policy for repo-checking aux roles when a role does not override it. Transcript-only roles never receive tools.",
              options: AUX_TOOLS_OPTIONS,
            },
            {
              kind: "integer",
              path: "providers.aux.emulateTimeoutMs",
              label: "Emulated decision timeout",
              description: "Minimum timeout (ms) granted to aux-emulated decisions when no HTTP decision endpoint is healthy (0 keeps the call site's shorter timeout). Answers apply at the next commit point.",
              unit: "ms",
              min: 0,
              max: 120_000,
              step: 2000,
              restart: true,
            },
          ],
        },
        {
          id: "aux-guard",
          title: "Aux Bash Guard",
          items: [
            {
              kind: "enum",
              path: "providers.aux.guard.writesOutsideRepo",
              label: "Writes outside repository",
              description: "Controls whether guarded bash calls inside aux sessions may write to paths outside the repository root.",
              options: [
                { value: "block", label: "block", description: "Refuse shell writes targeting paths outside the repository" },
                { value: "allow", label: "allow", description: "Allow shell writes outside the repository (deny list still applies)" },
              ],
            },
            {
              kind: "string-list",
              path: "providers.aux.guard.deny",
              label: "Denied bash command patterns",
              description: "Glob patterns blocked whenever an aux session invokes bash (e.g. rm -r*, git push*, curl * | *sh*). Project configs may only add patterns, never remove them.",
              itemPlaceholder: "git push*",
            },
          ],
        },
        {
          id: "aux-harnesses",
          title: "Harness Models & Per-Role Overrides",
          items: [
            {
              kind: "subscreen",
              id: "providers.aux.pi",
              label: "pi aux harness & roles",
              description: "Configure default model, thinking level, extensions, and per-role overrides for aux sessions running inside pi.",
              summary: (c) => {
                const count = Object.keys(c.providers.aux.pi.roles ?? {}).length;
                return `${c.providers.aux.pi.model ?? "session model"} · ${c.providers.aux.pi.thinking ?? "medium"}${count ? ` · ${count} role override${count === 1 ? "" : "s"}` : ""}`;
              },
              build: (c) => buildAuxHarnessScreen("pi", c),
            },
            {
              kind: "subscreen",
              id: "providers.aux.claudeCode",
              label: "Claude Code aux harness & roles",
              description: "Configure default model, thinking level, extensions, and per-role overrides for aux sessions running through `claude -p`.",
              summary: (c) => {
                const count = Object.keys(c.providers.aux.claudeCode.roles ?? {}).length;
                return `${c.providers.aux.claudeCode.model ?? "haiku"} · ${c.providers.aux.claudeCode.thinking ?? "medium"}${count ? ` · ${count} role override${count === 1 ? "" : "s"}` : ""}`;
              },
              build: (c) => buildAuxHarnessScreen("claudeCode", c),
            },
          ],
        },
      ],
    }),
  },

  // ═══════════════════════════════════════════════════════════ 2. Context
  {
    id: "context",
    title: "Context",
    aliases: ["ctx", "janus", "palim", "precip", "climb"],
    description: "Tune context window sizing, working tail protection, Precip and Palim consolidation thresholds, climb policy, Janus intent tracking, and credit attribution.",
    summary: (cfg) => `W=${cfg.context.maxWindow === "auto" ? "auto" : cfg.context.maxWindow === 0 ? "off" : `${Math.round(cfg.context.maxWindow / 1000)}k`} · ρ=${cfg.context.rho} · climb: ${cfg.context.climb.enabled ? "on" : "off"} · janus: ${cfg.janus.timeoutMs >= 1000 && cfg.janus.timeoutMs % 1000 === 0 ? `${cfg.janus.timeoutMs / 1000}s` : `${cfg.janus.timeoutMs}ms`}`,
    build: () => ({
      id: "context",
      title: "Context Engine",
      subtitle: "Window budget, working tail, Precip/Palim consolidation, climb policy, Janus, and attribution",
      sections: [
        {
          id: "window",
          title: "Window & Working Tail",
          items: [
            {
              kind: "number-or-auto",
              path: "context.maxWindow",
              label: "Max effective window (maxWindow)",
              description: 'Effective working context window W: "auto" uses the active model\'s contextWindow from the model catalog metadata; a number caps W at min(model window, maxWindow); 0 disables the context engine. Bmin, Tmin and deltaMin scale proportionally with W/128,000.',
              unit: "tokens",
              zeroLabel: "0 (disabled)",
              min: 8192,
              max: 2_000_000,
              step: 8192,
            },
            {
              kind: "model-overrides",
              path: "context.modelMaxWindows",
              label: "Per-model maxWindow overrides",
              description: 'Override maxWindow for individual models: "auto" inherits the default maxWindow, 0 disables the context engine for that model, or enter a token cap ≥ 8,192.',
              unit: "tokens",
              zeroLabel: "0 (disabled)",
              min: 8192,
              max: 2_000_000,
              showContextWindow: true,
              defaultSummary: (cfg) =>
                cfg.context.maxWindow === "auto"
                  ? "auto (model catalog)"
                  : cfg.context.maxWindow === 0
                    ? "0 (disabled)"
                    : `${formatNum(cfg.context.maxWindow)} tokens`,
            },
            {
              kind: "number",
              path: "context.rho",
              label: "Pressure threshold (rho)",
              description: "Fraction of effective window W where pressure relief folds begin (default 0.80). Keep below pi's auto-compaction threshold so realctx2 folds before pi compacts.",
              min: 0.2,
              max: 0.99,
              step: 0.05,
            },
            {
              kind: "integer",
              path: "context.K",
              label: "Min working-tail rounds (K)",
              description: "Minimum number of recent complete rounds always protected from folding at the tail of the conversation.",
              unit: "rounds",
              min: 1,
              max: 50,
              step: 1,
            },
            {
              kind: "integer",
              path: "context.Bmin",
              label: "Working-tail token floor (Bmin)",
              description: "Base minimum token budget kept in the live working tail at W = 128,000 (scales with W/128,000, floor 2,048).",
              unit: "tokens",
              min: 512,
              max: 128_000,
              step: 1024,
            },
            {
              kind: "number",
              path: "context.alpha",
              label: "Working-tail max fraction (alpha)",
              description: "Maximum fraction of effective window W that the protected working tail may occupy (default 0.20).",
              min: 0.05,
              max: 0.8,
              step: 0.05,
            },
            {
              kind: "number",
              path: "context.q",
              label: "Round-size quantile (q)",
              description: "Quantile of recent round token sizes used to estimate how much working-tail headroom to reserve (default 0.95).",
              min: 0.5,
              max: 0.999,
              step: 0.01,
            },
            {
              kind: "number",
              path: "context.maxToolResultFraction",
              label: "Max tool result fraction",
              description: "Tool outputs exceeding this fraction of W are archived behind an [o:…] ID, keeping only head and tail excerpts in live context.",
              min: 0.01,
              max: 0.9,
              step: 0.05,
            },
            {
              kind: "integer",
              path: "context.reinjectTokens",
              label: "Post-compaction reinject budget",
              description: "Token budget for re-injecting shadow consolidations and open intents after harness compaction on append-only L0 harnesses (Claude Code).",
              unit: "tokens",
              min: 500,
              max: 64_000,
              step: 1000,
            },
          ],
        },
        {
          id: "consolidation",
          title: "Consolidation (Precip & Palim)",
          items: [
            {
              kind: "integer",
              path: "context.Emin",
              label: "Min prefix consolidations (Emin)",
              description: "Minimum number of consolidated messages required in the root prefix before an ordinary Palim fold runs.",
              min: 1,
              max: 20,
              step: 1,
            },
            {
              kind: "integer",
              path: "context.Tmin",
              label: "Min prefix size (Tmin)",
              description: "Base minimum token count in the foldable prefix before Palim folds at W = 128,000 (scales with W/128,000, floor 8,192).",
              unit: "tokens",
              min: 1024,
              max: 128_000,
              step: 2048,
            },
            {
              kind: "integer",
              path: "context.deltaMin",
              label: "Min saving per fold (deltaMin)",
              description: "Minimum net tokens a Palim fold must save to be accepted (scales with W/128,000, floor 4,096); otherwise it retries.",
              unit: "tokens",
              min: 512,
              max: 64_000,
              step: 1024,
            },
            {
              kind: "integer",
              path: "context.foldRetries",
              label: "Fold retries (J)",
              description: "Number of retry attempts when a Palim fold saves fewer than deltaMin tokens before leaving the span intact.",
              min: 0,
              max: 10,
              step: 1,
            },
            {
              kind: "number",
              path: "context.tauClose",
              label: "Intent close threshold (tauClose)",
              description: "Calibrated decision probability required for Janus to close an intent (default 0.80; aux-emulated decisions enforce ≥ 0.90).",
              min: 0.1,
              max: 0.99,
              step: 0.05,
            },
            {
              kind: "number",
              path: "context.tauOpen",
              label: "Intent open threshold (tauOpen)",
              description: "Calibrated decision probability required for Janus to kindle a new root or nested intent (default 0.60).",
              min: 0.1,
              max: 0.99,
              step: 0.05,
            },
            {
              kind: "integer",
              path: "context.precipSkipTokens",
              label: "Precip skip threshold",
              description: "Closed intents smaller than this token size skip Precip consolidation so tiny spans are kept verbatim.",
              unit: "tokens",
              min: 0,
              max: 32_000,
              step: 250,
            },
            {
              kind: "boolean",
              path: "context.settleConsolidation",
              label: "Consolidate at agent settle",
              description: "Run boundary consolidation checks at agent_before_settle when the agent finishes a multi-turn response.",
            },
            {
              kind: "integer",
              path: "context.cacheTtlSeconds",
              label: "Provider cache TTL",
              description: "Assumed prompt-cache lifetime in seconds. When the cache is already cold past this TTL, Palim can fold without paying a cache-break penalty.",
              unit: "sec",
              min: 0,
              max: 7200,
              step: 60,
            },
            {
              kind: "model-overrides",
              path: "context.modelCacheTtlSeconds",
              label: "Per-model cacheTTL overrides",
              description: 'Override the prompt-cache TTL in seconds for individual models: "auto" inherits Provider cache TTL, or enter seconds ≥ 0 (e.g. 3600 for 1-hour caches).',
              unit: "sec",
              min: 0,
              max: 86_400,
              defaultSummary: (cfg) => `${formatNum(cfg.context.cacheTtlSeconds)} sec`,
            },
            {
              kind: "number",
              path: "context.prepareFraction",
              label: "Prepare fold occupancy fraction",
              description: "Occupancy fraction of W (default 0.70) at which background Palim folds begin preparing ahead of the pressure threshold rho.",
              min: 0.1,
              max: 0.98,
              step: 0.05,
            },
          ],
        },
        {
          id: "climb",
          title: "Palim Climb Policy",
          items: [
            {
              kind: "boolean",
              path: "context.climb.enabled",
              label: "Enable climb into open intents",
              description: "Allow Palim to step its fold frontier into long-running stable open intents one level at a time instead of folding only the root prefix.",
            },
            {
              kind: "integer",
              path: "context.climb.stableRounds",
              label: "Stable rounds before climb",
              description: "Minimum rounds an open intent level must remain unchanged before Palim considers it stable enough to climb into.",
              unit: "rounds",
              min: 1,
              max: 100,
              step: 1,
            },
            {
              kind: "integer",
              path: "context.climb.roundsPerLevel",
              label: "Rounds between frontier steps",
              description: "Minimum rounds waited between successive Palim frontier advances into deeper intent levels.",
              unit: "rounds",
              min: 1,
              max: 100,
              step: 1,
            },
            {
              kind: "number",
              path: "context.climb.fastOccupancy",
              label: "Fast climb occupancy",
              description: "Occupancy fraction of W (default 0.50) above which climb speeds up by fastFactor and bypasses the voluntary cost check.",
              min: 0.1,
              max: 0.99,
              step: 0.05,
            },
            {
              kind: "number",
              path: "context.climb.fastFactor",
              label: "Fast climb speed-up factor",
              description: "Divisor applied to stableRounds and roundsPerLevel once occupancy exceeds fastOccupancy (default 2).",
              min: 1,
              max: 10,
              step: 0.5,
            },
            {
              kind: "number",
              path: "context.climb.skipCloseProb",
              label: "Skip climb above close prob",
              description: "Skip climbing into an open intent when Janus estimates its closure probability is at or above this value (default 0.50), letting Precip handle it naturally.",
              min: 0.05,
              max: 0.99,
              step: 0.05,
            },
            {
              kind: "nullable-number",
              path: "context.climb.innermostMinTokens",
              label: "Innermost level min tokens",
              description: "Minimum token size required before folding inside the innermost open intent. Leave blank/null for the default (2 × Tmin).",
              unit: "tokens",
              min: 2048,
              step: 4096,
              nullLabel: "auto (2 × Tmin)",
            },
            {
              kind: "boolean",
              path: "context.climb.costCheck",
              label: "Prompt-cache cost check",
              description: "Below fastOccupancy, skip voluntary folds whose prompt-cache invalidation + aux fold cost exceeds expected savings over upcoming requests.",
            },
            {
              kind: "number-or-auto",
              path: "context.climb.expectedRequests",
              label: "Expected remaining requests",
              description: 'Number of future requests used in the cache cost check, or "auto" to estimate from historical session lengths.',
              min: 1,
              max: 1000,
            },
          ],
        },
        {
          id: "janus",
          title: "Janus Intent Tracking",
          items: [
            {
              kind: "integer",
              path: "janus.timeoutMs",
              label: "Decision timeout",
              description: "Wall-clock timeout (ms) for Janus decision calls before failing safe (continue without closing). Janus never retries.",
              unit: "ms",
              min: 100,
              max: 300_000,
              step: 1_000,
            },
            {
              kind: "integer",
              path: "janus.lateWaitMs",
              label: "Late-answer wait window",
              description: "Milliseconds to wait for an in-flight Janus response at a commit boundary before proceeding and applying the answer at the next commit point.",
              unit: "ms",
              min: 0,
              max: 120_000,
              step: 1_000,
            },
            {
              kind: "integer",
              path: "janus.maxInputTokens",
              label: "Max evidence tokens",
              description: "Token cap on the transcript evidence bundle sent to Janus on each step.",
              unit: "tokens",
              min: 512,
              max: 64_000,
              step: 1000,
            },
            {
              kind: "integer",
              path: "janus.remindEvery",
              label: "Intent reminder interval",
              description: "Append a compact reminder of the active intent every N rounds while staying inside the same intent (0 disables reminders).",
              unit: "rounds",
              min: 0,
              max: 100,
              step: 1,
            },
            {
              kind: "integer",
              path: "janus.maxDepth",
              label: "Max intent nesting depth",
              description: "Maximum depth of nested intents allowed on the intent stack before deepen requests are ignored.",
              min: 1,
              max: 20,
              step: 1,
            },
          ],
        },
        {
          id: "attribution",
          title: "Delivery Attribution",
          items: [
            {
              kind: "integer",
              path: "attribution.rootWindowRounds",
              label: "Root-region credit window",
              description: "Number of rounds after which memory deliveries made outside any open intent (in the root region) are attributed for use/value.",
              unit: "rounds",
              min: 1,
              max: 50,
              step: 1,
            },
          ],
        },
      ],
    }),
  },

  // ═══════════════════════════════════════════════════════════ 3. Memory
  {
    id: "memory",
    title: "Memory",
    aliases: ["mem", "evolution", "paths", "instructions", "reverify", "urgency"],
    description: "Tune memory graph weights, similarity & calibration, proactive delivery, search budgets, scope routing, forgetting, urgency gating, EvoDisco evolution, re-verification, path anchors, and instruction ingestion.",
    summary: (cfg) => `caps: ${cfg.memory.caps.short}/${cfg.memory.caps.long} · gate: ${cfg.memory.proactive.gate} · evo: ${cfg.evolution.policy} · reverify: ${cfg.reverify.enabled ? "on" : "off"}`,
    build: () => ({
      id: "memory",
      title: "Memory Engine",
      subtitle: "Graph retrieval, similarity, routing, lifecycle, urgency, evolution, re-verification, paths, and instructions",
      sections: [
        {
          id: "graph-caps",
          title: "Graph Weights & Soft Caps",
          items: [
            {
              kind: "number",
              path: "memory.kappaShortToLong",
              label: "Short→long centrality discount",
              description: "Discount factor (κ) applied to short-term→long-term edges when computing graph centrality for retention scoring (default 0.25).",
              min: 0,
              max: 1,
              step: 0.05,
            },
            {
              kind: "number",
              path: "memory.kappaActivation",
              label: "Spreading activation weight",
              description: "Multiplier controlling how strongly retrieval activation spreads along memory graph edges (default 1.0).",
              min: 0,
              max: 5,
              step: 0.1,
            },
            {
              kind: "integer",
              path: "memory.caps.short",
              label: "Short-term soft cap",
              description: "Target active short-term memory count per scope. Exceeding this cap tightens the forgetting retention threshold.",
              unit: "nodes",
              min: 50,
              max: 100_000,
              step: 250,
            },
            {
              kind: "integer",
              path: "memory.caps.long",
              label: "Long-term soft cap",
              description: "Target active long-term memory count per scope before hygiene/forgetting pressure increases.",
              unit: "nodes",
              min: 100,
              max: 200_000,
              step: 500,
            },
          ],
        },
        {
          id: "similarity",
          title: "Similarity & Calibration",
          items: [
            {
              kind: "number",
              path: "memory.similarity.dedup",
              label: "De-duplication threshold",
              description: "Dense-cosine threshold above which a new memory merges into an existing node as a duplicate (calibrated automatically for late-interaction models).",
              min: 0.1,
              max: 1,
              step: 0.02,
            },
            {
              kind: "number",
              path: "memory.similarity.conflict",
              label: "Conflict candidate threshold",
              description: "Minimum similarity for existing memories to be inspected for supersede/contradict/subsume conflicts on write.",
              min: 0.1,
              max: 1,
              step: 0.02,
            },
            {
              kind: "number",
              path: "memory.similarity.floor",
              label: "Retrieval similarity floor",
              description: "Minimum semantic similarity required for a dense or late-interaction hit to enter retrieval scoring.",
              min: 0.1,
              max: 1,
              step: 0.02,
            },
            {
              kind: "number",
              path: "memory.similarity.fusion",
              label: "Evolution fusion threshold",
              description: "Minimum similarity used by hygiene fusion to cluster near-duplicate memories for merging.",
              min: 0.1,
              max: 1,
              step: 0.02,
            },
            {
              kind: "number",
              path: "memory.similarity.intentDuplicate",
              label: "Intent duplicate guard",
              description: "Similarity threshold above which Janus treats a proposed intent label as a duplicate of an already-open intent.",
              min: 0.1,
              max: 1,
              step: 0.02,
            },
            {
              kind: "number",
              path: "memory.similarity.analogous",
              label: "Analogous link threshold",
              description: "Similarity threshold for discovering analogous memory candidates during graph evolution.",
              min: 0.1,
              max: 1,
              step: 0.02,
            },
            {
              kind: "enum",
              path: "memory.similarity.calibrate",
              label: "Threshold calibration mode",
              description: "Automatically calibrate MaxSim / cosine thresholds against the bundled labeled pair set and ongoing decision verdicts.",
              options: [
                { value: "auto", label: "auto", description: "Calibrate automatically on first use and refit from logged verdicts" },
                { value: "off", label: "off", description: "Use the raw configured similarity values without calibration" },
              ],
            },
            {
              kind: "integer",
              path: "memory.similarity.learn.refitEvery",
              label: "Refit interval (pairs)",
              description: "Number of newly labeled write/fusion pairs accumulated before refitting a model's similarity thresholds.",
              unit: "pairs",
              min: 10,
              max: 10_000,
              step: 50,
            },
            {
              kind: "number",
              path: "memory.similarity.learn.belowSample",
              label: "Below-threshold sample rate",
              description: "Fraction of pairs falling just below a threshold that are still checked by the decision model (inverse-probability weighted during refit).",
              min: 0,
              max: 0.5,
              step: 0.01,
            },
            {
              kind: "number",
              path: "memory.similarity.learn.maxStep",
              label: "Max threshold move per refit",
              description: "Maximum amount any single calibration refit may shift a similarity threshold (default 0.05).",
              min: 0.005,
              max: 0.25,
              step: 0.01,
            },
          ],
        },
        {
          id: "proactive-search",
          title: "Proactive Delivery & Search",
          items: [
            {
              kind: "integer",
              path: "memory.proactive.maxCards",
              label: "Proactive max cards",
              description: "Maximum number of proactive memory cards injected when a new intent is kindled.",
              unit: "cards",
              min: 0,
              max: 25,
              step: 1,
            },
            {
              kind: "integer",
              path: "memory.proactive.maxTokens",
              label: "Proactive token budget",
              description: "Maximum total tokens allocated to proactive memory cards on an intent kindle.",
              unit: "tokens",
              min: 0,
              max: 16_000,
              step: 200,
            },
            {
              kind: "number",
              path: "memory.proactive.gate",
              label: "Proactive relevance gate",
              description: "Minimum decision probability required to inject proactive cards (default 0.60; aux emulation enforces ≥ 0.70).",
              min: 0.1,
              max: 0.99,
              step: 0.05,
            },
            {
              kind: "integer",
              path: "memory.proactive.candidates",
              label: "Proactive candidate pool",
              description: "Number of top retrieval candidates scored by the proactive gate when an intent opens.",
              min: 1,
              max: 50,
              step: 1,
            },
            {
              kind: "integer",
              path: "memory.search.quickTokens",
              label: "Quick search token budget",
              description: "Token budget for `search` tool results in default quick mode.",
              unit: "tokens",
              min: 200,
              max: 16_000,
              step: 250,
            },
            {
              kind: "integer",
              path: "memory.search.thoroughTokens",
              label: "Thorough search token budget",
              description: "Token budget for constructed evidence cards returned by `search` in thorough (QEMem) mode.",
              unit: "tokens",
              min: 400,
              max: 32_000,
              step: 500,
            },
            {
              kind: "integer",
              path: "memory.search.refineRounds",
              label: "Thorough search refine rounds",
              description: "Maximum follow-up gap-query rounds QEMem runs when the constructor reports missing evidence.",
              min: 0,
              max: 8,
              step: 1,
            },
          ],
        },
        {
          id: "routing",
          title: "Scope Routing Thresholds",
          items: [
            {
              kind: "number",
              path: "memory.routing.shared",
              label: "Shared scope threshold",
              description: "Minimum decision confidence required to route a memory to the git-synced Project Shared scope (default 0.85; aux emulation uses 0.95). Project configs may only tighten this.",
              min: 0.1,
              max: 1,
              step: 0.05,
            },
            {
              kind: "number",
              path: "memory.routing.global",
              label: "Global scope threshold",
              description: "Minimum decision confidence required to route a cross-project memory to the Global scope (default 0.70). Project configs may only tighten this.",
              min: 0.1,
              max: 1,
              step: 0.05,
            },
            {
              kind: "number",
              path: "memory.routing.discard",
              label: "Discard threshold",
              description: "Decision confidence above which a candidate is discarded as ephemeral/unworthy of storage (default 0.60). Lower values are stricter.",
              min: 0.1,
              max: 1,
              step: 0.05,
            },
          ],
        },
        {
          id: "forgetting",
          title: "Lifecycle & Forgetting",
          items: [
            {
              kind: "integer",
              path: "memory.forgetting.intervalTurns",
              label: "Forgetting interval",
              description: "Number of turns between scheduled automatic forgetting passes.",
              unit: "turns",
              min: 10,
              max: 10_000,
              step: 50,
            },
            {
              kind: "number",
              path: "memory.forgetting.threshold",
              label: "Retention threshold",
              description: "Short-term memories whose retention score drops below this threshold transition to dormant (pinned and protected memories are exempt).",
              min: 0.01,
              max: 0.95,
              step: 0.02,
            },
            {
              kind: "number",
              path: "memory.forgetting.strengthFloor",
              label: "Retrieval strength floor",
              description: "Lower bound applied to decayed memory strength during retrieval scoring so older relevant memories remain discoverable.",
              min: 0,
              max: 0.5,
              step: 0.01,
            },
            {
              kind: "integer",
              path: "memory.forgetting.dormantDays",
              label: "Dormant grace period",
              description: "Days a dormant memory stays recoverable before eligible for archival cleanup.",
              unit: "days",
              min: 1,
              max: 365,
              step: 5,
            },
            {
              kind: "number",
              path: "forget.queryMargin",
              label: "Forget query disambiguation margin",
              description: "Minimum score gap between the #1 and #2 search hits required for `/realctx2 forget <query>` or the `forget` tool to act without asking for an exact ID.",
              min: 0.01,
              max: 0.9,
              step: 0.02,
            },
          ],
        },
        {
          id: "urgency",
          title: "Urgency & Pre-Edit Gating",
          items: [
            {
              kind: "enum",
              path: "urgency.gate",
              label: "Pre-edit gate",
              description: "When auto, edits or shell commands matching an unshown `immediate` memory are blocked once with the rule text so the agent sees it before acting.",
              options: [
                { value: "auto", label: "auto", description: "Gate matching edits and commands once per unshown immediate memory" },
                { value: "off", label: "off", description: "Disable pre-edit blocking; immediate memories downgrade to hints" },
              ],
            },
            {
              kind: "integer",
              path: "urgency.escalateAfter",
              label: "Escalate after violations",
              description: "Number of attributed rule violations before a memory's urgency automatically escalates one level (unless user-overridden).",
              min: 1,
              max: 20,
              step: 1,
            },
            {
              kind: "integer",
              path: "urgency.maxUnshownChecks",
              label: "Max unshown compliance checks",
              description: "Maximum number of unshown path rules checked for compliance when an intent closes.",
              min: 0,
              max: 100,
              step: 2,
            },
          ],
        },
        {
          id: "evolution",
          title: "Graph Evolution (EvoDisco)",
          items: [
            {
              kind: "enum",
              path: "evolution.policy",
              label: "Evolution policy",
              description: "Strategy controller selecting Abstract, Refine, Bridge, and Reframe graph edits during idle maintenance.",
              options: [
                { value: "teacher", label: "teacher", description: "Decision-model teacher chooses operators (falls back to rules)" },
                { value: "mlp", label: "mlp", description: "Distilled local MLP policy trained from teacher decisions" },
                { value: "rules", label: "rules", description: "Deterministic heuristic operator schedule (no teacher calls)" },
                { value: "off", label: "off", description: "Disable graph evolution operators (hygiene still runs)" },
              ],
            },
            {
              kind: "integer",
              path: "evolution.attemptsPerPass",
              label: "Attempts per maintenance pass",
              description: "Maximum number of evolution operator attempts executed during one idle maintenance pass per scope.",
              min: 0,
              max: 64,
              step: 1,
            },
            {
              kind: "enum",
              path: "evolution.sharedStrategy",
              label: "Shared scope strategy",
              description: "How evolution edits apply to the git-synced Project Shared scope.",
              options: [
                { value: "auto", label: "auto", description: "Commit vetted shared evolution edits (at most once per day)" },
                { value: "propose", label: "propose", description: "Propose shared evolution edits to the review queue instead of committing" },
                { value: "off", label: "off", description: "Do not run evolution operators on the shared scope" },
              ],
            },
            {
              kind: "boolean",
              path: "evolution.teacher",
              label: "Enable decision-model teacher",
              description: "Allow the decision model to act as teacher for operator selection and MLP training.",
            },
            {
              kind: "number",
              path: "evolution.hyper.alpha",
              label: "Hyper: utility weight (alpha)",
              description: "EvoDisco reward weight for retrieval utility gain ΔQ.",
              min: 0,
              max: 10,
              step: 0.1,
            },
            {
              kind: "number",
              path: "evolution.hyper.beta",
              label: "Hyper: efficacy weight (beta)",
              description: "EvoDisco reward weight for strategic efficacy E.",
              min: 0,
              max: 10,
              step: 0.05,
            },
            {
              kind: "number",
              path: "evolution.hyper.gamma",
              label: "Hyper: regret scale (gamma)",
              description: "EvoDisco scaling weight for counterfactual regret in efficacy scoring.",
              min: 0,
              max: 10,
              step: 0.1,
            },
            {
              kind: "number",
              path: "evolution.hyper.delta",
              label: "Hyper: prediction error scale (delta)",
              description: "EvoDisco weight for reward prediction error.",
              min: 0,
              max: 10,
              step: 0.1,
            },
            {
              kind: "number",
              path: "evolution.hyper.eta",
              label: "Hyper: diversity bonus (eta)",
              description: "EvoDisco weight rewarding operator diversity across recent attempts.",
              min: 0,
              max: 10,
              step: 0.05,
            },
            {
              kind: "integer",
              path: "evolution.hyper.K",
              label: "Hyper: candidate neighborhood (K)",
              description: "Neighborhood size K sampled when proposing graph evolution candidates.",
              min: 2,
              max: 128,
              step: 2,
            },
            {
              kind: "integer",
              path: "evolution.hyper.N",
              label: "Hyper: history window (N)",
              description: "Window length N used for tracking recent operator diversity and rolling metrics.",
              min: 1,
              max: 64,
              step: 1,
            },
            {
              kind: "number",
              path: "evolution.hyper.lambda.0",
              label: "Hyper: lambda[0] (size penalty)",
              description: "First component of the EvoDisco complexity penalty vector λ (node count penalty, default 0.001).",
              min: 0,
              max: 10,
              step: 0.001,
            },
            {
              kind: "number",
              path: "evolution.hyper.lambda.1",
              label: "Hyper: lambda[1] (edge/density penalty)",
              description: "Second component of the EvoDisco complexity penalty vector λ (default 1.0).",
              min: 0,
              max: 10,
              step: 0.1,
            },
            {
              kind: "number",
              path: "evolution.hyper.lambda.2",
              label: "Hyper: lambda[2] (churn penalty)",
              description: "Third component of the EvoDisco complexity penalty vector λ (default 0.1).",
              min: 0,
              max: 10,
              step: 0.05,
            },
          ],
        },
        {
          id: "reverify",
          title: "Code Re-verification",
          items: [
            {
              kind: "boolean",
              path: "reverify.enabled",
              label: "Enable re-verification",
              description: "Automatically re-verify path-anchored memories when their referenced source files change.",
            },
            {
              kind: "nullable-number",
              path: "reverify.maxPerDay",
              label: "Daily reverify session cap",
              description: "Maximum aux re-verification sessions allowed per day, or blank/null for unlimited (model-free quote/symbol checks always run).",
              min: 0,
              max: 1000,
              step: 5,
              nullLabel: "unlimited (null)",
            },
            {
              kind: "boolean",
              path: "reverify.countsTowardBudget",
              label: "Count toward daily aux budget",
              description: "When enabled, re-verification tokens are deducted from budgets.dailyAuxTokens instead of tracked separately.",
            },
            {
              kind: "enum",
              path: "reverify.rules",
              label: "Rule update policy",
              description: "Controls whether re-verification may automatically edit stale rule memories or send them to /realctx2 review.",
              options: [
                { value: "auto-mechanical", label: "auto-mechanical", description: "Auto-apply mechanical renames/paths; send semantic rule changes to review" },
                { value: "auto", label: "auto", description: "Automatically apply all re-verified rule updates" },
                { value: "review", label: "review", description: "Always route rule changes to the review queue" },
              ],
            },
            {
              kind: "integer",
              path: "reverify.settleMinutes",
              label: "Edit settle delay",
              description: "Minutes to wait after a file stops changing before scheduling aux re-verification, avoiding churn during rapid editing.",
              unit: "min",
              min: 0,
              max: 120,
              step: 2,
            },
            {
              kind: "enum",
              path: "reverify.sharedAgainst",
              label: "Shared memory reference",
              description: "Which version of the repository shared memories are verified against.",
              options: [
                { value: "HEAD", label: "HEAD", description: "Verify shared memories only against committed HEAD (wait if working copy differs)" },
                { value: "worktree", label: "worktree", description: "Verify shared memories directly against current working-tree files" },
              ],
            },
          ],
        },
        {
          id: "paths",
          title: "Path Anchors & Just-in-Time Delivery",
          items: [
            {
              kind: "boolean",
              path: "paths.deliver",
              label: "Deliver path memories",
              description: "Attach relevant path-anchored memories to tool results when the agent reads, edits, or runs commands on matching paths.",
            },
            {
              kind: "integer",
              path: "paths.perResultTokens",
              label: "Per tool-result budget",
              description: "Token budget for `[paths]` blocks appended to a single tool result (immediate rules are never cut; hints degrade to captions).",
              unit: "tokens",
              min: 0,
              max: 8000,
              step: 100,
            },
            {
              kind: "integer",
              path: "paths.perTurnTokens",
              label: "Per turn total budget",
              description: "Total token budget across all `[paths]` memory deliveries within one assistant turn.",
              unit: "tokens",
              min: 0,
              max: 16_000,
              step: 250,
            },
            {
              kind: "integer",
              path: "paths.absentToDeletedDays",
              label: "Absent-to-deleted days",
              description: "Days a missing tracked file remains marked absent (surviving branch switches) before being treated as deleted.",
              unit: "days",
              min: 1,
              max: 365,
              step: 1,
            },
            {
              kind: "number",
              path: "paths.moveSimilarity",
              label: "File rename fingerprint similarity",
              description: "Minimum content fingerprint similarity required to match a renamed and edited file outside git rename detection.",
              min: 0.1,
              max: 1,
              step: 0.05,
            },
            {
              kind: "number",
              path: "paths.dirMoveShare",
              label: "Directory move share",
              description: "Fraction of tracked files under a directory that must move together to infer a whole-directory rename.",
              min: 0.1,
              max: 1,
              step: 0.05,
            },
          ],
        },
        {
          id: "instructions",
          title: "Instruction Files (AGENTS.md / CLAUDE.md)",
          items: [
            {
              kind: "boolean",
              path: "instructions.deleteAfterIngest",
              label: "Delete files after ingest",
              description: "Delete tracked instruction files (and back up then delete untracked ones) after `/realctx2 ingest` slices them with full coverage.",
            },
            {
              kind: "boolean",
              path: "instructions.ignoreAfterIngest",
              label: "Ignore ingested files in harness",
              description: "Filter already-ingested instruction files out of pi's contextFiles / Claude Code loading so rules aren't duplicated.",
            },
            {
              kind: "integer",
              path: "instructions.alwaysOnTokens",
              label: "Always-on project rules budget",
              description: "Token budget for the always-on Project rules system-prompt section synthesized from root-level ingested rules.",
              unit: "tokens",
              min: 0,
              max: 16_000,
              step: 250,
            },
            {
              kind: "multi-enum",
              path: "instructions.include",
              label: "Included instruction sources",
              description: "Categories of instruction files discovered by `/realctx2 ingest` by default.",
              options: INSTRUCTION_INCLUDE_OPTIONS,
            },
            {
              kind: "integer",
              path: "instructions.importHops",
              label: "Max @import hops",
              description: "Maximum recursion depth followed when resolving `@file` imports inside instruction markdown files.",
              min: 0,
              max: 16,
              step: 1,
            },
            {
              kind: "boolean",
              path: "instructions.verifyWithDecisionModel",
              label: "Verify slices with decision model",
              description: "Ask the decision model to check faithfulness of each sliced rule item during `/realctx2 ingest`.",
            },
          ],
        },
      ],
    }),
  },

  // ═══════════════════════════════════════════════════════════ 4. Index & Storage
  {
    id: "storage",
    title: "Index & Storage",
    aliases: ["index", "shared", "loro", "vectors"],
    description: "Configure late-interaction vector indexing, quantization & eviction caps, Loro CRDT compaction, and git-synced shared store settings.",
    summary: (cfg) => `idx: ${formatBytes(cfg.index.maxBytes)} · flush: ${cfg.storage.flushMinutes}m · shared review: ${cfg.shared.review ? "on" : "off"}`,
    build: () => ({
      id: "storage",
      title: "Index & Storage",
      subtitle: "Late-interaction vector index, Loro CRDT storage, and git-synced shared repository store",
      sections: [
        {
          id: "late-index",
          title: "Vector Index (Late Interaction)",
          items: [
            {
              kind: "integer",
              path: "index.maxBytes",
              label: "Max turn index size",
              description: "Byte budget per project turn index before oldest raw-turn token matrices (then FDEs and dense vectors) are evicted. Memories and consolidated turns are never evicted.",
              unit: "bytes",
              min: 1_048_576,
              step: 134_217_728,
            },
            {
              kind: "integer",
              path: "index.lateInteraction.exactMax",
              label: "Exact MaxSim cutoff",
              description: "Maximum item count in a scope scored with exact brute-force MaxSim before switching to two-stage FDE candidate pre-filtering.",
              unit: "items",
              min: 50,
              max: 50_000,
              step: 500,
            },
            {
              kind: "integer",
              path: "index.lateInteraction.candidates",
              label: "Two-stage FDE candidates",
              description: "Number of top FDE candidates re-ranked with exact MaxSim during two-stage late-interaction search.",
              min: 10,
              max: 5000,
              step: 50,
            },
            {
              kind: "integer",
              path: "index.lateInteraction.recentDays",
              label: "Recent turns tier age",
              description: "Age window (days) during which raw-turn token vectors stay at `recentTurns` quantization before aging down to `olderTurns`.",
              unit: "days",
              min: 1,
              max: 365,
              step: 5,
            },
            {
              kind: "integer",
              path: "index.lateInteraction.fdeDims",
              label: "MUVERA FDE dimensions",
              description: "Fixed-dimensional encoding width computed locally from token vectors for fast first-stage candidate lookup.",
              min: 64,
              max: 4096,
              step: 128,
              restart: true,
            },
            {
              kind: "enum",
              path: "index.lateInteraction.fdeQuant",
              label: "FDE quantization",
              description: "Storage precision for MUVERA FDE vectors (int8 uses 1 byte/dim; float32 uses 4 bytes/dim).",
              options: [
                { value: "int8", label: "int8", description: "Compact 8-bit integer FDE vectors (512 B per chunk at 512 dims)" },
                { value: "float32", label: "float32", description: "Full 32-bit floating-point FDE vectors" },
              ],
              restart: true,
            },
            {
              kind: "integer",
              path: "index.lateInteraction.pool.memories",
              label: "Token pooling (memories)",
              description: "Hierarchical token pooling factor for memory-node vectors (1 = unpooled full precision).",
              min: 1,
              max: 8,
              step: 1,
            },
            {
              kind: "integer",
              path: "index.lateInteraction.pool.turns",
              label: "Token pooling (turns)",
              description: "Token pooling factor for consolidated and raw turn vectors (2 halves vector storage).",
              min: 1,
              max: 8,
              step: 1,
            },
            {
              kind: "enum",
              path: "index.lateInteraction.quantize.memories",
              label: "Quantization (memories)",
              description: "Stored precision of memory-node token matrices.",
              options: [
                { value: "int8", label: "int8", description: "8-bit scalar quantization (4× smaller than float32)" },
                { value: "float32", label: "float32", description: "Unquantized 32-bit floats" },
              ],
            },
            {
              kind: "enum",
              path: "index.lateInteraction.quantize.recentTurns",
              label: "Quantization (recent turns)",
              description: "Stored precision of raw-turn token matrices newer than `recentDays`.",
              options: [
                { value: "int8", label: "int8", description: "8-bit scalar quantization" },
                { value: "float32", label: "float32", description: "Unquantized 32-bit floats" },
              ],
            },
            {
              kind: "enum",
              path: "index.lateInteraction.quantize.olderTurns",
              label: "Quantization (older turns)",
              description: "Stored precision of raw-turn token matrices older than `recentDays`.",
              options: [
                { value: "binary", label: "binary", description: "1-bit binary quantization (~16× smaller than int8)" },
                { value: "int8", label: "int8", description: "Keep 8-bit quantization for older turns" },
              ],
            },
          ],
        },
        {
          id: "loro-storage",
          title: "Loro CRDT Storage & Compaction",
          items: [
            {
              kind: "integer",
              path: "storage.flushMinutes",
              label: "Periodic flush interval",
              description: "Minutes between automatic mid-session flushes of dirty memory stores to immutable update files.",
              unit: "min",
              min: 1,
              max: 120,
              step: 5,
            },
            {
              kind: "boolean",
              path: "storage.peerReuse",
              label: "Reuse released PeerIDs",
              description: "Reuse previously released Loro PeerIDs when the document still contains their operations (reduces metadata growth; off by default).",
              restart: true,
            },
            {
              kind: "integer",
              path: "storage.compact.maxUpdateFiles",
              label: "Compaction max update files",
              description: "Trigger Loro store compaction once uncompacted update files exceed this count.",
              unit: "files",
              min: 4,
              max: 1000,
              step: 16,
            },
            {
              kind: "number",
              path: "storage.compact.maxUpdateShare",
              label: "Compaction max update share",
              description: "Trigger compaction when update files exceed this ratio of the snapshot size.",
              min: 0.05,
              max: 5,
              step: 0.05,
            },
            {
              kind: "integer",
              path: "storage.compact.maxAgeDays",
              label: "Compaction max age",
              description: "Trigger compaction when the oldest uncompacted update file exceeds this age in days.",
              unit: "days",
              min: 1,
              max: 365,
              step: 5,
            },
            {
              kind: "integer",
              path: "storage.maxUpdateBytes",
              label: "Max update file bytes",
              description: "Safety cap on the size of any single Loro update file loaded from disk; oversized files are skipped and reported.",
              unit: "bytes",
              min: 65_536,
              step: 1_000_000,
            },
            {
              kind: "integer",
              path: "storage.maxSnapshotBytes",
              label: "Max snapshot file bytes",
              description: "Safety cap on the size of any Loro snapshot file loaded from disk.",
              unit: "bytes",
              min: 1_048_576,
              step: 10_000_000,
            },
            {
              kind: "enum",
              path: "storage.gitLfs",
              label: "Git LFS mode",
              description: "Controls whether `.pi/realctx2/` shared store binaries track via Git LFS.",
              options: [
                { value: "auto", label: "auto", description: "Use Git LFS automatically if configured in .gitattributes" },
                { value: "on", label: "on", description: "Require Git LFS tracking for shared store files" },
                { value: "off", label: "off", description: "Never use Git LFS for shared store files" },
              ],
            },
          ],
        },
        {
          id: "shared-store",
          title: "Shared Repository Store (.pi/realctx2/)",
          items: [
            {
              kind: "boolean",
              path: "shared.review",
              label: "Require review for shared writes",
              description: "Hold shared memory writes in the review queue instead of flushing directly to `.pi/realctx2/`. Project configs may force this true.",
            },
            {
              kind: "enum",
              path: "shared.compactOn",
              label: "Shared compaction branch policy",
              description: "Which git branches are permitted to compact the shared Loro store.",
              options: [
                { value: "any", label: "any", description: "Compact on any branch (off-default compacts back to default-branch snapshot)" },
                { value: "default-branch", label: "default-branch", description: "Only compact when checked out on the repository's default branch" },
                { value: "manual", label: "manual", description: "Only compact when `/realctx2 compact shared` is run manually" },
              ],
            },
            {
              kind: "optional-string",
              path: "shared.defaultBranch",
              label: "Default git branch override",
              description: "Explicit default branch name (e.g. main) for shared compaction and branch-aware path tracking. Leave blank to auto-detect from git.",
              placeholder: "main",
              nullLabel: "auto-detect (null)",
              get: (c) => c.shared.defaultBranch ?? undefined,
              set: (c, v) => setConfigPath(c, "shared.defaultBranch", v === undefined || v === "" ? null : String(v)),
              defaultValue: null,
            },
            {
              kind: "integer",
              path: "shared.counterFlushThreshold",
              label: "Buffered counter flush threshold",
              description: "Number of buffered shared usage counter updates accumulated before flushing a shared update file (avoids dirtying git for read-only sessions).",
              min: 1,
              max: 1000,
              step: 10,
            },
            {
              kind: "string-list",
              path: "shared.ignoreActors",
              label: "Ignored shared actors",
              description: "Actor IDs whose shared-store memories are ignored during retrieval and review.",
              itemPlaceholder: "actor-id",
            },
          ],
        },
      ],
    }),
  },

  // ═══════════════════════════════════════════════════════════ 5. Tools, Budgets & System
  {
    id: "system",
    title: "Tools, Budgets & System",
    aliases: ["tools", "budgets", "privacy", "maintenance", "claude", "claudecode"],
    description: "Enable/disable or rename agent tools, configure daily token budgets, privacy & session indexing, idle maintenance timing, and Claude Code integration.",
    summary: (cfg) => {
      const enabled = 3 + (cfg.tools.remember ? 1 : 0) + (cfg.tools.forget ? 1 : 0);
      return `tools: ${enabled}/5 · aux cap: ${(cfg.budgets.dailyAuxTokens / 1e6).toFixed(1)}M · idle: ${cfg.maintenance.idleMinutes}m`;
    },
    build: () => ({
      id: "system",
      title: "Tools, Budgets & System",
      subtitle: "Agent tools, daily spend caps, privacy, maintenance, and Claude Code integration",
      sections: [
        {
          id: "tools",
          title: "Agent Tools",
          items: [
            {
              kind: "boolean",
              path: "tools.remember",
              label: "Expose remember tool",
              description: "Register the agent-callable `remember` tool so the model can explicitly store memories.",
              restart: true,
            },
            {
              kind: "boolean",
              path: "tools.forget",
              label: "Expose forget tool",
              description: "Register the agent-callable `forget` tool so the model can retire stale memories.",
              restart: true,
            },
            {
              kind: "string",
              path: "tools.names.search",
              label: "Tool name: search",
              description: "Effective tool name registered for realctx2's `search` tool. Change this if another extension already registers `search`.",
              placeholder: "search",
              restart: true,
            },
            {
              kind: "string",
              path: "tools.names.recall",
              label: "Tool name: recall",
              description: "Effective tool name registered for realctx2's `recall` tool.",
              placeholder: "recall",
              restart: true,
            },
            {
              kind: "string",
              path: "tools.names.inspect",
              label: "Tool name: inspect",
              description: "Effective tool name registered for realctx2's `inspect` tool.",
              placeholder: "inspect",
              restart: true,
            },
            {
              kind: "string",
              path: "tools.names.remember",
              label: "Tool name: remember",
              description: "Effective tool name registered for realctx2's `remember` tool.",
              placeholder: "remember",
              restart: true,
            },
            {
              kind: "string",
              path: "tools.names.forget",
              label: "Tool name: forget",
              description: "Effective tool name registered for realctx2's `forget` tool.",
              placeholder: "forget",
              restart: true,
            },
          ],
        },
        {
          id: "budgets",
          title: "Daily Token Budgets",
          items: [
            {
              kind: "integer",
              path: "budgets.dailyAuxTokens",
              label: "Daily aux token budget",
              description: "Daily token limit across auxiliary LLM sessions (Janus scribe, Precip, Palim, thorough search, evolution). Background maintenance pauses once reached.",
              unit: "tokens",
              min: 0,
              step: 250_000,
            },
            {
              kind: "integer",
              path: "budgets.dailyDecisionTokens",
              label: "Daily decision token budget",
              description: "Daily input token limit for HTTP decision-model calls.",
              unit: "tokens",
              min: 0,
              step: 500_000,
            },
          ],
        },
        {
          id: "privacy-maintenance",
          title: "Privacy & Maintenance",
          items: [
            {
              kind: "enum",
              path: "privacy.indexSessions",
              label: "Session turn indexing",
              description: "Controls whether transcripts from sessions are indexed locally for `search` (`where: 'project'`).",
              options: [
                { value: "new-only", label: "new-only", description: "Index turns from new sessions run with realctx2" },
                { value: "off", label: "off", description: "Do not index session transcripts" },
              ],
            },
            {
              kind: "boolean",
              path: "privacy.telemetryContent",
              label: "Include content in local logs",
              description: "When false (default), local telemetry logs record only counts, latencies, and IDs—never prompt/memory text.",
              restart: true,
            },
            {
              kind: "number",
              path: "maintenance.idleMinutes",
              label: "Idle maintenance delay",
              description: "Minutes of user inactivity after agent settlement before idle harvesting, embedding, re-verification, and evolution run.",
              unit: "min",
              min: 0,
              max: 1440,
              step: 1,
            },
          ],
        },
        {
          id: "claude-code",
          title: "Claude Code Integration",
          items: [
            {
              kind: "boolean",
              path: "claudeCode.disableAutoMemory",
              label: "Disable Claude Code auto-memory",
              description: "Configure Claude Code settings so its built-in auto-memory does not compete with realctx2.",
              restart: true,
            },
            {
              kind: "boolean",
              path: "claudeCode.importAutoMemory",
              label: "Import Claude Code auto-memory",
              description: "During idle maintenance, import existing Claude Code auto-memory notes as unpinned short-term memories, then back them up and delete the originals.",
              restart: true,
            },
          ],
        },
      ],
    }),
  },
];

export function findCategory(query: string): SettingCategory | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  return SETTINGS_CATEGORIES.find(
    (c) => c.id === q || c.title.toLowerCase() === q || c.aliases?.includes(q) || c.id.startsWith(q),
  );
}

export interface SearchableSetting {
  categoryId: string;
  categoryTitle: string;
  sectionTitle: string;
  entry: EditableSetting;
  searchText: string;
}

/** Flatten every editable parameter across all categories (including endpoints & aux roles) for global `/` search. */
export function flattenAllSettings(cfg: Config, ctx?: SettingsDisplayContext): SearchableSetting[] {
  const out: SearchableSetting[] = [];
  const visitScreen = (categoryId: string, categoryTitle: string, screen: SettingScreenSpec, prefix?: string) => {
    for (const sec of screen.sections) {
      const secTitle = prefix ? `${prefix} › ${sec.title}` : sec.title;
      for (const item of sec.items) {
        if (item.kind === "subscreen") {
          visitScreen(categoryId, categoryTitle, item.build(cfg, ctx), prefix ? `${prefix} › ${item.label}` : item.label);
        } else if (item.kind === "action") {
          continue;
        } else {
          out.push({
            categoryId,
            categoryTitle,
            sectionTitle: secTitle,
            entry: item,
            searchText: `${categoryTitle} ${secTitle} ${item.label} ${item.path} ${item.description}`,
          });
        }
      }
    }
  };
  for (const cat of SETTINGS_CATEGORIES) {
    visitScreen(cat.id, cat.title, cat.build(cfg, ctx));
  }
  return out;
}

export type { AuxTools, ThinkingLevel };
