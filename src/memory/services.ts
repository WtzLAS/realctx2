/** The bundle of services the memory engine's modules share. */
import type { Config, Layout } from "../core/config.ts";
import type { Telemetry } from "../core/telemetry.ts";
import type { AuxSessionRunner, Clock, DecisionClient } from "../core/types.ts";
import type { TurnIndex } from "../storage/turnindex.ts";
import type { MemoryGraph } from "./graph.ts";
import type { SessionAccounting } from "./accounting.ts";
import type { PathTracker } from "./paths.ts";
import type { Similarity } from "./similarity.ts";

export interface MemoryServices {
  cfg: Config;
  layout: Layout | null;
  graph: MemoryGraph;
  sim: Similarity;
  paths: PathTracker;
  decision: DecisionClient;
  /** Aux LLM access through the harness; null where no model access exists (detached worker). */
  aux: AuxSessionRunner | null;
  turns: TurnIndex | null;
  /** Per-session batch of counters, accesses and strength events (§7.3). */
  accounting: SessionAccounting;
  telemetry?: Telemetry;
  clock: Clock;
  sessionId?: string;
  actorId: string;
}

/** Decision timeouts by call site (§9.1.5). */
export const TIMEOUTS = { janus: 30_000, gate: 1500, routing: 5000, conflict: 5000, attribution: 10_000, teacher: 10_000, check: 10_000 } as const;
/** Stricter thresholds for uncalibrated (aux-emulated) answers (§9.1.4). */
export const UNCALIBRATED = { tauClose: 0.9, sharedRouting: 0.95, proactiveGate: 0.7 } as const;
