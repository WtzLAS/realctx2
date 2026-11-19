import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { MemoryNode, ScopedNode } from "../src/core/types.ts";
import { commandActions, PathDelivery } from "../src/memory/delivery.ts";
import { commonDir, declaresSymbol, globDepth } from "../src/memory/paths.ts";
import { MemoryWriter } from "../src/memory/write.ts";
import { analyzeCommand } from "../src/util/shell.ts";
import { DAY, world, type World } from "./helpers/fakes.ts";
import { cleanupTmp, commitAll, git, initRepo, tmp, write } from "./helpers/fixtures.ts";

afterAll(cleanupTmp);

const CODE = (name: string) => `export class ${name} {\n  private pending: Promise<string> | null = null;\n  async refresh() {\n    if (!this.pending) this.pending = fetchToken();\n    return this.pending;\n  }\n  clear() { this.pending = null; }\n}\n// ${"padding line to make fingerprints meaningful\n// ".repeat(8)}\n`;

async function remember(w: World, text: string, over: Record<string, unknown> = {}): Promise<ScopedNode> {
  const [r] = await new MemoryWriter(w).write([{ text, origin: "explicit", scope: "personal", urgency: "hint", skipConflicts: true, skipDedup: true, ...over }]);
  return w.graph.get(r!.id!)!;
}

function pathsOf(w: World, ref: ScopedNode): Array<string | null> {
  return w.paths.displayAnchors(w.graph.get(ref.node.id, { includePurged: true }) ?? ref).map((a) => (a.anchor.status === "stale" ? `stale:${a.at}` : a.at));
}

function repoWithFiles(): string {
  const repo = initRepo();
  write(repo, "src/auth/tokenCache.ts", CODE("TokenCache"));
  write(repo, "src/auth/session/store.ts", CODE("SessionStore"));
  write(repo, "src/auth/session/cookie.ts", CODE("CookieJar"));
  write(repo, "src/db/schema.ts", "export const users = { deletedAt: null };\n");
  write(repo, "docs/guide.md", "# Guide\n");
  commitAll(repo, "files");
  return repo;
}

describe("anchors (§6.8.1–§6.8.2)", () => {
  it("builds the four anchor kinds and mirrors only anchored paths", async () => {
    const repo = repoWithFiles();
    const w = world({ cwd: repo });
    const m = await remember(w, "Auth notes.", { paths: ["src/auth/tokenCache.ts", "src/auth/", "packages/*/migrations/**", "src/auth/tokenCache.ts#TokenCache.refresh", "/etc/passwd", "../outside.ts"] });
    expect(pathsOf(w, m).sort()).toEqual(["packages/*/migrations/**", "src/auth/**", "src/auth/tokenCache.ts", "src/auth/tokenCache.ts#TokenCache.refresh"]); // paths outside the repo are not anchored
    expect(m.node.anchors.map((a) => a.kind).sort()).toEqual(["file", "glob", "subtree", "symbol"]);
    expect(m.node.anchors.find((a) => a.kind === "file")!.seenBlob).toBe(git(repo, "hash-object", "src/auth/tokenCache.ts"));
    expect(w.graph.sd("personal").pathEntries().map((e) => e.path).sort()).toEqual(["src", "src/auth", "src/auth/tokenCache.ts"]);
    // the repo root is the root glob; the Global scope has no repository and uses globs only
    expect((await remember(w, "Root rule.", { kind: "rule", paths: ["."] })).node.anchors).toEqual([expect.objectContaining({ kind: "glob", glob: "**", role: "applies" })]);
    const g = await remember(w, "Go files use gofumpt.", { kind: "rule", scope: "global", paths: ["**/*.go", "src/auth/tokenCache.ts"] });
    expect(g.node.anchors.map((a) => [a.kind, a.glob]).sort()).toEqual([["glob", "**/*.go"], ["glob", "**/src/auth/tokenCache.ts"]]);
    // separate trees per scope: a personal path never reaches the shared registry
    expect(w.graph.sd("shared").pathEntries()).toEqual([]);
    expect(declaresSymbol(CODE("TokenCache"), "TokenCache.refresh")).toBe(true);
    expect(declaresSymbol(CODE("TokenCache"), "TokenCache.rotate")).toBe(false);
    expect(declaresSymbol("def refresh_token(self):\n    pass\n", "refresh_token")).toBe(true);
    expect(globDepth("packages/*/migrations/**")).toBe(1);
    expect(commonDir(["src/auth/a.ts", "src/auth/session/b.ts"])).toBe("src/auth");
    w.close();
  });

  it("finds the memories covering a path, from the root down", async () => {
    const repo = repoWithFiles();
    const w = world({ cwd: repo });
    const root = await remember(w, "Root rule.", { kind: "rule", paths: ["."] });
    const dir = await remember(w, "Auth rule.", { kind: "rule", paths: ["src/auth/"] });
    const file = await remember(w, "Fact about the token cache.", { paths: ["src/auth/tokenCache.ts"] });
    const glob = await remember(w, "TypeScript rule.", { kind: "rule", paths: ["**/*.ts"] });
    const other = await remember(w, "Fact about the schema.", { paths: ["src/db/schema.ts"] });
    const cover = w.paths.covering("src/auth/tokenCache.ts");
    expect(cover.map((c) => [c.node.id, c.at, c.depth])).toEqual(expect.arrayContaining([[root.node.id, "**", 0], [glob.node.id, "**/*.ts", 0], [dir.node.id, "src/auth/**", 2], [file.node.id, "src/auth/tokenCache.ts", 3]]));
    expect(cover.map((c) => c.node.id)).not.toContain(other.node.id);
    expect(w.paths.covering("src/auth/session/store.ts").map((c) => c.node.id).sort()).toEqual([root.node.id, dir.node.id, glob.node.id].sort());
    expect(w.paths.covering("docs/guide.md").map((c) => c.node.id)).toEqual([root.node.id]);
    expect(w.paths.covering("src/auth/tokenCache.ts", { roles: ["about"] }).map((c) => c.node.id)).toEqual([file.node.id]);
    w.close();
  });
});

