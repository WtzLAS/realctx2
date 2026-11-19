/**
 * The engine host for a Claude Code session (§4.6.1): the plugin's MCP server. It is a
 * long-lived process that holds the stores and the session state, exposes the agent tools over
 * MCP, and answers the plugin's hooks over a local socket.
 *
 * Every hook fails open: on an error the answer is empty and Claude Code carries on (§4.6).
 * With `REALCTX2_CHILD=1` (a process realctx2 started itself) it runs in aux mode: only
 * `search` (quick), `recall` and `inspect`, forwarded to the parent session's engine.
 */
import type { Server } from "node:net";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { runCommand } from "../../commands/index.ts";
import type { PendingDelivery } from "../../context/engine.ts";
import { type Config, Layout, loadConfig } from "../../core/config.ts";
import { Host, type HostOptions } from "../../core/host.ts";
import type { AuxSessionRunner, CommandIO, ToolResultPayload } from "../../core/types.ts";
import type { PathEvent } from "../../memory/delivery.ts";
import { AUX_TOOL_KEYS, buildTools, type ToolKey, toolNames } from "../../tools/index.ts";
import { existsSync, readJson, removeFile, writeJson } from "../../util/fs.ts";
import { clipTokens } from "../../util/text.ts";
import { pathEventOf } from "../pathevents.ts";
import { loadAnySession } from "../sessions.ts";
import { ClaudeAdapter, responseText } from "./adapter.ts";
import { ClaudeAuxRunner, type SpawnFn } from "./aux.ts";
import { McpServer, type McpTool } from "./mcp.ts";
import { disableAutoMemory, syncClaudeMdExcludes } from "./settings.ts";
import { ancestorsOf, listen, register, request, runDir, socketPath } from "./socket.ts";
import { SessionLog } from "./state.ts";
import { TranscriptReader } from "./transcript.ts";

/** Claude Code caps each `additionalContext` string at 10,000 characters. */
export const CONTEXT_CAP = 9500;
/** SessionStart hooks registered for `compact`: one for the prompt section, the rest for the injected state. */
export const INJECTION_PARTS = 4;

const OWN_TOOL = /^mcp__(?:plugin_[A-Za-z0-9_-]*_)?realctx2__(.+)$/;

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  prompt_id?: string;
  agent_id?: string;
  agent_type?: string;
  source?: string;
  model?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  tool_use_id?: string;
  tool_calls?: Array<{ tool_use_id: string; tool_name: string; tool_input?: Record<string, unknown>; tool_response?: unknown }>;
  error?: string;
  last_assistant_message?: string;
  file_path?: string;
  event?: string;
  load_reason?: string;
  reason?: string;
  /** Which SessionStart handler is asking (0: prompt section; 1…: chunks of the injected state). */
  part?: number;
}

export interface ServerOptions {
  input: Readable;
  output: Writable;
  layout?: Layout;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: () => Date;
  /** Test seams, passed through to the session's host and aux runner. */
  host?: Partial<HostOptions>;
  spawn?: SpawnFn;
  claudeVersion?: () => string | null;
  /** Replaces the `claude -p` runner (tests). */
  auxRunner?: AuxSessionRunner;
}

interface Session {
  id: string;
  cwd: string;
  host: Host;
  adapter: ClaudeAdapter;
  log: SessionLog;
  events: Map<string, PathEvent | undefined>;
  deliveries: Map<string, PendingDelivery[][]>;
  subagents: Set<string>;
  injection: { key: string; chunks: string[] } | null;
  prompts: number;
}

/** Split text into chunks of at most `cap` characters, on paragraph boundaries where possible. */
export function chunk(text: string, cap: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const para of text.split("\n\n")) {
    let p = para;
    while (p.length > cap) {
      if (cur) out.push(cur);
      cur = "";
      out.push(p.slice(0, cap));
      p = p.slice(cap);
    }
    if (cur && cur.length + p.length + 2 > cap) {
      out.push(cur);
      cur = p;
    } else cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) out.push(cur);
  return out;
}

