#!/usr/bin/env node
/*
 * realctx2 hook client for Claude Code (design §4.6.1). A thin command: it forwards the hook's
 * JSON input to the session's engine host (the plugin's MCP server) over a local socket and
 * prints the host's answer. On any failure or timeout it prints nothing and exits 0, so
 * Claude Code carries on.
 *
 *   realctx2-hook <HookEvent>[:<part>]            hook input on stdin
 *   realctx2-hook command [--session <id>] <line> a /realctx2 command; arguments may come on stdin
 *
 * Only Node built-ins are used, so that every hook starts fast.
 */
"use strict";
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const TIMEOUT_MS = { SessionStart: 25000, UserPromptSubmit: 25000, PreToolUse: 8000, PostToolUse: 12000, PostToolUseFailure: 8000, PostToolBatch: 25000, Stop: 25000, PreCompact: 25000, SessionEnd: 1000, command: 110000 };

function runDir() {
  const home = process.env.REALCTX2_HOME || path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "realctx2");
  return path.join(home, "claude-code", "run");
}

function ancestors(pid, max) {
  const out = [];
  let cur = pid;
  for (let i = 0; i < (max || 8); i++) {
    let parent = 0;
    try {
      const stat = fs.readFileSync("/proc/" + cur + "/stat", "utf8");
      parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    } catch (_) {
      try {
        parent = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(cur)], { encoding: "utf8", timeout: 2000 }).trim());
      } catch (_e) {
        parent = 0;
      }
    }
    if (!parent || parent <= 1) break;
    out.push(parent);
    cur = parent;
  }
  return out;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function registrations() {
  const dir = runDir();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch (_) {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const reg = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (reg && reg.pid && reg.socket && alive(reg.pid)) out.push(reg);
    } catch (_) {
      // a file being written
    }
  }
  return out;
}

/** The server of this session, else the one that shares our nearest ancestor (the same Claude Code process). */
function findServer(sessionId, cwd) {
  const regs = registrations();
  if (!regs.length) return null;
  if (sessionId) {
    const exact = regs.find((r) => r.sessionId === sessionId);
    if (exact) return exact;
  }
  const mine = ancestors(process.pid);
  let best = null;
  for (const reg of regs) {
    for (let d = 0; d < mine.length; d++) {
      if ((reg.ancestors || []).includes(mine[d]) && (!best || d < best.depth)) {
        best = { reg, depth: d };
        break;
      }
    }
  }
  if (best) return best.reg;
  const here = cwd ? regs.filter((r) => r.cwd === cwd && !r.sessionId) : [];
  return here.length === 1 ? here[0] : null;
}

function ask(socket, payload, timeoutMs) {
  return new Promise((resolve) => {
    let buf = "";
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const conn = net.createConnection(socket);
    const timer = setTimeout(() => {
      conn.destroy();
      finish(undefined);
    }, timeoutMs);
    conn.setEncoding("utf8");
    conn.on("connect", () => conn.write(JSON.stringify(payload) + "\n"));
    conn.on("data", (c) => (buf += c));
    conn.on("end", () => {
      try {
        finish(JSON.parse(buf.trim() || "null"));
      } catch (_) {
        finish(undefined);
      }
    });
    conn.on("error", () => finish(undefined));
  });
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", () => resolve(buf));
    setTimeout(() => resolve(buf), 3000).unref();
  });
}

async function locate(sessionId, cwd, waitMs) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const reg = findServer(sessionId, cwd);
    if (reg || Date.now() >= deadline) return reg;
    await new Promise((r) => setTimeout(r, 120));
  }
}

async function main() {
  const argv = process.argv.slice(2);
  // processes realctx2 started itself: hooks stay silent except for enforcing aux Bash policy (design §4.6.4, §9.3.2)
  if (process.env.REALCTX2_CHILD === "1") {
    const [event] = String(argv[0] || "").split(":");
    if (event !== "PreToolUse" || !process.env.REALCTX2_PARENT_SOCKET) return;
    let input = {};
    try {
      input = JSON.parse((await readStdin()) || "{}");
    } catch (_) {
      input = {};
    }
    const tool = String(input.tool_name || "");
    if (tool !== "Bash" && tool !== "bash") return;
    const command = input.tool_input && typeof input.tool_input.command === "string" ? input.tool_input.command : "";
    const budget = Number(process.env.REALCTX2_HOOK_TIMEOUT_MS) || 0;
    const res = await ask(
      process.env.REALCTX2_PARENT_SOCKET,
      { kind: "aux-bash", command, cwd: input.cwd || process.cwd(), role: process.env.REALCTX2_AUX_ROLE || "aux" },
      budget || TIMEOUT_MS.PreToolUse,
    );
    if (res === undefined) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "Blocked by realctx2 aux policy: parent session guard is unreachable.",
        },
      }));
      return;
    }
    if (res && typeof res === "object" && !res.error) process.stdout.write(JSON.stringify(res));
    return;
  }
  const budget = Number(process.env.REALCTX2_HOOK_TIMEOUT_MS) || 0;
  if (argv[0] === "command") {
    let rest = argv.slice(1);
    let session;
    const at = rest.indexOf("--session");
    if (at >= 0) {
      session = rest[at + 1];
      rest = rest.slice(0, at).concat(rest.slice(at + 2));
    }
    const piped = (await readStdin()).trim();
    const line = rest.concat(piped ? [piped] : []).join(" ").trim();
    const reg = await locate(session, process.cwd(), 1500);
    if (!reg) {
      process.stdout.write("realctx2 is not running in this session (its MCP server was not found).\n");
      return;
    }
    // the server answers a long command (ingest, maintain, …) before this wait ends, and shows its result later
    const waitMs = budget || TIMEOUT_MS.command;
    const res = await ask(reg.socket, { kind: "command", line, session, waitMs }, waitMs);
    process.stdout.write((res && typeof res.text === "string" ? res.text : "realctx2 did not answer in time.") + "\n");
    return;
  }
  const [event, part] = String(argv[0] || "").split(":");
  let input = {};
  try {
    input = JSON.parse((await readStdin()) || "{}");
  } catch (_) {
    input = {};
  }
  if (!input.hook_event_name) input.hook_event_name = event;
  if (part) input.part = Number(part);
  // at session start the server may still be coming up: wait for it briefly
  const reg = await locate(input.session_id, input.cwd || process.cwd(), event === "SessionStart" ? 6000 : 0);
  if (!reg) return;
  const res = await ask(reg.socket, { kind: "hook", input }, budget || TIMEOUT_MS[event] || 5000);
  if (res && typeof res === "object" && !res.error) process.stdout.write(JSON.stringify(res));
}

main()
  .catch(() => undefined)
  .finally(() => process.exit(0));
