/**
 * Lifecycle (§6.5): strength bookkeeping, importance and layer moves, the forgetting tiers,
 * and explicit forgetting (retire, purge, restore).
 */
import type { MemoryNode, ScopedNode, ScopeName } from "../core/types.ts";
import { randomId8 } from "../util/ids.ts";
import { daysBetween } from "../util/text.ts";
import type { MemoryGraph } from "./graph.ts";
import type { MemoryServices } from "./services.ts";
import { accessScore, foldPlan, importance, memoryWorth, retention, reviewWorthClass, strengthAt, THETA_DEMOTE, THETA_PROMOTE } from "./strength.ts";

export interface HygieneReport {
  scope: ScopeName;
  folded: number;
  promoted: string[];
  demoted: string[];
  dormant: string[];
  archived: string[];
  lowValue: string[];
  forgettingRan: boolean;
  threshold: number;
  overCap: { short: boolean; long: boolean };
  revivalRate: number;
}

export interface ForgetOutcome {
  status: "retired" | "purged" | "refused" | "ambiguous" | "not-found" | "already";
  ref?: ScopedNode;
  /** Other nodes removed with it (derived nodes whose only evidence it was). */
  cascade?: string[];
  candidates?: Array<{ ref: ScopedNode; score: number }>;
  message?: string;
}

const GUARD_DELIVERED_DAYS = 7;
const GUARD_CREATED_DAYS = 3;
const PURGE_PREFIX = "purge|";

/** Bring a dormant or archived node back: active, edges active, and a note of the revival. */
export function reviveNode(graph: MemoryGraph, ref: ScopedNode, now: Date): boolean {
  const { scope, node } = ref;
  if (node.status === "active" || node.status === "purged" || !graph.writable(scope)) return false;
  const sd = graph.sd(scope);
  const flags = new Set(node.flags ?? []);
  // revivals of auto-forgotten nodes are counted, to notice over-forgetting (§11)
  if (node.statusReason?.startsWith("forgetting")) flags.add("revived");
  flags.delete("low-value");
  sd.patchNode(node.id, { status: "active", statusReason: null, statusAt: now.toISOString(), flags: [...flags], ...(node.status === "archived" ? { layer: "short" as const } : {}) });
  graph.setEdgesActive({ scope, node: sd.getNode(node.id)! }, true);
  return true;
}

export class Lifecycle {
  private readonly s: MemoryServices;

  constructor(services: MemoryServices) {
    this.s = services;
  }

  // ───────────── hygiene (model-free)
  /**
   * One hygiene pass over a scope: fold old strength events, refresh importance, move layers,
   * and run the forgetting pass when it is due (every `intervalTurns` scope turns, or daily).
   */
  hygiene(scope: ScopeName, opts: { forceForgetting?: boolean } = {}): HygieneReport {
    const g = this.s.graph;
    const cfg = this.s.cfg.memory;
    const report: HygieneReport = { scope, folded: 0, promoted: [], demoted: [], dormant: [], archived: [], lowValue: [], forgettingRan: false, threshold: cfg.forgetting.threshold, overCap: { short: false, long: false }, revivalRate: 0 };
    if (!g.has(scope) || !g.writable(scope)) return report;
    const h = g.handle(scope);
    const sd = h.store.sd;
    const now = this.s.clock();
    const nowIso = now.toISOString();

    for (const node of sd.allNodes()) {
      if (node.status === "purged") continue;
      // strength bookkeeping: fold events past the safety window (§7.3)
      const plan = foldPlan(node, now);
      if (plan && sd.foldStrength(node.id, plan.base, plan.remove)) report.folded++;
      if (node.status !== "active") continue;
      // importance (cached on the node; λ depends on it)
      const rel = this.s.sim.relevanceToPurposes(h, node.id, node.text);
      const I = importance(node, rel, now);
      if (node.importance === undefined || Math.abs(node.importance - I) >= 0.02) sd.patchNode(node.id, { importance: Math.round(I * 1000) / 1000 }, "counters");
      // layer moves, with hysteresis between the two thresholds
      const { mw, evidence } = memoryWorth(node.counters);
      const highValue = mw >= 0.6 && evidence >= 3;
      const fastTrack = node.counters.useSessions >= 3 && mw >= 0.6;
      if (node.layer === "short" && (I >= THETA_PROMOTE || fastTrack)) {
        this.moveLayer(scope, node, "long", nowIso);
        report.promoted.push(node.id);
      } else if (node.layer === "long" && I < THETA_DEMOTE && !node.pinned && !highValue) {
        this.moveLayer(scope, node, "short", nowIso);
        report.demoted.push(node.id);
      }
    }

    // dormant → archived after `dormantDays` unrevived
    for (const node of sd.allNodes()) {
      if (node.status !== "dormant" || !node.statusAt) continue;
      if (node.statusReason === "path-deleted") continue; // revived if the path returns (§6.8.4)
      if (daysBetween(node.statusAt, now) >= cfg.forgetting.dormantDays) {
        sd.patchNode(node.id, { status: "archived", statusReason: `${node.statusReason ?? "forgetting"}; unrevived`, statusAt: nowIso });
        report.archived.push(node.id);
      }
    }

    // forgetting pass: every N scope turns or daily, whichever comes first
    const lastAt = h.index?.getMeta("forget.lastAt") ?? null;
    const lastTurn = Number(h.index?.getMeta("forget.lastTurn") ?? 0);
    const due = opts.forceForgetting || !lastAt || daysBetween(lastAt, now) >= 1 || sd.turns() - lastTurn >= cfg.forgetting.intervalTurns;
    if (due) {
      this.forgettingPass(scope, report);
      h.index?.setMeta("forget.lastAt", nowIso);
      h.index?.setMeta("forget.lastTurn", String(sd.turns()));
    }
    g.commit(scope, "hygiene");
    g.syncIndex(scope);
    return report;
  }