export class ClaudeServer {
  readonly layout: Layout;
  readonly aux: boolean;
  session: Session | null = null;
  socket = "";
  private readonly o: ServerOptions;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => Date;
  private readonly cfg: Config;
  private readonly reader = new TranscriptReader();
  private mcp: McpServer | null = null;
  private net: Server | null = null;
  private registryFile = "";
  private queue: Promise<unknown> = Promise.resolve();
  private toolPrefix: string;
  private closing: Promise<void> | null = null;

  constructor(o: ServerOptions) {
    this.o = o;
    this.env = o.env ?? process.env;
    this.now = o.now ?? (() => new Date());
    this.layout = o.layout ?? new Layout();
    this.aux = this.env.REALCTX2_CHILD === "1";
    this.cfg = o.host?.cfg ?? loadConfig(this.layout, null, false).config;
    // a plugin-bundled server's tools are named mcp__plugin_<plugin>_<server>__<tool>
    this.toolPrefix = this.env.REALCTX2_TOOL_PREFIX ?? (this.env.CLAUDE_PLUGIN_ROOT ? "mcp__plugin_realctx2_realctx2__" : "mcp__realctx2__");
  }

  // ───────────── start and stop
  async start(): Promise<void> {
    this.mcp = new McpServer({ input: this.o.input, output: this.o.output, tools: () => this.mcpTools(), instructions: () => "realctx2 keeps long-term memory and the archive of consolidated turns for this session. search looks through both; recall opens an ID; inspect shows where it comes from." });
    if (this.aux) return;
    this.socket = socketPath(this.env.CLAUDE_PLUGIN_DATA, process.pid);
    this.net = await listen(this.socket, (req) => this.dispatch(req));
    this.registryFile = register(runDir(this.layout.claudeCodeDir), { pid: process.pid, socket: this.socket, ancestors: ancestorsOf(process.pid), cwd: this.o.cwd ?? this.env.CLAUDE_PROJECT_DIR ?? process.cwd(), startedAt: this.now().toISOString() });
  }

