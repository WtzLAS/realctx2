/**
 * Janus (§5.2): intent maintenance. One decision request per step answers "which purposes
 * closed?" and "where does the focus go?"; deterministic rules turn the probabilities into
 * closures and at most one kindle; the scribe (aux LLM) writes the new intent.
 */
import type { Config } from "../core/config.ts";
import type { AuxSessionRunner, DecisionAnswer, DecisionClient, DecisionQuestion, EntryView, Intent, IntentOutcome } from "../core/types.ts";
import { UNCALIBRATED } from "../memory/services.ts";
import type { Similarity } from "../memory/similarity.ts";
import { randomId8 } from "../util/ids.ts";
import { clipTokens, clipWords, estimateTokens, sanitize } from "../util/text.ts";
import { lastRounds, renderSpan, renderStack } from "./render.ts";
import { roundsBefore, type Unit } from "./rounds.ts";
import type { SessionState } from "./state.ts";

export type Focus = "continue" | "deepen" | "successor" | "new_root";

export interface JanusInput {
  state: SessionState;
  entries: EntryView[];
  units: Unit[];
  /** The new user message, when Janus runs at `before_agent_start`. */
  userMessage?: string;
  /** `closure`: no kindle (agent_before_settle). */
  mode: "full" | "closure";
  round: number;
  signal?: AbortSignal;
  cacheKey?: string;
}

export interface KindlePlan {
  parentId: string | null;
  focus: Focus;
  /** Why the focus moved, for the scribe. */
  note: string;
}

export interface JanusPlan {
  /** False when the decision model gave no answer: treated as `continue`, no closures (§5.2.7). */
  answered: boolean;
  /** Innermost first. */
  closures: Array<{ intent: Intent; outcome: IntentOutcome; forced?: boolean }>;
  kindle: KindlePlan | null;
  /** P(closed) per open intent from this run, for the climb's "no closure expected" rule. */
  closeProb: Record<string, number>;
  focus: Focus | null;
  focusP: number;
  redirect: number | null;
  /** Entries the evidence covered (answers that arrive late apply to the state they saw). */
  evidenceLeafId: string | null;
}

export interface ScribedIntent {
  label: string;
  reason: string;
  success: string;
  failure: string;
}

const CLOSE_TEXT = "Using only evidence in the transcript, has this purpose met its success condition, met its failure condition, or been abandoned by the user? Count only results the agent has examined, not raw unread output. Partial progress is `open`.";
const FOCUS_TEXT = "Where does the agent's focus go next? `continue`: still serving the innermost remaining purpose. `deepen`: starting a sub-purpose it needs. `successor`: moving to the next purpose under the same parent. `new_root`: the user started unrelated work.";

const SCRIBE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["label", "reason", "success", "failure"],
  properties: { label: { type: "string" }, reason: { type: "string" }, success: { type: "string" }, failure: { type: "string" } },
};

export class Janus {
  private readonly cfg: Config;
  private readonly decision: DecisionClient;
  private readonly aux: () => AuxSessionRunner | null;
  private readonly sim: Similarity | null;

  constructor(deps: { cfg: Config; decision: DecisionClient; aux: () => AuxSessionRunner | null; sim: Similarity | null }) {
    this.cfg = deps.cfg;
    this.decision = deps.decision;
    this.aux = deps.aux;
    this.sim = deps.sim;
  }

  /** Evidence (§5.2.2): stable parts first, capped at `janus.maxInputTokens`. */
  evidence(input: JanusInput): { intent_stack: string; recent_rounds: string; user_message?: string } {
    const cap = this.cfg.janus.maxInputTokens;
    const stack = renderStack(input.state.stack, input.round);
    const user = input.userMessage ? clipTokens(sanitize(input.userMessage), Math.floor(cap / 4)) : undefined;
    const span = lastRounds(input.entries, input.units, 2);
    const left = Math.max(500, cap - estimateTokens(stack) - (user ? estimateTokens(user) : 0) - 200);
    const recent = renderSpan(input.entries, span.from, span.to, { toolOutputTokens: 300, maxTokens: left });
    return { intent_stack: stack, recent_rounds: recent || "(nothing yet)", ...(user ? { user_message: user } : {}) };
  }

