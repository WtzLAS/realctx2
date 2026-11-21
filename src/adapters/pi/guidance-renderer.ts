/**
 * TUI renderer for realctx2's guidance messages (`realctx2.guidance`) in pi, styled like a tool:
 * a box on the tool background with a bold `realctx2 …` title, one line per closed or opened intent,
 * and the memory cards and path notes behind pi's tool-expand key. Display-only: the model still
 * receives the message text unchanged. The parser follows `renderGuidance`, `renderLateCards` and
 * `renderReminder` (src/context/render.ts); text it does not recognize is shown as is.
 */
import type { MessageRenderer, MessageRenderOptions } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Text } from "@earendil-works/pi-tui";
import { clean, SummaryComponent } from "./tool-renderers.ts";

type Theme = Parameters<MessageRenderer>[2];

export interface ParsedGuidance {
  kind: "intent" | "cards" | "reminder" | "note";
  closed: Array<{ label: string; outcome: string }>;
  now?: { label: string; inside?: string };
  backTo?: string;
  cardsFor?: string;
  why?: string;
  done?: string;
  giveUp?: string;
  /** `[m:…]` cards in the body. */
  memories: number;
  /** Headers of `[paths]` blocks (without the prefix). */
  paths: string[];
  /** Everything after the intent lines: cards, path notes, unrecognized text. */
  body: string[];
}

const CLOSED = /I finished "(.*?)": (succeeded|failed|set aside)\./g;
const NOW = /^I'm now working on "(.*)"(?: \(inside: (.*)\))?\.$/;
const BACK = /^I'm back to "(.*?)"\.(?: Done when: (.*))?$/;
const STILL = /^Still working on "(.*?)"(?: \(inside: (.*?)\))?\. Done when: (.*?)(?: Give up when: (.*))?$/;
const CARDS_FOR = /^Memory that may help with "(.*)":$/;

export function parseGuidance(content: string): ParsedGuidance {
  const lines = content.split("\n");
  const g: ParsedGuidance = { kind: "note", closed: [], memories: 0, paths: [], body: [] };
  let i = 0;
  if (lines[0]?.startsWith("[intent]")) {
    g.kind = "intent";
    lines[0] = lines[0].slice("[intent]".length).trim();
    for (; i < lines.length; i++) {
      let line = lines[i]!;
      if (i === 0) {
        line = line.replace(CLOSED, (_m, label: string, outcome: string) => {
          g.closed.push({ label, outcome });
          return "";
        }).trim();
        if (!line) continue;
      }
      let m: RegExpExecArray | null;
      if ((m = NOW.exec(line))) g.now = { label: m[1]!, inside: m[2] };
      else if ((m = BACK.exec(line))) {
        g.backTo = m[1]!;
        if (m[2]) g.done = m[2];
      } else if ((m = STILL.exec(line))) {
        g.kind = "reminder";
        g.now = { label: m[1]!, inside: m[2] };
        g.done = m[3];
        if (m[4]) g.giveUp = m[4];
      } else if ((m = CARDS_FOR.exec(line))) {
        g.kind = "cards";
        g.cardsFor = m[1]!;
        i++;
        break;
      } else if (line.startsWith("Why: ")) g.why = line.slice(5);
      else if (line.startsWith("Done when: ")) g.done = line.slice(11);
      else if (line.startsWith("Give up when: ")) g.giveUp = line.slice(14);
      else break; // "Memory that may help:", a [paths] block, or anything else
    }
  }
  g.body = lines.slice(i);
  for (const line of g.body) {
    if (/^\[m:[0-9a-z]{8}\]/.test(line)) g.memories++;
    else if (line.startsWith("[paths] ")) g.paths.push(line.slice(8));
  }
  // a message that is only path notes (no intent lines) is titled by them
  if (g.kind === "intent" && !g.closed.length && !g.now && !g.backTo) g.kind = "note";
  return g;
}

const TITLES: Record<ParsedGuidance["kind"], string> = { intent: "realctx2 intent", cards: "realctx2 memory", reminder: "realctx2 reminder", note: "realctx2" };

