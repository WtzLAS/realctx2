/**
 * Recall attribution (§5.5): for everything that entered context during a closed intent,
 * decide whether the main model actually used it. Deterministic signals first, then one
 * decision request per closed intent, counted softly.
 */
import type { Config } from "../core/config.ts";
import type { AttributionRecord, ConsolidationRecord, DecisionAnswer, DecisionClient, DecisionQuestion, Delivery, EntryView, Intent, IntentOutcome, MemoryNode, ScopedNode, ScopeName } from "../core/types.ts";
import type { SessionAccounting } from "../memory/accounting.ts";
import type { PathDelivery, PathEvent } from "../memory/delivery.ts";
import type { MemoryGraph } from "../memory/graph.ts";
import type { EvolutionLog } from "../memory/policy.ts";
import { TIMEOUTS } from "../memory/services.ts";
import { violationCounter } from "../memory/urgency.ts";
import { clipTokens } from "../util/text.ts";
import { renderSpan } from "./render.ts";
import type { SessionState } from "./state.ts";

export interface Signals {
  cited: boolean;
  signature_hit: boolean;
  expanded: boolean;
  restated: boolean;
}

export interface AttributionInput {
  /** Deliveries whose credit window closes now. */
  deliveries: Delivery[];
  entries: EntryView[];
  /** Entry index range of the credit window. */
  from: number;
  to: number;
  intent: Intent | null;
  /** Janus's closure outcome, when the window closes with an intent. */
  outcome?: IntentOutcome;
  state: SessionState;
  /** What the agent did in the window (paths touched, commands run), for unshown-rule checks. */
  actions: PathEvent[];
  signal?: AbortSignal;
  /** Skip the decision request (shutdown, or no time for it). */
  deterministicOnly?: boolean;
}

export interface AttributionResult {
  records: AttributionRecord[];
  outcome: "success" | "failure" | "mixed" | null;
  /** Consolidation records whose knowledge items were marked used. */
  updatedRecords: ConsolidationRecord[];
  complyChecked: number;
}

const USE_OPTIONS = [
  { value: "acted_on", description: "memory-specific content shaped an executed action or a stated decision" },
  { value: "referenced", description: "mentioned or weighed, no effect on actions" },
  { value: "ignored_relevant", description: "relevant to the work, but not used" },
  { value: "ignored_irrelevant", description: "not relevant to the work" },
  { value: "contradicted", description: "rejected, or acted against with a reason" },
  { value: "already_known", description: "restated something already visible" },
];

export class Attributor {
  private readonly cfg: Config;
  private readonly decision: DecisionClient;
  private readonly graph: MemoryGraph | null;
  private readonly delivery: PathDelivery | null;
  private readonly accounting: SessionAccounting | null;
  private readonly log: EvolutionLog | null;

  constructor(deps: { cfg: Config; decision: DecisionClient; graph?: MemoryGraph | null; delivery?: PathDelivery | null; accounting?: SessionAccounting | null; log?: EvolutionLog | null }) {
    this.cfg = deps.cfg;
    this.decision = deps.decision;
    this.graph = deps.graph ?? null;
    this.delivery = deps.delivery ?? null;
    this.accounting = deps.accounting ?? null;
    this.log = deps.log ?? null;
  }

  /** §5.5.3: signals computed before the decision request and passed to it as observations. */
  signals(d: Delivery, input: AttributionInput): Signals {
    const index = new Map(input.entries.map((e, i) => [e.id, i]));
    const at = index.get(d.entryId) ?? input.from - 1;
    const ids = new Set([d.id, ...(d.nodeIds ?? []).map((n) => `m:${n}`)]);
    let cited = false;
    let signatureHit = false;
    const terms = d.signature.filter((t) => t.length >= 4).map((t) => t.toLowerCase());
    for (let i = Math.max(input.from, at + 1); i < input.to; i++) {
      const e = input.entries[i]!;
      if (e.kind !== "assistant") continue;
      const text = e.rawText || e.text;
      for (const id of ids) if (text.includes(id)) cited = true;
      const calls = e.rawToolCalls ?? e.toolCalls;
      if (terms.length && calls?.length) {
        const args = calls.map((c) => JSON.stringify(c.args)).join(" ").toLowerCase();
        if (terms.some((t) => args.includes(t))) signatureHit = true;
      }
    }
    // a memory delivered because the agent touched its path would "hit" by construction: only later calls count
    const expanded = input.state.deliveries.some((o) => o.deliveryId !== d.deliveryId && (o.channel === "inspect" || o.channel === "recall") && (o.id === d.id || (d.nodeIds ?? []).some((n) => o.id === `m:${n}`)) && (index.get(o.entryId) ?? -1) > at);
    return { cited, signature_hit: signatureHit, expanded, restated: d.restatedRatio >= 0.6 };
  }

