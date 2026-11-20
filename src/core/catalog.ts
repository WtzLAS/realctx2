/**
 * Model catalog metadata lookup backed by `@earendil-works/pi-ai`'s built-in catalog.
 *
 * `@earendil-works/pi-ai` is an optional peer dependency (absent in standalone Claude Code
 * installs), so loading is lazy and degrades cleanly when unavailable.
 */
import { createRequire } from "node:module";

interface CatalogEntry {
  id: string;
  provider?: string;
  contextWindow?: number;
}

interface CatalogModule {
  getBuiltinProviders?: () => string[];
  getBuiltinModels?: (provider: string) => CatalogEntry[];
}

interface CatalogIndex {
  byProvider: Map<string, Map<string, number>>;
  byId: Map<string, number>;
}

let cached: CatalogIndex | null = null;
let loadTriedSync = false;
let loadPromise: Promise<CatalogIndex | null> | null = null;

function buildIndex(mod: CatalogModule): CatalogIndex {
  const byProvider = new Map<string, Map<string, number>>();
  const byId = new Map<string, number>();
  const providers = mod.getBuiltinProviders?.() ?? [];
  // Prefer canonical direct providers first so bare ID lookups match them over proxy aggregators.
  const ordered = [
    ...providers.filter((p) => p === "anthropic" || p === "openai" || p === "google"),
    ...providers.filter((p) => p !== "anthropic" && p !== "openai" && p !== "google"),
  ];
  for (const provider of ordered) {
    let models: CatalogEntry[] = [];
    try {
      models = mod.getBuiltinModels?.(provider) ?? [];
    } catch {
      continue;
    }
    let map = byProvider.get(provider);
    if (!map) {
      map = new Map();
      byProvider.set(provider, map);
    }
    for (const m of models) {
      if (!m?.id || typeof m.contextWindow !== "number" || m.contextWindow <= 0) continue;
      map.set(m.id, m.contextWindow);
      if (!byId.has(m.id)) byId.set(m.id, m.contextWindow);
    }
  }
  return { byProvider, byId };
}

function tryLoadSync(): CatalogIndex | null {
  if (cached) return cached;
  if (loadTriedSync) return null;
  loadTriedSync = true;
  try {
    const req = createRequire(import.meta.url);
    const mod = req("@earendil-works/pi-ai/providers/all") as CatalogModule;
    cached = buildIndex(mod);
    return cached;
  } catch {
    return null;
  }
}

/** Pre-load the `@earendil-works/pi-ai` built-in model catalog asynchronously (no-op if absent). */
export async function warmModelCatalog(): Promise<void> {
  if (cached) return;
  loadPromise ??= import("@earendil-works/pi-ai/providers/all")
    .then((mod) => {
      cached = buildIndex(mod as unknown as CatalogModule);
      return cached;
    })
    .catch(() => null);
  await loadPromise;
}

function lookupInMap(map: Map<string, number> | undefined, id: string): number {
  if (!map || !id) return 0;
  const exact = map.get(id);
  if (exact) return exact;
  // Strip bracket tags like `[1m]` and retry.
  const stripped = id.replace(/\[[^\]]+\]$/, "").trim();
  if (stripped && stripped !== id) {
    const hit = map.get(stripped);
    if (hit) return hit;
  }
  // Match dated snapshots (e.g. `claude-sonnet-4-6-20260101` -> `claude-sonnet-4-6`).
  const undate = stripped.replace(/-\d{8}$/, "");
  if (undate && undate !== stripped) {
    const hit = map.get(undate);
    if (hit) return hit;
  }
  return 0;
}

/**
 * Resolve a model's `contextWindow` from the model catalog metadata, or `0` when unknown.
 * Accepts optional `provider` (e.g. `"anthropic"`, `"openai"`) and `provider/id` forms.
 */
export function catalogContextWindow(modelId: string | undefined, provider?: string): number {
  if (!modelId) return 0;
  const raw = modelId.trim();
  if (!raw) return 0;
  let prov = provider?.trim();
  let id = raw;
  if (!prov && raw.includes("/")) {
    const slash = raw.indexOf("/");
    prov = raw.slice(0, slash);
    id = raw.slice(slash + 1);
  }
  const index = cached ?? tryLoadSync();
  if (!index) return 0;
  if (prov) {
    const hit = lookupInMap(index.byProvider.get(prov), id);
    if (hit > 0) return hit;
  }
  // If id looks like a Claude model without provider, try anthropic first.
  if (!prov && /^claude[-_]/i.test(id)) {
    const hit = lookupInMap(index.byProvider.get("anthropic"), id);
    if (hit > 0) return hit;
  }
  return lookupInMap(index.byId, id);
}
