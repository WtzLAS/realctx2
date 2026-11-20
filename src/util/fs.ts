import { appendFileSync, chmodSync, closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Write through a temp file + rename so readers never see a partial file. */
export function writeFileAtomic(path: string, data: string | Uint8Array, mode?: number): void {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, data, mode !== undefined ? { mode } : undefined);
    if (mode !== undefined) {
      try {
        chmodSync(tmp, mode);
      } catch {
        // ignore chmod failures on filesystems that don't support POSIX modes
      }
    }
    renameSync(tmp, path);
  } catch (e) {
    // a failed write (a full disk, a directory in the way) leaves no temp file behind
    removeFile(tmp);
    throw e;
  }
}

export function writeJson(path: string, value: unknown, mode?: number): void {
  writeFileAtomic(path, JSON.stringify(value, null, 2) + "\n", mode);
}

export function appendJsonl(path: string, value: unknown): void {
  ensureDir(dirname(path));
  appendFileSync(path, JSON.stringify(value) + "\n");
}

export function readJsonl<T>(path: string): T[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // a torn last line after a crash is skipped
    }
  }
  return out;
}

export function listFiles(dir: string, suffix?: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => !suffix || f.endsWith(suffix))
      .sort();
  } catch {
    return [];
  }
}

export function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

export function removeDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface LockHandle {
  release(): void;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function parseOwner(raw: string): { pid?: number; at?: number } {
  try {
    return JSON.parse(raw) as { pid?: number; at?: number };
  } catch {
    return {};
  }
}

/**
 * Remove a lock file judged stale from its contents `observed`. Deleting by path alone would let
 * two contenders that both judged it stale delete each other's fresh lock. Instead the file is
 * renamed aside, which only one contender can do, and checked: if what was moved is not the
 * stale lock (another process took over in between), it is put back. Returns whether the stale
 * lock is gone, so the caller may try to take the lock.
 */
export function takeOverStale(path: string, observed: string): boolean {
  const aside = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.stale`;
  try {
    renameSync(path, aside);
  } catch (e) {
    // ENOENT: another contender removed it first, and the path is free to try
    return (e as NodeJS.ErrnoException).code === "ENOENT";
  }
  if (readText(aside) === observed) {
    removeFile(aside);
    return true;
  }
  // a fresh lock was moved: put it back, unless yet another holder has the path by now
  try {
    linkSync(aside, path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST" && !existsSync(path)) {
      try {
        renameSync(aside, path);
      } catch {
        // nothing more to restore
      }
    }
  }
  removeFile(aside);
  return false;
}

/**
 * OS-level lock file published atomically via hard-link (falling back to O_EXCL).
 * A lock whose owner process is gone, or which is older than `staleMs`, is taken over.
 * Only the holder whose unique token still matches the file may release it.
 */
export function tryLock(path: string, staleMs = 10 * 60_000): LockHandle | null {
  ensureDir(dirname(path));
  const token = randomBytes(12).toString("hex");
  const payload = JSON.stringify({ pid: process.pid, at: Date.now(), token });
  const initGraceMs = Math.min(staleMs, 1000);
  const makeHandle = (): LockHandle => {
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        const cur = readJson<{ token?: string }>(path, {});
        if (cur.token === token) removeFile(path);
      },
    };
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const tmp = `${path}.${process.pid}.${token}.tmp`;
    let created = false;
    try {
      writeFileSync(tmp, payload, { mode: 0o600 });
      try {
        linkSync(tmp, path);
        created = true;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "EEXIST") throw e;
        // Filesystems without hard-link support fall back to O_EXCL.
        const fd = openSync(path, "wx", 0o600);
        try {
          writeSync(fd, payload);
        } finally {
          closeSync(fd);
        }
        created = true;
      } finally {
        removeFile(tmp);
      }
      if (created) return makeHandle();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const raw = readText(path);
      if (raw === null) continue; // released in the meantime
      const owner = parseOwner(raw);
      let stale: boolean;
      if (owner.pid) {
        stale = !pidAlive(owner.pid) || Date.now() - (owner.at ?? 0) > staleMs;
      } else {
        // An unreadable/empty lock may be mid-initialization on the O_EXCL fallback; wait past a brief grace window.
        try {
          stale = Date.now() - statSync(path).mtimeMs > initGraceMs;
        } catch {
          stale = false;
        }
      }
      if (!stale || !takeOverStale(path, raw)) return null;
    }
  }
  return null;
}

export async function withLock<T>(path: string, fn: () => Promise<T> | T, opts: { timeoutMs?: number; staleMs?: number } = {}): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  let delay = 15;
  for (;;) {
    const lock = tryLock(path, opts.staleMs);
    if (lock) {
      try {
        return await fn();
      } finally {
        lock.release();
      }
    }
    if (Date.now() > deadline) throw new Error(`lock timeout: ${path}`);
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(250, delay * 2);
  }
}

export function withLockSync<T>(path: string, fn: () => T, opts: { timeoutMs?: number; staleMs?: number } = {}): T {
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  for (;;) {
    const lock = tryLock(path, opts.staleMs);
    if (lock) {
      try {
        return fn();
      } finally {
        lock.release();
      }
    }
    if (Date.now() > deadline) throw new Error(`lock timeout: ${path}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}

export { existsSync, join };
