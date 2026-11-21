/** `/realctx2` commands that read or change memories (§10). */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Host } from "../core/host.ts";
import type { CommandIO, PathAnchor, ScopedNode, ScopeName, Severity, TriggerAction, Urgency } from "../core/types.ts";
import { URGENCY_ORDER } from "../core/types.ts";
import { day, mid, renderCard } from "../memory/cards.ts";
import { scopeLabel } from "../memory/graph.ts";
import type { MemoryRuntime } from "../memory/runtime.ts";
import { strengthAt } from "../memory/strength.ts";
import { capUrgency, hasTrigger } from "../memory/urgency.ts";
import { anchorKey } from "../storage/schema.ts";
import { errMsg } from "../util/errors.ts";
import { globCompiles } from "../util/glob.ts";
import { parseIdLoose } from "../util/ids.ts";
import { contentHash, makeTitle, sanitize } from "../util/text.ts";
import { inspectMemory, runInspect } from "../tools/inspect.ts";
import { describeCandidates, describeForget, remember, resolveTarget } from "../tools/memwrite.ts";
import { flagValue, freeText, type Parsed, table } from "./args.ts";

const SCOPES: ScopeName[] = ["global", "personal", "shared"];
const SEVERITIES: Severity[] = ["must", "should", "may", "info"];
const ACTIONS: TriggerAction[] = ["read", "edit", "command", "commit", "test"];

export function need(host: Host, io: CommandIO): MemoryRuntime | null {
  if (!host.memory) io.print(`Memory is unavailable${host.memoryError ? `: ${host.memoryError}` : "."}`);
  return host.memory;
}

/** Explicit user actions are flushed right away (§7.5). */
export function flushNow(mem: MemoryRuntime, scope?: ScopeName): void {
  try {
    mem.graph.flush({ scopes: scope ? [scope] : undefined, keepPurges: true });
  } catch (e) {
    mem.telemetry?.event("flush.failed", { error: errMsg(e) });
  }
}

async function target(host: Host, io: CommandIO, raw: string, opts: { includeRetired?: boolean } = {}): Promise<ScopedNode | null> {
  if (!raw.trim()) {
    io.print("Name a memory by its ID (m:…) or by a description that matches exactly one memory.");
    return null;
  }
  const t = await resolveTarget(host.env, raw.trim(), opts);
  if ("ref" in t) return t.ref;
  io.print(describeCandidates(t));
  return null;
}

export async function search(host: Host, io: CommandIO, p: Parsed): Promise<void> {
  const mem = need(host, io);
  if (!mem) return;
  const query = freeText(p.rest, ["history", "project"]);
  if (!query) return io.print("Usage: /realctx2 search <query> [--history] [--project]");
  const hits = await mem.retriever.retrieve(query, { limit: 12, history: p.flags.has("history"), count: false });
  const sessions = p.flags.has("project") ? [...mem.sessions().map((s) => s.id), host.sessionId] : [host.sessionId];
  const turns = await mem.retriever.searchTurns(query, { sessions, limit: 8 });
  const lines: string[] = [];
  if (hits.length) {
    lines.push(`Memories (search mode: ${mem.sim.searchMode()}):`);
    lines.push(table([["  score", "id", "scope", "layer", "kind", "urgency", "title"], ...hits.map((h) => [`  ${h.score.toFixed(3)}`, `m:${h.ref.node.id}`, scopeLabel(h.ref.scope), h.ref.node.layer, h.ref.node.kind, h.ref.node.urgency, `${h.ref.node.title}${h.seed ? "" : " (via a neighbor)"}`])]));
  } else lines.push("Memories: no match.");
  if (turns.length) {
    lines.push("Turns:");
    lines.push(table([["  score", "id", "kind", "when", "text"], ...turns.map((t) => [`  ${t.score.toFixed(3)}`, t.row.id, t.row.kind, t.row.at.slice(0, 16).replace("T", " "), t.row.text.replace(/\s+/g, " ").slice(0, 90)])]));
  } else lines.push("Turns: no match.");
  io.print(lines.join("\n"));
}

