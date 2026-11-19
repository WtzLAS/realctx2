/** `recall` (§8.1.1, §5.6): the content one level down, at most 4,000 tokens per page. */
import type { ConsolidationRecord, EntryView, ToolCallContext, ToolResultPayload } from "../core/types.ts";
import { BlobStore, PAGE_TOKENS, paginate, pickPage, renderLayer } from "../context/archive.ts";
import type { PendingDelivery } from "../context/engine.ts";
import { renderEntry } from "../context/render.ts";
import { SessionState } from "../context/state.ts";
import { renderCard } from "../memory/cards.ts";
import { rawTurnId, type TurnRow } from "../storage/turnindex.ts";
import { parseIdLoose } from "../util/ids.ts";
import { clipTokens } from "../util/text.ts";
import { fail, int, ok, projectSessions, str, type ToolEnv } from "./env.ts";

export interface Located {
  record: ConsolidationRecord;
  state: SessionState;
  entries: EntryView[];
  sessionId: string;
  /** False when the record belongs to another session of this project. */
  current: boolean;
}

/** Find a consolidation record: on this branch first, then in the session it was indexed under. */
export async function locateRecord(env: ToolEnv, id: string): Promise<Located | { missing: string }> {
  const here = env.engine?.state.records.get(id);
  if (here) return { record: here, state: env.engine!.state, entries: await env.entries(), sessionId: env.sessionId, current: true };
  const row = env.memory?.turns?.get(id);
  if (row && row.session !== env.sessionId && env.loadSession) {
    const session = projectSessions(env).find((s) => s.id === row.session);
    const loaded = session ? await env.loadSession(session).catch(() => null) : null;
    if (loaded) {
      const state = SessionState.from(loaded.records);
      const record = state.records.get(id);
      if (record) return { record, state, entries: loaded.entries, sessionId: row.session, current: false };
    }
  }
  if (row) return { missing: `[${id}] ${row.text}\n\n(This consolidation is from ${row.session === env.sessionId ? "another branch of this session" : "an earlier session"}; its layer cannot be opened here. search still finds its raw turns.)` };
  return { missing: `[${id}] is not available here. Consolidated turns are kept on the machine and in the session that made them: this ID may come from another machine, or its session state was lost. search still finds raw turns that are indexed here.` };
}

function paged(header: (page: number, pages: number) => string, text: string, page: number | undefined, lookingFor: string | undefined): { text: string; page: number; pages: number } {
  const pages = paginate(text, PAGE_TOKENS);
  const n = pickPage(pages, page, lookingFor);
  const more = n < pages.length ? `\n[page ${n} of ${pages.length}: recall with page: ${n + 1} continues]` : "";
  return { text: `${header(n, pages.length)}\n${pages[n - 1] ?? ""}${more}`, page: n, pages: pages.length };
}

function groupByEntry(rows: TurnRow[]): Array<{ key: string; rows: TurnRow[] }> {
  const out: Array<{ key: string; rows: TurnRow[] }> = [];
  for (const r of rows) {
    const key = r.entry ?? r.id;
    const last = out[out.length - 1];
    if (last && last.key === key) last.rows.push(r);
    else out.push({ key, rows: [r] });
  }
  return out;
}

function rowHead(r: TurnRow): string {
  return r.tool ? `tool ${r.tool}` : (r.role ?? "entry");
}

