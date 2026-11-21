/** Local JSONL telemetry with no content by default (§10), plus daily token budgets (§9.5). */
import { join } from "node:path";
import { appendJsonl, ensureDir, listFiles, readJson, removeFile, writeJson } from "../util/fs.ts";
import type { Layout } from "./config.ts";

export interface CallRecord {
  callSite: string;
  kind: "decision" | "aux" | "embedding";
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  outcome: "ok" | "timeout" | "error" | "fallback" | "skipped" | "aborted";
  detail?: string;
  /** Which daily budget the tokens count toward; default: the call's kind. `none` counts nowhere. */
  budget?: "aux" | "decision" | "reverify" | "none";
}

/** True when a daily cap is set and today's spend has reached it. A cap of 0 (or less) means no limit. */
export function budgetReached(spent: number, cap: number): boolean {
  return cap > 0 && spent >= cap;
}

function day(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export class Telemetry {
  private readonly layout: Layout | null;
  private readonly includeContent: boolean;
  private spent: { day: string; aux: number; decision: number; reverify: number } | null = null;
  readonly recent: CallRecord[] = [];

  constructor(layout: Layout | null, includeContent = false) {
    this.layout = layout;
    this.includeContent = includeContent;
  }

  private write(file: string, rec: Record<string, unknown>): void {
    if (!this.layout) return;
    try {
      appendJsonl(join(ensureDir(this.layout.logsDir), `${file}-${day()}.jsonl`), { at: new Date().toISOString(), ...rec });
    } catch {
      // telemetry never breaks a session
    }
  }

  call(rec: CallRecord): void {
    this.recent.push(rec);
    if (this.recent.length > 200) this.recent.shift();
    const { detail, ...rest } = rec;
    this.write("calls", this.includeContent && detail ? { ...rest, detail } : rest);
    const budget = rec.budget ?? (rec.kind === "aux" || rec.kind === "decision" ? rec.kind : "none");
    if (budget !== "none") this.spend(budget, (rec.inputTokens ?? 0) + (rec.outputTokens ?? 0));
  }

  step(rec: Record<string, unknown>): void {
    this.write("steps", rec);
  }

  session(rec: Record<string, unknown>): void {
    this.write("sessions", rec);
  }

  event(name: string, rec: Record<string, unknown> = {}): void {
    this.write("events", { event: name, ...rec });
  }

  private budgetFile(): string | null {
    return this.layout ? join(this.layout.logsDir, `budget-${day()}.json`) : null;
  }

  private load(): { day: string; aux: number; decision: number; reverify: number } {
    const today = day();
    if (this.spent && this.spent.day === today) return this.spent;
    const f = this.budgetFile();
    const disk = f ? readJson<{ aux?: number; decision?: number; reverify?: number }>(f, {}) : {};
    this.spent = { day: today, aux: disk.aux ?? 0, decision: disk.decision ?? 0, reverify: disk.reverify ?? 0 };
    return this.spent;
  }

  spend(kind: "aux" | "decision" | "reverify", tokens: number): void {
    if (!tokens) return;
    const s = this.load();
    s[kind] += tokens;
    const f = this.budgetFile();
    if (f) {
      try {
        // re-read so parallel sessions add up
        const disk = readJson<{ aux?: number; decision?: number; reverify?: number }>(f, {});
        writeJson(f, { ...disk, [kind]: (disk[kind] ?? 0) + tokens });
      } catch {
        // ignore
      }
    }
  }

  spentToday(): { aux: number; decision: number; reverify: number } {
    const f = this.budgetFile();
    const s = this.load();
    if (f) {
      const disk = readJson<{ aux?: number; decision?: number; reverify?: number }>(f, {});
      return { aux: Math.max(s.aux, disk.aux ?? 0), decision: Math.max(s.decision, disk.decision ?? 0), reverify: Math.max(s.reverify, disk.reverify ?? 0) };
    }
    return { aux: s.aux, decision: s.decision, reverify: s.reverify };
  }

  /** Remove logs older than `keepDays`. */
  rotate(keepDays = 30): void {
    if (!this.layout) return;
    const cutoff = day(new Date(Date.now() - keepDays * 86_400_000));
    for (const f of listFiles(this.layout.logsDir)) {
      const m = /(\d{4}-\d{2}-\d{2})\.jsonl?$/.exec(f);
      if (m && m[1]! < cutoff) removeFile(join(this.layout.logsDir, f));
    }
  }
}
