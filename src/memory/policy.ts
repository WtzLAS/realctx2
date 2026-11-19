/**
 * Evolution policy (§6.6.3–§6.6.6): a small MLP with an operator head, a candidate head per
 * operator and five instantiation heads; a utility predictor; EvoDisco's strategic efficacy E;
 * and the teacher phases T0 (imitate), T1 (kickstart) and T2 (graduated).
 * Everything here is local to the machine (`evolution/`), never synced.
 */
import { join } from "node:path";
import { appendJsonl, readJson, readJsonl, writeJson } from "../util/fs.ts";
import { median } from "../util/text.ts";

export const OPERATORS = ["abstract", "refine", "bridge", "reframe"] as const;
export type Operator = (typeof OPERATORS)[number];
export const MAX_CANDIDATES = 8;
export const HEADS = {
  k: [1, 2, 3],
  p: [0, 0.5],
  m: [2, 3, 4],
  dimension: ["temporal", "causal", "categorical"],
  frame: ["temporal_to_causal", "causal_to_temporal", "effect_cause"],
} as const;
export type HeadName = keyof typeof HEADS;
export const HEAD_NAMES: HeadName[] = ["k", "p", "m", "dimension", "frame"];

export interface Action {
  operator: Operator;
  candidate: number;
  k: number;
  p: number;
  m: number;
  dimension: (typeof HEADS.dimension)[number];
  frame: (typeof HEADS.frame)[number];
}

/** A full distribution over the action space, as the teacher returns it. */
export interface ActionDist {
  operator: number[]; // 4
  candidate: Partial<Record<Operator, number[]>>; // per operator, up to 8
  heads: Partial<Record<HeadName, number[]>>;
}

export interface Attempt {
  at: string;
  scope: string;
  s: number[];
  a: Action;
  /** Who chose the action. `ab` marks randomized A/B decisions (used for graduation). */
  actor: "teacher" | "mlp" | "rules";
  ab?: boolean;
  fallback?: boolean;
  teacher?: ActionDist;
  U: number;
  Uhat: number;
  E?: number;
  committed: boolean;
  vetoed?: boolean;
  cost?: { auxTokens: number; decisionCalls: number };
  detail?: string;
}

// group layout of the policy output
const OP_OFF = 0;
const CAND_OFF = OPERATORS.length;
const HEAD_OFF: Record<HeadName, number> = (() => {
  let off = CAND_OFF + OPERATORS.length * MAX_CANDIDATES;
  const out = {} as Record<HeadName, number>;
  for (const h of HEAD_NAMES) {
    out[h] = off;
    off += HEADS[h].length;
  }
  return out;
})();
export const POLICY_OUT = HEAD_OFF.frame + HEADS.frame.length;
export const ACTION_DIM = OPERATORS.length + MAX_CANDIDATES + HEAD_NAMES.reduce((s, h) => s + HEADS[h].length, 0);

// ───────────────────────────── a tiny MLP with Adam

export interface NetState {
  inDim: number;
  hidden: number;
  outDim: number;
  w1: number[];
  b1: number[];
  w2: number[];
  b2: number[];
  m: number[];
  v: number[];
  t: number;
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

export function softmax(logits: number[], mask?: boolean[]): number[] {
  let max = -Infinity;
  for (let i = 0; i < logits.length; i++) if ((!mask || mask[i]) && logits[i]! > max) max = logits[i]!;
  if (max === -Infinity) return logits.map(() => 0);
  let sum = 0;
  const out = logits.map((x, i) => {
    if (mask && !mask[i]) return 0;
    const e = Math.exp(x - max);
    sum += e;
    return e;
  });
  return out.map((x) => x / sum);
}

export function entropy(p: number[]): number {
  let h = 0;
  for (const x of p) if (x > 0) h -= x * Math.log(x);
  return h;
}

export class Mlp {
  s: NetState;
  private readonly lr: number;