  private nodeOf(d: Delivery): ScopedNode | null {
    if (!this.graph || !d.nodeIds?.length) return null;
    const id = d.nodeIds[0]!;
    if (d.scope && this.graph.has(d.scope)) {
      const node = this.graph.getIn(d.scope, id);
      if (node) return { scope: d.scope, node };
    }
    return this.graph.get(id);
  }

  private textOf(d: Delivery, state: SessionState): string {
    const node = this.nodeOf(d);
    if (node) return `${node.node.title}\n${node.node.text}`;
    const rec = state.records.get(d.id);
    return rec?.text ?? d.id;
  }

  /** Rules whose compliance is checked: every rule shown, plus unshown caption/passive rules that match what the agent did (§6.10.4). */
  private rulesToCheck(input: AttributionInput): Array<{ ref: ScopedNode; shown: boolean }> {
    const out = new Map<string, { ref: ScopedNode; shown: boolean }>();
    for (const d of input.deliveries) {
      const ref = this.nodeOf(d);
      if (ref && (ref.node.kind === "rule" || ref.node.kind === "procedure") && d.channel !== "search" && d.channel !== "inspect") out.set(`${ref.scope}:${ref.node.id}`, { ref, shown: true });
    }
    if (this.delivery) {
      const unshown: Array<{ ref: ScopedNode; depth: number }> = [];
      for (const ev of input.actions) {
        if (ev.action !== "edit" && ev.action !== "command") continue;
        for (const c of this.delivery.consider(ev)) {
          const n = c.ref.node;
          if (n.kind !== "rule" && n.kind !== "procedure") continue;
          if (c.urgency !== "caption" && c.urgency !== "passive") continue;
          const k = `${c.ref.scope}:${n.id}`;
          if (out.has(k) || unshown.some((u) => u.ref.node.id === n.id)) continue;
          unshown.push({ ref: c.ref, depth: c.depth });
        }
      }
      // the most specific matches first
      for (const u of unshown.sort((a, b) => b.depth - a.depth).slice(0, this.cfg.urgency.maxUnshownChecks)) out.set(`${u.ref.scope}:${u.ref.node.id}`, { ref: u.ref, shown: false });
    }
    return [...out.values()];
  }

