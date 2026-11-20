/**
 * Live endpoint tester for `/realctx2 settings`: verifies connectivity, Bearer authentication
 * (including apiKey / apiKeyEnv / apiKeyFile / custom headers), model ID, and response shape
 * against the currently configured endpoint settings.
 */
import {
  type ApiKeyInfo,
  type ApiKeyProviderFields,
  buildAuthHeaders,
  type Config,
  type DecisionProviderConfig,
  type EmbeddingProviderConfig,
  resolveApiKeyInfo,
} from "../core/config.ts";
import { type FetchLike, HttpDecisionClient } from "./decision.ts";
import { DenseEmbeddingClient, MultiVectorEmbeddingClient } from "./embedding.ts";

export type EndpointKind = "decision" | "late" | "dense";

export interface EndpointTestResult {
  endpoint: EndpointKind;
  ok: boolean;
  latencyMs: number;
  /** Compact single-line summary shown next to the Test button. */
  summary: string;
  /** Detailed diagnostic message shown in the description panel (never contains raw secrets). */
  detail: string;
  /** Human-readable auth source description (masked). */
  authSummary: string;
  status?: number;
  availableModels?: string[];
}

export type EndpointFetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export interface EndpointTestOptions {
  fetch?: EndpointFetchLike | FetchLike;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function maskToken(value: string | undefined): string {
  if (!value) return "(not set)";
  if (value.length <= 4) return "••••";
  return `••••${value.slice(-4)}`;
}

export function describeEndpointAuth(ep: ApiKeyProviderFields | null | undefined): { summary: string; info: ApiKeyInfo } {
  const info = resolveApiKeyInfo(ep);
  if (info.source === "literal") return { summary: `Bearer (${maskToken(info.key)})`, info };
  if (info.source === "env") return { summary: `Bearer via $${info.envVar}`, info };
  if (info.source === "file") return { summary: `Bearer via file (${info.filePath})`, info };
  if (info.source === "header") return { summary: "custom Authorization header", info };
  return { summary: info.warning ? `none (${info.warning})` : "none", info };
}

function parseHttpStatus(message: string): number | undefined {
  const m = /\bhttp\s+(\d{3})\b/i.exec(message);
  return m ? Number(m[1]) : undefined;
}

function validateUrl(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return "Set Endpoint URL before testing.";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return `Invalid Endpoint URL: "${trimmed}" (expected http:// or https://).`;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `Unsupported URL scheme "${parsed.protocol}" (expected http:// or https://).`;
  }
  return null;
}

