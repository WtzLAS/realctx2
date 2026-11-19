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

export function toolFamily(name: string): ToolFamily | undefined {
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