  constructor(state: NetState | { inDim: number; hidden: number; outDim: number; seed?: number }, lr = 1e-3) {
    this.lr = lr;
    if ("w1" in state) {
      this.s = state;
      return;
    }
    const { inDim, hidden, outDim } = state;
    const rnd = lcg(state.seed ?? 7);
    const init = (n: number, fanIn: number) => Array.from({ length: n }, () => (rnd() * 2 - 1) * Math.sqrt(2 / fanIn));
    const params = inDim * hidden + hidden + hidden * outDim + outDim;
    this.s = { inDim, hidden, outDim, w1: init(inDim * hidden, inDim), b1: new Array(hidden).fill(0), w2: init(hidden * outDim, hidden).map((x) => x * 0.1), b2: new Array(outDim).fill(0), m: new Array(params).fill(0), v: new Array(params).fill(0), t: 0 };
  }

  forward(x: number[]): { h: number[]; out: number[] } {
    const { inDim, hidden, outDim, w1, b1, w2, b2 } = this.s;
    const h = new Array<number>(hidden);
    for (let j = 0; j < hidden; j++) {
      let sum = b1[j]!;
      for (let i = 0; i < inDim; i++) sum += w1[j * inDim + i]! * (x[i] ?? 0);
      h[j] = sum > 0 ? sum : 0;
    }
    const out = new Array<number>(outDim);
    for (let k = 0; k < outDim; k++) {
      let sum = b2[k]!;
      for (let j = 0; j < hidden; j++) sum += w2[k * hidden + j]! * h[j]!;
      out[k] = sum;
    }
    return { h, out };
  }

