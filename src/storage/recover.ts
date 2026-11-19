/**
 * State-level recovery (§7.9): when updates cannot be applied because their history was
 * trimmed, diff the state they produce against the state they were based on, node by node
 * and field by field, and re-apply the differences as new writes on the current document.
 */
import { COUNTER_NAMES, type MemoryNode, type PathAnchor } from "../core/types.ts";
import { anchorKey, evidenceKey, PLAIN_FIELDS, type ScopeDoc } from "./schema.ts";

export interface RecoveryReport {
  source?: string;
  nodesAdded: number;
  nodesPatched: number;
  nodesDeleted: number;
  edges: number;
  counters: number;
  paths: number;
  skipped: number;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Apply `after − before` to `target`.
 * `additiveOnly` never deletes (used when there is no real base to diff against).
 */
export function applyStateDiff(before: ScopeDoc, after: ScopeDoc, target: ScopeDoc, opts: { additiveOnly?: boolean } = {}): RecoveryReport {
  const report: RecoveryReport = { nodesAdded: 0, nodesPatched: 0, nodesDeleted: 0, edges: 0, counters: 0, paths: 0, skipped: 0 };

  // ── path registry: tree node ids survive when the target shares the history; otherwise map by path
  const idMap = new Map<string, string>();
  const mapPath = (id: string | undefined): string | undefined => {
    if (!id) return undefined;
    const known = idMap.get(id);
    if (known) return known;
    let mapped: string | undefined;
    if (target.pathEntry(id)) mapped = id;
    else {
      const entry = after.pathEntry(id) ?? before.pathEntry(id);
      if (entry) mapped = target.findPath(entry.path) ?? target.ensurePath(entry.path, entry.data.kind, { blob: entry.data.blob, fingerprint: entry.data.fingerprint, commit: entry.data.lastSeen.commit });
    }
    if (mapped) idMap.set(id, mapped);
    return mapped;
  };
  const beforePaths = new Map(before.pathEntries().map((e) => [e.id, e]));
  // parents before children, so moves and creations see their directories
  for (const entry of after.pathEntries().sort((a, b) => a.path.length - b.path.length)) {
    const prev = beforePaths.get(entry.id);
    if (!prev) {
      if (!target.findPath(entry.path)) report.paths++;
      mapPath(entry.id);
      continue;
    }
    const tid = mapPath(entry.id);
    if (!tid) continue;
    if (prev.path !== entry.path && target.pathOf(tid) !== entry.path) {
      if (target.movePath(tid, entry.path)) report.paths++;
    }
    const patch: Record<string, unknown> = {};
    for (const k of ["status", "blob", "fingerprint", "absentSince", "lastSeen"] as const) {
      if (!same(prev.data[k], entry.data[k]) && entry.data[k] !== undefined) patch[k] = entry.data[k];
    }
    if (Object.keys(patch).length) target.patchPath(tid, patch);
  }

  const remap = (a: PathAnchor): PathAnchor => (a.pathId ? { ...a, pathId: mapPath(a.pathId) ?? a.pathId } : a);

  // ── nodes
  const beforeNodes = new Map(before.allNodes().map((n) => [n.id, n]));
  const afterNodes = new Map(after.allNodes().map((n) => [n.id, n]));
  for (const node of afterNodes.values()) {
    const prev = beforeNodes.get(node.id);
    const cur = target.getNode(node.id);
    if (!prev) {
      if (cur) {
        if (cur.contentHash !== node.contentHash) report.skipped++;
        continue;
      }
      target.insertNode({ ...node, anchors: node.anchors.map(remap) });
      report.nodesAdded++;
      continue;
    }
    if (!cur) {
      // the node no longer exists on the current document (purged there): leave it purged
      report.skipped++;
      continue;
    }
    const patch: Record<string, unknown> = {};
    const p = prev as unknown as Record<string, unknown>;
    const n = node as unknown as Record<string, unknown>;
    for (const f of PLAIN_FIELDS) if (!same(p[f], n[f])) patch[f] = n[f] === undefined ? null : n[f];
    if (Object.keys(patch).length) {
      target.patchNode(node.id, patch as never);
      report.nodesPatched++;
    }
    const prevEvidence = new Set(prev.evidence.map(evidenceKey));
    for (const e of node.evidence) if (!prevEvidence.has(evidenceKey(e))) target.addEvidence(node.id, e);
    const prevAnchors = new Map(prev.anchors.map((a) => [anchorKey(a), a]));
    const nowAnchors = new Map(node.anchors.map((a) => [anchorKey(a), a]));
    for (const [k, a] of nowAnchors) if (!same(prevAnchors.get(k), a)) target.setAnchor(node.id, remap(a));
    if (!opts.additiveOnly) for (const [k, a] of prevAnchors) if (!nowAnchors.has(k)) target.removeAnchor(node.id, remap(a));
    for (const name of COUNTER_NAMES) {
      const delta = node.counters[name] - prev.counters[name];
      if (delta > 0 && target.incCounter(node.id, name, delta)) report.counters++;
    }
    const prevEvents = new Set(prev.strength.events.map((e) => e.id));
    for (const e of node.strength.events) if (!prevEvents.has(e.id) && e.t > cur.strength.base.t) target.addStrengthEvent(node.id, e);
  }
  if (!opts.additiveOnly) {
    for (const id of beforeNodes.keys()) {
      if (!afterNodes.has(id) && target.deleteNode(id)) report.nodesDeleted++;
    }
  }

  // ── edges
  const beforeEdges = new Map(before.allEdges().map((e) => [e.id, e]));
  const afterEdges = new Map(after.allEdges().map((e) => [e.id, e]));
  for (const e of afterEdges.values()) {
    if (same(beforeEdges.get(e.id), e)) continue;
    if (!target.hasNode(e.src)) continue;
    target.putEdge(e);
    report.edges++;
  }
  if (!opts.additiveOnly) for (const id of beforeEdges.keys()) if (!afterEdges.has(id) && target.deleteEdge(id)) report.edges++;

  // ── instruction sources and the turn counter
  const beforeSources = new Map(before.sources().map((s) => [s.file, s]));
  for (const s of after.sources()) {
    if (same(beforeSources.get(s.file), s)) continue;
    target.setSource(s.file, { sha: s.sha, mode: s.mode, ingestedAt: s.ingestedAt, importedBy: s.importedBy }, s.sections);
  }
  if (!opts.additiveOnly) {
    const afterSources = new Set(after.sources().map((s) => s.file));
    for (const file of beforeSources.keys()) if (!afterSources.has(file)) target.removeSource(file);
  }
  const turns = after.turns() - before.turns();
  if (turns > 0) target.incTurns(turns);
  return report;
}

export function describeRecovery(r: RecoveryReport): string {
  const parts = [`${r.nodesAdded} added`, `${r.nodesPatched} changed`, `${r.nodesDeleted} deleted`, `${r.edges} edges`, `${r.counters} counters`, `${r.paths} paths`];
  if (r.skipped) parts.push(`${r.skipped} skipped`);
  return `${r.source ? `${r.source}: ` : ""}${parts.join(", ")}`;
}

export type { MemoryNode };
