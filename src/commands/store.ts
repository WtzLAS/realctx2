/** `/realctx2 share | maintain | compact | git | uninstall` (§10, §7.11). */
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { restoreClaudeSettings } from "../adapters/claude-code/settings.ts";
import type { Host } from "../core/host.ts";
import type { CommandIO, ScopeName } from "../core/types.ts";
import { ensureDir, existsSync } from "../util/fs.ts";
import { type Parsed, num } from "./args.ts";
import { uncommittedShared } from "./status.ts";

const SCOPES: ScopeName[] = ["global", "personal", "shared"];

function scopesArg(host: Host, p: Parsed): ScopeName[] | null {
  const mem = host.memory!;
  const arg = p.positional[0];
  if (!arg) return mem.graph.visible();
  if (!SCOPES.includes(arg as ScopeName)) return null;
  return mem.graph.has(arg as ScopeName) ? [arg as ScopeName] : [];
}

export async function share(host: Host, io: CommandIO, p: Parsed): Promise<void> {
  const mem = host.memory;
  if (!mem) return io.print("Memory is unavailable.");
  if (!mem.graph.has("shared")) return io.print(host.trusted ? "This project has no shared store yet. It is created by the first shared memory (remember with scope shared, or /realctx2 ingest)." : "The shared store is not loaded because the project is not trusted.");
  mem.accounting.flush(mem.graph, host.cfg);
  // `force` also writes buffered counter-only deltas (§7.5)
  const res = mem.graph.flush({ force: true, scopes: ["shared"], keepPurges: true });
  const wrote = res.filter((r) => r.kind === "update" || r.kind === "snapshot");
  const lines = [wrote.length ? `Flushed shared changes: ${wrote.map((r) => `${r.kind} (${num(r.bytes)} bytes)`).join(", ")}.` : "No pending shared changes to flush."];
  const pending = uncommittedShared(host);
  const git = host.project.git;
  const dir = host.project.sharedDir!;
  if (p.flags.has("commit")) {
    if (!git || !host.project.root) lines.push("Not a git repository: nothing to commit.");
    else if (!pending.length) lines.push("Nothing to commit in the shared store.");
    else {
      const rel = relative(host.project.root, dir) || ".";
      const add = git.git(["add", "--", rel]);
      // `--only` commits the shared store and nothing else that happens to be staged
      const commit = add.code === 0 ? git.git(["commit", "--only", "-m", "realctx2: update shared memory", "--", rel], 30_000) : add;
      lines.push(commit.code === 0 ? `Committed ${pending.length} file change(s) under ${rel}.` : `git commit failed: ${(commit.stderr || commit.stdout).trim().split("\n").slice(-2).join(" ")}`);
    }
  } else if (pending.length) lines.push(`${pending.length} shared file change(s) are not committed yet. Commit them with your code, or run /realctx2 share --commit.`);
  io.print(lines.join("\n"));
}

export async function maintain(host: Host, io: CommandIO, p: Parsed): Promise<void> {
  const mem = host.memory;
  if (!mem) return io.print("Memory is unavailable.");
  const scopes = scopesArg(host, p);
  if (!scopes) return io.print("Usage: /realctx2 maintain [global|personal|shared]");
  io.notify("Running maintenance…", "info");
  const lines: string[] = [];
  // model-free part: what the detached worker does at session end
  const free = mem.maintainModelFree({ inSession: true });
  if (free.reconcile) lines.push(`Paths: ${free.reconcile.checked} checked, ${free.reconcile.moved.length} moved, ${free.reconcile.deleted.length} deleted.`);
  for (const h of free.hygiene) lines.push(`${h.scope}: folded ${h.folded} strength log(s), promoted ${h.promoted.length}, demoted ${h.demoted.length}${h.forgettingRan ? `, forgetting pass: ${h.dormant.length} dormant, ${h.archived.length} archived (threshold ${h.threshold.toFixed(2)})` : ""}${h.lowValue.length ? `, ${h.lowValue.length} low-value` : ""}.`);
  if (free.compacted.length) lines.push(`Compacted: ${free.compacted.join(", ")}.`);
  // model-dependent part: harvest, re-verification, fusion and strategy attempts
  const res = await host.maintain({ force: true, scopes });
  if (res.harvested) lines.push(`Harvested ${res.harvested} knowledge item(s) from consolidated work.`);
  const idle = res.idle;
  if (idle) {
    if (idle.embedded) lines.push(`Embedded ${idle.embedded} item(s).`);
    if (idle.reverify && idle.reverify.files) lines.push(`Re-verified ${idle.reverify.files} file(s): ${idle.reverify.changed.length} updated, ${idle.reverify.obsolete.length} retired.`);
    if (idle.resliced) lines.push(`Re-sliced ${idle.resliced} changed imported file(s).`);
    for (const pass of idle.passes) {
      const committed = pass.attempts.filter((a) => a.committed).length;
      lines.push(`${pass.scope}: fused ${pass.fusion.fused.length} of ${pass.fusion.clusters} cluster(s), ${pass.attempts.length} strategy attempt(s), ${committed} committed${pass.stopped ? ` (stopped: ${pass.stopped})` : ""}.`);
    }
    if (!idle.passes.length) lines.push("No strategy pass ran (scopes are locked by another process, read-only, or the aux model is unavailable).");
  }
  mem.graph.flush({ scopes, keepPurges: true });
  io.print(lines.join("\n") || "Nothing to do.");
}