  private moveLayer(scope: ScopeName, node: MemoryNode, layer: "short" | "long", nowIso: string): void {
    const sd = this.s.graph.sd(scope);
    // the transition snapshots (v_now, t_now), so switching β never distorts earlier decay (§6.5.1)
    sd.addStrengthEvent(node.id, { id: `l-${randomId8()}`, t: nowIso, kind: "layer", value: strengthAt(node, nowIso), layer });
    sd.patchNode(node.id, { layer });
  }

  /** Share of auto-forgotten nodes that came back within 30 days (§11: over-forgetting). */
  revivalRate(scope: ScopeName): { rate: number; forgotten: number } {
    const now = this.s.clock();
    let revived = 0;
    let forgotten = 0;
    for (const n of this.s.graph.sd(scope).allNodes()) {
      if (!n.statusAt || daysBetween(n.statusAt, now) > 30) continue;
      if (n.status === "active" && n.flags?.includes("revived")) revived++;
      else if ((n.status === "dormant" || n.status === "archived") && n.statusReason?.startsWith("forgetting")) forgotten++;
    }
    const total = revived + forgotten;
    return { rate: total ? revived / total : 0, forgotten: total };
  }

  private forgettingPass(scope: ScopeName, report: HygieneReport): void {
    const g = this.s.graph;
    const cfg = this.s.cfg.memory;
    const sd = g.sd(scope);
    const now = this.s.clock();
    const nowIso = now.toISOString();
    const active = sd.allNodes().filter((n) => n.status === "active");
    const short = active.filter((n) => n.layer === "short");
    const long = active.filter((n) => n.layer === "long");
    report.forgettingRan = true;
    report.overCap = { short: short.length > cfg.caps.short, long: long.length > cfg.caps.long };

    // over-forgetting: raise the guard periods and lower the thresholds
    const rev = this.revivalRate(scope);
    report.revivalRate = rev.rate;
    const cautious = rev.forgotten >= 10 && rev.rate > 0.1;
    const guardDelivered = GUARD_DELIVERED_DAYS * (cautious ? 2 : 1);
    const guardCreated = GUARD_CREATED_DAYS * (cautious ? 2 : 1);
    const strengthFloor = cfg.forgetting.strengthFloor * (cautious ? 0.5 : 1);
    const baseThreshold = cfg.forgetting.threshold * (cautious ? 0.5 : 1);

    const centrality = g.centrality(scope);
    const maxAccess = Math.max(0, ...active.map((n) => accessScore(n.counters)));
    const turns = sd.turns();
    const concepts = this.conceptEvidence(scope);
    const scored = short.map((n) => ({ n, v: strengthAt(n, now), R: retention(n, { now, maxAccess, centrality: centrality.get(n.id) ?? 0, scopeTurns: turns }) }));

    const guarded = (n: MemoryNode): boolean => {
      if (n.pinned) return true;
      const ref = { scope, node: n };
      if (g.headsChain(ref)) return true;
      const { mw, evidence } = memoryWorth(n.counters);
      if (mw >= 0.6 && evidence >= 3) return true;
      if (n.lastDeliveredAt && daysBetween(n.lastDeliveredAt, now) < guardDelivered) return true;
      if (daysBetween(n.createdAt, now) < guardCreated) return true;
      return false;
    };
    const forget = (n: MemoryNode, reason: string) => {
      const concept = concepts.take(n.id);
      if (concept) {
        // the only verified evidence of an active concept is archived under it instead
        sd.patchNode(n.id, { status: "archived", statusReason: `forgetting: kept under m:${concept}`, statusAt: nowIso });
        report.archived.push(n.id);
      } else {
        sd.patchNode(n.id, { status: "dormant", statusReason: `forgetting: ${reason}`, statusAt: nowIso });
        report.dormant.push(n.id);
      }
      g.setEdgesActive({ scope, node: sd.getNode(n.id)! }, false);
    };

    // soft cap: the R threshold rises to 0.15, then 0.20, until the scope is under the cap
    const steps = report.overCap.short ? [baseThreshold, 0.15, 0.2] : [baseThreshold];
    const gone = new Set<string>();
    for (const threshold of steps) {
      report.threshold = threshold;
      for (const { n, v, R } of scored) {
        if (gone.has(n.id) || guarded(n)) continue;
        if (v < strengthFloor) {
          forget(n, `strength ${v.toFixed(3)}`);
          gone.add(n.id);
        } else if (R < threshold) {
          forget(n, `retention ${R.toFixed(3)}`);
          gone.add(n.id);
        }
      }
      if (short.length - gone.size <= cfg.caps.short) break;
    }
    // Memory Worth low-value nodes: dormant and flagged for review (§6.7); long-term ones are only flagged
    for (const n of active) {
      if (gone.has(n.id) || reviewWorthClass(n) !== "low" || n.pinned) continue;
      const flags = [...new Set([...(n.flags ?? []), "low-value"])];
      if (n.layer === "short") {
        sd.patchNode(n.id, { status: "dormant", statusReason: "forgetting: low Memory Worth", statusAt: nowIso, flags });
        g.setEdgesActive({ scope, node: sd.getNode(n.id)! }, false);
        report.dormant.push(n.id);
      } else if (!n.flags?.includes("low-value")) sd.patchNode(n.id, { flags });
      report.lowValue.push(n.id);
    }
  }

