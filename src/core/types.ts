/**
 * Shared types for realctx2. Section numbers refer to docs/realctx2-design.md.
 */

// ───────────────────────────── IDs (§8.1.2)
export type IdType = "m" | "t" | "r" | "o";

// ───────────────────────────── Context engine (§5.1, §4.3, §5.5.1, Appendix B.5)
export type IntentStatus = "open" | "success" | "failure" | "abandoned";
export type IntentOutcome = Exclude<IntentStatus, "open">;

export interface Intent {
  id: string; // 8 base36 characters (internal; never shown to the model)
  parentId: string | null;
  label: string; // ≤ 12 words; a purpose, not an action
  reason: string;
  success: string; // observable exit condition
  failure: string; // observable give-up condition
  /**
   * b_j: first entry the intent governs. Normally its guidance message ("" until the harness has
   * assigned it); for an intent whose scribe missed its commit point, the first entry after the
   * point it was planned at, so the rounds before its guidance belong to it.
   */
  guidanceEntryId: string;
  openedRound: number;
  status: IntentStatus;
  closedEntryId?: string;
}

export interface ConsolidationRecord {
  id: string; // "t:" + 8 base36 characters
  kind: "precip" | "palim" | "compaction";
  anchorId: string;
  children: Array<{ entryId: string } | { id: string }>; // ordered: raw entries and nested consolidations
  intentId?: string;
  outcome?: "success" | "failure" | "abandoned";
  telos: string[]; // enclosing intent labels, outermost first
  tokensBefore: number;
  tokensAfter: number;
  model: string;
  createdAt: string;
  /** Rendered consolidated message (kept so L0 harnesses and recall can show it without the edit). */
  text?: string;
  /** Palim knowledge items carried by this fold (§5.4.4). */
  knowledge?: KnowledgeItem[];
  /** Precip sidecar (§5.3.3); never shown to the main model. */
  sidecar?: PrecipSidecar;
  /** Shadow consolidations (L0 harnesses) are never applied to the transcript. */
  shadow?: boolean;
}

export interface KnowledgeItem {
  evaluation: "good" | "bad" | "neutral";
  fact: string;
  subject: string;
  as_of?: string;
  supersedes?: string;
  /** Set when a recall of the fold was attributed as used (§5.5.6). */
  used?: boolean;
  /** Memory the item was harvested into. */
  memoryId?: string;
}

export interface PrecipSidecar {
  outcome_summary: string;
  state_changes: string[];
  artifacts: string[];
  open_threads: string[];
}

export type DeliveryChannel = "proactive" | "path" | "gate" | "search" | "recall" | "inspect";

export interface Delivery {
  deliveryId: string;
  id: string; // what was delivered: "m:…", "t:…", "r:…" or "o:…"
  kind: "card" | "archive" | "found";
  nodeIds?: string[];
  scope?: ScopeName;
  channel: DeliveryChannel;
  entryId: string; // where it entered context
  intentId: string | null; // innermost open intent at delivery
  tokens: number;
  restatedRatio: number;
  signature: string[];
  /** Round counter at delivery (root-region credit windows, §5.5.2). */
  round?: number;
  /** Whether the full text (not a caption) was shown. */
  full?: boolean;
  /** Tool call that carried the delivery (resolves entryId once the harness has assigned ids). */
  toolCallId?: string;
  /** Set for deliveries inside a subagent: recorded, never attributed (§4.6.7). */
  subagent?: boolean;
}

export interface AttributionRecord {
  type: "realctx2.attribution";
  deliveryId: string;
  use: Record<string, number>;
  effect?: number;
  comply?: Record<string, number>;
  u: number;
}

export interface StatsRecord {
  type: "realctx2.stats";
  roundTokens: number[];
  janusLate: number;
  foldsSkippedByCost: number;
  /** Palim frontier f (§5.4.2) and climb bookkeeping, persisted so a resume continues the climb. */
  frontier?: number;
  lastClimbRound?: number;
  round?: number;
}

