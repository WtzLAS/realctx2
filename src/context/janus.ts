/**
 * Advisory Janus (§5.2): nonblocking drift detection using the decision model. The main model
 * maintains the intent stack directly through the `intent` tool; Janus runs in the background
 * after a quiet-gap debounce (or prefires when unchecked evidence hits `janus.maxInputTokens`)
 * and emits a strong drift reminder when the model appears to have moved on without updating
 * the stack. Janus never mutates the stack itself.
 */
import { type Config, effectiveJanusMaxInputTokens } from "../core/config.ts";
import type { DecisionAnswer, DecisionClient, DecisionQuestion, EntryView, Intent, IntentOutcome } from "../core/types.ts";
import { UNCALIBRATED } from "../memory/services.ts";
import { clipTokens, estimateTokens, sanitize } from "../util/text.ts";
import { lastRounds, outcomeWord, renderSpan, renderStack } from "./render.ts";
import { roundsBefore, type Unit } from "./rounds.ts";
import type { SessionState } from "./state.ts";

export type Focus = "continue" | "deepen" | "successor" | "new_root";
export type DriftKind = "close" | "open" | "shift" | "deepen" | "redirect";

export interface JanusInput {
  state: SessionState;
  entries: EntryView[];
  units: Unit[];
  /** New user message arrived since the last check, if any. */
  userMessage?: string;
  /** `closure`: check closures only (skip focus question). */
  mode: "full" | "closure";
  round: number;
  signal?: AbortSignal;
  cacheKey?: string;
  /** Entry id of the last checked leaf: evidence stretches back to cover everything after it. */
  sinceEntryId?: string | null;
}

export interface KindlePlan {
  parentId: string | null;
  focus: Focus;
  /** Why the focus moved. */
  note: string;
}

export interface JanusPlan {
  /** False when the decision model gave no answer: treated as `continue`, no drift (§5.2.7). */
  answered: boolean;
  /** Innermost first. */
  closures: Array<{ intent: Intent; outcome: IntentOutcome; forced?: boolean }>;
  kindle: KindlePlan | null;
  /** P(closed) per open intent from this run, for the climb's "no closure expected" rule. */
  closeProb: Record<string, number>;
  focus: Focus | null;
  focusP: number;
  redirect: number | null;
  /** Latest entry covered by the evidence. */
  evidenceLeafId: string | null;
}

export interface DriftAdvisory {
  kind: DriftKind;
  /** Innermost-first intents that appear finished or abandoned. */
  closures: Array<{ intent: Intent; outcome: IntentOutcome; forced?: boolean }>;
  /** Suggested focus transition, if any. */
  focus: Focus | null;
  /** Actionable reminder telling the main model how to update the stack with `intent`. */
  summary: string;
  /** Latest entry id covered by the evidence. */
  evidenceLeafId: string | null;
}

const CLOSE_TEXT = "Using only evidence in the transcript, has this purpose met its success condition, met its failure condition, or been abandoned by the user? Count only results the agent has examined, not raw unread output. Partial progress is `open`.";
const FOCUS_TEXT = "Where does the agent's focus go next? `continue`: still serving the innermost remaining purpose. `deepen`: starting a sub-purpose it needs. `successor`: moving to the next purpose under the same parent. `new_root`: the user started unrelated work.";

export class Janus {
  private readonly cfg: Config;
  private readonly decision: DecisionClient;

  constructor(deps: { cfg: Config; decision: DecisionClient }) {
    this.cfg = deps.cfg;
    this.decision = deps.decision;
  }

  available(): boolean {
    return this.decision.available();
  }

  /**
   * True when answers come from the aux-emulated fallback (§9.1.4): they take seconds and use
   * stricter thresholds.
   */
  slow(): boolean {
    return this.decision.available() && !this.decision.calibrated();
  }

  /** Effective evidence token cap (and prefire threshold): `min(decisionMaxInput, 64K)` on `"auto"`. */
  maxInputTokens(): number {
    return effectiveJanusMaxInputTokens(this.cfg);
  }

  /** First entry index not yet inspected by an earlier advisory check. */
  private uncheckedStart(entries: EntryView[], sinceEntryId: string | null | undefined): number {
    if (!sinceEntryId) return 0;
    const at = entries.findIndex((e) => e.id === sinceEntryId);
    return at >= 0 ? at + 1 : 0;
  }

  /**
   * Estimated evidence tokens accumulated since `sinceEntryId` (used for prefire: when this
   * reaches `janus.maxInputTokens` while a debounce timer is counting down, Janus fires
   * immediately once so earlier unchecked context is not truncated away).
   */
  uncheckedTokens(input: JanusInput, extraTokens = 0): number {
    const cap = this.maxInputTokens();
    const stack = renderStack(input.state.stack, input.round);
    const user = input.userMessage ? clipTokens(sanitize(input.userMessage), Math.floor(cap / 4)) : "";
    const from = this.uncheckedStart(input.entries, input.sinceEntryId);
    const recent = from < input.entries.length ? renderSpan(input.entries, from, input.entries.length, { toolOutputTokens: 300 }) : "";
    return estimateTokens(stack) + (user ? estimateTokens(user) : 0) + estimateTokens(recent) + 200 + extraTokens;
  }

