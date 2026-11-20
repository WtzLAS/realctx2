/** Project identity and machine identity (§6.1, §7.8). */
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, parse, resolve } from "node:path";
import { readJson, writeJson } from "../util/fs.ts";
import { Git } from "../util/git.ts";
import { sha256 } from "../util/text.ts";
import { Layout } from "./config.ts";

export interface ProjectInfo {
  cwd: string;
  /** Repo root when inside git, else the working directory itself. Null outside any project. */
  root: string | null;
  git: Git | null;
  /** Null outside any project: only the Global scope is visible then. */
  projectKey: string | null;
  sharedDir: string | null;
  inGit: boolean;
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Project key (§6.1):
 * 1. `projectId` from `<repo>/.pi/realctx2/store.json` when present;
 * 2. in a git repo, sha256("git-root:" + sorted root commit hashes) — stable across clones,
 *    forks and worktrees;
 * 3. otherwise sha256("path:" + realpath(cwd)).
 */
export function resolveProject(cwd: string, configDirName = ".pi"): ProjectInfo {
  const dir = real(cwd);
  const git = new Git(dir);
  const repoRoot = git.root();
  if (repoRoot) {
    const root = real(repoRoot);
    const sharedDir = Layout.sharedDir(root, configDirName);
    const stored = readJson<{ projectId?: unknown }>(join(sharedDir, "store.json"), {});
    let key: string;
    if (typeof stored.projectId === "string" && /^[\w-]{8,64}$/.test(stored.projectId)) key = stored.projectId;
    else {
      const roots = git.rootCommits();
      key = roots.length ? sha256(`git-root:${roots.join(",")}`).slice(0, 24) : sha256(`path:${root}`).slice(0, 24);
    }
    return { cwd: dir, root, git, projectKey: key, sharedDir, inGit: true };
  }
  // Outside git, a directory counts as a project unless it is the home directory or a filesystem root.
  const home = real(homedir());
  if (dir === home || dir === parse(dir).root) return { cwd: dir, root: null, git: null, projectKey: null, sharedDir: null, inGit: false };
  const sharedDir = Layout.sharedDir(dir, configDirName);
  const stored = readJson<{ projectId?: unknown }>(join(sharedDir, "store.json"), {});
  const key = typeof stored.projectId === "string" && /^[\w-]{8,64}$/.test(stored.projectId) ? stored.projectId : sha256(`path:${dir}`).slice(0, 24);
  return { cwd: dir, root: dir, git: null, projectKey: key, sharedDir, inGit: false };
}

/** This machine's id (`machine.json`), created on first use. It maps to Loro PeerIDs in `meta.peers`. */
export function machineActorId(layout: Layout): string {
  const cur = readJson<{ actorId?: string }>(layout.machineFile, {});
  if (typeof cur.actorId === "string" && cur.actorId) return cur.actorId;
  const actorId = `a-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  try {
    writeJson(layout.machineFile, { actorId, createdAt: new Date().toISOString() });
  } catch {
    // a read-only home still gets a usable (per-process) id
  }
  return actorId;
}
