import { describe, expect, it } from "vitest";
import type { AuxResult, AuxSessionRunner, AuxTask, DecisionQuestion } from "../src/core/types.ts";
import { buildDecisionsRequest, buildSystemOneRequest, CircuitBreaker, EmulatedDecisionClient, type FetchLike, HttpDecisionClient, parseDecisionsResponse, parseSystemOneResponse, ResilientDecisionClient } from "../src/providers/decision.ts";
import { DenseEmbeddingClient, MultiVectorEmbeddingClient } from "../src/providers/embedding.ts";
import { FdeEncoder, fdeParams, fdeScore, maxSim, normalizedMaxSim, packFde, packMatrix, poolTokens, symmetricMaxSim, unpackMatrix } from "../src/providers/late.ts";

const QUESTIONS: DecisionQuestion[] = [
  { kind: "binary", name: "redirect", instructions: "Does the user cancel?", yes: "cancels", no: "continues" },
  { kind: "choice", name: "focus", instructions: "Where next?", options: [{ value: "continue" }, { value: "deepen", description: "sub-purpose" }] },
  { kind: "score", name: "effect", instructions: "Effect?", levels: [{ label: "harmful" }, { label: "no_effect" }, { label: "helpful" }] },
];

function fakeFetch(handler: (url: string, body: any) => { status?: number; json?: unknown; delayMs?: number }): { fetch: FetchLike; calls: Array<{ url: string; body: any; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers });
    const r = handler(url, body);
    if (r.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, r.delayMs);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new Error("aborted"));
        });
      });
    }
    const status = r.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(r.json ?? {}), json: async () => r.json ?? {} };
  };
  return { fetch, calls };
}

describe("decision wire formats", () => {
  it("builds and parses SystemOne requests", () => {
    const req = buildSystemOneRequest("jev-latest", { a: 1 }, QUESTIONS) as any;
    expect(req.state).toEqual({ a: 1 });
    expect(req.questions.redirect).toEqual({ type: "noul", instructions: "Does the user cancel?", criteria: { true: "cancels", false: "continues" } });
    expect(req.questions.focus.criteria).toEqual({ continue: null, deepen: "sub-purpose" });
    expect(req.questions.effect.criteria).toEqual(["harmful", "no_effect", "helpful"]);
    const ans = parseSystemOneResponse(
      {
        answers: {
          redirect: { type: "noul", noul: 0.92 },
          focus: { type: "choice", choice: "deepen", probabilities: { continue: 0.15, deepen: 0.85 }, confidence: 0.8 },
          effect: { type: "score", score: 1.6, legend: { "0": "harmful", "1": "no_effect", "2": "helpful" }, probabilities: { "0": 0.05, "1": 0.3, "2": 0.65 }, confidence: 0.78 },
        },
      },
      QUESTIONS,
    );
    expect(ans.redirect).toMatchObject({ kind: "binary", p: 0.92, calibrated: true });
    expect(ans.focus).toMatchObject({ kind: "choice", choice: "deepen" });
    expect(ans.focus!.probs!.deepen).toBeCloseTo(0.85);
    expect(ans.effect!.score01).toBeCloseTo(0.8); // (0·0.05 + 1·0.3 + 2·0.65) / 2
    expect(ans.effect!.probs).toEqual({ harmful: 0.05, no_effect: 0.3, helpful: 0.65 });
  });

  it("builds and parses Decisions API requests, including refusals", () => {
    const req = buildDecisionsRequest("gpt-6-luna", "evidence text", QUESTIONS, "sess.janus") as any;
    expect(req.input).toBe("evidence text");
    expect(req.prompt_cache_key).toBe("sess.janus");
    expect(req.questions[0]).toMatchObject({ type: "predicate", name: "redirect" });
    expect(req.questions[0].instructions).toContain("True means: cancels");
    expect(req.questions[1].choices).toEqual([{ value: "continue" }, { value: "deepen", description: "sub-purpose" }]);
    expect(req.questions[2].levels).toEqual([{ label: "harmful" }, { label: "no_effect" }, { label: "helpful" }]);
    expect((buildDecisionsRequest("m", { x: 1 }, QUESTIONS) as any).input[0].content[0]).toEqual({ type: "input_json", data: { x: 1 } });
    const ans = parseDecisionsResponse(
      {
        answers: [
          { type: "refusal", name: "redirect" },
          { type: "choice", name: "focus", choice: "continue", probabilities: [{ value: "continue", probability: 0.7 }, { value: "deepen", probability: 0.3 }], confidence: 0.4 },
          { type: "score", name: "effect", score: 1.1, probabilities: [{ value: 0, label: "harmful", probability: 0.1 }, { value: 1, label: "no_effect", probability: 0.7 }, { value: 2, label: "helpful", probability: 0.2 }], confidence: 0.55 },
        ],
      },
      QUESTIONS,
    );
    expect(ans.redirect!.kind).toBe("refusal");
    expect(ans.focus!.probs).toEqual({ continue: 0.7, deepen: 0.3 });
    expect(ans.effect!.score01).toBeCloseTo(0.55);
  });
});

