import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
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
export function writeFileAtomic(path: string, data: string | Uint8Array): void {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export function writeJson(path: string, value: unknown): void {
  writeFileAtomic(path, JSON.stringify(value, null, 2) + "\n");
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

/**
 * OS-level lock file created with O_EXCL. A lock whose owner process is gone, or which is
 * older than `staleMs`, is taken over.
 */
export function tryLock(path: string, staleMs = 10 * 60_000): LockHandle | null {
  ensureDir(dirname(path));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      closeSync(fd);
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          removeFile(path);
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const owner = readJson<{ pid?: number; at?: number }>(path, {});
      const stale = !owner.pid || !pidAlive(owner.pid) || Date.now() - (owner.at ?? 0) > staleMs;
      if (!stale) return null;
      removeFile(path);
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
