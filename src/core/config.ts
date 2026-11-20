/** Configuration (§9.4): defaults, the global file, and restricted project overrides. */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJson, writeJson } from "../util/fs.ts";
import type { AuxRole, AuxTools, ThinkingLevel } from "./types.ts";

export interface DecisionProviderConfig {
  format: "systemone" | "decisions";
  url: string;
  model: string;
  apiKeyEnv?: string;
  apiKey?: string;
  apiKeyFile?: string;
  maxInputTokens?: number;
  maxQuestions?: number;
  registerInPi?: boolean;
  headers?: Record<string, string>;
}

export interface EmbeddingProviderConfig {
  url: string;
  model: string;
  kind?: "dense" | "multivector";
  /** multivector: token-vector width d. */
  dims?: number;
  /** dense: requested output dimensions (sent as `dimensions`). */
  dimensions?: number;
  apiKeyEnv?: string;
  apiKey?: string;
  apiKeyFile?: string;
  role?: "input_type" | "prefix" | "none";
  queryPrefix?: string;
  documentPrefix?: string;
  maxInputTokens?: number;
  batchSize?: number;
  transport?: "embeddings" | "pooling";
  headers?: Record<string, string>;
}

export interface AuxRoleConfig {
  model?: string;
  thinking?: ThinkingLevel;
  tools?: AuxTools;
  maxTurns?: number;
  timeoutMs?: number;
}

export interface AuxHarnessConfig {
  model?: string;
  thinking?: ThinkingLevel;
  extensions?: string[];
  roles?: Partial<Record<AuxRole, AuxRoleConfig>>;
}

