/** `inspect` (§8.1.1): metadata about any ID — memories, consolidated turns, raw turns, stored outputs. */
import type { ScopedNode, ToolCallContext, ToolResultPayload } from "../core/types.ts";
import { reachableEntries } from "../context/archive.ts";
import { BlobStore } from "../context/archive.ts";
import type { PendingDelivery } from "../context/engine.ts";
import { outcomeWord } from "../context/render.ts";
import { day, mid } from "../memory/cards.ts";
import { scopeLabel } from "../memory/graph.ts";
import type { MemoryRuntime } from "../memory/runtime.ts";
import { irrelevanceRate, memoryWorth, strengthAt, useSignals, worthClass } from "../memory/strength.ts";
import { violationsAtLevel } from "../memory/urgency.ts";
import { rawTurnId } from "../storage/turnindex.ts";
import { parseIdLoose } from "../util/ids.ts";
import { clipTokens } from "../util/text.ts";
import { fail, ok, projectSessions, str, strList, type ToolEnv } from "./env.ts";
import { locateRecord } from "./recall.ts";

const INCLUDES = ["evidence", "neighbors", "history", "sources", "anchors", "stats", "span", "knowledge", "attribution"] as const;
type Include = (typeof INCLUDES)[number];

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The supersession chain a memory belongs to, oldest first. */
function chain(mem: MemoryRuntime, ref: ScopedNode): ScopedNode[] {
  const g = mem.graph;
  const key = (r: ScopedNode) => `${r.scope}:${r.node.id}`;
  const seen = new Set<string>([key(ref)]);
  const older: ScopedNode[] = [];
  let cur = ref;
  for (let i = 0; i < 20; i++) {
    const prev = g.neighbors(cur, { rels: ["supersedes"] }).find((n) => n.direction === "out" && !seen.has(key(n.other)));
    if (!prev) break;
    seen.add(key(prev.other));
    older.unshift(prev.other);
    cur = prev.other;
  }
  const newer: ScopedNode[] = [];
  cur = ref;
  for (let i = 0; i < 20; i++) {
    const next = g.neighbors(cur, { rels: ["supersedes"] }).find((n) => n.direction === "in" && !seen.has(key(n.other)));
    if (!next) break;
    seen.add(key(next.other));
    newer.push(next.other);
    cur = next.other;
  }
  return [...older, ref, ...newer];
}

