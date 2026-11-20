import picomatch from "picomatch";

const cache = new Map<string, (s: string) => boolean>();

/** Repo-path glob (POSIX separators, dotfiles included; `[` and `]` are literal path characters). */
export function pathMatcher(glob: string): (path: string) => boolean {
  const key = "p:" + glob;
  let m = cache.get(key);
  if (!m) {
    m = picomatch(glob, { dot: true, nonegate: true, nobracket: true }) as (s: string) => boolean;
    cache.set(key, m);
  }
  return m;
}

export function globCompiles(glob: string): boolean {
  if (!glob.trim()) return false;
  try {
    picomatch.makeRe(glob, { dot: true, nobracket: true });
    return true;
  } catch {
    return false;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Command-pattern glob over a normalized command line (§6.10.3). `*` matches any run of
 * characters including spaces and slashes; `?` matches one character.
 */
export function commandMatcher(pattern: string): (cmd: string) => boolean {
  const key = "c:" + pattern;
  let m = cache.get(key);
  if (!m) {
    const src = pattern
      .trim()
      .replace(/\s+/g, " ")
      .split("*")
      .map((part) => part.split("?").map(escapeRe).join("."))
      .join(".*");
    const re = new RegExp(`^${src}$`, "s");
    m = (cmd: string) => re.test(cmd);
    cache.set(key, m);
  }
  return m;
}
