import { createHash } from "node:crypto";

export function sha256(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Cheap tokenizer-free estimate: ~4 ASCII chars per token, ~1 token per non-ASCII char. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let nonAscii = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x7f) nonAscii++;
  return Math.ceil((text.length - nonAscii) / 4 + nonAscii);
}

/** Cut `text` to roughly `maxTokens`, keeping the head. */
export function clipTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  let cut = Math.max(0, maxTokens * 4);
  while (cut > 0 && estimateTokens(text.slice(0, cut)) > maxTokens) cut = Math.floor(cut * 0.9);
  return text.slice(0, cut);
}

/** Keep the first `head` and last `tail` tokens with an elision marker in between. */
export function headTail(text: string, head: number, tail: number, marker?: (omitted: number) => string): string {
  const total = estimateTokens(text);
  if (total <= head + tail) return text;
  const h = clipTokens(text, head);
  let cut = Math.max(0, text.length - tail * 4);
  while (cut < text.length && estimateTokens(text.slice(cut)) > tail) cut += Math.ceil((text.length - cut) * 0.1);
  const t = text.slice(cut);
  const omitted = Math.max(0, total - estimateTokens(h) - estimateTokens(t));
  return `${h}\n${marker ? marker(omitted) : `[… ${omitted} tokens omitted …]`}\n${t}`;
}

export function wordCount(text: string): number {
  const m = text.trim().match(/\S+/g);
  return m ? m.length : 0;
}

export function clipWords(text: string, max: number): string {
  const words = text.trim().split(/\s+/);
  return words.length <= max ? text.trim() : words.slice(0, max).join(" ");
}

/** Normalization for content hashing: case, whitespace and quote characters folded. */
export function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function contentHash(text: string): string {
  return sha256(normalizeText(text));
}