  private questions(input: JanusInput): DecisionQuestion[] {
    const qs: DecisionQuestion[] = [];
    const open = [...input.state.stack].reverse().slice(0, this.cfg.janus.maxDepth);
    for (const i of open) {
      qs.push({
        kind: "choice",
        name: `close.${i.id}`,
        instructions: `Purpose [${i.id}] "${i.label}". ${CLOSE_TEXT}`,
        options: [{ value: "open" }, { value: "success", description: `met: ${i.success}` }, { value: "failure", description: `met: ${i.failure}` }, { value: "abandoned", description: "the user dropped or replaced it" }],
      });
    }
    if (input.mode === "full") {
      qs.push({ kind: "choice", name: "focus", instructions: FOCUS_TEXT, options: [{ value: "continue" }, { value: "deepen" }, { value: "successor" }, { value: "new_root" }] });
      if (input.userMessage) qs.push({ kind: "binary", name: "redirect", instructions: "Does the user's message cancel or replace the current purpose?" });
    }
    return qs;
  }

  /**
   * True when answers come from the aux-emulated fallback (§9.1.4): they take seconds, so no
   * commit point waits for them, and they apply one step late.
   */
  slow(): boolean {
    return this.decision.available() && !this.decision.calibrated();
  }

  /** One decision request and the deterministic rules of §5.2.4. Never throws. */
  async decide(input: JanusInput): Promise<JanusPlan> {
    const plan: JanusPlan = { answered: false, closures: [], kindle: null, closeProb: {}, focus: null, focusP: 0, redirect: null, evidenceLeafId: input.entries[input.entries.length - 1]?.id ?? null };
    const questions = this.questions(input);
    if (!questions.length || !this.decision.available()) return plan;
    let answers: Record<string, DecisionAnswer> = {};
    try {
      answers = await this.decision.decide(this.evidence(input), questions, { callSite: "janus", timeoutMs: this.cfg.janus.timeoutMs, noRetry: true, signal: input.signal, cacheKey: input.cacheKey });
    } catch {
      answers = {};
    }
    if (!Object.keys(answers).length) return plan; // timeout or error: continue, no closures
    plan.answered = true;
    return this.rules(input, answers, plan);
  }

  /** §5.2.4, exposed for tests and for answers that arrive late. */
  rules(input: JanusInput, answers: Record<string, DecisionAnswer>, plan: JanusPlan): JanusPlan {
    const cfg = this.cfg.context;
    const stack = input.state.stack;
    const index = new Map(input.entries.map((e, i) => [e.id, i]));

    // 1. close top-down: from the innermost intent outward, stopping at the first that stays open
    let stillOpen = stack.length;
    for (let j = stack.length - 1; j >= 0; j--) {
      const intent = stack[j]!;
      const a = answers[`close.${intent.id}`];
      const probs = a?.kind === "choice" ? a.probs : undefined;
      if (!probs) break;
      const pOpen = probs.open ?? 0;
      plan.closeProb[intent.id] = 1 - pOpen;
      const tau = a!.calibrated === false ? Math.max(cfg.tauClose, UNCALIBRATED.tauClose) : cfg.tauClose;
      if (1 - pOpen < tau) break;
      // 2. minimum evidence: at least one complete round since its guidance (a late intent's
      // first entry can be the assistant message of the round it was planned in)
      const at = intent.guidanceEntryId ? index.get(intent.guidanceEntryId) : undefined;
      if (at === undefined) break;
      const since = input.units.filter((u) => u.round && u.complete && u.start >= at).length;
      if (since < 1) break;
      const outcome = (["success", "failure", "abandoned"] as const).map((o) => [o, probs[o] ?? 0] as const).sort((x, y) => y[1] - x[1])[0]![0];
      plan.closures.push({ intent, outcome });
      stillOpen = j;
    }
    for (const i of stack) {
      const a = answers[`close.${i.id}`];
      if (a?.kind === "choice" && a.probs && plan.closeProb[i.id] === undefined) plan.closeProb[i.id] = 1 - (a.probs.open ?? 0);
    }
    if (input.mode === "closure") return plan;

    // 3. focus after closures
    const f = answers.focus;
    const fp = f?.kind === "choice" ? f.probs : undefined;
    const redirect = answers.redirect?.kind === "binary" ? (answers.redirect.p ?? null) : null;
    plan.redirect = redirect;
    if (!fp) return plan;
    const [focus, p] = (["continue", "deepen", "successor", "new_root"] as const).map((k) => [k, fp[k] ?? 0] as const).sort((x, y) => y[1] - x[1])[0]!;
    plan.focus = focus;
    plan.focusP = p;
    const tauOpen = cfg.tauOpen;
    const remaining = stack.slice(0, stillOpen);
    const atDepthCap = remaining.length >= this.cfg.janus.maxDepth;
    if (!remaining.length) {
      // empty stack: a new user task, or any move away from `continue`, kindles a root intent
      const moving = 1 - (fp.continue ?? 0);
      if ((input.userMessage && moving >= 0.5) || (focus !== "continue" && p >= tauOpen)) plan.kindle = { parentId: null, focus: "new_root", note: "No purpose is open; this starts a new one." };
      return plan;
    }
    const innermost = remaining[remaining.length - 1]!;
    if (focus === "deepen" && p >= tauOpen) {
      if (!atDepthCap) plan.kindle = { parentId: innermost.id, focus, note: `A sub-purpose of "${innermost.label}" is starting.` };
    } else if (focus === "successor" && p >= tauOpen) {
      // only after a closure in this step: `successor` never bypasses τ_close
      if (plan.closures.length) {
        const outermostClosed = plan.closures[plan.closures.length - 1]!.intent;
        plan.kindle = { parentId: outermostClosed.parentId, focus, note: `"${outermostClosed.label}" is finished; the next purpose under the same parent is starting.` };
      }
    } else if (focus === "new_root" && p >= tauOpen) {
      if (redirect !== null && redirect >= 0.8) {
        // the user replaced the work: what is still open is abandoned, then a root intent starts
        for (let j = remaining.length - 1; j >= 0; j--) plan.closures.push({ intent: remaining[j]!, outcome: "abandoned", forced: true });
        plan.kindle = { parentId: null, focus, note: "The user started unrelated work that replaces the current purpose." };
      } else if (!atDepthCap) {
        // an interruption: a child that returns focus to the parent when it closes
        plan.kindle = { parentId: innermost.id, focus: "deepen", note: `An interruption arrived while working on "${innermost.label}"; it is handled as a sub-purpose.` };
      }
    }
    return plan;
  }

