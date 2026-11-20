/**
 * Detect when git ignores the shared store (`.pi/realctx2/`), so shared memories would
 * silently never be committed, and find a fix verified in a scratch copy of the repo's
 * ignore rules before suggesting or applying it.
 *
 * gitignore semantics are subtle (a file cannot be re-included when a parent directory is
 * excluded; nested .gitignore files beat the root one; info/exclude and global excludes
 * rank lowest), so every candidate fix is tested with `git check-ignore` in a scratch repo.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix } from "node:path";

/** Shared store directory relative to the project root, in POSIX form. */
const SHARED_REL = ".pi/realctx2";
/** Representative paths inside the shared store (both metadata and CRDT update files). */
const PROBES = [`${SHARED_REL}/store.json`, `${SHARED_REL}/updates/probe.loro`];

export interface IgnoreFix {
  /** File to edit, relative to the project root. */
  file: string;
  /** Lines to append to `file`. */
  lines: string[];
  /** Optional explanation of why the fix has this shape. */
  note?: string;
}

export interface IgnoreProblem {
  /** Ignore file containing the deciding rule (as reported by `git check-ignore -v`). */
  source: string;
  line: number;
  pattern: string;
  /** Which representative path was ignored. */
  probe: string;
  /** A scratch-verified fix, or undefined when none of the candidates worked. */
  fix?: IgnoreFix;
}

function git(cwd: string, args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string };
    return { code: typeof e.status === "number" ? e.status : 128, out: typeof e.stdout === "string" ? e.stdout : "" };
  }
}

interface Verdict {
  ignored: boolean;
  source?: string;
  line?: number;
  pattern?: string;
}

function checkIgnore(cwd: string, path: string, extra: string[] = []): Verdict | undefined {
  const r = git(cwd, [...extra, "check-ignore", "-v", "--no-index", "--", path]);
  if (r.code === 1) return { ignored: false };
  if (r.code !== 0) return undefined;
  const m = r.out.split("\n")[0]?.match(/^(.*):(\d+):(.*)\t/);
  if (!m) return undefined;
  const pattern = m[3]!;
  return { ignored: !pattern.startsWith("!"), source: m[1]!, line: Number(m[2]), pattern };
}

/** Is the shared store ignored in the git repo at `root`? Undefined when not ignored or unknown. */
export function checkSharedIgnored(root: string): IgnoreProblem | undefined {
  for (const probe of PROBES) {
    const v = checkIgnore(root, probe);
    if (v?.ignored && v.source && v.line !== undefined && v.pattern !== undefined) {
      return { source: v.source, line: v.line, pattern: v.pattern, probe, fix: findFix(root, v.source) };
    }
  }
  return undefined;
}

function candidates(source: string): IgnoreFix[] {
  const out: IgnoreFix[] = [];
  const rel = source.replace(/\\/g, "/");
  if (!isAbsolute(rel) && posix.basename(rel) === ".gitignore") {
    const dir = posix.dirname(rel) === "." ? "" : posix.dirname(rel);
    if (dir === SHARED_REL) out.push({ file: rel, lines: ["!*", "!*/**"] });
    else if (dir && SHARED_REL.startsWith(`${dir}/`)) {
      const sub = SHARED_REL.slice(dir.length + 1);
      out.push({ file: rel, lines: [`!/${sub}/`, `!/${sub}/**`] });
    }
  }
  out.push({ file: ".gitignore", lines: [`!/${SHARED_REL}/`, `!/${SHARED_REL}/**`] });
  out.push({
    file: ".gitignore",
    lines: ["!/.pi/", "/.pi/*", `!/${SHARED_REL}/`, `!/${SHARED_REL}/**`],
    note: "git cannot re-include files inside an ignored directory, so `.pi` itself is re-included and everything else in it stays ignored",
  });
  return out;
}

function findFix(root: string, source: string): IgnoreFix | undefined {
  const scratch = mkdtempSync(join(tmpdir(), "realctx2-gi-"));
  try {
    if (git(scratch, ["init", "-q"]).code !== 0) return undefined;
    const excludes = git(root, ["config", "--path", "--get", "core.excludesFile"]).out.trim();
    const extra = excludes ? ["-c", `core.excludesFile=${excludes}`] : [];
    const infoExclude = git(root, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]).out.trim();
    const scratchExclude = join(scratch, ".git", "info", "exclude");
    const ignoreFiles = [".gitignore", ".pi/.gitignore", `${SHARED_REL}/.gitignore`];
    for (const c of candidates(source)) {
      rmSync(join(scratch, ".gitignore"), { force: true });
      rmSync(join(scratch, ".pi"), { recursive: true, force: true });
      mkdirSync(join(scratch, SHARED_REL, "updates"), { recursive: true });
      for (const f of ignoreFiles) if (existsSync(join(root, f))) copyFileSync(join(root, f), join(scratch, f));
      mkdirSync(dirname(scratchExclude), { recursive: true });
      if (infoExclude && existsSync(infoExclude)) copyFileSync(infoExclude, scratchExclude);
      else writeFileSync(scratchExclude, "");
      const target = join(scratch, c.file);
      const before = existsSync(target) ? readFileSync(target, "utf8") : "";
      writeFileSync(target, `${before}${before && !before.endsWith("\n") ? "\n" : ""}${c.lines.join("\n")}\n`);
      const allUnignored = PROBES.every((probe) => {
        const v = checkIgnore(scratch, probe, extra);
        return v !== undefined && !v.ignored;
      });
      if (allUnignored) return c;
    }
    return undefined;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Append a verified fix to its target ignore file in `root`. */
export function applyIgnoreFix(root: string, fix: IgnoreFix): string {
  const target = join(root, fix.file);
  mkdirSync(dirname(target), { recursive: true });
  const before = existsSync(target) ? readFileSync(target, "utf8") : "";
  writeFileSync(target, `${before}${before && !before.endsWith("\n") ? "\n" : ""}${fix.lines.join("\n")}\n`);
  return target;
}

/** Human explanation with the verified fix, for notifications, status, and doctor. */
export function describeIgnoreProblem(p: IgnoreProblem): string {
  const lines = [
    `The shared memory store ${SHARED_REL}/ is ignored by git (${p.source}:${p.line}: \`${p.pattern}\`), so project-shared memories will not be committed or shared.`,
  ];
  if (p.fix) {
    lines.push(`Fix (/realctx2 git fix-gitignore): append to ${p.fix.file}:`);
    for (const l of p.fix.lines) lines.push(`    ${l}`);
    if (p.fix.note) lines.push(`(${p.fix.note}.)`);
  } else {
    lines.push(`Fix: remove or narrow line ${p.line} of ${p.source} so that ${SHARED_REL}/ is not ignored.`);
  }
  lines.push(`Check with: git check-ignore -v --no-index ${p.probe}  (no output = fixed)`);
  return lines.join("\n");
}
