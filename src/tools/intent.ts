/**
 * The `intent` tool (§5.2, §8.1): lets the main model directly manage its nested intent stack
 * (`open`, `close`, `shift`, `update`). Opening an intent brings proactive memory cards and
 * path rules; closing an intent triggers background Precip consolidation.
 */
import type { IntentOutcome, ToolCallContext, ToolResultPayload } from "../core/types.ts";
import { outcomeWord } from "../context/render.ts";
import type { IntentActionInput } from "../context/engine.ts";
import { fail, int, ok, oneOf, str, type ToolEnv } from "./env.ts";

const ACTIONS = ["open", "close", "shift", "update"] as const;
const OUTCOMES: readonly IntentOutcome[] = ["success", "failure", "abandoned"];

export async function runIntent(env: ToolEnv, raw: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResultPayload> {
  if (ctx.aux) return fail("intent is not available to helper sessions.");
  const engine = env.engine;
  if (!engine) return fail("The context engine is not available in this session.");

  const action = oneOf(raw.action, ACTIONS);
  if (!action) return fail(`intent needs \`action\`: one of ${ACTIONS.join(", ")}.`);

  const outcome = raw.outcome !== undefined ? oneOf(raw.outcome, OUTCOMES) : undefined;
  if (raw.outcome !== undefined && !outcome) return fail(`outcome must be one of ${OUTCOMES.join(", ")}.`);

  let input: IntentActionInput;
  if (action === "open") {
    const label = str(raw.label);
    const done = str(raw.done);
    if (!label) return fail("open requires `label`: a short purpose (at most 12 words).");
    if (!done) return fail("open requires `done`: an observable condition that means this purpose is complete.");
    input = {
      action: "open",
      label,
      reason: typeof raw.reason === "string" ? raw.reason.trim() : undefined,
      done,
      giveUp: typeof raw.give_up === "string" ? raw.give_up.trim() : undefined,
    };
  } else if (action === "close") {
    input = {
      action: "close",
      outcome,
      count: raw.count !== undefined ? int(raw.count, 1, 1, 20) : undefined,
      all: raw.all === true,
    };
  } else if (action === "shift") {
    const label = str(raw.label);
    const done = str(raw.done);
    if (!label) return fail("shift requires `label`: a short purpose (at most 12 words).");
    if (!done) return fail("shift requires `done`: an observable condition that means this purpose is complete.");
    input = {
      action: "shift",
      label,
      reason: typeof raw.reason === "string" ? raw.reason.trim() : undefined,
      done,
      giveUp: typeof raw.give_up === "string" ? raw.give_up.trim() : undefined,
      outcome,
      count: raw.count !== undefined ? int(raw.count, 1, 1, 20) : undefined,
      all: raw.all === true,
    };
  } else {
    if (raw.label !== undefined && !str(raw.label)) return fail("label must be non-empty.");
    if (raw.done !== undefined && !str(raw.done)) return fail("done must be non-empty.");
    input = {
      action: "update",
      label: raw.label !== undefined ? str(raw.label) : undefined,
      reason: typeof raw.reason === "string" ? raw.reason.trim() : undefined,
      done: raw.done !== undefined ? str(raw.done) : undefined,
      giveUp: typeof raw.give_up === "string" ? raw.give_up.trim() : undefined,
    };
  }

  const res = await engine.applyIntentAction(input, { toolCallId: ctx.toolCallId, signal: ctx.signal });
  if (!res.ok) return fail(res.error ?? "intent action failed.");

  const lines: string[] = [];
  if (res.closed.length) {
    const desc = res.closed.map((c) => `"${c.intent.label}" (${outcomeWord(c.outcome)})`).join(", ");
    lines.push(`Closed ${desc}.`);
  }
  if (res.opened) {
    const parent = res.opened.parentId ? res.stack.find((i) => i.id === res.opened!.parentId)?.label : undefined;
    lines.push(`Opened "${res.opened.label}"${parent ? ` (inside: ${parent})` : ""}.`);
    if (res.opened.reason) lines.push(`Why: ${res.opened.reason}`);
    lines.push(`Done when: ${res.opened.success}`);
    if (res.opened.failure) lines.push(`Give up when: ${res.opened.failure}`);
  } else if (res.updated) {
    lines.push(`Updated "${res.updated.label}".`);
    if (res.updated.reason) lines.push(`Why: ${res.updated.reason}`);
    lines.push(`Done when: ${res.updated.success}`);
    if (res.updated.failure) lines.push(`Give up when: ${res.updated.failure}`);
  } else if (res.stack.length) {
    const back = res.stack[res.stack.length - 1]!;
    lines.push(`Back to "${back.label}". Done when: ${back.success}`);
  }
  lines.push(`Stack: ${res.stack.length ? res.stack.map((i) => `"${i.label}"`).join(" > ") : "(empty)"}`);
  if (res.cards) lines.push("", `Memory that may help:\n${res.cards}`);
  if (res.paths) lines.push("", res.paths);

  return ok(lines.join("\n"), {
    action: res.action,
    closed: res.closed.map((c) => ({ id: c.intent.id, label: c.intent.label, outcome: outcomeWord(c.outcome) })),
    opened: res.opened ? { id: res.opened.id, label: res.opened.label, done: res.opened.success } : undefined,
    updated: res.updated ? { id: res.updated.id, label: res.updated.label, done: res.updated.success } : undefined,
    stack: res.stack.map((i) => i.label),
    cards: res.deliveries.filter((d) => d.channel === "proactive").length,
    deliveries: res.deliveries,
  });
}