export async function runRecall(env: ToolEnv, raw: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResultPayload> {
  const id = parseIdLoose(str(raw.id) ?? "");
  if (!id) return fail("recall needs an `id` such as m:7f3a9k2d, t:…, r:… or o:… (brackets are optional).");
  const page = raw.page === undefined ? undefined : int(raw.page, 1, 1, 10_000);
  const lookingFor = str(raw.looking_for);
  const count = ctx.aux !== true;
  const deliveries: PendingDelivery[] = [];
  const done = (text: string, details: Record<string, unknown>) => ok(text, { id: id.full, ...details, deliveries: count ? deliveries : [] });

  if (id.type === "m") {
    const mem = env.memory;
    const ref = mem?.graph.get(id.id);
    if (!mem || !ref) {
      const aliases = mem?.graph.aliasesOf(id.id) ?? [];
      if (aliases.length) return fail(`[${id.full}] was re-keyed after an ID collision: see ${aliases.map((a) => `[m:${a.node.id}]`).join(", ")}.`);
      return fail(`No memory [${id.full}] is visible here. It may be purged, or belong to a scope that is not loaded in this project.`);
    }
    // the full text, with every evidence quote and its verification flag
    const text = renderCard(ref, mem.graph, mem.paths, { full: true, quotes: 50, history: true });
    if (count) {
      // explicit expansion: counts as access (§6.4.3) and as the `expanded` signal (§5.5.3)
      mem.accounting.bump(ref.scope, ref.node.id, "expanded", 1);
      mem.accounting.touch(ref.scope, ref.node.id);
    }
    deliveries.push({ id: id.full, kind: "card", channel: "recall", nodeIds: [ref.node.id], scope: ref.scope, text: ref.node.text, signature: ref.node.signature, full: true });
    const out = paged((n, of) => (of > 1 ? `[${id.full} · page ${n}/${of}]` : ""), text, page, lookingFor);
    return done(out.text.replace(/^\n/, ""), { type: "memory", scope: ref.scope, page: out.page, pages: out.pages });
  }

  if (id.type === "t") {
    const found = await locateRecord(env, id.full);
    if ("missing" in found) return fail(found.missing);
    const entries = new Map(found.entries.map((e) => [e.id, e] as [string, EntryView]));
    const layer = renderLayer(found.record, found.state, entries, found.sessionId);
    const kind = found.record.kind === "precip" ? "consolidated intent" : found.record.kind === "palim" ? "consolidated earlier work" : "compacted earlier work";
    const out = paged((n, of) => `[${id.full} · ${kind} · one layer down · ${found.record.children.length} items${of > 1 ? ` · page ${n}/${of}` : ""}]`, layer, page, lookingFor);
    deliveries.push({ id: id.full, kind: "archive", channel: "recall", text: out.text });
    return done(out.text, { type: "consolidation", kind: found.record.kind, session: found.sessionId, children: found.record.children.length, page: out.page, pages: out.pages });
  }

  if (id.type === "r") {
    const turns = env.memory?.turns;
    const row = turns?.get(id.full) ?? null;
    if (row && turns) {
      // the whole entry (all of its chunks), with ±2 neighboring entries for context
      const own = turns.byEntry(row.session, row.entry ?? "");
      const body = (own.length ? own : [row]).map((r) => r.text).join("\n");
      const around = groupByEntry(turns.neighbors(row, 2));
      const parts: string[] = [];
      for (const g of around) {
        const first = g.rows[0]!;
        if (g.key === (row.entry ?? row.id)) parts.push(`[${rawTurnId(row.session, row.entry ?? "")}] ${rowHead(row)}: ${body}`);
        else parts.push(`[${first.id}] ${rowHead(first)}: ${clipTokens(g.rows.map((r) => r.text).join("\n"), 300)}`);
      }
      if (!parts.length) parts.push(`[${id.full}] ${rowHead(row)}: ${body}`);
      const out = paged((n, of) => `[${id.full} · raw turn · ${row.at.slice(0, 16).replace("T", " ")}${row.session !== env.sessionId ? " · earlier session" : ""}${of > 1 ? ` · page ${n}/${of}` : ""}]`, parts.join("\n\n"), page, lookingFor);
      deliveries.push({ id: id.full, kind: "archive", channel: "recall", text: out.text });
      return done(out.text, { type: "raw", session: row.session, entry: row.entry, page: out.page, pages: out.pages });
    }
    // not indexed (yet): entries of this session can still be opened from the transcript
    const entries = await env.entries();
    const at = entries.findIndex((e) => rawTurnId(env.sessionId, e.id) === id.full);
    if (at >= 0) {
      const parts: string[] = [];
      for (let i = Math.max(0, at - 2); i <= Math.min(entries.length - 1, at + 2); i++) {
        const e = entries[i]!;
        parts.push(`[${rawTurnId(env.sessionId, e.id)}] ${i === at ? renderEntry(e, { raw: true, toolOutputTokens: PAGE_TOKENS }) : renderEntry(e, { raw: true, toolOutputTokens: 120, textTokens: 300 })}`);
      }
      const out = paged((n, of) => `[${id.full} · raw turn${of > 1 ? ` · page ${n}/${of}` : ""}]`, parts.join("\n\n"), page, lookingFor);
      deliveries.push({ id: id.full, kind: "archive", channel: "recall", text: out.text });
      return done(out.text, { type: "raw", session: env.sessionId, entry: entries[at]!.id, page: out.page, pages: out.pages });
    }
    return fail(`[${id.full}] is not in this machine's turn index. Raw-turn IDs are valid only on the machine that recorded them; an ID from a shared memory's provenance may be from another machine.`);
  }

  // o: a stored oversized tool output (§5.4.6)
  const stores: BlobStore[] = [];
  if (env.engine) stores.push(env.engine.blobs);
  for (const s of projectSessions(env)) if (s.id !== env.sessionId) stores.push(new BlobStore(env.layout.blobDir(s.id)));
  for (const store of stores) {
    const meta = store.meta(id.full);
    const text = meta ? store.read(id.full) : null;
    if (!meta || text === null) continue;
    const out = paged((n, of) => `[${id.full} · stored output${meta.tool ? ` of ${meta.tool}` : ""} · ${meta.tokens} tokens · page ${n}/${of}]`, text, page, lookingFor);
    deliveries.push({ id: id.full, kind: "archive", channel: "recall", text: out.text });
    return done(out.text, { type: "output", tool: meta.tool, tokens: meta.tokens, page: out.page, pages: out.pages });
  }
  return fail(`[${id.full}] is not stored on this machine. Stored tool outputs stay with the session that produced them.`);
}