export interface Config {
  providers: {
    decision: DecisionProviderConfig | null;
    embedding: { late: EmbeddingProviderConfig | null; dense: EmbeddingProviderConfig | null };
    aux: {
      maxConcurrent: number;
      defaultTools: AuxTools;
      /**
       * How long an aux-emulated decision may take (§9.1.4). An LLM rarely answers within a short
       * call-site timeout (1.5 s for the proactive gate), so this is a floor: the gate gets 20 s,
       * while Janus keeps its longer `janus.timeoutMs`. A commit point waits for an emulated
       * answer at most `janus.lateWaitMs`; one that misses it applies at the next commit point.
       * 0 keeps the call site's timeout.
       */
      emulateTimeoutMs: number;
      guard: { deny: string[]; writesOutsideRepo: "block" | "allow" };
      pi: AuxHarnessConfig;
      claudeCode: AuxHarnessConfig;
    };
  };
  context: {
    /** Upper cap on the effective window W, "auto" to use the active model's catalog contextWindow, or 0 to disable the context engine. */
    maxWindow: "auto" | number;
    /** Per-model overrides for maxWindow (`"provider/model-id"` or `"model-id"` -> `"auto"` | `0` (disable) | tokens). */
    modelMaxWindows: Record<string, "auto" | number>;
    rho: number;
    K: number;
    Bmin: number;
    alpha: number;
    q: number;
    Emin: number;
    Tmin: number;
    deltaMin: number;
    foldRetries: number;
    tauClose: number;
    tauOpen: number;
    precipSkipTokens: number;
    maxToolResultFraction: number;
    settleConsolidation: boolean;
    climb: {
      enabled: boolean;
      stableRounds: number;
      roundsPerLevel: number;
      fastOccupancy: number;
      fastFactor: number;
      skipCloseProb: number;
      innermostMinTokens: number | null;
      costCheck: boolean;
      expectedRequests: "auto" | number;
    };
    cacheTtlSeconds: number;
    /** Per-model overrides for cacheTtlSeconds (`"provider/model-id"` or `"model-id"` -> `"auto"` | seconds). */
    modelCacheTtlSeconds: Record<string, "auto" | number>;
    prepareFraction: number;
    /** Claude Code post-compaction injection budget (§4.6.3). */
    reinjectTokens: number;
  };
  janus: { timeoutMs: number; lateWaitMs: number; maxInputTokens: number; remindEvery: number; maxDepth: number };
  attribution: { rootWindowRounds: number };
  memory: {
    kappaShortToLong: number;
    kappaActivation: number;
    similarity: {
      dedup: number;
      conflict: number;
      floor: number;
      fusion: number;
      intentDuplicate: number;
      analogous: number;
      calibrate: "auto" | "off";
      learn: { refitEvery: number; belowSample: number; maxStep: number };
    };
    proactive: { maxCards: number; maxTokens: number; gate: number; candidates: number };
    routing: { shared: number; global: number; discard: number };
    forgetting: { intervalTurns: number; threshold: number; strengthFloor: number; dormantDays: number };
    caps: { short: number; long: number };
    search: { quickTokens: number; thoroughTokens: number; refineRounds: number };
  };
  index: {
    lateInteraction: {
      exactMax: number;
      candidates: number;
      recentDays: number;
      fdeDims: number;
      fdeQuant: "int8" | "float32";
      pool: { memories: number; turns: number };
      quantize: { memories: "int8" | "float32"; recentTurns: "int8" | "float32"; olderTurns: "binary" | "int8" };
    };
    maxBytes: number;
  };
  evolution: {
    policy: "teacher" | "mlp" | "rules" | "off";
    attemptsPerPass: number;
    sharedStrategy: "auto" | "propose" | "off";
    teacher: boolean;
    hyper: { alpha: number; beta: number; gamma: number; delta: number; eta: number; K: number; N: number; lambda: [number, number, number] };
  };
  urgency: { gate: "auto" | "off"; escalateAfter: number; maxUnshownChecks: number };
  reverify: {
    enabled: boolean;
    maxPerDay: number | null;
    countsTowardBudget: boolean;
    rules: "auto-mechanical" | "auto" | "review";
    settleMinutes: number;
    sharedAgainst: "HEAD" | "worktree";
  };
  paths: {
    deliver: boolean;
    perResultTokens: number;
    perTurnTokens: number;
    absentToDeletedDays: number;
    moveSimilarity: number;
    dirMoveShare: number;
  };
  instructions: {
    deleteAfterIngest: boolean;
    ignoreAfterIngest: boolean;
    alwaysOnTokens: number;
    include: string[];
    importHops: number;
    verifyWithDecisionModel: boolean;
  };
  claudeCode: { disableAutoMemory: boolean; importAutoMemory: boolean };
  storage: {
    compact: { maxUpdateFiles: number; maxUpdateShare: number; maxAgeDays: number };
    flushMinutes: number;
    peerReuse: boolean;
    maxUpdateBytes: number;
    maxSnapshotBytes: number;
    gitLfs: "auto" | "off" | "on";
  };
  shared: { review: boolean; ignoreActors: string[]; compactOn: "any" | "default-branch" | "manual"; defaultBranch: string | null; counterFlushThreshold: number };
  tools: { names: Record<string, string>; remember: boolean; forget: boolean };
  forget: { queryMargin: number };
  budgets: { dailyAuxTokens: number; dailyDecisionTokens: number };
  privacy: { indexSessions: "new-only" | "off"; telemetryContent: boolean };
  maintenance: { idleMinutes: number };
}

