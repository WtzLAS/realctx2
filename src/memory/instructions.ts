/**
 * Instruction files (§6.9): discovery, slicing with the aux LLM, deterministic verification,
 * storing items as pinned rules, reconciliation with learned memory, deletion and ignoring,
 * re-ingest of files that reappear, `export agents`, and the Claude Code auto-memory import.
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { agentDir, claudeDir } from "../core/config.ts";
import type { CommandIO, DecisionQuestion, Kind, MemoryNode, PathAnchor, ScopedNode, ScopeName, Severity, TriggerAction, Urgency } from "../core/types.ts";
import { binaryP, choiceProbs } from "../providers/decision.ts";
import type { SourceSection } from "../storage/schema.ts";
import { ensureDir, removeFile, writeFileAtomic } from "../util/fs.ts";
import { globCompiles } from "../util/glob.ts";
import { estimateTokens, makeTitle, sanitize, sha256, verifyQuote } from "../util/text.ts";
import { isGlob, ROOT_GLOB } from "./paths.ts";
import { type MemoryServices, TIMEOUTS } from "./services.ts";
import { defaultUrgency, pickUrgency, urgencyQuestion } from "./urgency.ts";
import type { Candidate, MemoryWriter } from "./write.ts";

export const GENERATED_MARK = "realctx2: generated";
const SECTION_TOKENS = 6000;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "out", "target", "vendor", ".venv", "venv", "__pycache__", ".next", ".cache"]);
const INSTRUCTION_NAMES = new Set(["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD", "AGENTS.override.md", "CLAUDE.local.md"]);

export type InstructionType = "agents" | "claude" | "override" | "local" | "rules" | "global" | "auto-memory" | "import";

export interface InstructionFile {
  abs: string;
  /** Repo-relative path, or a `~/…` display path for home-directory files. */
  display: string;
  type: InstructionType;
  scope: ScopeName;
  /** Repo-relative directory the file governs ("" = root); null for files without a location. */
  dir: string | null;
  tracked: boolean;
  /** Another file that replaces this one (AGENTS.override.md). */
  shadowedBy?: string;
  importedBy?: string;
  /** For non-markdown imports: the importing line the pointer memory is built from. */
  importLine?: string;
}

export interface SlicedItem {
  kind: Kind;
  severity?: Severity;
  title: string;
  text: string;
  lines: [number, number];
  quote: string;
  anchors: Array<{ kind: string; path: string; role?: string }>;
  triggers?: { on?: TriggerAction[]; commands?: string[] };
  // filled by verification
  quoteOk?: boolean;
  faithful?: number;
  urgency?: Urgency;
  urgencyBy?: "decision" | "default";
  section?: string;
  problems?: string[];
}

export interface FilePlan {
  file: InstructionFile;
  sha: string;
  lines: string[];
  items: SlicedItem[];
  skipped: Array<{ lines: [number, number]; reason: string }>;
  uncovered: number[];
  coverage: number;
  /** Section key → { hash, lines }. */
  sections: Map<string, { hash: string; from: number; to: number }>;
  /** Sections unchanged since the last ingest: their existing items are kept as they are. */
  unchanged: Set<string>;
  frontmatterPaths: string[];
  pointer?: boolean;
  problems: string[];
}

export interface IngestPlan {
  files: FilePlan[];
  toDelete: InstructionFile[];
  kept: InstructionFile[];
  problems: string[];
}

export interface IngestResult {
  plan: IngestPlan;
  stored: Array<{ file: string; id: string; scope: ScopeName; status: string }>;
  merged: string[];
  conflicts: string[];
  retired: string[];
  deleted: string[];
  backedUp: string[];
  backupDir?: string;
  dryRun: boolean;
  cancelled?: boolean;
}

interface Parsed {
  lines: string[];
  headings: Array<{ line: number; level: number; text: string }>;
  frontmatterPaths: string[];
  /** 1-based line numbers that need coverage: non-blank, non-heading, outside frontmatter. */
  content: number[];
  imports: Array<{ line: number; target: string; text: string }>;
  generated: boolean;
}

const SLICER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items", "skipped"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "title", "text", "lines", "quote"],
        properties: {
          kind: { type: "string", enum: ["rule", "procedure", "fact", "preference"] },
          severity: { type: "string", enum: ["must", "should", "may", "info"] },
          title: { type: "string" },
          text: { type: "string" },
          lines: { type: "array", minItems: 2, maxItems: 2, items: { type: "integer" } },
          quote: { type: "string" },
          anchors: { type: "array", items: { type: "object", additionalProperties: false, required: ["kind", "path"], properties: { kind: { type: "string", enum: ["file", "subtree", "glob", "symbol"] }, path: { type: "string" }, role: { type: "string", enum: ["applies", "about"] } } } },
          triggers: { type: "object", additionalProperties: false, properties: { on: { type: "array", items: { type: "string", enum: ["read", "edit", "command", "commit", "test"] } }, commands: { type: "array", items: { type: "string" } } } },
        },
      },
    },
    skipped: { type: "array", items: { type: "object", additionalProperties: false, required: ["lines", "reason"], properties: { lines: { type: "array", minItems: 2, maxItems: 2, items: { type: "integer" } }, reason: { type: "string" } } } },
  },
};

const SLICER_RULES = `Slice an agent instruction file into standalone memory items.
Rules:
- One directive per item. Keep each condition with its directive.
- Copy commands, paths and flags verbatim. Add nothing that is not in the source.
- Resolve "here" or "this package" to the file's directory. Carry heading context into the text so each item stands alone.
- Severity from wording: must/never/always → "must"; should/prefer → "should"; may → "may"; descriptions → "info".
- kind: "rule" for directives, "procedure" for how-to steps, "fact" for descriptions, "preference" for stylistic preferences.
- lines: the [first, last] line numbers the item comes from; quote: a verbatim excerpt of those lines.
- anchors: repo paths or globs the item is about, only when it names them ({ kind: "file" | "subtree" | "glob", path, role: "applies" for directives, "about" for facts }). Leave empty to use the file's default anchor.
- triggers: { on: [...] } when the item is tied to an action (edit, command, commit, test); commands: glob patterns over a command line for directives about specific commands (e.g. "prisma migrate reset*").
- Every non-blank, non-heading line must belong to an item or to "skipped" (with a reason such as "title", "table of contents", "pleasantry").`;