export async function compact(host: Host, io: CommandIO, p: Parsed): Promise<void> {
  const mem = host.memory;
  if (!mem) return io.print("Memory is unavailable.");
  const scopes = scopesArg(host, p);
  if (!scopes) return io.print("Usage: /realctx2 compact [global|personal|shared]");
  const lines: string[] = [];
  for (const scope of scopes) {
    const store = mem.graph.handle(scope).store;
    const before = store.stats();
    if (store.pendingPurge.size) {
      lines.push(`${scope}: a purge is pending; the store is compacted when this session ends.`);
      continue;
    }
    try {
      store.flush({ force: true });
      const r = store.compact({ reason: "manual" });
      const after = store.stats();
      if (r?.kind === "snapshot") {
        mem.graph.syncIndex(scope);
        lines.push(`${scope}: ${before.updates} update file(s) and ${before.snapshots} snapshot(s) → ${after.updates} and ${after.snapshots} (${num(before.updateBytes + before.snapshotBytes)} → ${num(after.updateBytes + after.snapshotBytes)} bytes).`);
      } else lines.push(`${scope}: nothing to compact${store.readOnly ? " (read-only)" : ""}.`);
    } catch (e) {
      lines.push(`${scope}: compaction failed: ${String((e as Error).message ?? e)}`);
    }
  }
  io.print(lines.join("\n") || "No stores.");
}

const HOOK_BEGIN = "# >>> realctx2 >>>";
const HOOK_END = "# <<< realctx2 <<<";

export function hookBlock(name: string, workerBin: string, execPath: string): string {
  const call = `"${execPath}" "${workerBin}" --hook ${name} --cwd "$(git rev-parse --show-toplevel)" >/dev/null 2>&1 || true`;
  return [HOOK_BEGIN, "# Optional: none of these hooks is needed for correctness (realctx2 design §7.11).", `if [ -z "$REALCTX2_CHILD" ] && [ -f "${workerBin}" ]; then`, `  REALCTX2_CHILD=1 ${call}`, "fi", HOOK_END].join("\n");
}

export async function git(host: Host, io: CommandIO, p: Parsed): Promise<void> {
  const sub = p.positional[0];
  const g = host.project.git;
  if (!g || !host.project.root || !host.project.inGit) return io.print("This is not a git repository.");
  if (sub === "install-hooks") {
    const custom = g.git(["config", "--get", "core.hooksPath"]);
    const gitDir = g.git(["rev-parse", "--git-common-dir"]).stdout.trim() || ".git";
    const base = custom.code === 0 && custom.stdout.trim() ? custom.stdout.trim() : join(gitDir, "hooks");
    const dir = isAbsolute(base) ? base : join(host.project.root, base);
    const worker = fileURLToPath(new URL("../../bin/realctx2-worker.js", import.meta.url));
    ensureDir(dir);
    const done: string[] = [];
    for (const name of ["pre-commit", "post-merge", "post-checkout", "post-rewrite"]) {
      const file = join(dir, name);
      const block = hookBlock(name, worker, process.execPath);
      let text = existsSync(file) ? readFileSync(file, "utf8") : "#!/bin/sh\n";
      const from = text.indexOf(HOOK_BEGIN);
      const to = text.indexOf(HOOK_END);
      // chains with whatever is already there: only realctx2's own block is replaced
      if (from >= 0 && to > from) text = `${text.slice(0, from)}${block}${text.slice(to + HOOK_END.length)}`;
      else text = `${text.replace(/\n*$/, "\n")}\n${block}\n`;
      writeFileSync(file, text);
      chmodSync(file, 0o755);
      done.push(name);
    }
    return io.print(`Installed hooks in ${dir}: ${done.join(", ")}.\npre-commit flushes pending shared memory into the commit; the others refresh the index after merges and checkouts. Existing hook content was kept.`);
  }
  if (sub === "lfs") {
    const mem = host.memory;
    if (!mem?.graph.has("shared")) return io.print("This project has no loaded shared store.");
    if (!g.lfsAvailable()) return io.print("git-lfs is not installed. Install it first (https://git-lfs.com), then run this again.");
    const store = mem.graph.handle("shared").store;
    if (store.usesLfs()) return io.print("The shared store already uses Git LFS.");
    if (!store.switchToLfs()) return io.print("The shared store is read-only here.");
    return io.print("Future shared .loro files go to Git LFS (.gitattributes updated; history is not rewritten). Commit .pi/realctx2/.gitattributes. Your hosting provider's LFS quotas apply.");
  }
  io.print("Usage: /realctx2 git install-hooks | /realctx2 git lfs");
}

export async function uninstall(host: Host, io: CommandIO): Promise<void> {
  const res = restoreClaudeSettings(host.layout);
  if (res.nothing) return io.print("realctx2 changed no Claude Code settings on this machine. Memory stores are left in place.");
  io.print([res.restored.length ? `Restored Claude Code settings:\n${res.restored.map((r) => `  ${r}`).join("\n")}` : "Claude Code settings already match what they were before realctx2.", `Memory stores are left in place (${host.layout.home}). Remove the plugin with /plugin, and the pi package from settings.json.`].join("\n"));
}
