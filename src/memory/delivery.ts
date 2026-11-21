/**
 * Just-in-time delivery of path memories (§6.8.5), the push budget (§6.10.2), the pre-edit
 * gate (§6.10.3) and the always-on "Project rules" section (§6.9.5).
 */
import type { MemoryNode, ScopedNode, ScopeName, TriggerAction, Urgency } from "../core/types.ts";
import { bracket } from "../util/ids.ts";
import { commandMatcher } from "../util/glob.ts";
import { analyzeCommand, type CommandEffects, normalizeCommandParts } from "../util/shell.ts";
import { estimateTokens } from "../util/text.ts";
import { day } from "./cards.ts";
import { type Covering, ROOT_GLOB } from "./paths.ts";
import type { MemoryServices } from "./services.ts";
import { memoryWorth, strengthAt } from "./strength.ts";
import { effectiveUrgency } from "./urgency.ts";

export type PathAction = "read" | "list" | "edit" | "command";

export interface PathEvent {
  action: PathAction;
  /** Repo-relative paths taken from the tool arguments or parsed from the command. */
  paths: string[];
  /** bash: the command line. */
  command?: string;
  effects?: CommandEffects;
}

export interface Shown {
  ref: ScopedNode;
  full: boolean;
  tokens: number;
}

export interface PathBlock {
  text: string;
  shown: Shown[];
  tokens: number;
  omitted: number;
}

export interface GateDecision {
  reason: string;
  refs: ScopedNode[];
}

interface Considered {
  ref: ScopedNode;
  /** Where the memory applies: anchor display path, or the command pattern that matched. */
  at: string;
  depth: number;
  role: "applies" | "about";
  changed: boolean;
  urgency: Urgency;
  viaCommand?: string;
}

const SEVERITY_RANK: Record<string, number> = { must: 0, should: 1, may: 2, info: 3 };
const URGENCY_RANK: Record<Urgency, number> = { immediate: 0, hint: 1, caption: 2, passive: 3 };
const FACTS_PER_FILE = 3;

const key = (ref: ScopedNode) => `${ref.scope}:${ref.node.id}`;

export function commandActions(parts: string[]): Set<TriggerAction> {
  const out = new Set<TriggerAction>(["command"]);
  for (const p of parts) {
    if (/^git\s+commit\b/.test(p)) out.add("commit");
    if (/(^|\s)(test|tests|pytest|jest|vitest|mocha|rspec|phpunit|tox)(\s|$|:)|\b(cargo|go|npm|pnpm|yarn|bun|dotnet|mvn|gradle|make)\s+(run\s+)?test\b/.test(p)) out.add("test");
  }
  return out;
}

function ruleLabel(n: MemoryNode): string {
  return n.kind === "rule" ? (n.severity ?? "should").toUpperCase().padEnd(6) : "";
}

export class PathDelivery {
  private readonly s: MemoryServices;

  constructor(services: MemoryServices) {
    this.s = services;
  }

  /** Whether a memory's `triggers.on` lets this action bring it up (unset: by role). */
  private triggered(n: MemoryNode, actions: Set<TriggerAction>): boolean {
    const on = n.triggers?.on;
    if (!on?.length) return true;
    return on.some((a) => actions.has(a));
  }

  /** Memories whose command patterns match a part of the (normalized) command line (§6.10.3). */
  commandMatches(command: string, scopes?: ScopeName[]): Array<{ ref: ScopedNode; pattern: string }> {
    const parts = normalizeCommandParts(command);
    if (!parts.length) return [];
    const out: Array<{ ref: ScopedNode; pattern: string }> = [];
    for (const ref of this.s.graph.active(scopes)) {
      const patterns = ref.node.triggers?.commands;
      if (!patterns?.length) continue;
      const hit = patterns.find((pat) => parts.some((part) => commandMatcher(pat)(part)));
      if (hit) out.push({ ref, pattern: hit });
    }
    return out;
  }