export function inspectMemory(env: ToolEnv, mem: MemoryRuntime, ref: ScopedNode, include: Set<Include>): { text: string; details: Record<string, unknown> } {
  const n = ref.node;
  const now = mem.clock();
  const lines: string[] = [];
  const head = [scopeLabel(ref.scope), n.layer === "long" ? "long-term" : "short-term", n.kind];
  if (n.severity) head.push(`severity ${n.severity}`);
  head.push(`urgency ${n.urgency} (set by ${n.urgencyBy})`);
  if (n.status !== "active") head.push(`${n.status}${n.statusReason ? `: ${n.statusReason.replace(/^purge\|[^|]*\|/, "")}` : ""}`);
  if (n.pinned) head.push("pinned");
  lines.push(`${mid(n)} ${head.join(" · ")}`);
  lines.push(`Title: ${n.title}`);
  const dates = [`created ${day(n.createdAt)}`, `as of ${day(n.validFrom ?? n.createdAt)}`];
  if (n.validTo) dates.push(`no longer current since ${day(n.validTo)}`);
  if (n.verifiedAt) dates.push(`last verified ${day(n.verifiedAt)}`);
  dates.push(`origin ${n.origin}`);
  if (n.evaluation) dates.push(`[${n.evaluation}]`);
  if (n.sensitivity === "personal") dates.push("personal-sensitivity");
  lines.push(dates.join(" · "));
  if (n.aliasOf) lines.push(`Re-keyed after an ID collision; it was written as [m:${n.aliasOf}].`);
  const aliases = mem.graph.aliasesOf(n.id);
  if (aliases.length) lines.push(`Another memory was written under this ID on another machine and now lives at ${aliases.map((a) => mid(a.node)).join(", ")}.`);
  if (n.flags?.length) lines.push(`Flags: ${n.flags.join(", ")}`);
  const triggers = [...(n.triggers?.on?.length ? [`on ${n.triggers.on.join(", ")}`] : []), ...(n.triggers?.commands?.length ? [`commands ${n.triggers.commands.map((c) => `\`${c}\``).join(", ")}`] : [])];
  if (triggers.length) lines.push(`Triggers: ${triggers.join("; ")}`);

  // provenance: IDs that recall opens on the machine that wrote them (§8.1.2)
  const p = n.provenance;
  const elsewhere = p.actor !== mem.actorId;
  const prov: string[] = [];
  if (p.turnId) prov.push(`[${p.turnId}]`);
  if (p.sessionId) for (const e of (p.entryIds ?? []).slice(0, 6)) prov.push(`[${rawTurnId(p.sessionId, e)}]`);
  if (prov.length || elsewhere) lines.push(`Provenance: ${prov.join(" ") || "—"}${elsewhere ? " (from another machine: these IDs cannot be opened here)" : ""}`);

  const details: Record<string, unknown> = { id: `m:${n.id}`, type: "memory", scope: ref.scope, layer: n.layer, kind: n.kind, status: n.status, urgency: n.urgency, urgencyBy: n.urgencyBy, severity: n.severity, pinned: n.pinned, flags: n.flags ?? [] };

  if (include.has("anchors")) {
    const anchors = mem.paths.displayAnchors(ref);
    if (anchors.length) {
      lines.push("Anchors:");
      for (const a of anchors) {
        const status = a.anchor.status === "stale" ? "stale" : a.entry ? a.entry.data.status : "live";
        const changed = a.anchor.seenBlob && a.entry?.data.blob && a.anchor.seenBlob !== a.entry.data.blob ? " · file changed since" : "";
        lines.push(`- ${a.anchor.role} ${a.at ?? "(path unknown)"} (${a.anchor.kind}, ${status}${changed})`);
      }
    } else lines.push("Anchors: none");
    details.anchors = anchors.map((a) => ({ role: a.anchor.role, kind: a.anchor.kind, at: a.at, status: a.anchor.status }));
  }
  if (include.has("sources")) {
    if (n.source) lines.push(`Instruction source: ${n.source.file} § ${n.source.section || "(top)"} lines ${n.source.lines[0]}–${n.source.lines[1]} (sha ${n.source.sha.slice(0, 12)})`);
    else lines.push("Instruction source: none (not from an instruction file)");
    details.source = n.source ?? null;
  }
  if (include.has("evidence")) {
    if (n.evidence.length) {
      lines.push("Evidence:");
      for (const e of n.evidence) lines.push(`- "${e.quote.replace(/\s+/g, " ").slice(0, 400)}" — ${e.source.type}${e.source.ref ? ` ${e.source.ref}` : ""}${e.time ? ` · ${day(e.time)}` : ""}${e.verified ? "" : " ⚠ quote unverified"}`);
    } else lines.push("Evidence: none recorded");
    details.evidence = n.evidence.map((e) => ({ source: e.source, verified: e.verified }));
  }
  if (include.has("neighbors")) {
    const nbs = mem.graph.neighbors(ref);
    if (nbs.length) {
      lines.push("Neighbors:");
      const order = (x: (typeof nbs)[number]) => `${x.other.node.layer === "long" ? 0 : 1}${x.edge.rel}`;
      for (const nb of [...nbs].sort((a, b) => order(a).localeCompare(order(b))).slice(0, 24)) {
        const o = nb.other.node;
        lines.push(`- ${nb.direction === "out" ? `${nb.edge.rel} →` : `← ${nb.edge.rel}`} ${mid(o)} (${scopeLabel(nb.other.scope)}, ${o.layer === "long" ? "long-term" : "short-term"}${o.status !== "active" ? `, ${o.status}` : ""}${nb.edge.active ? "" : ", inactive edge"}) ${o.title}`);
      }
      if (nbs.length > 24) lines.push(`- (+${nbs.length - 24} more)`);
    } else lines.push("Neighbors: none");
    details.neighbors = nbs.map((nb) => ({ id: `m:${nb.other.node.id}`, rel: nb.edge.rel, direction: nb.direction, w: r2(nb.edge.w) }));
  }
  if (include.has("history")) {
    const c = chain(mem, ref);
    if (c.length > 1) {
      lines.push("Supersession chain (oldest first):");
      for (const x of c) lines.push(`- ${mid(x.node)} as of ${day(x.node.validFrom ?? x.node.createdAt)}${x.node.validTo ? ` until ${day(x.node.validTo)}` : ""}${x.node.id === n.id ? " ← this one" : ""}: ${x.node.title}`);
    } else lines.push("Supersession chain: none (nothing replaces it and it replaces nothing)");
    const conflicts = mem.graph.contradictions(ref);
    if (conflicts.length) lines.push(`Conflicts with: ${conflicts.map((x) => `${mid(x.node)} (${scopeLabel(x.scope)})`).join(", ")}`);
    details.chain = c.map((x) => `m:${x.node.id}`);
  }
  if (include.has("stats")) {
    const c = n.counters;
    const pend = (name: Parameters<typeof mem.accounting.pendingOf>[2]) => c[name] + mem.accounting.pendingOf(ref.scope, n.id, name);
    const { mw, evidence } = memoryWorth(c);
    const sig = useSignals(n);
    lines.push(`Use: delivered ${r2(pend("delivered"))} · used ${r2(pend("used"))} (success ${r2(c.usedSuccess)}, failure ${r2(c.usedFailure)}) · ignored-relevant ${r2(c.ignoredRelevant)} · already-known ${r2(c.known)} · contradicted ${r2(c.contradicted)} · harm ${r2(c.harm)} · expanded ${r2(pend("expanded"))} · retrieved ${r2(pend("retrieved"))}`);
    lines.push(`Memory Worth ${mw.toFixed(2)} on ${r2(evidence)} outcomes (${worthClass(c)}) · strength ${strengthAt(n, now).toFixed(2)} · irrelevance ${irrelevanceRate(n).toFixed(2)} · importance ${n.importance === undefined ? "?" : n.importance.toFixed(2)}`);
    if (n.kind === "rule" || n.kind === "procedure") lines.push(`Compliance: complied ${r2(c.complied)} · violated ${r2(c.violated)} (${r2(violationsAtLevel(n))} at urgency ${n.urgency})`);
    const notes = [...(sig.rewriteCandidate ? ["often relevant but ignored: a rewrite candidate"] : []), ...(sig.deadWeight ? ["delivered often, never used: left out of proactive cards"] : []), ...(sig.harmful ? ["flagged as harmful"] : [])];
    if (notes.length) lines.push(`Signals: ${notes.join("; ")}`);
    lines.push(`Last access ${day(n.lastAccessAt)}${n.lastDeliveredAt ? ` · last delivered ${day(n.lastDeliveredAt)}` : ""}`);
    details.stats = { counters: c, mw: r2(mw), evidence: r2(evidence), strength: r2(strengthAt(n, now)) };
  }
  if (include.has("attribution") && env.engine) {
    const ds = env.engine.state.deliveriesOf(`m:${n.id}`);
    if (ds.length) {
      lines.push("Deliveries in this session:");
      for (const d of ds.slice(-12)) {
        const a = env.engine.state.attributed.get(d.deliveryId);
        lines.push(`- ${d.channel}${d.full === false ? " (caption)" : ""} · round ${d.round ?? "?"} · ${a ? `use ${r2(a.u)}` : "not attributed yet"}`);
      }
    } else lines.push("Deliveries in this session: none");
  }
  return { text: lines.join("\n"), details };
}

export async function runInspect(env: ToolEnv, raw: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResultPayload> {
  const id = parseIdLoose(str(raw.id) ?? "");
  if (!id) return fail("inspect needs an `id` such as m:7f3a9k2d, t:…, r:… or o:… (brackets are optional).");
  const asked = strList(raw.include).filter((x): x is Include => (INCLUDES as readonly string[]).includes(x));
  const count = ctx.aux !== true;
  const deliveries: PendingDelivery[] = [];
  const done = (text: string, details: Record<string, unknown>) => ok(text, { ...details, deliveries: count ? deliveries : [] });

  if (id.type === "m") {
    const mem = env.memory;
    const ref = mem?.graph.get(id.id) ?? null;
    if (!mem || !ref) {
      const aliases = mem?.graph.aliasesOf(id.id) ?? [];
      if (aliases.length) return fail(`[${id.full}] was re-keyed after an ID collision: see ${aliases.map((a) => `[m:${a.node.id}]`).join(", ")}.`);
      return fail(`No memory [${id.full}] is visible here.`);
    }
    const include = new Set<Include>(asked.length ? asked : ["anchors", "sources", "stats", "history"]);
    const out = inspectMemory(env, mem, ref, include);
    if (count) {
      mem.accounting.bump(ref.scope, ref.node.id, "expanded", 1);
      mem.accounting.touch(ref.scope, ref.node.id);
    }
    deliveries.push({ id: id.full, kind: "card", channel: "inspect", nodeIds: [ref.node.id], scope: ref.scope, text: ref.node.title, signature: ref.node.signature, full: false });
    return done(out.text, out.details);
  }

  if (id.type === "t") {
    const found = await locateRecord(env, id.full);
    if ("missing" in found) return fail(found.missing);
    const { record, state } = found;
    const include = new Set<Include>(asked.length ? asked : ["span", "knowledge"]);
    const lines: string[] = [];
    const kind = record.kind === "precip" ? "Precip (a closed intent)" : record.kind === "palim" ? "Palim (a folded prefix)" : "compaction";
    lines.push(`[${record.id}] ${kind} · made ${record.createdAt.slice(0, 16).replace("T", " ")} by ${record.model}${record.shadow ? " · shadow (the transcript keeps the raw messages)" : ""}${found.current ? "" : " · earlier session"}`);
    if (record.kind === "precip") {
      const intent = record.intentId ? state.intents.get(record.intentId) : undefined;
      lines.push(`Intent: "${intent?.label ?? "?"}" · ${record.outcome ? outcomeWord(record.outcome) : "?"}${record.telos.length ? ` · inside: ${record.telos.join(" › ")}` : ""}`);
      if (intent) lines.push(`Done when: ${intent.success}`);
      if (record.sidecar?.open_threads.length) lines.push(`Open threads: ${record.sidecar.open_threads.join("; ")}`);
    } else if (record.telos.length) lines.push(`Purposes at the time: ${record.telos.join(" › ")}`);
    const parent = state.parentOf(record.id);
    if (parent) lines.push(`Held by: [${parent.id}]`);
    const reach = reachableEntries(record, state);
    const byId = new Map(found.entries.map((e) => [e.id, e]));
    const span = reach.map((e) => byId.get(e)).filter((e): e is NonNullable<typeof e> => !!e);
    if (include.has("span")) {
      const rounds = span.filter((e) => e.kind === "assistant" && (e.toolCalls?.length ?? 0) > 0).length;
      const times = span.map((e) => e.timestamp).filter(Boolean).sort();
      const nested = record.children.filter((c) => "id" in c).length;
      lines.push(`Span: ${record.children.length} items (${record.children.length - nested} raw, ${nested} nested consolidations) · ${reach.length} raw entries in all · ${rounds} rounds · ${times.length ? `${times[0]!.slice(0, 16).replace("T", " ")} → ${times[times.length - 1]!.slice(0, 16).replace("T", " ")}` : "times unknown"}`);
      lines.push(`Tokens: ${record.tokensBefore} before → ${record.tokensAfter} after`);
    }
    if (include.has("knowledge")) {
      if (record.knowledge?.length) {
        lines.push("Knowledge:");
        for (const k of record.knowledge) lines.push(`- [${k.evaluation}] ${k.fact}${k.as_of ? ` (as of ${k.as_of})` : ""}${k.memoryId ? ` → [m:${k.memoryId}]` : ""}${k.used ? " · used after a recall" : ""}`);
      } else if (record.kind !== "precip") lines.push("Knowledge: none");
    }
    if (include.has("attribution")) {
      const inside = new Set(reach);
      inside.add(record.anchorId);
      const ds = state.deliveries.filter((d) => inside.has(d.entryId) || (record.intentId !== undefined && d.intentId === record.intentId));
      if (ds.length) {
        lines.push("Delivered inside the span:");
        for (const d of ds.slice(0, 30)) {
          const a = state.attributed.get(d.deliveryId);
          const top = a ? Object.entries(a.use).sort((x, y) => y[1] - x[1])[0] : undefined;
          lines.push(`- [${d.id}] via ${d.channel} · ${a ? `use ${r2(a.u)}${top ? ` (${top[0].replace(/_/g, " ")} ${r2(top[1])})` : ""}` : d.subagent ? "inside a subagent: not attributed" : "not attributed"}`);
        }
      } else lines.push("Delivered inside the span: nothing");
    }
    deliveries.push({ id: id.full, kind: "found", channel: "inspect", text: lines.join("\n") });
    return done(lines.join("\n"), { id: id.full, type: "consolidation", kind: record.kind, intentId: record.intentId, outcome: record.outcome, children: record.children.length, entries: reach.length, tokensBefore: record.tokensBefore, tokensAfter: record.tokensAfter });
  }

  if (id.type === "r") {
    const row = env.memory?.turns?.get(id.full) ?? null;
    let entryId = row?.entry ?? null;
    let session = row?.session ?? null;
    const lines: string[] = [];
    if (row) lines.push(`[${id.full}] raw turn · ${row.tool ? `tool ${row.tool}` : (row.role ?? "entry")} · ${row.at.slice(0, 16).replace("T", " ")} · ${row.tokens} tokens${row.chunk ? ` · chunk ${row.chunk + 1}` : ""} · session ${row.session}${row.session === env.sessionId ? " (this one)" : ""} · ${row.harness}`);
    else {
      const e = (await env.entries()).find((x) => rawTurnId(env.sessionId, x.id) === id.full);
      if (!e) return fail(`[${id.full}] is not in this machine's turn index.`);
      entryId = e.id;
      session = env.sessionId;
      lines.push(`[${id.full}] raw turn · ${e.toolName ? `tool ${e.toolName}` : e.kind} · ${e.timestamp.slice(0, 16).replace("T", " ")} · ${e.rawTokens} tokens · this session (not indexed yet)`);
    }
    if (session === env.sessionId && entryId && env.engine) {
      const holder = env.engine.state.holderOf(entryId);
      lines.push(holder ? `Held by: [${holder.id}] (${holder.kind})` : "Held by: no consolidation (still raw in context, or on another branch)");
    }
    if (row) lines.push(`Starts: ${clipTokens(row.text.replace(/\s+/g, " "), 40)}`);
    deliveries.push({ id: id.full, kind: "found", channel: "inspect", text: lines.join("\n") });
    return done(lines.join("\n"), { id: id.full, type: "raw", session, entry: entryId });
  }

  const stores: Array<{ store: BlobStore; session: string }> = [];
  if (env.engine) stores.push({ store: env.engine.blobs, session: env.sessionId });
  for (const s of projectSessions(env)) if (s.id !== env.sessionId) stores.push({ store: new BlobStore(env.layout.blobDir(s.id)), session: s.id });
  for (const { store, session } of stores) {
    const meta = store.meta(id.full);
    if (!meta) continue;
    const lines = [`[${id.full}] stored tool output · ${meta.tool ?? "tool"} · ${meta.at.slice(0, 16).replace("T", " ")} · ${meta.tokens} tokens (${meta.bytes} bytes) · ${Math.max(1, Math.ceil(meta.tokens / 4000))} pages · session ${session}${session === env.sessionId ? " (this one)" : ""}`];
    if (session === env.sessionId && env.engine && meta.toolCallId) {
      const e = (await env.entries()).find((x) => x.toolCallId === meta.toolCallId && x.kind === "toolResult");
      if (e) {
        const holder = env.engine.state.holderOf(e.id);
        lines.push(`Result entry: [${rawTurnId(env.sessionId, e.id)}]${holder ? ` · held by [${holder.id}]` : ""}`);
      }
    }
    deliveries.push({ id: id.full, kind: "found", channel: "inspect", text: lines.join("\n") });
    return done(lines.join("\n"), { id: id.full, type: "output", session, tool: meta.tool, tokens: meta.tokens, bytes: meta.bytes });
  }
  return fail(`[${id.full}] is not stored on this machine.`);
}
