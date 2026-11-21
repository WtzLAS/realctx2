/**
 * Use accounting (§6.7): counters, accesses and strength events are aggregated per session and
 * written once, at shutdown or before maintenance (§7.3).
 */
import type { Config } from "../core/config.ts";
import type { Clock, MemoryNode, ScopeName, StrengthEvent, UseCounters } from "../core/types.ts";
import { randomId8 } from "../util/ids.ts";
import type { MemoryGraph } from "./graph.ts";
import { recentUses, reviewWorthClass, useSignals } from "./strength.ts";
import { escalation, violationCounter } from "./urgency.ts";

interface Pending {
  scope: ScopeName;
  id: string;
  counters: Partial<Record<keyof UseCounters, number>>;
  events: StrengthEvent[];
  accessAt?: string;
  deliveredAt?: string;
  usedThisSession: boolean;
}

export interface EscalationEvent {
  scope: ScopeName;
  id: string;
  from: string;
  to?: string;
  action: "escalate" | "flag-rewrite" | "list-for-review";
}

export class SessionAccounting {
  private pending = new Map<string, Pending>();
  private turns = 0;
  private readonly clock: Clock;
  readonly escalations: EscalationEvent[] = [];

  constructor(clock: Clock = () => new Date()) {
    this.clock = clock;
  }

  private slot(scope: ScopeName, id: string): Pending {
    const key = `${scope}:${id}`;
    let p = this.pending.get(key);
    if (!p) {
      p = { scope, id, counters: {}, events: [], usedThisSession: false };
      this.pending.set(key, p);
    }
    return p;
  }

  bump(scope: ScopeName, id: string, name: keyof UseCounters, delta = 1): void {
    if (!(delta > 0)) return;
    const p = this.slot(scope, id);
    p.counters[name] = (p.counters[name] ?? 0) + delta;
    if (name === "delivered") p.deliveredAt = this.clock().toISOString();
  }

  /** Counter value including what this session has not written yet. */
  pendingOf(scope: ScopeName, id: string, name: keyof UseCounters): number {
    return this.pending.get(`${scope}:${id}`)?.counters[name] ?? 0;
  }

  /** `lastAccessAt` changes only on attributed use or explicit expansion (§6.4.3). */
  touch(scope: ScopeName, id: string): void {
    this.slot(scope, id).accessAt = this.clock().toISOString();
  }

  /** Attributed use with weight u: counters, a reinforcement event, and an access (§5.5.6, §6.5.1). */
  use(scope: ScopeName, node: MemoryNode, u: number, outcome?: "success" | "failure" | "abandoned"): void {
    if (!(u > 0)) return;
    const p = this.slot(scope, node.id);
    p.counters.used = (p.counters.used ?? 0) + u;
    if (outcome === "success") p.counters.usedSuccess = (p.counters.usedSuccess ?? 0) + u;
    else if (outcome === "failure") p.counters.usedFailure = (p.counters.usedFailure ?? 0) + u;
    const now = this.clock();
    p.events.push({ id: `r-${randomId8()}`, t: now.toISOString(), kind: "reinforce", value: u, n: recentUses(node, now) + p.events.length });
    p.accessAt = now.toISOString();
    if (!p.usedThisSession && u >= 0.5) {
      p.usedThisSession = true;
      p.counters.useSessions = (p.counters.useSessions ?? 0) + 1;
    }
  }

  /** One scope turn (SF turn decay); the counter is written with the rest of the batch. */
  turn(): void {
    this.turns++;
  }

  size(): number {
    return this.pending.size;
  }

  /**
   * Write the batch into the documents. Also applies the use signals that follow from the new
   * totals: review flags (§6.7) and urgency escalation (§6.10.4).
   */
  flush(graph: MemoryGraph, cfg: Config): { nodes: number; escalations: EscalationEvent[] } {
    const touched = new Set<ScopeName>();
    const escalated: EscalationEvent[] = [];
    let nodes = 0;
    for (const p of this.pending.values()) {
      if (!graph.has(p.scope) || !graph.writable(p.scope)) continue;
      const sd = graph.sd(p.scope);
      if (!sd.hasNode(p.id)) continue;
      for (const [name, delta] of Object.entries(p.counters)) if (delta) sd.incCounter(p.id, name as keyof UseCounters, delta);
      for (const e of p.events) sd.addStrengthEvent(p.id, e);
      if (p.accessAt || p.deliveredAt) sd.patchNode(p.id, { ...(p.accessAt ? { lastAccessAt: p.accessAt } : {}), ...(p.deliveredAt ? { lastDeliveredAt: p.deliveredAt } : {}) }, "counters");
      nodes++;
      touched.add(p.scope);
      const node = sd.getNode(p.id);
      if (!node) continue;
      // review flags from the new totals
      const flags = new Set(node.flags ?? []);
      const before = flags.size;
      const sig = useSignals(node);
      if (sig.rewriteCandidate) flags.add("rewrite-candidate");
      if (sig.harmful) flags.add("harm");
      if (reviewWorthClass(node) === "low") flags.add("low-value");
      // escalation: a memory that keeps being broken is pushed harder
      if ((p.counters[violationCounter(node.urgency)] ?? 0) > 0) {
        const esc = escalation(node, cfg);
        if (esc.action === "escalate" && esc.to) {
          sd.patchNode(p.id, { urgency: esc.to, urgencyBy: "escalation", violationsBaseline: { ...(node.violationsBaseline ?? {}), [esc.to]: node.counters[violationCounter(esc.to)] } });
          flags.add("escalated");
          escalated.push({ scope: p.scope, id: p.id, from: node.urgency, to: esc.to, action: "escalate" });
        } else if (esc.action === "flag-rewrite") {
          flags.add("rewrite-candidate");
          escalated.push({ scope: p.scope, id: p.id, from: node.urgency, action: "flag-rewrite" });
        } else if (esc.action === "list-for-review") {
          flags.add("violated");
          escalated.push({ scope: p.scope, id: p.id, from: node.urgency, action: "list-for-review" });
        }
      }
      if (flags.size !== before) sd.patchNode(p.id, { flags: [...flags] });
    }
    if (this.turns > 0) {
      for (const scope of graph.visible()) {
        if (!graph.writable(scope)) continue;
        graph.sd(scope).incTurns(this.turns);
        touched.add(scope);
      }
    }
    this.pending.clear();
    this.turns = 0;
    for (const scope of touched) graph.commit(scope, "accounting");
    this.escalations.push(...escalated);
    return { nodes, escalations: escalated };
  }
}
