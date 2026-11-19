/** `/realctx2 status | stack | tree | policy | doctor` (§10). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { autoMemoryState } from "../adapters/claude-code/settings.ts";
import type { Host } from "../core/host.ts";
import type { CommandIO, ConsolidationRecord, EntryView } from "../core/types.ts";
import { outcomeWord } from "../context/render.ts";
import { sumTokens, workingTail } from "../context/rounds.ts";
import { OPERATORS } from "../memory/policy.ts";
import { describeRecovery } from "../storage/recover.ts";
import { REALCTX2_VERSION } from "../storage/schema.ts";
import { sharedGitattributes } from "../storage/store.ts";
import { existsSync, listFiles, readJsonl } from "../util/fs.ts";
import { runSync } from "../util/git.ts";
import { parseId } from "../util/ids.ts";
import { hasSecrets } from "../util/secrets.ts";
import { num, table } from "./args.ts";

function pct(a: number, b: number): string {
  return b > 0 ? `${Math.round((a / b) * 100)}%` : "?";
}

/** Shared store files git has not committed yet. */
export function uncommittedShared(host: Host): string[] {
  const p = host.project;
  if (!p.git || !p.sharedDir || !p.root || !existsSync(p.sharedDir)) return [];
  const res = p.git.git(["status", "--porcelain", "--", p.sharedDir]);
  return res.code === 0 ? res.stdout.split("\n").filter((l) => l.trim()) : [];
}