describe("tracking moves and deletions (§6.8.3–§6.8.4)", () => {
  it("follows moves the agent makes with shell commands, only after stat confirms them", async () => {
    const repo = repoWithFiles();
    const w = world({ cwd: repo });
    const m = await remember(w, "Fact: src/auth/tokenCache.ts holds the single-flight refresh. We once moved src/auth/tokenCache.ts by hand.", { paths: ["src/auth/tokenCache.ts"], artifacts: ["src/auth/tokenCache.ts"] });
    const fx = analyzeCommand("git mv src/auth/tokenCache.ts src/auth/cache.ts", { cwd: repo });
    // the command has not run yet: nothing moves
    expect(w.paths.applyEffects(fx)).toEqual({ moved: 0, deleted: 0 });
    git(repo, "mv", "src/auth/tokenCache.ts", "src/auth/cache.ts");
    expect(w.paths.applyEffects(fx)).toEqual({ moved: 1, deleted: 0 });
    expect(pathsOf(w, m)).toEqual(["src/auth/cache.ts"]);
    const after = w.graph.get(m.node.id)!.node;
    // the old path is rewritten as a whole token in the signature; the text is left alone and queued for reverify
    expect(after.signature).toContain("src/auth/cache.ts");
    expect(after.signature).not.toContain("src/auth/tokenCache.ts");
    expect(after.text).toContain("src/auth/tokenCache.ts");
    expect(after.contentHash).toBe(m.node.contentHash);
    expect(after.flags).toContain("reverify");
    expect([...w.paths.reverifyQueue]).toEqual([`personal:${m.node.id}`]);
    // cp does not move anchors, and rm marks the path absent without touching the memory
    const cp = analyzeCommand("cp src/auth/cache.ts src/auth/copy.ts && rm src/db/schema.ts", { cwd: repo });
    const schema = await remember(w, "Fact about the schema.", { paths: ["src/db/schema.ts"] });
    writeFileSync(join(repo, "src/auth/copy.ts"), "x");
    rmSync(join(repo, "src/db/schema.ts"));
    expect(w.paths.applyEffects(cp)).toEqual({ moved: 0, deleted: 1 });
    expect(pathsOf(w, m)).toEqual(["src/auth/cache.ts"]);
    expect(w.graph.sd("personal").pathEntry(w.graph.sd("personal").findPath("src/db/schema.ts")!)!.data.status).toBe("absent");
    expect(w.graph.get(schema.node.id)!.node.status).toBe("active");
    expect(w.paths.covering("src/db/schema.ts")).toEqual([]); // absent paths are not touched, so their cards do not appear
    w.close();
  });

  it("reconciles committed renames, uncommitted renames and directory moves at session start", async () => {
    const repo = repoWithFiles();
    let w = world({ cwd: repo });
    const cache = await remember(w, "Token cache fact.", { paths: ["src/auth/tokenCache.ts"] });
    const store = await remember(w, "Session store fact.", { paths: ["src/auth/session/store.ts"] });
    const cookie = await remember(w, "Cookie fact.", { paths: ["src/auth/session/cookie.ts"] });
    const dirRule = await remember(w, "Session rule.", { kind: "rule", paths: ["src/auth/session/"] });
    const schema = await remember(w, "Schema fact.", { paths: ["src/db/schema.ts"] });
    w.graph.flush();
    w.close();
    // between sessions: a committed rename, a directory move (IDE), and an uncommitted rename with an edit
    git(repo, "mv", "src/auth/tokenCache.ts", "src/auth/cache.ts");
    commitAll(repo, "rename cache");
    mkdirSync(join(repo, "packages/core"), { recursive: true });
    renameSync(join(repo, "src/auth/session"), join(repo, "packages/core/session"));
    renameSync(join(repo, "src/db/schema.ts"), join(repo, "src/db/tables.ts"));
    w = w.reopen();
    const report = w.paths.reconcile();
    expect(pathsOf(w, cache)).toEqual(["src/auth/cache.ts"]);
    expect(pathsOf(w, store)).toEqual(["packages/core/session/store.ts"]);
    expect(pathsOf(w, cookie)).toEqual(["packages/core/session/cookie.ts"]);
    expect(pathsOf(w, dirRule)).toEqual(["packages/core/session/**"]); // the directory node moved, not each file
    expect(pathsOf(w, schema)).toEqual(["src/db/tables.ts"]); // untracked file with the same blob
    expect(report.moved.map((m) => `${m.from} → ${m.to}`).sort()).toEqual(["src/auth/session → packages/core/session", "src/auth/tokenCache.ts → src/auth/cache.ts", "src/db/schema.ts → src/db/tables.ts"]);
    expect(report.absent).toEqual([]);
    // a second reconcile has nothing uncertain left to move
    expect(w.paths.reconcile().moved).toEqual([]);
    w.close();
  });

  it("writes nothing when the content is unchanged at a new commit, and still follows a later rename", async () => {
    const repo = repoWithFiles();
    let w = world({ cwd: repo });
    const fact = await remember(w, "Schema fact.", { scope: "shared", paths: ["src/db/schema.ts"] });
    w.graph.flush({ force: true });
    w.close();
    commitAll(repo, "shared memory");
    // HEAD moves a few times; the anchored file stays as it is
    for (let i = 0; i < 3; i++) {
      write(repo, `docs/note${i}.md`, `note ${i}\n`);
      commitAll(repo, `note ${i}`);
      w = w.reopen();
      const report = w.paths.reconcile();
      expect(report.changed).toEqual([]);
      // a session that only looks leaves the shared store clean (§7.5)
      expect(w.graph.sd("shared").dirty).toBe("none");
      w.graph.flush({ force: true });
      w.close();
      expect(git(repo, "status", "--porcelain")).toBe("");
    }
    // the file is renamed in a commit, long after the commit recorded with its content
    git(repo, "mv", "src/db/schema.ts", "src/db/tables.ts");
    commitAll(repo, "rename schema");
    w = w.reopen();
    expect(w.paths.reconcile().moved.map((m) => `${m.from} → ${m.to}`)).toEqual(["src/db/schema.ts → src/db/tables.ts"]);
    expect(pathsOf(w, fact)).toEqual(["src/db/tables.ts"]);
    expect(w.graph.sd("shared").dirty).toBe("substantive");
    // an edit is noticed at the next reconcile, and recorded once
    w.graph.flush({ force: true });
    w.close();
    commitAll(repo, "moved memory");
    write(repo, "src/db/tables.ts", "export const users = { deletedAt: null, email: '' };\n");
    commitAll(repo, "edit");
    w = w.reopen();
    expect(w.paths.reconcile().changed).toEqual(["src/db/tables.ts"]);
    w.graph.flush({ force: true });
    w.close();
    w = w.reopen();
    expect(w.paths.reconcile().changed).toEqual([]);
    expect(w.graph.sd("shared").dirty).toBe("none");
    w.close();
  });

  it("matches a renamed and edited file by fingerprint outside git", async () => {
    const dir = tmp("realctx2-nogit-");
    write(dir, "lib/tokenCache.ts", CODE("TokenCache"));
    let w = world({ cwd: dir });
    expect(w.graph.project.inGit).toBe(false);
    const m = await remember(w, "Token cache fact.", { paths: ["lib/tokenCache.ts"] });
    w.close();
    // outside git there is no status to consult: a missing path simply becomes absent
    renameSync(join(dir, "lib/tokenCache.ts"), join(dir, "lib/cache.ts"));
    w = w.reopen();
    const report = w.paths.reconcile();
    expect(report.absent).toEqual(["lib/tokenCache.ts"]);
    expect(w.graph.get(m.node.id)!.node.status).toBe("active");
    // and it comes back when the path reappears
    renameSync(join(dir, "lib/cache.ts"), join(dir, "lib/tokenCache.ts"));
    expect(w.paths.reconcile().revived).toEqual(["lib/tokenCache.ts"]);
    w.close();
  });

  it("matches an uncommitted rename with edits by content fingerprint", async () => {
    const repo = repoWithFiles();
    let w = world({ cwd: repo });
    const m = await remember(w, "Token cache fact.", { paths: ["src/auth/tokenCache.ts"] });
    w.close();
    rmSync(join(repo, "src/auth/tokenCache.ts"));
    write(repo, "lib/cache.ts", CODE("TokenCache").replace("clear() { this.pending = null; }", "clear() { this.pending = null; /* edited */ }"));
    w = w.reopen();
    w.paths.reconcile();
    expect(pathsOf(w, m)).toEqual(["lib/cache.ts"]);
    // the anchor now shows that the file changed since the note was made
    expect(w.paths.covering("lib/cache.ts")[0]!.changed).toBe(true);
    w.close();
  });

  it("treats branch switches as absent, deletes after 14 days off the default branch, and revives on return", async () => {
    const repo = repoWithFiles();
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "src/feature/widget.ts", CODE("Widget"));
    write(repo, "src/feature/AGENTS-notes.ts", "// notes\n");
    commitAll(repo, "feature files");
    let w = world({ cwd: repo });
    const fact = await remember(w, "Widget fact.", { paths: ["src/feature/widget.ts"] });
    const proc = await remember(w, "Widget procedure.", { kind: "procedure", paths: ["src/feature/"] });
    const both = await remember(w, "Fact about widget and schema.", { paths: ["src/feature/widget.ts", "src/db/schema.ts"] });
    const [ingested] = await new MemoryWriter(w).write([{ text: "Never edit widget snapshots by hand.", kind: "rule", severity: "must", origin: "instructions", scope: "personal", urgency: "hint", paths: ["src/feature/"], source: { file: "src/feature/AGENTS.md", sha: "x", section: "Rules", lines: [1, 2] } }]);
    w.close();
    git(repo, "checkout", "-q", "main");
    w = w.reopen();
    let report = w.paths.reconcile();
    expect(report.absent.sort()).toEqual(["src/feature", "src/feature/widget.ts"]);
    // `absent` changes no memory
    for (const r of [fact, proc, both]) expect(w.graph.get(r.node.id)!.node.status).toBe("active");
    w.now.t += 13 * DAY;
    expect(w.paths.reconcile().deleted).toEqual([]);
    w.now.t += 2 * DAY;
    report = w.paths.reconcile();
    expect(report.deleted.sort()).toEqual(["src/feature", "src/feature/widget.ts"]);
    // all anchors stale: facts and learned procedures go dormant; an instruction rule is flagged, not hidden
    expect(w.graph.get(fact.node.id)!.node).toMatchObject({ status: "dormant", statusReason: "path-deleted" });
    expect(w.graph.get(proc.node.id)!.node).toMatchObject({ status: "dormant", statusReason: "path-deleted" });
    expect(w.graph.get(ingested!.id!)!.node).toMatchObject({ status: "active", flags: ["stale-rule"] });
    // some anchors still live: kept; the stale anchor is dropped after 30 days
    expect(w.graph.get(both.node.id)!.node.status).toBe("active");
    expect(pathsOf(w, both).sort()).toEqual(["src/db/schema.ts", "stale:src/feature/widget.ts"]);
    w.now.t += 31 * DAY;
    expect(w.paths.dropStaleAnchors()).toBe(1);
    expect(pathsOf(w, both)).toEqual(["src/db/schema.ts"]);
    // the branch comes back: paths live again, dormant memories revived, the flag cleared
    git(repo, "checkout", "-q", "feature");
    report = w.paths.reconcile();
    expect(report.revived).toEqual(expect.arrayContaining(["src/feature", "src/feature/widget.ts", `m:${fact.node.id}`, `m:${proc.node.id}`]));
    expect(w.graph.get(fact.node.id)!.node.status).toBe("active");
    expect(w.graph.get(ingested!.id!)!.node.flags).toEqual([]);
    expect(pathsOf(w, fact)).toEqual(["src/feature/widget.ts"]);
    w.close();
  });

  it("follows a symbol whose declaration moved to one other file, else marks the anchor stale", async () => {
    const repo = repoWithFiles();
    let w = world({ cwd: repo });
    const moved = await remember(w, "refresh is single-flight.", { paths: ["src/auth/tokenCache.ts#TokenCache.refresh"] });
    const gone = await remember(w, "SessionStore keeps sessions in memory.", { paths: ["src/auth/session/store.ts#SessionStore.refresh"] });
    w.close();
    write(repo, "src/auth/tokenCache.ts", "export const placeholder = 1;\n");
    write(repo, "src/auth/refresher.ts", CODE("TokenCache"));
    write(repo, "src/auth/session/store.ts", "export const nothing = 0;\n");
    write(repo, "src/auth/session/cookie.ts", "export const alsoNothing = 0;\n");
    commitAll(repo, "move declaration");
    w = w.reopen();
    w.paths.reconcile({ full: true });
    expect(pathsOf(w, moved)).toEqual(["src/auth/refresher.ts#TokenCache.refresh"]);
    expect(pathsOf(w, gone)).toEqual(["stale:src/auth/session/store.ts#SessionStore.refresh"]);
    expect(w.graph.get(moved.node.id)!.node.flags).toContain("reverify");
    w.close();
  });
});

