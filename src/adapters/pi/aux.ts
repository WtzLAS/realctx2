/**
 * Aux sessions in pi (§9.3): model calls go through `ctx.modelRegistry.streamSimple`, inside the
 * extension process, so any provider pi knows works with the user's own login.
 *
 * - Transcript-only roles: one completion, the schema in the prompt, JSON out.
 * - Repo-checking roles: a small nested agent loop with pi's read-only tools (`read`, `grep`,
 *   `find`, `ls`), realctx2's own read-only tools, and a `submit_result` tool. pi's events do not
 *   fire for it and no other extension is loaded into it.
 */
import type { AssistantMessage, Context, Message, Model, Tool } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { extractJson, insideAux, Limiter, pruneToSchema, renderAuxPrompt, roleSettings, type RoleSettings, runAsAux, validateSchema } from "../../core/aux.ts";
import type { Config } from "../../core/config.ts";
import type { Telemetry } from "../../core/telemetry.ts";
import type { AuxResult, AuxRole, AuxSessionRunner, AuxTask, ModelPricing, ThinkingLevel, ToolDef } from "../../core/types.ts";
import type { MemoryRuntime } from "../../memory/runtime.ts";
import { runSync } from "../../util/git.ts";
import { clipTokens } from "../../util/text.ts";
import { checkAuxBash } from "../guard.ts";

const SUBMIT = "submit_result";
const LEVELS: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** What the runner needs from pi at call time; read fresh on every run, since the context changes per event. */
export interface PiAuxEnv {
  registry(): Pick<ModelRegistry, "find" | "streamSimple"> | null;
  /** The session's current model: the default aux model. */
  model(): Model<any> | undefined;
  cwd(): string;
  root(): string | null;
  memory(): MemoryRuntime | null;
  /** realctx2's own read-only tools for aux sessions (`search` quick, `recall`, `inspect`). */
  ownTools(): ToolDef[];
  /** pi's built-in tools for a directory; injected so tests need no pi runtime. */
  builtinTools?(cwd: string, withBash: boolean): Promise<AuxTool[]>;
}

export interface AuxTool extends Tool {
  execute(toolCallId: string, params: any, signal?: AbortSignal): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
  prepareArguments?: (args: unknown) => unknown;
}

/** `reasoning` for `streamSimple`: the level clamped to what the model supports; undefined for off. */
export function clampThinking(model: Model<any>, level: ThinkingLevel): Exclude<ThinkingLevel, "off"> | undefined {
  if (level === "off" || !model.reasoning) return undefined;
  const map = (model.thinkingLevelMap ?? {}) as Record<string, unknown>;
  const supported = (l: ThinkingLevel) => map[l] !== null;
  let i = LEVELS.indexOf(level);
  // step down to the nearest supported level, then up
  for (let j = i; j >= 0; j--) if (supported(LEVELS[j]!)) return LEVELS[j] as Exclude<ThinkingLevel, "off">;
  for (i = i + 1; i < LEVELS.length; i++) if (supported(LEVELS[i]!)) return LEVELS[i] as Exclude<ThinkingLevel, "off">;
  return undefined;
}

async function piBuiltins(cwd: string, withBash: boolean): Promise<AuxTool[]> {
  // provided by pi at run time; realctx2 lists it as an optional peer dependency
  const pi = (await import("@earendil-works/pi-coding-agent")) as unknown as { createReadOnlyTools(cwd: string): AuxTool[]; createBashTool(cwd: string): AuxTool };
  const tools = pi.createReadOnlyTools(cwd);
  if (withBash) tools.push(pi.createBashTool(cwd));
  return tools;
}

function textOf(msg: AssistantMessage): string {
  return msg.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n");
}

function gitStatus(root: string | null): Set<string> | null {
  if (!root) return null;
  const res = runSync("git", ["status", "--porcelain=v2", "--untracked-files=all"], root, 10_000);
  return res.code === 0 ? new Set(res.stdout.split("\n").filter(Boolean)) : null;
}

export class PiAuxRunner implements AuxSessionRunner {
  private readonly cfg: Config;
  private readonly env: PiAuxEnv;
  private readonly telemetry?: Telemetry;
  private readonly limiter: Limiter;

  constructor(cfg: Config, env: PiAuxEnv, telemetry?: Telemetry) {
    this.cfg = cfg;
    this.env = env;
    this.telemetry = telemetry;
    this.limiter = new Limiter(cfg.providers.aux.maxConcurrent);
  }

  /** The model a role runs on: `providers.aux.pi` names it as `<provider>/<model-id>`; default: the session's model. */
  modelFor(settings: RoleSettings): Model<any> | undefined {
    const registry = this.env.registry();
    const name = settings.model;
    if (name && registry) {
      const slash = name.indexOf("/");
      const found = slash > 0 ? registry.find(name.slice(0, slash), name.slice(slash + 1)) : undefined;
      if (found) return found;
    }
    return this.env.model();
  }

