/**
 * Earlier sessions of a project (§5.6), whichever harness recorded them: pi session files and
 * Claude Code transcripts on one machine share memory and the turn index, so `recall` in one
 * harness can open a consolidation made in the other.
 */
import type { Layout } from "../core/config.ts";
import type { EntryView, SessionRecord } from "../core/types.ts";
import type { SessionEntry } from "../memory/runtime.ts";
import { ClaudeAdapter } from "./claude-code/adapter.ts";
import { SessionLog } from "./claude-code/state.ts";
import { TranscriptReader } from "./claude-code/transcript.ts";
import { loadPiSession } from "./pi/adapter.ts";

export async function loadAnySession(layout: Layout, session: SessionEntry): Promise<{ entries: EntryView[]; records: SessionRecord[] } | null> {
  if (session.harness === "claude-code") {
    if (!session.file) return null;
    const log = new SessionLog(layout, session.id).load();
    const adapter = new ClaudeAdapter(log, {
      reader: new TranscriptReader(),
      aux: () => {
        throw new Error("no aux sessions for an archived session");
      },
      now: () => new Date(),
    });
    adapter.transcriptPath = session.file;
    const entries = await adapter.archiveEntries();
    return entries.length || log.records.length ? { entries, records: log.records } : null;
  }
  return loadPiSession(session);
}
