import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runSync(cmd: string, args: string[], cwd: string, timeoutMs = 10_000, input?: string): ExecResult {
  try {
    const stdout = execFileSync(cmd, args, {
      cwd,
      timeout: timeoutMs,
      encoding: "utf8",
      input,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string; message?: string };
    return { code: err.status ?? 1, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? err.message ?? "") };
  }
}

export function run(cmd: string, args: string[], cwd: string, timeoutMs = 10_000): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, timeout: timeoutMs, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" } },
      (error, stdout, stderr) => {
        const raw: unknown = error ? (error as { code?: unknown }).code : 0;
        resolve({ code: typeof raw === "number" ? raw : error ? 1 : 0, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** Thin synchronous git helper. Every method degrades to "not a repo" answers outside git. */
export class Git {
  readonly cwd: string;
  private rootCache: string | null | undefined;
  constructor(cwd: string) {
    this.cwd = cwd;
  }

  git(args: string[], timeoutMs = 10_000): ExecResult {
    return runSync("git", args, this.root() ?? this.cwd, timeoutMs);
  }

  root(): string | null {
    if (this.rootCache !== undefined) return this.rootCache;
    const r = runSync("git", ["rev-parse", "--show-toplevel"], this.cwd, 5000);
    this.rootCache = r.code === 0 ? r.stdout.trim() : null;
    return this.rootCache;
  }

  isRepo(): boolean {
    return this.root() !== null;
  }

  /** Sorted root commit hashes: stable across clones, forks and worktrees (§6.1). */
  rootCommits(): string[] {
    const r = this.git(["rev-list", "--max-parents=0", "HEAD"]);
    if (r.code !== 0) return [];
    return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean).sort();
  }

  head(): string | null {
    const r = this.git(["rev-parse", "HEAD"]);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  branch(): string | null {
    const r = this.git(["rev-parse", "--abbrev-ref", "HEAD"]);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  defaultBranch(configured?: string | null): string | null {
    if (configured) return configured;
    const r = this.git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
    for (const name of ["main", "master"]) {
      if (this.git(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]).code === 0) return name;
    }
    return null;
  }

  mergeBase(a: string, b: string): string | null {
    const r = this.git(["merge-base", a, b]);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  /** `git show <rev>:<path>` as bytes, or null. */
  showBytes(rev: string, path: string): Buffer | null {
    try {
      return execFileSync("git", ["show", `${rev}:${path}`], { cwd: this.root() ?? this.cwd, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return null;
    }
  }

  show(rev: string, path: string): string | null {
    const b = this.showBytes(rev, path);
    return b ? b.toString("utf8") : null;
  }

  lsTree(rev: string, dir: string): string[] {
    const r = this.git(["ls-tree", "--name-only", rev, dir.endsWith("/") ? dir : dir + "/"]);
    if (r.code !== 0) return [];
    return r.stdout.split("\n").filter(Boolean);
  }

  existsAt(rev: string, path: string): boolean {
    return this.git(["cat-file", "-e", `${rev}:${path}`]).code === 0;
  }

  isTracked(path: string): boolean {
    return this.git(["ls-files", "--error-unmatch", "--", path]).code === 0;
  }

  isIgnored(path: string): boolean {
    return this.git(["check-ignore", "-q", "--", path]).code === 0;
  }

  /** Renames between a commit and HEAD: `git diff -M --name-status <from> HEAD`. */
  renamesSince(from: string): Array<{ from: string; to: string }> {
    const r = this.git(["diff", "-M", "--name-status", "--diff-filter=R", from, "HEAD"]);
    if (r.code !== 0) return [];
    return parseRenames(r.stdout);
  }

  /** Uncommitted renames and untracked files from `git status --porcelain=v2 -M`. */
  statusV2(): { renames: Array<{ from: string; to: string }>; untracked: string[]; deleted: string[]; modified: string[]; raw: string } {
    const r = this.git(["status", "--porcelain=v2", "-M", "--untracked-files=all"]);
    const out = { renames: [] as Array<{ from: string; to: string }>, untracked: [] as string[], deleted: [] as string[], modified: [] as string[], raw: r.stdout };
    if (r.code !== 0) return out;
    for (const line of r.stdout.split("\n")) {
      if (line.startsWith("2 ")) {
        // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\t<origPath>
        const tab = line.indexOf("\t");
        const head = line.slice(0, tab).split(" ");
        out.renames.push({ from: line.slice(tab + 1), to: head.slice(9).join(" ") });
      } else if (line.startsWith("1 ")) {
        const f = line.split(" ");
        const xy = f[1]!;
        const path = f.slice(8).join(" ");
        if (xy.includes("D")) out.deleted.push(path);
        else out.modified.push(path);
      } else if (line.startsWith("? ")) out.untracked.push(line.slice(2));
    }
    return out;
  }

  hasUncommitted(pathspec: string): boolean {
    const r = this.git(["status", "--porcelain", "--", pathspec]);
    return r.code === 0 && r.stdout.trim().length > 0;
  }

  /** Whether the working-tree copy of a file differs from HEAD (exit code 1 with no stderr; errors return false). */
  differsFromHead(path: string): boolean {
    if (!this.isRepo()) return false;
    const r = this.git(["diff", "--quiet", "HEAD", "--", path]);
    return r.code === 1 && r.stderr.trim() === "";
  }

  diffSince(blobOrRev: string, path: string): string | null {
    const r = this.git(["diff", "--no-color", blobOrRev, "HEAD", "--", path]);
    return r.code === 0 ? r.stdout : null;
  }

  lfsAvailable(): boolean {
    return runSync("git", ["lfs", "version"], this.cwd, 5000).code === 0;
  }

  /** History of deletions of a path: commits where it was deleted, newest first. */
  deletionCommits(path: string): string[] {
    const r = this.git(["log", "--diff-filter=D", "--format=%H", "--", path]);
    if (r.code !== 0) return [];
    return r.stdout.split("\n").filter(Boolean);
  }
}

function parseRenames(stdout: string): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  for (const line of stdout.split("\n")) {
    const f = line.split("\t");
    if (f.length >= 3 && f[0]!.startsWith("R")) out.push({ from: f[1]!, to: f[2]! });
  }
  return out;
}

/** Git blob hash of content (matches `git hash-object`). */
export function blobHash(content: Uint8Array | string): string {
  const buf = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
  return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

export function fileBlobHash(absPath: string): string | null {
  try {
    return blobHash(readFileSync(absPath));
  } catch {
    return null;
  }
}

/** Content fingerprint for move detection without git: a set of hashed line shingles. */
export function fingerprint(content: string, max = 64): string {
  const lines = content.split("\n").map((l) => l.trim()).filter((l) => l.length > 3);
  const hashes = new Set<number>();
  for (const l of lines) {
    let h = 2166136261;
    for (let i = 0; i < l.length; i++) h = Math.imul(h ^ l.charCodeAt(i), 16777619);
    hashes.add(h >>> 0);
  }
  return [...hashes].sort((a, b) => a - b).slice(0, max).map((h) => h.toString(36)).join(".");
}

export function fingerprintSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const sa = new Set(a.split("."));
  const sb = new Set(b.split("."));
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / Math.max(1, Math.min(sa.size, sb.size));
}
