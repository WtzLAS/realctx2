/** Argument parsing for `/realctx2 <command> …`: shell-like words, `--flag` and `--flag value`. */

export function words(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < input.length) cur += input[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (cur || has) out.push(cur);
      cur = "";
      has = false;
    } else cur += c;
  }
  if (cur || has) out.push(cur);
  return out;
}

export interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
  /** The argument text after the subcommand, untouched (for free-text commands). */
  rest: string;
}

/** `valued` names the flags that take a value; every other `--flag` is boolean. */
export function parseArgs(rest: string, valued: string[] = []): Parsed {
  const ws = words(rest);
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i]!;
    if (w.startsWith("--") && w.length > 2) {
      const eq = w.indexOf("=");
      const name = eq > 0 ? w.slice(2, eq) : w.slice(2);
      if (eq > 0) flags.set(name, w.slice(eq + 1));
      else if (valued.includes(name) && i + 1 < ws.length) flags.set(name, ws[++i]!);
      else flags.set(name, true);
    } else positional.push(w);
  }
  return { positional, flags, rest };
}

export function flagValue(p: Parsed, name: string): string | undefined {
  const v = p.flags.get(name);
  return typeof v === "string" ? v : undefined;
}

/** Free text after removing the named flags (for `remember <text>` and `forget <query> --purge`). */
export function freeText(rest: string, drop: string[]): string {
  let t = rest;
  for (const f of drop) t = t.replace(new RegExp(`(^|\\s)--${f}(?=\\s|$)`, "g"), " ");
  return t.trim().replace(/^["']([\s\S]*)["']$/, "$1").trim();
}

export function num(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export function table(rows: string[][]): string {
  if (!rows.length) return "";
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => (r[c] ?? "").length)));
  return rows.map((r) => r.map((cell, c) => (c === r.length - 1 ? cell : cell.padEnd(widths[c]!))).join("  ").trimEnd()).join("\n");
}
