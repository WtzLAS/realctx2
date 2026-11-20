/** Urgency (§6.10): who sets it, fail-safe defaults, triggers and escalation. */
import type { Config } from "../core/config.ts";
import { type DecisionAnswer, type DecisionQuestion, type Kind, type MemoryNode, type PathAnchor, type Severity, type Urgency, URGENCY_ORDER } from "../core/types.ts";

const URGENCY_DESCRIPTIONS: Record<Urgency, string> = {
  immediate:
    "The agent must know this before it acts. Learning it from the tool result afterwards would cause harm or work that is hard to undo: editing generated files, destructive or irreversible commands, migrations, publishing.",
  hint: "The full text helps when the agent touches this path or runs this command, and acting on it afterwards is cheap.",
  caption: "A one-line reminder is enough.",
  passive: "Background knowledge, useful only when searched for.",
};

/** `immediate` needs a trigger: a path anchor or a command pattern (§6.10). */
export function hasTrigger(n: { anchors: PathAnchor[]; triggers?: MemoryNode["triggers"] }): boolean {
  return n.anchors.some((a) => a.status === "live") || (n.triggers?.commands?.length ?? 0) > 0;
}

/** Fail-safe default when no decision is available (§6.10.1). */
export function defaultUrgency(kind: Kind, severity?: Severity): Urgency {
  if (kind === "rule") return severity === "must" || severity === "should" ? "hint" : "caption";
  if (kind === "procedure") return "hint";
  if (kind === "fact" || kind === "preference") return "caption";
  return "passive";
}

export function capUrgency(u: Urgency, triggered: boolean): Urgency {
  return u === "immediate" && !triggered ? "hint" : u;
}

export function urgencyQuestion(name: string, subject: string, triggered: boolean): DecisionQuestion {
  const levels: Urgency[] = triggered ? ["immediate", "hint", "caption", "passive"] : ["hint", "caption", "passive"];
  return {
    kind: "choice",
    name,
    instructions: `How urgently must a coding agent be told this memory when it has not asked for it? Memory: ${subject}`,
    options: levels.map((value) => ({ value, description: URGENCY_DESCRIPTIONS[value] })),
  };
}

/**
 * The most probable answer wins. An emulated (uncalibrated) answer is used only when its
 * probability is at least 0.7; otherwise the fail-safe default applies.
 */
export function pickUrgency(answer: DecisionAnswer | undefined, triggered: boolean, fallback: Urgency): { urgency: Urgency; by: "decision" | "default" } {
  if (!answer || answer.kind !== "choice" || !answer.probs) return { urgency: capUrgency(fallback, triggered), by: "default" };
  let best: Urgency | null = null;
  let bestP = -1;
  for (const [k, p] of Object.entries(answer.probs)) {
    if (!URGENCY_ORDER.includes(k as Urgency)) continue;
    if (p > bestP) {
      bestP = p;
      best = k as Urgency;
    }
  }
  if (!best || (!answer.calibrated && bestP < 0.7)) return { urgency: capUrgency(fallback, triggered), by: "default" };
  return { urgency: capUrgency(best, triggered), by: "decision" };
}

/** With the gate switched off, `immediate` memories are treated as `hint` (§6.10.3). */
export function effectiveUrgency(node: MemoryNode, cfg: Config): Urgency {
  const u = capUrgency(node.urgency, hasTrigger(node));
  return u === "immediate" && cfg.urgency.gate === "off" ? "hint" : u;
}

export function violationCounter(u: Urgency): "violations_passive" | "violations_caption" | "violations_hint" | "violations_immediate" {
  return `violations_${u}` as const;
}

/** Violations counted at the node's current level since it last arrived there (§6.10.4). */
export function violationsAtLevel(node: MemoryNode): number {
  const total = node.counters[violationCounter(node.urgency)];
  return Math.max(0, total - (node.violationsBaseline?.[node.urgency] ?? 0));
}

export interface EscalationDecision {
  action: "none" | "escalate" | "flag-rewrite" | "list-for-review";
  to?: Urgency;
}

/**
 * Escalation (§6.10.4): one level up per `escalateAfter` violations at the current level.
 * Only rules and procedures escalate; user-set urgency never does; `immediate` needs a trigger,
 * and a rule still broken at `immediate` becomes a rewrite candidate.
 */
export function escalation(node: MemoryNode, cfg: Config, extraViolations = 0): EscalationDecision {
  if (node.kind !== "rule" && node.kind !== "procedure") return { action: "none" };
  const count = violationsAtLevel(node) + extraViolations;
  if (count < cfg.urgency.escalateAfter) return { action: "none" };
  if (node.urgencyBy === "user") return { action: "list-for-review" };
  const idx = URGENCY_ORDER.indexOf(node.urgency);
  if (node.urgency === "immediate") return { action: "flag-rewrite" };
  const next = URGENCY_ORDER[idx + 1]!;
  if (next === "immediate" && !hasTrigger(node)) return { action: "flag-rewrite" };
  return { action: "escalate", to: next };
}
