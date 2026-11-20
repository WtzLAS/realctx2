/** A real pi session (SDK) with realctx2 loaded as an extension, a scripted model and a local decision endpoint. */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { type AgentSession, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import realctx2 from "../../src/index.ts";
import { ensureDir, writeJson } from "../../src/util/fs.ts";
import { tmp } from "./fixtures.ts";

export type Probs = Record<string, number>;
/** Answers by question name: a number for binary questions, a distribution for choice and score. */
export type Decide = (names: string[], state: any, questions: Record<string, { type: string; instructions: string; criteria?: unknown }>) => Record<string, number | Probs>;

export interface DecisionServer {
  url: string;
  requests: Array<{ names: string[]; state: any }>;
  handler: Decide;
  close(): Promise<void>;
}

/** A SystemOne-format endpoint (§9.1.2). */
export async function decisionServer(): Promise<DecisionServer> {
  // Ensure loopback mock requests bypass any ambient HTTP(S)_PROXY in the test environment.
  for (const key of ["NO_PROXY", "no_proxy"] as const) {
    const items = (process.env[key] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    for (const host of ["127.0.0.1", "localhost"]) if (!items.includes(host)) items.push(host);
    process.env[key] = items.join(",");
  }
  const self: DecisionServer = { url: "", requests: [], handler: () => ({}), close: async () => undefined };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const json = JSON.parse(body) as { state: unknown; questions: Record<string, { type: string; instructions: string; criteria?: unknown }> };
        const names = Object.keys(json.questions);
        self.requests.push({ names, state: json.state });
        const raw = self.handler(names, json.state, json.questions);
        const answers: Record<string, unknown> = {};
        for (const name of names) {
          const v = raw[name];
          const q = json.questions[name]!;
          if (v === undefined) continue;
          if (q.type === "noul") answers[name] = { noul: typeof v === "number" ? v : 0 };
          else if (q.type === "choice") {
            const probs = v as Probs;
            const choice = Object.entries(probs).sort((a, b) => b[1] - a[1])[0]?.[0];
            answers[name] = { choice, probabilities: probs, confidence: choice ? probs[choice] : 0 };
          } else {
            // score: probabilities keyed by level index
            const levels = (q.criteria as string[]).map((c) => c.split(":")[0]!);
            const probs: Record<string, number> = {};
            for (const [label, p] of Object.entries(v as Probs)) probs[String(levels.indexOf(label))] = p;
            answers[name] = { probabilities: probs };
          }
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ answers, usage: { input_tokens: 100, output_tokens: 0 } }));
      } catch (e) {
        res.writeHead(500);
        res.end(String(e));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  self.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/systemone`;
  self.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return self;
}

export interface MainCall {
  /** Role sequence and text of the request, for assertions. */
  roles: string[];
  text: string;
  system: string;
}
export type MainReply = { text?: string; tools?: Array<{ name: string; args: Record<string, unknown> }> };
export type MainStep = MainReply | ((call: MainCall) => MainReply | Promise<MainReply>);

export interface PiRig {
  session: AgentSession;
  modelRuntime: ModelRuntime;
  cwd: string;
  home: string;
  agentDir: string;
  decision: DecisionServer;
  /** Scripted responses of the main model, one per request. */
  main: MainStep[];
  /** Every main-model request seen. */
  calls: MainCall[];
  /** Aux roles answer by the JSON schema they were given: a handler per property name found in it. */
  aux: Array<{ when: string; reply: (user: string, system: string) => unknown }>;
  auxCalls: Array<{ system: string; user: string; tools: string[] }>;
  ui: { notes: Array<{ text: string; level?: string }>; status: Map<string, string | undefined>; confirm: boolean[]; edits: Array<(prefill: string) => string | undefined> };
  errors: unknown[];
  prompt(text: string): Promise<void>;
  /** Fire `session_shutdown` and dispose the session. */
  shutdown(): Promise<void>;
  branch(): Array<{ id: string; type: string; role?: string; customType?: string; text: string; raw: any }>;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((p: any) => (p?.type === "text" ? p.text : p?.type === "toolCall" ? `→ ${p.name}(${JSON.stringify(p.arguments)})` : "")).join("\n") : "";
}

export async function piRig(o: { cwd: string; config?: Record<string, unknown>; home?: string; agentDir?: string; contextWindow?: number; models?: Array<{ id: string; contextWindow: number; maxTokens?: number }>; decision?: DecisionServer; sessionFile?: string; settings?: Record<string, unknown> } = { cwd: "" }): Promise<PiRig> {
  const agentDir = o.agentDir ?? tmp("pi-agent-");
  const home = o.home ?? join(agentDir, "realctx2");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.REALCTX2_HOME = home;
  process.env.REALCTX2_NO_WORKER = "1";
  const decision = o.decision ?? (await decisionServer());
  ensureDir(home);
  writeJson(join(home, "config.json"), {
    providers: { decision: { format: "systemone", url: decision.url, model: "jev-test" } },
    context: { maxWindow: 32000 },
    janus: { lateWaitMs: 200, timeoutMs: 3000 },
    maintenance: { idleMinutes: 600 },
    ...(o.config ?? {}),
  });
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  const fauxModels = (o.models ?? [{ id: "faux-main", contextWindow: o.contextWindow ?? 32000, maxTokens: 4000 }]).map((m) => ({
    id: m.id,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens ?? 4000,
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  }));
  const faux = fauxProvider({ models: fauxModels, tokensPerSecond: 1_000_000 });
  modelRuntime.registerNativeProvider(faux.provider);
  const rig = { main: [] as MainStep[], calls: [] as MainCall[], aux: [] as PiRig["aux"], auxCalls: [] as PiRig["auxCalls"] };
  // one dispatcher answers every request: aux sessions are recognized by their system prompt
  const dispatch = async (ctx: any) => {
    const messages: any[] = ctx.messages;
    const systems = messages.filter((m) => m.role === "system");
    const system = systems.map((m) => `${m.content ?? ""}\n${Object.values(m.sections ?? {}).join("\n")}`).join("\n");
    if (system.includes("helper process for realctx2")) {
      const user = messages.filter((m) => m.role === "user").map((m) => contentText(m.content)).join("\n");
      const tools: string[] = systems.flatMap((m) => (m.tools ?? []).map((t: any) => t.name));
      rig.auxCalls.push({ system, user, tools });
      const h = rig.aux.find((a) => system.includes(a.when));
      const out = h ? h.reply(user, system) : null;
      if (out === null) return fauxAssistantMessage("I cannot help with that.");
      if (tools.includes("submit_result")) return fauxAssistantMessage([fauxToolCall("submit_result", out as never)], { stopReason: "toolUse" });
      return fauxAssistantMessage(JSON.stringify(out));
    }
    const call: MainCall = { roles: messages.map((m) => m.role), text: messages.filter((m) => m.role !== "system").map((m) => `${m.role}: ${contentText(m.content)}`).join("\n"), system };
    rig.calls.push(call);
    const step = rig.main.shift();
    const r = typeof step === "function" ? await step(call) : (step ?? { text: "(nothing scripted)" });
    if (r.tools?.length) return fauxAssistantMessage([...(r.text ? [fauxText(r.text)] : []), ...r.tools.map((t) => fauxToolCall(t.name, t.args as never))], { stopReason: "toolUse" });
    return fauxAssistantMessage(r.text ?? "ok");
  };
  faux.setResponses(Array.from({ length: 400 }, () => dispatch));

  const resourceLoader = new DefaultResourceLoader({ cwd: o.cwd, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: false, extensionFactories: [{ name: "realctx2", factory: realctx2 }] });
  await resourceLoader.reload();
  const sessionDir = join(agentDir, "sessions");
  const sessionManager = o.sessionFile ? SessionManager.open(o.sessionFile, sessionDir) : SessionManager.create(o.cwd, sessionDir);
  const { session } = await createAgentSession({ cwd: o.cwd, agentDir, model: faux.getModel(), thinkingLevel: "off", modelRuntime, resourceLoader, sessionManager, settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, ...(o.settings ?? {}) } as never) });
  const ui: PiRig["ui"] = { notes: [], status: new Map(), confirm: [], edits: [] };
  const errors: unknown[] = [];
  const uiContext = new Proxy(
    {
      notify: (text: string, level?: string) => void ui.notes.push({ text, level }),
      setStatus: (key: string, text: string | undefined) => void ui.status.set(key, text),
      confirm: async () => ui.confirm.shift() ?? true,
      editor: async (_title: string, prefill?: string) => ui.edits.shift()?.(prefill ?? ""),
      select: async () => undefined,
      input: async () => undefined,
    } as Record<string, unknown>,
    { get: (t, k: string) => t[k] ?? (() => undefined) },
  );
  await session.bindExtensions({ uiContext: uiContext as never, mode: "rpc", onError: (e: unknown) => errors.push(e) });
  return {
    session,
    modelRuntime,
    cwd: o.cwd,
    home,
    agentDir,
    decision,
    ...rig,
    ui,
    errors,
    async prompt(text: string) {
      await session.prompt(text);
    },
    async shutdown() {
      await (session as unknown as { _extensionRunner: { emit(e: unknown): Promise<unknown> } })._extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
      if (!o.decision) await decision.close();
    },
    branch() {
      return session.sessionManager.getBranch().map((e: any) => ({
        id: e.id,
        type: e.type,
        role: e.type === "message" ? e.message.role : undefined,
        customType: e.customType,
        text: e.type === "message" ? contentText(e.message.content) : e.type === "custom_message" ? contentText(e.content) : e.type === "compaction" ? e.summary : "",
        raw: e,
      }));
    },
  };
}