export async function status(host: Host, io: CommandIO): Promise<void> {
  const e = host.engine;
  await e.rebuild().catch(() => undefined);
  const s = e.status();
  const lines: string[] = [];
  const tail = workingTail(e.entries, e.units, host.cfg, s.window, e.state.stats.roundTokens);
  const tailTokens = sumTokens(e.entries, tail.start, e.entries.length);
  lines.push(`realctx2 ${REALCTX2_VERSION} · ${host.adapter.harness}${host.adapter.capabilities.level === 0 ? " (append-only: consolidation takes effect at the harness's own compaction)" : ""}${host.light ? " · light mode (sub-session)" : ""}`);
  lines.push(`Context: W = ${num(s.window)} tokens · occupancy ${num(s.occupancy)} (${pct(s.occupancy, s.window)}) · working tail ${num(tailTokens)} tokens · ${s.round} rounds · ${s.requests} requests`);
  if (s.stack.length) {
    lines.push("Open intents (outermost first):");
    s.stack.forEach((i, d) => lines.push(`${"  ".repeat(d + 1)}- ${i.label} (open for ${Math.max(0, s.round - i.openedRound)} rounds) — done when: ${i.success}`));
  } else lines.push("Open intents: none");
  const recent = [...e.state.records.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 5);
  if (recent.length) {
    lines.push(`Consolidations: ${e.state.records.size} (frontier level ${s.frontier}; ${s.foldsSkippedByCost} fold(s) skipped by the cost check; Janus answered late ${s.janusLate}×)`);
    for (const r of recent) lines.push(`  [${r.id}] ${describeRecord(host, r)} · ${num(r.tokensBefore)} → ${num(r.tokensAfter)} tokens`);
  } else lines.push("Consolidations: none yet");
  lines.push(`Deliveries: ${s.deliveries} (${s.attributed} attributed) · background jobs: ${s.jobs.precip} Precip, ${s.jobs.folds} folds`);

  const h = host.health();
  const d = h.decision;
  lines.push(`Decision model: ${d.configured ? `${d.model} (${d.format}) · ${d.healthy ? "healthy" : `unavailable${d.lastError ? `: ${d.lastError}` : ""}`}` : "not configured"}${!d.healthy ? (d.emulated ? " · emulated by the aux model, with stricter thresholds" : " · fail-safe defaults apply") : ""}`);
  const emb = [h.late ? `late interaction ${h.late.model} ${h.late.healthy ? "healthy" : `down${h.late.problem ? ` (${h.late.problem})` : ""}`}` : null, h.dense ? `dense ${h.dense.model} ${h.dense.healthy ? "healthy" : `down${h.dense.problem ? ` (${h.dense.problem})` : ""}`}` : null].filter(Boolean);
  lines.push(`Embeddings: ${emb.length ? emb.join(" · ") : "not configured (BM25 only)"}${host.memory ? ` · search mode ${host.memory.sim.searchMode()}` : ""}`);
  lines.push(`Aux model: ${h.aux.available ? "available" : "unavailable"}`);
  const spent = host.telemetry.spentToday();
  lines.push(`Today's spend: aux ${num(spent.aux)} / ${num(host.cfg.budgets.dailyAuxTokens)} tokens · decision ${num(spent.decision)} / ${num(host.cfg.budgets.dailyDecisionTokens)} tokens${spent.reverify ? ` · re-verification ${num(spent.reverify)}` : ""}`);

  const mem = host.memory;
  if (mem) {
    const rows: string[][] = [];
    for (const scope of mem.graph.visible()) {
      const store = mem.graph.handle(scope).store;
      const st = store.stats();
      const nodes = mem.graph.all([scope]);
      const active = nodes.filter((n) => n.node.status === "active").length;
      rows.push([`  ${scope}`, `${active} active / ${nodes.length} memories`, `${st.updates} update file(s), ${st.snapshots} snapshot(s)`, store.readOnly ? "read-only" : store.hasUnflushed() && store.sd.dirty !== "none" ? (scope === "shared" && store.sd.dirty === "counters" ? "use counters buffered" : "unflushed changes") : store.exists() ? "flushed" : "not created yet"]);
    }
    lines.push("Stores:");
    lines.push(table(rows));
    if (host.project.sharedDir && !mem.graph.has("shared")) lines.push(`  shared: not loaded${host.trusted ? " (no shared store in this repository yet; it is created by the first shared write)" : " (the project is not trusted)"}`);
    if (mem.graph.has("shared")) {
      const pending = uncommittedShared(host);
      lines.push(`  shared memory follows the git branch · ${pending.length ? `${pending.length} shared file change(s) not committed yet (git add ${relShared(host)} && git commit)` : "nothing to commit"}`);
    }
    if (mem.lastReconcile && (mem.lastReconcile.moved.length || mem.lastReconcile.deleted.length || mem.lastReconcile.flagged.length)) lines.push(`Paths: ${mem.lastReconcile.moved.length} moved, ${mem.lastReconcile.deleted.length} deleted, ${mem.lastReconcile.flagged.length} rule(s) flagged at session start`);
    const reappeared = safe(() => mem.instructions.reappeared(), []);
    if (reappeared.length) lines.push(`Instruction files that reappeared after ingest (ignored for loading; /realctx2 ingest <path> re-slices them): ${reappeared.map((f) => f.display).join(", ")}`);
    const queued = mem.queued();
    if (queued.length) lines.push(`Queued for idle time: ${queued.map((j) => j.kind).join(", ")}`);
    if (mem.lastIdle) lines.push(`Last idle maintenance: ${mem.lastIdle.embedded} embedded, ${mem.lastIdle.passes.length} pass(es)${mem.lastIdle.autoMemory ? `, auto-memory import: ${mem.lastIdle.autoMemory.items} item(s) from ${mem.lastIdle.autoMemory.files} file(s)` : ""}${mem.lastIdle.stopped ? ` (stopped: ${mem.lastIdle.stopped})` : ""}`);
    if (mem.auxChanges.length) lines.push(`⚠ Files changed during aux sessions: ${mem.auxChanges.flatMap((c) => c.files).slice(0, 8).join(", ")}`);
    if (mem.auxBlocked.length) lines.push(`Aux tool calls blocked by the guard: ${mem.auxBlocked.length} (last: ${mem.auxBlocked.at(-1)!.reason})`);
    const review = mem.review.list().length;
    if (review) lines.push(`Review queue: ${review} item(s) (/realctx2 review)`);
  } else lines.push(`Memory: unavailable${host.memoryError ? ` (${host.memoryError})` : ""}`);
  const problems = [...host.problems, ...s.problems];
  if (problems.length) {
    lines.push("Problems:");
    for (const p of problems.slice(-10)) lines.push(`  - ${p}`);
  }
  if (host.overrides.ignored.length) lines.push(`Project config keys ignored: ${host.overrides.ignored.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(", ")}`);
  io.print(lines.join("\n"));
}

