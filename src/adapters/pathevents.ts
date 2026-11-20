/**
 * Paths and commands taken from tool calls (§4.2, §4.6.2): what the pre-edit gate, path-memory
 * delivery and move tracking look at. Shared by the pi and Claude Code adapters.
 */
import type { PathEvent } from "../memory/delivery.ts";
import { analyzeCommand } from "../util/shell.ts";

export type ToolFamily = "read" | "edit" | "bash" | "list";

/** Built-in tool names of both harnesses, by what they do to paths. */
const FAMILIES: Record<string, ToolFamily> = {
  // pi
  read: "read",
  edit: "edit",
  write: "edit",
  bash: "bash",
  grep: "list",
  find: "list",
  ls: "list",
  // Claude Code
  Read: "read",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
  Bash: "bash",
  Grep: "list",
  Glob: "list",
  LS: "list",
};

function toolFamily(name: string): ToolFamily | undefined {
  return FAMILIES[name];
}

function firstString(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = input[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

export interface PathResolver {
  cwd: string;
  /** Repo-relative path, or null outside the project. */
  rel(pathLike: string, cwd?: string): string | null;
  /** Optional existence check for inferred paths (tool-result details). */
  exists?(rel: string): boolean;
}

const SNAPSHOT_ID = /^v\d+\|(.+)\|\d+\|[\d.]+\|[\d.]+\|\d+$/;
const RESULT_EDIT_TOOLS = new Set(["edit", "write", "replace", "replace_match", "insert", "copy", "move", "undo_last_change", "patch", "apply_patch", "Edit", "MultiEdit", "Write", "NotebookEdit"]);
const GLOB_CHARS = /[*?{}]/;

/**
 * File names in the headers of a unified patch. Hunks are skipped by their line counts,
 * so a removed `-- x` line followed by an added `++ x` line is never taken for a header.
 */
export function patchFiles(patch: string): string[] {
  const out: string[] = [];
  const lines = patch.split("\n");
  const name = (s: string) => s.replace(/\t.*$/, "").replace(/^[ab]\/(?=.)/, "");
  for (let i = 0; i < lines.length && out.length < 32; i++) {
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(lines[i]!);
    if (hunk) {
      let old = hunk[1] === undefined ? 1 : Number(hunk[1]);
      let neu = hunk[2] === undefined ? 1 : Number(hunk[2]);
      while ((old > 0 || neu > 0) && i + 1 < lines.length) {
        const l = lines[++i]!;
        if (l.startsWith("\\")) continue;
        if (l.startsWith("-")) old--;
        else if (l.startsWith("+")) neu--;
        else {
          old--;
          neu--;
        }
      }
      continue;
    }
    const a = /^--- (.+)$/.exec(lines[i]!);
    const b = a && i + 1 < lines.length ? /^\+\+\+ (.+)$/.exec(lines[i + 1]!) : null;
    if (!a || !b) continue;
    for (const f of [name(a[1]!), name(b[1]!)]) if (f !== "/dev/null" && !out.includes(f)) out.push(f);
    i++;
  }
  return out;
}

/**
 * Fallback path event from tool-result `details`, for tools whose call arguments name no path
 * (e.g. anchor-addressed edits such as pi-hashline-edit-pro's `replace`, `insert`, `move`,
 * `undo_last_change`). Reads `details.path`/`file`/`filePath`/`file_path`/`paths`, a
 * `v2|<path>|ino|mtime|ctime|size` `snapshotId`, and unified `patch` headers.
 */
export function resultPathEventOf(toolName: string, details: unknown, r: PathResolver): PathEvent | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const d = details as Record<string, unknown>;
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: unknown) => {
    if (out.length >= 32 || typeof raw !== "string") return;
    const p = raw.trim();
    if (!p || p === "." || p === ".." || p.includes("\n") || GLOB_CHARS.test(p)) return;
    const rel = r.rel(p, r.cwd);
    if (rel === null || !rel || seen.has(rel)) return;
    if (r.exists && !r.exists(rel)) return;
    seen.add(rel);
    out.push(rel);
  };
  for (const k of ["path", "file", "filePath", "file_path"]) add(d[k]);
  if (Array.isArray(d.paths)) for (const p of d.paths.slice(0, 32)) add(p);
  if (typeof d.snapshotId === "string") add(SNAPSHOT_ID.exec(d.snapshotId)?.[1]);
  if (typeof d.patch === "string" && d.patch.length <= 4 * 1024 * 1024) for (const p of patchFiles(d.patch)) add(p);
  if (!out.length) return undefined;
  const isEdit = RESULT_EDIT_TOOLS.has(toolName) || typeof d.patch === "string" || typeof d.snapshotId === "string";
  return { action: isEdit ? "edit" : "read", paths: out };
}

/** The path event of a tool call, or undefined for tools that touch no paths. */
export function pathEventOf(toolName: string, input: Record<string, unknown> | undefined, r: PathResolver): PathEvent | undefined {
  const family = toolFamily(toolName);
  if (!family || !input) return undefined;
  if (family === "bash") {
    const command = firstString(input, ["command"]);
    if (!command) return undefined;
    const effects = analyzeCommand(command, { cwd: r.cwd });
    const paths = [...effects.touched, ...effects.cds].map((p) => r.rel(p)).filter((p): p is string => p !== null);
    return { action: "command", paths: [...new Set(paths)], command, effects };
  }
  const raw = firstString(input, ["path", "file_path", "notebook_path"]);
  if (family === "list") {
    const rel = r.rel(raw ?? ".", r.cwd);
    return rel === null ? undefined : { action: "list", paths: [rel] };
  }
  if (!raw) return undefined;
  const rel = r.rel(raw, r.cwd);
  if (rel === null) return undefined;
  return { action: family === "read" ? "read" : "edit", paths: [rel] };
}
