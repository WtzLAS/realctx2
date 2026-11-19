import { join } from "node:path";
import { type Config, Layout } from "../../src/core/config.ts";
import { resolveProject } from "../../src/core/project.ts";
import { Telemetry } from "../../src/core/telemetry.ts";
import type { AuxResult, AuxRole, AuxSessionRunner, AuxTask, DecideOptions, DecisionAnswer, DecisionClient, DecisionQuestion, DenseVector, EmbeddingClient, TokenMatrix } from "../../src/core/types.ts";
import { SessionAccounting } from "../../src/memory/accounting.ts";
import { MemoryGraph } from "../../src/memory/graph.ts";
import { PathTracker } from "../../src/memory/paths.ts";
import type { MemoryServices } from "../../src/memory/services.ts";
import { Similarity } from "../../src/memory/similarity.ts";
import { TurnIndex } from "../../src/storage/turnindex.ts";
import { testConfig, tmp } from "./fixtures.ts";

export type Answers = Record<string, number | Partial<Record<string, number>>>;
export type DecisionHandler = (evidence: any, questions: DecisionQuestion[], opts: DecideOptions) => Answers | undefined;

/**
 * Programmable decision model. A handler returns `{ name: p }` for binary questions and
 * `{ name: { option: p } }` for choice and score questions; unanswered questions are omitted.
 */
export class FakeDecision implements DecisionClient {
  calls: Array<{ callSite: string; evidence: any; questions: DecisionQuestion[] }> = [];
  private handlers = new Map<string, DecisionHandler>();
  isAvailable = true;
  isCalibrated = true;
  fallback: DecisionHandler | null = null;

  on(callSite: string, handler: DecisionHandler): this {
    this.handlers.set(callSite, handler);
    return this;
  }

  available(): boolean {
    return this.isAvailable;
  }
  calibrated(): boolean {
    return this.isCalibrated;
  }

  async decide(evidence: string | object, questions: DecisionQuestion[], opts: DecideOptions): Promise<Record<string, DecisionAnswer>> {
    this.calls.push({ callSite: opts.callSite, evidence, questions });
    if (!this.isAvailable) return {};
    const handler = this.handlers.get(opts.callSite) ?? this.fallback;
    const raw = handler?.(evidence, questions, opts) ?? {};
    const out: Record<string, DecisionAnswer> = {};
    for (const q of questions) {
      const v = raw[q.name];
      if (v === undefined) continue;
      if (q.kind === "binary") out[q.name] = { name: q.name, kind: "binary", p: typeof v === "number" ? v : 0, calibrated: this.isCalibrated };
      else if (q.kind === "choice") {
        const probs = clean(v);
        const choice = Object.entries(probs).sort((a, b) => b[1] - a[1])[0]?.[0];
        out[q.name] = { name: q.name, kind: "choice", probs, choice, confidence: choice ? probs[choice] : 0, calibrated: this.isCalibrated };
      } else {
        const probs = clean(v);
        const labels = q.levels.map((l) => l.label);
        const score01 = labels.reduce((s, l, i) => s + i * (probs[l] ?? 0), 0) / Math.max(1, labels.length - 1);
        out[q.name] = { name: q.name, kind: "score", probs, score01, calibrated: this.isCalibrated };
      }
    }
    return out;
  }

  sites(): string[] {
    return this.calls.map((c) => c.callSite);
  }
}

function clean(v: number | Partial<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof v !== "number") for (const [k, p] of Object.entries(v)) if (typeof p === "number") out[k] = p;
  return out;
}

export class FakeAux implements AuxSessionRunner {
  calls: AuxTask[] = [];
  private handlers = new Map<string, (task: AuxTask) => unknown>();
  isAvailable = true;
  changedFiles: string[] = [];

  on(role: AuxRole, handler: (task: AuxTask) => unknown): this {
    this.handlers.set(role, handler);
    return this;
  }
  available(): boolean {
    return this.isAvailable;
  }
  async run<T>(task: AuxTask<T>): Promise<AuxResult<T>> {
    this.calls.push(task as AuxTask);
    const h = this.handlers.get(task.role);
    let output: unknown = null;
    let error: string | undefined;
    try {
      output = h ? await h(task as AuxTask) : null;
    } catch (e) {
      error = String((e as Error).message);
    }
    return { output: (output ?? null) as T | null, turns: 1, toolCalls: 0, tokens: { input: 100, output: 50 }, blocked: [], changedFiles: this.changedFiles, error };
  }
  roles(): string[] {
    return this.calls.map((c) => c.role);
  }
}

