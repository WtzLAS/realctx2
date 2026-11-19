/**
 * Session state (§5.1): intent stack, consolidation map, delivery ledger and round statistics,
 * rebuilt from the session's realctx2 records on the active branch.
 */
import type { AttributionRecord, ConsolidationRecord, Delivery, EntryView, Intent, SessionRecord, StatsRecord } from "../core/types.ts";

export interface Region {
  /** Level 0 is the root region; level j ≥ 1 belongs to the j-th open intent (outermost first). */
  level: number;
  intent: Intent | null;
  /** Entry index of the region's first entry (the intent's guidance message for level ≥ 1). */
  from: number;
  /** One past the region's last entry. */
  to: number;
}

export class SessionState {
  /** Every intent of the branch by id (latest record wins). */
  intents = new Map<string, Intent>();
  /** Open intents, outermost first. */
  stack: Intent[] = [];
  records = new Map<string, ConsolidationRecord>();
  /** Current consolidation anchored at an entry (the latest one wins). */
  anchorOf = new Map<string, string>();
  deliveries: Delivery[] = [];
  attributed = new Map<string, AttributionRecord>();
  stats: StatsRecord = { type: "realctx2.stats", roundTokens: [], janusLate: 0, foldsSkippedByCost: 0, frontier: 0, lastClimbRound: 0, round: 0 };
  /** Order in which closed intents closed (for episodes and the post-compaction injection). */
  closedOrder: string[] = [];

  static from(records: SessionRecord[]): SessionState {
    const s = new SessionState();
    for (const r of records) s.apply(r);
    return s;
  }

  apply(r: SessionRecord): void {
    switch (r.type) {
      case "realctx2.intent": {
        const prev = this.intents.get(r.intent.id);
        this.intents.set(r.intent.id, { ...r.intent });
        if (r.intent.status !== "open" && prev?.status === "open") this.closedOrder.push(r.intent.id);
        else if (r.intent.status !== "open" && !prev) this.closedOrder.push(r.intent.id);
        this.restack();
        break;
      }
      case "realctx2.consolidation": {
        this.records.set(r.record.id, r.record);
        if (!r.record.shadow) this.anchorOf.set(r.record.anchorId, r.record.id);
        break;
      }
      case "realctx2.delivery": {
        const i = this.deliveries.findIndex((d) => d.deliveryId === r.delivery.deliveryId);
        if (i >= 0) this.deliveries[i] = r.delivery;
        else this.deliveries.push(r.delivery);
        break;
      }
      case "realctx2.attribution":
        this.attributed.set(r.deliveryId, r);
        break;
      case "realctx2.stats":
        this.stats = { ...this.stats, ...r };
        break;
    }
  }

  private restack(): void {
    const open = [...this.intents.values()].filter((i) => i.status === "open");
    // order by ancestry: a parent always comes before its children
    const depth = (i: Intent): number => {
      let d = 0;
      let cur: Intent | undefined = i;
      const seen = new Set<string>();
      while (cur?.parentId && !seen.has(cur.id)) {
        seen.add(cur.id);
        cur = this.intents.get(cur.parentId);
        d++;
      }
      return d;
    };
    // only one chain can be open: follow parent links from the deepest open intent
    const deepest = open.sort((a, b) => depth(b) - depth(a) || b.openedRound - a.openedRound)[0];
    const chain: Intent[] = [];
    let cur: Intent | undefined = deepest;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.status === "open") chain.unshift(cur);
      cur = cur.parentId ? this.intents.get(cur.parentId) : undefined;
    }
    this.stack = chain;
  }

  innermost(): Intent | null {
    return this.stack[this.stack.length - 1] ?? null;
  }

  /** Labels of the enclosing open intents of an intent, outermost first (the telos chain). */
  telos(intent: Intent | null): string[] {
    const out: string[] = [];
    let cur = intent?.parentId ? this.intents.get(intent.parentId) : undefined;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      out.unshift(cur.label);
      cur = cur.parentId ? this.intents.get(cur.parentId) : undefined;
    }
    return out;
  }

  /**
   * Regions of the open stack over the entry list:
   * C₀ = [first, b₁), C_j = [b_j, b_{j+1}), C_d = [b_d, leaf].
   * Intents whose guidance entry is not on this branch yet are left out.
   */
  regions(entries: EntryView[]): Region[] {
    const index = new Map(entries.map((e, i) => [e.id, i]));
    const located = this.stack.map((intent) => ({ intent, at: intent.guidanceEntryId ? index.get(intent.guidanceEntryId) : undefined })).filter((x): x is { intent: Intent; at: number } => x.at !== undefined);
    const out: Region[] = [{ level: 0, intent: null, from: 0, to: located[0]?.at ?? entries.length }];
    located.forEach((x, i) => out.push({ level: i + 1, intent: x.intent, from: x.at, to: located[i + 1]?.at ?? entries.length }));
    return out;
  }

  /** The consolidation record currently shown at an entry, if the entry is an anchor. */
  recordAt(entryId: string): ConsolidationRecord | null {
    const id = this.anchorOf.get(entryId);
    return id ? (this.records.get(id) ?? null) : null;
  }

  /** The consolidation that holds a raw entry directly (for `inspect` on raw turns). */
  holderOf(entryId: string): ConsolidationRecord | null {
    let best: ConsolidationRecord | null = null;
    for (const r of this.records.values()) {
      if (r.children.some((c) => "entryId" in c && c.entryId === entryId)) {
        if (!best || r.createdAt > best.createdAt) best = r;
      }
    }
    return best;
  }

  /** The record that lists `id` as a nested child. */
  parentOf(id: string): ConsolidationRecord | null {
    for (const r of this.records.values()) if (r.children.some((c) => "id" in c && c.id === id)) return r;
    return null;
  }

  deliveriesOf(memoryOrArchiveId: string): Delivery[] {
    return this.deliveries.filter((d) => d.id === memoryOrArchiveId || d.nodeIds?.includes(memoryOrArchiveId.replace(/^m:/, "")));
  }
}