export type SessionRecord =
  | { type: "realctx2.intent"; intent: Intent }
  | { type: "realctx2.consolidation"; record: ConsolidationRecord }
  | { type: "realctx2.delivery"; delivery: Delivery }
  | AttributionRecord
  | StatsRecord;

export const RECORD_TYPES = [
  "realctx2.intent",
  "realctx2.consolidation",
  "realctx2.delivery",
  "realctx2.attribution",
  "realctx2.stats",
] as const;

// ───────────────────────────── Harness adapter (§4.5)

export type EntryKind = "user" | "assistant" | "toolResult" | "custom_message" | "summary" | "other";

export interface ToolCallView {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** One context-producing entry on the active branch. `text` is the content as currently projected. */
export interface EntryView {
  id: string;
  kind: EntryKind;
  /** Role the provider sees. */
  role: "user" | "assistant" | "tool";
  /** Projected text (after context edits). Empty when omitted. */
  text: string;
  /** Raw text before any context edit (the archive view). */
  rawText: string;
  /** True when a context edit currently omits this entry from model context. */
  omitted: boolean;
  /** True when a context edit currently replaces this entry's content. */
  edited: boolean;
  /**
   * True when the harness cannot edit this entry (pi: compaction and branch summaries, `!` shell
   * runs). A span that contains it leaves it in place.
   */
  fixed?: boolean;
  /** Tool calls as projected: absent once a context edit replaced the entry's content. */
  toolCalls?: ToolCallView[];
  /** Tool calls of the raw entry, whatever the edits (the archive view). */
  rawToolCalls?: ToolCallView[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  customType?: string;
  details?: unknown;
  timestamp: string;
  /** Token estimate of the projected text. */
  tokens: number;
  /** Token estimate of the raw text. */
  rawTokens: number;
}

export interface ContextEdit {
  targetId: string;
  /** null omits the target from model context. */
  replacement: string | null;
}

export interface GuidanceMessage {
  customType: string;
  content: string;
  display: boolean;
  details?: Record<string, unknown>;
}

export interface CommitBatch {
  records: SessionRecord[];
  edits: ContextEdit[];
  messages: GuidanceMessage[];
}

export function emptyBatch(): CommitBatch {
  return { records: [], edits: [], messages: [] };
}

export interface ModelPricing {
  /** Per-token prices in any consistent unit. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ToolResultPayload {
  text: string;
  details?: unknown;
  isError?: boolean;
}

export interface ToolDef {
  /** Canonical name (search, recall, inspect, remember, forget). */
  key: string;
  /** Effective name after tools.names. */
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: JSONSchema;
  readOnly: boolean;
  execute(params: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResultPayload>;
}

export interface ToolCallContext {
  toolCallId?: string;
  signal?: AbortSignal;
  /** True for calls made by an aux session: not a delivery, no retrieval counters (§9.3.2). */
  aux?: boolean;
  /** True when another tool made the call (pi parentToolCallId). */
  nested?: boolean;
  subagent?: boolean;
}

export interface CommandIO {
  print(text: string): void;
  notify(text: string, level?: "info" | "warning" | "error"): void;
  confirm(title: string, message: string): Promise<boolean>;
  edit?(title: string, prefill: string): Promise<string | undefined>;
  openSettings?(category?: string): Promise<void>;
  /** Interactive review screen (pi's TUI); without it `/realctx2 review` prints a list. */
  review?(model: import("../commands/review.ts").ReviewModel): Promise<void>;
  hasUI: boolean;
}

export interface CommandDef {
  name: string;
  description: string;
  handler(args: string, io: CommandIO): Promise<void>;
  completions?(prefix: string): string[];
}

export type JSONSchema = Record<string, unknown>;

export interface HarnessAdapter {
  readonly harness: "pi" | "claude-code" | "test";
  capabilities: { level: 0 | 1 | 2 };
  /** Called once by the engine host, before anything else: the session's configuration and telemetry. */
  attach?(env: { cfg: import("./config.ts").Config; telemetry: import("./telemetry.ts").Telemetry; layout: import("./config.ts").Layout }): void;
  maxContextTokens(): number;
  listEntries(): Promise<EntryView[]>; // active branch, projected + raw content
  /**
   * Raw entries of the whole branch, including what a harness compaction cut from context (the
   * archive `recall` reads, §5.6). Defaults to `listEntries()`.
   */
  archiveEntries?(): Promise<EntryView[]>;
  listRecords(): Promise<SessionRecord[]>; // realctx2 session records on the active branch
  requestTokens(): Promise<number | null>; // size of the next request incl. system prompt + tools
  commit(batch: CommitBatch): Promise<void>; // records, edits, guidance (outside a boundary return)
  registerTool(def: ToolDef): void; // checked for name clashes first (§8.1.3)
  registerCommand(def: CommandDef): void;
  aux(): AuxSessionRunner; // aux sessions through the harness's model access (§9.3)
  /** Main model metadata for the cost check (§5.4.2). */
  pricing(): ModelPricing | null;
  /** Prices of the model an aux role runs on, when the harness knows them (C_fold in §5.4.2). */
  auxPricing?(role: AuxRole): ModelPricing | null;
  /**
   * Epoch ms when the provider's prompt cache was last written (latest assistant response, or
   * a later harness cache-warming refresh for the active provider). Used for cold-cache folds.
   */
  lastCacheWriteAt?(): number | null;
  modelName(): string;
  notify(text: string, level?: "info" | "warning" | "error"): void;
  setStatus?(text: string | undefined): void;
}

// ───────────────────────────── Aux sessions (Appendix B.2)
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type AuxRole =
  | "janus.scribe"
  | "precip"
  | "palim"
  | "qemem.planner"
  | "qemem.constructor"
  | "write.merge"
  | "evo.operator"
  | "ingest.slicer"
  | "reverify"
  | "decision.emulate";
export type AuxTools = "none" | "read-only" | "read-only+bash";

export interface AuxTask<T = unknown> {
  role: AuxRole;
  instructions: string; // role prompt; tool-using roles start with the shared aux preamble
  data: Array<{ label: string; text: string }>; // untrusted input, rendered as quoted data blocks
  schema: JSONSchema;
  tools?: AuxTools;
  budget?: { maxTurns?: number; timeoutMs?: number; thinking?: ThinkingLevel };
  signal?: AbortSignal;
  /** Phantom marker for the output type. */
  __out?: T;
}

export interface AuxResult<T> {
  output: T | null; // null: the role's fail-safe applies
  turns: number;
  toolCalls: number;
  tokens: { input: number; output: number; cacheRead?: number };
  blocked: string[]; // calls the pi guard refused
  changedFiles: string[]; // from the change watch
  error?: string;
}

export interface AuxSessionRunner {
  run<T>(task: AuxTask<T>): Promise<AuxResult<T>>; // refuses inside an aux session (no recursion)
  available(): boolean;
  resetCooldowns?(): void;
}

// ───────────────────────────── Decision model (§9.1.1)
export type DecisionQuestion =
  | { kind: "binary"; name: string; instructions: string; yes?: string; no?: string }
  | { kind: "choice"; name: string; instructions: string; options: Array<{ value: string; description?: string }> }
  | { kind: "score"; name: string; instructions: string; levels: Array<{ label: string; description?: string }> };

export interface DecisionAnswer {
  name: string;
  kind: "binary" | "choice" | "score" | "refusal";
  p?: number; // binary
  probs?: Record<string, number>; // choice: value -> probability; score: label -> probability
  choice?: string; // choice argmax
  score01?: number; // score: expected level index / (levels - 1)
  confidence?: number;
  calibrated: boolean; // false for the aux-emulated fallback
}

export interface DecideOptions {
  callSite: string;
  cacheKey?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Disable the retry (Janus never retries, §9.1.5). */
  noRetry?: boolean;
}

export interface DecisionClient {
  decide(
    evidence: string | object,
    questions: DecisionQuestion[],
    opts: DecideOptions,
  ): Promise<Record<string, DecisionAnswer>>;
  /** False when neither an endpoint nor an emulation path exists. */
  available(): boolean;
  /** True when answers come from a real decision model (calibrated probabilities). */
  calibrated(): boolean;
}

// ───────────────────────────── Embeddings (Appendix B.3)
export type DenseVector = Float32Array;
export type TokenMatrix = Float32Array[]; // one L2-normalized row per token

export interface EmbeddingClient<K extends "dense" | "multivector"> {
  readonly kind: K;
  readonly model: string;
  readonly dims: number;
  /** Cache key component: model + d + role settings. */
  readonly key: string;
  embed(
    texts: string[],
    role: "query" | "document",
    signal?: AbortSignal,
  ): Promise<K extends "dense" ? DenseVector[] : TokenMatrix[]>;
  probe(): Promise<{ ok: boolean; problem?: string }>;
  /** False while the circuit breaker is open or the provider was disabled by a shape error. */
  healthy(): boolean;
}

// ───────────────────────────── Memory graph (§6.2)
export type ScopeName = "global" | "personal" | "shared";
export type Layer = "short" | "long";
export type Kind = "fact" | "procedure" | "episode" | "concept" | "preference" | "rule";
export type Status = "active" | "dormant" | "archived" | "purged";
export type Urgency = "immediate" | "hint" | "caption" | "passive";
export type Severity = "must" | "should" | "may" | "info";
export type Origin = "harvest" | "instructions" | "explicit" | "operator" | "auto-memory";
export type TriggerAction = "read" | "edit" | "command" | "commit" | "test";

export const URGENCY_ORDER: Urgency[] = ["passive", "caption", "hint", "immediate"];
export const KINDS: Kind[] = ["fact", "procedure", "episode", "concept", "preference", "rule"];

export interface PathAnchor {
  kind: "subtree" | "file" | "glob" | "symbol";
  pathId?: string; // TreeID in the scope's path registry (subtree, file, symbol)
  glob?: string; // kind "glob"
  symbol?: string; // kind "symbol" (best effort)
  role: "applies" | "about";
  seenBlob?: string; // git blob hash when the anchor was made
  status: "live" | "stale";
  /** When the anchor went stale (stale anchors are dropped after 30 days, §6.8.4). */
  staleAt?: string;
}

export interface SourceRef {
  /** "session" | "file" | "instruction" | "tool" | "user" | free text */
  type: string;
  ref: string; // e.g. "src/auth/tokenCache.ts:88", "t:c7f3a2e8", "tool read_file"
}

export interface Evidence {
  quote: string;
  source: SourceRef;
  time?: string;
  verified: boolean;
}

export interface StrengthEvent {
  id: string;
  t: string; // ISO time
  kind: "reinforce" | "suppress" | "layer" | "set";
  /** reinforce: use weight u; suppress: multiplier; layer/set: absolute value */
  value: number;
  /** For reinforce: attributed uses in the last 7 days at the time of the event (n_i). */
  n?: number;
  /** For layer transitions: the layer after the move. */
  layer?: Layer;
}

export interface UseCounters {
  delivered: number;
  used: number;
  ignoredRelevant: number;
  known: number;
  contradicted: number;
  harm: number;
  usedSuccess: number;
  usedFailure: number;
  expanded: number;
  retrieved: number;
  complied: number;
  violated: number;
  violations_passive: number;
  violations_caption: number;
  violations_hint: number;
  violations_immediate: number;
  /** Distinct sessions with attributed use (fast-track promotion, §6.5.2). */
  useSessions: number;
}

export const COUNTER_NAMES: Array<keyof UseCounters> = [
  "delivered",
  "used",
  "ignoredRelevant",
  "known",
  "contradicted",
  "harm",
  "usedSuccess",
  "usedFailure",
  "expanded",
  "retrieved",
  "complied",
  "violated",
  "violations_passive",
  "violations_caption",
  "violations_hint",
  "violations_immediate",
  "useSessions",
];

export function zeroCounters(): UseCounters {
  const c = {} as UseCounters;
  for (const n of COUNTER_NAMES) c[n] = 0;
  return c;
}

export interface MemoryNode {
  id: string; // 8 random base36 characters, shown as [m:id]
  layer: Layer;
  kind: Kind;
  origin: Origin;
  anchors: PathAnchor[];
  severity?: Severity;
  urgency: Urgency;
  urgencyBy: "decision" | "agent" | "user" | "escalation" | "default";
  triggers?: { on?: TriggerAction[]; commands?: string[] };
  source?: { file: string; sha: string; section: string; lines: [number, number] };
  verifiedAt?: string;
  title: string; // ≤ 15 words
  text: string; // one fact / one procedure / one episode
  evidence: Evidence[];
  evaluation?: "good" | "bad" | "neutral";
  validFrom?: string;
  validTo?: string;
  status: Status;
  /** Why the node left the active tier (forgetting reason, path-deleted, …). */
  statusReason?: string;
  statusAt?: string;
  pinned: boolean;
  sensitivity: "normal" | "personal";
  signature: string[];
  confidence: number;
  importance?: number; // I_i, cached by the hygiene pass (§6.5.2)
  createdAt: string;
  createdTurn: number;
  lastAccessAt: string;
  /** Last delivery of any kind (a forgetting guard, §6.5.4). */
  lastDeliveredAt?: string;
  strength: { base: { v: number; t: string }; events: StrengthEvent[] };
  counters: UseCounters;
  provenance: { actor: string; sessionId?: string; turnId?: string; entryIds?: string[] };
  contentHash: string;
  /** Review flags (§6.7, §6.8.4, §6.10.4): rewrite-candidate, harm, low-value, stale-rule, conflict… */
  flags?: string[];
  /** Urgency baseline per level after a user override lowered urgency (§6.10.4). */
  violationsBaseline?: Partial<Record<Urgency, number>>;
  /**
   * Counters when the user last approved or dismissed this memory's review flags: the review
   * signals (low value, rewrite candidate, harm) count only from here on (§6.7).
   */
  reviewBaseline?: { at: string; counters: Partial<UseCounters> };
  /** Alias left by an ID collision (§8.1.2). */
  aliasOf?: string;
  /** Fused decay-rate divisor 1 + log|C| (FadeMem Eq. 13, §6.6.1). */
  decayDivisor?: number;
  /** Fields this version does not know; preserved on write (§7.13). */
  extra?: Record<string, unknown>;
}

export type Relation =
  | "causes"
  | "precedes"
  | "analogous-to"
  | "is-a"
  | "generalizes"
  | "part-of"
  | "supersedes"
  | "contradicts"
  | "derived-from";

export const RELATIONS: Relation[] = [
  "causes",
  "precedes",
  "analogous-to",
  "is-a",
  "generalizes",
  "part-of",
  "supersedes",
  "contradicts",
  "derived-from",
];

export interface MemoryEdge {
  id: string; // sha256(src | rel | dst)
  src: string;
  dst: string;
  rel: Relation;
  w: number; // strength in [0, 1]
  evidenceAt: string; // τ_e, evidence recency
  active: boolean; // false while an endpoint is dormant or archived
  /** Scope of the destination when it differs from the edge's own scope (§6.1). */
  dstScope?: ScopeName;
}

export interface PathNodeData {
  name: string;
  kind: "dir" | "file";
  status: "live" | "absent" | "deleted";
  blob?: string;
  fingerprint?: string;
  lastSeen: { commit?: string; at: string };
  /** When the path was first seen missing (absent → deleted after 14 days, §6.8.3). */
  absentSince?: string;
}

/** A memory together with the scope it lives in. */
export interface ScopedNode {
  scope: ScopeName;
  node: MemoryNode;
}

export type Clock = () => Date;
