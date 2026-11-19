import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Retriever } from "../src/memory/retrieve.ts";
import { strengthAt } from "../src/memory/strength.ts";
import { MemoryWriter } from "../src/memory/write.ts";
import { FakeDecision, world } from "./helpers/fakes.ts";
import { cleanupTmp, commitAll, initRepo, treeContains, write } from "./helpers/fixtures.ts";

afterAll(cleanupTmp);

const route = (scope: string, urgency = "caption", sensitive = 0) => (_e: unknown, qs: Array<{ name: string }>) => {
  const out: Record<string, number | Record<string, number>> = {};
  for (const q of qs) {
    if (q.name.startsWith("scope.")) out[q.name] = { [scope]: 0.9, discard: 0.02 };
    if (q.name.startsWith("sensitive.")) out[q.name] = sensitive;
    if (q.name.startsWith("urgency.")) out[q.name] = { [urgency]: 0.8 };
  }
  return out;
};

describe("write path (§6.3)", () => {
  it("normalizes, verifies evidence, extracts a signature and anchors, and routes by the decision model", async () => {
    const repo = initRepo();
    write(repo, "src/auth/tokenCache.ts", "export class TokenCache {\n  async refresh() {\n    if (!this.pending) this.pending = fetchToken()\n    return this.pending;\n  }\n}\n");
    commitAll(repo);
    const w = world({ cwd: repo });
    w.decision.on("write.route", route("project_shared", "hint"));
    const writer = new MemoryWriter(w);
    const [r] = await writer.write([
      {
        text: "TokenCache.refresh must be single-flight; concurrent refreshes race on `pending` in src/auth/tokenCache.ts.",
        origin: "harvest",
        evidence: [
          { quote: "if (!this.pending)   this.pending = fetchToken()", source: { type: "file", ref: "src/auth/tokenCache.ts:3" } },
          { quote: "this line is not in the source", source: { type: "session", ref: "t:c7f3a2e8" } },
        ],
        sourceTexts: ["    if (!this.pending) this.pending = fetchToken()\n    return this.pending;"],
      },
    ]);
    expect(r).toMatchObject({ status: "created", scope: "shared", urgency: "hint", sensitivity: "normal" });
    const n = w.graph.get(r!.id!)!.node;
    expect(n.layer).toBe("short");
    expect(n.pinned).toBe(false);
    expect(strengthAt(n, w.clock())).toBeCloseTo(0.6);
    expect(n.urgencyBy).toBe("decision");
    expect(Object.fromEntries(n.evidence.map((e) => [e.source.type, e.verified]))).toEqual({ file: true, session: false }); // unverified quotes are kept, marked
    expect(n.signature).toEqual(expect.arrayContaining(["pending", "src/auth/tokenCache.ts", "TokenCache.refresh"]));
    expect(n.title.split(/\s+/).length).toBeLessThanOrEqual(15);
    // the repo path in the signature became an `about` anchor, upgraded to a symbol anchor
    expect(w.paths.displayAnchors({ scope: "shared", node: n }).map((a) => [a.anchor.kind, a.anchor.role, a.at])).toEqual([["symbol", "about", "src/auth/tokenCache.ts#TokenCache.refresh"]]);
    expect(n.provenance).toMatchObject({ actor: "actor-test", sessionId: "sess-test" });
    // shared writes are held in the journal until the flush, then land in the repo
    expect(treeContains(repo, "single-flight")).toEqual([]);
    w.graph.flush();
    expect(treeContains(join(repo, ".pi"), "single-flight").length).toBe(1);
    w.close();
  });

  it("applies the routing rules in order", async () => {
    const repo = initRepo();
    const w = world({ cwd: repo });
    const writer = new MemoryWriter(w);
    const probs: Record<string, Record<string, number>> = {
      "worth nothing at all": { discard: 0.7, project_personal: 0.3 },
      "team convention about commits": { project_shared: 0.9, global: 0.05 },
      "almost shared but not confident": { project_shared: 0.8, project_personal: 0.2 },
      "user likes terse answers everywhere": { global: 0.8, project_personal: 0.2 },
      "global-looking but names src/app/main.ts": { global: 0.8, project_personal: 0.2 },
      "shared-looking but sensitive": { project_shared: 0.95 },
    };
    w.decision.on("write.route", (ev, qs) => {
      const out: Record<string, number | Record<string, number>> = {};
      for (const q of qs) {
        const id = q.name.split(".")[1]!;
        const text = ev.memories.find((m: { id: string }) => m.id === id).text as string;
        if (q.name.startsWith("scope.")) out[q.name] = probs[text]!;
        if (q.name.startsWith("sensitive.")) out[q.name] = text.includes("sensitive") ? 0.5 : 0.01;
      }
      return out;
    });
    const res = await writer.write(Object.keys(probs).map((text) => ({ text, origin: "harvest" as const })));
    expect(res.map((r) => [r.status, r.scope])).toEqual([
      ["discarded", undefined],
      ["created", "shared"],
      ["created", "personal"],
      ["created", "global"],
      ["created", "personal"], // repo paths never go global
      ["created", "personal"], // P(sensitive) ≥ 0.2 blocks shared
    ]);
    expect(res[5]!.sensitivity).toBe("personal");
    // one decision request covered the whole batch
    expect(w.decision.sites().filter((s) => s === "write.route").length).toBe(1);
    // episodes stay personal unless the shared rule fires
    w.decision.on("write.route", route("global"));
    const [ep] = await writer.write([{ text: "Fixed the flaky checkout test by awaiting navigation.", kind: "episode", origin: "harvest" }]);
    expect(ep!.scope).toBe("personal");
    // uncalibrated answers face the stricter shared threshold (0.95)
    w.decision.isCalibrated = false;
    w.decision.on("write.route", (_e, qs) => Object.fromEntries(qs.map((q): [string, number | Record<string, number>] => [q.name, q.name.startsWith("scope.") ? { project_shared: 0.9 } : q.name.startsWith("urgency.") ? { caption: 0.9 } : 0.0])));
    const [unc] = await writer.write([{ text: "emulated answers are held to a higher bar", origin: "harvest" }]);
    expect(unc!.scope).toBe("personal");
    w.close();
  });

  it("falls back to Project Personal, and to Global outside any project, without a decision model", async () => {
    const repo = initRepo();
    const decision = new FakeDecision();
    decision.isAvailable = false;
    const w = world({ cwd: repo, decision });
    const writer = new MemoryWriter(w);
    const [a, b, c] = await writer.write([
      { text: "A rule: always run the linter before committing.", kind: "rule", severity: "must", origin: "harvest" },
      { text: "The staging database lives at db.internal port 5433.", origin: "harvest" },
      { text: "We fixed the build.", kind: "episode", origin: "harvest" },
    ]);
    expect([a!.scope, b!.scope, c!.scope]).toEqual(["personal", "personal", "personal"]);
    expect([a!.urgency, b!.urgency, c!.urgency]).toEqual(["hint", "caption", "passive"]); // fail-safe urgency
    expect(w.graph.get(a!.id!)!.node.urgencyBy).toBe("default");
    w.close();
  });

  it("redacts secrets in every scope and never routes personal-sensitivity memories to shared", async () => {
    const repo = initRepo();
    const w = world({ cwd: repo });
    w.decision.on("write.route", route("project_shared"));
    const writer = new MemoryWriter(w);
    const key = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const [r, named] = await writer.write([
      { text: `The deploy token is ${key}; rotate it monthly.`, origin: "harvest", evidence: [{ quote: `token: "${key}"`, source: { type: "session", ref: "x" } }] },
      { text: `CI uses ${key} for publishing.`, origin: "explicit", scope: "shared" },
    ]);
    expect(r).toMatchObject({ status: "created", scope: "personal", redacted: true, sensitivity: "personal" });
    expect(named).toMatchObject({ status: "created", scope: "personal", reroutedFrom: "shared" });
    const n = w.graph.get(r!.id!)!.node;
    expect(n.text).toContain("[secret:redacted]");
    expect(n.text).not.toContain(key);
    expect(JSON.stringify(n.evidence)).not.toContain(key);
    w.graph.flush({ force: true });
    w.close();
    expect(treeContains(w.home, key)).toEqual([]);
    expect(treeContains(repo, key)).toEqual([]);
  });

  it("uses the scope and urgency the main model names, and asks only what is still needed", async () => {
    const repo = initRepo();
    write(repo, "packages/api/prisma/schema.prisma", "model User { id Int @id }\n");
    const w = world({ cwd: repo });
    const writer = new MemoryWriter(w);
    const [r] = await writer.write([
      { text: "Never run `prisma migrate reset`; the dev database is shared.", kind: "rule", severity: "must", origin: "explicit", scope: "shared", urgency: "immediate", commands: ["prisma migrate reset*", "pnpm  prisma migrate reset*"], paths: ["packages/api/prisma/schema.prisma", "packages/api/migrations/**"] },
    ]);
    expect(w.decision.sites()).toEqual([]); // nothing left to ask
    const n = w.graph.get(r!.id!)!.node;
    expect(r).toMatchObject({ scope: "shared", urgency: "immediate" });
    // unpinned explicit memories start in the short-term layer, at 0.8, and have to earn the long-term one
    expect(n).toMatchObject({ layer: "short", pinned: false, urgencyBy: "agent", severity: "must" });
    expect(strengthAt(n, w.clock())).toBeCloseTo(0.8);
    expect(n.triggers).toEqual({ on: ["command"], commands: ["prisma migrate reset*", "pnpm prisma migrate reset*"] });
    expect(n.anchors.map((a) => `${a.kind}:${a.role}`).sort()).toEqual(["file:applies", "glob:applies"]);
    // `immediate` needs a trigger: without one it is capped at hint
    const [capped] = await writer.write([{ text: "Be careful around the billing module in general.", kind: "rule", origin: "explicit", scope: "personal", urgency: "immediate" }]);
    expect(capped!.urgency).toBe("hint");
    // only urgency is asked when the scope is given
    w.decision.on("write.route", route("global", "passive"));
    await writer.write([{ text: "The office wifi is slow on Fridays.", origin: "explicit", scope: "personal" }]);
    expect(w.decision.calls.at(-1)!.questions.map((q) => q.name)).toEqual(["urgency.c0"]);
    // a pinned memory starts in the long-term layer at full strength and never decays
    const [pinned] = await writer.write([{ text: "Always answer in British English.", kind: "preference", origin: "explicit", scope: "global", urgency: "hint", pin: true }]);
    const p = w.graph.get(pinned!.id!)!.node;
    expect(p).toMatchObject({ pinned: true, layer: "long" });
    w.now.t += 400 * 86_400_000;
    expect(strengthAt(p, w.clock())).toBe(1);
    w.close();
  });

  it("de-duplicates into an existing node: evidence, reinforcement, revival of dormant nodes", async () => {
    for (const embeddings of ["none", "dense", "both"] as const) {
      const repo = initRepo();
      const w = world({ cwd: repo, embeddings });
      if (embeddings === "both") await w.sim.calibrate();
      w.decision.on("write.route", route("project_personal"));
      const writer = new MemoryWriter(w);
      const [first] = await writer.write([{ text: "Run `pnpm db:generate` after editing prisma/schema.prisma.", kind: "procedure", origin: "harvest", evidence: [{ quote: "pnpm db:generate", source: { type: "tool", ref: "bash" } }] }]);
      w.now.t += 86_400_000;
      const before = strengthAt(w.graph.get(first!.id!)!.node, w.clock());
      const [second] = await writer.write([{ text: "Run `pnpm db:generate` after editing  prisma/schema.prisma!", kind: "procedure", origin: "harvest", evidence: [{ quote: "after editing prisma/schema.prisma", source: { type: "session", ref: "t:aaaaaaaa" } }] }]);
      expect(second, embeddings).toMatchObject({ status: "merged", id: first!.id });
      const n = w.graph.get(first!.id!)!.node;
      expect(n.evidence.length).toBe(2);
      expect(n.strength.events.filter((e) => e.kind === "reinforce").length).toBe(1);
      expect(strengthAt(n, w.clock())).toBeGreaterThan(before);
      expect(n.lastAccessAt).toBe(w.clock().toISOString());
      // a different kind is not a duplicate
      const [other] = await writer.write([{ text: "Run `pnpm db:generate` after editing prisma/schema.prisma.", kind: "episode", origin: "harvest", skipConflicts: true }]);
      expect(other!.status).toBe("created");
      // a dormant node revives on an exact content match
      w.graph.sd("personal").patchNode(first!.id!, { status: "dormant", statusReason: "forgetting" });
      w.graph.commit("personal");
      w.graph.syncIndex("personal");
      const [third] = await writer.write([{ text: "Run `pnpm db:generate` after editing prisma/schema.prisma.", kind: "procedure", origin: "harvest" }]);
      expect(third).toMatchObject({ status: "merged", id: first!.id });
      expect(w.graph.get(first!.id!)!.node.status).toBe("active");
      w.close();
    }
  });

  it("resolves conflicts by class: supersede, contradict, subsume, subsumed, compatible", async () => {
    const repo = initRepo();
    const w = world({ cwd: repo, embeddings: "dense" });
    w.decision.on("write.route", route("project_personal"));
    const writer = new MemoryWriter(w);
    const rel = (kind: string, newer = 0.1) => w.decision.on("write.conflict", (_e, qs) => Object.fromEntries(qs.map((q): [string, number | Record<string, number>] => [q.name, q.name.startsWith("rel.") ? { [kind]: 0.9 } : q.name.startsWith("newer.") ? newer : 0.0])));
    const add = async (text: string, extra = {}) => (await writer.write([{ text, origin: "harvest", ...extra }]))[0]!;

    // contradictory + newer → supersedes, validTo, suppression, and the old node leaves retrieval
    const old = await add("The API server listens on port 3000 in development.");
    w.now.t += 20 * 86_400_000;
    rel("contradictory", 0.9);
    const next = await add("The API server listens on port 4000 in development.");
    expect(next).toMatchObject({ status: "created", superseded: [old.id] });
    const oldNode = w.graph.get(old.id!)!;
    expect(oldNode.node.validTo).toBe(w.graph.get(next.id!)!.node.validFrom);
    expect(oldNode.node.strength.events.some((e) => e.kind === "suppress")).toBe(true);
    expect(w.graph.supersededBy(oldNode)!.node.id).toBe(next.id);
    const r = new Retriever(w);
    expect((await r.retrieve("API server port development")).map((h) => h.ref.node.id)).toEqual([next.id]);
    expect((await r.retrieve("API server port development", { history: true })).map((h) => h.ref.node.id).sort()).toEqual([old.id, next.id].sort());

    // contradictory, not clearly newer → contradicts both ways; delivered together
    const a = await add("Integration tests need Docker running locally.", { skipConflicts: true });
    rel("contradictory", 0.3);
    const b = await add("Integration tests do not need Docker running locally.");
    expect(b).toMatchObject({ status: "created", conflicts: [a.id] });
    expect(w.graph.contradictions(w.graph.get(a.id!)!).map((x) => x.node.id)).toEqual([b.id]);
    expect(w.graph.contradictions(w.graph.get(b.id!)!).map((x) => x.node.id)).toEqual([a.id]);

    // subsumed → evidence merged into the existing node, no new node
    const general = await add("All services read configuration from environment variables via src/config.ts.", { skipConflicts: true });
    rel("subsumed");
    const narrow = await add("The billing services read configuration from environment variables via src/config.ts.", { evidence: [{ quote: "process.env.BILLING_URL", source: { type: "file", ref: "src/config.ts:9" } }] });
    expect(narrow).toMatchObject({ status: "merged", id: general.id });
    expect(w.graph.get(general.id!)!.node.evidence.length).toBe(1);

    // subsumes → aux merges the old node's unique content; the old node is archived as part-of
    const specific = await add("Deploys to staging need the VPN profile connected.", { skipConflicts: true });
    rel("subsumes");
    w.aux.on("write.merge", (task) => ({ title: "Deploys need the VPN", text: `Every deploy needs the corporate VPN; staging uses the profile \`corp-eu\`. (${task.data.length} notes)` }));
    const broad = await add("Deploys to staging and production need the VPN connected.");
    expect(broad).toMatchObject({ status: "created", subsumed: [specific.id] });
    expect(w.graph.get(broad.id!)!.node.text).toContain("corp-eu");
    expect(w.graph.get(specific.id!)!.node.status).toBe("archived");
    expect(w.graph.neighbors(w.graph.get(broad.id!)!).map((n) => [n.edge.rel, n.direction, n.other.node.id])).toEqual([["part-of", "in", specific.id]]);
    // without the aux LLM the merge is skipped and both stay
    w.aux.isAvailable = false;
    const s2 = await add("Linting uses the shared eslint preset from packages/eslint-config.", { skipConflicts: true });
    const b2 = await add("Linting and formatting use the shared eslint preset from packages/eslint-config.");
    expect(b2.subsumed).toBeUndefined();
    expect(w.graph.get(s2.id!)!.node.status).toBe("active");

    // no answer from the judge → insert, flagged for a re-check
    w.decision.on("write.conflict", () => ({}));
    const unjudged = await add("Linting and formatting both use the shared eslint preset from packages/eslint-config today.");
    expect(w.graph.get(unjudged.id!)!.node.flags).toEqual(["conflict-recheck"]);
    w.close();
  });

  it("never mutates a broader scope from a narrower one", async () => {
    const repo = initRepo();
    const w = world({ cwd: repo, embeddings: "dense" });
    const writer = new MemoryWriter(w);
    const [shared] = await writer.write([{ text: "The API server listens on port 3000 in development.", origin: "explicit", scope: "shared", urgency: "caption" }]);
    w.decision.on("write.conflict", (_e, qs) => Object.fromEntries(qs.map((q): [string, number | Record<string, number>] => [q.name, q.name.startsWith("rel.") ? { contradictory: 0.9 } : 0.95])));
    const [mine] = await writer.write([{ text: "The API server listens on port 3055 in development here.", origin: "explicit", scope: "personal", urgency: "caption" }]);
    expect(mine).toMatchObject({ status: "created", superseded: [shared!.id] });
    const sharedNode = w.graph.get(shared!.id!)!.node;
    expect(sharedNode.validTo).toBeUndefined();
    expect(sharedNode.strength.events).toEqual([]);
    // the edge lives in the personal document, pointing outward
    expect(w.graph.sd("shared").allEdges()).toEqual([]);
    expect(w.graph.sd("personal").allEdges().map((e) => [e.rel, e.dstScope])).toEqual([["supersedes", "shared"]]);
    // on this machine the personal fact wins in retrieval
    expect((await new Retriever(w).retrieve("API server port")).map((h) => h.ref.scope)).toEqual(["personal"]);
    w.close();
  });

  it("links episodes and their knowledge, and honours Palim's supersedes hint", async () => {
    const repo = initRepo();
    const w = world({ cwd: repo });
    w.decision.on("write.route", route("project_personal"));
    const writer = new MemoryWriter(w);
    const [e1] = await writer.write([{ text: "Investigated the login timeout; root cause was a missing index on sessions.user_id.", kind: "episode", origin: "harvest" }]);
    const [e2] = await writer.write([{ text: "Added the index and verified p95 login latency dropped to 40 ms.", kind: "episode", origin: "harvest", after: { scope: "personal", id: e1!.id! } }]);
    const [k] = await writer.write([{ text: "sessions.user_id needs an index; without it login queries scan the table.", origin: "harvest", evaluation: "good", episode: { scope: "personal", id: e2!.id! } }]);
    const edges = w.graph.sd("personal").allEdges().map((e) => `${e.src} ${e.rel} ${e.dst}`).sort();
    expect(edges).toEqual([`${e1!.id} precedes ${e2!.id}`, `${k!.id} derived-from ${e2!.id}`].sort());
    expect(w.graph.get(k!.id!)!.node.evaluation).toBe("good");
    const [old] = await writer.write([{ text: "The cache TTL for feature flags is 30 seconds.", origin: "harvest" }]);
    const [upd] = await writer.write([{ text: "Feature flags are now cached for 5 minutes.", origin: "harvest", validFrom: "2026-11-19T00:00:00.000Z", supersedesHint: "the cache TTL for feature flags is 30 seconds", skipConflicts: true }]);
    expect(upd!.superseded).toEqual([old!.id]);
    expect(w.graph.get(old!.id!)!.node.validTo).toBe("2026-11-19T00:00:00.000Z");
    w.close();
  });

  it("hides the shared scope in an untrusted project and outside a project", async () => {
    const repo = initRepo();
    const w = world({ cwd: repo });
    const [s] = await new MemoryWriter(w).write([{ text: "Shared architecture fact about the queue.", origin: "explicit", scope: "shared", urgency: "caption" }]);
    w.graph.flush();
    const untrusted = w.reopen({ trusted: false });
    expect(untrusted.graph.visible()).toEqual(["personal", "global"]);
    expect(untrusted.graph.get(s!.id!)).toBeNull();
    expect(untrusted.graph.sharedHidden).toMatch(/not trusted/);
    const [rerouted] = await new MemoryWriter(untrusted).write([{ text: "Wanted shared, but the project is untrusted.", origin: "explicit", scope: "shared", urgency: "caption" }]);
    expect(rerouted).toMatchObject({ scope: "personal", reroutedFrom: "shared" });
    untrusted.close();
    writeFileSync(join(repo, "marker"), "x");
  });
});
