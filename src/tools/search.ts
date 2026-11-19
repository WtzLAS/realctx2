/** `search` (§8.1.1): one tool over memories and earlier turns; quick (§6.4.2) or thorough (§6.4.4). */
import type { ScopedNode, ScopeName, ToolCallContext, ToolResultPayload } from "../core/types.ts";
import type { PendingDelivery } from "../context/engine.ts";
import { captionLine, day, renderCards } from "../memory/cards.ts";
import { scopeLabel } from "../memory/graph.ts";
import { type Hit, renderViewCard, type TurnHit } from "../memory/retrieve.ts";
import type { TurnRow } from "../storage/turnindex.ts";
import { parseId } from "../util/ids.ts";
import { clipTokens, estimateTokens } from "../util/text.ts";
import { fail, int, ok, oneOf, projectSessions, str, strList, type ToolEnv } from "./env.ts";

const SCOPES: ScopeName[] = ["global", "personal", "shared"];

export interface SearchParams {
  query: string;
  memory: boolean;
  turns: boolean;
  where: "session" | "project";
  mode: "quick" | "thorough";
  scopes?: ScopeName[];
  path?: string;
  history: boolean;
  limit: number;
  budget: number;
}

export function parseSearch(env: ToolEnv, p: Record<string, unknown>, aux: boolean): SearchParams | string {
  const query = str(p.query);
  if (!query) return "search needs a `query`.";
  const within = strList(p.in).filter((x) => x === "memory" || x === "turns");
  // aux sessions get quick mode only: thorough mode would start aux work of its own (§9.3.2)
  const mode = aux ? "quick" : (oneOf(p.mode, ["quick", "thorough"] as const) ?? "quick");
  const scopes = strList(p.scopes).filter((s): s is ScopeName => (SCOPES as string[]).includes(s));
  const s = env.cfg.memory.search;
  return {
    query,
    memory: within.length ? within.includes("memory") : true,
    turns: within.length ? within.includes("turns") : true,
    where: oneOf(p.where, ["session", "project"] as const) ?? "session",
    mode,
    scopes: scopes.length ? scopes : undefined,
    path: str(p.path),
    history: p.history === true,
    limit: int(p.limit, 8, 1, 20),
    budget: int(p.budget_tokens, mode === "thorough" ? s.thoroughTokens : s.quickTokens, 200, 6000),
  };
}

function when(iso: string): string {
  return iso ? iso.slice(0, 16).replace("T", " ") : "?";
}

function turnLabel(env: ToolEnv, row: TurnRow): string {
  const parts: string[] = [];
  if (row.kind === "raw") parts.push(row.tool ? `tool ${row.tool}` : (row.role ?? "entry"));
  else parts.push(row.kind === "precip" ? "consolidated intent" : row.kind === "palim" ? "consolidated earlier work" : "compacted earlier work");
  parts.push(when(row.at));
  if (row.session !== env.sessionId) parts.push("earlier session");
  return parts.join(" · ");
}

/** Turn snippets: the hit, then one-line context from the ±2 surrounding entries (§6.4.3 step 6). */
function renderTurns(env: ToolEnv, hits: TurnHit[], budget: number): { text: string; shown: Array<{ row: TurnRow; text: string }> } {
  const turns = env.memory?.turns;
  const blocks: string[] = [];
  const shown: Array<{ row: TurnRow; text: string }> = [];
  let used = 0;
  const per = Math.max(60, Math.min(220, Math.floor(budget / Math.max(1, hits.length))));
  for (const h of hits) {
    const row = h.row;
    const snippet = clipTokens(row.text.replace(/\s*\n\s*/g, " ⏎ "), per);
    const lines = [`[${row.id}] ${turnLabel(env, row)}: ${snippet}`];
    if (row.kind === "raw" && turns) {
      const seen = new Set<string>([row.entry ?? row.id]);
      for (const nb of turns.neighbors(row, 2)) {
        if (nb.chunk !== 0 || seen.has(nb.entry ?? nb.id)) continue;
        seen.add(nb.entry ?? nb.id);
        lines.push(`  ${nb.seq < row.seq ? "↑" : "↓"} [${nb.id}] ${nb.tool ? `tool ${nb.tool}` : (nb.role ?? "entry")}: ${clipTokens(nb.text.replace(/\s+/g, " "), 24)}`);
      }
    }
    // context lines are dropped before the hit itself is
    let block = lines.join("\n");
    if (used + estimateTokens(block) > budget) block = lines[0]!;
    const t = estimateTokens(block);
    if (used + t > budget) break;
    used += t;
    blocks.push(block);
    shown.push({ row, text: snippet });
  }
  return { text: blocks.join("\n"), shown };
}