  /**
   * Track active verified members of unverified active concepts dynamically during a forgetting
   * pass so removing multiple members in one pass still archives the last remaining evidence.
   */
  private conceptEvidence(scope: ScopeName): { take(memberId: string): string | undefined } {
    const sd = this.s.graph.sd(scope);
    const members = new Map<string, string[]>();
    for (const e of sd.allEdges()) {
      if (e.rel !== "generalizes" || (e.dstScope && e.dstScope !== scope)) continue;
      const list = members.get(e.src);
      if (list) list.push(e.dst);
      else members.set(e.src, [e.dst]);
    }
    const remaining = new Map<string, Set<string>>();
    const byMember = new Map<string, string[]>();
    for (const [conceptId, ids] of members) {
      const concept = sd.getNode(conceptId);
      if (!concept || concept.status !== "active" || concept.evidence.some((e) => e.verified)) continue;
      const verified = new Set(
        ids.filter((id) => {
          const m = sd.getNode(id);
          return m && m.status === "active" && m.evidence.some((e) => e.verified);
        }),
      );
      if (!verified.size) continue;
      remaining.set(conceptId, verified);
      for (const id of verified) {
        const list = byMember.get(id);
        if (list) list.push(conceptId);
        else byMember.set(id, [conceptId]);
      }
    }
    return {
      take(memberId: string): string | undefined {
        const list = byMember.get(memberId);
        if (!list) return undefined;
        let sole: string | undefined;
        for (const conceptId of list) {
          const set = remaining.get(conceptId);
          if (!set?.has(memberId)) continue;
          if (set.size === 1) sole ??= conceptId;
          set.delete(memberId);
        }
        return sole;
      },
    };
  }