  /** One Adam step given dL/d(out) for a batch of inputs. */
  step(batch: Array<{ x: number[]; dOut: number[] }>): void {
    if (!batch.length) return;
    const { inDim, hidden, outDim, w1, b1, w2, b2 } = this.s;
    const gW1 = new Array<number>(w1.length).fill(0);
    const gB1 = new Array<number>(hidden).fill(0);
    const gW2 = new Array<number>(w2.length).fill(0);
    const gB2 = new Array<number>(outDim).fill(0);
    for (const { x, dOut } of batch) {
      const { h } = this.forward(x);
      const dH = new Array<number>(hidden).fill(0);
      for (let k = 0; k < outDim; k++) {
        const g = dOut[k] ?? 0;
        if (g === 0) continue;
        gB2[k]! += g;
        for (let j = 0; j < hidden; j++) {
          gW2[k * hidden + j]! += g * h[j]!;
          dH[j]! += g * w2[k * hidden + j]!;
        }
      }
      for (let j = 0; j < hidden; j++) {
        if (h[j]! <= 0 || dH[j] === 0) continue;
        gB1[j]! += dH[j]!;
        for (let i = 0; i < inDim; i++) gW1[j * inDim + i]! += dH[j]! * (x[i] ?? 0);
      }
    }
    const scale = 1 / batch.length;
    const grads = [gW1, gB1, gW2, gB2];
    const params = [w1, b1, w2, b2];
    const st = this.s;
    st.t++;
    const b1c = 1 - 0.9 ** st.t;
    const b2c = 1 - 0.999 ** st.t;
    let idx = 0;
    for (let a = 0; a < params.length; a++) {
      const P = params[a]!;
      const G = grads[a]!;
      for (let i = 0; i < P.length; i++, idx++) {
        const g = Math.max(-5, Math.min(5, G[i]! * scale));
        st.m[idx] = 0.9 * st.m[idx]! + 0.1 * g;
        st.v[idx] = 0.999 * st.v[idx]! + 0.001 * g * g;
        P[i] = P[i]! - (this.lr * (st.m[idx]! / b1c)) / (Math.sqrt(st.v[idx]! / b2c) + 1e-8);
      }
    }
  }
}

// ───────────────────────────── policy state

export interface PolicyState {
  version: 1;
  featureDim: number;
  phase: "T0" | "T1" | "T2";
  attempts: number;
  /** Running mean of E (the baseline Ē). */
  Ebar: number | null;
  policy: NetState;
  predictor: NetState;
  /** Recent |Û − U| values, for the high-PredErr fallback. */
  predErr: number[];
  sinceUpdate: number;
  graduatedAt?: string;
  demotedAt?: string;
}

export interface Masks {
  operators: boolean[];
  candidates: Record<Operator, number>;
}

export function encodeAction(a: Action): number[] {
  const out = new Array<number>(ACTION_DIM).fill(0);
  out[OPERATORS.indexOf(a.operator)] = 1;
  out[OPERATORS.length + Math.min(MAX_CANDIDATES - 1, Math.max(0, a.candidate))] = 1;
  let off = OPERATORS.length + MAX_CANDIDATES;
  for (const h of HEAD_NAMES) {
    const idx = (HEADS[h] as readonly (number | string)[]).indexOf(a[h]);
    if (idx >= 0) out[off + idx] = 1;
    off += HEADS[h].length;
  }
  return out;
}

function sample(p: number[], rnd: () => number): number {
  const r = rnd();
  let acc = 0;
  for (let i = 0; i < p.length; i++) {
    acc += p[i]!;
    if (r < acc) return i;
  }
  for (let i = p.length - 1; i >= 0; i--) if (p[i]! > 0) return i;
  return 0;
}

function normalize(p: number[] | undefined, n: number, mask?: boolean[]): number[] | null {
  if (!p) return null;
  const v = Array.from({ length: n }, (_, i) => (mask && !mask[i] ? 0 : Math.max(0, p[i] ?? 0)));
  const sum = v.reduce((a, b) => a + b, 0);
  return sum > 0 ? v.map((x) => x / sum) : null;
}

/** Sample an action from a full distribution (the teacher's answer), respecting the masks. */
export function sampleFromDist(dist: ActionDist, masks: Masks, rnd: () => number): Action | null {
  const op = normalize(dist.operator, OPERATORS.length, masks.operators);
  if (!op) return null;
  const operator = OPERATORS[sample(op, rnd)]!;
  const n = masks.candidates[operator];
  const cand = normalize(dist.candidate[operator], MAX_CANDIDATES, Array.from({ length: MAX_CANDIDATES }, (_, i) => i < n));
  const pick = <H extends HeadName>(h: H): (typeof HEADS)[H][number] => {
    const p = normalize(dist.heads[h], HEADS[h].length);
    return HEADS[h][p ? sample(p, rnd) : 0] as (typeof HEADS)[H][number];
  };
  return { operator, candidate: cand ? sample(cand, rnd) : 0, k: pick("k"), p: pick("p"), m: pick("m"), dimension: pick("dimension"), frame: pick("frame") };
}

export class Policy {
  readonly dir: string | null;
  state: PolicyState;
  private policyNet: Mlp;
  private predictorNet: Mlp;
  private readonly rnd: () => number;

  constructor(dir: string | null, featureDim: number, rnd: () => number = Math.random) {
    this.dir = dir;
    this.rnd = rnd;
    const saved = dir ? readJson<PolicyState | null>(join(dir, "policy.json"), null) : null;
    if (saved && saved.version === 1 && saved.featureDim === featureDim && saved.policy?.outDim === POLICY_OUT) this.state = saved;
    else {
      this.state = {
        version: 1,
        featureDim,
        phase: "T0",
        attempts: 0,
        Ebar: null,
        policy: new Mlp({ inDim: featureDim, hidden: 64, outDim: POLICY_OUT, seed: 11 }).s,
        predictor: new Mlp({ inDim: featureDim + ACTION_DIM, hidden: 64, outDim: 1, seed: 13 }).s,
        predErr: [],
        sinceUpdate: 0,
      };
    }
    this.policyNet = new Mlp(this.state.policy);
    this.predictorNet = new Mlp(this.state.predictor);
  }

