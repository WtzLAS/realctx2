/** The `/realctx2` command (§10): one command with subcommands. Claude Code exposes them as skills. */
import type { Host } from "../core/host.ts";
import { findCategory, SETTINGS_CATEGORIES } from "../core/settings-schema.ts";
import type { CommandDef, CommandIO } from "../core/types.ts";
import { parseArgs } from "./args.ts";
import * as memory from "./memory.ts";
import * as status from "./status.ts";
import * as store from "./store.ts";

async function openSettingsCmd(host: Host, io: CommandIO, rest: string): Promise<void> {
  const arg = parseArgs(rest).positional[0];
  if (arg && !findCategory(arg)) {
    const names = SETTINGS_CATEGORIES.map((c) => c.id).join(", ");
    io.print(`Unknown settings category "${arg}". Available categories: ${names}`);
    return;
  }
  if (io.openSettings) {
    await io.openSettings(arg);
    return;
  }
  const lines = [
    `realctx2 settings (interactive settings screen requires pi's TUI)`,
    `Config file: ${host.layout.configFile}`,
    "",
    ...SETTINGS_CATEGORIES.map((c) => `  ${c.title} (${c.id}): ${c.summary(host.cfg, { health: host.health() })}`),
  ];
  io.print(lines.join("\n"));
}

interface Sub {
  usage: string;
  help: string;
  /** Flags that take a value. */
  valued?: string[];
  run(host: Host, io: CommandIO, rest: string): Promise<void> | void;
}

export const SUBCOMMANDS: Record<string, Sub> = {
  status: { usage: "status", help: "Window, occupancy, open intents, consolidations, providers, spend, uncommitted shared files", run: (h, io) => status.status(h, io) },
  settings: { usage: "settings [category]", help: "Open the interactive settings screen (endpoints, context, memory, index & storage, tools)", run: (h, io, r) => openSettingsCmd(h, io, r) },
  stack: { usage: "stack", help: "The intent stack, with regions and their token sizes", run: (h, io) => status.stack(h, io) },
  tree: { usage: "tree [<t: id>]", help: "The message tree under a consolidation, or the whole session's", run: (h, io, r) => status.tree(h, io, parseArgs(r).positional[0]) },
  search: { usage: "search <query> [--history] [--project]", help: "Search memories and turns, with scores, layers, scopes and urgency", run: (h, io, r) => memory.search(h, io, parseArgs(r)) },
  inspect: { usage: "inspect <id>", help: "Details of any ID", run: (h, io, r) => memory.inspect(h, io, parseArgs(r)) },
  review: { usage: "review [--low-value | --harm | --conflicts | --escalations | --stale-rules | --actor <id>] | review approve|dismiss <id>", help: "Review queue: approve, pin, edit or forget", valued: ["actor"], run: (h, io, r) => memory.review(h, io, parseArgs(r, ["actor"])) },
  remember: { usage: "remember <text> [--scope …] [--kind …] [--severity …] [--urgency …] [--path …] [--command …]", help: "Add an explicit, pinned memory", valued: ["scope", "kind", "severity", "urgency", "path", "command"], run: (h, io, r) => memory.rememberCmd(h, io, parseArgs(r, ["scope", "kind", "severity", "urgency", "path", "command"])) },
  forget: { usage: "forget <id | query> [--purge] [--reason <text>]", help: "Retire a memory, or purge it with --purge. Acts at once.", valued: ["reason"], run: (h, io, r) => memory.forgetCmd(h, io, parseArgs(r, ["reason"])) },
  urgency: { usage: "urgency <id> <immediate | hint | caption | passive>", help: "Set a memory's urgency; the user's choice is final", run: (h, io, r) => memory.urgency(h, io, parseArgs(r)) },
  pin: { usage: "pin <target>", help: "Protect a memory from automatic forgetting", run: (h, io, r) => memory.pin(h, io, parseArgs(r), true) },
  unpin: { usage: "unpin <target>", help: "Remove that protection", run: (h, io, r) => memory.pin(h, io, parseArgs(r), false) },
  share: { usage: "share [--commit]", help: "Flush pending shared changes now, and optionally commit .pi/realctx2/ only", run: (h, io, r) => store.share(h, io, parseArgs(r)) },
  maintain: { usage: "maintain [scope]", help: "Run a maintenance pass now", run: (h, io, r) => store.maintain(h, io, parseArgs(r)) },
  policy: { usage: "policy", help: "EvoDisco phase, recent U and E, agreement with the teacher, operator mix", run: (h, io) => status.policy(h, io) },
  doctor: { usage: "doctor", help: "Check providers, calibration, tool names, stores, instruction files, indexes and secrets", run: (h, io) => status.doctor(h, io) },
  export: { usage: "export [scope] <dir> | export agents [--dir <dir>]", help: "Write a readable markdown mirror, or regenerate AGENTS.md files from rules", valued: ["dir"], run: (h, io, r) => memory.exportCmd(h, io, parseArgs(r, ["dir"])) },
  ingest: { usage: "ingest [paths…] [--all] [--include local,rules,global] [--dry-run]", help: "Slice AGENTS.md / CLAUDE.md / rules files into path-anchored memories, then delete the files", valued: ["include"], run: (h, io, r) => memory.ingest(h, io, parseArgs(r, ["include"])) },
  rules: { usage: "rules [path] | rules edit <id>", help: "List the rules in force at a path; edit one rule", run: (h, io, r) => memory.rules(h, io, parseArgs(r)) },
  restore: { usage: "restore <id>", help: "Restore a retired memory, or a purged one until the session-end flush", run: (h, io, r) => memory.restore(h, io, parseArgs(r)) },
  paths: { usage: "paths [sync | show <path> | stale]", help: "Reconcile tracked paths; show a path's memories; list stale anchors", run: (h, io, r) => memory.paths(h, io, parseArgs(r)) },
  compact: { usage: "compact [scope]", help: "Compact a store now", run: (h, io, r) => store.compact(h, io, parseArgs(r)) },
  calibrate: { usage: "calibrate [model]", help: "Recalibrate similarity thresholds for an embedding model", run: (h, io, r) => memory.calibrate(h, io, parseArgs(r)) },
  reverify: { usage: "reverify [id | --all]", help: "Re-verify memories against the code now", run: (h, io, r) => memory.reverify(h, io, parseArgs(r)) },
  uninstall: { usage: "uninstall", help: "Restore the Claude Code settings realctx2 changed", run: (h, io) => store.uninstall(h, io) },
  git: { usage: "git install-hooks | git lfs | git fix-gitignore", help: "Install optional git hooks; move shared files to Git LFS; un-ignore .pi/realctx2/ in .gitignore", run: (h, io, r) => store.git(h, io, parseArgs(r)) },
};