function relShared(host: Host): string {
  const p = host.project;
  return p.sharedDir && p.root ? p.sharedDir.slice(p.root.length + 1) : ".pi/realctx2";
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function describeRecord(host: Host, r: ConsolidationRecord): string {
  if (r.kind === "precip") {
    const intent = r.intentId ? host.engine.state.intents.get(r.intentId) : undefined;
    return `intent "${intent?.label ?? "?"}" ${r.outcome ? outcomeWord(r.outcome) : ""}${r.shadow ? " (shadow)" : ""}`.trim();
  }
  return `${r.kind === "palim" ? "fold" : "compaction"}${r.knowledge?.length ? ` · ${r.knowledge.length} knowledge item(s)` : ""}${r.shadow ? " (shadow)" : ""}`;
}

export async function stack(host: Host, io: CommandIO): Promise<void> {
  const e = host.engine;
  await e.rebuild().catch(() => undefined);
  const regions = e.state.regions(e.entries);
  const lines: string[] = [];
  for (const r of regions) {
    const tokens = sumTokens(e.entries, r.from, r.to);
    const visible = e.entries.slice(r.from, r.to).filter((x) => !x.omitted).length;
    const pad = "  ".repeat(r.level);
    if (!r.intent) lines.push(`root region · ${visible} visible entries · ${num(tokens)} tokens`);
    else {
      lines.push(`${pad}${r.level}. ${r.intent.label} · ${visible} visible entries · ${num(tokens)} tokens · open for ${Math.max(0, e.round - r.intent.openedRound)} rounds`);
      lines.push(`${pad}   why: ${r.intent.reason}`);
      lines.push(`${pad}   done when: ${r.intent.success}`);
      lines.push(`${pad}   give up when: ${r.intent.failure}`);
    }
  }
  const unplaced = e.state.stack.filter((i) => !regions.some((r) => r.intent?.id === i.id));
  for (const i of unplaced) lines.push(`(just kindled, no entries yet) ${i.label}`);
  io.print(lines.join("\n"));
}

function treeLines(host: Host, r: ConsolidationRecord, entries: Map<string, EntryView>, depth: number, out: string[], budget: { left: number }): void {
  if (budget.left-- <= 0) return;
  const pad = "  ".repeat(depth);
  out.push(`${pad}[${r.id}] ${describeRecord(host, r)} · ${r.children.length} items · ${num(r.tokensBefore)} → ${num(r.tokensAfter)} tokens`);
  let raw = 0;
  const flush = () => {
    if (raw) out.push(`${pad}  ${raw} raw entr${raw === 1 ? "y" : "ies"}`);
    raw = 0;
  };
  for (const c of r.children) {
    if ("entryId" in c) raw++;
    else {
      flush();
      const nested = host.engine.state.records.get(c.id);
      if (nested) treeLines(host, nested, entries, depth + 1, out, budget);
      else out.push(`${pad}  [${c.id}] (not on this branch)`);
    }
  }
  flush();
}

export async function tree(host: Host, io: CommandIO, arg: string | undefined): Promise<void> {
  const e = host.engine;
  await e.rebuild().catch(() => undefined);
  const entries = new Map(e.entries.map((x) => [x.id, x] as [string, EntryView]));
  const out: string[] = [];
  const budget = { left: 400 };
  if (arg) {
    const id = parseId(arg);
    const rec = id?.type === "t" ? e.state.records.get(id.full) : undefined;
    if (!rec) {
      io.print(`No consolidation ${arg} on this branch.`);
      return;
    }
    treeLines(host, rec, entries, 0, out, budget);
    io.print(out.join("\n"));
    return;
  }
  out.push(`session ${host.sessionId} · ${e.entries.length} entries on this branch · ${e.state.records.size} consolidation(s)`);
  let raw = 0;
  let rawTokens = 0;
  const flush = () => {
    if (raw) out.push(`  ${raw} raw entr${raw === 1 ? "y" : "ies"} · ${num(rawTokens)} tokens`);
    raw = 0;
    rawTokens = 0;
  };
  for (const x of e.entries) {
    if (x.omitted) continue;
    const rec = e.state.recordAt(x.id);
    if (rec && x.edited) {
      flush();
      treeLines(host, rec, entries, 1, out, budget);
    } else {
      raw++;
      rawTokens += x.tokens;
    }
  }
  flush();
  const shadow = [...e.state.records.values()].filter((r) => r.shadow && !e.state.parentOf(r.id));
  if (shadow.length) {
    out.push("shadow consolidations (injected after the harness compacts):");
    for (const r of shadow) treeLines(host, r, entries, 1, out, budget);
  }
  io.print(out.join("\n"));
}

export function policy(host: Host, io: CommandIO): void {
  const mem = host.memory;
  if (!mem) return io.print("Memory is unavailable.");
  const attempts = mem.evoLog.attempts(400);
  const lines: string[] = [];
  const mode = host.cfg.evolution.policy;
  const st = mem.policy?.state;
  lines.push(`Evolution policy: ${mode}${st ? ` · phase ${st.phase} (${st.attempts} attempts${st.graduatedAt ? `, graduated ${st.graduatedAt.slice(0, 10)}` : ""}${st.demotedAt ? `, demoted ${st.demotedAt.slice(0, 10)}` : ""})` : ""} · shared strategy ${host.cfg.evolution.sharedStrategy}`);
  if (!attempts.length) {
    lines.push("No strategy attempts logged yet. They run during idle maintenance (/realctx2 maintain).");
    return io.print(lines.join("\n"));
  }
  const recent = attempts.slice(-50);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const E = recent.map((a) => a.E).filter((x): x is number => typeof x === "number");
  lines.push(`Last ${recent.length} attempts: mean U ${mean(recent.map((a) => a.U)).toFixed(3)} · mean E ${E.length ? mean(E).toFixed(3) : "?"} · committed ${recent.filter((a) => a.committed).length} · vetoed ${recent.filter((a) => a.vetoed).length}`);
  // agreement with the teacher: how often the acting policy picked the teacher's most probable operator
  const judged = recent.filter((a) => a.teacher && a.actor !== "teacher");
  if (judged.length) {
    const agree = judged.filter((a) => {
      const probs = a.teacher!.operator;
      const top = OPERATORS[probs.indexOf(Math.max(...probs))];
      return top === a.a.operator;
    }).length;
    lines.push(`Agreement with the teacher: ${Math.round((agree / judged.length) * 100)}% of ${judged.length} non-teacher attempts`);
  }
  const mix = OPERATORS.map((op) => `${op} ${Math.round((recent.filter((a) => a.a.operator === op).length / recent.length) * 100)}%`);
  lines.push(`Operator mix: ${mix.join(" · ")}`);
  const actors = ["teacher", "mlp", "rules"].map((who) => `${who} ${recent.filter((a) => a.actor === who).length}`);
  lines.push(`Chosen by: ${actors.join(" · ")}`);
  const proposals = mem.evoLog.proposals();
  if (proposals.length) lines.push(`Proposals waiting (shared strategy "propose"): ${proposals.length} (/realctx2 review)`);
  io.print(lines.join("\n"));
}

interface Check {
  level: "ok" | "warn" | "error";
  text: string;
}

export async function doctor(host: Host, io: CommandIO): Promise<void> {
  const checks: Check[] = [];
  const ok = (text: string) => checks.push({ level: "ok", text });
  const warn = (text: string) => checks.push({ level: "warn", text });
  const error = (text: string) => checks.push({ level: "error", text });
  const cfg = host.cfg;

  // providers, including the shape of each embedding model's output
  await host.probe();
  const h = host.health();
  if (!h.decision.configured) warn(`No decision model is configured (providers.decision). ${h.aux.available ? "The aux model emulates decisions with stricter thresholds." : "Fail-safe defaults apply everywhere."}`);
  else if (host.http) {
    const res = await host.http.decide("doctor probe: the sky is blue.", [{ kind: "binary", name: "probe", instructions: "Does the text mention a color?" }], { callSite: "doctor", timeoutMs: 8000, noRetry: true }).then(
      (a) => (a.probe?.p !== undefined ? null : "the answer had no probability for the probe question"),
      (e: unknown) => String((e as Error).message ?? e),
    );
    if (res) error(`Decision model ${h.decision.model} (${h.decision.format}): ${res}`);
    else ok(`Decision model ${h.decision.model} (${h.decision.format}) answers.`);
  }
  for (const [name, p, probe] of [["late-interaction", h.late, host.probes.late], ["dense", h.dense, host.probes.dense]] as const) {
    if (!p) continue;
    if (probe && !probe.ok) error(`Embedding model ${p.model} (${name}): ${probe.problem ?? "probe failed"}. The provider stays off until its configuration is fixed.`);
    else ok(`Embedding model ${p.model} (${name}) returns the expected shape.`);
  }
  if (!h.late && !h.dense) warn("No embedding model is configured: search and thresholds use BM25 and lexical overlap only.");
  if (!h.aux.available) warn("The aux model is unavailable: no consolidation, ingest, thorough search or evolution until it is.");

  const mem = host.memory;
  if (mem) {
    // embedding calibration
    for (const c of mem.sim.status()) {
      if (!c.calibratedAt) warn(`Embedding model ${c.model} (${c.kind}) is not calibrated yet: configured default thresholds are in use (/realctx2 calibrate).`);
      else ok(`Embedding model ${c.model} (${c.kind}) calibrated ${c.calibratedAt.slice(0, 10)} (${c.source}).`);
    }
    // store integrity, stranded updates, LFS, schema versions
    for (const scope of mem.graph.visible()) {
      const store = mem.graph.handle(scope).store;
      const st = store.stats();
      if (store.unloaded) error(`${scope} store is not loaded: ${store.unloadedReason}`);
      for (const p of store.problems.slice(0, 5)) warn(`${scope} store: ${p.file ? `${p.file}: ` : ""}${p.problem}`);
      const invalid = store.sd.invalid.length;
      if (invalid) warn(`${scope} store: ${invalid} node(s) failed the schema check and were skipped.`);
      const stranded = store.strandedFiles();
      if (stranded.length) warn(`${scope} store: ${stranded.length} stranded update file(s) could not be recovered from git history (${store.strandedDir}).`);
      for (const r of store.recovered.slice(0, 3)) ok(`${scope} store: recovered stranded updates (${describeRecovery(r)}).`);
      for (const c of store.collisions) warn(`${scope} store: memory ID collision, [m:${c.id}] was re-keyed as [m:${c.rekeyed}].`);
      const due = store.compactionDue();
      if (due) warn(`${scope} store: compaction is due (${due}); it runs in the session-end worker, or now with /realctx2 compact ${scope}.`);
      const meta = store.sd.meta();
      if (store.readOnly) warn(`${scope} store is read-only here (schema ${meta.schema}, minWriter ${meta.minWriter}): upgrade realctx2 to write to it.`);
      const versions = new Set(Object.values(meta.peers).map((p) => p.version));
      ok(`${scope} store: ${st.nodes} node(s), ${st.updates} update file(s) (${num(st.updateBytes)} bytes), ${st.snapshots} snapshot(s) (${num(st.snapshotBytes)} bytes), ${st.peers} writer(s)${versions.size > 1 ? `, versions ${[...versions].join(", ")}` : ""}.`);
      // secrets in the shared store
      if (scope === "shared") {
        const leaks = mem.graph.all(["shared"]).filter((n) => hasSecrets(`${n.node.title}\n${n.node.text}\n${n.node.evidence.map((x) => x.quote).join("\n")}`));
        if (leaks.length) error(`Shared store: ${leaks.length} memor${leaks.length === 1 ? "y looks" : "ies look"} like they contain secrets: ${leaks.slice(0, 5).map((n) => `[m:${n.node.id}]`).join(", ")}. Purge them with /realctx2 forget <id> --purge.`);
        const dir = host.project.sharedDir!;
        const ga = join(dir, ".gitattributes");
        // the directory is created by the first shared write
        if (!store.exists()) ok("Shared store: not created yet (the first shared memory creates it).");
        else if (!existsSync(ga)) warn(`Shared store: ${ga} is missing (it marks .loro files as binary/generated).`);
        else {
          const text = safeRead(ga);
          const lfs = /filter=lfs/.test(text);
          if (lfs && !host.project.git?.lfsAvailable()) error("Shared store uses Git LFS, but git-lfs is not installed: install it and run `git lfs pull`.");
          else if (text.trim() !== sharedGitattributes(lfs).trim()) warn("Shared store: .gitattributes differs from what realctx2 writes.");
          else ok(`Shared store: .gitattributes is in place (${lfs ? "Git LFS" : "binary"}).`);
        }
      }
    }
    if (host.project.sharedDir && !mem.graph.has("shared") && existsSync(join(host.project.sharedDir, "store.json"))) warn(host.trusted ? "The shared store exists but could not be loaded." : "The shared store is not loaded because the project is not trusted.");
    // instruction files that reappeared after ingest
    const reappeared = safe(() => mem.instructions.reappeared(), []);
    if (reappeared.length) warn(`Instruction files reappeared after ingest (ignored for loading): ${reappeared.map((f) => f.display).join(", ")}. Re-slice with /realctx2 ingest <path>.`);
    // index sizes
    for (const scope of mem.graph.visible()) {
      const idx = mem.graph.handle(scope).index;
      if (idx) ok(`${scope} index: ${num(idx.sizeBytes())} bytes, ${idx.activeCount()} active memories.`);
      else warn(`${scope} index is unavailable (SQLite could not be opened): retrieval is degraded.`);
    }
    if (mem.turns) {
      const t = mem.turns.stats();
      const over = t.bytes > cfg.index.maxBytes;
      (over ? warn : ok)(`Turn index: ${num(t.bytes)} bytes of ${num(cfg.index.maxBytes)} allowed, ${t.turns} turn(s), vectors: ${t.vectors.dense} dense / ${t.vectors.tokens} token matrices / ${t.vectors.fde} FDE.`);
    } else if (cfg.privacy.indexSessions === "off") ok("Session indexing is off (privacy.indexSessions).");
    // files changed by aux sessions
    const changes = [...mem.auxChanges, ...readJsonl<{ at: string; role: string; files: string[] }>(join(host.layout.logsDir, "aux-changes.jsonl")).slice(-20)];
    if (changes.length) warn(`Aux sessions changed files (nothing was reverted): ${[...new Set(changes.flatMap((c) => c.files))].slice(0, 10).join(", ")}`);
    if (mem.auxBlocked.length) warn(`${mem.auxBlocked.length} aux tool call(s) were blocked by the guard in this session, last: ${mem.auxBlocked.at(-1)!.reason}`);
  } else error(`Memory stores are unavailable${host.memoryError ? `: ${host.memoryError}` : ""}`);

  // tool-name conflicts
  if (host.problems.length) for (const p of host.problems) error(p);
  else ok("No tool-name conflicts.");

  // pi's compaction threshold against ρW
  const window = host.engine.window();
  const model = host.adapter.maxContextTokens();
  const note = (host.adapter as { compactionNote?: () => string | null }).compactionNote?.();
  if (note) warn(note);
  else if (host.adapter.harness === "pi") ok(`Pressure control starts at ${Math.round(cfg.context.rho * 100)}% of W = ${num(window)} tokens (model window ${num(model)}).`);

  if (host.adapter.harness === "claude-code") {
    const am = autoMemoryState();
    if (am.enabled && cfg.claudeCode.disableAutoMemory) warn(`Claude Code auto memory is on again (${am.file}): it competes with realctx2's memory. Turn it off in /memory, or set claudeCode.disableAutoMemory to false to keep both.`);
    else ok("Claude Code auto memory is off.");
    const v = runSync("claude", ["--version"], host.project.cwd, 5000);
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(v.stdout);
    if (m && (Number(m[1]) < 2 || (Number(m[1]) === 2 && Number(m[2]) === 1 && Number(m[3]) < 259))) warn(`Claude Code ${m[0]} is older than 2.1.259: aux sessions use --permission-mode dontAsk instead of --permission-prompts none. Upgrading is recommended.`);
  }
  const logs = listFiles(host.layout.logsDir).length;
  ok(`Logs: ${logs} file(s) in ${host.layout.logsDir}.`);

  const icon = { ok: "✓", warn: "⚠", error: "✗" } as const;
  const order = { error: 0, warn: 1, ok: 2 } as const;
  const sorted = [...checks].sort((a, b) => order[a.level] - order[b.level]);
  const errors = checks.filter((c) => c.level === "error").length;
  const warnings = checks.filter((c) => c.level === "warn").length;
  io.print([`realctx2 doctor: ${errors} error(s), ${warnings} warning(s)`, ...sorted.map((c) => `${icon[c.level]} ${c.text}`)].join("\n"));
}

function safeRead(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
