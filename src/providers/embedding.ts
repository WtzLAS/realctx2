/**
 * Embedding clients in the OpenAI Embeddings format (§9.2): dense (one vector per text) and
 * late interaction (one vector per token, `embedding` returned as a matrix, as vLLM serves
 * `token_embed` models).
 */
import type { EmbeddingProviderConfig } from "../core/config.ts";
import { resolveApiKey } from "../core/config.ts";
import type { Telemetry } from "../core/telemetry.ts";
import type { DenseVector, EmbeddingClient, TokenMatrix } from "../core/types.ts";
import { clipTokens, estimateTokens, sha256 } from "../util/text.ts";
import { CircuitBreaker, type FetchLike } from "./decision.ts";

export interface EmbeddingOptions {
  fetch?: FetchLike;
  telemetry?: Telemetry;
  timeoutMs?: number;
  now?: () => number;
}

export class EmbeddingShapeError extends Error {}

function l2normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
  n = Math.sqrt(n);
  if (n > 0 && Math.abs(n - 1) > 1e-4) for (let i = 0; i < v.length; i++) v[i] = v[i]! / n;
  return v;
}

const PUNCT_ONLY = /^[\s\p{P}\p{S}]*$/u;

abstract class BaseClient {
  readonly config: EmbeddingProviderConfig;
  readonly model: string;
  readonly breaker: CircuitBreaker;
  protected readonly fetchImpl: FetchLike;
  protected readonly telemetry?: Telemetry;
  protected readonly timeoutMs: number;
  /** Set when a response had the wrong shape: the provider stays off until reconfigured. */
  disabledReason: string | undefined;

  constructor(config: EmbeddingProviderConfig, opts: EmbeddingOptions) {
    this.config = config;
    this.model = config.model;
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.telemetry = opts.telemetry;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.breaker = new CircuitBreaker(5, 60_000, opts.now);
  }

  healthy(): boolean {
    return !this.disabledReason && !this.breaker.isOpen();
  }

  protected applyRole(texts: string[], role: "query" | "document"): { input: string[]; extra: Record<string, unknown> } {
    const mode = this.config.role ?? "none";
    const max = this.config.maxInputTokens;
    const clip = (t: string) => (max ? clipTokens(t, max) : t);
    if (mode === "prefix") {
      const prefix = role === "query" ? (this.config.queryPrefix ?? "") : (this.config.documentPrefix ?? "");
      return { input: texts.map((t) => prefix + clip(t)), extra: {} };
    }
    if (mode === "input_type") return { input: texts.map(clip), extra: { input_type: role } };
    return { input: texts.map(clip), extra: {} };
  }

  /** POST one batch with a timeout, one retry with jitter on 429/5xx, and the breaker. */
  protected async post(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (this.disabledReason) throw new Error(`embedding provider disabled: ${this.disabledReason}`);
    if (this.breaker.isOpen()) throw new Error("embedding circuit breaker open");
    const headers: Record<string, string> = { "content-type": "application/json", ...(this.config.headers ?? {}) };
    const key = resolveApiKey(this.config);
    if (key) headers.authorization = `Bearer ${key}`;
    const payload = JSON.stringify(body);
    const started = Date.now();
    let lastErr = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 150 + Math.random() * 350));
      const timeout = AbortSignal.timeout(this.timeoutMs);
      try {
        const res = await this.fetchImpl(this.config.url, { method: "POST", headers, body: payload, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
        if (!res.ok) {
          lastErr = `http ${res.status}`;
          if (res.status === 429 || res.status >= 500) continue;
          break;
        }
        const json = await res.json();
        this.breaker.success();
        this.telemetry?.call({ callSite: `embedding.${this.config.kind ?? "dense"}`, kind: "embedding", latencyMs: Date.now() - started, inputTokens: estimateTokens(payload), outcome: "ok" });
        return json;
      } catch (e) {
        if (signal?.aborted) throw new Error("aborted");
        lastErr = timeout.aborted ? "timeout" : String((e as Error).message ?? e);
      }
    }
    this.breaker.failure();
    this.telemetry?.call({ callSite: `embedding.${this.config.kind ?? "dense"}`, kind: "embedding", latencyMs: Date.now() - started, outcome: lastErr === "timeout" ? "timeout" : "error", detail: lastErr });
    throw new Error(`embedding request failed: ${lastErr}`);
  }

  protected rows(json: unknown, expected: number): Array<Record<string, unknown>> {
    const data = (json as { data?: unknown })?.data;
    if (!Array.isArray(data) || data.length !== expected) throw this.shape(`expected ${expected} items in "data", got ${Array.isArray(data) ? data.length : typeof data}`);
    const out: Array<Record<string, unknown>> = new Array(expected);
    data.forEach((item, i) => {
      const idx = typeof (item as { index?: unknown })?.index === "number" ? ((item as { index: number }).index as number) : i;
      if (idx < 0 || idx >= expected || out[idx]) throw this.shape(`bad or duplicate index ${idx}`);
      out[idx] = item as Record<string, unknown>;
    });
    return out;
  }

  protected shape(problem: string): EmbeddingShapeError {
    this.disabledReason = problem;
    return new EmbeddingShapeError(problem);
  }
}

export class DenseEmbeddingClient extends BaseClient implements EmbeddingClient<"dense"> {
  readonly kind = "dense" as const;
  private seenDims = 0;

  get dims(): number {
    return this.config.dimensions ?? this.seenDims;
  }

