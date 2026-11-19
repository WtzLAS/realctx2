import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { type Config, DEFAULT_CONFIG, deepMerge } from "../../src/core/config.ts";
import { type MemoryNode, zeroCounters } from "../../src/core/types.ts";
import { ScopeStore, type StoreOptions } from "../../src/storage/store.ts";
import { Git } from "../../src/util/git.ts";
import { contentHash } from "../../src/util/text.ts";

const made: string[] = [];

export function tmp(prefix = "realctx2-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}

export function cleanupTmp(): void {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
}

export function testConfig(over: unknown = {}): Config {
  return deepMerge(structuredClone(DEFAULT_CONFIG), over);
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  }).trim();
}

export function initRepo(dir = tmp("realctx2-repo-")): string {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "# repo\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

export function commitAll(dir: string, message = "wip"): string {
  git(dir, "add", "-A");
  try {
    git(dir, "commit", "-q", "-m", message);
  } catch {
    // nothing to commit
  }
  return git(dir, "rev-parse", "HEAD");
}

export function write(root: string, rel: string, content: string): string {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

let seq = 0;
export function node(over: Partial<MemoryNode> & { id: string; text?: string }): MemoryNode {
  const text = over.text ?? `memory ${over.id}`;
  const createdAt = over.createdAt ?? new Date(Date.UTC(2026, 10, 1, 0, 0, seq++)).toISOString();
  return {
    layer: "short",
    kind: "fact",
    origin: "harvest",
    anchors: [],
    urgency: "passive",
    urgencyBy: "default",
    title: text.slice(0, 40),
    evidence: [],
    status: "active",
    pinned: false,
    sensitivity: "normal",
    signature: [],
    confidence: 0.5,
    createdAt,
    createdTurn: 0,
    lastAccessAt: createdAt,
    strength: { base: { v: 0.6, t: createdAt }, events: [] },
    counters: zeroCounters(),
    provenance: { actor: "test" },
    contentHash: contentHash(text),
    ...over,
    text,
  };
}

export interface StoreEnv {
  home: string;
  cfg: Config;
}

export function openStore(dir: string, over: Partial<StoreOptions> = {}, env?: StoreEnv): ScopeStore {
  const home = env?.home ?? join(dirname(dir), ".home");
  const scope = over.scope ?? "personal";
  const store = new ScopeStore({
    dir,
    scope,
    storeId: over.storeId ?? "test-store",
    actorId: "actor-test",
    cfg: env?.cfg ?? testConfig(),
    lockFile: join(home, "locks", `${over.storeId ?? "test-store"}.lock`),
    ...over,
  });
  return store.open();
}

export function sharedStore(repo: string, over: Partial<StoreOptions> = {}, env?: StoreEnv): ScopeStore {
  const home = env?.home ?? join(dirname(repo), `.home-${relative(dirname(repo), repo)}`);
  return openStore(join(repo, ".pi", "realctx2"), { scope: "shared", storeId: "shared-test", git: new Git(repo), journalFile: join(home, "pending-shared.loro"), ...over }, { home, cfg: env?.cfg ?? testConfig() });
}

/** The parts of a document that must converge across peers. */
export function stateOf(store: ScopeStore): unknown {
  const j = store.sd.doc.toJSON() as Record<string, unknown>;
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) {
        // tree nodes carry a fractional index that is an ordering detail, not state
        if (k === "fractional_index" || k === "index") continue;
        out[k] = strip((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  const paths = store.sd.pathEntries().map((e) => `${e.path}|${e.data.kind}|${e.data.status}`).sort();
  return strip({ nodes: j.nodes ?? {}, edges: j.edges ?? {}, turns: j.turns ?? 0, sources: j.sources ?? {}, paths });
}

export function listTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

/** True when any file under `dir` contains the bytes of `needle`. */
export function treeContains(dir: string, needle: string): string[] {
  const hits: string[] = [];
  const n = Buffer.from(needle, "utf8");
  for (const f of listTree(dir)) if (readFileSync(join(dir, f)).includes(n)) hits.push(f);
  return hits;
}

/**
 * Merge two "branches" of a store directory the way git does for immutable files:
 * a file added on either side is added, a file deleted on either side is deleted.
 */
export function mergeDirs(base: string, ours: string, theirs: string, out: string): void {
  const b = new Set(listTree(base));
  const o = new Set(listTree(ours));
  const t = new Set(listTree(theirs));
  mkdirSync(out, { recursive: true });
  for (const f of new Set([...o, ...t])) {
    const deleted = (b.has(f) && !o.has(f)) || (b.has(f) && !t.has(f));
    if (deleted) continue;
    const src = o.has(f) ? join(ours, f) : join(theirs, f);
    mkdirSync(dirname(join(out, f)), { recursive: true });
    cpSync(src, join(out, f));
  }
}

export function copyDir(from: string, to: string): string {
  if (existsSync(from)) cpSync(from, to, { recursive: true });
  else mkdirSync(to, { recursive: true });
  return to;
}

export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