export const DEFAULT_CONFIG: Config = {
  providers: {
    decision: null,
    embedding: { late: null, dense: null },
    aux: {
      maxConcurrent: 2,
      defaultTools: "read-only",
      emulateTimeoutMs: 20_000,
      guard: {
        deny: [
          "rm -r*",
          "rm -fr*",
          "git reset --hard*",
          "git clean*",
          "git push*",
          "npm publish*",
          "*curl * | *sh*",
          "*wget * | *sh*",
          "scp *",
          "rsync * *:*",
          "curl * -T *",
          "curl * --upload-file *",
        ],
        writesOutsideRepo: "block",
      },
      pi: { thinking: "medium", extensions: [], roles: {} },
      claudeCode: {
        model: "haiku",
        thinking: "medium",
        roles: { precip: { model: "sonnet" }, palim: { model: "sonnet" }, "ingest.slicer": { model: "sonnet", thinking: "high" } },
      },
    },
  },
  context: {
    maxWindow: "auto",
    modelMaxWindows: {},
    rho: 0.8,
    K: 2,
    Bmin: 4096,
    alpha: 0.2,
    q: 0.95,
    Emin: 2,
    Tmin: 16384,
    deltaMin: 8192,
    foldRetries: 2,
    tauClose: 0.8,
    tauOpen: 0.6,
    precipSkipTokens: 1500,
    maxToolResultFraction: 0.15,
    settleConsolidation: true,
    climb: {
      enabled: true,
      stableRounds: 8,
      roundsPerLevel: 8,
      fastOccupancy: 0.5,
      fastFactor: 2,
      skipCloseProb: 0.5,
      innermostMinTokens: null, // null: 2 · T_min
      costCheck: true,
      expectedRequests: "auto",
    },
    cacheTtlSeconds: 300,
    modelCacheTtlSeconds: {},
    prepareFraction: 0.7,
    reinjectTokens: 8000,
  },
  janus: { timeoutMs: 30_000, lateWaitMs: 10_000, maxInputTokens: 8000, remindEvery: 8, maxDepth: 6 },
  attribution: { rootWindowRounds: 6 },
  memory: {
    kappaShortToLong: 0.25,
    kappaActivation: 1.0,
    similarity: {
      dedup: 0.92,
      conflict: 0.75,
      floor: 0.75,
      fusion: 0.75,
      intentDuplicate: 0.9,
      analogous: 0.85,
      calibrate: "auto",
      learn: { refitEvery: 200, belowSample: 0.05, maxStep: 0.05 },
    },
    proactive: { maxCards: 5, maxTokens: 1200, gate: 0.6, candidates: 8 },
    routing: { shared: 0.85, global: 0.7, discard: 0.6 },
    forgetting: { intervalTurns: 400, threshold: 0.1, strengthFloor: 0.05, dormantDays: 30 },
    caps: { short: 2000, long: 5000 },
    search: { quickTokens: 1500, thoroughTokens: 3000, refineRounds: 2 },
  },
  index: {
    lateInteraction: {
      exactMax: 2000,
      candidates: 200,
      recentDays: 30,
      fdeDims: 512,
      fdeQuant: "int8",
      pool: { memories: 1, turns: 2 },
      quantize: { memories: "int8", recentTurns: "int8", olderTurns: "binary" },
    },
    maxBytes: 1073741824,
  },
  evolution: {
    policy: "teacher",
    attemptsPerPass: 8,
    sharedStrategy: "auto",
    teacher: true,
    hyper: { alpha: 1.0, beta: 0.1, gamma: 1.0, delta: 0.5, eta: 0.1, K: 16, N: 8, lambda: [1 / 1000, 1.0, 0.1] },
  },
  urgency: { gate: "auto", escalateAfter: 2, maxUnshownChecks: 10 },
  reverify: { enabled: true, maxPerDay: null, countsTowardBudget: false, rules: "auto-mechanical", settleMinutes: 10, sharedAgainst: "HEAD" },
  paths: { deliver: true, perResultTokens: 600, perTurnTokens: 1500, absentToDeletedDays: 14, moveSimilarity: 0.8, dirMoveShare: 0.6 },
  instructions: {
    deleteAfterIngest: true,
    ignoreAfterIngest: true,
    alwaysOnTokens: 1500,
    include: ["agents", "claude", "local", "rules"],
    importHops: 4,
    verifyWithDecisionModel: true,
  },
  claudeCode: { disableAutoMemory: true, importAutoMemory: true },
  storage: {
    compact: { maxUpdateFiles: 64, maxUpdateShare: 0.25, maxAgeDays: 30 },
    flushMinutes: 10,
    peerReuse: false,
    maxUpdateBytes: 5_000_000,
    maxSnapshotBytes: 50_000_000,
    gitLfs: "auto",
  },
  shared: { review: false, ignoreActors: [], compactOn: "any", defaultBranch: null, counterFlushThreshold: 50 },
  tools: {
    names: { search: "search", recall: "recall", inspect: "inspect", remember: "remember", forget: "forget" },
    remember: true,
    forget: true,
  },
  forget: { queryMargin: 0.1 },
  budgets: { dailyAuxTokens: 2_000_000, dailyDecisionTokens: 5_000_000 },
  privacy: { indexSessions: "new-only", telemetryContent: false },
  maintenance: { idleMinutes: 2 },
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function deepMerge<T>(base: T, over: unknown): T {
  if (!isObject(base) || !isObject(over)) return (over === undefined ? base : (over as T));
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    out[k] = isObject(out[k]) && isObject(v) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

export interface ProjectOverrideReport {
  applied: string[];
  ignored: string[];
}

function num(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Apply `<repo>/.pi/realctx2/config.json`. The file arrives with the repo, so only an allow-list
 * of non-sensitive keys is honoured (§9.4): provider URLs, keys and models never are.
 */
export function applyProjectOverrides(base: Config, project: unknown): { config: Config; report: ProjectOverrideReport } {
  const report: ProjectOverrideReport = { applied: [], ignored: [] };
  if (!isObject(project)) return { config: base, report };
  const cfg = structuredClone(base);
  const walk = (obj: Record<string, unknown>, path: string[]) => {
    for (const [k, v] of Object.entries(obj)) {
      const p = [...path, k];
      const key = p.join(".");
      if (isObject(v) && !["tools.names", "context.modelMaxWindows", "context.modelCacheTtlSeconds"].includes(key)) {
        walk(v, p);
        continue;
      }
      if (applyOne(cfg, key, v)) report.applied.push(key);
      else report.ignored.push(key);
    }
  };
  walk(project, []);
  return { config: cfg, report };
}

function setPath(obj: unknown, path: string[], value: unknown): boolean {
  let cur = obj as Record<string, unknown>;
  for (let i = 0; i < path.length - 1; i++) {
    const next = cur[path[i]!];
    if (!isObject(next)) return false;
    cur = next;
  }
  const leaf = path[path.length - 1]!;
  if (!(leaf in cur)) return false;
  const old = cur[leaf];
  if (old !== null && value !== null && typeof old !== typeof value) return false;
  cur[leaf] = value;
  return true;
}

function applyOne(cfg: Config, key: string, v: unknown): boolean {
  const path = key.split(".");
  if (key.startsWith("memory.routing.")) {
    // routing thresholds may only become stricter
    if (!num(v) || v < 0 || v > 1) return false;
    const name = path[2] as keyof Config["memory"]["routing"];
    if (!(name in cfg.memory.routing)) return false;
    const cur = cfg.memory.routing[name];
    const stricter = name === "discard" ? v <= cur : v >= cur;
    if (!stricter) return false;
    cfg.memory.routing[name] = v;
    return true;
  }
  if (key === "context.maxWindow") {
    if (v === "auto") {
      cfg.context.maxWindow = "auto";
      return true;
    }
    if (num(v) && (v === 0 || v >= 8192)) {
      cfg.context.maxWindow = Math.round(v);
      return true;
    }
    return false;
  }
  if (key === "context.modelMaxWindows") {
    if (!isObject(v)) return false;
    const next: Record<string, "auto" | number> = { ...cfg.context.modelMaxWindows };
    for (const [modelKey, val] of Object.entries(v)) {
      const k = modelKey.trim();
      if (!k) return false;
      if (val === "auto") delete next[k];
      else if (num(val) && (val === 0 || val >= 8192)) next[k] = Math.round(val);
      else return false;
    }
    cfg.context.modelMaxWindows = next;
    return true;
  }
  if (key === "context.modelCacheTtlSeconds") {
    if (!isObject(v)) return false;
    const next: Record<string, "auto" | number> = { ...cfg.context.modelCacheTtlSeconds };
    for (const [modelKey, val] of Object.entries(v)) {
      const k = modelKey.trim();
      if (!k) return false;
      if (val === "auto") delete next[k];
      else if (num(val) && val >= 0) next[k] = Math.round(val);
      else return false;
    }
    cfg.context.modelCacheTtlSeconds = next;
    return true;
  }
  if (key === "context.climb.expectedRequests") {
    if (v === "auto") {
      cfg.context.climb.expectedRequests = "auto";
      return true;
    }
    if (num(v) && v >= 1) {
      cfg.context.climb.expectedRequests = Math.round(v);
      return true;
    }
    return false;
  }
  if (key.startsWith("context.") || key.startsWith("memory.")) return (num(v) || typeof v === "boolean" || typeof v === "string") && setPath(cfg, path, v);
  if (key === "shared.review") {
    if (v !== true) return false;
    cfg.shared.review = true;
    return true;
  }
  if (key === "evolution.sharedStrategy") {
    if (v !== "propose" && v !== "off") return false;
    cfg.evolution.sharedStrategy = v;
    return true;
  }
  if (key.startsWith("paths.")) return (num(v) || typeof v === "boolean") && setPath(cfg, path, v);
  if (key === "instructions.alwaysOnTokens") return num(v) && setPath(cfg, path, v);
  if (key === "shared.compactOn") {
    if (v !== "any" && v !== "default-branch" && v !== "manual") return false;
    cfg.shared.compactOn = v;
    return true;
  }
  if (key === "shared.defaultBranch") {
    if (typeof v !== "string" && v !== null) return false;
    cfg.shared.defaultBranch = v;
    return true;
  }
  if (key === "urgency.gate") {
    if (v !== "auto" && v !== "off") return false;
    cfg.urgency.gate = v;
    return true;
  }
  if (key === "urgency.escalateAfter") return num(v) && v >= 1 && setPath(cfg, path, v);
  if (key === "providers.aux.guard.deny") {
    // patterns can only be added, never removed
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) return false;
    cfg.providers.aux.guard.deny = [...new Set([...cfg.providers.aux.guard.deny, ...(v as string[])])];
    return true;
  }
  return false;
}

export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function realctx2Home(): string {
  return process.env.REALCTX2_HOME || join(agentDir(), "realctx2");
}

export function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/** Directory layout (§6.1). */
export class Layout {
  readonly home: string;
  constructor(home: string = realctx2Home()) {
    this.home = home;
  }
  get configFile(): string {
    return join(this.home, "config.json");
  }
  get machineFile(): string {
    return join(this.home, "machine.json");
  }
  get globalDir(): string {
    return join(this.home, "global");
  }
  projectDir(projectKey: string): string {
    return join(this.home, "projects", projectKey);
  }
  cacheDir(storeId: string): string {
    return join(this.home, "cache", storeId);
  }
  indexFile(storeId: string): string {
    return join(this.cacheDir(storeId), "index.sqlite");
  }
  turnIndexFile(projectKey: string): string {
    return join(this.home, "cache", "turns", `${projectKey}.sqlite`);
  }
  modelFile(modelKey: string): string {
    return join(this.home, "models", `${modelKey.replace(/[^\w.-]+/g, "_")}.json`);
  }
  sessionDir(sessionId: string): string {
    return join(this.home, "sessions", sessionId.replace(/[^\w.-]+/g, "_"));
  }
  blobDir(sessionId: string): string {
    return join(this.sessionDir(sessionId), "blobs");
  }
  get queueDir(): string {
    return join(this.home, "queue");
  }
  get backupsDir(): string {
    return join(this.home, "backups");
  }
  get logsDir(): string {
    return join(this.home, "logs");
  }
  get locksDir(): string {
    return join(this.home, "locks");
  }
  lockFile(name: string): string {
    return join(this.locksDir, `${name.replace(/[^\w.-]+/g, "_")}.lock`);
  }
  get evolutionDir(): string {
    return join(this.home, "evolution");
  }
  get peersDir(): string {
    return join(this.home, "peers");
  }
  get claudeCodeDir(): string {
    return join(this.home, "claude-code");
  }
  /** `<repo>/.pi/realctx2` */
  static sharedDir(repoRoot: string, configDirName = ".pi"): string {
    return join(repoRoot, configDirName, "realctx2");
  }
}

export interface LoadedConfig {
  config: Config;
  overrides: ProjectOverrideReport;
  globalFileFound: boolean;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => kb.includes(k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function cleanValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(cleanValue);
  if (isObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined) continue;
      out[k] = cleanValue(val);
    }
    return out;
  }
  return v;
}

const DYNAMIC_PATHS = new Set([
  "context.modelMaxWindows",
  "context.modelCacheTtlSeconds",
  "providers.decision",
  "providers.embedding.late",
  "providers.embedding.dense",
  "providers.aux.pi.roles",
  "providers.aux.claudeCode.roles",
  "tools.names",
]);

function diffObject(next: Record<string, unknown>, base: Record<string, unknown>, existing: unknown, path: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const ex = isObject(existing) ? existing : undefined;
  const isDynamic = DYNAMIC_PATHS.has(path) || path.endsWith(".headers") || path.includes(".roles.");

  // Preserve unknown future keys from existing config.json at fixed schema levels.
  if (ex && !isDynamic) {
    for (const [k, v] of Object.entries(ex)) {
      if (!(k in base) && !(k in next) && v !== undefined) out[k] = v;
    }
  }

  const keys = new Set([...Object.keys(next), ...Object.keys(base)]);
  for (const k of keys) {
    const childPath = path ? `${path}.${k}` : k;
    const nv = next[k];
    const bv = base[k];
    if (deepEqual(nv, bv)) continue;
    if (nv === undefined) {
      // Key existed in defaults (e.g. claudeCode.roles.precip.model) and was explicitly cleared.
      if (bv !== undefined) out[k] = null;
      continue;
    }
    if (isObject(nv) && isObject(bv)) {
      const sub = diffObject(nv, bv, ex?.[k], childPath);
      if (Object.keys(sub).length > 0) out[k] = sub;
    } else {
      const cleaned = cleanValue(nv);
      if (bv === undefined && isObject(cleaned) && Object.keys(cleaned).length === 0) continue;
      out[k] = cleaned;
    }
  }
  return out;
}

/**
 * Compute a minimal config.json object representing `next` relative to `base` (DEFAULT_CONFIG),
 * while preserving unknown future keys from `existingRaw`.
 */
export function diffConfig(next: Config, base: Config = DEFAULT_CONFIG, existingRaw?: unknown): Record<string, unknown> {
  return diffObject(next as unknown as Record<string, unknown>, base as unknown as Record<string, unknown>, existingRaw, "");
}

/** Load only the global configuration file merged with defaults (excluding project overrides). */
export function loadGlobalConfig(layout: Layout): Config {
  const globalRaw = readJson<unknown>(layout.configFile, null);
  return deepMerge(structuredClone(DEFAULT_CONFIG), globalRaw ?? {});
}

/** Persist `next` as minimal overrides to the global config.json atomically. */
export function saveConfig(layout: Layout, next: Config): Record<string, unknown> {
  const existingRaw = readJson<unknown>(layout.configFile, null);
  const diff = diffConfig(next, DEFAULT_CONFIG, existingRaw);
  writeJson(layout.configFile, diff, configHasInlineSecrets(next) ? 0o600 : undefined);
  return diff;
}

export function loadConfig(layout: Layout, sharedDir?: string | null, trusted = false): LoadedConfig {
  const globalRaw = readJson<unknown>(layout.configFile, null);
  let config = deepMerge(structuredClone(DEFAULT_CONFIG), globalRaw ?? {});
  let overrides: ProjectOverrideReport = { applied: [], ignored: [] };
  if (sharedDir && trusted) {
    const projectRaw = readJson<unknown>(join(sharedDir, "config.json"), null);
    if (projectRaw) ({ config, report: overrides } = applyProjectOverrides(config, projectRaw));
  }
  return { config, overrides, globalFileFound: globalRaw !== null };
}

export interface ApiKeyProviderFields {
  apiKey?: string;
  apiKeyEnv?: string;
  apiKeyFile?: string;
  headers?: Record<string, string>;
}

export interface ApiKeyInfo {
  key?: string;
  source: "literal" | "env" | "file" | "header" | "none";
  envVar?: string;
  filePath?: string;
  warning?: string;
}

const SENSITIVE_HEADER_RE = /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key)$|(?:^|[-_])(?:api[-_]?key|token|secret|auth)(?:$|[-_])/i;