export async function inspect(host: Host, io: CommandIO, p: Parsed): Promise<void> {
  const id = p.positional[0];
  if (!id) return io.print("Usage: /realctx2 inspect <id>");
  // the user's own look: not a delivery, no counters
  const res = await runInspect(host.env, { id, include: ["evidence", "neighbors", "history", "sources", "anchors", "stats", "span", "knowledge", "attribution"] }, { aux: true });
  const parsed = parseIdLoose(id);
  const ref = parsed?.type === "m" ? host.memory?.graph.get(parsed.id) : null;
  io.print(ref ? `${res.text}\n\n${ref.node.text}` : res.text);
}

export async function rememberCmd(host: Host, io: CommandIO, p: Parsed): Promise<void> {
  const mem = need(host, io);
  if (!mem) return;
  const text = freeText(p.rest.replace(/--(scope|kind|severity|urgency|path|command)(=|\s+)("[^"]*"|'[^']*'|\S+)/g, " "), []);
  if (!text) return io.print("Usage: /realctx2 remember <text> [--scope global|personal|shared] [--kind rule|fact|…] [--severity must|should|may|info] [--urgency …] [--path <path>] [--command <pattern>]");
  const scope = flagValue(p, "scope");
  const urgency = flagValue(p, "urgency");
  const severity = flagValue(p, "severity");
  const kind = flagValue(p, "kind");
  const out = await remember(host.env, {
    text,
    by: "user",
    scope: SCOPES.includes(scope as ScopeName) ? (scope as ScopeName) : undefined,
    urgency: URGENCY_ORDER.includes(urgency as Urgency) ? (urgency as Urgency) : undefined,
    severity: SEVERITIES.includes(severity as Severity) ? (severity as Severity) : undefined,
    kind: kind === "rule" || kind === "fact" || kind === "procedure" || kind === "preference" || kind === "concept" ? kind : undefined,
    paths: flagValue(p, "path") ? [flagValue(p, "path")!] : undefined,
    commands: flagValue(p, "command") ? [flagValue(p, "command")!] : undefined,
  });
  flushNow(mem, out.result.scope);
  io.print(out.text);
}

export async function forgetCmd(host: Host, io: CommandIO, p: Parsed): Promise<void> {
  const mem = need(host, io);
  if (!mem) return;
  const purge = p.flags.has("purge");
  const reason = flagValue(p, "reason") ?? "forgotten by the user";
  const raw = freeText(p.rest.replace(/--reason(=|\s+)("[^"]*"|'[^']*'|\S+)/g, " "), ["purge"]);
  const ref = await target(host, io, raw);
  if (!ref) return;
  if (purge && ref.scope === "shared") io.print("Note: purging shared memory writes a snapshot that teammates' unsent updates cannot attach to (they are recovered at their next load), and git history keeps the old text.");
  // acts at once, without confirmation, and prints what it removed (§6.5.6)
  const out = mem.lifecycle.forget(ref, reason, { purge, byAgent: false });
  // a purge reaches the files at the session-end flush, so it can be undone until then (§7.10)
  if (out.status === "retired") flushNow(mem, ref.scope);
  io.print(`${describeForget(out, { byUser: true })}${out.ref && (out.status === "retired" || out.status === "purged") ? `\n\n${out.ref.node.text}` : ""}`);
}

export async function restore(host: Host, io: CommandIO, p: Parsed): Promise<void> {
  const mem = need(host, io);
  if (!mem) return;
  const id = p.positional[0];
  if (!id) return io.print("Usage: /realctx2 restore <id>");
  const out = mem.lifecycle.restore(id);
  if (out.status === "retired" && out.ref) {
    flushNow(mem, out.ref.scope);
    io.print(`Restored ${mid(out.ref.node)} "${out.ref.node.title}" (${scopeLabel(out.ref.scope)}); it is ${out.ref.node.status} again.`);
  } else if (out.status === "already") io.print(`${mid(out.ref!.node)} is already active.`);
  else io.print(out.message ?? "Nothing was restored.");
}

export async function urgency(host: Host, io: CommandIO, p: Parsed): Promise<void> {
  const mem = need(host, io);
  if (!mem) return;
  const level = p.positional[p.positional.length - 1] as Urgency | undefined;
  if (p.positional.length < 2 || !level || !URGENCY_ORDER.includes(level)) return io.print("Usage: /realctx2 urgency <id> <immediate|hint|caption|passive>");
  const ref = await target(host, io, p.positional.slice(0, -1).join(" "));
  if (!ref) return;
  if (!mem.graph.writable(ref.scope)) return io.print(`The ${ref.scope} store is read-only here.`);
  const n = ref.node;
  const capped = capUrgency(level, hasTrigger(n));
  const patch: Parameters<ReturnType<typeof mem.graph.sd>["patchNode"]>[1] = { urgency: capped, urgencyBy: "user" };
  // lowering to a level visited before: its violation count starts over from here (§6.10.4)
  if (URGENCY_ORDER.indexOf(capped) < URGENCY_ORDER.indexOf(n.urgency)) {
    const counter = `violations_${capped}` as const;
    patch.violationsBaseline = { ...(n.violationsBaseline ?? {}), [capped]: n.counters[counter] + mem.accounting.pendingOf(ref.scope, n.id, counter) };
    patch.flags = (n.flags ?? []).filter((f) => f !== "escalated");
  }
  mem.graph.sd(ref.scope).patchNode(n.id, patch);
  mem.graph.commit(ref.scope, "urgency");
  mem.graph.syncIndex(ref.scope);
  flushNow(mem, ref.scope);
  io.print(`${mid(n)} urgency: ${n.urgency} → ${capped} (set by the user; it will not be escalated or re-decided).${capped !== level ? ` "${level}" needs a path anchor or a command pattern, so it was capped.` : ""}`);
}

export async function pin(host: Host, io: CommandIO, p: Parsed, value: boolean): Promise<void> {
  const mem = need(host, io);
  if (!mem) return;
  const ref = await target(host, io, p.rest);
  if (!ref) return;
  if (!mem.graph.writable(ref.scope)) return io.print(`The ${ref.scope} store is read-only here.`);
  if (ref.node.pinned === value) return io.print(`${mid(ref.node)} is already ${value ? "pinned" : "unpinned"}.`);
  mem.graph.sd(ref.scope).patchNode(ref.node.id, value ? { pinned: true, layer: "long" } : { pinned: false });
  mem.graph.commit(ref.scope, value ? "pin" : "unpin");
  mem.graph.syncIndex(ref.scope);
  flushNow(mem, ref.scope);
  io.print(value ? `Pinned ${mid(ref.node)} "${ref.node.title}": it never decays and is never forgotten automatically.` : `Unpinned ${mid(ref.node)} "${ref.node.title}": it follows the normal lifecycle again.`);
}

// ───────────── rules (§6.9.3)
/** The live path anchors as the form shows them: a subtree ends in `/`. */
function formAnchors(mem: MemoryRuntime, ref: ScopedNode): Array<{ spec: string; anchor: PathAnchor }> {
  return mem.paths
    .displayAnchors(ref)
    .filter((a) => a.at && a.anchor.status === "live")
    .map((a) => ({ spec: a.anchor.kind === "subtree" ? a.at!.replace(/\/\*\*$/, "/") : a.at!, anchor: a.anchor }));
}

/** The edit form of a memory; `text` prefills the body (a suggested rewrite) instead of the current text. */
export function memoryForm(mem: MemoryRuntime, ref: ScopedNode, opts: { text?: string; note?: string } = {}): string {
  const n = ref.node;
  return [
    `# Editing ${mid(n)} (${scopeLabel(ref.scope)}). Lines starting with # are ignored. Save to apply; empty the text to cancel.`,
    ...(opts.note ? opts.note.split("\n").map((l) => `# ${l}`) : []),
    ...(n.kind === "rule" || n.severity ? [`severity: ${n.severity ?? "info"}`] : []),
    `# immediate | hint | caption | passive`,
    `urgency: ${n.urgency}`,
    `# repository paths or globs, comma-separated; a trailing / covers the subtree`,
    `paths: ${formAnchors(mem, ref).map((a) => a.spec).join(", ")}`,
    `# command patterns (globs over the command line), comma-separated`,
    `commands: ${(n.triggers?.commands ?? []).join(", ")}`,
    `# read | edit | command | commit | test`,
    `on: ${(n.triggers?.on ?? []).join(", ")}`,
    "---",
    opts.text ?? n.text,
  ].join("\n");
}

function parseRuleForm(text: string): { severity?: Severity; urgency?: Urgency; paths: string[]; commands: string[]; on: TriggerAction[]; text: string } | null {
  const lines = text.split("\n").filter((l) => !l.startsWith("#"));
  const sep = lines.findIndex((l) => l.trim() === "---");
  if (sep < 0) return null;
  const head = new Map<string, string>();
  for (const l of lines.slice(0, sep)) {
    const m = /^(\w+):\s*(.*)$/.exec(l);
    if (m) head.set(m[1]!.toLowerCase(), m[2]!.trim());
  }
  const list = (k: string) => (head.get(k) ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const sev = head.get("severity");
  const urg = head.get("urgency");
  return {
    severity: SEVERITIES.includes(sev as Severity) ? (sev as Severity) : undefined,
    urgency: URGENCY_ORDER.includes(urg as Urgency) ? (urg as Urgency) : undefined,
    paths: list("paths"),
    commands: list("commands"),
    on: list("on").filter((x): x is TriggerAction => ACTIONS.includes(x as TriggerAction)),
    text: lines.slice(sep + 1).join("\n").trim(),
  };
}

/** What an edited form would change, applied only by `apply()` (so a screen can confirm it first). */
export interface EditPlan {
  ref: ScopedNode;
  /** Short names of the changes: `text`, `severity should`, `anchors`, … (empty: nothing changes). */
  changes: string[];
  /** Paths in the form that do not resolve; they are ignored. */
  bad: string[];
  /** The sanitized text the memory would have. */
  text: string;
  apply(): void;
}

export function planMemoryEdit(mem: MemoryRuntime, ref: ScopedNode, edited: string): EditPlan | { error: string } {
  const form = parseRuleForm(edited);
  if (!form || !form.text) return { error: "the form had no text below the --- line" };
  const n = ref.node;
  const text = sanitize(form.text);
  const changes: string[] = [];
  const patch: Parameters<ReturnType<typeof mem.graph.sd>["patchNode"]>[1] = {};
  if (text !== n.text) {
    Object.assign(patch, { text, title: makeTitle(text), contentHash: contentHash(text), verifiedAt: mem.clock().toISOString() });
    changes.push("text");
  }
  if (form.severity && form.severity !== n.severity) {
    patch.severity = form.severity;
    changes.push(`severity ${form.severity}`);
  }
  // anchors: the listed paths replace the live `applies`/`about` anchors; unchanged ones are reused as they are
  const role = n.anchors[0]?.role ?? (n.kind === "rule" || n.kind === "procedure" || n.kind === "preference" ? "applies" : "about");
  const shown = new Map(formAnchors(mem, ref).map((a) => [a.spec, a.anchor]));
  const wanted: PathAnchor[] = [];
  const bad: string[] = [];
  for (const spec of form.paths) {
    const same = shown.get(spec);
    if (same) {
      wanted.push(same);
      continue;
    }
    if (/[*?[\]{}]/.test(spec) && !globCompiles(spec)) {
      bad.push(spec);
      continue;
    }
    const a = mem.paths.makeAnchor(ref.scope, spec, role);
    if (a) wanted.push(a);
    else bad.push(spec);
  }
  const have = new Map(n.anchors.filter((a) => a.status === "live").map((a) => [anchorKey(a), a]));
  const wantKeys = new Set(wanted.map(anchorKey));
  const removed = [...have].filter(([k]) => !wantKeys.has(k)).map(([, a]) => a);
  const added = wanted.filter((a) => !have.has(anchorKey(a)));
  if (removed.length || added.length) changes.push("anchors");
  const triggers = { ...(form.on.length || form.commands.length ? { on: [...new Set([...form.on, ...(form.commands.length ? (["command"] as TriggerAction[]) : [])])] } : {}), ...(form.commands.length ? { commands: form.commands } : {}) };
  if (JSON.stringify(triggers) !== JSON.stringify(n.triggers ?? {})) {
    patch.triggers = Object.keys(triggers).length ? triggers : null;
    changes.push("triggers");
  }
  const triggered = wanted.length > 0 || form.commands.length > 0;
  if (form.urgency && form.urgency !== n.urgency) {
    patch.urgency = capUrgency(form.urgency, triggered);
    patch.urgencyBy = "user";
    changes.push(`urgency ${patch.urgency}`);
  } else if (n.urgency === "immediate" && !triggered) {
    patch.urgency = "hint"; // `immediate` needs a trigger (§6.10)
    changes.push("urgency hint (no trigger left)");
  }
  return {
    ref,
    changes,
    bad,
    text,
    apply: () => {
      const sd = mem.graph.sd(ref.scope);
      for (const a of removed) sd.removeAnchor(n.id, a);
      for (const a of added) sd.setAnchor(n.id, a);
      if (Object.keys(patch).length) sd.patchNode(n.id, patch);
      mem.graph.commit(ref.scope, "rule-edit");
      mem.graph.syncIndex(ref.scope);
      mem.paths.invalidate();
      flushNow(mem, ref.scope);
    },
  };
}

/** The report line of an applied edit. */
export function describeEdit(plan: EditPlan): string {
  const { ref, changes, bad } = plan;
  return `Updated ${mid(ref.node)}: ${changes.join(", ")}.${ref.scope === "shared" ? " Teammates get the change with the next commit of the shared store." : ""}${bad.length ? `\nIgnored paths that do not resolve: ${bad.join(", ")}` : ""}`;
}

export async function rules(host: Host, io: CommandIO, p: Parsed): Promise<void> {
  const mem = need(host, io);
  if (!mem) return;
  if (p.positional[0] === "edit") {
    const ref = p.positional[1] ? mem.graph.get(p.positional[1]) : null;
    if (!ref) return io.print("Usage: /realctx2 rules edit <id>");
    if (!mem.graph.writable(ref.scope)) return io.print(`The ${ref.scope} store is read-only here.`);
    if (!io.edit) return io.print(`Editing needs an interactive session. The rule now reads:\n\n${memoryForm(mem, ref)}`);
    const edited = await io.edit(`Edit rule ${mid(ref.node)}`, memoryForm(mem, ref));
    if (edited === undefined) return io.print("Cancelled.");
    const plan = planMemoryEdit(mem, ref, edited);
    if ("error" in plan) return io.print(`Cancelled: ${plan.error}.`);
    if (!plan.changes.length) return io.print(`No changes to ${mid(ref.node)}.${plan.bad.length ? ` Unusable paths: ${plan.bad.join(", ")}` : ""}`);
    plan.apply();
    return io.print(describeEdit(plan));
  }
  const arg = p.positional[0] ?? ".";
  const rel = mem.paths.rel(arg);
  if (rel === null) return io.print(`${arg} is outside this project.`);
  const found = mem.delivery.rulesAt(rel).filter((r) => r.ref.node.status === "active");
  if (!found.length) return io.print(`No rules are in force at ${rel || "the repository root"}.`);
  const lines = [`Rules in force at ${rel || "the repository root"}, from the root down (a deeper rule overrides a shallower one):`];
  for (const r of found) {
    const n = r.ref.node;
    lines.push(`${r.at || "(repo)"}\n  ${(n.severity ?? "info").toUpperCase().padEnd(6)} ${mid(n)} ${n.text.replace(/\s+/g, " ")}\n         ${scopeLabel(r.ref.scope)} · urgency ${n.urgency}${n.source ? ` · from ${n.source.file}${n.source.section ? ` § ${n.source.section}` : ""}` : ` · ${n.origin}`}`);
  }
  io.print(lines.join("\n"));
}

// ───────────── paths (§6.8)
export async function paths(host: Host, io: CommandIO, p: Parsed): Promise<void> {
  const mem = need(host, io);
  if (!mem) return;
  const sub = p.positional[0] ?? "sync";
  if (sub === "sync") {
    if (!mem.graph.project.root) return io.print("Path tracking needs a project.");
    const r = mem.paths.reconcile({ full: true });
    const dropped = mem.paths.dropStaleAnchors();
    mem.graph.commitAll("paths-sync");
    mem.graph.syncIndexes();
    const lines = [`Checked ${r.checked} tracked path(s): ${r.moved.length} moved, ${r.absent.length} newly absent, ${r.deleted.length} deleted, ${r.revived.length} back, ${r.changed.length} changed.`];
    for (const m of r.moved.slice(0, 20)) lines.push(`  moved: ${m.from} → ${m.to}`);
    for (const d of r.deleted.slice(0, 20)) lines.push(`  deleted: ${d}`);
    if (r.dormant.length) lines.push(`  ${r.dormant.length} memor${r.dormant.length === 1 ? "y" : "ies"} made dormant (their only path is gone)`);
    if (r.flagged.length) lines.push(`  ${r.flagged.length} rule(s) flagged for review (/realctx2 review --stale-rules)`);
    if (dropped) lines.push(`  ${dropped} stale anchor(s) older than 30 days dropped`);
    return io.print(lines.join("\n"));
  }
  if (sub === "show") {
    const arg = p.positional[1];
    if (!arg) return io.print("Usage: /realctx2 paths show <path>");
    const rel = mem.paths.rel(arg);
    if (rel === null) return io.print(`${arg} is outside this project.`);
    const cov = mem.paths.covering(rel).sort((a, b) => a.depth - b.depth);
    if (!cov.length) return io.print(`No memories are anchored at or above ${rel || "the repository root"}.`);
    const lines = [`Memories for ${rel || "the repository root"}:`];
    for (const c of cov) lines.push(`${c.at || "(repo)"} · ${c.anchor.role}${c.changed ? " · file changed since" : ""}\n  ${mid(c.node)} ${c.node.kind}${c.node.severity ? ` ${c.node.severity.toUpperCase()}` : ""} · ${scopeLabel(c.scope)} · urgency ${c.node.urgency}${c.node.status !== "active" ? ` · ${c.node.status}` : ""}: ${c.node.title}`);
    return io.print(lines.join("\n"));
  }
  if (sub === "stale") {
    const rows: string[] = [];
    for (const r of mem.graph.all(undefined, (n) => n.status !== "purged")) {
      for (const a of mem.paths.displayAnchors(r)) {
        const status = a.anchor.status === "stale" ? `stale since ${day(a.anchor.staleAt)}` : a.entry && a.entry.data.status !== "live" ? `${a.entry.data.status}${a.entry.data.absentSince ? ` since ${day(a.entry.data.absentSince)}` : ""}` : null;
        if (status) rows.push(`  ${mid(r.node)} ${a.at ?? "(unknown path)"} — ${status} — ${r.node.title}`);
      }
    }
    return io.print(rows.length ? `Stale anchors (${rows.length}):\n${rows.join("\n")}` : "No stale anchors.");
  }
  io.print("Usage: /realctx2 paths [sync | show <path> | stale]");
}

// ───────────── export (§10)
export async function exportCmd(host: Host, io: CommandIO, p: Parsed): Promise<void> {
  const mem = need(host, io);
  if (!mem) return;
  if (p.positional[0] === "agents") {
    const dir = flagValue(p, "dir");
    const written = mem.instructions.exportAgents(dir ? resolve(host.project.cwd, dir) : undefined);
    return io.print(written.length ? `Wrote ${written.length} AGENTS.md file(s) from rules (they carry a "realctx2: generated" header and are never re-ingested):\n${written.map((f) => `  ${f}`).join("\n")}` : "No rules to export.");
  }
  const scopes = SCOPES.includes(p.positional[0] as ScopeName) ? [p.positional[0] as ScopeName] : mem.graph.visible();
  const dirArg = SCOPES.includes(p.positional[0] as ScopeName) ? p.positional[1] : p.positional[0];
  if (!dirArg) return io.print("Usage: /realctx2 export [scope] <dir>   or   /realctx2 export agents [--dir <dir>]");
  const out = resolve(host.project.cwd, dirArg);
  let n = 0;
  const now = mem.clock();
  for (const scope of scopes) {
    if (!mem.graph.has(scope)) continue;
    const dir = join(out, scope);
    mkdirSync(dir, { recursive: true });
    const index: string[] = [`# realctx2 memory: ${scope}`, "", `Exported ${now.toISOString()}. This is a read-only mirror; edits here are not read back.`, ""];
    for (const r of mem.graph.all([scope], (x) => x.status !== "purged").sort((a, b) => a.node.title.localeCompare(b.node.title))) {
      const node = r.node;
      const meta = inspectMemory(host.env, mem, r, new Set(["evidence", "neighbors", "history", "sources", "anchors", "stats"] as const));
      const page = [`# ${node.title}`, "", node.text, "", "```text", meta.text, "```", "", `Strength ${strengthAt(node, now).toFixed(2)} · card as shown to the agent:`, "", "```text", renderCard(r, mem.graph, mem.paths, { full: true, quotes: 3, history: true }), "```", ""].join("\n");
      writeFileSync(join(dir, `${node.id}.md`), page);
      index.push(`- [${node.title}](./${node.id}.md) — ${node.kind}, ${node.layer}, ${node.status}`);
      n++;
    }
    writeFileSync(join(dir, "README.md"), index.join("\n") + "\n");
  }
  io.print(`Wrote ${n} page(s) under ${out}.`);
}

// ───────────── ingest (§6.9.2)
export async function ingest(host: Host, io: CommandIO, p: Parsed): Promise<void> {
  const mem = need(host, io);
  if (!mem) return;
  if (!mem.aux?.available()) return io.print("Ingest needs the aux model (it slices the files), and none is available right now.");
  const include = p.flags.has("all") ? ["agents", "claude", "local", "rules", "global"] : flagValue(p, "include") ? [...new Set(["agents", "claude", ...flagValue(p, "include")!.split(",").map((x) => x.trim()).filter(Boolean)])] : undefined;
  const dryRun = p.flags.has("dry-run");
  io.notify("Slicing instruction files…", "info");
  const res = await mem.instructions.ingest({ paths: p.positional.length ? p.positional : undefined, include, dryRun, io, assumeYes: p.flags.has("yes") });
  if (res.dryRun) return io.print("Dry run: nothing was stored or deleted.");
  if (res.cancelled) return io.print("Cancelled: nothing was stored or deleted.");
  if (!res.stored.length && !res.deleted.length) return io.print(res.plan.problems.length ? `Nothing was ingested:\n${res.plan.problems.map((x) => `  - ${x}`).join("\n")}` : "No instruction files to ingest.");
  for (const scope of mem.graph.visible()) flushNow(mem, scope);
  const lines = [`Stored ${res.stored.length} item(s) as pinned memories${res.merged.length ? `, merged ${res.merged.length} learned memor${res.merged.length === 1 ? "y" : "ies"} into them` : ""}${res.retired.length ? `, retired ${res.retired.length} item(s) that are no longer in the files` : ""}.`];
  if (res.conflicts.length) lines.push(`⚠ ${res.conflicts.length} learned memor${res.conflicts.length === 1 ? "y contradicts" : "ies contradict"} an instruction; the instruction wins in delivery until reviewed (/realctx2 review --conflicts).`);
  if (res.deleted.length) lines.push(`Deleted ${res.deleted.length} file(s): ${res.deleted.join(", ")}${res.backupDir ? `\nUntracked files were backed up to ${res.backupDir}.` : ""}`);
  if (res.plan.kept.length) lines.push(`Kept (not fully covered, imported, or generated): ${res.plan.kept.map((f) => f.display).join(", ")}`);
  if (res.stored.some((s) => s.scope === "shared")) lines.push("Commit the shared store together with the deletions, so teammates get the rules from memory.");
  host.projectRules();
  (host.adapter as { onIngest?: () => void }).onIngest?.();
  io.print(lines.join("\n"));
}

export async function reverify(host: Host, io: CommandIO, p: Parsed): Promise<void> {
  const mem = need(host, io);
  if (!mem) return;
  const all = p.flags.has("all");
  const id = p.positional[0];
  if (id) {
    const ref = mem.graph.get(id);
    if (!ref) return io.print(`No memory ${id} is visible here.`);
    mem.paths.queueReverify(ref.scope, ref.node);
    mem.graph.commit(ref.scope, "reverify-queue");
  } else if (all) {
    for (const r of mem.graph.active()) if (r.node.anchors.some((a) => a.kind === "file" || a.kind === "symbol")) mem.paths.queueReverify(r.scope, r.node);
    mem.graph.commitAll("reverify-queue");
  }
  io.notify("Re-verifying memories against the code…", "info");
  const r = await mem.reverifier.run({ sessionEnding: true, maxFiles: all ? 200 : 20 });
  const lines = [`Checked ${r.files} file(s) in ${r.auxSessions} aux session(s): ${r.holdsModelFree.length + r.holds.length} hold, ${r.changed.length} updated, ${r.obsolete.length} retired as obsolete, ${r.unclear.length} unclear, ${r.review.length} sent to review.`];
  for (const c of r.changed.slice(0, 10)) lines.push(`  [m:${c.id}] → [m:${c.replacement}]`);
  if (r.waiting.length) lines.push(`  ${r.waiting.length} file(s) are still changing and will be checked later.`);
  for (const scope of mem.graph.visible()) flushNow(mem, scope);
  io.print(lines.join("\n"));
}

export async function calibrate(host: Host, io: CommandIO, p: Parsed): Promise<void> {
  const mem = need(host, io);
  if (!mem) return;
  if (!host.late && !host.dense) return io.print("No embedding model is configured: there is nothing to calibrate.");
  const only = p.positional[0];
  io.notify("Calibrating similarity thresholds…", "info");
  const res = await mem.sim.calibrate(true);
  const rows = mem.sim.status().filter((s) => !only || s.model === only || s.kind === only);
  const lines = [res.ok ? "Calibration finished." : `Calibration failed: ${res.problem ?? "unknown"}`];
  for (const s of rows) lines.push(`${s.model} (${s.kind}) · ${s.calibratedAt ? `calibrated ${s.calibratedAt.slice(0, 16).replace("T", " ")}` : "not calibrated"} · ${Object.entries(s.thresholds).map(([k, v]) => `${k} ${v.toFixed(3)}`).join(" · ")}`);
  io.print(lines.join("\n"));
}
