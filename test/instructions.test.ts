import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { AuxTask, CommandIO } from "../src/core/types.ts";
import { PathDelivery } from "../src/memory/delivery.ts";
import { GENERATED_MARK, Instructions, parseInstructionFile } from "../src/memory/instructions.ts";
import { Lifecycle } from "../src/memory/lifecycle.ts";
import { mechanicalChange, Reverifier, ReviewQueue } from "../src/memory/reverify.ts";
import { MemoryWriter } from "../src/memory/write.ts";
import { world, type World } from "./helpers/fakes.ts";
import { cleanupTmp, commitAll, git, initRepo, listTree, tmp, write } from "./helpers/fixtures.ts";

afterAll(cleanupTmp);

/** A deterministic stand-in for the slicer: one item per content line, with severity from wording. */
function fakeSlicer(opts: { drop?: RegExp; badQuote?: RegExp; anchorFor?: (line: string) => Array<{ kind: string; path: string; role: string }>; calls?: AuxTask[] } = {}) {
  return (task: AuxTask) => {
    opts.calls?.push(task);
    const only = /Cover exactly lines ([\d, ]+)/.exec(task.instructions)?.[1]?.split(",").map((x) => Number(x.trim()));
    const items: unknown[] = [];
    const skipped: unknown[] = [];
    for (const row of task.data[0]!.text.split("\n")) {
      const m = /^\s*(\d+)\| (.*)$/.exec(row);
      if (!m) continue;
      const n = Number(m[1]);
      const line = m[2]!.trim();
      if (!line || /^#{1,6}\s/.test(line) || line === "---" || /^paths:/.test(line) || /^\s*-\s+"/.test(m[2]!)) continue;
      if (only && !only.includes(n)) continue;
      if (!only && opts.drop?.test(line)) continue;
      if (/^Welcome|^Thanks/.test(line)) {
        skipped.push({ lines: [n, n], reason: "pleasantry" });
        continue;
      }
      const text = line.replace(/^[-*]\s+/, "");
      const cmd = /`((?:pnpm |npx )?prisma migrate reset)`/.exec(text);
      items.push({
        kind: /\b(must|never|always|should|prefer|do not)\b/i.test(text) ? "rule" : "fact",
        severity: /\b(must|never|always)\b/i.test(text) ? "must" : /\b(should|prefer)\b/i.test(text) ? "should" : "info",
        title: text.split(/[.;]/)[0],
        text,
        lines: [n, n],
        quote: opts.badQuote?.test(line) ? "words that are not in the file" : text.slice(0, 40),
        anchors: opts.anchorFor?.(text) ?? [],
        ...(cmd ? { triggers: { on: ["command"], commands: [`${cmd[1]}*`] } } : {}),
      });
    }
    return { items, skipped };
  };
}

function io(answers: { confirm?: boolean } = {}): CommandIO & { out: string[]; asked: string[] } {
  const out: string[] = [];
  const asked: string[] = [];
  return { out, asked, hasUI: true, print: (t) => void out.push(t), notify: (t) => void out.push(t), confirm: async (_t, m) => (asked.push(m), answers.confirm ?? true) };
}

const ROOT_AGENTS = `# Project

Welcome to the project.

## Build
- Always use pnpm; never use npm.
- The API lives in packages/api.

## Database
- Never run \`prisma migrate reset\`; the dev database is shared.
- You should prefer small migrations.
`;

function ingestWorld(files: Record<string, string>, over: Parameters<typeof world>[0] = {}): { repo: string; w: World; ins: Instructions } {
  const repo = initRepo();
  for (const [rel, content] of Object.entries(files)) write(repo, rel, content);
  commitAll(repo, "instruction files");
  const w = world({ cwd: repo, ...over });
  w.aux.on("ingest.slicer", fakeSlicer());
  return { repo, w, ins: new Instructions(w, new MemoryWriter(w)) };
}

let savedEnv: Record<string, string | undefined>;
beforeEach(() => {
  savedEnv = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  const home = tmp("realctx2-fakehome-");
  process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
  process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
  return () => {
    for (const [k, v] of Object.entries(savedEnv)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
});

describe("parsing and discovery (§6.9.1)", () => {
  it("parses headings, frontmatter paths, content lines and @imports outside code", () => {
    const p = parseInstructionFile(['---', 'paths:', '  - "src/**/*.ts"', '  - lib/**', '---', '# Title', '', 'See @docs/guide.md and `@not/an-import.md`.', '```', '@inside/fence.md', '```', 'Scripts are in @package.json.', '<!-- comment -->'].join("\n"));
    expect(p.frontmatterPaths).toEqual(["src/**/*.ts", "lib/**"]);
    expect(p.headings).toEqual([{ line: 6, level: 1, text: "Title" }]);
    expect(p.imports.map((i) => i.target)).toEqual(["docs/guide.md", "package.json"]);
    expect(p.content).toEqual([8, 9, 10, 11, 12]);
    expect(parseInstructionFile("paths: [a/**, b/*.sql]\n".replace(/^/, "---\n") + "---\nx").frontmatterPaths).toEqual(["a/**", "b/*.sql"]);
    expect(parseInstructionFile(`<!-- ${GENERATED_MARK} -->\n# x`).generated).toBe(true);
  });

  it("finds instruction files with their scope and default anchor, honouring overrides and ignores", () => {
    const { repo, w, ins } = ingestWorld({
      "AGENTS.md": ROOT_AGENTS,
      "CLAUDE.md": "- Root claude rule must hold.\n",
      "packages/api/AGENTS.md": "- API handlers must stay thin.\n",
      "packages/api/AGENTS.override.md": "- Override: API handlers may be fat.\n",
      "packages/web/.claude/CLAUDE.md": "- Web rule should hold.\n",
      ".claude/rules/sql.md": "---\npaths: \"**/*.sql\"\n---\n- SQL keywords must be uppercase.\n",
      "node_modules/pkg/AGENTS.md": "- vendored\n",
      ".gitignore": "node_modules/\nCLAUDE.local.md\nignored-dir/\n",
    });
    write(repo, "CLAUDE.local.md", "- My local note: I prefer vim keys.\n"); // git-ignored file in a tracked directory
    write(repo, "ignored-dir/AGENTS.md", "- inside an ignored directory\n");
    const found = ins.discover({ include: ["agents", "claude", "local", "rules"] });
    expect(found.map((f) => [f.display, f.type, f.scope, f.dir, f.tracked])).toEqual([
      [".claude/rules/sql.md", "rules", "shared", "", true],
      ["AGENTS.md", "agents", "shared", "", true],
      ["CLAUDE.local.md", "local", "personal", "", false],
      ["CLAUDE.md", "claude", "shared", "", true],
      ["packages/api/AGENTS.md", "agents", "shared", "packages/api", true],
      ["packages/api/AGENTS.override.md", "override", "shared", "packages/api", true],
      ["packages/web/.claude/CLAUDE.md", "claude", "shared", "packages/web", true],
    ]);
    expect(found.find((f) => f.display === "packages/api/AGENTS.md")!.shadowedBy).toBe("packages/api/AGENTS.override.md");
    expect(ins.discover({ include: ["agents"] }).map((f) => f.display)).toEqual(["AGENTS.md", "packages/api/AGENTS.md", "packages/api/AGENTS.override.md"]);
    expect(ins.discover({ paths: ["packages/api"], include: ["agents", "claude"] }).length).toBe(2);
    w.close();
  });
});

describe("/realctx2 ingest (§6.9.2)", () => {
  it("previews without changing anything on --dry-run", async () => {
    const { repo, w, ins } = ingestWorld({ "AGENTS.md": ROOT_AGENTS });
    const out = io();
    const res = await ins.ingest({ io: out, dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(out.out[0]).toContain("AGENTS.md → shared · 4 items · coverage 100%");
    expect(out.out[0]).toContain("§ Project / Database");
    expect(out.out[0]).toMatch(/\[MUST · \w+ · \. · commands: prisma migrate reset\*\] Never run `prisma migrate reset`/);
    expect(out.out[0]).toContain("Files that will be deleted after ingest:\n  AGENTS.md (tracked: git history keeps it)");
    expect(existsSync(join(repo, "AGENTS.md"))).toBe(true);
    expect(w.graph.all()).toEqual([]);
    expect(out.asked).toEqual([]);
    // declining the confirmation changes nothing either
    const no = io({ confirm: false });
    expect((await ins.ingest({ io: no })).cancelled).toBe(true);
    expect(w.graph.all()).toEqual([]);
    w.close();
  });

  it("stores pinned long-term rules with sources, deletes tracked files, and backs up untracked ones", async () => {
    const { repo, w, ins } = ingestWorld({ "AGENTS.md": ROOT_AGENTS, "packages/api/AGENTS.md": "- API handlers must stay thin.\n", ".gitignore": "CLAUDE.local.md\n" });
    write(repo, "CLAUDE.local.md", "- I prefer vim keys.\n");
    write(repo, "packages/api/src/index.ts", "export {}\n");
    w.decision.on("ingest.check", (_e, qs) => Object.fromEntries(qs.map((q): [string, number | Record<string, number>] => [q.name, q.name.startsWith("urgency.") ? { hint: 0.8 } : 0.95])));
    const out = io();
    const res = await ins.ingest({ io: out, include: ["agents", "claude", "local"] });
    expect(res.stored.length).toBe(6);
    expect(res.deleted.sort()).toEqual(["AGENTS.md", "CLAUDE.local.md", "packages/api/AGENTS.md"]);
    expect(res.backedUp).toEqual(["CLAUDE.local.md"]);
    expect(readFileSync(join(res.backupDir!, "CLAUDE.local.md"), "utf8")).toBe("- I prefer vim keys.\n");
    // tracked deletions show up in git status next to the new update files, so both land in one commit
    const status = git(repo, "status", "--porcelain");
    expect(status).toContain("D AGENTS.md");
    expect(status).toContain(" D packages/api/AGENTS.md");
    expect(status).toContain("?? .pi/");
    const rules = w.graph.all(["shared"]).map((r) => r.node);
    expect(rules.length).toBe(5);
    for (const n of rules) expect(n).toMatchObject({ origin: "instructions", pinned: true, layer: "long", status: "active" });
    const reset = rules.find((n) => n.text.includes("prisma migrate reset"))!;
    expect(reset).toMatchObject({ kind: "rule", severity: "must", triggers: { on: ["command"], commands: ["prisma migrate reset*"] } });
    expect(reset.source).toMatchObject({ file: "AGENTS.md", section: "Project / Database", lines: [10, 10] });
    expect(reset.evidence[0]).toMatchObject({ verified: true, source: { type: "instruction", ref: "AGENTS.md:10" } });
    expect(reset.anchors).toEqual([expect.objectContaining({ kind: "glob", glob: "**", role: "applies" })]);
    const fact = rules.find((n) => n.text.startsWith("The API lives"))!;
    expect(fact).toMatchObject({ kind: "fact", anchors: [expect.objectContaining({ role: "about" })] });
    const api = rules.find((n) => n.text.includes("handlers must stay thin"))!;
    expect(w.paths.displayAnchors({ scope: "shared", node: api }).map((a) => a.at)).toEqual(["packages/api/**"]);
    // CLAUDE.local.md goes to Project Personal
    expect(w.graph.all(["personal"]).map((r) => r.node.text)).toEqual(["I prefer vim keys."]);
    // the sources map remembers each file's hash and its section → item mapping
    const src = w.graph.sd("shared").getSource("AGENTS.md")!;
    expect(src.mode).toBe("ingested");
    expect(Object.keys(src.sections).sort()).toEqual(["Project", "Project / Build", "Project / Database"]);
    expect(src.sections["Project / Database"]!.itemIds.length).toBe(2);
    // delivery: the API rule arrives with a file under packages/api; root rules are in the always-on section
    const d = new PathDelivery(w);
    const mine = w.graph.all(["personal"])[0]!.node; // a personal root rule is always-on too
    expect(d.projectRules().ids.sort()).toEqual([...rules.filter((n) => n.kind === "rule" && n !== api), mine].map((n) => n.id).sort());
    const block = d.block({ action: "read", paths: ["packages/api/src/index.ts"] }, { visible: (id) => d.projectRules().ids.includes(id), turnTokensLeft: 1500 })!;
    expect(block.text).toContain("packages/api/** (from packages/api/AGENTS.md)");
    // ignoring afterwards, in both harnesses
    expect(ins.ingestedScopes()).toEqual({ project: true, global: false });
    expect(ins.shouldIgnore(join(repo, "AGENTS.md"))).toBe(true);
    expect(ins.shouldIgnore(join(repo, "packages/web/CLAUDE.md"))).toBe(true);
    expect(ins.shouldIgnore(join(repo, "README.md"))).toBe(false);
    expect(ins.shouldIgnore(join(process.env.PI_CODING_AGENT_DIR!, "AGENTS.md"))).toBe(false); // no global ingest yet
    expect(ins.excludePatterns()).toEqual(expect.arrayContaining([`${repo}/**/CLAUDE.md`, `${repo}/**/.claude/rules/**`]));
    w.close();
  });

  it("checks coverage and quotes: uncovered lines get one re-prompt, and a file that stays uncovered is kept", async () => {
    const { repo, w, ins } = ingestWorld({ "AGENTS.md": ROOT_AGENTS, "docs/AGENTS.md": "- Docs must use sentence case.\n- This line is always dropped.\n" });
    const calls: AuxTask[] = [];
    // first pass drops a line of the root file; the re-prompt covers it
    w.aux.on("ingest.slicer", (task) => {
      if (task.instructions.includes("File: docs/AGENTS.md")) return fakeSlicer({ calls })({ ...task, instructions: task.instructions.replace(/Cover exactly lines [\d, ]+/, "") , data: [{ label: "x", text: task.data[0]!.text.split("\n").filter((l) => !l.includes("always dropped")).join("\n") }] });
      return fakeSlicer({ drop: /prefer small migrations/, badQuote: /API lives/, calls })(task);
    });
    const out = io();
    const res = await ins.ingest({ io: out });
    const root = res.plan.files.find((p) => p.file.display === "AGENTS.md")!;
    expect(root.coverage).toBe(1);
    expect(root.items.length).toBe(4);
    expect(calls.filter((c) => c.instructions.includes("File: AGENTS.md")).length).toBe(2); // one re-prompt
    expect(calls.find((c) => /Cover exactly lines 11\b/.test(c.instructions))).toBeDefined();
    // a quote that does not match its cited lines is flagged, kept, and stored unverified
    const flagged = root.items.find((i) => i.text.startsWith("The API lives"))!;
    expect(flagged.quoteOk).toBe(false);
    expect(out.out[0]).toContain("⚠ quote does not match the cited lines");
    expect(w.graph.all(["shared"]).find((r) => r.node.text.startsWith("The API lives"))!.node.evidence[0]!.verified).toBe(false);
    // the docs file never reaches full coverage: its items are stored, but the file is not deleted
    const docs = res.plan.files.find((p) => p.file.display === "docs/AGENTS.md")!;
    expect(docs.uncovered).toEqual([2]);
    expect(docs.coverage).toBe(0.5);
    expect(res.deleted).toEqual(["AGENTS.md"]);
    expect(existsSync(join(repo, "docs/AGENTS.md"))).toBe(true);
    expect(out.out[0]).toContain("uncovered lines: 2 — the file will be kept");
    w.close();
  });

  it("drops anchors that do not resolve, uses frontmatter globs for rule files, and replaces by override", async () => {
    const { repo, w, ins } = ingestWorld({
      "packages/api/AGENTS.md": "- Shadowed rule must never be stored.\n",
      "packages/api/AGENTS.override.md": "- Schema edits must be followed by codegen.\n",
      "packages/api/prisma/schema.prisma": "model User { id Int @id }\n",
      ".claude/rules/sql.md": "---\npaths:\n  - \"**/*.sql\"\n  - \"db/**\"\n---\n- SQL keywords must be uppercase.\n",
    });
    w.aux.on("ingest.slicer", fakeSlicer({ anchorFor: (t) => (t.includes("Schema edits") ? [{ kind: "file", path: "packages/api/prisma/schema.prisma", role: "applies" }, { kind: "file", path: "packages/api/missing.ts", role: "applies" }, { kind: "glob", path: "packages/[", role: "applies" }] : []) }));
    const out = io();
    const res = await ins.ingest({ io: out, include: ["agents", "rules"] });
    const nodes = w.graph.all(["shared"]).map((r) => r);
    expect(nodes.map((r) => r.node.text).sort()).toEqual(["SQL keywords must be uppercase.", "Schema edits must be followed by codegen."]);
    const schema = nodes.find((r) => r.node.text.startsWith("Schema"))!;
    expect(w.paths.displayAnchors(schema).map((a) => a.at)).toEqual(["packages/api/prisma/schema.prisma"]);
    expect(out.out[0]).toContain("⚠ anchor path not found: packages/api/missing.ts");
    expect(out.out[0]).toContain("⚠ anchor does not resolve: packages/[");
    const sql = nodes.find((r) => r.node.text.startsWith("SQL"))!;
    expect(sql.node.anchors.map((a) => a.glob).sort()).toEqual(["**/*.sql", "db/**"]);
    expect(out.out[0]).toContain("packages/api/AGENTS.md → shared · 0 items");
    expect(out.out[0]).toContain("replaced by packages/api/AGENTS.override.md: not sliced");
    expect(res.deleted.sort()).toEqual([".claude/rules/sql.md", "packages/api/AGENTS.md", "packages/api/AGENTS.override.md"]);
    void repo;
    w.close();
  });

  it("keeps imported files, makes pointer memories for non-markdown imports, and re-slices imports that change", async () => {
    const { repo, w, ins } = ingestWorld({
      "CLAUDE.md": "- Follow @docs/conventions.md for style.\n- The npm scripts are listed in @package.json.\n",
      "docs/conventions.md": "# Conventions\n- Functions must have doc comments.\n",
      "package.json": '{ "scripts": { "test": "vitest" } }\n',
    });
    const outside = join(tmp(), "team-handbook.md");
    writeFileSync(outside, "- Handbook rule: reviews must be answered within a day.\n");
    write(repo, "AGENTS.md", `- See @${outside} too.\n`);
    commitAll(repo);
    const out = io();
    const res = await ins.ingest({ io: out });
    expect(out.asked[0]).toContain(`AGENTS.md imports ${outside}. Read it?`); // outside the repo: confirmation first
    expect(res.deleted.sort()).toEqual(["AGENTS.md", "CLAUDE.md"]);
    expect(existsSync(join(repo, "docs/conventions.md"))).toBe(true); // imported files are never deleted
    expect(existsSync(join(repo, "package.json"))).toBe(true);
    expect(existsSync(outside)).toBe(true);
    const shared = w.graph.all(["shared"]).map((r) => r.node);
    const conv = shared.find((n) => n.text.includes("doc comments"))!;
    expect(conv.source!.file).toBe("docs/conventions.md"); // imported lines keep the imported file as their source
    const pointer = shared.find((n) => n.source?.file === "package.json")!;
    expect(pointer.text).toBe("- The npm scripts are listed in package.json.");
    expect(w.paths.displayAnchors({ scope: "shared", node: pointer }).map((a) => a.at)).toEqual(["package.json"]);
    // a shared file's import from outside the repo goes to Project Personal
    expect(w.graph.all(["personal"]).map((r) => r.node.text)).toEqual(["Handbook rule: reviews must be answered within a day."]);
    expect(shared.find((n) => n.text.startsWith("See @"))!.sensitivity).toBe("normal"); // a temp-dir path is not a secret
    expect(w.graph.sd("shared").sources().map((s) => [s.file, s.mode]).sort()).toEqual([["AGENTS.md", "ingested"], ["CLAUDE.md", "ingested"], ["docs/conventions.md", "import"], ["package.json", "pointer"]]);
    // the importing file is gone, so realctx2 stands in for the import: a changed file is re-sliced
    expect(ins.changedImports()).toEqual([]);
    write(repo, "docs/conventions.md", "# Conventions\n- Functions must have doc comments.\n- Modules must have a README.\n");
    expect(ins.changedImports().map((f) => f.display)).toEqual(["docs/conventions.md"]);
    expect(await ins.resliceImports()).toBe(1);
    const after = w.graph.active(["shared"]).map((r) => r.node.text);
    expect(after).toEqual(expect.arrayContaining(["Functions must have doc comments.", "Modules must have a README."]));
    expect(after.filter((t) => t.includes("doc comments")).length).toBe(1);
    expect(ins.changedImports()).toEqual([]);
    w.close();
  });

  it("re-ingests a file that reappears: unchanged sections are kept, changed ones replaced", async () => {
    const { repo, w, ins } = ingestWorld({ "AGENTS.md": ROOT_AGENTS });
    await ins.ingest({ io: io() });
    commitAll(repo, "ingested");
    const before = new Map(w.graph.active(["shared"]).map((r) => [r.node.text, r.node.id]));
    expect(ins.reappeared()).toEqual([]);
    // a teammate without realctx2 brings the file back, with one section edited
    write(repo, "AGENTS.md", ROOT_AGENTS.replace("- You should prefer small migrations.", "- You should prefer small, reversible migrations.\n- Migrations must be reviewed."));
    expect(ins.reappeared().map((f) => f.display)).toEqual(["AGENTS.md"]);
    const calls: AuxTask[] = [];
    w.aux.on("ingest.slicer", fakeSlicer({ calls }));
    const out = io();
    const res = await ins.ingest({ io: out, paths: ["AGENTS.md"] });
    expect(out.out[0]).toContain("2 unchanged section(s)");
    const now = new Map(w.graph.active(["shared"]).map((r) => [r.node.text, r.node.id]));
    // the Build section did not change: same nodes, same IDs
    expect(now.get("Always use pnpm; never use npm.")).toBe(before.get("Always use pnpm; never use npm."));
    expect([...now.keys()].sort()).toEqual(["Always use pnpm; never use npm.", "Migrations must be reviewed.", "Never run `prisma migrate reset`; the dev database is shared.", "The API lives in packages/api.", "You should prefer small, reversible migrations."].sort());
    expect(res.retired.length).toBe(2); // the old Database items were replaced
    expect(existsSync(join(repo, "AGENTS.md"))).toBe(false); // and the file is deleted again
    w.close();
  });

  it("merges duplicated learned memories into the item and flags contradicting ones", async () => {
    const { w, ins } = ingestWorld({ "AGENTS.md": "- Always use pnpm; never use npm.\n- Tests must run with --runInBand.\n" }, { embeddings: "dense" });
    const writer = new MemoryWriter(w);
    const [dup, contra] = await writer.write([
      { text: "Always use pnpm; never use npm.", origin: "harvest", scope: "shared", urgency: "caption", skipConflicts: true },
      { text: "Tests must run without --runInBand.", origin: "harvest", scope: "shared", urgency: "caption", skipConflicts: true },
    ]);
    w.graph.sd("shared").incCounter(dup!.id!, "used", 3);
    w.graph.commit("shared");
    w.decision.on("write.conflict", (_e, qs) => Object.fromEntries(qs.map((q) => [q.name, { contradictory: 0.9, compatible: 0.05 }])));
    const res = await ins.ingest({ io: io() });
    expect(res.merged).toEqual([dup!.id]);
    expect(res.conflicts).toEqual([contra!.id]);
    const item = w.graph.active(["shared"]).find((r) => r.node.origin === "instructions" && r.node.text.includes("pnpm"))!;
    expect(item.node.counters.used).toBe(3); // provenance and use counters are kept
    expect(w.graph.get(dup!.id!)!.node).toMatchObject({ status: "archived", statusReason: `merged into instruction m:${item.node.id}` });
    // the instruction wins in delivery until the user reviews the conflict
    expect(w.graph.get(contra!.id!)!.node.flags).toContain("conflicts-instruction");
    const d = new PathDelivery(w);
    const shown = d.consider({ action: "read", paths: ["src/x.ts"] }).map((c) => c.ref.node.id);
    expect(shown).not.toContain(contra!.id);
    w.close();
  });

  it("exports AGENTS.md files that it never ingests again", async () => {
    const { repo, w, ins } = ingestWorld({ "AGENTS.md": ROOT_AGENTS, "packages/api/AGENTS.md": "- API handlers must stay thin.\n" });
    write(repo, "packages/api/src/index.ts", "export {}\n");
    await ins.ingest({ io: io() });
    const written = ins.exportAgents();
    expect(written).toEqual(["AGENTS.md", "packages/api/AGENTS.md"]);
    const root = readFileSync(join(repo, "AGENTS.md"), "utf8");
    expect(root).toContain(GENERATED_MARK);
    expect(root).toContain("- **MUST** Never run `prisma migrate reset`; the dev database is shared.");
    expect(readFileSync(join(repo, "packages/api/AGENTS.md"), "utf8")).toContain("- **MUST** API handlers must stay thin.");
    expect(ins.reappeared()).toEqual([]); // generated files are not "reappeared" instruction files
    const out = io();
    const res = await ins.ingest({ io: out });
    expect(res.stored).toEqual([]);
    expect(out.out[0]).toContain("generated by realctx2: never re-ingested");
    expect(existsSync(join(repo, "AGENTS.md"))).toBe(true);
    expect(ins.shouldIgnore(join(repo, "AGENTS.md"))).toBe(true); // still ignored for loading: memory is the source of truth
    w.close();
  });

  it("ingests home-directory files into Global only on request, with a backup", async () => {
    const { w, ins } = ingestWorld({ "README.md": "# r\n" });
    mkdirSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true });
    mkdirSync(join(process.env.CLAUDE_CONFIG_DIR!, "rules"), { recursive: true });
    writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "AGENTS.md"), "- Always answer in British English.\n");
    writeFileSync(join(process.env.CLAUDE_CONFIG_DIR!, "rules", "go.md"), "---\npaths: \"**/*.go\"\n---\n- Go code must be formatted with gofumpt.\n");
    expect(ins.discover().map((f) => f.display)).toEqual([]);
    const res = await ins.ingest({ io: io(), include: ["global"] });
    expect(res.stored.map((s) => s.scope)).toEqual(["global", "global"]);
    expect(res.backedUp.length).toBe(2);
    expect(existsSync(join(process.env.PI_CODING_AGENT_DIR!, "AGENTS.md"))).toBe(false);
    const go = w.graph.all(["global"]).find((r) => r.node.text.includes("gofumpt"))!;
    expect(go.node.anchors.map((a) => a.glob)).toEqual(["**/*.go"]);
    expect(ins.shouldIgnore(join(process.env.PI_CODING_AGENT_DIR!, "AGENTS.md"))).toBe(true);
    expect(new PathDelivery(w).projectRules().text).toContain("Always answer in British English.");
    w.close();
  });

  it("imports Claude Code auto-memory notes as unpinned short-term memories, then backs them up and deletes them", async () => {
    const { repo, w, ins } = ingestWorld({ "README.md": "# r\n" });
    const dir = join(process.env.CLAUDE_CONFIG_DIR!, "projects", repo.replace(/[^A-Za-z0-9]/g, "-"), "memory");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "MEMORY.md"), "# Memory\n- The user prefers tabs over spaces everywhere.\n- This repo's tests need Docker running.\n");
    writeFileSync(join(dir, "debugging.md"), "- The flaky test is fixed by awaiting navigation.\n");
    w.decision.on("write.route", (ev, qs) => Object.fromEntries(qs.map((q): [string, number | Record<string, number>] => {
      const text = ev.memories.find((m: { id: string }) => m.id === q.name.split(".")[1]).text as string;
      if (q.name.startsWith("scope.")) return [q.name, text.includes("tabs") ? { global: 0.9 } : { project_personal: 0.9 }];
      if (q.name.startsWith("urgency.")) return [q.name, { caption: 0.9 }];
      return [q.name, 0.01];
    })));
    expect(ins.autoMemoryDir()).toBe(dir);
    const res = await ins.importAutoMemory();
    expect(res).toMatchObject({ files: 2, items: 3 });
    expect(listTree(res.backupDir!).sort()).toEqual(["MEMORY.md", "debugging.md"]);
    expect(listTree(dir)).toEqual([]);
    const all = w.graph.all();
    expect(all.map((r) => [r.scope, r.node.origin, r.node.pinned, r.node.layer]).sort()).toEqual([["global", "auto-memory", false, "short"], ["personal", "auto-memory", false, "short"], ["personal", "auto-memory", false, "short"]]);
    expect(await ins.importAutoMemory()).toMatchObject({ files: 0 });
    w.close();
  });
});