export function isSensitiveHeaderName(name: string): boolean {
  return SENSITIVE_HEADER_RE.test(name.trim());
}

export function normalizeEnvVarName(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.trim().replace(/^\$/, "").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

function normalizeSecret(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim().replace(/^bearer\s+/i, "").trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function expandHome(path: string): string {
  const p = path.trim();
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

function unquoteEnvValue(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Read a Bearer secret from a raw single-line token file or a `KEY=VALUE` env file
 * (such as systemd EnvironmentFile `/etc/pplx-embed-v2-exl3/env` or `/etc/pplx-decider-v1.3-exl3/env`).
 */
export function readSecretFromFile(filePath: string, preferredEnvKey?: string): { key?: string; error?: string } {
  const target = expandHome(filePath);
  if (!target) return { error: "empty file path" };
  let raw: string;
  try {
    raw = readFileSync(target, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { error: code ? `${code}: cannot read ${filePath}` : `cannot read ${filePath}` };
  }
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  if (!lines.length) return { error: `secret file is empty (${filePath})` };

  const envEntries: Array<[string, string]> = [];
  for (const line of lines) {
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m) envEntries.push([m[1]!, unquoteEnvValue(m[2]!)]);
  }
  if (envEntries.length > 0) {
    const want = normalizeEnvVarName(preferredEnvKey);
    const matched =
      (want ? envEntries.find(([k]) => k === want) : undefined) ??
      (envEntries.length === 1 ? envEntries[0] : envEntries.find(([k]) => /(?:^|_)(?:API_KEY|TOKEN|SECRET)$/i.test(k)));
    if (!matched) {
      return {
        error: want
          ? `key "${want}" not found in ${filePath}`
          : `multiple env keys in ${filePath}; set API key env var to select one`,
      };
    }
    const key = normalizeSecret(matched[1]);
    return key ? { key } : { error: `key "${matched[0]}" is empty in ${filePath}` };
  }

  const key = normalizeSecret(lines[0]);
  return key ? { key } : { error: `secret file is empty (${filePath})` };
}

export function resolveApiKeyInfo(p: ApiKeyProviderFields | null | undefined): ApiKeyInfo {
  if (!p) return { source: "none" };
  const literal = normalizeSecret(p.apiKey);
  if (literal) return { key: literal, source: "literal" };

  const envVar = normalizeEnvVarName(p.apiKeyEnv);
  if (envVar) {
    const fromEnv = normalizeSecret(process.env[envVar]);
    if (fromEnv) return { key: fromEnv, source: "env", envVar };
  }

  const filePath = p.apiKeyFile?.trim() || undefined;
  let fileError: string | undefined;
  if (filePath) {
    const fromFile = readSecretFromFile(filePath, envVar);
    if (fromFile.key) return { key: fromFile.key, source: "file", filePath, envVar };
    fileError = fromFile.error;
  }

  if (p.headers) {
    for (const [k, v] of Object.entries(p.headers)) {
      if (k.toLowerCase() === "authorization" && typeof v === "string" && v.trim().length > 0) {
        return { source: "header", envVar, filePath };
      }
    }
  }

  const warning = fileError ?? (envVar ? `Environment variable "${envVar}" is not set` : undefined);
  return { source: "none", envVar, filePath, warning };
}

export function resolveApiKey(p: ApiKeyProviderFields | null | undefined): string | undefined {
  return resolveApiKeyInfo(p).key;
}

/**
 * Build request headers with custom headers and Bearer auth from `apiKey` / `apiKeyEnv` / `apiKeyFile`,
 * avoiding case-variant duplicate `Authorization` or `Content-Type` headers.
 */
export function buildAuthHeaders(
  p: ApiKeyProviderFields | null | undefined,
  base: Record<string, string> = { "content-type": "application/json" },
): Record<string, string> {
  const headers: Record<string, string> = { ...base };
  if (p?.headers) {
    for (const [k, v] of Object.entries(p.headers)) {
      const lower = k.toLowerCase();
      for (const existing of Object.keys(headers)) {
        if (existing.toLowerCase() === lower) delete headers[existing];
      }
      headers[k] = v;
    }
  }
  const key = resolveApiKey(p);
  if (key) {
    for (const existing of Object.keys(headers)) {
      if (existing.toLowerCase() === "authorization") delete headers[existing];
    }
    headers.authorization = `Bearer ${key}`;
  }
  return headers;
}

function configHasInlineSecrets(cfg: Config): boolean {
  const endpoints: Array<ApiKeyProviderFields | null | undefined> = [
    cfg.providers.decision,
    cfg.providers.embedding.late,
    cfg.providers.embedding.dense,
  ];
  for (const ep of endpoints) {
    if (!ep) continue;
    if (normalizeSecret(ep.apiKey)) return true;
    if (ep.headers) {
      for (const [k, v] of Object.entries(ep.headers)) {
        if (isSensitiveHeaderName(k) && typeof v === "string" && v.trim().length > 0) return true;
      }
    }
  }
  return false;
}

const FALLBACK_CONTEXT_WINDOW = 128000;

/** Look up a per-model override by exact `"provider/id"` first, then bare `"id"`. */
function lookupModelOverride<T>(map: Record<string, T> | undefined, modelName?: string): T | undefined {
  if (!map || !modelName) return undefined;
  const trimmed = modelName.trim();
  if (!trimmed || trimmed === "unknown") return undefined;
  if (Object.prototype.hasOwnProperty.call(map, trimmed)) return map[trimmed];
  const slash = trimmed.indexOf("/");
  if (slash > 0) {
    const bare = trimmed.slice(slash + 1);
    if (Object.prototype.hasOwnProperty.call(map, bare)) return map[bare];
  }
  return undefined;
}

/** Resolve the active maxWindow setting (`"auto"`, `0` = disabled, or token cap) for `modelName`. */
function resolveMaxWindowSetting(cfg: Config, modelName?: string): "auto" | number {
  const over = lookupModelOverride(cfg.context.modelMaxWindows, modelName);
  if (typeof over === "number" && Number.isFinite(over) && over >= 0) return over;
  return cfg.context.maxWindow;
}

/** Whether the context engine is enabled for `modelName` (`maxWindow === 0` disables it). */
export function isContextEngineEnabled(cfg: Config, modelName?: string): boolean {
  return resolveMaxWindowSetting(cfg, modelName) !== 0;
}

/**
 * Resolve the effective working window W from the active model's catalog metadata (`modelWindow`)
 * and optional user cap (`cfg.context.maxWindow` / `cfg.context.modelMaxWindows`).
 * Returns `0` when the resolved maxWindow setting is `0` (context engine disabled).
 * When `"auto"`, W follows the model's contextWindow directly (falling back to 128,000 only if unknown).
 */
export function effectiveMaxWindow(cfg: Config, modelWindow: number, modelName?: string): number {
  const cap = resolveMaxWindowSetting(cfg, modelName);
  if (cap === 0) return 0;
  if (typeof cap === "number" && cap > 0) return modelWindow > 0 ? Math.min(modelWindow, cap) : cap;
  return modelWindow > 0 ? modelWindow : FALLBACK_CONTEXT_WINDOW;
}

/** Resolve the effective provider prompt-cache TTL in seconds for `modelName`. */
export function effectiveCacheTtlSeconds(cfg: Config, modelName?: string): number {
  const over = lookupModelOverride(cfg.context.modelCacheTtlSeconds, modelName);
  if (typeof over === "number" && Number.isFinite(over) && over >= 0) return over;
  return cfg.context.cacheTtlSeconds;
}

/** Scale B_min, T_min and Δ_min when W ≠ 128,000 (§5.7). Returns all zeros when W === 0 (disabled). */
export function scaledContext(cfg: Config, modelWindow: number, modelName?: string): { W: number; Bmin: number; Tmin: number; deltaMin: number; innermostMin: number; maxToolResult: number } {
  const W = effectiveMaxWindow(cfg, modelWindow, modelName);
  if (W <= 0) return { W: 0, Bmin: 0, Tmin: 0, deltaMin: 0, innermostMin: 0, maxToolResult: 0 };
  const f = W / 128000;
  const Bmin = Math.max(2048, Math.round(cfg.context.Bmin * f));
  const Tmin = Math.max(8192, Math.round(cfg.context.Tmin * f));
  const deltaMin = Math.max(4096, Math.round(cfg.context.deltaMin * f));
  const innermostMin = cfg.context.climb.innermostMinTokens != null ? Math.max(2 * 8192, Math.round(cfg.context.climb.innermostMinTokens * f)) : 2 * Tmin;
  return { W, Bmin, Tmin, deltaMin, innermostMin, maxToolResult: Math.round(cfg.context.maxToolResultFraction * W) };
}