function modelsUrlFor(endpointUrl: string): string | null {
  try {
    const u = new URL(endpointUrl);
    const v1Idx = u.pathname.indexOf("/v1/");
    if (v1Idx >= 0) {
      u.pathname = `${u.pathname.slice(0, v1Idx)}/v1/models`;
    } else {
      u.pathname = "/v1/models";
    }
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

async function discoverModels(
  endpointUrl: string,
  authFields: ApiKeyProviderFields,
  fetchImpl: EndpointFetchLike,
  signal?: AbortSignal,
): Promise<string[] | undefined> {
  const url = modelsUrlFor(endpointUrl);
  if (!url) return undefined;
  try {
    const timeout = AbortSignal.timeout(3000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const headers = buildAuthHeaders(authFields, {});
    const res = await fetchImpl(url, { method: "GET", headers, signal: combined });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { data?: unknown };
    if (!Array.isArray(body?.data)) return undefined;
    const ids = body.data
      .map((item) => (item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string" ? (item as { id: string }).id : null))
      .filter((id): id is string => Boolean(id));
    return ids.length ? [...new Set(ids)] : undefined;
  } catch {
    return undefined;
  }
}

function authFailureHint(endpoint: EndpointKind, authSummary: string, info: ApiKeyInfo): string {
  const exampleEnv = endpoint === "decision" ? "DECIDER_API_KEY" : endpoint === "late" ? "EMBED_API_KEY" : "OPENAI_API_KEY";
  if (info.warning) {
    return `${info.warning}. Check your secret configuration or set API key (literal) / API key file.`;
  }
  if (info.source === "none") {
    return `This endpoint requires authentication. Set API key env var (e.g. ${exampleEnv}), API key (literal), or API key file.`;
  }
  return `Verify the configured secret (${authSummary}) matches the server's Bearer key.`;
}

function shortErrorSummary(status: number | undefined, rawMessage: string): string {
  if (status === 401) return "401 Unauthorized (secret required/invalid)";
  if (status === 403) return "403 Forbidden (check secret)";
  if (status === 404) return "404 Not Found (check URL or model ID)";
  if (status) return `HTTP ${status}`;
  const clean = rawMessage.replace(/^embedding request failed:\s*/i, "").trim();
  if (/timeout/i.test(clean)) return "Timed out";
  if (/aborted/i.test(clean)) return "Cancelled";
  return clean.length > 48 ? `${clean.slice(0, 45)}…` : clean || "Request failed";
}

export async function testDecisionEndpoint(
  cfg: DecisionProviderConfig | null,
  opts: EndpointTestOptions = {},
): Promise<EndpointTestResult> {
  const { summary: authSummary, info } = describeEndpointAuth(cfg);
  if (!cfg) {
    return {
      endpoint: "decision",
      ok: false,
      latencyMs: 0,
      summary: "Disabled",
      detail: "Decision endpoint is disabled. Enable it before testing.",
      authSummary,
    };
  }
  const urlErr = validateUrl(cfg.url);
  if (urlErr) {
    return { endpoint: "decision", ok: false, latencyMs: 0, summary: "Missing/invalid URL", detail: urlErr, authSummary };
  }
  if (!cfg.model?.trim()) {
    return {
      endpoint: "decision",
      ok: false,
      latencyMs: 0,
      summary: "Missing model ID",
      detail: 'Set Model ID before testing (for example "pplx-decider-v1.3" or "jev-latest").',
      authSummary,
    };
  }

  const fetchImpl = (opts.fetch ?? globalThis.fetch) as unknown as EndpointFetchLike;
  const client = new HttpDecisionClient(cfg, { fetch: fetchImpl as FetchLike });
  const started = Date.now();
  try {
    const answers = await client.decide(
      "realctx2 endpoint probe: the sky is blue.",
      [{ kind: "binary", name: "probe", instructions: "Does the text mention a color?" }],
      { callSite: "settings.test", timeoutMs: opts.timeoutMs ?? 10_000, noRetry: true, signal: opts.signal },
    );
    const latencyMs = Date.now() - started;
    const p = answers.probe?.p;
    if (typeof p !== "number" || !Number.isFinite(p)) {
      return {
        endpoint: "decision",
        ok: false,
        latencyMs,
        summary: "Unexpected response shape",
        detail: `Endpoint responded (${latencyMs}ms) but returned no probability for the probe question. Check wire format ("${cfg.format}") and URL.`,
        authSummary,
      };
    }
    const warnNote = info.warning ? ` Note: ${info.warning}, but the server accepted the request.` : "";
    return {
      endpoint: "decision",
      ok: true,
      latencyMs,
      summary: `OK · ${latencyMs}ms (p=${p.toFixed(2)})`,
      detail: `Decision endpoint (${cfg.format}, model "${cfg.model}") answered probe with p=${p.toFixed(2)} in ${latencyMs}ms. Auth: ${authSummary}.${warnNote}`,
      authSummary,
    };
  } catch (e) {
    const latencyMs = Date.now() - started;
    const message = String((e as Error).message ?? e);
    const status = parseHttpStatus(message);
    const parts = [`Probe failed after ${latencyMs}ms: ${message}.`, `Auth: ${authSummary}.`];
    let availableModels: string[] | undefined;
    if (status === 401 || status === 403) {
      parts.push(authFailureHint("decision", authSummary, info));
    } else if (status === 404) {
      availableModels = await discoverModels(cfg.url, cfg, fetchImpl, opts.signal);
      if (availableModels?.length) {
        parts.push(`Served models: ${availableModels.join(", ")}.`);
      }
    }
    return {
      endpoint: "decision",
      ok: false,
      latencyMs,
      status,
      availableModels,
      summary: shortErrorSummary(status, message),
      detail: parts.join(" "),
      authSummary,
    };
  }
}

export async function testEmbeddingEndpoint(
  kind: "late" | "dense",
  cfg: EmbeddingProviderConfig | null,
  opts: EndpointTestOptions = {},
): Promise<EndpointTestResult> {
  const { summary: authSummary, info } = describeEndpointAuth(cfg);
  const label = kind === "late" ? "Late-interaction embedding" : "Dense embedding";
  if (!cfg) {
    return {
      endpoint: kind,
      ok: false,
      latencyMs: 0,
      summary: "Disabled",
      detail: `${label} endpoint is disabled. Enable it before testing.`,
      authSummary,
    };
  }
  const urlErr = validateUrl(cfg.url);
  if (urlErr) {
    return { endpoint: kind, ok: false, latencyMs: 0, summary: "Missing/invalid URL", detail: urlErr, authSummary };
  }
  if (!cfg.model?.trim()) {
    return {
      endpoint: kind,
      ok: false,
      latencyMs: 0,
      summary: "Missing model ID",
      detail:
        kind === "late"
          ? 'Set Model ID before testing (for example "perplexity-ai/pplx-embed-v2-late-9b").'
          : 'Set Model ID before testing (for example "text-embedding-3-small").',
      authSummary,
    };
  }

  const fetchImpl = (opts.fetch ?? globalThis.fetch) as unknown as EndpointFetchLike;
  const clientOpts = { fetch: fetchImpl as FetchLike, timeoutMs: opts.timeoutMs ?? 10_000, retries: 0 };
  const started = Date.now();
  try {
    if (kind === "late") {
      const client = new MultiVectorEmbeddingClient({ ...cfg, kind: "multivector" }, clientOpts);
      const [matrix] = await client.embed(["realctx2 embedding probe"], "document", opts.signal);
      const latencyMs = Date.now() - started;
      const tokens = matrix?.length ?? 0;
      const dims = matrix?.[0]?.length ?? 0;
      if (!tokens || !dims) {
        return {
          endpoint: "late",
          ok: false,
          latencyMs,
          summary: "Empty matrix",
          detail: `Endpoint responded (${latencyMs}ms) with an empty token matrix.`,
          authSummary,
        };
      }
      const warnNote = info.warning ? ` Note: ${info.warning}, but the server accepted the request.` : "";
      return {
        endpoint: "late",
        ok: true,
        latencyMs,
        summary: `OK · ${latencyMs}ms (${tokens}×${dims})`,
        detail: `Late-interaction endpoint (${cfg.transport ?? "embeddings"}, model "${cfg.model}", role "${cfg.role ?? "none"}") returned ${tokens} token vectors × ${dims} dims in ${latencyMs}ms. Auth: ${authSummary}.${warnNote}`,
        authSummary,
      };
    } else {
      const client = new DenseEmbeddingClient({ ...cfg, kind: "dense" }, clientOpts);
      const [vec] = await client.embed(["realctx2 embedding probe"], "document", opts.signal);
      const latencyMs = Date.now() - started;
      const dims = vec?.length ?? 0;
      if (!dims) {
        return {
          endpoint: "dense",
          ok: false,
          latencyMs,
          summary: "Empty vector",
          detail: `Endpoint responded (${latencyMs}ms) with an empty embedding vector.`,
          authSummary,
        };
      }
      const warnNote = info.warning ? ` Note: ${info.warning}, but the server accepted the request.` : "";
      return {
        endpoint: "dense",
        ok: true,
        latencyMs,
        summary: `OK · ${latencyMs}ms (${dims} dims)`,
        detail: `Dense embedding endpoint (model "${cfg.model}", role "${cfg.role ?? "none"}") returned a ${dims}-dim vector in ${latencyMs}ms. Auth: ${authSummary}.${warnNote}`,
        authSummary,
      };
    }
  } catch (e) {
    const latencyMs = Date.now() - started;
    const message = String((e as Error).message ?? e);
    const status = parseHttpStatus(message);
    const parts = [`Probe failed after ${latencyMs}ms: ${message}.`, `Auth: ${authSummary}.`];
    let availableModels: string[] | undefined;
    if (status === 401 || status === 403) {
      parts.push(authFailureHint(kind, authSummary, info));
    } else if (status === 404) {
      availableModels = await discoverModels(cfg.url, cfg, fetchImpl, opts.signal);
      if (availableModels?.length) {
        parts.push(`Served models: ${availableModels.join(", ")}.`);
      }
    }
    return {
      endpoint: kind,
      ok: false,
      latencyMs,
      status,
      availableModels,
      summary: shortErrorSummary(status, message),
      detail: parts.join(" "),
      authSummary,
    };
  }
}

export function testEndpoint(kind: EndpointKind, cfg: Config, opts: EndpointTestOptions = {}): Promise<EndpointTestResult> {
  if (kind === "decision") return testDecisionEndpoint(cfg.providers.decision, opts);
  return testEmbeddingEndpoint(kind, cfg.providers.embedding[kind], opts);
}