function outcomeStyle(theme: Theme, outcome: string): string {
  if (outcome === "succeeded") return theme.fg("success", `✓ finished`);
  if (outcome === "failed") return theme.fg("error", `✗ finished`);
  return theme.fg("warning", `• finished`);
}

/** The title, the intent lines and a footer; with `expanded`, also why/give-up and the full body. */
export function guidanceLines(content: string, expanded: boolean, theme: Theme, hint?: (description: string) => string): { lines: string[]; hidden: boolean } {
  const g = parseGuidance(content);
  const muted = (s: string) => theme.fg("muted", s);
  const extras: string[] = [];
  if (g.memories) extras.push(`${g.memories} memor${g.memories === 1 ? "y" : "ies"}`);
  if (g.paths.length) extras.push(`paths ${g.paths.map((p) => clean(p, 60)).join(", ")}`);
  if (g.kind === "note" && !extras.length) extras.push(clean(g.body.find((l) => l.trim()) ?? "", 120));
  const title = theme.fg("toolTitle", theme.bold(g.kind === "note" && g.paths.length ? "realctx2 paths" : TITLES[g.kind]));
  const lines = [title + (extras.length ? `  ${muted(extras.join(" · "))}` : "")];

  for (const c of g.closed) lines.push(`${outcomeStyle(theme, c.outcome)} ${theme.fg("text", `"${clean(c.label, 120)}"`)}${muted(` · ${clean(c.outcome, 16)}`)}`);
  if (g.now) {
    const verb = g.kind === "reminder" ? "still working on" : "now working on";
    lines.push(`${theme.fg("accent", `→ ${verb}`)} ${theme.fg("text", `"${clean(g.now.label, 120)}"`)}${g.now.inside ? muted(`  inside: ${clean(g.now.inside, 80)}`) : ""}`);
  }
  if (g.backTo) lines.push(`${theme.fg("accent", "↩ back to")} ${theme.fg("text", `"${clean(g.backTo, 120)}"`)}`);
  if (g.cardsFor) lines.push(`${theme.fg("accent", "for")} ${theme.fg("text", `"${clean(g.cardsFor, 120)}"`)}`);
  if (expanded && g.why) lines.push(muted(`  Why: ${clean(g.why, 400)}`));
  if (g.done) lines.push(muted(`  Done when: ${clean(g.done, expanded ? 400 : 160)}`));
  if (expanded && g.giveUp) lines.push(muted(`  Give up when: ${clean(g.giveUp, 400)}`));

  const body = g.body.join("\n").trim();
  const hidden = !expanded && Boolean(body || (g.why && g.why.trim()) || (g.giveUp && g.giveUp.trim()));
  if (expanded && body) {
    for (const l of body.split("\n").slice(0, 200)) {
      const indent = " ".repeat(Math.min(8, /^[ \t]*/.exec(l)![0].replace(/\t/g, "  ").length));
      lines.push(muted(indent + clean(l, 400)) || " ");
    }
  }
  else if (hidden) lines.push(theme.fg("dim", hint ? hint("to expand") : "expand to view"));
  return { lines, hidden };
}

/** Registered with `pi.registerMessageRenderer(GUIDANCE_TYPE, …)`. */
export function guidanceRenderer(): MessageRenderer {
  return (message, options: MessageRenderOptions, theme) => {
    const content = typeof message.content === "string" ? message.content : message.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    // pi's tool-expand key also expands custom messages; without a bound key, a plain hint
    const bound = typeof options.keyText === "function" && typeof options.keyHint === "function" && Boolean(options.keyText("app.tools.expand"));
    const hint = bound ? (d: string) => options.keyHint("app.tools.expand", d) : undefined;
    const { lines } = guidanceLines(content, options.expanded, theme, hint);
    const box = new Box(options.outputPad ?? 1, 1, (t) => theme.bg("toolSuccessBg", t));
    // collapsed: one line each, cut to the width; expanded: wrapped like tool output
    const inner: Component = options.expanded ? new Text(lines.join("\n"), 0, 0) : new SummaryComponent(lines);
    box.addChild(inner);
    return box;
  };
}
