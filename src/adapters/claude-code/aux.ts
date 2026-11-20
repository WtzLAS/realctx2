/**
 * Aux sessions in Claude Code (§4.6.4, §9.3): a `claude -p` child process with the user's own
 * Claude Code login. `--bare` is not used, because bare mode skips the login.
 *
 * The child carries `REALCTX2_CHILD=1`: realctx2's hooks do nothing in it, and its MCP server runs
 * in aux mode, offering only `search` (quick), `recall` and `inspect`, forwarded to this session.
 */
import { spawn } from "node:child_process";
import { insideAux, Limiter, pruneToSchema, renderAuxPrompt, roleSettings, type RoleSettings, validateSchema } from "../../core/aux.ts";
import type { Config } from "../../core/config.ts";
import type { Telemetry } from "../../core/telemetry.ts";
import type { AuxResult, AuxSessionRunner, AuxTask, ThinkingLevel } from "../../core/types.ts";
import type { MemoryRuntime } from "../../memory/runtime.ts";
import { errMsg } from "../../util/errors.ts";
import { runSync } from "../../util/git.ts";

export interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
export type SpawnFn = (cmd: string, args: string[], opts: { input: string; env: Record<string, string | undefined>; cwd: string; timeoutMs: number; signal?: AbortSignal }) => Promise<SpawnResult>;

const spawnClaude: SpawnFn = (cmd, args, opts) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let done = false;
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr, timedOut });
    };
    const kill = () => {
      try {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2000).unref();
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    const onAbort = () => kill();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      stderr += String(e.message);
      finish(null);
    });
    child.on("close", (code) => finish(code));
    child.stdin.on("error", () => undefined);
    child.stdin.end(opts.input);
  });

/** `--effort` for a thinking level (§9.3.3); undefined for `off`, which sets MAX_THINKING_TOKENS=0 instead. */
export function effortFor(level: ThinkingLevel): string | undefined {
  if (level === "off") return undefined;
  return level === "minimal" || level === "low" ? "low" : level;
}

export interface ClaudeAuxEnv {
  cwd(): string;
  root(): string | null;
  memory(): MemoryRuntime | null;
  /** Socket of this session's engine host, for the child's MCP server in aux mode. */
  parentSocket(): string | null;
  /** Full names of realctx2's read-only MCP tools, as Claude Code exposes them. */
  ownToolNames(): string[];
  spawn?: SpawnFn;
  /** `claude --version`, e.g. "2.1.326"; injected in tests. */
  version?(): string | null;
  binary?: string;
}

function atLeast(version: string | null, major: number, minor: number, patch: number): boolean {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  if (!m) return false;
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  return v[0]! > major || (v[0] === major && (v[1]! > minor || (v[1] === minor && v[2]! >= patch)));
}

function gitStatus(root: string | null): Set<string> | null {
  if (!root) return null;
  const res = runSync("git", ["status", "--porcelain=v2", "--untracked-files=all"], root, 10_000);
  return res.code === 0 ? new Set(res.stdout.split("\n").filter(Boolean)) : null;
}

export class ClaudeAuxRunner implements AuxSessionRunner {
  private readonly cfg: Config;
  private readonly env: ClaudeAuxEnv;
  private readonly telemetry?: Telemetry;
  private readonly limiter: Limiter;
  private versionCache: string | null | undefined;
  /** USD spent on aux calls in this process (counts toward the user's Claude Code usage). */
  costUsd = 0;

  constructor(cfg: Config, env: ClaudeAuxEnv, telemetry?: Telemetry) {
    this.cfg = cfg;
    this.env = env;
    this.telemetry = telemetry;
    this.limiter = new Limiter(cfg.providers.aux.maxConcurrent);
  }

  version(): string | null {
    if (this.versionCache === undefined) {
      if (this.env.version) this.versionCache = this.env.version();
      else {
        const res = runSync(this.env.binary ?? "claude", ["--version"], this.env.cwd(), 5000);
        this.versionCache = res.code === 0 ? (/(\d+\.\d+\.\d+)/.exec(res.stdout)?.[1] ?? null) : null;
      }
    }
    return this.versionCache;
  }

  available(): boolean {
    return !insideAux() && this.version() !== null;
  }

  /** The command line for one aux session. Exposed for tests and `doctor`. */
  args(task: AuxTask, settings: RoleSettings, system: string): { args: string[]; env: Record<string, string> } {
    const withTools = settings.tools !== "none";
    const env: Record<string, string> = { REALCTX2_CHILD: "1", REALCTX2_AUX_ROLE: task.role };
    const socket = this.env.parentSocket();
    if (socket) env.REALCTX2_PARENT_SOCKET = socket;
    const args = ["-p", "--model", settings.model ?? "haiku", "--output-format", "json", "--json-schema", JSON.stringify(task.schema), "--no-session-persistence", "--system-prompt", system];
    // the structured result takes a turn of its own, after the model's last one
    args.push("--max-turns", String(settings.maxTurns + 1));
    const effort = effortFor(settings.thinking);
    if (effort) args.push("--effort", effort);
    else env.MAX_THINKING_TOKENS = "0";
    // prompts that nobody is there to answer are denied instead of waiting
    if (atLeast(this.version(), 2, 1, 259)) args.push("--permission-prompts", "none");
    else args.push("--permission-mode", "dontAsk");
    if (!withTools) args.push("--tools", "", "--disallowedTools", "mcp__*", "--strict-mcp-config");
    else {
      const builtin = ["Read", "Grep", "Glob", ...(settings.tools === "read-only+bash" ? ["Bash"] : [])];
      const own = this.env.ownToolNames();
      args.push("--tools", builtin.join(","), "--allowedTools", [...builtin.filter((t) => t !== "Bash"), ...own].join(","));
    }
    return { args, env };
  }