describe("just-in-time delivery (§6.8.5, §6.10.2)", () => {
  async function setup() {
    const repo = initRepo();
    write(repo, "packages/api/src/db/schema.ts", "export const users = { deletedAt: null };\n");
    write(repo, "packages/api/src/db/generated/client.ts", "// generated\n");
    write(repo, "packages/api/src/routes/users.ts", "export {}\n");
    commitAll(repo);
    const w = world({ cwd: repo });
    const src = (file: string) => ({ file, sha: "s", section: "Rules", lines: [1, 2] as [number, number] });
    const rule = async (text: string, over: Record<string, unknown>) => remember(w, text, { kind: "rule", origin: "instructions", ...over });
    const gen = await rule("Run `pnpm db:generate` after editing prisma/schema.prisma.", { severity: "must", paths: ["packages/api/"], source: src("packages/api/AGENTS.md") });
    const thin = await rule("Keep route handlers thin; business logic lives in src/services.", { severity: "should", paths: ["packages/api/"], source: src("packages/api/AGENTS.md") });
    const never = await rule("Never edit files in src/db/generated.", { severity: "must", urgency: "immediate", paths: ["packages/api/src/db/"], source: src("packages/api/src/db/AGENTS.md"), triggersOn: ["edit"] });
    const fat = await rule("In the db layer, handlers may hold query logic.", { severity: "should", paths: ["packages/api/src/db/"], source: src("packages/api/src/db/AGENTS.md") });
    w.graph.link(fat, "contradicts", thin);
    w.graph.commit("personal");
    const soft = await remember(w, "`users` rows are soft-deleted via `deletedAt`.", { paths: ["packages/api/src/db/schema.ts"], validFrom: "2026-10-02T00:00:00.000Z" });
    const seed = await remember(w, "Seed data lives in prisma/seed.ts and is long to explain in full detail.", { title: "Seed data lives in prisma/seed.ts", urgency: "caption", paths: ["packages/api/src/db/schema.ts"] });
    const quiet = await remember(w, "Background trivia about the schema.", { urgency: "passive", paths: ["packages/api/src/db/schema.ts"] });
    const reset = await rule("Never run `prisma migrate reset`; the dev database is shared.", { severity: "must", urgency: "immediate", commands: ["prisma migrate reset*", "pnpm prisma migrate reset*"] });
    const lint = await rule("Run the linter before committing.", { severity: "should", triggersOn: ["commit"] });
    return { repo, w, d: new PathDelivery(w), gen, thin, never, fat, soft, seed, quiet, reset, lint };
  }
  const none = { visible: () => false, turnTokensLeft: 1500 };

  it("renders a [paths] block from the root down, by urgency, with overrides and file-changed marks", async () => {
    const t = await setup();
    write(t.repo, "packages/api/src/db/schema.ts", "export const users = { deletedAt: null, email: '' };\n");
    t.w.paths.noteWrite("packages/api/src/db/schema.ts");
    t.w.graph.commit("personal");
    const block = t.d.block({ action: "read", paths: ["packages/api/src/db/schema.ts"] }, none)!;
    const id = (r: ScopedNode) => `[m:${r.node.id}]`;
    expect(block.text.split("\n")).toEqual([
      "[paths] packages/api/src/db/schema.ts",
      "packages/api/** (from packages/api/AGENTS.md)",
      `- MUST   ${id(t.gen)} Run \`pnpm db:generate\` after editing prisma/schema.prisma.`,
      `- SHOULD ${id(t.thin)} Keep route handlers thin; business logic lives in src/services.`,
      `packages/api/src/db/** (from packages/api/src/db/AGENTS.md) · overrides ${id(t.thin)} here`,
      `- SHOULD ${id(t.fat)} In the db layer, handlers may hold query logic.`,
      "packages/api/src/db/schema.ts",
      `- ${id(t.soft)} fact · as of 2026-10-02 · ⚠ file changed since: \`users\` rows are soft-deleted via \`deletedAt\`.`,
      `- ${id(t.seed)} Seed data lives in prisma/seed.ts`,
    ]);
    // `never` is triggered by edits only; `quiet` is passive and never pushed
    expect(block.shown.map((s) => s.ref.node.id)).not.toContain(t.never.node.id);
    expect(block.shown.map((s) => s.ref.node.id)).not.toContain(t.quiet.node.id);
    expect(block.shown.find((s) => s.ref.node.id === t.seed.node.id)!.full).toBe(false);
    // an edit brings the edit-triggered rule
    const edit = t.d.block({ action: "edit", paths: ["packages/api/src/db/schema.ts"] }, none)!;
    expect(edit.text).toContain(`- MUST   ${id(t.never)} Never edit files in src/db/generated.`);
    // no repeats while an earlier delivery is still visible in context
    const seen = new Set(block.shown.map((s) => s.ref.node.id));
    expect(t.d.block({ action: "read", paths: ["packages/api/src/db/schema.ts"] }, { visible: (i) => seen.has(i), turnTokensLeft: 1500 })).toBeNull();
    // another file under packages/api gets the directory rules but not the schema's facts
    const other = t.d.block({ action: "read", paths: ["packages/api/src/routes/users.ts"] }, none)!;
    expect(other.shown.map((s) => s.ref.node.id).sort()).toEqual([t.gen.node.id, t.thin.node.id].sort());
    t.w.close();
  });

  it("fills the budget in urgency order: immediate is never cut, hints fall back to captions, then to a count", async () => {
    const t = await setup();
    const long = await remember(t.w, `Handlers stay thin. ${"Every handler validates input, calls exactly one service, maps the result, and returns. ".repeat(6)}`, { kind: "rule", severity: "must", title: "Handlers stay thin", paths: ["packages/api/"] });
    const tight = t.d.block({ action: "edit", paths: ["packages/api/src/db/schema.ts"] }, { visible: () => false, turnTokensLeft: 80 })!;
    const full = tight.shown.filter((s) => s.full).map((s) => s.ref.node.id);
    expect(full).toContain(t.never.node.id); // immediate
    expect(tight.shown.find((s) => s.ref.node.id === long.node.id)).toMatchObject({ full: false }); // a hint that does not fit is shown as a caption
    expect(tight.text).toContain(`- [m:${long.node.id}] Handlers stay thin`);
    expect(tight.text).toMatch(/\+\d+ more: search\(path: "packages\/api\/src\/db\/schema\.ts"\)$/);
    expect(tight.tokens).toBeLessThan(120);
    // immediate memories are never cut, even with nothing left of the turn budget
    const zero = t.d.block({ action: "edit", paths: ["packages/api/src/db/schema.ts"] }, { visible: () => false, turnTokensLeft: 0 })!;
    expect(zero.shown.map((s) => s.ref.node.id)).toEqual([t.never.node.id]);
    const cfgOff = t.w.cfg.paths;
    cfgOff.deliver = false;
    expect(t.d.block({ action: "read", paths: ["packages/api/src/db/schema.ts"] }, none)).toBeNull();
    t.w.close();
  });

  it("brings up memories by command pattern and by the kind of action", async () => {
    const t = await setup();
    expect([...commandActions(["git commit -m x"])].sort()).toEqual(["command", "commit"]);
    expect([...commandActions(["pnpm test --runInBand"])].sort()).toEqual(["command", "test"]);
    const reset = t.d.block({ action: "command", paths: [], command: "cd packages/api && FOO=1 pnpm prisma migrate reset --force" }, none)!;
    expect(reset.shown.map((s) => s.ref.node.id)).toEqual([t.reset.node.id]);
    expect(t.d.block({ action: "command", paths: [], command: "echo prisma migrate reset" }, none)).toBeNull(); // each part is matched on its own
    const commit = t.d.block({ action: "command", paths: [], command: "git add -A && git commit -m wip" }, none)!;
    expect(commit.shown.map((s) => s.ref.node.id)).toEqual([t.lint.node.id]);
    expect(t.d.block({ action: "command", paths: [], command: "git status" }, none)).toBeNull();
    t.w.close();
  });

  it("gates edits and commands once per memory, and not when the memory was already shown in full", async () => {
    const t = await setup();
    const ctx = (gated: string[] = [], shown: string[] = []) => ({ gated: (i: string) => gated.includes(i), shownFull: (i: string) => shown.includes(i) });
    const g = t.d.gate({ action: "edit", paths: ["packages/api/src/db/generated/client.ts"] }, ctx())!;
    expect(g.reason).toBe(`[gate] Before this edit: MUST [m:${t.never.node.id}] Never edit files in src/db/generated. If the action still complies, repeat it.`);
    expect(g.refs.map((r) => r.node.id)).toEqual([t.never.node.id]);
    expect(t.d.gate({ action: "edit", paths: ["packages/api/src/db/generated/client.ts"] }, ctx([t.never.node.id]))).toBeNull(); // once per intent
    expect(t.d.gate({ action: "edit", paths: ["packages/api/src/db/generated/client.ts"] }, ctx([], [t.never.node.id]))).toBeNull(); // already shown in full
    expect(t.d.gate({ action: "read", paths: ["packages/api/src/db/generated/client.ts"] }, ctx())).toBeNull();
    expect(t.d.gate({ action: "edit", paths: ["packages/api/src/routes/users.ts"] }, ctx())).toBeNull();
    // bash: command patterns, and writes the shell parser sees
    const cmd = (command: string) => t.d.gate({ action: "command", paths: [], command, effects: analyzeCommand(command, { cwd: t.repo }) }, ctx());
    expect(cmd("pnpm prisma migrate reset")!.reason).toContain("[gate] Before this command: MUST");
    expect(cmd("cd packages/api && env CI=1 prisma migrate reset --force; echo done")).not.toBeNull();
    expect(cmd("prisma migrate status")).toBeNull();
    for (const c of ["echo x > packages/api/src/db/generated/client.ts", "sed -i 's/a/b/' packages/api/src/db/generated/client.ts", "cat a | tee packages/api/src/db/generated/client.ts", "rm packages/api/src/db/generated/client.ts", "git checkout -- packages/api/src/db/generated/client.ts", "cp x.ts packages/api/src/db/generated/client.ts", "cd packages/api/src/db && mv generated/client.ts generated/old.ts"]) {
      expect(cmd(c)?.refs.map((r) => r.node.id), c).toEqual([t.never.node.id]);
    }
    expect(cmd("cat packages/api/src/db/generated/client.ts")).toBeNull();
    // switch: with the gate off, immediate memories are treated as hints
    t.w.cfg.urgency.gate = "off";
    expect(cmd("pnpm prisma migrate reset")).toBeNull();
    const asHint = t.d.block({ action: "edit", paths: ["packages/api/src/db/generated/client.ts"] }, none)!;
    expect(asHint.shown.find((s) => s.ref.node.id === t.never.node.id)!.full).toBe(true);
    t.w.close();
  });

  it("builds the always-on Project rules section from root rules, with the shared-scope restriction", async () => {
    const repo = initRepo();
    mkdirSync(join(repo, "packages/api"), { recursive: true });
    const w = world({ cwd: join(repo, "packages/api") });
    const add = async (text: string, over: Record<string, unknown>): Promise<MemoryNode> => (await remember(w, text, { kind: "rule", severity: "should", ...over })).node;
    const rootMust = await add("Use pnpm, never npm.", { severity: "must", origin: "instructions", scope: "shared", paths: [repo] });
    const cwdRule = await add("API code uses the Result type.", { origin: "instructions", scope: "shared", paths: [join(repo, "packages/api") + "/"] });
    const cap = await add("Prefer small commits with long explanation text here.", { title: "Prefer small commits", origin: "instructions", scope: "shared", urgency: "caption", paths: [repo] });
    await add("Passive root rule.", { origin: "instructions", scope: "shared", urgency: "passive", paths: [repo] });
    const learnedShared = await add("A rule a teammate's agent learned.", { origin: "harvest", scope: "shared", paths: [repo] }); // shared, but not from instruction files
    const personal = await add("My own root rule.", { origin: "explicit", scope: "personal", paths: [repo] });
    const globalRule = await add("Global habit from ~/.pi/agent/AGENTS.md.", { origin: "instructions", scope: "global" });
    await add("Deeper rule elsewhere.", { origin: "instructions", scope: "shared", paths: [join(repo, "docs") + "/"] });
    const d = new PathDelivery(w);
    const pr = d.projectRules();
    expect(pr.ids.sort()).toEqual([rootMust.id, cwdRule.id, cap.id, personal.id, globalRule.id].sort());
    expect(pr.ids).not.toContain(learnedShared.id);
    expect(pr.text.split("\n")[0]).toBe(`- MUST   [m:${rootMust.id}] Use pnpm, never npm.`);
    expect(pr.text).toContain(`- [m:${cap.id}] Prefer small commits`);
    expect(pr.text).toContain(`- SHOULD [m:${cwdRule.id}] API code uses the Result type. (packages/api/**)`);
    // budget in urgency order; what does not fit is left to path delivery
    w.cfg.instructions.alwaysOnTokens = 30;
    const small = d.projectRules();
    expect(small.ids[0]).toBe(rootMust.id);
    expect(small.overflow.length).toBeGreaterThan(0);
    expect(d.rulesAt("packages/api/src/x.ts").map((r) => r.ref.node.id)).toEqual(expect.arrayContaining([rootMust.id, cwdRule.id, personal.id]));
    w.close();
  });
});