describe("re-verification (§6.8.6)", () => {
  const CODE = "export class TokenCache {\n  private pending = null;\n  async refresh() {\n    if (!this.pending) this.pending = fetchToken();\n    return this.pending;\n  }\n}\n";
  async function setup(over: Parameters<typeof world>[0] = {}) {
    const repo = initRepo();
    write(repo, "src/auth/tokenCache.ts", CODE);
    commitAll(repo);
    const w = world({ cwd: repo, cfg: { reverify: { settleMinutes: 0 } }, ...over });
    const writer = new MemoryWriter(w);
    const lifecycle = new Lifecycle(w);
    const rv = new Reverifier(w, { writer, lifecycle, review: new ReviewQueue(w.layout.queueDir) });
    const add = async (text: string, extra: Record<string, unknown> = {}) => {
      const [r] = await writer.write([{ text, origin: "harvest", scope: "personal", urgency: "hint", paths: ["src/auth/tokenCache.ts"], skipConflicts: true, skipDedup: true, sourceTexts: [CODE], ...extra }]);
      return r!.id!;
    };
    const edit = (content: string) => {
      write(repo, "src/auth/tokenCache.ts", content);
      w.paths.noteWrite("src/auth/tokenCache.ts");
      w.graph.commit("personal");
      w.graph.commit("shared");
    };
    return { repo, w, rv, add, edit };
  }

  it("ends most checks without a model: quotes and symbols are still there", async () => {
    const t = await setup();
    const quoted = await t.add("TokenCache.refresh is single-flight.", { evidence: [{ quote: "if (!this.pending) this.pending = fetchToken();", source: { type: "file", ref: "src/auth/tokenCache.ts:4" } }] });
    expect((await t.rv.run()).files).toBe(0); // nothing changed yet
    t.edit(CODE.replace("export class", "// reviewed\nexport class"));
    expect(t.w.paths.covering("src/auth/tokenCache.ts")[0]!.changed).toBe(true); // ⚠ file changed since
    const report = await t.rv.run();
    expect(report).toMatchObject({ files: 1, holdsModelFree: [quoted], auxSessions: 0 });
    const n = t.w.graph.get(quoted)!.node;
    expect(n.verifiedAt).toBe(t.w.clock().toISOString());
    expect(t.w.paths.covering("src/auth/tokenCache.ts")[0]!.changed).toBe(false); // the flag goes away
    expect((await t.rv.run()).files).toBe(0);
    t.w.close();
  });

  it("asks one aux session per file for the rest and applies each verdict", async () => {
    const t = await setup();
    const holds = await t.add("The cache keeps one pending promise.", { evidence: [{ quote: "private pending = null;", source: { type: "file", ref: "src/auth/tokenCache.ts:2" } }] });
    const changed = await t.add("refresh() calls fetchToken() to get a token.", { evidence: [{ quote: "this.pending = fetchToken();", source: { type: "file", ref: "src/auth/tokenCache.ts:4" } }] });
    const obsolete = await t.add("refresh() returns the pending promise.", { evidence: [{ quote: "return this.pending;", source: { type: "file", ref: "src/auth/tokenCache.ts:5" } }] });
    const unclear = await t.add("The cache is thread-safe by design.", {});
    t.w.graph.sd("personal").incCounter(changed, "used", 2);
    const NEW = "export class TokenCache {\n  private pending = null;\n  async refresh() {\n    if (!this.pending) this.pending = requestToken({ retries: 3 });\n    return await this.pending.finally(() => (this.pending = null));\n  }\n}\n";
    t.edit(NEW);
    let prompt = "";
    t.w.aux.on("reverify", (task) => {
      prompt = task.data.map((d) => `${d.label}\n${d.text}`).join("\n");
      return {
        verdicts: [
          { id: changed, verdict: "changed", evidence: [{ path: "src/auth/tokenCache.ts", lines: "4", quote: "this.pending = requestToken({ retries: 3 });" }], replacement: { title: "refresh requests a token with retries", text: "refresh() calls requestToken({ retries: 3 }) to get a token." } },
          { id: `[m:${obsolete}]`, verdict: "obsolete", evidence: [{ path: "src/auth/tokenCache.ts", quote: "return await this.pending.finally(() => (this.pending = null));" }] },
          { id: unclear, verdict: "changed", evidence: [{ path: "src/auth/tokenCache.ts", quote: "this quote is not in the file" }], replacement: { text: "Invented." } },
        ],
      };
    });
    t.w.decision.on("evo.check", () => ({ valid: 0.9 }));
    const report = await t.rv.run();
    expect(report.holdsModelFree).toEqual([holds]);
    expect(report.auxSessions).toBe(1);
    expect(prompt).toContain(`MEMORY ${changed}`);
    expect(prompt).toContain("DIFF of src/auth/tokenCache.ts since the verified version");
    expect(prompt).toContain("+    if (!this.pending) this.pending = requestToken({ retries: 3 });");
    expect(prompt).not.toContain(`MEMORY ${holds}`);
    // changed: the replacement supersedes the old memory, whose history stays available
    expect(report.changed.map((c) => c.id)).toEqual([changed]);
    const next = t.w.graph.get(report.changed[0]!.replacement)!;
    expect(next.node.text).toBe("refresh() calls requestToken({ retries: 3 }) to get a token.");
    expect(next.node.evidence[0]).toMatchObject({ verified: true, source: { ref: "src/auth/tokenCache.ts:4" } });
    expect(next.node.counters.used).toBe(2);
    expect(t.w.graph.supersededBy(t.w.graph.get(changed)!)!.node.id).toBe(next.node.id);
    expect(t.w.graph.get(changed)!.node.validTo).toBeDefined();
    // obsolete: retired with the evidence as the reason (reversible)
    expect(report.obsolete).toEqual([obsolete]);
    expect(t.w.graph.get(obsolete)!.node).toMatchObject({ status: "archived" });
    expect(t.w.graph.get(obsolete)!.node.statusReason).toContain("obsolete per src/auth/tokenCache.ts");
    // a verdict whose evidence cannot be verified counts as unclear: flag kept, retried only after the next change
    expect(report.unclear).toEqual([unclear]);
    expect(t.w.graph.get(unclear)!.node.status).toBe("active");
    expect((await t.rv.run()).auxSessions).toBe(0);
    t.edit(NEW + "// again\n");
    expect((await t.rv.run()).auxSessions).toBe(1);
    t.w.close();
  });

  it("applies rule changes automatically only when they are mechanical; the rest go to review", async () => {
    expect(mechanicalChange("Run `pnpm db:generate` after editing prisma/schema.prisma.", "Run `pnpm db:codegen` after editing db/schema.prisma.")).toBe(true);
    expect(mechanicalChange("Call TokenCache.refresh before each request.", "Call TokenStore.renew before each request.")).toBe(true);
    expect(mechanicalChange("Never edit generated files.", "Generated files may be edited after review.")).toBe(false);
    expect(mechanicalChange("Run the linter.", "Run the linter.")).toBe(false);
    const t = await setup();
    const mech = await t.add("Callers must use TokenCache.refresh, never fetchToken directly.", { kind: "rule", severity: "must" });
    const deep = await t.add("The pending field must never be reset outside refresh.", { kind: "rule", severity: "must" });
    const gone = await t.add("Callers must await TokenCache.warmup at startup.", { kind: "rule", severity: "should" });
    const NEW = CODE.replace(/fetchToken/g, "requestToken").replace("return this.pending;", "return this.pending.finally(() => (this.pending = null));");
    t.edit(NEW);
    t.w.aux.on("reverify", () => ({
      verdicts: [
        { id: mech, verdict: "changed", evidence: [{ path: "src/auth/tokenCache.ts", quote: "this.pending = requestToken();" }], replacement: { text: "Callers must use TokenCache.refresh, never requestToken directly." } },
        { id: deep, verdict: "changed", evidence: [{ path: "src/auth/tokenCache.ts", quote: "this.pending.finally(() => (this.pending = null))" }], replacement: { text: "refresh resets the pending field itself once the token arrives; nothing else may." } },
        { id: gone, verdict: "obsolete", evidence: [{ path: "src/auth/tokenCache.ts", quote: "async refresh() {" }] },
      ],
    }));
    t.w.decision.on("evo.check", () => ({ valid: 0.9 }));
    const report = await t.rv.run();
    expect(report.changed.map((c) => c.id)).toEqual([mech]);
    expect(report.review.sort()).toEqual([deep, gone].sort());
    expect(t.w.graph.get(deep)!.node.flags).toContain("review");
    expect(t.w.graph.get(gone)!.node.status).toBe("active"); // rules are never retired without review
    expect(t.rv.review.list().map((r) => [r.id, r.kind]).sort()).toEqual([[deep, "rule-change"], [gone, "rule-obsolete"]].sort());
    expect(t.rv.review.list().find((r) => r.id === deep)!.suggestion!.text).toContain("resets the pending field itself");
    t.w.close();
  });

  it("checks shared memories against HEAD and waits while the working copy differs", async () => {
    const t = await setup();
    const id = await t.add("TokenCache.refresh is single-flight.", { scope: "shared", evidence: [{ quote: "if (!this.pending) this.pending = fetchToken();", source: { type: "file", ref: "src/auth/tokenCache.ts:4" } }] });
    t.edit(CODE.replace("fetchToken", "requestToken"));
    let report = await t.rv.run();
    expect(report.waiting).toEqual(["src/auth/tokenCache.ts"]); // uncommitted work never rewrites team memory
    expect(report.files).toBe(0);
    git(t.repo, "checkout", "--", "src/auth/tokenCache.ts"); // the experiment is thrown away
    t.w.paths.noteWrite("src/auth/tokenCache.ts");
    report = await t.rv.run();
    expect(report.files).toBe(0);
    // a committed change is checked
    t.edit(CODE.replace("export class", "// v2\nexport class"));
    commitAll(t.repo, "comment");
    report = await t.rv.run();
    expect(report.holdsModelFree).toEqual([id]);
    t.w.close();
  });

  it("lets a burst of edits settle, honours the daily cap, and can be switched off", async () => {
    const t = await setup({ cfg: { reverify: { settleMinutes: 10, maxPerDay: 1 } } });
    await t.add("An unquoted claim about the cache.", {});
    t.w.now.t = Date.now(); // settling compares against the file's real modification time
    t.edit(CODE + "// a\n");
    expect((await t.rv.run()).waiting).toEqual(["src/auth/tokenCache.ts"]);
    t.w.aux.on("reverify", () => ({ verdicts: [] }));
    expect((await t.rv.run({ sessionEnding: true })).auxSessions).toBe(1); // …or until the session ends
    t.edit(CODE + "// b\n");
    expect((await t.rv.run({ sessionEnding: true })).auxSessions).toBe(0); // daily cap reached
    t.w.cfg.reverify.enabled = false;
    expect((await t.rv.run({ sessionEnding: true })).files).toBe(0);
    t.w.close();
  });
});
