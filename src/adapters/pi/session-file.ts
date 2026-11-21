/**
 * Reading an earlier pi session from its file (§5.6). Kept apart from the pi adapter: the
 * Claude Code server reads pi sessions too, and must load without pi's packages, which are
 * optional peer dependencies. Only type imports from them here.
 */
import { readFileSync } from "node:fs";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { EntryView, SessionRecord } from "../../core/types.ts";
import type { SessionEntry as RegisteredSession } from "../../memory/runtime.ts";
import { archiveEntries, branchRecords } from "./entries.ts";

/**
 * An earlier session of this project, read from its pi session file (§5.6): the branch that
 * ends at the last entry of the file.
 */
export function loadPiSession(session: RegisteredSession): { entries: EntryView[]; records: SessionRecord[] } | null {
  if (!session.file) return null;
  let text: string;
  try {
    text = readFileSync(session.file, "utf8");
  } catch {
    return null;
  }
  const byId = new Map<string, SessionEntry>();
  let last: SessionEntry | null = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { type?: string; id?: unknown };
      if (e.type === "session" || typeof e.id !== "string") continue;
      byId.set(e.id, e as SessionEntry);
      last = e as SessionEntry;
    } catch {
      // a torn last line
    }
  }
  if (!last) return null;
  const branch: SessionEntry[] = [];
  const seen = new Set<string>();
  for (let cur: SessionEntry | undefined = last; cur && !seen.has(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
    seen.add(cur.id);
    branch.unshift(cur);
  }
  return { entries: archiveEntries(branch), records: branchRecords(branch) };
}