  save(): void {
    if (!this.dir) return;
    try {
      writeJson(join(this.dir, "policy.json"), this.state);
    } catch {
      // the policy is rebuilt from the attempt log when it cannot be stored
    }
  }

  // ───────────── distributions
  dist(s: number[], masks: Masks): { operator: number[]; candidate: Record<Operator, number[]>; heads: Record<HeadName, number[]> } {
    const { out } = this.policyNet.forward(s);
    const operator = softmax(out.slice(OP_OFF, OP_OFF + OPERATORS.length), masks.operators);
    const candidate = {} as Record<Operator, number[]>;
    OPERATORS.forEach((op, i) => {
      const n = masks.candidates[op];
      candidate[op] = softmax(out.slice(CAND_OFF + i * MAX_CANDIDATES, CAND_OFF + (i + 1) * MAX_CANDIDATES), Array.from({ length: MAX_CANDIDATES }, (_, j) => j < n));
    });
    const heads = {} as Record<HeadName, number[]>;
    for (const h of HEAD_NAMES) heads[h] = softmax(out.slice(HEAD_OFF[h], HEAD_OFF[h] + HEADS[h].length));
    return { operator, candidate, heads };
  }

  /** Sample from π(a|s) = π(o|s) · π(c|s, o) · π(θ|s). */
  act(s: number[], masks: Masks): { action: Action; entropy: number; maxEntropy: number } | null {
    if (!masks.operators.some(Boolean)) return null;
    const d = this.dist(s, masks);
    const action = sampleFromDist({ operator: d.operator, candidate: d.candidate, heads: d.heads }, masks, this.rnd);
    if (!action) return null;
    return { action, entropy: entropy(d.operator), maxEntropy: Math.log(Math.max(1, masks.operators.filter(Boolean).length)) };
  }

  predict(s: number[], a: Action): number {
    return this.predictorNet.forward([...s, ...encodeAction(a)]).out[0] ?? 0;
  }

  // ───────────── learning
  private ceGrad(s: number[], target: ActionDist, masks: Masks, weight: number): number[] {
    const d = this.dist(s, masks);
    const g = new Array<number>(POLICY_OUT).fill(0);
    const op = normalize(target.operator, OPERATORS.length, masks.operators);
    if (op) for (let i = 0; i < OPERATORS.length; i++) g[OP_OFF + i] = weight * (d.operator[i]! - op[i]!);
    OPERATORS.forEach((o, i) => {
      const n = masks.candidates[o];
      const t = normalize(target.candidate[o], MAX_CANDIDATES, Array.from({ length: MAX_CANDIDATES }, (_, j) => j < n));
      if (!t) return;
      for (let j = 0; j < MAX_CANDIDATES; j++) g[CAND_OFF + i * MAX_CANDIDATES + j] = weight * (d.candidate[o][j]! - t[j]!);
    });
    for (const h of HEAD_NAMES) {
      const t = normalize(target.heads[h], HEADS[h].length);
      if (!t) continue;
      for (let j = 0; j < HEADS[h].length; j++) g[HEAD_OFF[h] + j] = weight * (d.heads[h][j]! - t[j]!);
    }
    return g;
  }

  /** dL/dlogits for L = −adv · log π^w(a|s), with log π^w = log π(o) + log π(c|o) + ¼ Σ log π(θ_j). */
  private pgGrad(s: number[], a: Action, masks: Masks, adv: number): number[] {
    const d = this.dist(s, masks);
    const g = new Array<number>(POLICY_OUT).fill(0);
    const oi = OPERATORS.indexOf(a.operator);
    for (let i = 0; i < OPERATORS.length; i++) g[OP_OFF + i] = adv * (d.operator[i]! - (i === oi ? 1 : 0));
    const n = masks.candidates[a.operator];
    for (let j = 0; j < MAX_CANDIDATES; j++) if (j < n) g[CAND_OFF + oi * MAX_CANDIDATES + j] = adv * (d.candidate[a.operator][j]! - (j === a.candidate ? 1 : 0));
    for (const h of HEAD_NAMES) {
      const idx = (HEADS[h] as readonly (number | string)[]).indexOf(a[h]);
      for (let j = 0; j < HEADS[h].length; j++) g[HEAD_OFF[h] + j] = 0.25 * adv * (d.heads[h][j]! - (j === idx ? 1 : 0));
    }
    return g;
  }

