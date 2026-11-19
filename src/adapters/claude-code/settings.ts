/**
 * Claude Code settings realctx2 manages (§4.6.5): auto memory off for the user (with a backup
 * that `/realctx2 uninstall` restores), and `claudeMdExcludes` for ingested instruction files.
 */
import { join } from "node:path";
import { claudeDir, type Layout } from "../../core/config.ts";
import { ensureDir, existsSync, readJson, writeJson } from "../../util/fs.ts";

interface Backup {
  at: string;
  /** The previous value; `null` means the key was absent. */
  autoMemoryEnabled: boolean | null;
  /** `claudeMdExcludes` entries realctx2 added, per settings file. */
  excludes: Record<string, string[]>;
}

function backupFile(layout: Layout): string {
  return join(layout.claudeCodeDir, "settings-backup.json");
}

function readBackup(layout: Layout): Backup | null {
  return readJson<Backup | null>(backupFile(layout), null);
}

function userSettingsFile(): string {
  return join(claudeDir(), "settings.json");
}

export function autoMemoryState(): { enabled: boolean; file: string } {
  const file = userSettingsFile();
  const s = readJson<Record<string, unknown>>(file, {});
  return { enabled: s.autoMemoryEnabled !== false && process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY !== "1", file };
}

/**
 * First session after install: set `autoMemoryEnabled: false` in the user's settings and keep
 * the previous value. Returns true when this call changed the setting.
 */
export function disableAutoMemory(layout: Layout, now: Date): boolean {
  const file = userSettingsFile();
  const settings = readJson<Record<string, unknown>>(file, {});
  const backup = readBackup(layout);
  if (backup) return false; // done before: a user who turned it back on is only warned by `doctor`
  const prev = typeof settings.autoMemoryEnabled === "boolean" ? settings.autoMemoryEnabled : null;
  ensureDir(layout.claudeCodeDir);
  writeJson(backupFile(layout), { at: now.toISOString(), autoMemoryEnabled: prev, excludes: {} } satisfies Backup);
  if (prev === false) return false;
  ensureDir(claudeDir());
  writeJson(file, { ...settings, autoMemoryEnabled: false });
  return true;
}

/** Add instruction-file patterns to `claudeMdExcludes` in `<repo>/.claude/settings.local.json`. */
export function syncClaudeMdExcludes(layout: Layout, repoRoot: string, patterns: string[]): string[] {
  if (!patterns.length) return [];
  const file = join(repoRoot, ".claude", "settings.local.json");
  const settings = readJson<Record<string, unknown>>(file, {});
  const cur = Array.isArray(settings.claudeMdExcludes) ? settings.claudeMdExcludes.filter((x): x is string => typeof x === "string") : [];
  const add = patterns.filter((p) => !cur.includes(p));
  if (!add.length) return [];
  ensureDir(join(repoRoot, ".claude"));
  writeJson(file, { ...settings, claudeMdExcludes: [...cur, ...add] });
  const backup = readBackup(layout) ?? { at: new Date().toISOString(), autoMemoryEnabled: null, excludes: {} };
  backup.excludes[file] = [...new Set([...(backup.excludes[file] ?? []), ...add])];
  ensureDir(layout.claudeCodeDir);
  writeJson(backupFile(layout), backup);
  return add;
}

/** `/realctx2 uninstall`: put back what realctx2 changed. Memory stores are left in place. */
export function restoreClaudeSettings(layout: Layout): { restored: string[]; nothing: boolean } {
  const backup = readBackup(layout);
  if (!backup) return { restored: [], nothing: true };
  const restored: string[] = [];
  const file = userSettingsFile();
  if (existsSync(file)) {
    const settings = readJson<Record<string, unknown>>(file, {});
    if (settings.autoMemoryEnabled === false && backup.autoMemoryEnabled !== false) {
      if (backup.autoMemoryEnabled === null) delete settings.autoMemoryEnabled;
      else settings.autoMemoryEnabled = backup.autoMemoryEnabled;
      writeJson(file, settings);
      restored.push(`${file}: autoMemoryEnabled restored to ${backup.autoMemoryEnabled === null ? "its default (on)" : String(backup.autoMemoryEnabled)}`);
    }
  }
  for (const [f, added] of Object.entries(backup.excludes ?? {})) {
    if (!existsSync(f)) continue;
    const settings = readJson<Record<string, unknown>>(f, {});
    const cur = Array.isArray(settings.claudeMdExcludes) ? settings.claudeMdExcludes.filter((x): x is string => typeof x === "string") : [];
    const next = cur.filter((p) => !added.includes(p));
    if (next.length === cur.length) continue;
    if (next.length) settings.claudeMdExcludes = next;
    else delete settings.claudeMdExcludes;
    writeJson(f, settings);
    restored.push(`${f}: removed ${cur.length - next.length} claudeMdExcludes pattern(s)`);
  }
  writeJson(backupFile(layout), { ...backup, restoredAt: new Date().toISOString(), excludes: {} });
  return { restored, nothing: false };
}