/** Normalization for quote verification (§6.3.2, §6.4.4): whitespace, quote characters, case. */
export function normalizeForMatch(text: string): string {
  return normalizeText(text).replace(/[`'"]/g, "'");
}

/**
 * Verify a verbatim quote against its source with a normalized substring match,
 * segment by segment for multi-excerpt quotes ("a … b", "a [...] b").
 */
export function verifyQuote(quote: string, source: string): boolean {
  const src = normalizeForMatch(source);
  const segments = quote
    .split(/\s*(?:\[\s*(?:\.\.\.|…)\s*\]|\.\.\.|…)\s*/)
    .map((s) => normalizeForMatch(s))
    .filter((s) => s.length > 0);
  if (segments.length === 0) return false;
  let from = 0;
  for (const seg of segments) {
    const at = src.indexOf(seg, from);
    if (at < 0) return false;
    from = at + seg.length;
  }
  return true;
}

function wordNgrams(text: string, n: number): Set<string> {
  const words = normalizeText(text).split(/[^\p{L}\p{N}_./-]+/u).filter(Boolean);
  const out = new Set<string>();
  if (words.length < n) {
    if (words.length) out.add(words.join(" "));
    return out;
  }
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(" "));
  return out;
}

/** Fraction of `a`'s word n-grams that also appear in `b` (restatedRatio, §5.5.1). */
export function ngramOverlap(a: string, b: string, n = 3): number {
  const ga = wordNgrams(a, n);
  if (ga.size === 0) return 0;
  const gb = wordNgrams(b, n);
  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit++;
  return hit / ga.size;
}

function charTrigrams(text: string): Set<string> {
  const s = `  ${normalizeText(text)}  `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
  return out;
}

/** Character-trigram Jaccard similarity (the no-embedding fallback, §9.2.1). */
export function trigramJaccard(a: string, b: string): number {
  const ta = charTrigrams(a);
  const tb = charTrigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const g of ta) if (tb.has(g)) inter++;
  return inter / (ta.size + tb.size - inter);
}

const ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const HARNESS_TAGS =
  /<\s*\/?\s*(system|system-reminder|assistant|user|human|tool_result|tool_use|function_calls|antml:[\w-]+|im_start|im_end)\b[^>]*>/gi;
const RESERVED_LINE = /^(\s*)\[(intent|gate|paths|t:[0-9a-z]{8}\b)/gim;
const ROLE_LINE = /^(\s*)(Human|Assistant|System|User):/gm;

/**
 * Strip control and zero-width characters and neutralize markup that imitates harness or
 * system messages (§7.12). Memory text is data; it must never read as a harness message.
 */
export function sanitize(text: string): string {
  return text
    .replace(ZERO_WIDTH, "")
    .replace(CONTROL, "")
    .replace(/<\|[^|>]{1,40}\|>/g, (m) => m.replace("<", "‹").replace(">", "›"))
    .replace(HARNESS_TAGS, (m) => m.replace("<", "‹").replace(">", "›"))
    .replace(RESERVED_LINE, (_m, ws: string, tag: string) => `${ws}［${tag}`)
    .replace(ROLE_LINE, (_m, ws: string, role: string) => `${ws}${role}\u2236`);
}

const PATH_EXT =
  "ts|tsx|js|jsx|mjs|cjs|json|md|mdx|py|rs|go|java|kt|rb|php|c|h|cc|cpp|hpp|cs|swift|sql|sh|bash|zsh|yml|yaml|toml|ini|cfg|conf|env|lock|html|css|scss|vue|svelte|proto|graphql|prisma|tf|gradle|xml|txt|csv";
const RE_BACKTICK = /`([^`\n]{2,120})`/g;
const RE_URL = /\bhttps?:\/\/[^\s)'"<>]+/g;
const RE_PATH = new RegExp(
  `(?<![\\w@])(?:\\.{0,2}\\/)?(?:[\\w.@+-]+\\/)+[\\w.@+-]*[\\w@+-]|(?<![\\w/.-])[\\w.-]+\\.(?:${PATH_EXT})\\b`,
  "g",
);
const RE_IDENT =
  /\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+(?:\(\))?|\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b|\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b|\b[a-z][a-z0-9]*_[a-z0-9_]+\b|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g;
const RE_VALUE = /\b\d+(?:\.\d+)?\s?(?:ms|s|sec|secs|min|mins|h|hrs?|days?|kb|mb|gb|tb|kib|mib|gib|%|px|rpm|qps|tokens?)\b/gi;
const RE_IDS = /#\d{1,7}\b|\b[0-9a-f]{7,40}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b(?:port|pid|issue|pr)\s+#?(\d{2,6})\b/gi;

/** True when a token looks like a repo-relative or absolute file path. */
export function looksLikePath(token: string): boolean {
  if (/^https?:\/\//.test(token)) return false;
  if (token.includes("/") && /^[\w.@+~/-]+$/.test(token) && !/^\/+$/.test(token)) return true;
  return new RegExp(`^[\\w.-]+\\.(?:${PATH_EXT})$`).test(token);
}

/**
 * Action signature (§6.3.2 step 3): file paths, code identifiers, commands in backticks,
 * URLs, ids and values with units.
 */
export function extractSignature(text: string, extra: string[] = [], cap = 32): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (s: string) => {
    const t = s.trim().replace(/[.,;:)\]]+$/, "");
    if (t.length < 2 || t.length > 160) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };
  for (const e of extra) add(e);
  for (const m of text.matchAll(RE_BACKTICK)) add(m[1]!);
  for (const m of text.matchAll(RE_URL)) add(m[0]);
  const noUrls = text.replace(RE_URL, " ");
  for (const m of noUrls.matchAll(RE_PATH)) add(m[0]);
  for (const m of noUrls.matchAll(RE_IDENT)) add(m[0]);
  for (const m of noUrls.matchAll(RE_VALUE)) add(m[0]);
  for (const m of noUrls.matchAll(RE_IDS)) {
    const v = m[1] ?? m[0];
    // bare hex needs at least one digit and one letter to count as an id
    if (/^[0-9a-f]+$/i.test(v) && !(/[0-9]/.test(v) && /[a-f]/i.test(v))) continue;
    add(v);
  }
  return out.slice(0, cap);
}

/** Path-like tokens in free text (user messages, §6.8.5). */
export function extractPathTokens(text: string): string[] {
  const out = new Set<string>();
  const noUrls = text.replace(RE_URL, " ");
  for (const m of noUrls.matchAll(RE_BACKTICK)) if (looksLikePath(m[1]!)) out.add(m[1]!);
  for (const m of noUrls.matchAll(RE_PATH)) out.add(m[0].replace(/[.,;:)\]]+$/, ""));
  return [...out];
}

/** Title from text: first sentence, at most `maxWords` words. */
export function makeTitle(text: string, maxWords = 15): string {
  const first = text.trim().split(/(?<=[.!?])\s+|\n/)[0] ?? text.trim();
  return clipWords(first.replace(/^[-*#>\s]+/, ""), maxWords).replace(/[.:;,]+$/, "");
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

export function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

export function median(values: number[]): number {
  return quantile(values, 0.5);
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export function daysBetween(a: string | Date, b: string | Date): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / 86_400_000;
}