  // ───────────── explicit forgetting (§6.5.6)
  /**
   * Retire (default) or purge a memory. No confirmation: it acts at once.
   * `byAgent` enforces the shared-scope restriction on purges.
   */
  forget(ref: ScopedNode, reason: string, opts: { purge?: boolean; byAgent?: boolean } = {}): ForgetOutcome {
    const g = this.s.graph;
    const { scope, node } = ref;
    if (!g.writable(scope)) return { status: "refused", ref, message: `the ${scope} store is read-only here` };
    const sd = g.sd(scope);
    const nowIso = this.s.clock().toISOString();
    let purge = opts.purge === true;
    let message: string | undefined;
    if (purge && scope === "shared" && opts.byAgent) {
      // a shared purge writes a non-lagged snapshot that strands teammates' in-flight updates (§7.10)
      purge = false;
      message = `Retired instead of purged: a permanent purge of shared memory must be run by the user with \`/realctx2 forget m:${node.id} --purge\`.`;
    }
    if (!purge) {
      if (node.status === "archived") return { status: "already", ref, message };
      sd.patchNode(node.id, { status: "archived", statusReason: `retired: ${reason}`.slice(0, 300), statusAt: nowIso });
      g.setEdgesActive({ scope, node: sd.getNode(node.id)! }, false);
      g.commit(scope, "retire");
      g.syncIndex(scope);
      return { status: "retired", ref: { scope, node: sd.getNode(node.id)! }, message };
    }
    const cascade = this.purgeOne(scope, node, reason, nowIso);
    g.commit(scope, "purge");
    return { status: "purged", ref, cascade };
  }

  private purgeOne(scope: ScopeName, node: MemoryNode, reason: string, nowIso: string, seen = new Set<string>()): string[] {
    const g = this.s.graph;
    const h = g.handle(scope);
    const sd = h.store.sd;
    if (seen.has(node.id)) return [];
    seen.add(node.id);
    // derived nodes whose only evidence was this node go with it
    const dependents: MemoryNode[] = [];
    for (const nb of g.neighbors({ scope, node })) {
      if (nb.other.scope !== scope || seen.has(nb.other.node.id)) continue;
      const other = nb.other.node;
      if (nb.edge.rel === "derived-from" && nb.direction === "in") {
        const otherSources = g.neighbors(nb.other, { rels: ["derived-from"] }).filter((x) => x.direction === "out" && x.other.node.id !== node.id && x.other.node.status !== "purged");
        if (!otherSources.length && !other.evidence.some((e) => e.verified) && other.origin !== "explicit" && other.origin !== "instructions") dependents.push(other);
      } else if (nb.edge.rel === "generalizes" && nb.direction === "in") {
        const members = g.neighbors(nb.other, { rels: ["generalizes"] }).filter((x) => x.direction === "out" && x.other.node.id !== node.id && x.other.node.status !== "purged");
        if (!members.length) dependents.push(other);
      }
    }
    // at once: out of retrieval, the derived index and the vector caches; marked purged on this machine
    sd.patchNode(node.id, { status: "purged", statusReason: `${PURGE_PREFIX}${node.status}|${reason}`.slice(0, 300), statusAt: nowIso });
    g.setEdgesActive({ scope, node: sd.getNode(node.id)! }, false);
    h.index?.remove(node.id);
    h.store.pendingPurge.add(node.id);
    // turn-index entries holding its quoted evidence are dropped too
    this.s.turns?.removeContaining(node.evidence.map((e) => e.quote));
    const out: string[] = [];
    for (const d of dependents) {
      out.push(d.id, ...this.purgeOne(scope, d, `derived from purged m:${node.id}`, nowIso, seen));
    }
    return out;
  }

  /** Reverse a retirement, or a purge that has not reached the session-end flush yet. */
  restore(rawId: string): ForgetOutcome {
    const g = this.s.graph;
    const ref = g.get(rawId, { includePurged: true });
    if (!ref) return { status: "not-found", message: "No such memory here. A purge cannot be undone after the flush that removed it." };
    if (!g.writable(ref.scope)) return { status: "refused", ref };
    const { scope, node } = ref;
    const h = g.handle(scope);
    const sd = h.store.sd;
    const now = this.s.clock();
    if (node.status === "purged") {
      const [, prev] = (node.statusReason ?? "").split("|");
      const status = prev === "dormant" || prev === "archived" ? prev : "active";
      h.store.pendingPurge.delete(node.id);
      sd.patchNode(node.id, { status, statusReason: null, statusAt: now.toISOString() });
      if (status === "active") g.setEdgesActive({ scope, node: sd.getNode(node.id)! }, true);
    } else if (node.status === "active") return { status: "already", ref };
    else reviveNode(g, ref, now);
    g.commit(scope, "restore");
    g.syncIndex(scope);
    return { status: "retired", ref: { scope, node: sd.getNode(node.id)! }, message: "restored" };
  }
}