  /** Everything an event could bring up, before urgency, repeats and budgets are applied. */
  consider(event: PathEvent): Considered[] {
    const cfg = this.s.cfg;
    const out = new Map<string, Considered>();
    const add = (c: Considered) => {
      // a learned memory that contradicts an ingested instruction waits for review: the instruction wins (§6.9.2)
      if (c.ref.node.flags?.includes("conflicts-instruction")) return;
      const k = key(c.ref);
      const cur = out.get(k);
      // keep the most specific location for a memory that is reached several ways
      if (!cur || c.depth > cur.depth) out.set(k, c);
    };
    const actions: Set<TriggerAction> = event.action === "command" ? commandActions(normalizeCommandParts(event.command ?? "")) : new Set<TriggerAction>([event.action === "list" ? "read" : event.action]);
    const fromCover = (c: Covering): Considered => ({ ref: { scope: c.scope, node: c.node }, at: c.at, depth: c.depth, role: c.anchor.role, changed: c.changed, urgency: effectiveUrgency(c.node, cfg) });
    for (const path of event.paths) {
      for (const c of this.s.paths.covering(path)) {
        if (!this.triggered(c.node, actions)) continue;
        // facts describe a file; rules apply from each directory down to it
        if (c.anchor.role === "about" && c.anchor.kind === "subtree" && event.action !== "list" && c.at !== `${path}/**`) {
          // a fact about a directory is not repeated for every file below it
          continue;
        }
        add(fromCover(c));
      }
    }
    if (event.action === "command" && event.command) {
      for (const m of this.commandMatches(event.command)) add({ ref: m.ref, at: `\`${m.pattern}\``, depth: 99, role: "applies", changed: false, urgency: effectiveUrgency(m.ref.node, cfg), viaCommand: m.pattern });
      // memories brought up by the kind of action alone ("before committing, …")
      for (const ref of this.s.graph.active()) {
        const on = ref.node.triggers?.on;
        if (!on?.length || ref.node.anchors.length || ref.node.triggers?.commands?.length) continue;
        if (on.some((a) => a !== "command" && a !== "read" && a !== "edit" && actions.has(a))) add({ ref, at: `on ${on.filter((a) => actions.has(a)).join("/")}`, depth: 98, role: "applies", changed: false, urgency: effectiveUrgency(ref.node, cfg) });
      }
    }
    return [...out.values()];
  }

  /**
   * Build the `[paths]` block for a tool result.
   * `visible` says whether an earlier delivery of the memory is still in context (no repeats);
   * `turnTokensLeft` is what remains of the per-turn budget.
   */
  block(event: PathEvent, ctx: { visible: (id: string) => boolean; turnTokensLeft: number; extra?: Considered[] }): PathBlock | null {
    const cfg = this.s.cfg.paths;
    if (!cfg.deliver) return null;
    const now = this.s.clock();
    let items = [...this.consider(event), ...(ctx.extra ?? [])].filter((c) => c.urgency !== "passive" && !ctx.visible(c.ref.node.id));
    if (!items.length) return null;
    // up to 3 facts per event, the most valuable first
    const value = (n: MemoryNode) => (0.5 + memoryWorth(n.counters).mw) * (0.2 + 0.8 * strengthAt(n, now));
    const facts = items.filter((c) => c.role === "about").sort((a, b) => value(b.ref.node) - value(a.ref.node));
    const dropped = new Set(facts.slice(FACTS_PER_FILE).map((c) => key(c.ref)));
    let omitted = dropped.size;
    items = items.filter((c) => !dropped.has(key(c.ref)));

    // budget, filled in urgency order: immediate, then hint by severity, then caption
    const budget = Math.max(0, Math.min(cfg.perResultTokens, ctx.turnTokensLeft));
    const order = [...items].sort((a, b) => URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency] || (SEVERITY_RANK[a.ref.node.severity ?? "info"] ?? 3) - (SEVERITY_RANK[b.ref.node.severity ?? "info"] ?? 3) || b.depth - a.depth);
    const mode = new Map<string, "full" | "caption">();
    let used = estimateTokens(`[paths] ${event.paths[0] ?? event.command ?? ""}`);
    for (const c of order) {
      const full = this.line(c, true);
      const caption = this.line(c, false);
      const want = c.urgency === "caption" ? "caption" : "full";
      const tFull = estimateTokens(full);
      const tCap = estimateTokens(caption);
      if (c.urgency === "immediate") {
        // never cut
        mode.set(key(c.ref), "full");
        used += tFull;
      } else if (want === "full" && used + tFull <= budget) {
        mode.set(key(c.ref), "full");
        used += tFull;
      } else if (used + tCap <= budget) {
        // hints that do not fit are shown as captions instead
        mode.set(key(c.ref), "caption");
        used += tCap;
      } else omitted++;
    }
    const kept = items.filter((c) => mode.has(key(c.ref)));
    if (!kept.length) return null;