export function helpText(prefix = "/realctx2 "): string {
  const rows = Object.values(SUBCOMMANDS).map((s) => `  ${prefix}${s.usage}\n      ${s.help}`);
  return `realctx2 commands:\n${rows.join("\n")}`;
}

/** Run one subcommand line (`status`, `forget m:… --purge`, …). Never throws. */
export async function runCommand(host: Host, line: string, io: CommandIO): Promise<void> {
  const trimmed = line.trim();
  const name = trimmed.split(/\s+/)[0] ?? "";
  const rest = trimmed.slice(name.length).trim();
  if (!name || name === "help" || name === "--help") return io.print(helpText());
  const sub = SUBCOMMANDS[name];
  if (!sub) {
    const near = Object.keys(SUBCOMMANDS).filter((k) => k.startsWith(name.slice(0, 2)));
    return io.print(`Unknown command "${name}".${near.length ? ` Did you mean: ${near.join(", ")}?` : ""}\n\n${helpText()}`);
  }
  if (host.isClosed) return io.print("realctx2 has shut down in this session.");
  try {
    await sub.run(host, io, rest);
  } catch (e) {
    host.telemetry.event("command.failed", { command: name, error: String((e as Error).message ?? e) });
    io.notify(`/realctx2 ${name} failed: ${String((e as Error).message ?? e)}`, "error");
  }
  host.updateStatus();
}

export function buildCommand(host: Host): CommandDef {
  return {
    name: "realctx2",
    description: "Context and memory manager: status, search, review, ingest, forget, doctor…",
    handler: (args, io) => runCommand(host, args, io),
    completions(prefix: string): string[] {
      const p = prefix.trimStart();
      if (!p.includes(" ")) return Object.keys(SUBCOMMANDS).filter((k) => k.startsWith(p));
      const m = /^settings\s+(\S*)$/.exec(p);
      if (m) return SETTINGS_CATEGORIES.map((c) => c.id).filter((id) => id.startsWith(m[1]!));
      return [];
    },
  };
}