  async run<T>(task: AuxTask<T>): Promise<AuxResult<T>> {
    const empty: AuxResult<T> = { output: null, turns: 0, toolCalls: 0, tokens: { input: 0, output: 0 }, blocked: [], changedFiles: [] };
    if (insideAux()) return { ...empty, error: "aux sessions cannot start aux sessions" };
    if (!this.available()) return { ...empty, error: "the claude CLI is not available" };
    const settings = roleSettings(this.cfg, "claudeCode", task as AuxTask);
    const budgetKind = task.role === "reverify" && !this.cfg.reverify.countsTowardBudget ? "reverify" : "aux";
    if (budgetKind === "aux" && this.telemetry && this.telemetry.spentToday().aux >= this.cfg.budgets.dailyAuxTokens) {
      this.telemetry.call({ callSite: task.role, kind: "aux", latencyMs: 0, outcome: "skipped", detail: "daily budget", budget: "none" });
      return { ...empty, error: "daily aux budget exhausted" };
    }
    const started = Date.now();
    let result: AuxResult<T>;
    try {
      result = await this.limiter.run(() => this.session(task, settings), task.signal);
    } catch (e) {
      result = { ...empty, error: errMsg(e) };
    }
    this.telemetry?.call({
      callSite: task.role,
      kind: "aux",
      latencyMs: Date.now() - started,
      inputTokens: result.tokens.input,
      outputTokens: result.tokens.output,
      outcome: result.output !== null ? "ok" : task.signal?.aborted ? "aborted" : result.error === "timeout" ? "timeout" : "error",
      detail: result.error,
      budget: budgetKind,
    });
    return result;
  }

  private async session<T>(task: AuxTask<T>, settings: RoleSettings): Promise<AuxResult<T>> {
    const out: AuxResult<T> = { output: null, turns: 0, toolCalls: 0, tokens: { input: 0, output: 0, cacheRead: 0 }, blocked: [], changedFiles: [] };
    const withTools = settings.tools !== "none";
    // the schema travels through --json-schema, so the prompt only frames the data
    const prompt = renderAuxPrompt(task as AuxTask, settings, { schemaInPrompt: false });
    const system = prompt.system.replace("Answer with a single JSON object that matches the schema. No prose, no code fence.", "Return the result as structured output.");
    const { args, env } = this.args(task as AuxTask, settings, system);
    const cwd = this.env.root() ?? this.env.cwd();
    const before = withTools ? gitStatus(this.env.root()) : null;
    const deadline = Date.now() + settings.timeoutMs;
    let input = prompt.user;
    // one repair turn: a second call that names what was wrong with the first answer
    for (let attempt = 0; attempt < 2 && out.output === null; attempt++) {
      const left = deadline - Date.now();
      if (left < 1000) {
        out.error = "timeout";
        break;
      }
      const res = await (this.env.spawn ?? spawnClaude)(this.env.binary ?? "claude", args, { input, env: { ...process.env, ...env }, cwd, timeoutMs: left, signal: task.signal });
      if (res.timedOut) {
        out.error = "timeout";
        break;
      }
      if (task.signal?.aborted) {
        out.error = "aborted";
        break;
      }
      let json: Record<string, unknown> | null = null;
      try {
        json = JSON.parse(res.stdout.trim().split("\n").at(-1) ?? "") as Record<string, unknown>;
      } catch {
        out.error = `claude exited with ${res.code}: ${(res.stderr || res.stdout).trim().slice(0, 300)}`;
        break;
      }
      const usage = (json.usage ?? {}) as Record<string, number>;
      out.turns += typeof json.num_turns === "number" ? json.num_turns : 1;
      out.tokens.input += (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
      out.tokens.output += usage.output_tokens ?? 0;
      out.tokens.cacheRead = (out.tokens.cacheRead ?? 0) + (usage.cache_read_input_tokens ?? 0);
      if (typeof json.total_cost_usd === "number") this.costUsd += json.total_cost_usd;
      const denials = Array.isArray(json.permission_denials) ? (json.permission_denials as Array<{ tool_name?: string }>) : [];
      for (const d of denials) out.blocked.push(`${d.tool_name ?? "tool"} — denied by Claude Code's permission settings`);
      const value = json.structured_output;
      const problems = value === undefined || value === null ? [`no structured output (${String(json.subtype ?? "unknown")})`] : validateSchema(value, task.schema);
      if (!problems.length) {
        out.output = pruneToSchema(value, task.schema) as T;
        out.error = undefined;
        break;
      }
      out.error = `invalid output: ${problems.join("; ")}`;
      if (json.is_error === true && json.subtype !== "error_max_turns") break;
      input = `${prompt.user}\n\nYour previous answer did not match the required schema (${problems.join("; ")}). Return a corrected result.`;
    }
    if (before) {
      const after = gitStatus(this.env.root());
      if (after) {
        out.changedFiles = [...after].filter((l) => !before.has(l)).map((l) => l.split(" ").at(-1) ?? l);
        if (out.changedFiles.length) this.env.memory()?.noteAuxChanges(task.role, out.changedFiles);
      }
    }
    for (const b of out.blocked) this.env.memory()?.noteAuxBlocked(task.role, b, "permission denied");
    if (out.output === null && !out.error) out.error = "no valid result";
    return out;
  }
}