  pricing(role: AuxRole): ModelPricing | null {
    const model = this.modelFor(roleSettings(this.cfg, "pi", { role, instructions: "", data: [], schema: {} }));
    const c = model?.cost;
    return c ? { input: c.input, output: c.output, cacheRead: c.cacheRead, cacheWrite: c.cacheWrite } : null;
  }

  available(): boolean {
    return !insideAux() && this.env.registry() !== null && this.env.model() !== undefined;
  }

  async run<T>(task: AuxTask<T>): Promise<AuxResult<T>> {
    const empty: AuxResult<T> = { output: null, turns: 0, toolCalls: 0, tokens: { input: 0, output: 0 }, blocked: [], changedFiles: [] };
    // no recursion: an aux session never starts another one (§9.3.2)
    if (insideAux()) return { ...empty, error: "aux sessions cannot start aux sessions" };
    const settings = roleSettings(this.cfg, "pi", task as AuxTask);
    const registry = this.env.registry();
    const model = this.modelFor(settings);
    if (!registry || !model) return { ...empty, error: "no model available" };
    const reverify = task.role === "reverify";
    const budgetKind = reverify && !this.cfg.reverify.countsTowardBudget ? "reverify" : "aux";
    if (budgetKind === "aux" && this.telemetry && this.telemetry.spentToday().aux >= this.cfg.budgets.dailyAuxTokens) {
      this.telemetry.call({ callSite: task.role, kind: "aux", latencyMs: 0, outcome: "skipped", detail: "daily budget", budget: "none" });
      return { ...empty, error: "daily aux budget exhausted" };
    }
    const started = Date.now();
    let result: AuxResult<T>;
    try {
      result = await this.limiter.run(() => runAsAux(task.role, () => this.session(task, settings, registry, model)), task.signal);
    } catch (e) {
      result = { ...empty, error: String((e as Error).message ?? e) };
    }
    const aborted = task.signal?.aborted === true;
    this.telemetry?.call({
      callSite: task.role,
      kind: "aux",
      latencyMs: Date.now() - started,
      inputTokens: result.tokens.input,
      outputTokens: result.tokens.output,
      outcome: result.output !== null ? "ok" : aborted ? "aborted" : result.error === "timeout" ? "timeout" : "error",
      detail: result.error,
      budget: budgetKind,
    });
    return result;
  }