    // render from the root down to the file; a deeper rule that conflicts with a shallower one is marked
    const groups = new Map<string, Considered[]>();
    for (const c of kept.sort((a, b) => a.depth - b.depth || a.at.localeCompare(b.at))) groups.set(c.at, [...(groups.get(c.at) ?? []), c]);
    const lines: string[] = [`[paths] ${event.paths.slice(0, 3).join(", ") || (event.command ?? "").slice(0, 80)}`];
    const shown: Shown[] = [];
    const seenIds = new Set<string>();
    for (const [at, list] of groups) {
      const sources = new Set(list.map((c) => c.ref.node.source?.file).filter(Boolean));
      const overrides: string[] = [];
      for (const c of list) {
        if (c.ref.node.kind !== "rule") continue;
        for (const other of this.s.graph.contradictions(c.ref)) if (seenIds.has(other.node.id)) overrides.push(bracket("m", other.node.id));
      }
      lines.push(`${at}${sources.size === 1 ? ` (from ${[...sources][0]})` : ""}${overrides.length ? ` · overrides ${[...new Set(overrides)].join(", ")} here` : ""}`);
      list.sort((a, b) => (a.ref.node.kind === "rule" ? 0 : 1) - (b.ref.node.kind === "rule" ? 0 : 1) || (SEVERITY_RANK[a.ref.node.severity ?? "info"] ?? 3) - (SEVERITY_RANK[b.ref.node.severity ?? "info"] ?? 3));
      for (const c of list) {
        const full = mode.get(key(c.ref)) === "full";
        const line = this.line(c, full);
        lines.push(line);
        shown.push({ ref: c.ref, full, tokens: estimateTokens(line) });
        seenIds.add(c.ref.node.id);
      }
    }
    if (omitted > 0) lines.push(`+${omitted} more: search(path: "${event.paths[0] ?? "."}")`);
    const text = lines.join("\n");
    return { text, shown, tokens: estimateTokens(text), omitted };
  }

  private line(c: Considered, full: boolean): string {
    const n = c.ref.node;
    const id = bracket("m", n.id);
    if (!full) return `- ${id} ${n.title || n.text.split("\n")[0]}`;
    if (n.kind === "rule") return `- ${ruleLabel(n)} ${id} ${n.text}`;
    const tags = [n.kind, `as of ${day(n.validFrom ?? n.createdAt)}`];
    if (c.changed) tags.push("⚠ file changed since");
    return `- ${id} ${tags.join(" · ")}: ${n.text}`;
  }

  // ───────────── the pre-edit gate (§6.10.3)
  /**
   * Decide whether a tool call must be blocked once so an `immediate` memory is seen before
   * the action. `gated` holds memories that already gated in this intent (or this user turn in
   * the root region); `shownFull` those already shown in full in this intent.
   */
  gate(event: PathEvent, ctx: { gated: (id: string) => boolean; shownFull: (id: string) => boolean }): GateDecision | null {
    if (this.s.cfg.urgency.gate === "off") return null;
    if (event.action !== "edit" && event.action !== "command") return null;
    const hits = new Map<string, ScopedNode>();
    const immediate = (n: MemoryNode) => !n.flags?.includes("conflicts-instruction") && effectiveUrgency(n, this.s.cfg) === "immediate";
    const edits = new Set<TriggerAction>(["edit"]);
    if (event.action === "edit") {
      for (const path of event.paths) for (const c of this.s.paths.covering(path)) if (immediate(c.node) && this.triggered(c.node, edits)) hits.set(key({ scope: c.scope, node: c.node }), { scope: c.scope, node: c.node });
    } else if (event.command) {
      for (const m of this.commandMatches(event.command)) if (immediate(m.ref.node)) hits.set(key(m.ref), m.ref);
      // writes the shell parser sees: redirects, sed -i, tee, mv, cp, rm, git checkout/restore
      const fx = event.effects ?? analyzeCommand(event.command, { cwd: this.s.graph.project.cwd });
      const written = [...fx.writes, ...fx.deletes, ...fx.moves.flatMap((m) => [m.from, m.to]), ...fx.copies.map((c) => c.to), ...fx.mkdirs];
      for (const abs of written) {
        const rel = this.s.paths.rel(abs);
        if (rel === null) continue;
        for (const c of this.s.paths.covering(rel)) if (immediate(c.node) && this.triggered(c.node, edits)) hits.set(key({ scope: c.scope, node: c.node }), { scope: c.scope, node: c.node });
      }
    }
    const refs = [...hits.values()].filter((r) => !ctx.gated(r.node.id) && !ctx.shownFull(r.node.id));
    if (!refs.length) return null;
    refs.sort((a, b) => (SEVERITY_RANK[a.node.severity ?? "info"] ?? 3) - (SEVERITY_RANK[b.node.severity ?? "info"] ?? 3));
    const what = event.action === "edit" ? "this edit" : "this command";
    const body = refs.map((r) => `${r.node.kind === "rule" ? `${(r.node.severity ?? "should").toUpperCase()} ` : ""}${bracket("m", r.node.id)} ${r.node.text}`).join("\n");
    return { reason: `[gate] Before ${what}: ${body}${refs.length > 1 ? "\n" : " "}If the action still complies, repeat it.`, refs };
  }

  // ───────────── always-on rules (§6.9.5)
  /**
   * Rules anchored at the repo root or at an ancestor of the working directory, rendered by
   * urgency within the budget. From the shared scope only ingested instruction rules qualify,
   * and only in a trusted project (§7.12).
   */
  projectRules(): { text: string; ids: string[]; overflow: string[] } {
    const g = this.s.graph;
    const cwdRel = g.project.root ? (this.s.paths.rel(g.project.cwd) ?? "") : "";
    const chosen = new Map<string, { ref: ScopedNode; depth: number; at: string }>();
    const consider = (ref: ScopedNode, depth: number, at: string) => {
      const n = ref.node;
      if (n.kind !== "rule" || n.status !== "active") return;
      if (ref.scope === "shared" && n.origin !== "instructions") return;
      if (!chosen.has(key(ref))) chosen.set(key(ref), { ref, depth, at });
    };
    // anchors that cover the working directory itself: the root glob and subtrees above it
    for (const c of this.s.paths.covering(cwdRel ? `${cwdRel}/.` : ".", { roles: ["applies"] })) {
      if (c.anchor.kind === "glob" && c.anchor.glob !== ROOT_GLOB) continue;
      if (c.anchor.kind !== "glob" && c.anchor.kind !== "subtree") continue;
      consider({ scope: c.scope, node: c.node }, c.depth, c.at);
    }
    // ingested rules without any anchor apply everywhere (home-directory instruction files)
    for (const ref of g.active()) if (ref.node.origin === "instructions" && ref.node.kind === "rule" && !ref.node.anchors.length && ref.scope !== "shared") consider(ref, 0, ROOT_GLOB);
    const cfg = this.s.cfg;
    const rules = [...chosen.values()].filter((r) => effectiveUrgency(r.ref.node, cfg) !== "passive");
    rules.sort((a, b) => URGENCY_RANK[effectiveUrgency(a.ref.node, cfg)] - URGENCY_RANK[effectiveUrgency(b.ref.node, cfg)] || (SEVERITY_RANK[a.ref.node.severity ?? "info"] ?? 3) - (SEVERITY_RANK[b.ref.node.severity ?? "info"] ?? 3) || a.depth - b.depth || (a.ref.node.id < b.ref.node.id ? -1 : 1));
    const budget = cfg.instructions.alwaysOnTokens;
    const lines: string[] = [];
    const ids: string[] = [];
    const overflow: string[] = [];
    let used = 0;
    for (const r of rules) {
      const n = r.ref.node;
      const caption = effectiveUrgency(n, cfg) === "caption";
      const where = r.depth > 0 ? ` (${r.at})` : "";
      const line = caption ? `- ${bracket("m", n.id)} ${n.title}${where}` : `- ${ruleLabel(n)} ${bracket("m", n.id)} ${n.text}${where}`;
      const t = estimateTokens(line);
      if (used + t > budget) {
        overflow.push(n.id); // delivered by path relevance instead
        continue;
      }
      used += t;
      lines.push(line);
      ids.push(n.id);
    }
    return { text: lines.join("\n"), ids, overflow };
  }

  /** Rules in force at a path, from the root down (`/realctx2 rules [path]`). */
  rulesAt(path: string): Array<{ ref: ScopedNode; at: string; depth: number }> {
    return this.s.paths
      .covering(path, { roles: ["applies"] })
      .filter((c) => c.node.kind === "rule")
      .sort((a, b) => a.depth - b.depth)
      .map((c) => ({ ref: { scope: c.scope, node: c.node }, at: c.at, depth: c.depth }));
  }
}

export type { Considered };