  /**
   * Record one attempt; every N attempts run the update for the current phase:
   * T0 cross-entropy to the teacher, T1 centered policy gradient + λ_t · KL(teacher ‖ π), T2 policy gradient only.
   */
  record(attempt: Attempt, masks: Masks, hyper: { K: number; N: number; gamma: number; delta: number; eta: number }, window: Attempt[]): { E: number; updated: boolean } {
    const st = this.state;
    st.attempts++;
    st.sinceUpdate++;
    st.predErr.push(Math.abs(attempt.Uhat - attempt.U));
    if (st.predErr.length > 200) st.predErr.splice(0, st.predErr.length - 200);
    // the predictor learns from every logged (s, a, U)
    this.predictorNet.step([{ x: [...attempt.s, ...encodeAction(attempt.a)], dOut: [2 * (this.predict(attempt.s, attempt.a) - attempt.U)] }]);
    const recent = [...window, attempt].slice(-hyper.K);
    const E = efficacy(recent, hyper);
    let updated = false;
    if (st.sinceUpdate >= hyper.N) {
      st.sinceUpdate = 0;
      updated = true;
      const batch = recent.slice(-hyper.N).filter((a) => a.s.length === st.featureDim);
      const adv = E - (st.Ebar ?? E);
      const lambdaT = Math.exp(-st.attempts / 500);
      const grads: Array<{ x: number[]; dOut: number[] }> = [];
      for (const a of batch) {
        let g: number[];
        if (st.phase === "T0") {
          if (!a.teacher) continue;
          g = this.ceGrad(a.s, a.teacher, masks, 1);
        } else {
          // gradient descent on −adv·log π ⇒ adv·(softmax − onehot)
          g = this.pgGrad(a.s, a.a, masks, adv);
          if (st.phase === "T1" && a.teacher) {
            const kl = this.ceGrad(a.s, a.teacher, masks, lambdaT);
            for (let i = 0; i < g.length; i++) g[i]! += kl[i]!;
          }
        }
        grads.push({ x: a.s, dOut: g });
      }
      this.policyNet.step(grads);
      st.Ebar = st.Ebar === null ? E : 0.9 * st.Ebar + 0.1 * E;
      this.advancePhase(window);
      this.save();
    }
    return { E, updated };
  }

  /** Whether the teacher should act instead of the MLP for this decision. */
  teacherTurn(entropyNow: number, maxEntropy: number): { teacher: boolean; ab: boolean; fallback: boolean } {
    const st = this.state;
    if (st.phase === "T0") return { teacher: true, ab: false, fallback: false };
    // safety fallback: an undecided policy or a predictor that has lost track (excluded from A/B)
    const med = median(st.predErr.slice(0, -8));
    const recent = st.predErr.slice(-8);
    const recentErr = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
    if (st.phase === "T1" && ((maxEntropy > 0 && entropyNow > 0.9 * maxEntropy) || (med > 0 && recentErr > 2 * med))) return { teacher: true, ab: false, fallback: true };
    const share = st.phase === "T1" ? 0.2 : 0.15;
    return { teacher: this.rnd() < share, ab: true, fallback: false };
  }