function hashVec(word: string, dims: number): Float32Array {
  const v = new Float32Array(dims);
  let h = 2166136261;
  for (let i = 0; i < dims; i++) {
    for (let j = 0; j < word.length; j++) h = Math.imul(h ^ word.charCodeAt(j), 16777619);
    h = Math.imul(h ^ (i + 1), 16777619);
    v[i] = ((h >>> 0) / 4294967296) * 2 - 1;
  }
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

const STOP = new Set(["the", "a", "an", "of", "to", "in", "on", "is", "are", "and", "or", "for", "with", "that", "this", "it", "be", "by", "at", "as", "must", "after", "run"]);

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 1 && !STOP.has(w));
}

/** Toy late-interaction model: one hashed unit vector per content word. */
export class FakeLate implements EmbeddingClient<"multivector"> {
  readonly kind = "multivector" as const;
  readonly model = "fake-colbert";
  readonly dims = 48;
  readonly key = "fake-colbert:48";
  calls: Array<{ texts: string[]; role: string }> = [];
  up = true;
  async embed(texts: string[], role: "query" | "document"): Promise<TokenMatrix[]> {
    if (!this.up) throw new Error("late endpoint down");
    this.calls.push({ texts, role });
    return texts.map((t) => {
      const ws = words(t);
      return (ws.length ? ws : ["empty"]).map((w) => hashVec(w, this.dims));
    });
  }
  async probe(): Promise<{ ok: boolean }> {
    return { ok: this.up };
  }
  healthy(): boolean {
    return this.up;
  }
}

/** Toy dense model: normalized bag of hashed words. */
export class FakeDense implements EmbeddingClient<"dense"> {
  readonly kind = "dense" as const;
  readonly model = "fake-dense";
  readonly dims = 64;
  readonly key = "fake-dense:64";
  calls: Array<{ texts: string[]; role: string }> = [];
  up = true;
  async embed(texts: string[], role: "query" | "document"): Promise<DenseVector[]> {
    if (!this.up) throw new Error("dense endpoint down");
    this.calls.push({ texts, role });
    return texts.map((t) => {
      const v = new Float32Array(this.dims);
      for (const w of new Set(words(t))) {
        const h = hashVec(w, this.dims);
        for (let i = 0; i < this.dims; i++) v[i]! += h[i]!;
      }
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    });
  }
  async probe(): Promise<{ ok: boolean }> {
    return { ok: this.up };
  }
  healthy(): boolean {
    return this.up;
  }
}

export interface World extends MemoryServices {
  home: string;
  cwd: string;
  decision: FakeDecision;
  aux: FakeAux;
  late: FakeLate | null;
  dense: FakeDense | null;
  layout: Layout;
  now: { t: number };
  /** Reopen the stores as a new process would (same home and project). */
  reopen(over?: Partial<WorldOptions>): World;
  close(): void;
}

export interface WorldOptions {
  cwd?: string;
  home?: string;
  cfg?: unknown;
  trusted?: boolean;
  embeddings?: "none" | "dense" | "late" | "both";
  decision?: FakeDecision;
  aux?: FakeAux;
  startAt?: string;
  actorId?: string;
  sessionId?: string;
}

/** A complete memory world on temporary directories, with programmable fakes for every model. */
export function world(o: WorldOptions = {}): World {
  const home = o.home ?? join(tmp("realctx2-home-"), "realctx2");
  const cwd = o.cwd ?? tmp("realctx2-proj-");
  const cfg: Config = testConfig(o.cfg ?? {});
  const layout = new Layout(home);
  const now = { t: Date.parse(o.startAt ?? "2026-11-20T10:00:00.000Z") };
  const clock = () => new Date(now.t);
  const telemetry = new Telemetry(layout, false);
  const decision = o.decision ?? new FakeDecision();
  const aux = o.aux ?? new FakeAux();
  const mode = o.embeddings ?? "none";
  const late = mode === "late" || mode === "both" ? new FakeLate() : null;
  const dense = mode === "dense" || mode === "both" ? new FakeDense() : null;
  const project = resolveProject(cwd);
  const actorId = o.actorId ?? "actor-test";
  const graph = MemoryGraph.open({ layout, cfg, project, trusted: o.trusted ?? true, actorId, clock, telemetry });
  const sim = new Similarity({ cfg, layout, late, dense, telemetry, clock, random: () => 0.99 });
  const paths = new PathTracker(graph);
  const turns = project.projectKey ? new TurnIndex(layout.turnIndexFile(project.projectKey)) : null;
  const accounting = new SessionAccounting(clock);
  const w: World = {
    cfg,
    layout,
    graph,
    sim,
    paths,
    decision,
    aux,
    turns,
    accounting,
    telemetry,
    clock,
    sessionId: o.sessionId ?? "sess-test",
    actorId,
    home,
    cwd,
    late,
    dense,
    now,
    reopen(over = {}) {
      w.close();
      return world({ ...o, home, cwd, decision, aux, startAt: new Date(now.t).toISOString(), ...over });
    },
    close() {
      try {
        accounting.flush(graph, cfg);
      } catch {
        // already closed
      }
      graph.close();
      turns?.close();
    },
  };
  return w;
}

export const DAY = 86_400_000;
