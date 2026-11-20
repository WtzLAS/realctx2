/** Secret scanner (patterns plus an entropy check) and PII detector (§6.3.2 step 4, §7.12). */

export interface SecretFinding {
  type: string;
  start: number;
  end: number;
}

export interface ScanResult {
  redacted: string;
  findings: SecretFinding[];
  pii: string[];
}

const REDACTED = "[secret:redacted]";

const PATTERNS: Array<{ type: string; re: RegExp; group?: number }> = [
  { type: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { type: "aws-access-key", re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}\b/g },
  { type: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { type: "slack-token", re: /\bxox[abeoprs]-[A-Za-z0-9-]{10,}\b/g },
  { type: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { type: "openai-key", re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g },
  { type: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { type: "stripe-key", re: /\b(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g },
  { type: "npm-token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { type: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { type: "bearer", re: /\b[Bb]earer\s+([A-Za-z0-9._~+/-]{20,}=*)/g, group: 1 },
  { type: "url-credentials", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:([^\s/@]{3,})@/gi, group: 1 },
  {
    type: "assigned-secret",
    re: /\b(?:api[_-]?key|apikey|secret|client[_-]?secret|access[_-]?token|auth[_-]?token|token|passwd|password|pwd|private[_-]?key)\b["']?\s*[:=]\s*["']?([^\s"'`,;]{8,})/gi,
    group: 1,
  },
];

function shannonEntropy(s: string): number {
  if (!s) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** High-entropy token check for strings that match no known pattern. */
function looksRandom(token: string): boolean {
  if (token.length < 24) return false;
  if (/^[0-9a-f]+$/i.test(token)) return false; // hashes (git, sha256) are not secrets by themselves
  if (!/[0-9]/.test(token) || !/[A-Za-z]/.test(token)) return false;
  if (/^[\w.-]+\/[\w./-]+$/.test(token) && token.split("/").length > 2) return false; // paths
  // absolute and dot-relative paths: several short segments, none of which is random on its own
  if (/^(?:\.{1,2}|~)?\/[\w.@+-]+(?:\/[\w.@+-]+)+\/?$/.test(token) && token.split("/").every((seg) => seg.length < 32)) return false;
  return shannonEntropy(token) >= 4.2;
}

const PLACEHOLDER = /^(?:x+|\*+|<[^>]+>|\$\{?[A-Z0-9_]+\}?|your[_-]?\w*|changeme|example\w*|redacted|\[secret:redacted\]|null|none|true|false|undefined|process\.env\.\w+)$/i;

const PII: Array<{ type: string; re: RegExp; check?: (m: string) => boolean }> = [
  { type: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, check: (m) => !/@(example|test|localhost)\b|noreply|users\.noreply/i.test(m) },
  { type: "phone", re: /(?<![\w.])\+?\d{1,3}[\s.-]?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\w.])/g },
  { type: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { type: "credit-card", re: /\b(?:\d[ -]?){13,19}\b/g, check: luhn },
];

function luhn(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function scanSecrets(text: string): ScanResult {
  const findings: SecretFinding[] = [];
  for (const { type, re, group } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const value = group ? m[group] : m[0];
      if (!value) continue;
      if (type === "assigned-secret" || type === "url-credentials") {
        if (PLACEHOLDER.test(value)) continue;
        if (type === "assigned-secret" && shannonEntropy(value) < 2.5) continue;
      }
      const start = m.index! + (group ? m[0].lastIndexOf(value) : 0);
      findings.push({ type, start, end: start + value.length });
    }
  }
  for (const m of text.matchAll(/[A-Za-z0-9+/_=-]{24,}/g)) {
    if (looksRandom(m[0])) findings.push({ type: "high-entropy", start: m.index!, end: m.index! + m[0].length });
  }
  // merge overlaps, redact right-to-left
  findings.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: SecretFinding[] = [];
  for (const f of findings) {
    const last = merged[merged.length - 1];
    if (last && f.start < last.end) {
      last.end = Math.max(last.end, f.end);
      continue;
    }
    merged.push({ ...f });
  }
  let redacted = text;
  for (let i = merged.length - 1; i >= 0; i--) {
    const f = merged[i]!;
    redacted = redacted.slice(0, f.start) + REDACTED + redacted.slice(f.end);
  }
  const pii: string[] = [];
  for (const { type, re, check } of PII) {
    re.lastIndex = 0;
    for (const m of redacted.matchAll(re)) {
      if (check && !check(m[0])) continue;
      pii.push(type);
      break;
    }
  }
  return { redacted, findings: merged, pii };
}

export function hasSecrets(text: string): boolean {
  return scanSecrets(text).findings.length > 0;
}