  /**
   * The scribe (§5.2.5): `{ label, reason, success, failure }`, validated, with the duplicate
   * guard and one retry. Returns null when the kindle is skipped.
   */
  async scribe(input: JanusInput, kindle: KindlePlan, openAfter: Intent[]): Promise<ScribedIntent | null> {
    const aux = this.aux();
    if (!aux?.available()) return null;
    const span = lastRounds(input.entries, input.units, 2);
    const data = [
      { label: "OPEN PURPOSES", text: renderStack(openAfter, input.round) },
      { label: "LAST ROUNDS", text: renderSpan(input.entries, span.from, span.to, { toolOutputTokens: 300, maxTokens: 5000 }) || "(nothing yet)" },
      ...(input.userMessage ? [{ label: "NEW USER MESSAGE", text: clipTokens(input.userMessage, 1500) }] : []),
      { label: "FOCUS DECISION", text: kindle.note },
    ];
    let problem = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await aux.run<ScribedIntent>({
        role: "janus.scribe",
        instructions: `Name the purpose the coding agent is starting now, as an intent record. Name a purpose, not an action ("Find why login is flaky", not "Run the tests"). label: at most 12 words. reason: why this purpose now, one sentence. success: a condition observable in the transcript that means it is done. failure: an observable condition that means giving up. Do not repeat a purpose that is already open.${problem ? `\nYour previous answer was rejected: ${problem}` : ""}`,
        data,
        schema: SCRIBE_SCHEMA,
        tools: "none",
        signal: input.signal,
      });
      const out = res.output;
      if (!out || [out.label, out.reason, out.success, out.failure].some((x) => typeof x !== "string" || !x.trim())) {
        problem = "every field must be a non-empty string";
        continue;
      }
      const intent: ScribedIntent = { label: clipWords(sanitize(out.label).replace(/\s+/g, " ").trim(), 12).replace(/[."]+$/, ""), reason: sanitize(out.reason).trim(), success: sanitize(out.success).trim(), failure: sanitize(out.failure).trim() };
      // duplicate guard: never kindle a purpose already on the stack
      let duplicate: Intent | null = null;
      for (const open of openAfter) {
        if (open.label.toLowerCase() === intent.label.toLowerCase()) duplicate = open;
        else if (this.sim) {
          const pair = await this.sim.textPair(intent.label, open.label, input.signal);
          if (pair.sim >= this.sim.threshold("intentDuplicate", pair.mode)) duplicate = open;
        }
        if (duplicate) break;
      }
      if (!duplicate) return intent;
      problem = `"${intent.label}" duplicates the open purpose "${duplicate.label}"`;
    }
    return null;
  }

  newIntent(s: ScribedIntent, parentId: string | null, round: number): Intent {
    return { id: randomId8(), parentId, label: s.label, reason: s.reason, success: s.success, failure: s.failure, guidanceEntryId: "", openedRound: round, status: "open" };
  }

  /** Rounds an intent has been open, counted on the transcript (for reminders). */
  static roundsSince(intent: Intent, entries: EntryView[], units: Unit[]): number {
    const at = entries.findIndex((e) => e.id === intent.guidanceEntryId);
    if (at < 0) return 0;
    return units.filter((u) => u.round).length - roundsBefore(units, at);
  }
}
