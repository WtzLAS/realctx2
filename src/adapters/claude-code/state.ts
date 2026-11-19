/**
 * Session state for Claude Code (§4.6.6): Claude Code has no session entries like pi's, so each
 * session's realctx2 records live in a log of their own,
 * `~/.pi/agent/realctx2/sessions/<sessionId>/state.jsonl`, one record per change, in the same
 * shapes as pi's `realctx2.*` entries. Guidance realctx2 injected is logged next to them, since
 * hooks return it as `additionalContext` and it has no entry of its own in the transcript.
 */
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "../../core/config.ts";
import type { SessionRecord } from "../../core/types.ts";
import { RECORD_TYPES } from "../../core/types.ts";
import { appendJsonl, ensureDir, existsSync, readJsonl } from "../../util/fs.ts";

/** A message realctx2 put into context through a hook. */
export interface InjectedMessage {
  type: "realctx2.message";
  id: string;
  /** Entry the message follows (the last one when it was injected); "" at the start. */
  after: string;
  customType: string;
  content: string;
  details?: Record<string, unknown>;
  timestamp: string;
}

const RECORDS = new Set<string>(RECORD_TYPES);

export class SessionLog {
  readonly file: string;
  records: SessionRecord[] = [];
  messages: InjectedMessage[] = [];

  constructor(layout: Layout, sessionId: string) {
    this.file = join(layout.sessionDir(sessionId), "state.jsonl");
  }

  exists(): boolean {
    return existsSync(this.file);
  }

  /** Reload the log (`resume`); a missing or damaged log starts fresh. */
  load(): this {
    this.records = [];
    this.messages = [];
    for (const line of readJsonl<{ type?: string }>(this.file)) {
      if (line.type === "realctx2.message") this.messages.push(line as InjectedMessage);
      else if (line.type && RECORDS.has(line.type)) this.records.push(line as SessionRecord);
    }
    return this;
  }

  /** `fork`: the parent's log is copied when the parent session can be identified. */
  copyFrom(parent: SessionLog): boolean {
    if (!parent.exists() || this.exists()) return false;
    try {
      ensureDir(join(this.file, ".."));
      copyFileSync(parent.file, this.file);
      this.load();
      return true;
    } catch {
      return false;
    }
  }

  append(record: SessionRecord): void {
    this.records.push(record);
    this.write(record);
  }

  inject(message: InjectedMessage): void {
    this.messages.push(message);
    this.write(message);
  }

  private write(line: object): void {
    try {
      appendJsonl(this.file, line);
    } catch {
      // the state stays in memory for this process; a later resume starts without it (§4.6.6)
    }
  }
}