  get key(): string {
    return sha256(JSON.stringify(["dense", this.model, this.config.dimensions ?? null, this.config.role ?? "none", this.config.queryPrefix ?? "", this.config.documentPrefix ?? ""])).slice(0, 16);
  }

  async embed(texts: string[], role: "query" | "document", signal?: AbortSignal): Promise<DenseVector[]> {
    const out: DenseVector[] = [];
    const batch = Math.min(this.config.batchSize ?? 128, 128);
    for (let i = 0; i < texts.length; i += batch) {
      const { input, extra } = this.applyRole(texts.slice(i, i + batch), role);
      const body: Record<string, unknown> = { model: this.model, input, encoding_format: "float", ...extra };
      if (this.config.dimensions) body.dimensions = this.config.dimensions;
      const json = await this.post(body, signal);
      for (const item of this.rows(json, input.length)) {
        const e = item.embedding;
        if (!Array.isArray(e) || e.length === 0 || typeof e[0] !== "number") throw this.shape('dense model returned a non-vector "embedding" (is this a token_embed model? set kind: "multivector")');
        if (this.config.dimensions && e.length !== this.config.dimensions) throw this.shape(`expected ${this.config.dimensions} dimensions, got ${e.length}`);
        if (this.seenDims && e.length !== this.seenDims) throw this.shape(`dimension changed from ${this.seenDims} to ${e.length}`);
        this.seenDims = e.length;
        out.push(l2normalize(Float32Array.from(e as number[])));
      }
    }
    return out;
  }

  async probe(): Promise<{ ok: boolean; problem?: string }> {
    try {
      const [v] = await this.embed(["realctx2 embedding probe"], "document");
      return v && v.length > 0 ? { ok: true } : { ok: false, problem: "empty vector" };
    } catch (e) {
      return { ok: false, problem: String((e as Error).message ?? e) };
    }
  }
}

export class MultiVectorEmbeddingClient extends BaseClient implements EmbeddingClient<"multivector"> {
  readonly kind = "multivector" as const;
  private seenDims = 0;

  get dims(): number {
    return this.config.dims ?? this.seenDims;
  }

  get key(): string {
    return sha256(JSON.stringify(["multivector", this.model, this.config.dims ?? null, this.config.role ?? "none", this.config.queryPrefix ?? "", this.config.documentPrefix ?? ""])).slice(0, 16);
  }

  async embed(texts: string[], role: "query" | "document", signal?: AbortSignal): Promise<TokenMatrix[]> {
    const out: TokenMatrix[] = [];
    const batch = this.config.batchSize ?? 16; // responses are large
    const pooling = this.config.transport === "pooling";
    for (let i = 0; i < texts.length; i += batch) {
      const { input, extra } = this.applyRole(texts.slice(i, i + batch), role);
      // `dimensions` is never sent for late-interaction models
      const body: Record<string, unknown> = { model: this.model, input, ...(pooling ? {} : { encoding_format: "float" }), ...extra };
      const json = await this.post(body, signal);
      for (const item of this.rows(json, input.length)) {
        // /v1/embeddings returns `embedding`; vLLM's /pooling alias returns `data`
        const m = (item.embedding ?? item.data) as unknown;
        if (!Array.isArray(m) || m.length === 0) throw this.shape("multivector model returned no token rows");
        if (typeof m[0] === "number") throw this.shape('expected a token matrix but got a single vector (set kind: "dense", or serve the model with the token_embed task)');
        const tokens = Array.isArray(item.tokens) && item.tokens.length === m.length ? (item.tokens as unknown[]) : null;
        const rows: Float32Array[] = [];
        for (let r = 0; r < m.length; r++) {
          const row = m[r];
          if (!Array.isArray(row) || typeof row[0] !== "number") throw this.shape(`token row ${r} is not a vector`);
          if (this.config.dims && row.length !== this.config.dims) throw this.shape(`expected token vectors of width ${this.config.dims}, got ${row.length}`);
          if (this.seenDims && row.length !== this.seenDims) throw this.shape(`token vector width changed from ${this.seenDims} to ${row.length}`);
          this.seenDims = row.length;
          // punctuation rows are dropped for documents when the server reports the tokens
          if (role === "document" && tokens && typeof tokens[r] === "string" && PUNCT_ONLY.test(tokens[r] as string)) continue;
          rows.push(l2normalize(Float32Array.from(row as number[])));
        }
        if (rows.length === 0) throw this.shape("every token row was dropped");
        out.push(rows);
      }
    }
    return out;
  }

  async probe(): Promise<{ ok: boolean; problem?: string }> {
    try {
      const [m] = await this.embed(["realctx2 embedding probe"], "document");
      return m && m.length > 0 ? { ok: true } : { ok: false, problem: "empty matrix" };
    } catch (e) {
      return { ok: false, problem: String((e as Error).message ?? e) };
    }
  }
}

export function createEmbeddingClients(
  cfg: { late: EmbeddingProviderConfig | null; dense: EmbeddingProviderConfig | null },
  opts: EmbeddingOptions = {},
): { late: MultiVectorEmbeddingClient | null; dense: DenseEmbeddingClient | null } {
  return {
    late: cfg.late?.url ? new MultiVectorEmbeddingClient({ ...cfg.late, kind: "multivector" }, opts) : null,
    dense: cfg.dense?.url ? new DenseEmbeddingClient({ ...cfg.dense, kind: "dense" }, opts) : null,
  };
}