describe("HttpDecisionClient", () => {
  const cfg = { format: "systemone" as const, url: "http://x/v1/systemone", model: "jev", apiKey: "k", maxQuestions: 2 };
  it("splits large requests and sends auth", async () => {
    const { fetch, calls } = fakeFetch((_u, body) => ({ json: { answers: Object.fromEntries(Object.keys(body.questions).map((k) => [k, k === "redirect" ? { type: "noul", noul: 0.5 } : k === "focus" ? { type: "choice", choice: "continue", probabilities: { continue: 1, deepen: 0 }, confidence: 1 } : { type: "score", score: 2, probabilities: { "0": 0, "1": 0, "2": 1 }, confidence: 1 }])) } }));
    const c = new HttpDecisionClient(cfg, { fetch });
    const ans = await c.decide("e", QUESTIONS, { callSite: "t", timeoutMs: 1000 });
    expect(calls.length).toBe(2);
    expect(calls[0]!.headers.authorization).toBe("Bearer k");
    expect(Object.keys(ans).sort()).toEqual(["effect", "focus", "redirect"]);
  });
  it("retries once on 5xx, never when noRetry, and times out", async () => {
    let n = 0;
    const flaky = fakeFetch(() => (n++ === 0 ? { status: 503 } : { json: { answers: { redirect: { type: "noul", noul: 1 } } } }));
    const c = new HttpDecisionClient(cfg, { fetch: flaky.fetch });
    expect((await c.decide("e", [QUESTIONS[0]!], { callSite: "t", timeoutMs: 3000 })).redirect!.p).toBe(1);
    expect(flaky.calls.length).toBe(2);
    n = 0;
    const c2 = new HttpDecisionClient(cfg, { fetch: flaky.fetch });
    await expect(c2.decide("e", [QUESTIONS[0]!], { callSite: "janus", timeoutMs: 3000, noRetry: true })).rejects.toThrow();
    const slow = fakeFetch(() => ({ delayMs: 500, json: {} }));
    const c3 = new HttpDecisionClient(cfg, { fetch: slow.fetch });
    const t0 = Date.now();
    await expect(c3.decide("e", [QUESTIONS[0]!], { callSite: "janus", timeoutMs: 60 })).rejects.toThrow(/timeout/);
    expect(Date.now() - t0).toBeLessThan(400);
  });
  it("drops Decisions API options the server rejects, without failing the call or tripping the breaker", async () => {
    // a Decisions-compatible server without prompt caching or JSON parts (seen in the wild)
    const strict = fakeFetch((_u, body) => {
      if ("prompt_cache_key" in body) return { status: 400, json: { error: { message: "unknown field 'prompt_cache_key'" } } };
      if (typeof body.input !== "string") return { status: 400, json: { error: { message: "Unsupported input content type 'input_json'" } } };
      return { json: { answers: [{ type: "predicate", name: "redirect", probability: 0.25 }] } };
    });
    const c = new HttpDecisionClient({ format: "decisions", url: "http://x/v1/decisions", model: "m" }, { fetch: strict.fetch });
    const ans = await c.decide({ stack: ["a"] }, [QUESTIONS[0]!], { callSite: "janus", timeoutMs: 3000, noRetry: true, cacheKey: "sess.janus" });
    expect(ans.redirect!.p).toBe(0.25);
    expect(strict.calls.length).toBe(3); // as built, without the cache key, then with JSON as text
    expect(JSON.parse(strict.calls[2]!.body.input)).toEqual({ stack: ["a"] });
    expect([...c.unsupported].sort()).toEqual(["input_json", "prompt_cache_key"]);
    // later requests leave both out from the start
    await c.decide({ x: 1 }, [QUESTIONS[0]!], { callSite: "t", timeoutMs: 3000, cacheKey: "k" });
    expect(strict.calls.length).toBe(4);
    expect(c.available()).toBe(true);
    // any other 400 still fails
    const other = fakeFetch(() => ({ status: 400, json: { error: { message: "questions must not be empty" } } }));
    const c2 = new HttpDecisionClient({ format: "decisions", url: "http://x/v1/decisions", model: "m" }, { fetch: other.fetch });
    await expect(c2.decide("e", [QUESTIONS[0]!], { callSite: "t", timeoutMs: 3000, cacheKey: "k" })).rejects.toThrow(/questions must not be empty/);
    expect(other.calls.length).toBe(1);
  });
  it("opens the breaker after 5 consecutive failures for 60 s", () => {
    let now = 0;
    const b = new CircuitBreaker(5, 60_000, () => now);
    for (let i = 0; i < 4; i++) b.failure();
    expect(b.isOpen()).toBe(false);
    b.failure();
    expect(b.isOpen()).toBe(true);
    now = 59_999;
    expect(b.isOpen()).toBe(true);
    now = 60_001;
    expect(b.isOpen()).toBe(false);
  });
});