  /** Evidence (§5.2.2): stable parts first, capped at `janus.maxInputTokens`. */
  evidence(input: JanusInput): { intent_stack: string; recent_rounds: string; user_message?: string } {
    const cap = this.maxInputTokens();
    const stack = renderStack(input.state.stack, input.round);
    const user = input.userMessage ? clipTokens(sanitize(input.userMessage), Math.floor(cap / 4)) : undefined;
    const recentSpan = lastRounds(input.entries, input.units, 2);
    const from = input.sinceEntryId !== undefined ? Math.min(recentSpan.from, this.uncheckedStart(input.entries, input.sinceEntryId)) : recentSpan.from;
    const left = Math.max(500, cap - estimateTokens(stack) - (user ? estimateTokens(user) : 0) - 200);
    const recent = renderSpan(input.entries, from, recentSpan.to, { toolOutputTokens: 300, maxTokens: left });
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
        options: [
          { value: "open" },
          { value: "success", description: `met: ${i.success}` },
          { value: "failure", description: i.failure ? `met: ${i.failure}` : "the purpose failed or hit a blocker" },
          { value: "abandoned", description: "the user dropped or replaced it" },
        ],
      });
    }
    if (input.mode === "full") {
      qs.push({ kind: "choice", name: "focus", instructions: FOCUS_TEXT, options: [{ value: "continue" }, { value: "deepen" }, { value: "successor" }, { value: "new_root" }] });
      if (input.userMessage) qs.push({ kind: "binary", name: "redirect", instructions: "Does the user's message cancel or replace the current purpose?" });
    }
    return qs;
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
    if (!Object.keys(answers).length) return plan; // timeout or error: continue, no drift
    plan.answered = true;
    return this.rules(input, answers, plan);
  }

  /** §5.2.4, exposed for tests and deterministic drift evaluation. */
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
      // 2. minimum evidence: at least one complete round since its start
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
      // empty stack: a new user task, or any move away from `continue`, warrants opening a root intent
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
        for (let j = remaining.length - 1; j >= 0; j--) plan.closures.push({ intent: remaining[j]!, outcome: "abandoned", forced: true });
        plan.kindle = { parentId: null, focus, note: "The user started unrelated work that replaces the current purpose." };
      } else if (!atDepthCap) {
        plan.kindle = { parentId: innermost.id, focus: "deepen", note: `An interruption arrived while working on "${innermost.label}"; it is handled as a sub-purpose.` };
      }
    }
    return plan;
  }

  /** Turn a decision plan into an actionable drift advisory for the main model, or null when aligned. */
  advisory(plan: JanusPlan, stack: Intent[], toolName = "intent"): DriftAdvisory | null {
    if (!plan.answered || (!plan.closures.length && !plan.kindle)) return null;
    const closedCount = plan.closures.length;
    const closedList = plan.closures.map((c) => `"${c.intent.label}" (${outcomeWord(c.outcome)})`).join(", ");
    const primaryOutcome = plan.closures[0]?.outcome ?? "success";
    const popArg = stack.length > 0 && closedCount >= stack.length ? "all: true" : `count: ${closedCount}`;

    if (closedCount > 0 && plan.kindle) {
      if (plan.closures.some((c) => c.forced)) {
        return {
          kind: "redirect",
          closures: plan.closures,
          focus: plan.focus,
          summary: `Work appears to have shifted to a new goal while ${stack.length} intent(s) remain open. Call \`${toolName}\` with action "shift" (all: true, outcome: "abandoned") or "close" (all: true, outcome: "abandoned") to realign the stack.`,
          evidenceLeafId: plan.evidenceLeafId,
        };
      }
      return {
        kind: "shift",
        closures: plan.closures,
        focus: plan.focus,
        summary: `${closedList} appears finished and focus is moving to the next purpose. Call \`${toolName}\` with action "shift" (${popArg}, outcome: "${primaryOutcome}") to close it and open the next intent.`,
        evidenceLeafId: plan.evidenceLeafId,
      };
    }
    if (closedCount > 0) {
      return {
        kind: "close",
        closures: plan.closures,
        focus: plan.focus,
        summary: `${closedList} appears finished. Call \`${toolName}\` with action "close" (${popArg}, outcome: "${primaryOutcome}") so completed work can consolidate.`,
        evidenceLeafId: plan.evidenceLeafId,
      };
    }
    // kindle only (no closures)
    if (!stack.length) {
      return {
        kind: "open",
        closures: [],
        focus: plan.focus,
        summary: `No intent is currently open on the stack for this work. Call \`${toolName}\` with action "open" to record your current purpose and completion condition.`,
        evidenceLeafId: plan.evidenceLeafId,
      };
    }
    const innermost = stack[stack.length - 1]!;
    return {
      kind: "deepen",
      closures: [],
      focus: plan.focus,
      summary: `Your focus appears to have moved into a distinct sub-purpose inside "${innermost.label}". Call \`${toolName}\` with action "open" to push a sub-intent, or "shift" if "${innermost.label}" is already done.`,
      evidenceLeafId: plan.evidenceLeafId,
    };
  }

  /** Rounds an intent has been open, counted on the transcript (for reminders and climb stability). */
  static roundsSince(intent: Intent, entries: EntryView[], units: Unit[]): number {
    const at = entries.findIndex((e) => e.id === intent.guidanceEntryId);
    if (at < 0) return 0;
    return units.filter((u) => u.round).length - roundsBefore(units, at);
  }
}