function sessionsFor(env: ToolEnv, where: "session" | "project"): string[] {
  return where === "project" ? projectSessions(env).map((s) => s.id) : [env.sessionId];
}

export async function runSearch(env: ToolEnv, raw: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResultPayload> {
  const p = parseSearch(env, raw, ctx.aux === true);
  if (typeof p === "string") return fail(p);
  const mem = env.memory;
  if (!mem) return fail("Memory is not available in this session.");
  const count = ctx.aux !== true;
  const sessions = sessionsFor(env, p.where);
  const relPath = p.path ? (mem.paths.rel(p.path) ?? undefined) : undefined;
  const deliveries: PendingDelivery[] = [];
  const cardDelivery = (ref: ScopedNode, full: boolean): PendingDelivery => ({ id: `m:${ref.node.id}`, kind: "card", channel: "search", nodeIds: [ref.node.id], scope: ref.scope, text: full ? ref.node.text : ref.node.title, signature: ref.node.signature, full });

  if (p.mode === "thorough") {
    const res = await mem.thorough.run(p.query, { memory: p.memory, turns: p.turns, scopes: p.scopes, sessions, path: relPath, history: p.history, count, budgetTokens: p.budget, signal: ctx.signal });
    if (!res.degraded) {
      const lines = res.cards.map(renderViewCard);
      lines.push(res.sufficient ? "Sufficient: the cards above cover the question." : `Missing: ${res.missing.length ? res.missing.join("; ") : "the evidence found does not settle the question"}`);
      const seen = new Set<string>();
      for (const c of res.cards) {
        for (const s of c.sources) {
          const id = parseId(s);
          if (!id || seen.has(id.full)) continue;
          seen.add(id.full);
          if (id.type === "m") {
            const ref = mem.graph.get(id.id);
            if (ref) deliveries.push({ ...cardDelivery(ref, false), text: c.claim });
          } else deliveries.push({ id: id.full, kind: "found", channel: "search", text: c.claim });
        }
      }
      return ok(lines.join("\n\n") || "Nothing relevant was found.", {
        mode: "thorough",
        rounds: res.rounds,
        sufficient: res.sufficient,
        missing: res.missing,
        plan: res.plan,
        cards: res.cards.map((c) => ({ role: c.role, sources: c.sources, verified: c.verified })),
        deliveries: count ? deliveries : [],
      });
    }
    // no aux model: the retrieved evidence is shown as in quick mode
    return quick(env, p, { memoryHits: res.memoryHits, turnHits: res.turnHits }, count, "(thorough mode needs the aux model, which is unavailable: showing the quick results)\n\n", relPath);
  }
  const memoryHits = p.memory ? await mem.retriever.retrieve(p.query, { scopes: p.scopes, limit: p.limit, path: relPath, history: p.history, count, signal: ctx.signal }) : [];
  const turnHits = p.turns ? await mem.retriever.searchTurns(p.query, { sessions, limit: p.limit, signal: ctx.signal }) : [];
  return quick(env, p, { memoryHits, turnHits }, count, "", relPath);
}

function quick(env: ToolEnv, p: SearchParams, found: { memoryHits: Hit[]; turnHits: TurnHit[] }, count: boolean, note: string, relPath: string | undefined): ToolResultPayload {
  const mem = env.memory!;
  const deliveries: PendingDelivery[] = [];
  const sections: string[] = [];
  const memoryHits = found.memoryHits.slice(0, p.limit);
  const turnHits = found.turnHits.slice(0, p.limit);
  // the budget is shared: memories first, turns get at least a third when both were asked for
  const turnShare = turnHits.length ? (memoryHits.length ? Math.floor(p.budget / 3) : p.budget) : 0;
  let left = p.budget;
  if (relPath !== undefined && p.memory) {
    // `path` also brings the rules in force there, root first (§6.8.5)
    const rules = mem.delivery.rulesAt(relPath).filter((r) => r.ref.node.status === "active" && !memoryHits.some((h) => h.ref.node.id === r.ref.node.id));
    if (rules.length) {
      const lines: string[] = [];
      for (const r of rules) {
        const line = `${r.at || "(repo)"}: ${r.ref.node.severity ? `${r.ref.node.severity.toUpperCase()} ` : ""}${captionLine(r.ref)}`;
        if (estimateTokens(lines.join("\n")) + estimateTokens(line) > Math.floor(p.budget / 4)) break;
        lines.push(line);
        deliveries.push({ id: `m:${r.ref.node.id}`, kind: "card", channel: "search", nodeIds: [r.ref.node.id], scope: r.ref.scope, text: r.ref.node.title, signature: r.ref.node.signature, full: false });
      }
      sections.push(`Rules in force at ${relPath || "the repository root"}:\n${lines.join("\n")}`);
      left -= estimateTokens(sections[0]!);
    }
  }
  let cards: ReturnType<typeof renderCards> | null = null;
  if (memoryHits.length) {
    cards = renderCards(memoryHits.map((h) => h.ref), mem.graph, mem.paths, { budgetTokens: Math.max(100, left - turnShare), history: p.history });
    if (cards.text) {
      sections.push(`Memory:\n${cards.text}${cards.omitted ? `\n(+${cards.omitted} more: narrow the query or raise budget_tokens)` : ""}`);
      left -= estimateTokens(cards.text);
      for (const s of cards.shown) deliveries.push({ id: `m:${s.ref.node.id}`, kind: "card", channel: "search", nodeIds: [s.ref.node.id], scope: s.ref.scope, text: s.full ? s.ref.node.text : s.ref.node.title, signature: s.ref.node.signature, full: s.full });
    }
  }
  let turns: ReturnType<typeof renderTurns> | null = null;
  if (turnHits.length) {
    turns = renderTurns(env, turnHits, Math.max(100, left));
    if (turns.text) {
      sections.push(`Turns (${p.where === "project" ? "this project's sessions" : "this session"}):\n${turns.text}`);
      for (const s of turns.shown) deliveries.push({ id: s.row.id, kind: "found", channel: "search", text: s.text });
    }
  }
  if (!sections.length) {
    const hints: string[] = [];
    if (p.where === "session" && p.turns) hints.push('where: "project" also covers earlier sessions');
    if (!p.history && p.memory) hints.push("history: true includes superseded memories");
    return ok(`${note}Nothing relevant was found.${hints.length ? ` (${hints.join("; ")})` : ""}`, { mode: "quick", memory: [], turns: [], deliveries: [] });
  }
  return ok(note + sections.join("\n\n"), {
    mode: "quick",
    memory: (cards?.shown ?? []).map((s) => {
      const h = memoryHits.find((x) => x.ref.node.id === s.ref.node.id);
      return { id: `m:${s.ref.node.id}`, scope: scopeLabel(s.ref.scope), layer: s.ref.node.layer, kind: s.ref.node.kind, urgency: s.ref.node.urgency, score: h ? Math.round(h.score * 1000) / 1000 : undefined, asOf: day(s.ref.node.validFrom ?? s.ref.node.createdAt), full: s.full };
    }),
    turns: (turns?.shown ?? []).map((s) => ({ id: s.row.id, kind: s.row.kind, session: s.row.session, at: s.row.at, score: Math.round((turnHits.find((h) => h.row.id === s.row.id)?.score ?? 0) * 1000) / 1000 })),
    deliveries: count ? deliveries : [],
  });
}