  async attribute(input: AttributionInput): Promise<AttributionResult> {
    const result: AttributionResult = { records: [], outcome: null, updatedRecords: [], complyChecked: 0 };
    const deliveries = input.deliveries.filter((d) => !d.subagent && !input.state.attributed.has(d.deliveryId));
    const rules = this.rulesToCheck({ ...input, deliveries });
    if (!deliveries.length && !rules.length) return result;
    const sig = new Map(deliveries.map((d) => [d.deliveryId, this.signals(d, input)]));
    const askOutcome = input.intent !== null && (input.outcome === undefined || input.outcome === "abandoned");
    let answers: Record<string, DecisionAnswer> = {};
    // uncalibrated (aux-emulated) answers are not used here: deterministic signals only (§9.1.4)
    if (!input.deterministicOnly && this.decision.available() && this.decision.calibrated()) {
      const questions: DecisionQuestion[] = [];
      deliveries.forEach((_, i) => {
        questions.push({ kind: "choice", name: `use.d${i}`, instructions: `What did the agent do with delivered item d${i}?`, options: USE_OPTIONS });
        questions.push({ kind: "score", name: `effect.d${i}`, instructions: `What effect did item d${i} have on the work?`, levels: [{ label: "harmful" }, { label: "no_effect" }, { label: "helpful" }] });
      });
      rules.forEach((_, k) => questions.push({ kind: "choice", name: `comply.k${k}`, instructions: `Did the agent's actions in this excerpt comply with rule k${k}?`, options: [{ value: "complied" }, { value: "violated" }, { value: "not_applicable", description: "the rule did not apply to what the agent did" }] }));
      if (askOutcome) questions.push({ kind: "choice", name: "outcome", instructions: "How did this piece of work end?", options: [{ value: "success" }, { value: "failure" }, { value: "mixed" }] });
      const evidence = {
        purpose: input.intent ? { label: input.intent.label, done_when: input.intent.success } : null,
        delivered: deliveries.map((d, i) => ({ d: `d${i}`, id: d.id, via: d.channel, text: clipTokens(this.textOf(d, input.state), 300), observed: sig.get(d.deliveryId) })),
        rules: rules.map((r, k) => ({ k: `k${k}`, text: clipTokens(r.ref.node.text, 200), shown_to_agent: r.shown })),
        // the stable description first, the long excerpt last
        excerpt: renderSpan(input.entries, input.from, input.to, { toolOutputTokens: 200, maxTokens: 12_000 }),
      };
      if (questions.length) answers = await this.decision.decide(evidence, questions, { callSite: "attribution", timeoutMs: TIMEOUTS.attribution, signal: input.signal });
    }
    // outcome: Janus's, unless it was `abandoned` or unclear
    let outcome: "success" | "failure" | "mixed" | null = input.outcome === "success" || input.outcome === "failure" ? input.outcome : null;
    const op = answers.outcome?.kind === "choice" ? answers.outcome.probs : undefined;
    if (askOutcome && op) outcome = (["success", "failure", "mixed"] as const).map((o) => [o, op[o] ?? 0] as const).sort((a, b) => b[1] - a[1])[0]![0];
    result.outcome = outcome;

    const usedScopes = new Map<ScopeName, number>();
    deliveries.forEach((d, i) => {
      const s = sig.get(d.deliveryId)!;
      const ua = answers[`use.d${i}`];
      const probs = ua?.kind === "choice" && ua.probs ? ua.probs : null;
      let u: number;
      let use: Record<string, number>;
      if (probs) {
        // calibrated probabilities are counted directly instead of taking the argmax
        u = (probs.acted_on ?? 0) + 0.5 * (probs.referenced ?? 0);
        if (s.cited || s.signature_hit) u = Math.max(u, 0.5); // deterministic floor
        use = probs;
      } else {
        u = s.cited && s.signature_hit ? 1 : s.cited || s.signature_hit || s.expanded ? 0.5 : 0;
        use = { deterministic: 1 };
      }
      u = Math.min(1, u);
      const ea = answers[`effect.d${i}`];
      const harmful = ea?.kind === "score" ? (ea.probs?.harmful ?? 0) : 0;
      const record: AttributionRecord = { type: "realctx2.attribution", deliveryId: d.deliveryId, use, effect: ea?.kind === "score" ? ea.score01 : undefined, u };
      result.records.push(record);
      const ref = this.nodeOf(d);
      if (ref && this.accounting) {
        const acc = this.accounting;
        acc.bump(ref.scope, ref.node.id, "delivered", 1);
        acc.use(ref.scope, ref.node, u, outcome === "success" || outcome === "failure" ? outcome : undefined);
        if (probs) {
          acc.bump(ref.scope, ref.node.id, "ignoredRelevant", probs.ignored_relevant ?? 0);
          acc.bump(ref.scope, ref.node.id, "known", probs.already_known ?? 0);
          acc.bump(ref.scope, ref.node.id, "contradicted", probs.contradicted ?? 0);
          acc.bump(ref.scope, ref.node.id, "harm", (probs.acted_on ?? 0) * harmful);
        } else if (s.restated) acc.bump(ref.scope, ref.node.id, "known", 0.5);
        if (u > 0) usedScopes.set(ref.scope, Math.max(usedScopes.get(ref.scope) ?? 0, u));
      }
      // a recalled fold that was used keeps its knowledge verbatim through later folds (§5.4.4)
      if (d.channel === "recall" && d.id.startsWith("t:") && u >= 0.5) {
        const rec = input.state.records.get(d.id);
        if (rec?.knowledge?.length && rec.knowledge.some((k) => !k.used)) result.updatedRecords.push({ ...rec, knowledge: rec.knowledge.map((k) => ({ ...k, used: true })) });
      }
    });
    // rule compliance feeds escalation (§6.10.4); fail-safe: not counted
    rules.forEach((r, k) => {
      const a = answers[`comply.k${k}`];
      const probs = a?.kind === "choice" ? a.probs : undefined;
      if (!probs || !this.accounting) return;
      result.complyChecked++;
      const n: MemoryNode = r.ref.node;
      this.accounting.bump(r.ref.scope, n.id, "complied", probs.complied ?? 0);
      this.accounting.bump(r.ref.scope, n.id, "violated", probs.violated ?? 0);
      this.accounting.bump(r.ref.scope, n.id, violationCounter(n.urgency), probs.violated ?? 0);
      const rec = result.records.find((x) => deliveries.find((d) => d.deliveryId === x.deliveryId)?.nodeIds?.includes(n.id));
      if (rec) rec.comply = { complied: probs.complied ?? 0, violated: probs.violated ?? 0, not_applicable: probs.not_applicable ?? 0 };
    });
    // EvoDisco's recent episode scores: closure outcomes of intents that used a scope
    if (this.log && input.intent && (input.outcome || outcome)) {
      const y = (outcome ?? input.outcome) === "success" ? 1 : (outcome ?? input.outcome) === "failure" ? 0 : 0.5;
      for (const scope of usedScopes.keys()) this.log.recordOutcome(scope, y, new Date().toISOString());
    }
    return result;
  }
}
