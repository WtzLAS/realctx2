/** `remember` and `forget` (§8.1.1, §6.5.6), shared by the agent tools and the `/realctx2` command. */
import type { Kind, ScopedNode, ScopeName, Severity, ToolCallContext, ToolResultPayload, Urgency } from "../core/types.ts";
import { KINDS, URGENCY_ORDER } from "../core/types.ts";
import { captionLine, mid } from "../memory/cards.ts";
import { scopeLabel } from "../memory/graph.ts";
import type { ForgetOutcome } from "../memory/lifecycle.ts";
import type { MemoryRuntime } from "../memory/runtime.ts";
import type { Candidate, WriteResult } from "../memory/write.ts";
import { parseId } from "../util/ids.ts";
import { fail, ok, oneOf, str, strList, type ToolEnv } from "./env.ts";

const SCOPES: ScopeName[] = ["global", "personal", "shared"];
const SEVERITIES: Severity[] = ["must", "should", "may", "info"];

export interface RememberInput {
  text: string;
  kind?: Kind;
  scope?: ScopeName;
  paths?: string[];
  commands?: string[];
  severity?: Severity;
  urgency?: Urgency;
  pin?: boolean;
  /** Who asked: the agent's tool call, or the user's command (pinned, §6.3.1). */
  by: "agent" | "user";
}

export function describeWrite(mem: MemoryRuntime, r: WriteResult): string {
  if (r.status === "discarded") return `Not stored: ${r.reason ?? "discarded"}.`;
  if (r.status === "failed" || !r.id) return `Could not store the memory: ${r.reason ?? "unknown error"}.`;
  const ref = mem.graph.get(r.id);
  const n = ref?.node;
  const where = [scopeLabel(r.scope ?? ref?.scope ?? "personal"), n ? (n.layer === "long" ? "long-term" : "short-term") : "", n ? (n.kind === "rule" && n.severity ? `rule ${n.severity.toUpperCase()}` : n.kind) : "", n ? `urgency ${n.urgency}` : "", n?.pinned ? "pinned" : ""].filter(Boolean).join(" · ");
  const lines = [`${r.status === "merged" ? "Merged into" : "Remembered as"} [m:${r.id}] (${where}).`];
  if (r.reroutedFrom) lines.push(`Stored in ${scopeLabel(r.scope!)} instead of ${scopeLabel(r.reroutedFrom)}${r.sensitivity === "personal" ? ": it looks personal or sensitive, and such memories never go to the shared store" : ": that store is not writable here"}.`);
  if (r.redacted) lines.push("A secret-looking value was redacted before storing.");
  if (r.superseded?.length) lines.push(`It replaces ${r.superseded.map((x) => `[m:${x}]`).join(", ")}.`);
  if (r.subsumed?.length) lines.push(`It absorbed ${r.subsumed.map((x) => `[m:${x}]`).join(", ")}.`);
  if (r.conflicts?.length) lines.push(`⚠ It conflicts with ${r.conflicts.map((x) => `[m:${x}]`).join(", ")}; both are kept and shown together.`);
  if (n && n.anchors.length) {
    const at = mem.paths.displayAnchors(ref!).map((a) => a.at).filter(Boolean);
    if (at.length) lines.push(`Anchored at ${at.slice(0, 4).join(", ")}${at.length > 4 ? ` +${at.length - 4}` : ""}.`);
  }
  return lines.join("\n");
}

export async function remember(env: ToolEnv, input: RememberInput, signal?: AbortSignal): Promise<{ result: WriteResult; text: string }> {
  const mem = env.memory!;
  const c: Candidate = {
    text: input.text,
    kind: input.kind,
    origin: "explicit",
    scope: input.scope,
    urgency: input.urgency,
    urgencyBy: input.urgency ? input.by : undefined,
    severity: input.severity ?? (input.kind === "rule" ? "should" : undefined),
    // pinned only when the user asked for it (§6.3.1)
    pin: input.by === "user" ? true : input.pin === true,
    paths: input.paths?.length ? input.paths : undefined,
    commands: input.commands?.length ? input.commands : undefined,
    provenance: { sessionId: env.sessionId },
    keep: true,
  };
  const [result] = await mem.writer.write([c], { signal });
  const r = result ?? { status: "failed" as const, reason: "nothing was written" };
  return { result: r, text: describeWrite(mem, r) };
}

