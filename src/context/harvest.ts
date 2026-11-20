/**
 * The hand-off from consolidation to long-term memory (§5.3.4, §5.4.4): a committed Precip
 * record becomes an episode, each committed fold sends its knowledge items to the write path
 * once, and idle time extracts knowledge from Precip memories no fold has covered yet.
 */
import type { ConsolidationRecord, KnowledgeItem, ScopeName, SessionRecord } from "../core/types.ts";
import type { MemoryRuntime } from "../memory/runtime.ts";
import type { Candidate } from "../memory/write.ts";
import { estimateTokens } from "../util/text.ts";
import { type Consolidator, knowledgeKey } from "./consolidate.ts";
import type { SessionState } from "./state.ts";

/** What the harvester reads from the engine that owns it, and does through it. */
export interface HarvestHost {
  readonly memory: MemoryRuntime | null;
  readonly sessionId: string;
  readonly consolidator: Consolidator;
  /** The session state of the active branch; `rebuild` replaces it. */
  state(): SessionState;
  /** Apply a record to the session state and queue it for the next commit point. */
  emit(record: SessionRecord): void;
  /** Register background work, so shutdown and tests can wait for it. */
  track<T>(p: Promise<T>): Promise<T>;
}

type EpisodeRef = { scope: ScopeName; id: string };

export class Harvester {
  private readonly host: HarvestHost;
  private readonly memory: MemoryRuntime | null;
  private readonly sessionId: string;
  private readonly consolidator: Consolidator;
  /** Knowledge items already sent to the write path, by item hash. */
  private harvested = new Set<string>();
  /** The newest episode on this branch: the next one links to it. */
  private lastEpisode: EpisodeRef | null = null;
  /** Episodes by the intent they consolidated: that intent's knowledge links to its episode. */
  private episodes = new Map<string, EpisodeRef>();

  constructor(host: HarvestHost) {
    this.host = host;
    this.memory = host.memory;
    this.sessionId = host.sessionId;
    this.consolidator = host.consolidator;
  }

  /** Start over on a branch: knowledge its records already carry counts as harvested. */
  reset(): void {
    this.harvested = new Set();
    for (const r of this.state.records.values()) for (const k of r.knowledge ?? []) this.harvested.add(knowledgeKey(k));
    this.lastEpisode = null;
    this.episodes.clear();
  }

  private get state(): SessionState {
    return this.host.state();
  }
  private emit(record: SessionRecord): void {
    this.host.emit(record);
  }
  private track<T>(p: Promise<T>): Promise<T> {
    return this.host.track(p);
  }

  /** A committed Precip record becomes an episode, linked to the one before it (§5.3.4). */
  handOffEpisode(record: ConsolidationRecord): void {
    const mem = this.memory;
    if (!mem || !record.text || !record.sidecar) return;
    const intentId = record.intentId;
    const entryIds = record.children.filter((c): c is { entryId: string } => "entryId" in c).map((c) => c.entryId).slice(0, 64);
    const body = record.text.split("\n").slice(1).join("\n");
    const candidate: Candidate = {
      text: body,
      title: record.sidecar.outcome_summary || undefined,
      kind: "episode",
      origin: "harvest",
      defaultScope: "personal",
      artifacts: [...record.sidecar.artifacts, ...record.sidecar.state_changes].slice(0, 32),
      evaluation: record.outcome === "success" ? "good" : record.outcome === "failure" ? "bad" : "neutral",
      provenance: { sessionId: this.sessionId, turnId: record.id, entryIds },
      after: this.lastEpisode ?? undefined,
      sourceTexts: [body],
    };
    void this.track(
      mem.writer.write([candidate]).then((res) => {
        const r = res[0];
        if (r?.id && r.scope && (r.status === "created" || r.status === "merged")) {
          this.lastEpisode = { scope: r.scope, id: r.id };
          if (intentId) this.episodes.set(intentId, this.lastEpisode);
        }
      }),
    ).catch(() => undefined);
  }

  /** Each committed fold sends its knowledge items to the write path, de-duplicated by item hash. */
  harvest(record: ConsolidationRecord): void {
    const mem = this.memory;
    const items = (record.knowledge ?? []).filter((k) => !this.harvested.has(knowledgeKey(k)) && !k.memoryId);
    if (!mem || !items.length) return;
    for (const k of items) this.harvested.add(knowledgeKey(k));
    const episode = record.intentId ? this.episodes.get(record.intentId) : undefined;
    const candidates: Candidate[] = items.map((k) => ({
      text: k.fact,
      kind: /^(run|use|pass|set|call|avoid|add|install|restart|always|never)\b/i.test(k.fact.replace(/^[`"']/, "")) ? "procedure" : "fact",
      origin: "harvest",
      evaluation: k.evaluation,
      validFrom: k.as_of && !Number.isNaN(Date.parse(k.as_of)) ? new Date(k.as_of).toISOString() : undefined,
      supersedesHint: k.supersedes,
      provenance: { sessionId: this.sessionId, turnId: record.id },
      evidence: [{ quote: k.fact, source: { type: "session", ref: record.id } }],
      sourceTexts: [record.text ?? ""],
      episode,
    }));
    void this.track(
      mem.writer.write(candidates).then((res) => {
        let any = false;
        const knowledge = (record.knowledge ?? []).map((k) => {
          const i = items.indexOf(k);
          const id = i >= 0 ? res[i]?.id : undefined;
          if (!id) return k;
          any = true;
          return { ...k, memoryId: id };
        });
        // the record learns which memories its knowledge went into (for `inspect`)
        if (any) this.emit({ type: "realctx2.consolidation", record: { ...(this.state.records.get(record.id) ?? record), knowledge } });
      }),
    ).catch(() => undefined);
  }

  /** Idle harvest (§5.4.4): one ripple-style extraction over Precip memories no fold has covered yet. */
  async idleHarvest(signal?: AbortSignal, budgetTokens = 12_000): Promise<number> {
    const open = [...this.state.records.values()].filter((r) => r.kind === "precip" && r.text && !r.knowledge && !this.state.parentOf(r.id)).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    if (!open.length) return 0;
    const picked: ConsolidationRecord[] = [];
    let tokens = 0;
    for (const r of open) {
      const t = estimateTokens(r.text!);
      if (tokens + t > budgetTokens && picked.length) break;
      picked.push(r);
      tokens += t;
    }
    const out = await this.consolidator.ripple({ text: picked.map((r) => r.text!).join("\n\n"), carry: [], telos: [] }, signal);
    if (!out || signal?.aborted) return 0;
    // it edits no context: the knowledge is attached to the Precip records and harvested
    picked.forEach((r, i) => {
      // the first record carries the items; the others are marked as covered
      const knowledge: KnowledgeItem[] = i === 0 ? out.knowledge : [];
      const updated: ConsolidationRecord = { ...r, knowledge };
      this.emit({ type: "realctx2.consolidation", record: updated });
      if (knowledge.length) this.harvest(updated);
    });
    return out.knowledge.length;
  }
}