  private async session<T>(task: AuxTask<T>, settings: RoleSettings, registry: Pick<ModelRegistry, "find" | "streamSimple">, model: Model<any>): Promise<AuxResult<T>> {
    const out: AuxResult<T> = { output: null, turns: 0, toolCalls: 0, tokens: { input: 0, output: 0, cacheRead: 0 }, blocked: [], changedFiles: [] };
    const timeout = AbortSignal.timeout(settings.timeoutMs);
    const signal = task.signal ? AbortSignal.any([task.signal, timeout]) : timeout;
    const useTools = settings.tools !== "none";
    const withBash = settings.tools === "read-only+bash";
    const cwd = this.env.root() ?? this.env.cwd();
    const memory = this.env.memory();

    // tools: pi's read-only built-ins for the repository root, realctx2's own, and submit_result
    const tools = new Map<string, AuxTool>();
    if (useTools) {
      try {
        for (const t of await (this.env.builtinTools ?? piBuiltins)(cwd, withBash)) tools.set(t.name, t);
      } catch (e) {
        this.telemetry?.event("aux.tools_unavailable", { error: String((e as Error).message ?? e) });
      }
      for (const def of this.env.ownTools()) {
        tools.set(def.name, {
          name: def.name,
          description: def.description,
          parameters: def.parameters,
          // calls from an aux session are not deliveries and skip the retrieval counters
          execute: async (_id, params, sig) => {
            const r = await def.execute((params ?? {}) as Record<string, unknown>, { aux: true, signal: sig });
            return { content: [{ type: "text", text: r.text }], isError: r.isError };
          },
        });
      }
    }
    const submit: Tool = { name: SUBMIT, description: "Return the final result. Call it exactly once, when you are done.", parameters: task.schema };
    const prompt = renderAuxPrompt(task as AuxTask, settings, { schemaInPrompt: !useTools, submitTool: useTools ? SUBMIT : undefined });
    const messages: Message[] = [{ role: "user", content: prompt.user, timestamp: Date.now() }];
    const reasoning = clampThinking(model, settings.thinking);
    const before = withBash ? gitStatus(this.env.root()) : null;

    const complete = async (toolList: Tool[]): Promise<AssistantMessage> => {
      const context: Context = { systemPrompt: prompt.system, messages, ...(toolList.length ? { tools: toolList } : {}) };
      const stream = registry.streamSimple(model, context, {
        signal,
        ...(reasoning ? { reasoning } : { temperature: 0 }),
        maxTokens: Math.min(model.maxTokens || 8192, 16_000),
      });
      const msg = await stream.result();
      out.turns++;
      out.tokens.input += (msg.usage?.input ?? 0) + (msg.usage?.cacheRead ?? 0) + (msg.usage?.cacheWrite ?? 0);
      out.tokens.output += msg.usage?.output ?? 0;
      out.tokens.cacheRead = (out.tokens.cacheRead ?? 0) + (msg.usage?.cacheRead ?? 0);
      return msg;
    };
    const accept = (value: unknown): string[] => {
      const problems = value === undefined ? ["no JSON object found"] : validateSchema(value, task.schema);
      if (!problems.length) out.output = pruneToSchema(value, task.schema) as T;
      return problems;
    };
    const failed = (msg: AssistantMessage): boolean => {
      if (msg.stopReason !== "error" && msg.stopReason !== "aborted") return false;
      out.error = timeout.aborted ? "timeout" : (msg.errorMessage ?? msg.stopReason);
      return true;
    };

    try {
      if (!useTools) {
        // schema-constrained single completion, with one repair turn
        for (let attempt = 0; attempt < 2 && out.output === null; attempt++) {
          const msg = await complete([]);
          if (failed(msg)) break;
          const problems = accept(extractJson(textOf(msg)));
          if (!problems.length) break;
          out.error = `invalid output: ${problems.join("; ")}`;
          messages.push(msg, { role: "user", content: `That did not match the schema (${problems.join("; ")}). Answer again with one JSON object that matches it, and nothing else.`, timestamp: Date.now() });
        }
      } else {
        let repaired = false;
        let asked = false;
        let giveUp = false;
        const all = [...tools.values(), submit];
        for (let turn = 0; out.output === null; turn++) {
          // at the turn limit, the runner asks once for the result
          const final = turn >= settings.maxTurns;
          if (final) {
            if (asked) break;
            asked = true;
            messages.push({ role: "user", content: `You have reached the turn limit. Call ${SUBMIT} now with the best result you have.`, timestamp: Date.now() });
          }
          const msg = await complete(final ? [submit] : all);
          if (failed(msg)) break;
          messages.push(msg);
          const calls = msg.content.filter((c): c is Extract<AssistantMessage["content"][number], { type: "toolCall" }> => c.type === "toolCall");
          if (!calls.length) {
            // prose instead of a tool call: accept JSON if it is there, else ask once
            if (!accept(extractJson(textOf(msg))).length) break;
            if (asked) break;
            asked = true;
            messages.push({ role: "user", content: `Call ${SUBMIT} with the result. Do not answer in prose.`, timestamp: Date.now() });
            continue;
          }
          for (const call of calls) {
            const reply = (text: string, isError = false) => messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text }], isError, timestamp: Date.now() } as Message);
            if (out.output !== null) {
              reply("Skipped: the result was already submitted.");
              continue;
            }
            if (call.name === SUBMIT) {
              const problems = accept(call.arguments);
              if (!problems.length) reply("Result received.");
              else if (!repaired) {
                repaired = true;
                reply(`The result does not match the schema: ${problems.join("; ")}. Call ${SUBMIT} again with a corrected result.`, true);
              } else {
                // one repair turn only: the role's fail-safe applies
                reply("The result still does not match the schema.", true);
                out.error = `invalid output: ${problems.join("; ")}`;
                giveUp = true;
              }
              continue;
            }
            out.toolCalls++;
            const tool = final ? undefined : tools.get(call.name);
            if (!tool) {
              reply(`No such tool: ${call.name}. Available: ${all.map((t) => t.name).join(", ")}.`, true);
              continue;
            }
            if (call.name === "bash") {
              const command = String((call.arguments as { command?: unknown }).command ?? "");
              const reason = checkAuxBash(command, { cfg: this.cfg, cwd, root: this.env.root(), memory });
              if (reason) {
                out.blocked.push(`${command.slice(0, 120)} — ${reason}`);
                memory?.noteAuxBlocked(task.role, command, reason);
                reply(`Refused: ${reason}. This helper is read-only.`, true);
                continue;
              }
            }
            try {
              const args = tool.prepareArguments ? tool.prepareArguments(call.arguments) : call.arguments;
              const res = await tool.execute(call.id, args, signal);
              const text = res.content.map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type}]`)).join("\n");
              reply(clipTokens(text, 6000), res.isError === true);
            } catch (e) {
              reply(`Tool error: ${String((e as Error).message ?? e)}`, true);
            }
          }
          if (giveUp) break;
        }
      }
    } catch (e) {
      out.error = timeout.aborted ? "timeout" : String((e as Error).message ?? e);
    }
    if (out.output !== null) out.error = undefined;
    else if (!out.error) out.error = timeout.aborted ? "timeout" : "no valid result";

    // change watch: nothing is reverted, the change is reported (§9.3.2)
    if (before) {
      const after = gitStatus(this.env.root());
      if (after) {
        out.changedFiles = [...after].filter((l) => !before.has(l)).map((l) => l.split(" ").at(-1) ?? l);
        if (out.changedFiles.length) memory?.noteAuxChanges(task.role, out.changedFiles);
      }
    }
    return out;
  }
}