  /** Resolves when Claude Code closes the MCP connection. */
  get done(): Promise<void> {
    return this.mcp?.done ?? Promise.resolve();
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      await this.queue.catch(() => undefined);
      await this.closeSession(true);
      await new Promise<void>((resolve) => (this.net ? this.net.close(() => resolve()) : resolve()));
      if (this.registryFile) removeFile(this.registryFile);
      if (this.socket && process.platform !== "win32" && existsSync(this.socket)) removeFile(this.socket);
    })();
    return this.closing;
  }

  private async closeSession(spawnWorker: boolean): Promise<void> {
    const s = this.session;
    if (!s) return;
    this.session = null;
    try {
      const batch = await s.host.shutdown({ spawnWorker });
      for (const r of batch.records) s.log.append(r);
    } catch (e) {
      s.host.telemetry.event("cc.shutdown_failed", { error: String((e as Error).message ?? e) });
    }
  }

  // ───────────── sessions (§4.6.6)
  private async open(input: HookInput): Promise<Session | null> {
    const id = input.session_id;
    if (!id) return this.session;
    const cur = this.session;
    if (cur && cur.id === id) {
      if (input.transcript_path) cur.adapter.transcriptPath = input.transcript_path;
      if (input.model) cur.adapter.model = input.model;
      return cur;
    }
    // /clear or /resume inside one Claude Code process: the previous session ends here
    if (cur) await this.closeSession(true);
    const cwd = input.cwd ?? this.o.cwd ?? process.cwd();
    const log = new SessionLog(this.layout, id);
    const source = input.source ?? "resume";
    if (source !== "clear" && log.exists()) log.load();
    else if (source === "fork" && input.transcript_path) {
      // the parent is known when the forked transcript begins with its entries
      const parent = this.reader.read(input.transcript_path).sessionIds.find((sid) => sid !== id && new SessionLog(this.layout, sid).exists());
      if (parent) log.copyFrom(new SessionLog(this.layout, parent));
    }
    let host: Host | null = null;
    const adapter = new ClaudeAdapter(log, {
      reader: this.reader,
      now: this.now,
      aux: (env) =>
        this.o.auxRunner ??
        new ClaudeAuxRunner(
          env.cfg,
          {
            cwd: () => cwd,
            root: () => host?.project.root ?? null,
            memory: () => host?.memory ?? null,
            parentSocket: () => this.socket || null,
            ownToolNames: () => AUX_TOOL_KEYS.map((k) => `${this.toolPrefix}${toolNames(env.cfg)[k]}`),
            spawn: this.o.spawn,
            version: this.o.claudeVersion,
          },
          env.telemetry,
        ),
    });
    adapter.transcriptPath = input.transcript_path;
    if (input.model) adapter.model = input.model;
    host = new Host({
      adapter,
      cwd,
      sessionId: id,
      sessionFile: input.transcript_path,
      // Claude Code asks the user to trust a folder before it runs there
      trusted: this.env.REALCTX2_UNTRUSTED !== "1",
      layout: this.layout,
      toolPrefix: this.toolPrefix,
      clock: this.now,
      loadSession: (s) => loadAnySession(this.layout, s),
      ...this.o.host,
    });
    const session: Session = { id, cwd, host, adapter, log, events: new Map(), deliveries: new Map(), subagents: new Set(), injection: null, prompts: 0 };
    this.session = session;
    await host.start();
    this.afterStart(session, source);
    if (this.registryFile) {
      const reg = readJson<Record<string, unknown>>(this.registryFile, {});
      writeJson(this.registryFile, { ...reg, sessionId: id, cwd });
    }
    return session;
  }

  /** First-session chores: settings realctx2 manages in Claude Code (§4.6.5). */
  private afterStart(s: Session, source: string): void {
    const { host } = s;
    const mem = host.memory;
    try {
      if (host.cfg.claudeCode.disableAutoMemory && disableAutoMemory(this.layout, this.now())) {
        s.adapter.notices.push("realctx2 turned off Claude Code's auto memory, so the two memory systems do not compete. /realctx2:uninstall restores the setting.");
      }
      if (mem && host.project.root) {
        // teammates who pull after someone else ran ingest do not double-load files that reappear
        if (host.cfg.instructions.ignoreAfterIngest) syncClaudeMdExcludes(this.layout, host.project.root, mem.instructions.excludePatterns());
        // a project's first session: its auto-memory notes are imported during idle time
        if (source === "startup" && host.cfg.claudeCode.importAutoMemory && host.project.projectKey) {
          const marker = join(this.layout.projectDir(host.project.projectKey), "auto-memory-import.json");
          if (!existsSync(marker) && mem.instructions.autoMemoryDir()) {
            mem.enqueue({ kind: "auto-memory-import", sessionId: s.id, harness: "claude-code" });
            writeJson(marker, { queuedAt: this.now().toISOString() });
          }
        }
      }
    } catch (e) {
      host.telemetry.event("cc.settings_failed", { error: String((e as Error).message ?? e) });
    }
  }

  // ───────────── tools over MCP
  private mcpTools(): McpTool[] {
    if (this.aux) {
      const parent = this.env.REALCTX2_PARENT_SOCKET;
      return buildTools(() => null, this.cfg, { aux: true }).map((def) => ({
        name: def.name,
        title: def.label,
        description: def.description,
        inputSchema: def.parameters,
        readOnly: true,
        call: async (args) => {
          if (!parent) return { text: "The parent realctx2 session is not reachable.", isError: true };
          const res = (await request(parent, { kind: "tool", name: def.key, params: args }, 60_000)) as { text?: string; isError?: boolean } | null;
          return { text: res?.text ?? "No answer from the parent session.", isError: res?.isError === true || !res };
        },
      }));
    }
    return buildTools(() => this.session?.host.env ?? null, this.cfg, { displayPrefix: this.toolPrefix }).map((def) => ({
      name: def.name,
      title: def.label,
      description: def.description,
      inputSchema: def.parameters,
      readOnly: def.readOnly,
      call: (args) => this.serial(() => this.callTool(def.key as ToolKey, args, false)),
    }));
  }

  private async callTool(key: ToolKey, params: Record<string, unknown>, aux: boolean): Promise<ToolResultPayload> {
    // without hooks (the server configured on its own), the first tool call starts the session
    const s = this.session ?? (await this.open({ session_id: `mcp-${process.pid}`, cwd: this.o.cwd ?? this.env.CLAUDE_PROJECT_DIR ?? process.cwd(), source: "startup" }));
    if (!s) return { text: "realctx2 has not started in this session.", isError: true };
    const def = s.host.tools({ aux }).find((t) => t.key === key);
    if (!def) return { text: `${key} is not available here.`, isError: true };
    const res = await def.execute(params, { aux });
    if (!aux) {
      // the ledger entry is made when PostToolUse reports the call's id
      const list = s.deliveries.get(key) ?? [];
      list.push(((res.details as { deliveries?: PendingDelivery[] } | undefined)?.deliveries ?? []) as PendingDelivery[]);
      if (list.length > 20) list.shift();
      s.deliveries.set(key, list);
    }
    return res;
  }

  // ───────────── the socket: hooks, commands, and tool calls from aux children
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async dispatch(req: Record<string, unknown>): Promise<unknown> {
    if (req.kind === "hook") return this.serial(() => this.hook(req.input as HookInput).catch((e) => this.failOpen("hook", e)));
    if (req.kind === "command") return this.serial(async () => ({ text: await this.command(String(req.line ?? ""), req.session as string | undefined) }));
    if (req.kind === "tool") {
      const key = String(req.name) as ToolKey;
      if (!AUX_TOOL_KEYS.includes(key)) return { text: `${key} is not available to helper sessions.`, isError: true };
      const res = await this.callTool(key, (req.params ?? {}) as Record<string, unknown>, true);
      return { text: res.text, isError: res.isError === true };
    }
    if (req.kind === "ping") return { ok: true, session: this.session?.id ?? null };
    return null;
  }

  private failOpen(where: string, e: unknown): null {
    try {
      this.session?.host.telemetry.event("cc.hook_failed", { where, error: String((e as Error)?.message ?? e) });
    } catch {
      // nothing left to do
    }
    return null;
  }

  async command(line: string, sessionId?: string): Promise<string> {
    const s = this.session ?? (sessionId ? await this.open({ session_id: sessionId, source: "resume" }) : null);
    if (!s) return "realctx2 has not started in this session yet.";
    const out: string[] = [];
    const io: CommandIO = {
      hasUI: false,
      print: (t) => void out.push(t),
      notify: (t, level) => void (level && level !== "info" ? out.push(`${level}: ${t}`) : undefined),
      confirm: async (title, message) => {
        out.push(`${title}: ${message}\nNothing was changed. Run the command again with --yes to confirm.`);
        return false;
      },
    };
    await runCommand(s.host, line, io);
    return out.join("\n\n");
  }

  // ───────────── hooks (§4.6.2)
  private isOwn(toolName: string): ToolKey | null {
    const m = OWN_TOOL.exec(toolName);
    if (!m) return null;
    const prefix = toolName.slice(0, toolName.length - m[1]!.length);
    if (prefix !== this.toolPrefix) {
      // the name Claude Code really uses wins over the guess made at start-up
      this.toolPrefix = prefix;
      if (this.session) this.session.host.toolPrefix = prefix;
    }
    const names = toolNames(this.cfg);
    return (Object.keys(names) as ToolKey[]).find((k) => names[k] === m[1]) ?? null;
  }

  private watchPaths(s: Session): string[] {
    const mem = s.host.memory;
    if (!mem || !s.host.project.root) return [];
    const out = new Set<string>();
    for (const ref of mem.graph.active()) {
      for (const a of mem.paths.displayAnchors(ref)) {
        if (a.anchor.kind !== "file" && a.anchor.kind !== "symbol") continue;
        if (a.entry?.data.status === "live" && a.entry.path) out.add(mem.paths.abs(a.entry.path));
        if (out.size >= 300) return [...out];
      }
    }
    return [...out];
  }

  private context(event: string, text: string | undefined, s: Session | null, extra: Record<string, unknown> = {}): Record<string, unknown> | null {
    const notice = s?.adapter.takeNotices();
    const specific: Record<string, unknown> = { hookEventName: event, ...extra };
    if (text) specific.additionalContext = text.length > CONTEXT_CAP ? `${text.slice(0, CONTEXT_CAP - 60)}\n[… cut at Claude Code's context limit for hooks]` : text;
    if (!text && !Object.keys(extra).length && !notice) return null;
    return { ...(text || Object.keys(extra).length ? { hookSpecificOutput: specific } : {}), ...(notice ? { systemMessage: notice } : {}) };
  }

  async hook(input: HookInput): Promise<Record<string, unknown> | null> {
    const event = input.hook_event_name ?? "";
    if (event === "SessionEnd") {
      // SessionEnd hooks have 1.5 seconds: answer now, flush after
      void this.serial(() => this.closeSession(true));
      return null;
    }
    const s = await this.open(input);
    if (!s) return null;
    const { host, adapter } = s;
    const engine = host.engine;
    const mem = host.memory;
    const sub = !!input.agent_id;
    const rel = (p: string, cwd?: string) => mem?.paths.rel(p, cwd) ?? null;

    switch (event) {
      case "SessionStart": {
        const part = input.part ?? 0;
        const source = input.source ?? "startup";
        if (part === 0) {
          const pieces = [host.promptSection(), host.projectRules()].filter(Boolean);
          // startup with a reloaded state (the server restarted mid-session): the open purposes come along
          if (source !== "compact" && engine.state.stack.length && source === "startup") pieces.push(engine.reinjection());
          return this.context(event, pieces.join("\n\n"), s, { watchPaths: this.watchPaths(s) });
        }
        // this is where consolidation takes effect in Claude Code (§4.6.3)
        if (source !== "compact") return null;
        const key = `${s.id}:${s.prompts}:${engine.state.records.size}`;
        if (s.injection?.key !== key) {
          const budgetChars = (INJECTION_PARTS - 1) * CONTEXT_CAP;
          const text = clipTokens(engine.reinjection(), Math.min(host.cfg.context.reinjectTokens, Math.floor(budgetChars / 4)));
          s.injection = { key, chunks: chunk(text, CONTEXT_CAP) };
          host.telemetry.event("cc.reinjection", { chars: text.length, chunks: s.injection.chunks.length });
        }
        return this.context(event, s.injection.chunks[part - 1], null);
      }

      case "UserPromptSubmit": {
        const prompt = input.prompt ?? "";
        host.noteInput();
        host.refreshConfig();
        s.prompts++;
        // skills and commands are not purposes of their own
        if (prompt.trimStart().startsWith("/")) return this.context(event, adapter.takeOutbox(), s);
        const batch = await engine.onUserMessage(prompt);
        adapter.noteUser(input.prompt_id, prompt);
        await adapter.commit(batch);
        host.updateStatus();
        return this.context(event, adapter.takeOutbox(), s);
      }

      case "PreToolUse": {
        const id = input.tool_use_id ?? "";
        const name = input.tool_name ?? "";
        const own = this.isOwn(name) !== null;
        const pathEvent = own || !mem ? undefined : pathEventOf(name, input.tool_input, { cwd: input.cwd ?? s.cwd, rel });
        if (s.events.size > 500) s.events.clear();
        s.events.set(id, pathEvent);
        if (!sub) adapter.noteToolCall(id, name, input.tool_input ?? {});
        const res = await engine.onToolCall({ toolCallId: id, event: pathEvent, subagent: sub, own });
        if (!res) return null;
        // denied once, with the memories as the reason; the agent repeats the action or changes course
        if (!sub) adapter.noteToolResult(id, name, res.block, true);
        s.events.delete(id);
        return { hookSpecificOutput: { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: res.block } };
      }

      case "PostToolUse":
      case "PostToolUseFailure": {
        const id = input.tool_use_id ?? "";
        const name = input.tool_name ?? "";
        const failed = event === "PostToolUseFailure";
        const key = this.isOwn(name);
        const text = failed ? (input.error ?? "") : responseText(name, input.tool_response);
        const deliveries = key && !failed ? s.deliveries.get(key)?.shift() : undefined;
        const pathEvent = s.events.get(id);
        s.events.delete(id);
        const patch = await engine.onToolResult({ toolCallId: id, toolName: name, text, isError: failed, event: pathEvent, own: key !== null, deliveries, subagent: sub });
        if (!sub) adapter.noteToolResult(id, name, patch?.text ?? text, failed);
        if (!patch || failed) return null;
        const extra: Record<string, unknown> = {};
        if (patch.body !== undefined) {
          // the replacement has to match the tool's output shape; where realctx2 does not know the
          // shape, Claude Code's own output limits apply
          const r = input.tool_response;
          if (typeof r === "string") extra.updatedToolOutput = patch.body;
          else if (r && typeof r === "object" && typeof (r as { stdout?: unknown }).stdout === "string") extra.updatedToolOutput = { ...(r as object), stdout: patch.body, stderr: "" };
        }
        return this.context(event, patch.block, s, extra);
      }

      case "PostToolBatch": {
        if (sub) return null;
        adapter.endBatch(input.tool_calls ?? []);
        const batch = await engine.onTurnEnd();
        await adapter.commit(batch);
        host.telemetry.step({ session: s.id, requestTokens: await adapter.requestTokens(), consolidations: batch.records.filter((r) => r.type === "realctx2.consolidation").length });
        mem?.flushIfDue();
        return this.context(event, adapter.takeOutbox(), s);
      }

      case "Stop": {
        if (sub) return null;
        adapter.noteStop(input.last_assistant_message);
        await adapter.commit(await engine.onTurnEnd());
        if (host.cfg.context.settleConsolidation) await adapter.commit(await engine.onBeforeSettle());
        // side effects only: context returned from Stop would make Claude keep going. What was
        // decided here reaches the model with the next prompt.
        host.noteSettled();
        return null;
      }

      case "SubagentStart": {
        if (input.agent_id) s.subagents.add(input.agent_id);
        return this.context(event, host.promptSection(), null);
      }

      case "SubagentStop": {
        if (input.agent_id) s.subagents.delete(input.agent_id);
        return null;
      }

      case "PreCompact": {
        // finish pending shadow consolidations, so the injection after compaction is complete
        await Promise.race([engine.onIdle().then(() => engine.settleBackground()), new Promise((r) => setTimeout(r, 20_000))]).catch(() => undefined);
        return null;
      }

      case "FileChanged": {
        const r = input.file_path ? rel(input.file_path) : null;
        if (mem && r !== null) {
          if (input.event === "unlink") mem.paths.markAbsent(r);
          else mem.paths.noteWrite(r);
        }
        return { hookSpecificOutput: { hookEventName: event, watchPaths: this.watchPaths(s) } };
      }

      case "InstructionsLoaded": {
        if (input.file_path && host.ignoresInstructionFile(input.file_path)) {
          const msg = `Claude Code loaded ${input.file_path}, an instruction file that was ingested into memory: its rules now reach the model twice. /realctx2:ingest ${input.file_path} re-slices it and deletes it again.`;
          if (!host.problems.includes(msg)) host.problems.push(msg);
          if (mem && host.project.root) syncClaudeMdExcludes(this.layout, host.project.root, mem.instructions.excludePatterns());
        }
        return null;
      }

      default:
        return null;
    }
  }
}

/** Entry point of `bin/realctx2-mcp.js`. */
export async function main(): Promise<number> {
  const server = new ClaudeServer({ input: process.stdin, output: process.stdout });
  await server.start();
  const stop = () => void server.close().finally(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  await server.done;
  await server.close();
  return 0;
}
