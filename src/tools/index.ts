/**
 * The five agent-facing tools (§8.1). Parameters are plain JSON Schema objects; the pi adapter
 * hands them to `registerTool`, the Claude Code adapter to its MCP server.
 */
import type { JSONSchema, ToolCallContext, ToolDef, ToolResultPayload } from "../core/types.ts";
import { errMsg } from "../util/errors.ts";
import { AUX_TOOL_KEYS, fail, TOOL_KEYS, type ToolEnv, type ToolKey, toolNames } from "./env.ts";
import { runInspect } from "./inspect.ts";
import { runForget, runRemember } from "./memwrite.ts";
import { runRecall } from "./recall.ts";
import { runSearch } from "./search.ts";

export { promptSection, PROMPT_SECTION_ID, RULES_SECTION_ID } from "./prompt.ts";
export { AUX_TOOL_KEYS, TOOL_KEYS, type ToolEnv, type ToolKey, toolNames } from "./env.ts";

const ID_DESC = "An ID as shown in context, with or without brackets: m:… (memory), t:… (consolidated turns), r:… (raw turn) or o:… (stored tool output).";

function schemas(aux: boolean): Record<ToolKey, JSONSchema> {
  return {
    search: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", description: "What to look for, in plain words." },
        in: { type: "array", items: { type: "string", enum: ["memory", "turns"] }, description: "Where to look. Default: both long-term memory and earlier turns." },
        where: { type: "string", enum: ["session", "project"], description: 'Turns of this session (default) or of every earlier session of this project ("project").' },
        ...(aux ? {} : { mode: { type: "string", enum: ["quick", "thorough"], description: '"quick" (default) is one fast lookup. "thorough" plans several queries and builds evidence cards; use it for multi-part or historical questions.' } }),
        scopes: { type: "array", items: { type: "string", enum: ["global", "personal", "shared"] }, description: "Restrict memory search to these scopes." },
        path: { type: "string", description: "A repository path: boosts memories anchored there and lists the rules in force at it." },
        history: { type: "boolean", description: "Include superseded memories, with ⟂ markers." },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Maximum hits per kind (default 8)." },
        budget_tokens: { type: "integer", minimum: 200, maximum: 6000, description: "Token budget of the result (default 1,500 quick, 3,000 thorough)." },
      },
    },
    recall: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string", description: ID_DESC },
        page: { type: "integer", minimum: 1, description: "Page of a long result (4,000 tokens per page). Default 1." },
        looking_for: { type: "string", description: "What you hope to find: picks the best-matching page when `page` is not given." },
      },
    },
    inspect: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string", description: ID_DESC },
        include: {
          type: "array",
          items: { type: "string", enum: ["evidence", "neighbors", "history", "sources", "anchors", "stats", "span", "knowledge", "attribution"] },
          description: "Sections to show. Memories: evidence, neighbors, history, sources, anchors, stats, attribution. Consolidated turns: span, knowledge, attribution.",
        },
      },
    },
    remember: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: {
        text: { type: "string", description: "One fact, rule, preference or procedure, written to stand on its own without this conversation." },
        kind: { type: "string", enum: ["fact", "procedure", "preference", "rule", "concept", "episode"], description: "Default: fact." },
        scope: { type: "string", enum: ["global", "personal", "shared"], description: "global: true for the user across projects. personal: this user's work in this repo. shared: true for anyone working on this repo (stored in the repository). Leave out when unsure." },
        paths: { type: "array", items: { type: "string" }, description: "Repository paths or globs the memory belongs to. A directory covers its subtree." },
        commands: { type: "array", items: { type: "string" }, description: 'Command patterns (globs over the command line) that should bring the memory up, e.g. "git push*".' },
        severity: { type: "string", enum: ["must", "should", "may", "info"], description: "For rules." },
        urgency: { type: "string", enum: ["immediate", "hint", "caption", "passive"], description: "immediate: must be known before acting (needs paths or commands). hint: shown in full when its path or command comes up. caption: a one-line reminder. passive: found only by search. Leave out when unsure." },
        pin: { type: "boolean", description: "Protect from automatic forgetting. True only when the user asked to remember this." },
      },
    },
    forget: {
      type: "object",
      additionalProperties: false,
      required: ["target", "reason"],
      properties: {
        target: { type: "string", description: "A memory ID (m:…), or a description that matches exactly one memory." },
        reason: { type: "string", description: "Why it is wrong or obsolete. Stored with the retired memory." },
        purge: { type: "boolean", description: "Permanently remove instead of retiring. Only when the user asked for permanent removal; refused for shared memories." },
      },
    },
  };
}

