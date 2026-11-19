/**
 * Re-verification (§6.8.6): when an anchored file changes, check the memories about it —
 * first without a model (quotes and symbols still there), then with one read-only aux session
 * per file for the rest.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryNode, ScopedNode, ScopeName } from "../core/types.ts";
import { binaryP } from "../providers/decision.ts";
import { appendJsonl, readJsonl, writeFileAtomic } from "../util/fs.ts";
import { blobHash, runSync } from "../util/git.ts";
import { clipTokens, normalizeForMatch, sanitize, verifyQuote } from "../util/text.ts";
import type { Lifecycle } from "./lifecycle.ts";
import { declaresSymbol } from "./paths.ts";
import { type MemoryServices, TIMEOUTS } from "./services.ts";
import { memoryWorth } from "./strength.ts";
import type { MemoryWriter } from "./write.ts";

export type Verdict = "holds" | "changed" | "obsolete" | "unclear";

export interface ReviewItem {
  at: string;
  scope: ScopeName;
  id: string;
  kind: "rule-change" | "rule-obsolete" | "conflict" | "proposal";
  suggestion?: { title?: string; text: string };
  evidence?: Array<{ path: string; lines?: string; quote: string }>;
  note?: string;
}

export interface ReverifyReport {
  files: number;
  holdsModelFree: string[];
  holds: string[];
  changed: Array<{ id: string; replacement: string }>;
  obsolete: string[];
  unclear: string[];
  review: string[];
  waiting: string[];
  auxSessions: number;
}

interface Group {
  scope: ScopeName;
  path: string;
  content: string | null;
  blob: string | null;
  members: MemoryNode[];
}

const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdicts"],
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "verdict"],
        properties: {
          id: { type: "string" },
          verdict: { type: "string", enum: ["holds", "changed", "obsolete", "unclear"] },
          evidence: { type: "array", items: { type: "object", additionalProperties: false, required: ["path", "quote"], properties: { path: { type: "string" }, lines: { type: "string" }, quote: { type: "string" } } } },
          replacement: { type: "object", additionalProperties: false, required: ["text"], properties: { title: { type: "string" }, text: { type: "string" } } },
        },
      },
    },
  },
};

/** Identifier-like tokens of a signature (symbols that should still exist in the file). */
function symbolsOf(node: MemoryNode): string[] {
  return node.signature.filter((s) => /^[A-Za-z_$][\w$]*(?:[.#:]{1,2}[A-Za-z_$][\w$]*)*(?:\(\))?$/.test(s) && /[A-Z_.]/.test(s.slice(1)) && !s.includes("/")).map((s) => s.replace(/\(\)$/, ""));
}

/** True when two texts differ only in path-, command- or identifier-like tokens (a mechanical change). */
export function mechanicalChange(before: string, after: string): boolean {
  const mask = (t: string) =>
    normalizeForMatch(
      t
        .replace(/`[^`\n]+`/g, " ⟨x⟩ ")
        .replace(/(?:\.{0,2}\/)?(?:[\w.@+-]+\/)+[\w.@+-]+/g, " ⟨x⟩ ")
        .replace(/\b[\w-]+\.[A-Za-z0-9]{1,6}\b/g, " ⟨x⟩ ")
        .replace(/\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+\b|\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b|\b[a-z0-9]+_[a-z0-9_]+\b/g, " ⟨x⟩ "),
    );
  const a = mask(before);
  const b = mask(after);
  return a === b && a.includes("⟨x⟩") && normalizeForMatch(before) !== normalizeForMatch(after);
}

/** Unified diff of two texts through `git diff --no-index` (the new content need not be in git). */
export function diffText(before: string, after: string, label: string): string {
  if (before === after) return "";
  const dir = mkdtempSync(join(tmpdir(), "realctx2-diff-"));
  try {
    writeFileSync(join(dir, "before"), before);
    writeFileSync(join(dir, "after"), after);
    const r = runSync("git", ["diff", "--no-index", "--no-color", "--unified=3", "before", "after"], dir, 10_000);
    // exit code 1 means "differences found"
    if (r.code > 1 || !r.stdout) return "";
    return r.stdout.split("\n").filter((l) => !/^(diff --git|index |--- |\+\+\+ )/.test(l)).join("\n").replace(/^/, `--- ${label} (verified)\n+++ ${label} (current)\n`);
  } catch {
    return "";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export class ReviewQueue {
  private readonly file: string | null;
  constructor(queueDir: string | null) {
    this.file = queueDir ? join(queueDir, "review.jsonl") : null;
  }
  add(item: ReviewItem): void {
    if (this.file) appendJsonl(this.file, item);
  }
  list(): ReviewItem[] {
    return this.file ? readJsonl<ReviewItem>(this.file) : [];
  }
  remove(id: string): void {
    if (!this.file) return;
    const rest = this.list().filter((r) => r.id !== id);
    writeFileAtomic(this.file, rest.map((r) => JSON.stringify(r)).join("\n") + (rest.length ? "\n" : ""));
  }
}

export class Reverifier {
  private readonly s: MemoryServices;
  private readonly writer: MemoryWriter;
  private readonly lifecycle: Lifecycle;
  readonly review: ReviewQueue;
  /** blob per memory for which a model check already ended `unclear`: retried only after the file changes again. */
  private tried = new Map<string, string>();
  private doneToday = { day: "", n: 0 };

  constructor(s: MemoryServices, deps: { writer: MemoryWriter; lifecycle: Lifecycle; review: ReviewQueue }) {
    this.s = s;
    this.writer = deps.writer;
    this.lifecycle = deps.lifecycle;
    this.review = deps.review;
  }

  private readFor(scope: ScopeName, path: string): { content: string | null; blob: string | null; wait: boolean } {
    const git = this.s.graph.project.git?.isRepo() ? this.s.graph.project.git : null;
    // shared memories are checked against committed code, so discarded work never rewrites team memory
    if (scope === "shared" && git && this.s.cfg.reverify.sharedAgainst === "HEAD") {
      if (git.differsFromHead(path)) return { content: null, blob: null, wait: true };
      const bytes = git.showBytes("HEAD", path);
      return bytes ? { content: bytes.toString("utf8"), blob: blobHash(bytes), wait: false } : { content: null, blob: null, wait: false };
    }
    const blob = this.s.paths.blobOf(path);
    if (!blob) return { content: null, blob: null, wait: false };
    try {
      return { content: readFileSync(this.s.paths.abs(path), "utf8"), blob, wait: false };
    } catch {
      return { content: null, blob: null, wait: false };
    }
  }

  /**
   * Memories that need a check, grouped by file:
   * a `file` or `symbol` anchor whose file changed since the memory was last verified, or a
   * memory flagged because a path in its signature moved or vanished.
   */
  pending(opts: { sessionEnding?: boolean } = {}): { groups: Group[]; waiting: string[] } {
    const g = this.s.graph;
    const settleMs = this.s.cfg.reverify.settleMinutes * 60_000;
    const now = this.s.clock().getTime();
    const groups = new Map<string, Group>();
    const waiting: string[] = [];
    const add = (scope: ScopeName, path: string, node: MemoryNode) => {
      const key = `${scope}\u0000${path}`;
      let grp = groups.get(key);
      if (!grp) {
        // settling: a burst of edits costs one check, not one per edit
        if (!opts.sessionEnding) {
          try {
            if (now - statSync(this.s.paths.abs(path)).mtimeMs < settleMs) {
              waiting.push(path);
              return;
            }
          } catch {
            // a file that is gone is checked right away
          }
        }
        const read = this.readFor(scope, path);
        if (read.wait) {
          waiting.push(path);
          return;
        }
        grp = { scope, path, content: read.content, blob: read.blob, members: [] };
        groups.set(key, grp);
      }
      if (!grp.members.some((m) => m.id === node.id)) grp.members.push(node);
    };
    for (const scope of g.visible()) {
      if (scope === "global" || !g.writable(scope)) continue;
      const sd = g.sd(scope);
      for (const node of sd.allNodes()) {
        // superseded memories are history: only current truth is re-verified
        if (node.status !== "active" || node.validTo) continue;
        let queued = false;
        for (const a of node.anchors) {
          if ((a.kind !== "file" && a.kind !== "symbol") || a.status !== "live" || !a.pathId) continue;
          const entry = sd.pathEntry(a.pathId);
          if (!entry || entry.data.status !== "live") continue;
          const current = scope === "shared" && this.s.cfg.reverify.sharedAgainst === "HEAD" ? null : entry.data.blob;
          const changed = a.seenBlob ? (current ? current !== a.seenBlob : this.s.paths.blobOf(entry.path) !== a.seenBlob) : false;
          if (!changed && !node.flags?.includes("reverify")) continue;
          if (this.tried.get(`${scope}:${node.id}`) === (entry.data.blob ?? "")) continue;
          add(scope, entry.path, node);
          queued = true;
        }
        if (!queued && node.flags?.includes("reverify")) {
          // a path in the signature moved or vanished: check against the first path that still exists
          const path = node.signature.map((t) => this.s.paths.rel(t, this.s.graph.project.root ?? undefined)).find((rel): rel is string => !!rel && this.s.paths.exists(rel) && !this.s.paths.isDir(rel));
          if (path) add(scope, path, node);
          else if (this.tried.get(`${scope}:${node.id}`) !== "moved") add(scope, "", node);
        }
      }
    }
    // files whose memories are used most go first
    const weight = (grp: Group) => grp.members.reduce((s, m) => s + memoryWorth(m.counters).mw + Math.log1p(m.counters.retrieved), 0);
    return { groups: [...groups.values()].filter((x) => x.members.length).sort((a, b) => weight(b) - weight(a)), waiting: [...new Set(waiting)] };
  }

  /** The check without a model: every evidence quote is still in the file and every symbol still exists. */
  holdsModelFree(grp: Group, node: MemoryNode): boolean {
    if (!grp.content) return false;
    const git = this.s.graph.project.git?.isRepo() ? this.s.graph.project.git : null;
    const anchor = node.anchors.find((a) => (a.kind === "file" || a.kind === "symbol") && a.seenBlob);
    let old: string | null = null;
    if (git && anchor?.seenBlob) {
      const r = git.git(["cat-file", "-p", anchor.seenBlob]);
      if (r.code === 0) old = r.stdout;
    }
    // only quotes that came from this file can be checked against it
    const fileQuotes = node.evidence.filter((e) => (old !== null ? verifyQuote(e.quote, old) : e.source.type === "file" || e.source.ref.includes(grp.path)));
    const symbols = symbolsOf(node).filter((s) => (old !== null ? new RegExp(`\\b${s.split(/[.#:]+/).pop()!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(old) : true));
    const anchored = node.anchors.filter((a) => a.kind === "symbol" && a.symbol).map((a) => a.symbol!);
    if (!fileQuotes.length && !symbols.length && !anchored.length) return false;
    if (!fileQuotes.every((e) => verifyQuote(e.quote, grp.content!))) return false;
    for (const s of anchored) if (!declaresSymbol(grp.content, s)) return false;
    for (const s of symbols) {
      const last = s.split(/[.#:]+/).pop()!;
      if (!new RegExp(`\\b${last.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(grp.content)) return false;
    }
    return true;
  }

  private markHolds(scope: ScopeName, node: MemoryNode, grp: Group): void {
    const sd = this.s.graph.sd(scope);
    const nowIso = this.s.clock().toISOString();
    for (const a of node.anchors) {
      if ((a.kind !== "file" && a.kind !== "symbol") || !a.pathId) continue;
      if (sd.pathOf(a.pathId) === grp.path && grp.blob && a.seenBlob !== grp.blob) sd.setAnchor(node.id, { ...a, seenBlob: grp.blob });
    }
    sd.patchNode(node.id, { verifiedAt: nowIso, flags: (node.flags ?? []).filter((f) => f !== "reverify") }, "substantive");
  }

  private underDailyLimit(): boolean {
    const max = this.s.cfg.reverify.maxPerDay;
    if (max === null) return true;
    const day = this.s.clock().toISOString().slice(0, 10);
    if (this.doneToday.day !== day) this.doneToday = { day, n: 0 };
    return this.doneToday.n < max;
  }

  /** Run the checks that are due. Aborts cleanly on `signal`; an aborted file is retried later. */
  async run(opts: { signal?: AbortSignal; sessionEnding?: boolean; maxFiles?: number; modelFreeOnly?: boolean } = {}): Promise<ReverifyReport> {
    const report: ReverifyReport = { files: 0, holdsModelFree: [], holds: [], changed: [], obsolete: [], unclear: [], review: [], waiting: [], auxSessions: 0 };
    if (!this.s.cfg.reverify.enabled) return report;
    const g = this.s.graph;
    const { groups, waiting } = this.pending({ sessionEnding: opts.sessionEnding });
    report.waiting = waiting;
    const touched = new Set<ScopeName>();
    for (const grp of groups.slice(0, opts.maxFiles ?? 20)) {
      if (opts.signal?.aborted) break;
      report.files++;
      const rest: MemoryNode[] = [];
      for (const node of grp.members) {
        if (this.holdsModelFree(grp, node)) {
          this.markHolds(grp.scope, node, grp);
          report.holdsModelFree.push(node.id);
          touched.add(grp.scope);
        } else rest.push(node);
      }
      if (!rest.length || opts.modelFreeOnly || !this.s.aux?.available() || !this.underDailyLimit()) continue;
      // one aux session checks the remaining memories of this file together
      const git = g.project.git?.isRepo() ? g.project.git : null;
      const seen = rest.map((n) => n.anchors.find((a) => a.seenBlob)?.seenBlob).find(Boolean);
      let diff = "";
      if (git && seen && grp.content !== null && grp.path) {
        const old = git.git(["cat-file", "-p", seen]);
        if (old.code === 0) diff = clipTokens(diffText(old.stdout, grp.content, grp.path), 3000);
      }
      this.doneToday.n++;
      report.auxSessions++;
      const res = await this.s.aux.run<{ verdicts: Array<{ id: string; verdict: Verdict; evidence?: Array<{ path: string; lines?: string; quote: string }>; replacement?: { title?: string; text: string } }> }>({
        role: "reverify",
        instructions: `Check whether each memory still holds for the code as it is now${grp.scope === "shared" ? " (the committed version)" : ""}. The file ${grp.path || "(a path named in the memory moved or was deleted)"} changed since the memories were written. Use your tools to read the code. For each memory return a verdict: "holds" (still true), "changed" (true in a different form: give a replacement that states the current truth), "obsolete" (no longer true and nothing replaces it), or "unclear". Quote the lines you rely on as evidence, with their path.`,
        data: [
          ...rest.map((n) => ({ label: `MEMORY ${n.id}`, text: `${n.kind}${n.severity ? ` (${n.severity})` : ""} · as of ${(n.validFrom ?? n.createdAt).slice(0, 10)}\n${n.text}\n${n.evidence.map((e) => `evidence: "${e.quote}" — ${e.source.ref}`).join("\n")}` })),
          ...(diff ? [{ label: `DIFF of ${grp.path} since the verified version`, text: diff }] : []),
          ...(grp.content ? [{ label: `CURRENT ${grp.path}`, text: clipTokens(grp.content, 6000) }] : []),
        ],
        schema: VERDICT_SCHEMA,
        signal: opts.signal,
      });
      if (opts.signal?.aborted) break;
      const verdicts = new Map((res.output?.verdicts ?? []).filter((v) => v && typeof v.id === "string").map((v) => [v.id.replace(/^\[?m:/, "").replace(/\]$/, ""), v]));
      for (const node of rest) {
        const v = verdicts.get(node.id);
        const ref: ScopedNode = { scope: grp.scope, node };
        const evidence = (v?.evidence ?? []).filter((e) => e && typeof e.quote === "string" && e.quote.trim()).map((e) => ({ path: String(e.path ?? grp.path), lines: e.lines, quote: sanitize(e.quote) }));
        // quotes in the evidence are verified against the files
        const backed = evidence.filter((e) => {
          const rel = this.s.paths.rel(e.path, g.project.root ?? undefined);
          const content = rel === grp.path ? grp.content : rel ? this.readFor(grp.scope, rel).content : null;
          return !!content && verifyQuote(e.quote, content);
        });
        if (!v || v.verdict === "unclear" || (v.verdict !== "holds" && !backed.length)) {
          // keep the flag, and try again after the file next changes
          this.tried.set(`${grp.scope}:${node.id}`, grp.path ? (grp.blob ?? "") : "moved");
          report.unclear.push(node.id);
          continue;
        }
        touched.add(grp.scope);
        if (v.verdict === "holds") {
          this.markHolds(grp.scope, node, grp);
          report.holds.push(node.id);
          continue;
        }
        const isRule = node.kind === "rule";
        const mode = this.s.cfg.reverify.rules;
        if (v.verdict === "obsolete") {
          if (isRule && mode !== "auto") {
            this.queueReview(ref, { kind: "rule-obsolete", evidence: backed });
            report.review.push(node.id);
          } else {
            // reversible: retired, with the evidence as the reason
            this.lifecycle.forget(ref, `obsolete per ${backed[0]!.path}: "${backed[0]!.quote.slice(0, 120)}"`);
            report.obsolete.push(node.id);
          }
          continue;
        }
        const replacement = v.replacement?.text ? { title: v.replacement.title, text: sanitize(v.replacement.text.trim()) } : null;
        if (!replacement) {
          this.tried.set(`${grp.scope}:${node.id}`, grp.blob ?? "");
          report.unclear.push(node.id);
          continue;
        }
        if (isRule && (mode === "review" || (mode === "auto-mechanical" && !mechanicalChange(node.text, replacement.text)))) {
          this.queueReview(ref, { kind: "rule-change", suggestion: replacement, evidence: backed });
          report.review.push(node.id);
          continue;
        }
        // replacements go through the semantic check before they commit
        if (!(await this.supported(replacement.text, backed, opts.signal))) {
          this.tried.set(`${grp.scope}:${node.id}`, grp.blob ?? "");
          report.unclear.push(node.id);
          continue;
        }
        const newId = await this.replace(ref, replacement, backed, grp, opts.signal);
        if (newId) report.changed.push({ id: node.id, replacement: newId });
        else report.unclear.push(node.id);
      }
    }
    for (const scope of touched) {
      g.commit(scope, "reverify");
      g.syncIndex(scope);
    }
    if (touched.size) this.s.paths.invalidate();
    return report;
  }

  private queueReview(ref: ScopedNode, item: Pick<ReviewItem, "kind" | "suggestion" | "evidence">): void {
    this.review.add({ at: this.s.clock().toISOString(), scope: ref.scope, id: ref.node.id, ...item });
    const sd = this.s.graph.sd(ref.scope);
    sd.patchNode(ref.node.id, { flags: [...new Set([...(ref.node.flags ?? []).filter((f) => f !== "reverify"), "review"])] });
  }

  private async supported(text: string, evidence: Array<{ path: string; quote: string }>, signal?: AbortSignal): Promise<boolean> {
    if (!this.s.decision.available()) return false; // fail-safe of the semantic check: veto
    const answers = await this.s.decision.decide({ statement: text, evidence: evidence.map((e) => ({ path: e.path, quote: e.quote })) }, [{ kind: "binary", name: "valid", instructions: "Is the statement supported by the quoted evidence?" }], { callSite: "evo.check", timeoutMs: TIMEOUTS.check, signal });
    const p = binaryP(answers, "valid");
    return p !== undefined && p >= 0.5;
  }

  /** Write the replacement through the write path; it supersedes the old memory, whose history stays available. */
  private async replace(old: ScopedNode, replacement: { title?: string; text: string }, evidence: Array<{ path: string; lines?: string; quote: string }>, grp: Group, signal?: AbortSignal): Promise<string | null> {
    const g = this.s.graph;
    const n = old.node;
    const sd = g.sd(old.scope);
    const nowIso = this.s.clock().toISOString();
    const paths = this.s.paths.displayAnchors(old).filter((a) => a.anchor.status === "live" && a.at).map((a) => a.at!.replace(/\/\*\*$/, "/"));
    const [w] = await this.writer.write(
      [
        {
          text: replacement.text,
          title: replacement.title,
          kind: n.kind,
          origin: n.origin === "instructions" ? "instructions" : "harvest",
          scope: old.scope,
          severity: n.severity,
          urgency: n.urgency,
          urgencyBy: n.urgencyBy,
          pin: n.pinned,
          layer: n.layer,
          paths,
          anchorRole: n.anchors[0]?.role,
          commands: n.triggers?.commands,
          triggersOn: n.triggers?.on,
          evidence: evidence.map((e) => ({ quote: e.quote, source: { type: "file", ref: e.lines ? `${e.path}:${e.lines}` : e.path }, time: nowIso })),
          sourceTexts: grp.content ? [grp.content] : [],
          source: n.source,
          validFrom: nowIso,
          skipConflicts: true,
          skipDedup: true,
          keep: true,
        },
      ],
      { signal },
    );
    if (w?.status !== "created" || !w.id) return null;
    const next = { scope: old.scope, node: sd.getNode(w.id)! };
    g.link(next, "supersedes", old, { w: 0.9 });
    sd.patchNode(n.id, { validTo: nowIso, verifiedAt: nowIso, flags: (n.flags ?? []).filter((f) => f !== "reverify") });
    sd.patchNode(w.id, { verifiedAt: nowIso });
    // the replacement inherits what the old memory had earned
    for (const name of ["used", "usedSuccess", "usedFailure"] as const) if (n.counters[name] > 0) sd.incCounter(w.id, name, n.counters[name]);
    return w.id;
  }
}