  private advancePhase(window: Attempt[]): void {
    const st = this.state;
    if (st.phase === "T0" && st.attempts >= 300) {
      st.phase = "T1";
      return;
    }
    const ab = window.filter((a) => a.ab && !a.fallback).slice(-200);
    const mlp = ab.filter((a) => a.actor === "mlp").map((a) => a.U);
    const teacher = ab.filter((a) => a.actor === "teacher").map((a) => a.U);
    if (mlp.length < 20 || teacher.length < 20) return;
    const ci = (xs: number[]) => {
      const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
      const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, xs.length - 1));
      const half = (1.96 * sd) / Math.sqrt(xs.length);
      return { mean, lo: mean - half, hi: mean + half };
    };
    const a = ci(mlp);
    const b = ci(teacher);
    if (st.phase === "T1" && ab.length >= 200 && a.lo > b.hi) {
      // graduation: the MLP's mean U exceeds the teacher's with non-overlapping 95% intervals
      st.phase = "T2";
      st.graduatedAt = new Date().toISOString();
    } else if (st.phase === "T2" && a.mean < b.mean) {
      st.phase = "T1";
      st.demotedAt = new Date().toISOString();
    }
  }
}

/** E = −γ · Regret − δ · PredErr + η · Div over the last K attempts (§6.6.4). */
export function efficacy(window: Attempt[], hyper: { gamma: number; delta: number; eta: number }, h = 8): number {
  if (!window.length) return 0;
  const byOp = new Map<string, number[]>();
  for (const a of window) {
    const list = byOp.get(a.a.operator);
    if (list) list.push(a.U);
    else byOp.set(a.a.operator, [a.U]);
  }
  let bestMean = -Infinity;
  for (const us of byOp.values()) {
    const last = us.slice(-h);
    bestMean = Math.max(bestMean, last.reduce((x, y) => x + y, 0) / last.length);
  }
  const regret = window.reduce((s, a) => s + Math.max(0, bestMean - a.U), 0) / window.length;
  const predErr = window.reduce((s, a) => s + Math.abs(a.Uhat - a.U), 0) / window.length;
  const freqs = [...byOp.values()].map((us) => us.length / window.length);
  return -hyper.gamma * regret - hyper.delta * predErr + hyper.eta * entropy(freqs);
}

// ───────────────────────────── local logs

export class EvolutionLog {
  readonly dir: string | null;
  constructor(dir: string | null) {
    this.dir = dir;
  }
  private file(name: string): string | null {
    return this.dir ? join(this.dir, name) : null;
  }
  append(attempt: Attempt): void {
    const f = this.file("attempts.jsonl");
    if (f) appendJsonl(f, attempt);
  }
  attempts(limit = 400): Attempt[] {
    const f = this.file("attempts.jsonl");
    if (!f) return [];
    const all = readJsonl<Attempt>(f);
    return all.slice(-limit);
  }
  /** Closure outcomes of intents that used a scope: success 1, failure 0, abandoned 0.5. */
  recordOutcome(scope: string, y: number, at: string): void {
    const f = this.file("outcomes.jsonl");
    if (f) appendJsonl(f, { scope, y, at });
  }
  outcomes(scope: string, limit = 20): number[] {
    const f = this.file("outcomes.jsonl");
    if (!f) return [];
    return readJsonl<{ scope: string; y: number }>(f).filter((o) => o.scope === scope).slice(-limit).map((o) => o.y);
  }
  proposals(): Array<Record<string, unknown>> {
    const f = this.file("proposals.jsonl");
    return f ? readJsonl<Record<string, unknown>>(f) : [];
  }
  propose(p: Record<string, unknown>): void {
    const f = this.file("proposals.jsonl");
    if (f) appendJsonl(f, p);
  }
  lastSharedPass(): string | null {
    const f = this.file("shared-pass.json");
    return f ? readJson<{ at?: string }>(f, {}).at ?? null : null;
  }
  markSharedPass(at: string): void {
    const f = this.file("shared-pass.json");
    if (f) writeJson(f, { at });
  }
}