export async function runRemember(env: ToolEnv, raw: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResultPayload> {
  if (ctx.aux) return fail("remember is not available to helper sessions.");
  const mem = env.memory;
  if (!mem) return fail("Memory is not available in this session.");
  const text = str(raw.text);
  if (!text) return fail("remember needs `text`: one fact, rule, preference or procedure, written to stand on its own.");
  const out = await remember(
    env,
    {
      text,
      kind: oneOf(raw.kind, KINDS),
      scope: oneOf(raw.scope, SCOPES),
      paths: strList(raw.paths),
      commands: strList(raw.commands),
      severity: oneOf(raw.severity, SEVERITIES),
      urgency: oneOf(raw.urgency, URGENCY_ORDER),
      pin: raw.pin === true,
      by: "agent",
    },
    ctx.signal,
  );
  const details = { status: out.result.status, id: out.result.id ? `m:${out.result.id}` : undefined, scope: out.result.scope, superseded: out.result.superseded, conflicts: out.result.conflicts, redacted: out.result.redacted };
  return out.result.status === "failed" ? fail(out.text, details) : ok(out.text, details);
}

export type Target = { ref: ScopedNode } | { candidates: Array<{ ref: ScopedNode; score: number }>; message: string };

/**
 * A target is an ID or a query. A query acts only when it resolves to a single memory: its
 * similarity clears the retrieval floor and leads the runner-up by `forget.queryMargin` (§6.5.6).
 */
export async function resolveTarget(env: ToolEnv, target: string, opts: { includeRetired?: boolean; signal?: AbortSignal } = {}): Promise<Target> {
  const mem = env.memory!;
  const id = parseId(target) ?? (/^[0-9a-z]{8}$/.test(target.trim()) ? { type: "m" as const, id: target.trim(), full: `m:${target.trim()}` } : null);
  if (id) {
    if (id.type !== "m") return { candidates: [], message: `[${id.full}] is not a memory. Only memories (m: IDs) can be forgotten; transcripts are the user's own.` };
    const ref = mem.graph.get(id.id, { includePurged: opts.includeRetired });
    if (ref) return { ref };
    const aliases = mem.graph.aliasesOf(id.id);
    return { candidates: aliases.map((a) => ({ ref: a, score: 1 })), message: aliases.length ? `[${id.full}] was re-keyed after an ID collision.` : `No memory [${id.full}] is visible here.` };
  }
  const found = await mem.writer.similar(target, mem.graph.visible(), 5, opts.signal);
  if (!found.length) return { candidates: [], message: "No memory matches that description." };
  const [top, second] = found;
  const unit = (x: { sim: number; mode: typeof top.mode }) => mem.sim.toUnit(x.sim, x.mode);
  const clears = top!.sim >= mem.sim.threshold("floor", top!.mode);
  const lead = second ? unit(top!) - unit(second) : 1;
  if (clears && lead >= env.cfg.forget.queryMargin) return { ref: top!.ref };
  return {
    candidates: found.map((f) => ({ ref: f.ref, score: Math.round(unit(f) * 100) / 100 })),
    message: clears ? "Several memories match about equally well. Nothing was changed." : "No memory matches that description closely enough. Nothing was changed.",
  };
}

export function describeCandidates(t: Extract<Target, { candidates: unknown }>): string {
  if (!t.candidates.length) return t.message;
  return `${t.message}\nCandidates:\n${t.candidates.map((c) => `- ${captionLine(c.ref)} (${scopeLabel(c.ref.scope)}, match ${c.score.toFixed(2)})`).join("\n")}\nName one by its ID.`;
}

export function describeForget(out: ForgetOutcome, opts: { byUser: boolean }): string {
  const ref = out.ref;
  const name = ref ? `${mid(ref.node)} "${ref.node.title}" (${scopeLabel(ref.scope)})` : "the memory";
  switch (out.status) {
    case "retired": {
      const lines = [`Retired ${name}. It is archived and no longer retrieved; /realctx2 restore m:${ref!.node.id} brings it back.`];
      if (ref!.scope === "shared") lines.push("Teammates get the retirement with the next flush of the shared store.");
      if (out.message) lines.push(out.message);
      return lines.join("\n");
    }
    case "purged": {
      const lines = [`Purged ${name}. It left retrieval at once; its text is removed from the store files when this session ends (until then, /realctx2 restore m:${ref!.node.id} undoes it).`];
      if (out.cascade?.length) lines.push(`Purged with it, because it was their only evidence: ${out.cascade.map((x) => `[m:${x}]`).join(", ")}.`);
      if (ref!.scope === "shared" && opts.byUser) {
        lines.push("Shared store: git history still holds the text. To remove it there as well, rewrite history (for example `git filter-repo --path .pi/realctx2 --invert-paths` on a fresh clone, then force-push) and ask teammates to re-clone.");
        lines.push("Teammates with unsent updates will go through stranded-update recovery at their next load.");
      }
      return lines.join("\n");
    }
    case "already":
      return `${name} is already retired.${out.message ? `\n${out.message}` : ""}`;
    case "refused":
      return `Nothing was changed: ${out.message ?? "the store is read-only here"}.`;
    default:
      return out.message ?? "Nothing was changed.";
  }
}

export async function runForget(env: ToolEnv, raw: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResultPayload> {
  if (ctx.aux) return fail("forget is not available to helper sessions.");
  const mem = env.memory;
  if (!mem) return fail("Memory is not available in this session.");
  const target = str(raw.target);
  const reason = str(raw.reason);
  if (!target) return fail("forget needs a `target`: a memory ID, or a description that matches exactly one memory.");
  if (!reason) return fail("forget needs a `reason`: it is stored with the retired memory.");
  const t = await resolveTarget(env, target, { signal: ctx.signal });
  if ("candidates" in t) return ok(describeCandidates(t), { status: "ambiguous", candidates: t.candidates.map((c) => ({ id: `m:${c.ref.node.id}`, scope: c.ref.scope, score: c.score })) });
  // acts at once, without confirmation (§6.5.6)
  const out = mem.lifecycle.forget(t.ref, reason, { purge: raw.purge === true, byAgent: true });
  const text = describeForget(out, { byUser: false });
  const details = { status: out.status, id: `m:${t.ref.node.id}`, scope: t.ref.scope, cascade: out.cascade };
  return out.status === "refused" ? fail(text, details) : ok(text, details);
}