export function parseInstructionFile(content: string): Parsed {
  const lines = content.split(/\r?\n/);
  const headings: Parsed["headings"] = [];
  const contentLines: number[] = [];
  const imports: Parsed["imports"] = [];
  const frontmatterPaths: string[] = [];
  let i = 0;
  if (lines[0]?.trim() === "---") {
    let end = -1;
    for (let j = 1; j < Math.min(lines.length, 200); j++) if (lines[j]!.trim() === "---") {
      end = j;
      break;
    }
    if (end > 0) {
      let inPaths = false;
      for (let j = 1; j < end; j++) {
        const l = lines[j]!;
        const m = /^paths\s*:\s*(.*)$/.exec(l);
        if (m) {
          inPaths = true;
          const rest = m[1]!.trim();
          if (rest) {
            for (const p of rest.replace(/^\[|\]$/g, "").split(",")) {
              const v = p.trim().replace(/^["']|["']$/g, "");
              if (v) frontmatterPaths.push(v);
            }
            inPaths = false;
          }
          continue;
        }
        const item = /^\s*-\s+(.*)$/.exec(l);
        if (inPaths && item) frontmatterPaths.push(item[1]!.trim().replace(/^["']|["']$/g, ""));
        else if (/^\S/.test(l)) inPaths = false;
      }
      i = end + 1;
    }
  }
  let fence: string | null = null;
  for (; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    const f = /^(```+|~~~+)/.exec(line);
    if (f) {
      if (fence === null) fence = f[1]![0]!;
      else if (line.startsWith(fence)) fence = null;
      contentLines.push(i + 1);
      continue;
    }
    if (!line) continue;
    if (fence === null) {
      const h = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line);
      if (h) {
        headings.push({ line: i + 1, level: h[1]!.length, text: h[2]! });
        continue;
      }
      if (/^<!--.*-->$/.test(line)) continue;
      // @path imports (Claude Code syntax), outside code spans and fenced blocks
      const noSpans = raw.replace(/`[^`]*`/g, " ");
      for (const m of noSpans.matchAll(/(?:^|[\s(])@((?:~\/|\.{1,2}\/|\/)?[\w.-]+(?:\/[\w.@-]+)*\.[A-Za-z0-9]{1,8}|(?:~\/|\.{1,2}\/)[\w.@/-]+)/g)) imports.push({ line: i + 1, target: m[1]!, text: raw.trim() });
    }
    contentLines.push(i + 1);
  }
  return { lines, headings, frontmatterPaths, content: contentLines, imports, generated: content.slice(0, 400).includes(GENERATED_MARK) };
}

/** Section key for each content line: the heading path it sits under. */
function sectionOf(parsed: Parsed): (line: number) => string {
  const stack: Array<{ level: number; text: string }> = [];
  const keyAt = new Map<number, string>();
  let hi = 0;
  for (let line = 1; line <= parsed.lines.length; line++) {
    while (hi < parsed.headings.length && parsed.headings[hi]!.line === line) {
      const h = parsed.headings[hi]!;
      while (stack.length && stack[stack.length - 1]!.level >= h.level) stack.pop();
      stack.push({ level: h.level, text: h.text });
      hi++;
    }
    keyAt.set(line, stack.map((s) => s.text).join(" / ") || "(top)");
  }
  return (line) => keyAt.get(line) ?? "(top)";
}

export class Instructions {
  private readonly s: MemoryServices;
  private readonly writer: MemoryWriter;

  constructor(services: MemoryServices, writer: MemoryWriter) {
    this.s = services;
    this.writer = writer;
  }

  private get root(): string | null {
    return this.s.graph.project.root;
  }

  // ───────────── 1. discover (§6.9.1)
  private classify(abs: string): { type: InstructionType; scope: ScopeName; dirAbs: string } | null {
    const name = basename(abs);
    const parent = dirname(abs);
    const norm = abs.split(sep).join("/");
    if (/\/\.claude\/rules\/.+\.md$/.test(norm)) return { type: "rules", scope: "shared", dirAbs: norm.slice(0, norm.indexOf("/.claude/rules/")) };
    if (basename(parent) === ".claude" && (name === "CLAUDE.md" || name === "CLAUDE.MD")) return { type: "claude", scope: "shared", dirAbs: dirname(parent) };
    if (name === "AGENTS.override.md") return { type: "override", scope: "shared", dirAbs: parent };
    if (name === "AGENTS.md" || name === "AGENTS.MD") return { type: "agents", scope: "shared", dirAbs: parent };
    if (name === "CLAUDE.md" || name === "CLAUDE.MD") return { type: "claude", scope: "shared", dirAbs: parent };
    if (name === "CLAUDE.local.md") return { type: "local", scope: "personal", dirAbs: parent };
    return null;
  }

  private walk(): string[] {
    const root = this.root;
    if (!root) return [];
    const git = this.s.graph.project.git?.isRepo() ? this.s.graph.project.git : null;
    const out = new Set<string>();
    const consider = (rel: string) => {
      const name = basename(rel);
      if (INSTRUCTION_NAMES.has(name) || /(^|\/)\.claude\/rules\/.+\.md$/.test(rel)) out.add(join(root, rel));
    };
    if (git) {
      // tracked and untracked files; then ignored *files* (CLAUDE.local.md) — ignored directories stay collapsed and are skipped
      for (const args of [["ls-files", "-co", "--exclude-standard", "-z"], ["ls-files", "-oi", "--exclude-standard", "--directory", "-z"]]) {
        const r = git.git(args, 20_000);
        if (r.code === 0) for (const rel of r.stdout.split("\0")) if (rel && !rel.endsWith("/")) consider(rel);
      }
      return [...out].filter((p) => existsSync(p));
    }
    const visit = (dir: string, depth: number) => {
      if (depth > 8) return;
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        if (SKIP_DIRS.has(name)) continue;
        const abs = join(dir, name);
        let st: ReturnType<typeof statSync>;
        try {
          st = statSync(abs);
        } catch {
          continue;
        }
        if (st.isDirectory()) visit(abs, depth + 1);
        else consider(relative(root, abs).split(sep).join("/"));
      }
    };
    visit(root, 0);
    return [...out];
  }

  private homeFiles(): string[] {
    const out: string[] = [];
    const add = (p: string) => existsSync(p) && out.push(p);
    add(join(agentDir(), "AGENTS.md"));
    add(join(claudeDir(), "CLAUDE.md"));
    const rules = join(claudeDir(), "rules");
    const visit = (dir: string, depth: number) => {
      if (depth > 4 || !existsSync(dir)) return;
      for (const name of readdirSync(dir)) {
        const abs = join(dir, name);
        try {
          if (statSync(abs).isDirectory()) visit(abs, depth + 1);
          else if (name.endsWith(".md")) out.push(abs);
        } catch {
          // skip
        }
      }
    };
    visit(rules, 0);
    return out;
  }

  private display(abs: string): string {
    const root = this.root;
    if (root) {
      const rel = relative(root, abs);
      if (!rel.startsWith("..") && !isAbsolute(rel)) return rel.split(sep).join("/");
    }
    const home = homedir();
    return abs.startsWith(home + sep) ? `~/${relative(home, abs).split(sep).join("/")}` : abs;
  }

  /**
   * Find instruction files. `paths` limits the search to those files or directories;
   * `include` selects the families (agents, claude, local, rules, global).
   */
  discover(opts: { paths?: string[]; include?: string[] } = {}): InstructionFile[] {
    const include = new Set(opts.include ?? this.s.cfg.instructions.include);
    const root = this.root;
    const git = this.s.graph.project.git?.isRepo() ? this.s.graph.project.git : null;
    const files: InstructionFile[] = [];
    const wanted = (opts.paths ?? []).map((p) => resolve(this.s.graph.project.cwd, p));
    const matches = (abs: string) => !wanted.length || wanted.some((w) => abs === w || abs.startsWith(w + sep));
    for (const abs of this.walk()) {
      if (!matches(abs)) continue;
      const c = this.classify(abs);
      if (!c || !root) continue;
      const family = c.type === "override" ? "agents" : c.type;
      if (!include.has(family)) continue;
      const dir = relative(root, c.dirAbs).split(sep).join("/");
      const display = this.display(abs);
      files.push({ abs, display, type: c.type, scope: c.scope, dir, tracked: git ? git.isTracked(display) : false });
    }
    // AGENTS.override.md replaces that directory's AGENTS.md or CLAUDE.md, as pi does
    for (const o of files.filter((f) => f.type === "override")) {
      for (const f of files) if (f !== o && f.dir === o.dir && (f.type === "agents" || f.type === "claude")) f.shadowedBy = o.display;
    }
    if (include.has("global")) {
      for (const abs of this.homeFiles()) if (matches(abs) || !wanted.length) files.push({ abs, display: this.display(abs), type: "global", scope: "global", dir: null, tracked: false });
    }
    // explicitly named files that are not standard instruction files are still ingested on request
    for (const w of wanted) {
      if (files.some((f) => f.abs === w) || !existsSync(w) || !statSync(w).isFile() || !/\.(md|MD|markdown)$/.test(w)) continue;
      const inRepo = root && !relative(root, w).startsWith("..");
      files.push({ abs: w, display: this.display(w), type: "agents", scope: inRepo ? "shared" : "global", dir: inRepo ? relative(root, dirname(w)).split(sep).join("/") : null, tracked: git && inRepo ? git.isTracked(this.display(w)) : false });
    }
    return files.sort((a, b) => a.display.localeCompare(b.display));
  }

  /** Instruction files present on disk although their content was ingested (§6.9.4). */
  reappeared(): InstructionFile[] {
    const ingested = new Set<string>();
    for (const scope of this.s.graph.visible()) for (const src of this.s.graph.sd(scope).sources()) if (src.mode === "ingested") ingested.add(src.file);
    if (!ingested.size) return [];
    return this.discover({ include: ["agents", "claude", "local", "rules", "global"] }).filter((f) => {
      try {
        return !parseInstructionFile(readFileSync(f.abs, "utf8")).generated;
      } catch {
        return false;
      }
    });
  }

  /** True once any instruction file of this project (or of the home directory) has been ingested. */
  ingestedScopes(): { project: boolean; global: boolean } {
    const has = (scope: ScopeName) => this.s.graph.has(scope) && this.s.graph.sd(scope).sources().some((s) => s.mode === "ingested");
    return { project: has("shared") || has("personal"), global: has("global") };
  }

  /**
   * pi: which loaded context files to drop from `systemPromptOptions.contextFiles` (§6.9.5).
   * Files that realctx2 generated itself are dropped as well: memory is the source of truth.
   */
  shouldIgnore(absPath: string): boolean {
    if (!this.s.cfg.instructions.ignoreAfterIngest) return false;
    const state = this.ingestedScopes();
    const root = this.root;
    const inRepo = root ? !relative(root, absPath).startsWith("..") : false;
    if (inRepo) return state.project && this.classify(absPath) !== null;
    if (!state.global) return false;
    const norm = absPath.split(sep).join("/");
    return norm === join(agentDir(), "AGENTS.md").split(sep).join("/") || norm.startsWith(claudeDir().split(sep).join("/") + "/");
  }

  /** Claude Code: patterns for `claudeMdExcludes` in `.claude/settings.local.json`. */
  excludePatterns(): string[] {
    const state = this.ingestedScopes();
    const root = this.root;
    if (!state.project || !root) return [];
    const base = root.split(sep).join("/");
    return [`${base}/**/CLAUDE.md`, `${base}/**/CLAUDE.MD`, `${base}/**/CLAUDE.local.md`, `${base}/**/AGENTS.md`, `${base}/**/.claude/rules/**`, `${base}/CLAUDE.md`, `${base}/CLAUDE.local.md`];
  }

  // ───────────── 2. slice
  private defaultAnchor(file: InstructionFile, frontmatterPaths: string[]): string[] {
    if (file.type === "rules" || file.type === "global") return frontmatterPaths.filter((p) => globCompiles(p));
    if (file.dir === null) return [];
    return [file.dir === "" ? "." : `${file.dir}/`];
  }

  private async sliceChunk(file: InstructionFile, parsed: Parsed, from: number, to: number, only: number[] | null, signal?: AbortSignal): Promise<{ items: SlicedItem[]; skipped: FilePlan["skipped"] } | null> {
    const aux = this.s.aux;
    if (!aux?.available()) return null;
    const numbered = parsed.lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(4)}| ${l}`).join("\n");
    const anchors = this.defaultAnchor(file, parsed.frontmatterPaths);
    const res = await aux.run<{ items: SlicedItem[]; skipped: FilePlan["skipped"] }>({
      role: "ingest.slicer",
      instructions: `${SLICER_RULES}\n\nFile: ${file.display}\nDefault anchor: ${anchors.length ? anchors.join(", ") : "(none)"}${parsed.frontmatterPaths.length ? `\nFrontmatter paths: ${parsed.frontmatterPaths.join(", ")}` : ""}${only ? `\n\nThese lines were not covered by a first pass. Cover exactly lines ${only.join(", ")}: each belongs to an item or to "skipped".` : ""}`,
      data: [{ label: `${file.display} (numbered lines ${from}-${to})`, text: numbered }],
      schema: SLICER_SCHEMA,
      tools: this.root ? undefined : "none",
      signal,
    });
    const out = res.output;
    if (!out || !Array.isArray(out.items)) return null;
    return { items: out.items, skipped: Array.isArray(out.skipped) ? out.skipped : [] };
  }

  private chunks(parsed: Parsed): Array<[number, number]> {
    const total = parsed.lines.length;
    if (estimateTokens(parsed.lines.join("\n")) <= SECTION_TOKENS) return [[1, total]];
    // split at headings into groups of sections of up to about 6K tokens
    const cuts = [1, ...parsed.headings.map((h) => h.line).filter((l) => l > 1), total + 1];
    const out: Array<[number, number]> = [];
    let start = cuts[0]!;
    let tokens = 0;
    for (let i = 1; i < cuts.length; i++) {
      const t = estimateTokens(parsed.lines.slice(cuts[i - 1]! - 1, cuts[i]! - 1).join("\n"));
      if (tokens > 0 && tokens + t > SECTION_TOKENS) {
        out.push([start, cuts[i - 1]! - 1]);
        start = cuts[i - 1]!;
        tokens = 0;
      }
      tokens += t;
    }
    out.push([start, total]);
    return out;
  }

  // ───────────── 3. verify (deterministic)
  private verify(file: InstructionFile, parsed: Parsed, items: SlicedItem[], skipped: FilePlan["skipped"]): { items: SlicedItem[]; uncovered: number[] } {
    const total = parsed.lines.length;
    const covered = new Set<number>();
    const clean: SlicedItem[] = [];
    const section = sectionOf(parsed);
    for (const raw of items) {
      if (!raw || typeof raw.text !== "string" || !raw.text.trim()) continue;
      const a = Math.max(1, Math.min(total, Math.floor(Number(raw.lines?.[0]) || 0)));
      const b = Math.max(a, Math.min(total, Math.floor(Number(raw.lines?.[1]) || a)));
      if (!Number.isFinite(a) || a < 1) continue;
      const problems: string[] = [];
      const cited = parsed.lines.slice(a - 1, b).join("\n");
      // every quote must match its cited lines after normalization
      const quoteOk = typeof raw.quote === "string" && raw.quote.trim().length > 0 && verifyQuote(raw.quote, cited);
      if (!quoteOk) problems.push("quote does not match the cited lines");
      const anchors: SlicedItem["anchors"] = [];
      for (const an of Array.isArray(raw.anchors) ? raw.anchors : []) {
        if (!an || typeof an.path !== "string" || !an.path.trim()) continue;
        const spec = an.path.trim();
        if (isGlob(spec) ? globCompiles(spec) : file.scope === "global" || this.s.paths.rel(spec, this.root ?? undefined) !== null) {
          if (!isGlob(spec) && file.scope !== "global") {
            const rel = this.s.paths.rel(spec, this.root ?? undefined)!;
            if (!this.s.paths.exists(rel)) {
              problems.push(`anchor path not found: ${spec}`);
              continue;
            }
          }
          anchors.push({ kind: an.kind, path: spec, role: an.role });
        } else problems.push(`anchor does not resolve: ${spec}`);
      }
      const kind: Kind = raw.kind === "procedure" || raw.kind === "fact" || raw.kind === "preference" ? raw.kind : "rule";
      const severity: Severity | undefined = kind === "rule" ? (["must", "should", "may", "info"].includes(String(raw.severity)) ? (raw.severity as Severity) : "should") : undefined;
      const on = (raw.triggers?.on ?? []).filter((x): x is TriggerAction => ["read", "edit", "command", "commit", "test"].includes(String(x)));
      const commands = (raw.triggers?.commands ?? []).filter((x): x is string => typeof x === "string" && x.trim().length > 0);
      clean.push({ kind, severity, title: makeTitle(sanitize(raw.title || raw.text)), text: sanitize(raw.text.trim()), lines: [a, b], quote: typeof raw.quote === "string" ? raw.quote : "", anchors, triggers: on.length || commands.length ? { ...(on.length ? { on } : {}), ...(commands.length ? { commands } : {}) } : undefined, quoteOk, section: section(a), problems });
      for (let l = a; l <= b; l++) covered.add(l);
    }
    for (const s of skipped) {
      const a = Math.floor(Number(s?.lines?.[0]) || 0);
      const b = Math.floor(Number(s?.lines?.[1]) || a);
      for (let l = Math.max(1, a); l <= Math.min(total, b); l++) covered.add(l);
    }
    return { items: clean, uncovered: parsed.content.filter((l) => !covered.has(l)) };
  }

  private sections(parsed: Parsed): FilePlan["sections"] {
    const section = sectionOf(parsed);
    const ranges = new Map<string, { from: number; to: number; text: string[] }>();
    for (const l of parsed.content) {
      const key = section(l);
      const cur = ranges.get(key);
      if (cur) {
        cur.to = l;
        cur.text.push(parsed.lines[l - 1]!);
      } else ranges.set(key, { from: l, to: l, text: [parsed.lines[l - 1]!] });
    }
    const out: FilePlan["sections"] = new Map();
    for (const [k, r] of ranges) out.set(k, { hash: sha256(r.text.join("\n")).slice(0, 16), from: r.from, to: r.to });
    return out;
  }

  /** Slice and verify one file. Sections whose hash matches the last ingest are left alone. */
  async planFile(file: InstructionFile, signal?: AbortSignal): Promise<FilePlan> {
    const content = readFileSync(file.abs, "utf8");
    const sha = sha256(content).slice(0, 40);
    const parsed = parseInstructionFile(content);
    const sections = this.sections(parsed);
    const plan: FilePlan = { file, sha, lines: parsed.lines, items: [], skipped: [], uncovered: [], coverage: 1, sections, unchanged: new Set(), frontmatterPaths: parsed.frontmatterPaths, problems: [] };
    if (parsed.generated) {
      plan.problems.push("generated by realctx2: never re-ingested");
      return plan;
    }
    if (file.shadowedBy) {
      plan.problems.push(`replaced by ${file.shadowedBy}: not sliced`);
      return plan;
    }
    // non-markdown imports become one pointer memory built from the importing line
    if (file.type === "import" && !/\.(md|mdx|markdown|txt)$/i.test(file.abs)) {
      plan.pointer = true;
      const name = file.display;
      const line = file.importLine?.replace(/@(\S+)/g, "$1") ?? "";
      plan.items = [{ kind: "fact", title: `See ${name}`, text: line && line.length > name.length + 4 ? sanitize(line) : `Details are kept in ${name}.`, lines: [1, 1], quote: "", anchors: [{ kind: "file", path: file.abs, role: "about" }], quoteOk: true, section: "(import)", problems: [] }];
      return plan;
    }
    const prior = this.s.graph.has(file.scope) ? this.s.graph.sd(file.scope).getSource(file.display) : null;
    // a section whose text did not change keeps its items exactly as they are — including ones the user retired since
    if (prior) for (const [key, sec] of sections) if (prior.sections[key]?.hash === sec.hash) plan.unchanged.add(key);
    const section = sectionOf(parsed);
    const todo = parsed.content.filter((l) => !plan.unchanged.has(section(l)));
    if (!todo.length) return plan;
    if (!this.s.aux?.available()) {
      plan.problems.push("no aux model available: cannot slice");
      plan.uncovered = todo;
      plan.coverage = 0;
      return plan;
    }
    let items: SlicedItem[] = [];
    let skipped: FilePlan["skipped"] = [];
    for (const [from, to] of this.chunks(parsed)) {
      if (!todo.some((l) => l >= from && l <= to)) continue;
      const out = await this.sliceChunk(file, parsed, from, to, null, signal);
      if (!out) {
        plan.problems.push(`slicing failed for lines ${from}-${to}`);
        continue;
      }
      items.push(...out.items);
      skipped.push(...out.skipped);
    }
    let v = this.verify(file, parsed, items, skipped);
    let uncovered = v.uncovered.filter((l) => !plan.unchanged.has(section(l)));
    if (uncovered.length) {
      // uncovered lines get one re-prompt
      const from = Math.max(1, uncovered[0]! - 3);
      const to = Math.min(parsed.lines.length, uncovered[uncovered.length - 1]! + 3);
      const again = await this.sliceChunk(file, parsed, from, to, uncovered, signal);
      if (again) {
        const want = new Set(uncovered);
        items = [...items, ...again.items.filter((it) => Array.isArray(it?.lines) && [...Array(Math.max(0, Number(it.lines[1]) - Number(it.lines[0]) + 1)).keys()].some((k) => want.has(Number(it.lines[0]) + k)))];
        skipped = [...skipped, ...again.skipped];
        v = this.verify(file, parsed, items, skipped);
        uncovered = v.uncovered.filter((l) => !plan.unchanged.has(section(l)));
      }
    }
    plan.items = v.items.filter((it) => !plan.unchanged.has(it.section ?? ""));
    plan.skipped = skipped;
    plan.uncovered = uncovered;
    plan.coverage = todo.length ? 1 - uncovered.length / todo.length : 1;
    return plan;
  }

  /** `@path` imports of a file, expanded up to `importHops` (§6.9.1). Imported files are kept, never deleted. */
  private async imports(file: InstructionFile, io: CommandIO | null, seen: Set<string>, hop = 0): Promise<InstructionFile[]> {
    if (hop >= this.s.cfg.instructions.importHops) return [];
    let parsed: Parsed;
    try {
      parsed = parseInstructionFile(readFileSync(file.abs, "utf8"));
    } catch {
      return [];
    }
    const out: InstructionFile[] = [];
    const root = this.root;
    for (const imp of parsed.imports) {
      const target = imp.target.startsWith("~/") ? join(homedir(), imp.target.slice(2)) : resolve(dirname(file.abs), imp.target);
      if (seen.has(target) || !existsSync(target) || !statSync(target).isFile()) continue;
      seen.add(target);
      const inRepo = root ? !relative(root, target).startsWith("..") : false;
      if (!inRepo) {
        // imports that resolve outside the repo need the user's confirmation
        if (!io || !(await io.confirm("Import from outside the repository", `${file.display} imports ${target}. Read it?`))) continue;
      }
      // a shared file's imports from outside the repo go to Project Personal
      const scope: ScopeName = file.scope === "shared" && !inRepo ? "personal" : file.scope;
      const child: InstructionFile = { abs: target, display: this.display(target), type: "import", scope, dir: file.dir, tracked: false, importedBy: file.display, importLine: imp.text };
      out.push(child);
      if (/\.(md|mdx|markdown)$/i.test(target)) out.push(...(await this.imports(child, io, seen, hop + 1)));
    }
    return out;
  }

  /** One decision request for the batch: urgency for each item, and optionally faithfulness. */
  private async judge(plans: FilePlan[], signal?: AbortSignal): Promise<void> {
    const all = plans.flatMap((p) => p.items.map((item) => ({ p, item })));
    if (!all.length) return;
    const questions: DecisionQuestion[] = [];
    const checkFaith = this.s.cfg.instructions.verifyWithDecisionModel;
    all.forEach(({ p, item }, i) => {
      const triggered = item.anchors.length > 0 || (item.triggers?.commands?.length ?? 0) > 0 || this.defaultAnchor(p.file, p.frontmatterPaths).length > 0;
      questions.push(urgencyQuestion(`urgency.i${i}`, `i${i}`, triggered));
      if (checkFaith && !p.pointer) questions.push({ kind: "binary", name: `faithful.i${i}`, instructions: `Does item i${i} keep the meaning of its quoted lines without adding anything?` });
    });
    let answers: Awaited<ReturnType<typeof this.s.decision.decide>> = {};
    if (this.s.decision.available()) {
      answers = await this.s.decision.decide({ task: "Instruction-file items for a coding agent.", items: all.map(({ item }, i) => ({ id: `i${i}`, kind: item.kind, severity: item.severity ?? null, text: item.text.slice(0, 800), quoted: item.quote.slice(0, 600) })) }, questions, { callSite: "ingest.check", timeoutMs: TIMEOUTS.check, signal });
    }
    all.forEach(({ p, item }, i) => {
      const triggered = item.anchors.length > 0 || (item.triggers?.commands?.length ?? 0) > 0 || this.defaultAnchor(p.file, p.frontmatterPaths).length > 0;
      const picked = pickUrgency(answers[`urgency.i${i}`], triggered, defaultUrgency(item.kind, item.severity));
      item.urgency = picked.urgency;
      item.urgencyBy = picked.by;
      // fail-safe: keep the item, marked unchecked
      item.faithful = binaryP(answers, `faithful.i${i}`);
      if (item.faithful !== undefined && item.faithful < 0.5) item.problems = [...(item.problems ?? []), "may not be faithful to its source lines"];
    });
  }

  /** Steps 1–3 for a set of files: discover, expand imports, slice, verify, judge. Changes nothing. */
  async plan(opts: { paths?: string[]; include?: string[]; io?: CommandIO | null; signal?: AbortSignal } = {}): Promise<IngestPlan> {
    const discovered = this.discover(opts);
    const seen = new Set(discovered.map((f) => f.abs));
    const imported: InstructionFile[] = [];
    for (const f of discovered) if (!f.shadowedBy) imported.push(...(await this.imports(f, opts.io ?? null, seen)));
    const plans: FilePlan[] = [];
    const problems: string[] = [];
    for (const f of [...discovered, ...imported]) {
      if (opts.signal?.aborted) break;
      if (!this.s.graph.has(f.scope) || !this.s.graph.writable(f.scope)) {
        problems.push(`${f.display}: the ${f.scope} scope is not available here${f.scope === "shared" ? " (is the project trusted?)" : ""}`);
        continue;
      }
      try {
        plans.push(await this.planFile(f, opts.signal));
      } catch (e) {
        problems.push(`${f.display}: ${String((e as Error).message)}`);
      }
    }
    await this.judge(plans, opts.signal);
    const generated = (p: FilePlan) => p.problems.some((x) => x.startsWith("generated by realctx2"));
    const complete = (p: FilePlan) => p.file.shadowedBy !== undefined || (p.uncovered.length === 0 && !p.problems.some((x) => x.startsWith("slicing failed") || x.startsWith("no aux")));
    // only instruction files are deleted, and only when everything in them was covered; imports are kept
    const toDelete = plans.filter((p) => p.file.type !== "import" && !generated(p) && complete(p) && this.s.cfg.instructions.deleteAfterIngest).map((p) => p.file);
    const kept = plans.filter((p) => !toDelete.includes(p.file)).map((p) => p.file);
    return { files: plans, toDelete, kept, problems };
  }

  /** The preview shown before anything is stored or deleted (§6.9.2 step 6). */
  preview(plan: IngestPlan): string {
    const out: string[] = [];
    for (const p of plan.files) {
      const pct = Math.round(p.coverage * 100);
      out.push(`${p.file.display} → ${p.file.scope}${p.file.importedBy ? ` (imported by ${p.file.importedBy}, kept)` : ""} · ${p.items.length} item${p.items.length === 1 ? "" : "s"} · coverage ${pct}%${p.unchanged.size ? ` · ${p.unchanged.size} unchanged section(s)` : ""}`);
      for (const x of p.problems) out.push(`  ! ${x}`);
      let section = "";
      for (const item of p.items) {
        if (item.section !== section) {
          section = item.section ?? "";
          out.push(`  § ${section}`);
        }
        const anchors = item.anchors.length ? item.anchors.map((a) => a.path) : this.defaultAnchor(p.file, p.frontmatterPaths);
        const tags = [item.kind === "rule" ? (item.severity ?? "should").toUpperCase() : item.kind, item.urgency ?? "?", anchors.length ? anchors.join(", ") : "no anchor"];
        if (item.triggers?.commands?.length) tags.push(`commands: ${item.triggers.commands.join(" | ")}`);
        out.push(`    - [${tags.join(" · ")}] ${item.text}  (lines ${item.lines[0]}-${item.lines[1]})`);
        for (const x of item.problems ?? []) out.push(`        ⚠ ${x}`);
      }
      if (p.uncovered.length) out.push(`  ! uncovered lines: ${p.uncovered.slice(0, 20).join(", ")}${p.uncovered.length > 20 ? ", …" : ""} — the file will be kept`);
    }
    for (const x of plan.problems) out.push(`! ${x}`);
    out.push("");
    if (plan.toDelete.length) {
      out.push("Files that will be deleted after ingest:");
      for (const f of plan.toDelete) out.push(`  ${f.display}${f.tracked ? " (tracked: git history keeps it)" : " (untracked: backed up first)"}${f.shadowedBy ? ` — replaced by ${f.shadowedBy}, not sliced` : ""}`);
    } else out.push("No files will be deleted.");
    return out.join("\n");
  }

  // ───────────── 4–7. store, reconcile, delete, ignore
  private candidate(p: FilePlan, item: SlicedItem): Candidate {
    const file = p.file;
    const role = item.kind === "fact" ? "about" : "applies";
    const specs = item.anchors.length ? item.anchors.map((a) => a.path) : this.defaultAnchor(file, p.frontmatterPaths);
    const anchors: PathAnchor[] = [];
    for (const spec of specs) {
      const explicit = item.anchors.find((a) => a.path === spec);
      const a = this.s.paths.makeAnchor(file.scope, spec, explicit?.role === "about" || explicit?.role === "applies" ? explicit.role : role, { cwd: this.root ?? undefined, subtree: explicit?.kind === "subtree" ? true : undefined });
      if (a) anchors.push(a);
    }
    const auto = file.type === "auto-memory";
    return {
      text: item.text,
      title: item.title,
      kind: item.kind,
      origin: auto ? "auto-memory" : "instructions",
      scope: auto ? undefined : file.scope,
      defaultScope: auto ? "personal" : undefined,
      severity: item.severity,
      urgency: auto ? undefined : item.urgency,
      urgencyBy: auto ? undefined : (item.urgencyBy ?? "default"),
      anchors,
      commands: item.triggers?.commands,
      triggersOn: item.triggers?.on,
      evidence: item.quote ? [{ quote: item.quote, source: { type: "instruction", ref: `${file.display}:${item.lines[0]}` } }] : [],
      sourceTexts: item.quoteOk ? [p.lines.slice(item.lines[0] - 1, item.lines[1]).join("\n")] : [],
      source: auto ? undefined : { file: file.display, sha: p.sha, section: item.section ?? "(top)", lines: item.lines },
      layer: auto ? "short" : "long",
      pin: auto ? false : true,
      skipConflicts: true,
      skipDedup: !auto,
      keep: !auto,
    };
  }

  /** Reconcile new instruction items with learned memory (§6.9.2 step 5). */
  private async reconcile(items: ScopedNode[], result: IngestResult, signal?: AbortSignal): Promise<void> {
    const g = this.s.graph;
    const sim = this.s.sim;
    const pairs: Array<{ item: ScopedNode; other: ScopedNode; sim: number }> = [];
    const nowIso = this.s.clock().toISOString();
    for (const item of items) {
      for (const hit of await this.writer.similar(item.node.text, g.visible(), 6, signal)) {
        const other = hit.ref;
        if (other.node.id === item.node.id || other.node.origin === "instructions" || other.node.status !== "active") continue;
        const dup = other.node.contentHash === item.node.contentHash || hit.sim >= sim.threshold("dedup", hit.mode);
        if (dup && other.scope === item.scope && g.writable(other.scope)) {
          // a learned memory that duplicates an item is merged into the item, keeping its provenance and use counters
          const sd = g.sd(item.scope);
          for (const [name, v] of Object.entries(other.node.counters)) if (v > 0) sd.incCounter(item.node.id, name as keyof MemoryNode["counters"], v);
          for (const e of other.node.evidence) sd.addEvidence(item.node.id, e);
          g.link(other, "part-of", item, { w: 0.8 });
          sd.patchNode(other.node.id, { status: "archived", statusReason: `merged into instruction m:${item.node.id}`, statusAt: nowIso });
          g.setEdgesActive({ scope: other.scope, node: sd.getNode(other.node.id)! }, false);
          result.merged.push(other.node.id);
        } else if (!dup && hit.sim >= (hit.mode === "lexical" ? 0.2 : sim.threshold("conflict", hit.mode))) pairs.push({ item, other, sim: hit.sim });
      }
    }
    if (pairs.length && this.s.decision.available()) {
      const batch = pairs.slice(0, 40);
      const answers = await this.s.decision.decide(
        { pairs: batch.map((p, j) => ({ j, instruction: p.item.node.text.slice(0, 600), learned: p.other.node.text.slice(0, 600) })) },
        batch.map((_, j) => ({ kind: "choice" as const, name: `rel.${j}`, instructions: `How does the learned memory of pair ${j} relate to the instruction?`, options: [{ value: "compatible" }, { value: "contradictory", description: "they cannot both be followed" }, { value: "unrelated" }] })),
        { callSite: "write.conflict", timeoutMs: TIMEOUTS.conflict, signal },
      );
      batch.forEach((p, j) => {
        const probs = choiceProbs(answers, `rel.${j}`);
        if (!probs || (probs.contradictory ?? 0) < Math.max(probs.compatible ?? 0, probs.unrelated ?? 0)) return;
        // a learned memory that contradicts an item is flagged; the instruction wins until the user reviews it
        g.link(p.item, "contradicts", p.other, { w: 0.6 });
        g.link(p.other, "contradicts", p.item, { w: 0.6 });
        if (g.writable(p.other.scope)) g.sd(p.other.scope).patchNode(p.other.node.id, { flags: [...new Set([...(p.other.node.flags ?? []), "conflicts-instruction"])] });
        result.conflicts.push(p.other.node.id);
      });
    }
  }

  /**
   * `/realctx2 ingest [paths…] [--include …] [--dry-run]`.
   * Nothing is stored or deleted before the preview has been confirmed.
   */
  async ingest(opts: { paths?: string[]; include?: string[]; dryRun?: boolean; io: CommandIO; signal?: AbortSignal; assumeYes?: boolean }): Promise<IngestResult> {
    const plan = await this.plan({ paths: opts.paths, include: opts.include, io: opts.io, signal: opts.signal });
    const result: IngestResult = { plan, stored: [], merged: [], conflicts: [], retired: [], deleted: [], backedUp: [], dryRun: opts.dryRun === true };
    opts.io.print(this.preview(plan));
    if (opts.dryRun) return result;
    if (!plan.files.some((p) => p.items.length || p.unchanged.size) && !plan.toDelete.length) return result;
    if (!opts.assumeYes) {
      const ok = await opts.io.confirm("Ingest instruction files", `Store ${plan.files.reduce((n, p) => n + p.items.length, 0)} item(s) and delete ${plan.toDelete.length} file(s)?`);
      if (!ok) {
        result.cancelled = true;
        return result;
      }
    }
    await this.apply(plan, result, opts.signal);
    return result;
  }

  /** Store the planned items, reconcile, record sources, then delete and back up files. */
  async apply(plan: IngestPlan, result: IngestResult, signal?: AbortSignal): Promise<void> {
    const g = this.s.graph;
    const nowIso = this.s.clock().toISOString();
    const fresh: ScopedNode[] = [];
    for (const p of plan.files) {
      if (!p.items.length && !p.unchanged.size) continue;
      const file = p.file;
      const sd = g.sd(file.scope);
      const prior = sd.getSource(file.display);
      const written = p.items.length ? await this.writer.write(p.items.map((item) => this.candidate(p, item)), { signal }) : [];
      const bySection = new Map<string, string[]>();
      written.forEach((w, i) => {
        const item = p.items[i]!;
        if (!w.id || !w.scope) return;
        result.stored.push({ file: file.display, id: w.id, scope: w.scope, status: w.status });
        if (w.status === "created") fresh.push({ scope: w.scope, node: g.getIn(w.scope, w.id)! });
        if (w.scope === file.scope) bySection.set(item.section ?? "(top)", [...(bySection.get(item.section ?? "(top)") ?? []), w.id]);
      });
      if (file.type === "auto-memory") continue;
      // sources: the file's hash and its section → items mapping, so a re-ingest can be matched
      const sections: Record<string, SourceSection> = {};
      for (const [key, sec] of p.sections) {
        if (p.unchanged.has(key) && prior?.sections[key]) sections[key] = prior.sections[key]!;
        else {
          sections[key] = { hash: sec.hash, itemIds: bySection.get(key) ?? [] };
          // items of a section that changed or vanished are retired: memory follows the file
          for (const old of prior?.sections[key]?.itemIds ?? []) {
            const n = sd.getNode(old);
            if (n && n.status === "active" && !sections[key]!.itemIds.includes(old)) {
              sd.patchNode(old, { status: "archived", statusReason: `retired: replaced on re-ingest of ${file.display}`, statusAt: nowIso });
              g.setEdgesActive({ scope: file.scope, node: sd.getNode(old)! }, false);
              result.retired.push(old);
            }
          }
        }
      }
      for (const [key, sec] of Object.entries(prior?.sections ?? {})) {
        if (sections[key]) continue;
        for (const old of sec.itemIds) {
          const n = sd.getNode(old);
          if (n && n.status === "active") {
            sd.patchNode(old, { status: "archived", statusReason: `retired: removed from ${file.display}`, statusAt: nowIso });
            result.retired.push(old);
          }
        }
      }
      sd.setSource(file.display, { sha: p.sha, mode: file.type === "import" ? (p.pointer ? "pointer" : "import") : "ingested", ingestedAt: nowIso, importedBy: file.importedBy }, sections);
      g.commit(file.scope, "ingest");
    }
    await this.reconcile(fresh, result, signal);
    for (const scope of g.visible()) {
      g.commit(scope, "ingest-reconcile");
      g.syncIndex(scope);
    }
    this.s.paths.invalidate();
    // delete: tracked files leave the working tree (git history keeps them); untracked ones are backed up first
    if (plan.toDelete.length && this.s.cfg.instructions.deleteAfterIngest) {
      const backupDir = this.s.layout ? join(this.s.layout.backupsDir, "instructions", nowIso.replace(/[:.]/g, "-")) : null;
      for (const f of plan.toDelete) {
        if (!existsSync(f.abs)) continue;
        if (!f.tracked) {
          if (!backupDir) continue; // nowhere to back up: keep the file
          const dest = join(backupDir, f.display.replace(/^~\//, "home/").replace(/^\//, "abs/"));
          ensureDir(dirname(dest));
          copyFileSync(f.abs, dest);
          result.backedUp.push(f.display);
          result.backupDir = backupDir;
        }
        removeFile(f.abs);
        result.deleted.push(f.display);
      }
    }
    // user-initiated: flush right away so the update files land next to the deletions (§7.5)
    g.flush();
  }

  // ───────────── imports kept in sync (§6.9.1)
  /** Imported files whose content changed since they were sliced: re-sliced at idle time. */
  changedImports(): InstructionFile[] {
    const out: InstructionFile[] = [];
    const root = this.root;
    for (const scope of this.s.graph.visible()) {
      for (const src of this.s.graph.sd(scope).sources()) {
        if (src.mode !== "import" && src.mode !== "pointer") continue;
        const abs = src.file.startsWith("~/") ? join(homedir(), src.file.slice(2)) : isAbsolute(src.file) ? src.file : root ? join(root, src.file) : null;
        if (!abs || !existsSync(abs)) continue;
        let sha: string;
        try {
          sha = sha256(readFileSync(abs, "utf8")).slice(0, 40);
        } catch {
          continue;
        }
        if (sha !== src.sha) out.push({ abs, display: src.file, type: "import", scope, dir: root && !src.file.startsWith("~/") && !isAbsolute(src.file) ? dirname(src.file).replace(/^\.$/, "") : null, tracked: false, importedBy: src.importedBy });
      }
    }
    return out;
  }

  /** Re-slice changed imports and reconcile them like a re-ingest. */
  async resliceImports(signal?: AbortSignal): Promise<number> {
    const changed = this.changedImports();
    if (!changed.length || !this.s.aux?.available()) return 0;
    const plans: FilePlan[] = [];
    for (const f of changed) {
      if (signal?.aborted) break;
      plans.push(await this.planFile(f, signal));
    }
    await this.judge(plans, signal);
    const result: IngestResult = { plan: { files: plans, toDelete: [], kept: changed, problems: [] }, stored: [], merged: [], conflicts: [], retired: [], deleted: [], backedUp: [], dryRun: false };
    await this.apply(result.plan, result, signal);
    return plans.length;
  }

  // ───────────── export agents (§6.9.4)
  /** Regenerate AGENTS.md files from rules, for tools and teammates that still need the files. */
  exportAgents(dir?: string): string[] {
    const root = this.root;
    if (!root) return [];
    const base = dir ? resolve(this.s.graph.project.cwd, dir) : root;
    const groups = new Map<string, Array<{ node: MemoryNode; note: string }>>();
    const add = (where: string, node: MemoryNode, note = "") => groups.set(where, [...(groups.get(where) ?? []), { node, note }]);
    for (const ref of this.s.graph.active(["shared", "personal"].filter((s) => this.s.graph.has(s as ScopeName)) as ScopeName[])) {
      const n = ref.node;
      if (n.kind !== "rule" && n.origin !== "instructions") continue;
      if (ref.scope === "personal" && n.origin !== "instructions") continue;
      const anchors = this.s.paths.displayAnchors(ref).filter((a) => a.anchor.status === "live");
      if (!anchors.length) {
        add("", n);
        continue;
      }
      for (const a of anchors) {
        if (a.anchor.kind === "subtree" && a.entry) add(a.entry.path, n);
        else if (a.anchor.kind === "glob") add("", n, a.anchor.glob === ROOT_GLOB ? "" : ` (applies to \`${a.anchor.glob}\`)`);
        else if (a.entry) add(dirname(a.entry.path).replace(/^\.$/, ""), n, ` (\`${a.entry.path}\`)`);
      }
    }
    const written: string[] = [];
    const rank: Record<string, number> = { must: 0, should: 1, may: 2, info: 3 };
    for (const [where, list] of groups) {
      const seen = new Set<string>();
      const lines = [`<!-- ${GENERATED_MARK} from project memory. Edit rules with /realctx2 rules; this file is overwritten by /realctx2 export agents. -->`, "", `# Agent instructions${where ? ` for ${where}` : ""}`, ""];
      for (const { node, note } of list.sort((a, b) => (rank[a.node.severity ?? "info"] ?? 3) - (rank[b.node.severity ?? "info"] ?? 3))) {
        if (seen.has(node.id)) continue;
        seen.add(node.id);
        lines.push(`- ${node.kind === "rule" && node.severity === "must" ? "**MUST** " : ""}${node.text.replace(/\n+/g, " ")}${note}`);
      }
      const file = join(base, where, "AGENTS.md");
      writeFileAtomic(file, lines.join("\n") + "\n");
      written.push(relative(root, file).split(sep).join("/"));
    }
    return written.sort();
  }

  // ───────────── Claude Code auto-memory import (§4.6.5)
  autoMemoryDir(): string | null {
    const cwd = this.s.graph.project.root ?? this.s.graph.project.cwd;
    const dir = join(claudeDir(), "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), "memory");
    return existsSync(dir) ? dir : null;
  }

  /** Slice a project's auto-memory notes through the ingest pipeline, back them up, then delete them. */
  async importAutoMemory(signal?: AbortSignal): Promise<{ files: number; items: number; backupDir?: string }> {
    const dir = this.autoMemoryDir();
    if (!dir || !this.s.cfg.claudeCode.importAutoMemory || !this.s.aux?.available()) return { files: 0, items: 0 };
    const notes = readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => join(dir, f));
    if (!notes.length) return { files: 0, items: 0 };
    const plans: FilePlan[] = [];
    for (const abs of notes) {
      if (signal?.aborted) return { files: 0, items: 0 };
      // the decision model picks each item's scope, Global included, so the file's scope here is only a default
      plans.push(await this.planFile({ abs, display: `auto-memory/${basename(abs)}`, type: "auto-memory", scope: this.s.graph.has("personal") ? "personal" : "global", dir: null, tracked: false }, signal));
    }
    const complete = plans.every((p) => p.uncovered.length === 0 && !p.problems.length);
    const result: IngestResult = { plan: { files: plans, toDelete: [], kept: [], problems: [] }, stored: [], merged: [], conflicts: [], retired: [], deleted: [], backedUp: [], dryRun: false };
    await this.apply(result.plan, result, signal);
    let backupDir: string | undefined;
    if (complete && this.s.layout) {
      const project = basename(dirname(dir));
      backupDir = join(this.s.layout.backupsDir, "auto-memory", project, this.s.clock().toISOString().replace(/[:.]/g, "-"));
      ensureDir(backupDir);
      for (const abs of notes) {
        copyFileSync(abs, join(backupDir, basename(abs)));
        removeFile(abs);
      }
    }
    this.s.telemetry?.event("auto_memory.import", { files: notes.length, items: result.stored.length, complete });
    return { files: notes.length, items: result.stored.length, backupDir };
  }
}
