/**
 * Guard for `bash` in aux sessions (§9.3.2): the deny list, writes outside the repository, and
 * the pre-edit gate for `immediate` memories. A blocked call returns an error to the aux session.
 */
import { isAbsolute, relative, resolve } from "node:path";
import type { Config } from "../core/config.ts";
import type { MemoryRuntime } from "../memory/runtime.ts";
import { commandMatcher } from "../util/glob.ts";
import { analyzeCommand, normalizeCommandParts } from "../util/shell.ts";
import { pathEventOf } from "./pathevents.ts";

function inside(root: string, abs: string): boolean {
  const r = relative(root, abs);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

export function checkAuxBash(command: string, o: { cfg: Config; cwd: string; root: string | null; memory: MemoryRuntime | null }): string | null {
  const guard = o.cfg.providers.aux.guard;
  const parts = normalizeCommandParts(command);
  for (const pattern of guard.deny) {
    const match = commandMatcher(pattern);
    const hit = parts.find((p) => match(p)) ?? (match(command.trim().replace(/\s+/g, " ")) ? command : undefined);
    if (hit) return `blocked by aux.guard.deny ("${pattern}")`;
  }
  const fx = analyzeCommand(command, { cwd: o.cwd });
  if (guard.writesOutsideRepo === "block") {
    const root = o.root ?? o.cwd;
    const targets = [...fx.writes, ...fx.deletes, ...fx.moves.flatMap((m) => [m.from, m.to]), ...fx.copies.map((c) => c.to), ...fx.mkdirs];
    const out = targets.map((t) => resolve(o.cwd, t)).find((t) => !inside(root, t) && t !== "/dev/null");
    if (out) return `blocked: it writes outside the repository (${out})`;
  }
  const mem = o.memory;
  if (mem && o.cfg.urgency.gate !== "off") {
    const event = pathEventOf("bash", { command }, { cwd: o.cwd, rel: (p, cwd) => mem.paths.rel(p, cwd) });
    // an aux session has no intent of its own: every matching `immediate` memory blocks
    const decision = event ? mem.delivery.gate(event, { gated: () => false, shownFull: () => false }) : null;
    if (decision) return `blocked by memory: ${decision.reason}`;
  }
  return null;
}