class FakeAux implements AuxSessionRunner {
  calls: AuxTask[] = [];
  private readonly reply: (task: AuxTask) => unknown;
  constructor(reply: (task: AuxTask) => unknown) {
    this.reply = reply;
  }
  available(): boolean {
    return true;
  }
  async run<T>(task: AuxTask<T>): Promise<AuxResult<T>> {
    this.calls.push(task as AuxTask);
    return { output: this.reply(task as AuxTask) as T, turns: 1, toolCalls: 0, tokens: { input: 10, output: 5 }, blocked: [], changedFiles: [] };
  }
}

describe("emulated decisions", () => {
  it("answers through the aux LLM and marks answers uncalibrated", async () => {
    const aux = new FakeAux(() => ({
      answers: [
        { name: "redirect", probabilities: [{ option: "yes", p: 0.2 }, { option: "no", p: 0.6 }] },
        { name: "focus", probabilities: [{ option: "continue", p: 1 }, { option: "deepen", p: 3 }] },
        { name: "effect", probabilities: [{ option: "harmful", p: 0 }, { option: "no_effect", p: 0.5 }, { option: "helpful", p: 0.5 }] },
      ],
    }));
    const c = new ResilientDecisionClient(null, new EmulatedDecisionClient(aux));
    const ans = await c.decide("ev", QUESTIONS, { callSite: "t", timeoutMs: 1000 });
    expect(aux.calls[0]!.role).toBe("decision.emulate");
    expect(aux.calls[0]!.tools).toBe("none");
    expect(ans.redirect).toMatchObject({ p: 0.25, calibrated: false });
    expect(ans.focus!.probs).toEqual({ continue: 0.25, deepen: 0.75 });
    expect(ans.effect!.score01).toBeCloseTo(0.75);
    expect(c.calibrated()).toBe(false);
    // the call site's timeout applies as it is…
    expect(aux.calls[0]!.budget).toEqual({ timeoutMs: 1000, maxTurns: 1 });
    // …unless a floor is set: an LLM needs seconds where a decision model needs milliseconds
    const patient = new EmulatedDecisionClient(aux, 8000);
    await patient.decide("ev", QUESTIONS, { callSite: "janus", timeoutMs: 1500 });
    await patient.decide("ev", QUESTIONS, { callSite: "attribution", timeoutMs: 10_000 });
    expect(aux.calls.slice(1).map((c) => c.budget!.timeoutMs)).toEqual([8000, 10_000]);
  });
  it("returns an empty map when everything fails", async () => {
    const c = new ResilientDecisionClient(null, null);
    expect(await c.decide("e", QUESTIONS, { callSite: "t", timeoutMs: 10 })).toEqual({});
    expect(c.available()).toBe(false);
  });
});