const RUNNERS: Record<ToolKey, (env: ToolEnv, params: Record<string, unknown>, ctx: ToolCallContext) => Promise<ToolResultPayload>> = {
  search: runSearch,
  recall: runRecall,
  inspect: runInspect,
  remember: runRemember,
  forget: runForget,
};

export interface BuildOptions {
  /** Aux sessions get `search` (quick mode only), `recall` and `inspect` (§9.3.2). */
  aux?: boolean;
  /** Name prefix the harness adds on its own (Claude Code: `mcp__realctx2__`); used in texts only. */
  displayPrefix?: string;
}

export function buildTools(getEnv: () => ToolEnv | null, cfg: ToolEnv["cfg"], opts: BuildOptions = {}): ToolDef[] {
  const names = toolNames(cfg);
  const shown = toolNames(cfg, opts.displayPrefix ?? "");
  const schema = schemas(opts.aux === true);
  const keys = (opts.aux ? AUX_TOOL_KEYS : TOOL_KEYS).filter((k) => (k !== "remember" || cfg.tools.remember) && (k !== "forget" || cfg.tools.forget));
  const meta: Record<ToolKey, { label: string; description: string; snippet: string; guidelines: string[]; readOnly: boolean }> = {
    search: {
      label: "Search memory and turns",
      description: `Search long-term memory and earlier turns of this session or project. Returns memory cards ([m:…]) and turn snippets ([t:…] consolidated, [r:…] raw), each with an ID that ${shown.recall} opens.`,
      snippet: "Search long-term memory and earlier turns (quick or thorough)",
      guidelines: [`Use ${shown.search} before re-deriving something that may already be known: decisions, conventions, earlier failures, where things live.`, `Use ${shown.search} with mode "thorough" only for multi-part or historical questions; it costs several model calls.`],
      readOnly: true,
    },
    recall: {
      label: "Recall archived detail",
      description: "Open the content one level below an ID: the turns behind a consolidated message (t:), a memory's full text and evidence (m:), a raw turn with its neighbors (r:), or a page of a stored tool output (o:). At most 4,000 tokens per page.",
      snippet: "Open the details behind a [t:…], [m:…], [r:…] or [o:…] ID",
      guidelines: [`Before calling ${shown.recall}, state what is missing; recall only gaps that matter for the current step.`],
      readOnly: true,
    },
    inspect: {
      label: "Inspect an ID",
      description: "Show metadata for an ID: a memory's scope, anchors, sources, evidence, neighbors, history and use statistics; a consolidation's span, intent, knowledge and attribution; a raw turn's or stored output's origin.",
      snippet: "Show where a memory or consolidated turn comes from and how it has been used",
      guidelines: [`Use ${shown.inspect} when a memory card looks doubtful: it shows evidence, sources and whether newer memories replace it.`],
      readOnly: true,
    },
    remember: {
      label: "Remember",
      description: "Store one durable piece of knowledge in long-term memory: a fact, rule, preference or procedure that will matter beyond this conversation. Returns the new or merged memory's ID.",
      snippet: "Store something worth keeping in long-term memory",
      guidelines: [`Use ${shown.remember} for knowledge that outlives the task (conventions, pitfalls, decisions and their reasons), not for progress notes.`, `Set pin on ${shown.remember} only when the user asked to remember it.`],
      readOnly: false,
    },
    forget: {
      label: "Forget",
      description: "Retire a memory that is wrong or obsolete. It acts at once: the memory is archived with the reason and leaves retrieval. A description acts only if it matches exactly one memory; otherwise the candidates come back.",
      snippet: "Retire a memory that is wrong or obsolete",
      guidelines: [`Use ${shown.forget} when a memory card turned out wrong; give the reason.`],
      readOnly: false,
    },
  };
  return keys.map((key): ToolDef => {
    const m = meta[key];
    return {
      key,
      name: names[key],
      label: m.label,
      description: m.description,
      promptSnippet: m.snippet,
      promptGuidelines: m.guidelines,
      parameters: schema[key],
      readOnly: m.readOnly,
      async execute(params, ctx) {
        const env = getEnv();
        if (!env) return fail("realctx2 has not finished starting in this session.");
        const call: ToolCallContext = opts.aux ? { ...ctx, aux: true } : ctx;
        try {
          return await RUNNERS[key](env, params ?? {}, call);
        } catch (e) {
          env.memory?.telemetry?.event("tool.failed", { tool: key, error: errMsg(e) });
          return fail(`${names[key]} failed: ${errMsg(e)}`);
        }
      },
    };
  });
}
