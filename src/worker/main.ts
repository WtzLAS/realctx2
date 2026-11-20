/**
 * The model-free worker (§6.6.8): a detached Node process started at session end, by
 * `/realctx2 maintain`, or by the optional git hooks (§7.11). It makes no model calls: aux
 * sessions and the decision model belong to the harness's own model access. The embedding
 * endpoints are the user's own, so embedding backlogs are fair game.
 *
 *   realctx2-worker --cwd <dir> [--project <key>] [--trusted] [--hook <name>]
 */
import { existsSync } from "node:fs";
import { relative } from "node:path";
import { Layout, loadConfig } from "../core/config.ts";
import { resolveProject } from "../core/project.ts";
import { Telemetry } from "../core/telemetry.ts";
import type { DecisionClient } from "../core/types.ts";
import { MemoryRuntime } from "../memory/runtime.ts";
import { createEmbeddingClients } from "../providers/embedding.ts";
import { errMsg } from "../util/errors.ts";
import { tryLock } from "../util/fs.ts";

export interface WorkerOptions {
  cwd: string;
  project?: string;
  trusted?: boolean;
  hook?: string;
  layout?: Layout;
  /** Embedding work is skipped when false (tests, hooks). */
  embed?: boolean;
}

export interface WorkerReport {
  ran: boolean;
  reason?: string;
  flushed?: number;
  compacted?: string[];
  reconciled?: { moved: number; deleted: number };
  hygiene?: Array<{ scope: string; dormant: number; archived: number; folded: number }>;
  droppedSessions?: string[];
  embedded?: number;
  staged?: boolean;
}

const NO_DECISIONS: DecisionClient = { decide: async () => ({}), available: () => false, calibrated: () => false };

export function parseWorkerArgs(argv: string[]): WorkerOptions {
  const o: WorkerOptions = { cwd: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cwd" && argv[i + 1]) o.cwd = argv[++i]!;
    else if (a === "--project" && argv[i + 1]) o.project = argv[++i]!;
    else if (a === "--hook" && argv[i + 1]) o.hook = argv[++i]!;
    else if (a === "--trusted") o.trusted = true;
  }
  return o;
}

export async function runWorker(o: WorkerOptions): Promise<WorkerReport> {
  const layout = o.layout ?? new Layout();
  const project = resolveProject(o.cwd);
  if (o.project && project.projectKey !== o.project) return { ran: false, reason: "the directory is not the project the worker was started for" };
  // hooks run inside the user's own repository, which they trust by running git there
  const trusted = o.trusted === true || !!o.hook;
  const cfg = loadConfig(layout, project.sharedDir, trusted).config;
  // one worker per project: a second one exits (§11)
  const lock = tryLock(layout.lockFile(`worker-${project.projectKey ?? "global"}`), 15 * 60_000);
  if (!lock) return { ran: false, reason: "another worker is running for this project" };
  const telemetry = new Telemetry(layout, cfg.privacy.telemetryContent);
  const emb = o.embed === false || o.hook ? { late: null, dense: null } : createEmbeddingClients(cfg.providers.embedding, { telemetry });
  let mem: MemoryRuntime | null = null;
  const report: WorkerReport = { ran: true };
  try {
    mem = new MemoryRuntime({ layout, cfg, cwd: o.cwd, trusted, decision: NO_DECISIONS, aux: null, late: emb.late, dense: emb.dense, telemetry, harness: "worker", project });
    if (o.hook === "pre-commit") {
      // pending shared changes land in the same commit as the code (§7.11)
      if (!mem.graph.has("shared")) return { ran: true, flushed: 0 };
      const res = mem.graph.flush({ force: true, scopes: ["shared"] });
      report.flushed = res.filter((r) => r.kind === "update" || r.kind === "snapshot").length;
      if (project.git && project.root && project.sharedDir && existsSync(project.sharedDir)) {
        const rel = relative(project.root, project.sharedDir) || ".";
        report.staged = project.git.git(["add", "--", rel]).code === 0;
      }
      return report;
    }
    if (o.hook) {
      // post-merge, post-checkout, post-rewrite: refresh the derived index, check the compaction trigger
      mem.graph.refresh();
      mem.graph.syncIndexes();
      report.compacted = [];
      for (const scope of mem.graph.visible()) {
        try {
          if (mem.graph.handle(scope).store.maybeCompact()?.kind === "snapshot") {
            report.compacted.push(scope);
            mem.graph.syncIndex(scope);
          }
        } catch (e) {
          telemetry.event("compact.failed", { scope, error: errMsg(e) });
        }
      }
      return report;
    }
    const res = mem.maintainModelFree();
    report.flushed = res.flushed;
    report.compacted = res.compacted;
    report.reconciled = res.reconcile ? { moved: res.reconcile.moved.length, deleted: res.reconcile.deleted.length } : undefined;
    report.hygiene = res.hygiene.map((h) => ({ scope: h.scope, dormant: h.dormant.length, archived: h.archived.length, folded: h.folded }));
    report.droppedSessions = mem.dropGoneSessions(existsSync);
    if (emb.late || emb.dense) {
      try {
        report.embedded = (await mem.warm(AbortSignal.timeout(5 * 60_000))).embedded;
      } catch (e) {
        telemetry.event("worker.embed_failed", { error: errMsg(e) });
      }
    }
    telemetry.rotate(30);
    telemetry.event("worker.done", { project: project.projectKey, ...report, hygiene: undefined });
    return report;
  } catch (e) {
    telemetry.event("worker.failed", { error: errMsg(e) });
    return { ran: false, reason: errMsg(e) };
  } finally {
    try {
      mem?.shutdown();
    } catch {
      // closing must not throw
    }
    lock.release();
  }
}

/** Entry point of `bin/realctx2-worker.js`. Never prints unless asked: it runs detached. */
export async function main(argv: string[]): Promise<number> {
  const report = await runWorker(parseWorkerArgs(argv));
  if (argv.includes("--print")) process.stdout.write(`${JSON.stringify(report)}\n`);
  return report.ran ? 0 : 1;
}