describe("embedding clients", () => {
  it("dense: batches, aligns by index, normalizes, and checks shape", async () => {
    const { fetch, calls } = fakeFetch((_u, body) => ({ json: { data: body.input.map((_t: string, i: number) => ({ index: body.input.length - 1 - i, embedding: [3, 4, body.input.length - 1 - i] })).reverse() } }));
    const c = new DenseEmbeddingClient({ url: "http://e", model: "m", dimensions: 3, batchSize: 2, role: "prefix", queryPrefix: "Q: " }, { fetch });
    const out = await c.embed(["a", "b", "c"], "query");
    expect(calls.length).toBe(2);
    expect(calls[0]!.body).toMatchObject({ model: "m", dimensions: 3, encoding_format: "float", input: ["Q: a", "Q: b"] });
    expect(out.length).toBe(3);
    expect(Math.hypot(...out[1]!)).toBeCloseTo(1);
    const bad = new DenseEmbeddingClient({ url: "http://e", model: "m" }, { fetch: fakeFetch(() => ({ json: { data: [{ index: 0, embedding: [[1, 2], [3, 4]] }] } })).fetch });
    expect((await bad.probe()).ok).toBe(false);
    expect(bad.healthy()).toBe(false);
    expect(bad.disabledReason).toMatch(/multivector/);
  });
  it("multivector: token matrices, no dimensions, prefixes, pooling alias, punctuation rows", async () => {
    const matrix = [[1, 0, 0], [0, 2, 0], [0, 0, 3]];
    const { fetch, calls } = fakeFetch((_u, body) => ({ json: { data: body.input.map((_t: string, i: number) => ({ index: i, embedding: matrix, tokens: ["hello", ".", "world"] })) } }));
    const c = new MultiVectorEmbeddingClient({ url: "http://e", model: "colbert", dims: 3, role: "prefix", queryPrefix: "[Q] ", documentPrefix: "[D] ", dimensions: 64 }, { fetch });
    const docs = await c.embed(["x"], "document");
    expect(calls[0]!.body.input).toEqual(["[D] x"]);
    expect("dimensions" in calls[0]!.body).toBe(false);
    expect(docs[0]!.length).toBe(2); // the "." row is dropped for documents
    expect(Array.from(docs[0]![1]!)).toEqual([0, 0, 1]);
    const q = await c.embed(["x"], "query");
    expect(q[0]!.length).toBe(3);
    const pooled = new MultiVectorEmbeddingClient({ url: "http://e/pooling", model: "colbert", transport: "pooling", role: "input_type" }, { fetch: fakeFetch((_u, body) => ({ json: { data: [{ index: 0, data: matrix }] }, ...(body.input_type === "query" ? {} : {}) })).fetch });
    expect((await pooled.embed(["x"], "query"))[0]!.length).toBe(3);
    const wrongWidth = new MultiVectorEmbeddingClient({ url: "http://e", model: "colbert", dims: 128 }, { fetch });
    await expect(wrongWidth.embed(["x"], "document")).rejects.toThrow(/width 128/);
    expect(wrongWidth.healthy()).toBe(false);
    const dense = new MultiVectorEmbeddingClient({ url: "http://e", model: "colbert" }, { fetch: fakeFetch(() => ({ json: { data: [{ index: 0, embedding: [1, 2, 3] }] } })).fetch });
    await expect(dense.embed(["x"], "document")).rejects.toThrow(/token matrix/);
  });
});

