import { randomInt } from "node:crypto";
import type { IdType } from "../core/types.ts";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** 8 random base36 characters from a cryptographic generator (§8.1.2). */
export function randomId8(): string {
  let out = "";
  for (let i = 0; i < 8; i++) out += ALPHABET[randomInt(36)];
  return out;
}

/** Draw until `taken` reports no clash. */
export function freshId8(taken: (id: string) => boolean): string {
  for (let i = 0; i < 64; i++) {
    const id = randomId8();
    if (!taken(id)) return id;
  }
  throw new Error("could not draw a free id");
}

export function formatId(type: IdType, id: string): string {
  return `${type}:${id}`;
}

export function bracket(type: IdType, id: string): string {
  return `[${type}:${id}]`;
}

const ID_RE = /^\[?\s*([mtro]):([0-9a-z]{8})\s*\]?$/;

/** Accepts IDs with or without brackets. */
export function parseId(raw: string): { type: IdType; id: string; full: string } | null {
  const m = ID_RE.exec(raw.trim());
  if (!m) return null;
  return { type: m[1] as IdType, id: m[2]!, full: `${m[1]}:${m[2]}` };
}

/** Like `parseId`, and a bare 8-character ID is taken as a memory's (the only kind people type by hand). */
export function parseIdLoose(raw: string): { type: IdType; id: string; full: string } | null {
  const p = parseId(raw);
  if (p) return p;
  const bare = raw.trim();
  return /^[0-9a-z]{8}$/.test(bare) ? { type: "m", id: bare, full: `m:${bare}` } : null;
}

/** All bracketed or bare typed IDs mentioned in a text. */
export function findIds(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b([mtro]):([0-9a-z]{8})\b/g)) out.add(`${m[1]}:${m[2]}`);
  return [...out];
}

/** Deterministic 8-char base36 id from a string (used for r: ids of session entries). */
export function stableId8(input: string, hashHex: (s: string) => string): string {
  const hex = hashHex(input).slice(0, 13); // 52 bits
  const n = BigInt("0x" + hex);
  return n.toString(36).padStart(8, "0").slice(-8);
}
