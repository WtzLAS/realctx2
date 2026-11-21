/**
 * Archive and recall (§5.6, §5.4.6): the session file is the archive; oversized tool outputs
 * live in sidecar blobs behind `o:` IDs; `recall` opens one layer of a consolidation.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConsolidationRecord, EntryView } from "../core/types.ts";
import { ensureDir, listFiles, readJson, writeFileAtomic, writeJson } from "../util/fs.ts";
import { stableId8 } from "../util/ids.ts";
import { estimateTokens, headTail, sha256 } from "../util/text.ts";
import { chunkText, rawTurnId } from "../storage/turnindex.ts";
import { renderEntry } from "./render.ts";
import type { SessionState } from "./state.ts";

export const PAGE_TOKENS = 4000;
const BLOB_ID = /^o:[0-9a-z]{8}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/i;

export interface BlobMeta {
  id: string; // "o:…"
  sha: string;
  tokens: number;
  bytes: number;
  tool?: string;
  toolCallId?: string;
  entryId?: string;
  at: string;
}

/** Sidecar store for oversized tool outputs: `sessions/<sid>/blobs/<sha256>`. */
export class BlobStore {
  readonly dir: string | null;
  readonly fallbackDirs: string[];
  private mem = new Map<string, { meta: BlobMeta; text: string }>();

  constructor(dir: string | null, fallbackDirs: string[] = []) {
    this.dir = dir;
    this.fallbackDirs = fallbackDirs.filter((d) => d && d !== dir);
  }

  private readDirs(): string[] {
    return this.dir ? [this.dir, ...this.fallbackDirs] : this.fallbackDirs;
  }

  put(text: string, meta: { tool?: string; toolCallId?: string; at: string }): BlobMeta {
    const sha = sha256(text);
    const id = `o:${stableId8(sha, (s) => s)}`;
    const m: BlobMeta = { id, sha, tokens: estimateTokens(text), bytes: Buffer.byteLength(text), tool: meta.tool, toolCallId: meta.toolCallId, at: meta.at };
    if (this.dir) {
      ensureDir(this.dir);
      if (!existsSync(join(this.dir, sha))) writeFileAtomic(join(this.dir, sha), text);
      writeJson(join(this.dir, `${id.slice(2)}.json`), m);
    } else this.mem.set(id, { meta: m, text });
    return m;
  }

  meta(id: string): BlobMeta | null {
    const key = id.replace(/^\[|\]$/g, "");
    if (!BLOB_ID.test(key)) return null;
    if (!this.dir && !this.fallbackDirs.length) return this.mem.get(key)?.meta ?? null;
    for (const d of this.readDirs()) {
      const m = readJson<BlobMeta | null>(join(d, `${key.slice(2)}.json`), null);
      if (m && typeof m.sha === "string" && SHA256_HEX.test(m.sha)) return m;
    }
    return this.mem.get(key)?.meta ?? null;
  }

  read(id: string): string | null {
    const key = id.replace(/^\[|\]$/g, "");
    if (!BLOB_ID.test(key)) return null;
    if (!this.dir && !this.fallbackDirs.length) return this.mem.get(key)?.text ?? null;
    for (const d of this.readDirs()) {
      const m = readJson<BlobMeta | null>(join(d, `${key.slice(2)}.json`), null);
      if (!m || typeof m.sha !== "string" || !SHA256_HEX.test(m.sha)) continue;
      try {
        return readFileSync(join(d, m.sha), "utf8");
      } catch {
        // continue to fallback dirs
      }
    }
    return this.mem.get(key)?.text ?? null;
  }

  list(): BlobMeta[] {
    if (!this.dir && !this.fallbackDirs.length) return [...this.mem.values()].map((x) => x.meta);
    const seen = new Set<string>();
    const out: BlobMeta[] = [];
    for (const d of this.readDirs()) {
      for (const f of listFiles(d, ".json")) {
        const m = readJson<BlobMeta | null>(join(d, f), null);
        if (m && !seen.has(m.id)) {
          seen.add(m.id);
          out.push(m);
        }
      }
    }
    return out;
  }
}

/**
 * Oversized tool-result guard (§5.4.6): keep the head and tail in context and page the rest
 * through `recall`.
 */
export function guardToolResult(text: string, maxTokens: number, blobs: BlobStore, meta: { tool?: string; toolCallId?: string; at: string }): { text: string; blob: BlobMeta } | null {
  const tokens = estimateTokens(text);
  if (tokens <= maxTokens) return null;
  const blob = blobs.put(text, meta);
  const keep = Math.max(200, Math.floor(maxTokens / 4));
  const body = headTail(text, keep, keep, (omitted) => `\n[… ${omitted} tokens of this output are stored as [${blob.id}]; recall("${blob.id}") pages through it …]\n`);
  return { text: `${body}\n[${blob.id} · full output: ${tokens} tokens · recall("${blob.id}", page) opens it]`, blob };
}

/** Split text into pages of at most `pageTokens`, on line boundaries where possible (CJK-aware). */
export function paginate(text: string, pageTokens = PAGE_TOKENS): string[] {
  return chunkText(text, pageTokens);
}

/** Pick the page that best matches `lookingFor` (most term hits), else the requested page. */
export function pickPage(pages: string[], page: number | undefined, lookingFor: string | undefined): number {
  if (page && page >= 1) return Math.min(pages.length, page);
  if (lookingFor && pages.length > 1) {
    const terms = lookingFor.toLowerCase().split(/[^\p{L}\p{N}_.-]+/u).filter((t) => t.length > 2);
    let best = 0;
    let bestScore = -1;
    pages.forEach((p, i) => {
      const lower = p.toLowerCase();
      const score = terms.reduce((s, t) => s + (lower.includes(t) ? 1 : 0), 0);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    });
    return best + 1;
  }
  return 1;
}

/**
 * One layer of a consolidation (Hippocam's RECALL): raw entries rendered compactly with their
 * `r:` IDs, nested consolidations as their consolidated text with their own `t:` IDs.
 */
export function renderLayer(record: ConsolidationRecord, state: SessionState, entries: Map<string, EntryView>, sessionId: string): string {
  const parts: string[] = [];
  for (const child of record.children) {
    if ("id" in child) {
      const nested = state.records.get(child.id);
      parts.push(nested?.text ?? `[${child.id}] (consolidated turns; not available on this branch)`);
      continue;
    }
    const e = entries.get(child.entryId);
    if (!e) {
      parts.push(`[${rawTurnId(sessionId, child.entryId)}] (entry not found in the session file)`);
      continue;
    }
    parts.push(`[${rawTurnId(sessionId, child.entryId)}] ${renderEntry(e, { raw: true, toolOutputTokens: 600 })}`);
  }
  return parts.join("\n\n");
}

/** Every raw entry reachable from a record, through nested consolidations (the recall round trip, §12.1). */
export function reachableEntries(record: ConsolidationRecord, state: SessionState, seen = new Set<string>()): string[] {
  if (seen.has(record.id)) return [];
  seen.add(record.id);
  const out: string[] = [];
  for (const child of record.children) {
    if ("entryId" in child) out.push(child.entryId);
    else {
      const nested = state.records.get(child.id);
      if (nested) out.push(...reachableEntries(nested, state, seen));
    }
  }
  return out;
}