function randMatrix(rows: number, dims: number, seed: number): Float32Array[] {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  return Array.from({ length: rows }, () => {
    const v = Float32Array.from({ length: dims }, rnd);
    const n = Math.hypot(...v);
    return v.map((x) => x / n);
  });
}

describe("late interaction math", () => {
  it("computes MaxSim and its normalized and symmetric forms", () => {
    const q = [Float32Array.from([1, 0]), Float32Array.from([0, 1])];
    const d = [Float32Array.from([1, 0]), Float32Array.from([Math.SQRT1_2, Math.SQRT1_2])];
    expect(maxSim(q, d)).toBeCloseTo(1 + Math.SQRT1_2);
    expect(normalizedMaxSim(q, q)).toBeCloseTo(1);
    expect(symmetricMaxSim(q, d)).toBeCloseTo(((1 + Math.SQRT1_2) / 2 + (1 + Math.SQRT1_2) / 2) / 2);
  });
  it("keeps scores through int8 and 1-bit quantization", () => {
    const q = randMatrix(8, 64, 1);
    const d = randMatrix(40, 64, 2);
    const exact = normalizedMaxSim(q, d);
    const i8 = packMatrix(d, "int8");
    expect(i8.data.length).toBe(40 * 64);
    expect(normalizedMaxSim(q, unpackMatrix(i8))).toBeCloseTo(exact, 2);
    const bin = packMatrix(d, "binary");
    expect(bin.data.length).toBe(40 * 8);
    expect(Math.abs(normalizedMaxSim(q, unpackMatrix(bin)) - exact)).toBeLessThan(0.2);
    expect(unpackMatrix(packMatrix(d, "float32"))[3]![5]).toBeCloseTo(d[3]![5]!, 6);
  });
  it("pools tokens by the requested factor", () => {
    const d = randMatrix(40, 32, 3);
    const pooled = poolTokens(d, 2);
    expect(pooled.length).toBe(20);
    for (const r of pooled) expect(Math.hypot(...r)).toBeCloseTo(1, 4);
    expect(poolTokens(d, 1)).toBe(d);
  });
  it("FDE scores track MaxSim well enough to rank candidates", () => {
    const dims = 64;
    const enc = new FdeEncoder(fdeParams(dims, 512));
    expect(enc.size).toBe(512);
    const q = randMatrix(8, dims, 10);
    // the relevant document contains noisy copies of the query tokens
    const relevant = [...q.map((v, i) => { const n = randMatrix(1, dims, 100 + i)[0]!; const mixed = v.map((x, j) => x + 0.15 * n[j]!); const norm = Math.hypot(...mixed); return mixed.map((x) => x / norm); }), ...randMatrix(24, dims, 11)];
    const docs = [relevant, ...Array.from({ length: 30 }, (_, i) => randMatrix(32, dims, 200 + i))];
    const qf = enc.query(q);
    const scores = docs.map((d) => fdeScore(qf, packFde(enc.document(d), "int8"), "int8"));
    const rank = scores.map((s, i) => [s, i] as const).sort((a, b) => b[0] - a[0]).findIndex(([, i]) => i === 0);
    expect(rank).toBeLessThan(3);
    expect(packFde(enc.document(docs[1]!), "int8").length).toBe(516);
    // same seed → same encoding (stored FDEs stay comparable across runs)
    expect(Array.from(new FdeEncoder(fdeParams(dims, 512)).query(q))).toEqual(Array.from(qf));
  });
});
