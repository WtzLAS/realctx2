/** Configuration (§9.4): defaults, the global file, and restricted project overrides. */
import { homedir } from "node:os";
import { join } from "node:path";
import { readJson, writeJson } from "../util/fs.ts";
import type { AuxRole, AuxTools, ThinkingLevel, Urgency } from "./types.ts";

export interface DecisionProviderConfig {
  format: "systemone" | "decisions";
  url: string;
  model: string;
  apiKeyEnv?: string;
  apiKey?: string;
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
       * How long an aux-emulated decision may take (§9.1.4). An LLM rarely answers within a call
       * site's own timeout (1.5 s for Janus and the proactive gate), so those answers apply at
       * the next commit point instead of holding the current one. Where the call site's timeout
       * is longer, it applies. 0 keeps the call site's timeout.
       */
      emulateTimeoutMs: number;
      guard: { deny: string[]; writesOutsideRepo: "block" | "allow" };
      pi: AuxHarnessConfig;
      claudeCode: AuxHarnessConfig;
    };
  };
  context: {
    maxWindow: number;
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
    maxWindow: 128000,
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
    prepareFraction: 0.7,
    reinjectTokens: 8000,
  },
  janus: { timeoutMs: 1500, lateWaitMs: 200, maxInputTokens: 8000, remindEvery: 8, maxDepth: 6 },
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
      if (isObject(v) && !["tools.names"].includes(key)) {
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

export function realctx2Home(): string {
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
  writeJson(layout.configFile, diff);
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

export function resolveApiKey(p: { apiKey?: string; apiKeyEnv?: string } | null | undefined): string | undefined {
  if (!p) return undefined;
  if (p.apiKey) return p.apiKey;
  if (p.apiKeyEnv) return process.env[p.apiKeyEnv];
  return undefined;
}

/** Scale B_min, T_min and Δ_min when W ≠ 128,000 (§5.7). */
export function scaledContext(cfg: Config, modelWindow: number): { W: number; Bmin: number; Tmin: number; deltaMin: number; innermostMin: number; maxToolResult: number } {
  const W = Math.min(modelWindow > 0 ? modelWindow : cfg.context.maxWindow, cfg.context.maxWindow);
  const f = W / 128000;
  const Bmin = Math.max(2048, Math.round(cfg.context.Bmin * f));
  const Tmin = Math.max(8192, Math.round(cfg.context.Tmin * f));
  const deltaMin = Math.max(4096, Math.round(cfg.context.deltaMin * f));
  const innermostMin = cfg.context.climb.innermostMinTokens != null ? Math.max(2 * 8192, Math.round(cfg.context.climb.innermostMinTokens * f)) : 2 * Tmin;
  return { W, Bmin, Tmin, deltaMin, innermostMin, maxToolResult: Math.round(cfg.context.maxToolResultFraction * W) };
}

export const URGENCY_LEVELS: Urgency[] = ["immediate", "hint", "caption", "passive"];
