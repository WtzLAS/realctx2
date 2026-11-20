/**
 * The local socket between Claude Code's hook commands and the session's engine host (§4.6.1):
 * one JSON request line in, one JSON response line out. The registry under
 * `~/.pi/agent/realctx2/claude-code/run/` tells a hook which socket belongs to its session.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errMsg } from "../../util/errors.ts";
import { ensureDir, existsSync, listFiles, readJson, removeFile, writeJson } from "../../util/fs.ts";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const IDLE_TIMEOUT_MS = 30_000;

export interface Registration {
  pid: number;
  socket: string;
  /** Parent pids of the server, nearest first: Claude Code is among them. */
  ancestors: number[];
  cwd: string;
  startedAt: string;
  sessionId?: string;
}

/** Parent pids of a process, nearest first (Linux: /proc; elsewhere: ps). */
export function ancestorsOf(pid: number, max = 8): number[] {
  const out: number[] = [];
  let cur = pid;
  for (let i = 0; i < max; i++) {
    let parent = 0;
    try {
      const stat = readFileSync(`/proc/${cur}/stat`, "utf8");
      parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    } catch {
      try {
        parent = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(cur)], { encoding: "utf8", timeout: 2000 }).trim());
      } catch {
        parent = 0;
      }
    }
    if (!parent || parent <= 1) break;
    out.push(parent);
    cur = parent;
  }
  return out;
}

export function runDir(claudeCodeDir: string): string {
  return join(claudeCodeDir, "run");
}

function ensurePrivateDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return dir;
  const st = lstatSync(dir);
  const uid = process.getuid?.();
  if (!st.isDirectory() || st.isSymbolicLink() || (uid !== undefined && st.uid !== uid)) {
    const safe = mkdtempSync(join(tmpdir(), "realctx2-"));
    try {
      chmodSync(safe, 0o700);
    } catch {
      // ignore on filesystems without POSIX modes
    }
    return safe;
  }
  try {
    chmodSync(dir, 0o700);
  } catch {
    // ignore on filesystems without POSIX modes
  }
  return dir;
}

/** Unix socket paths are short-lived and length-limited: prefer the plugin data directory, else tmp. */
export function socketPath(pluginData: string | undefined, pid: number): string {
  if (process.platform === "win32") return `\\\\.\\pipe\\realctx2-${pid}`;
  const candidate = pluginData && pluginData.length < 70 ? join(pluginData, "run") : join(tmpdir(), `realctx2-${process.getuid?.() ?? 0}`);
  const dir = ensurePrivateDir(candidate);
  return join(dir, `${pid}.sock`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function register(dir: string, reg: Registration): string {
  ensureDir(dir);
  if (process.platform !== "win32") {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // ignore on filesystems without POSIX modes
    }
  }
  const file = join(dir, `server-${reg.pid}.json`);
  writeJson(file, reg, 0o600);
  return file;
}

export function registrations(dir: string): Registration[] {
  const out: Registration[] = [];
  for (const f of listFiles(dir, ".json")) {
    const reg = readJson<Registration | null>(join(dir, f), null);
    if (!reg?.pid || !reg.socket) continue;
    if (!alive(reg.pid)) {
      removeFile(join(dir, f)); // a server that died without cleaning up
      if (process.platform !== "win32" && existsSync(reg.socket)) removeFile(reg.socket);
      continue;
    }
    out.push(reg);
  }
  return out;
}

/**
 * The server a hook belongs to: the one registered for its session, else the one that shares
 * the hook's nearest ancestor process (both are children of the same Claude Code process).
 */
export function findServer(dir: string, o: { sessionId?: string; pid: number; cwd?: string }): Registration | null {
  const regs = registrations(dir);
  if (!regs.length) return null;
  if (o.sessionId) {
    const exact = regs.find((r) => r.sessionId === o.sessionId);
    if (exact) return exact;
  }
  const mine = ancestorsOf(o.pid);
  let best: { reg: Registration; depth: number } | null = null;
  for (const reg of regs) {
    for (let d = 0; d < mine.length; d++) {
      if (reg.ancestors.includes(mine[d]!) && (!best || d < best.depth)) {
        best = { reg, depth: d };
        break;
      }
    }
  }
  if (best) return best.reg;
  // nothing in common (a detached shell): a single server for this directory is still unambiguous
  const here = o.cwd ? regs.filter((r) => r.cwd === o.cwd && !r.sessionId) : [];
  return here.length === 1 ? here[0]! : null;
}

export type Handler = (request: Record<string, unknown>) => Promise<unknown>;

export function listen(path: string, handler: Handler): Promise<Server> {
  if (process.platform !== "win32" && existsSync(path)) removeFile(path);
  const server = createServer({ allowHalfOpen: true }, (conn) => {
    let buf = "";
    let bytes = 0;
    let handled = false;
    conn.setEncoding("utf8");
    conn.setTimeout(IDLE_TIMEOUT_MS, () => {
      if (!handled) {
        handled = true;
        conn.destroy();
      }
    });
    const run = async (line: string) => {
      if (handled) return;
      handled = true;
      conn.setTimeout(0);
      let out: unknown = null;
      try {
        out = await handler(JSON.parse(line) as Record<string, unknown>);
      } catch (e) {
        out = { error: errMsg(e) };
      }
      if (!conn.destroyed) conn.end(`${JSON.stringify(out ?? null)}\n`);
    };
    conn.on("data", (chunk: string) => {
      if (handled) return;
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > MAX_REQUEST_BYTES) {
        handled = true;
        conn.setTimeout(0);
        conn.end(`${JSON.stringify({ error: "request too large" })}\n`, () => conn.destroy());
        return;
      }
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl >= 0) void run(buf.slice(0, nl));
    });
    conn.on("end", () => {
      if (!handled && buf.trim()) void run(buf);
    });
    conn.on("error", () => undefined);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      if (process.platform !== "win32") {
        try {
          chmodSync(path, 0o600);
        } catch {
          // ignore on non-socket transports
        }
      }
      resolve(server);
    });
  });
}

/** One request to a server; rejects on timeout or a closed socket. */
export function request(path: string, payload: object, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const conn = createConnection(path);
    let buf = "";
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error("timeout"));
    }, timeoutMs);
    conn.setEncoding("utf8");
    conn.on("connect", () => conn.write(`${JSON.stringify(payload)}\n`));
    conn.on("data", (c: string) => (buf += c));
    conn.on("end", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buf.trim() || "null"));
      } catch (e) {
        reject(e as Error);
      }
    });
    conn.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
