import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Realctx2SettingsComponent, type SettingsTheme } from "../src/adapters/pi/settings-ui.ts";
import { buildCommand, runCommand } from "../src/commands/index.ts";
import {
  buildAuthHeaders,
  type Config,
  DEFAULT_CONFIG,
  diffConfig,
  Layout,
  loadConfig,
  loadGlobalConfig,
  readSecretFromFile,
  resolveApiKey,
  resolveApiKeyInfo,
  saveConfig,
} from "../src/core/config.ts";
import { type EndpointFetchLike, testEndpoint } from "../src/providers/test-endpoint.ts";
import { Host } from "../src/core/host.ts";
import {
  AUX_ROLES,
  findCategory,
  flattenAllSettings,
  formatSettingValue,
  getConfigPath,
  parseSettingInput,
  SETTINGS_CATEGORIES,
  setConfigPath,
  splitConfigPath,
} from "../src/core/settings-schema.ts";
import type { CommandIO } from "../src/core/types.ts";
import { readJson, writeJson } from "../src/util/fs.ts";
import { FakeAux, FakeDecision } from "./helpers/fakes.ts";
import { cleanupTmp, tmp } from "./helpers/fixtures.ts";
import { FakeHarness } from "./helpers/harness.ts";

const plainTheme: SettingsTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI escape codes in tests
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function renderText(comp: Realctx2SettingsComponent, width = 100): string {
  return comp.render(width).map(stripAnsi).join("\n");
}

function sendKeys(comp: Realctx2SettingsComponent, keys: string[]): void {
  for (const k of keys) comp.handleInput(k);
}

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const ENTER = "\r";
const ESC = "\x1b";
const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";

describe("settings schema completeness & descriptions", () => {
  it("covers every single Config parameter, endpoint, and aux role with descriptions", () => {
    const populated: Config = structuredClone(DEFAULT_CONFIG);
    populated.providers.decision = {
      format: "systemone",
      url: "https://example.test/v1/systemone",
      model: "jev-latest",
      apiKeyEnv: "API_KEY",
      apiKey: "secret",
      apiKeyFile: "/tmp/decider.env",
      maxInputTokens: 30000,
      maxQuestions: 100,
      registerInPi: true,
      headers: { "X-Test": "1" },
    };
    populated.providers.embedding.late = {
      url: "http://127.0.0.1:8000/v1/embeddings",
      model: "colbert",
      kind: "multivector",
      dims: 128,
      dimensions: 128,
      apiKeyEnv: "EMB_KEY",
      apiKey: "secret",
      apiKeyFile: "/tmp/embed.env",
      role: "prefix",
      queryPrefix: "[Q] ",
      documentPrefix: "[D] ",
      maxInputTokens: 512,
      batchSize: 16,
      transport: "embeddings",
      headers: { "X-Emb": "1" },
    };
    populated.providers.embedding.dense = {
      url: "https://api.openai.com/v1/embeddings",
      model: "text-embedding-3-small",
      kind: "dense",
      dims: 1024,
      dimensions: 1024,
      apiKeyEnv: "OPENAI_API_KEY",
      apiKey: "secret",
      apiKeyFile: "/tmp/dense.key",
      role: "none",
      queryPrefix: "",
      documentPrefix: "",
      maxInputTokens: 8192,
      batchSize: 128,
      transport: "embeddings",
      headers: {},
    };
    for (const h of ["pi", "claudeCode"] as const) {
      populated.providers.aux[h].model = "m";
      populated.providers.aux[h].thinking = "medium";
      populated.providers.aux[h].extensions = [];
      populated.providers.aux[h].roles = {};
      for (const r of AUX_ROLES) {
        populated.providers.aux[h].roles![r.role] = {
          model: "m",
          thinking: "low",
          tools: "read-only",
          maxTurns: 3,
          timeoutMs: 10000,
        };
      }
    }

    const all = flattenAllSettings(populated);
    const coveredPaths = new Set(all.map((s) => s.entry.path));

    // Collect every leaf path of `populated`
    const expectedPaths: string[] = [];
    const walk = (obj: unknown, prefix: string) => {
      if (prefix.endsWith(".headers")) {
        expectedPaths.push(prefix);
        return;
      }
      if (prefix === "evolution.hyper.lambda") {
        expectedPaths.push(`${prefix}.0`, `${prefix}.1`, `${prefix}.2`);
        return;
      }
      if (Array.isArray(obj) || obj === null || typeof obj !== "object") {
        expectedPaths.push(prefix);
        return;
      }
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        walk(v, prefix ? `${prefix}.${k}` : k);
      }
    };
    walk(populated, "");

    const missing = expectedPaths.filter((p) => !coveredPaths.has(p));
    expect(missing).toEqual([]);

    // Every category, setting, and enum option has a non-empty description
    for (const cat of SETTINGS_CATEGORIES) {
      expect(cat.description.trim().length).toBeGreaterThan(15);
    }
    for (const item of all) {
      expect(item.entry.label.trim().length).toBeGreaterThan(0);
      expect(item.entry.description.trim().length).toBeGreaterThan(15);
      if ("options" in item.entry && item.entry.options) {
        for (const opt of item.entry.options) {
          expect((opt.description ?? "").trim().length).toBeGreaterThan(5);
        }
      }
    }
  });

  it("handles dotted AuxRole keys and array indices in splitConfigPath / getConfigPath / setConfigPath", () => {
    expect(splitConfigPath("providers.aux.pi.roles.janus.scribe.thinking")).toEqual([
      "providers",
      "aux",
      "pi",
      "roles",
      "janus.scribe",
      "thinking",
    ]);
    expect(splitConfigPath("providers.aux.claudeCode.roles.ingest.slicer.model")).toEqual([
      "providers",
      "aux",
      "claudeCode",
      "roles",
      "ingest.slicer",
      "model",
    ]);
    expect(splitConfigPath("evolution.hyper.lambda.2")).toEqual(["evolution", "hyper", "lambda", "2"]);

    let cfg = structuredClone(DEFAULT_CONFIG);
    cfg = setConfigPath(cfg, "providers.aux.pi.roles.janus.scribe.thinking", "high");
    expect(cfg.providers.aux.pi.roles?.["janus.scribe"]?.thinking).toBe("high");
    expect(getConfigPath(cfg, "providers.aux.pi.roles.janus.scribe.thinking")).toBe("high");

    cfg = setConfigPath(cfg, "evolution.hyper.lambda.1", 2.5);
    expect(cfg.evolution.hyper.lambda).toEqual([0.001, 2.5, 0.1]);
    expect(getConfigPath(cfg, "evolution.hyper.lambda.1")).toBe(2.5);
  });

  it("validates and parses scalar inputs accurately", () => {
    expect(parseSettingInput({ kind: "integer", path: "context.K", label: "K", description: "d", min: 1, max: 50 }, "5")).toEqual({ ok: true, value: 5 });
    expect(parseSettingInput({ kind: "integer", path: "context.K", label: "K", description: "d", min: 1, max: 50 }, "2.5").ok).toBe(false);
    expect(parseSettingInput({ kind: "integer", path: "context.K", label: "K", description: "d", min: 1, max: 50 }, "0").ok).toBe(false);
    expect(parseSettingInput({ kind: "nullable-number", path: "reverify.maxPerDay", label: "m", description: "d", min: 0 }, "")).toEqual({ ok: true, value: null });
    expect(parseSettingInput({ kind: "nullable-number", path: "reverify.maxPerDay", label: "m", description: "d", min: 0 }, "25")).toEqual({ ok: true, value: 25 });
    expect(parseSettingInput({ kind: "number-or-auto", path: "context.climb.expectedRequests", label: "e", description: "d", min: 1 }, "auto")).toEqual({ ok: true, value: "auto" });
    expect(parseSettingInput({ kind: "number-or-auto", path: "context.climb.expectedRequests", label: "e", description: "d", min: 1 }, "42")).toEqual({ ok: true, value: 42 });
    expect(formatSettingValue({ kind: "secret", path: "providers.decision.apiKey", label: "k", description: "d" }, "sk-12345678")).toBe("••••5678");
  });
});

describe("config persistence (diffConfig / saveConfig / loadGlobalConfig)", () => {
  it("writes minimal diffs, preserves unknown keys, and round-trips endpoints and cleared role defaults", () => {
    const dir = tmp("settings-cfg-");
    const layout = new Layout(dir);

    // Seed an existing config with an unknown future key
    writeJson(layout.configFile, { futureFeatureFlag: true });

    // Unchanged default preserves only the unknown key
    const emptyDiff = saveConfig(layout, structuredClone(DEFAULT_CONFIG));
    expect(emptyDiff).toEqual({ futureFeatureFlag: true });

    // Edit context, enable decision endpoint with headers, and clear a claudeCode default role override
    let next = structuredClone(DEFAULT_CONFIG);
    next.context.rho = 0.75;
    next.providers.decision = {
      format: "decisions",
      url: "https://dec.example/v1/decisions",
      model: "gpt-6-luna",
      apiKeyEnv: "DEC_KEY",
      registerInPi: true,
      headers: { "X-Team": "core" },
    };
    next = setConfigPath(next, "providers.aux.pi.roles.janus.scribe.timeoutMs", 25000);
    next = setConfigPath(next, "providers.aux.claudeCode.roles.precip.model", undefined);

    const saved = saveConfig(layout, next);
    expect(saved.futureFeatureFlag).toBe(true);
    expect(saved.context).toEqual({ rho: 0.75 });
    expect((saved.providers as Record<string, unknown>).decision).toEqual(next.providers.decision);

    // Reload and verify exact round-trip
    const reloaded = loadGlobalConfig(layout);
    expect(reloaded.context.rho).toBe(0.75);
    expect(reloaded.providers.decision).toEqual(next.providers.decision);
    expect(reloaded.providers.aux.pi.roles?.["janus.scribe"]?.timeoutMs).toBe(25000);
    expect(reloaded.providers.aux.claudeCode.roles?.precip?.model ?? null).toBeNull();

    // Remove header & disable decision endpoint -> removed cleanly from disk
    next.providers.decision = null;
    next = setConfigPath(next, "providers.aux.pi.roles.janus.scribe.timeoutMs", undefined);
    saveConfig(layout, next);
    const rawAfter = readJson<Record<string, unknown>>(layout.configFile, {});
    expect((rawAfter.providers as Record<string, unknown> | undefined)?.decision).toBeUndefined();
    expect(loadGlobalConfig(layout).providers.decision).toBeNull();
    expect(loadGlobalConfig(layout).providers.aux.pi.roles?.["janus.scribe"]).toBeUndefined();

    // diffConfig directly against DEFAULT_CONFIG produces empty object for defaults
    expect(diffConfig(DEFAULT_CONFIG)).toEqual({});
    cleanupTmp();
  });
});

describe("Realctx2SettingsComponent TUI interactions", () => {
  it("renders categories, enters Context with separated sections, jumps sections, edits & resets parameters", () => {
    let saved: Config = structuredClone(DEFAULT_CONFIG);
    let closed = false;
    const comp = new Realctx2SettingsComponent({
      config: saved,
      effectiveConfig: { ...structuredClone(DEFAULT_CONFIG), context: { ...DEFAULT_CONFIG.context, rho: 0.7 } },
      projectOverrides: ["context.rho"],
      configPath: "/tmp/config.json",
      onSave: (next) => {
        saved = next;
      },
      onClose: () => {
        closed = true;
      },
      theme: plainTheme,
    });

    const home = renderText(comp);
    expect(home).toContain("realctx2 settings");
    expect(home).toContain("Endpoints & Providers");
    expect(home).toContain("Context");
    expect(home).toContain("Memory");
    expect(home).toContain("Index & Storage");
    expect(home).toContain("Tools, Budgets & System");

    // Navigate down to Context and open it
    sendKeys(comp, [DOWN, ENTER]);
    const ctxScreen = renderText(comp);
    expect(ctxScreen).toContain("realctx2 settings › Context");
    expect(ctxScreen).toContain("── Window & Working Tail");
    expect(ctxScreen).toContain("Max effective window (maxWindow)");
    expect(ctxScreen).toContain("context.maxWindow");

    // Quick-step maxWindow with Right arrow (+8192)
    sendKeys(comp, [RIGHT]);
    expect(saved.context.maxWindow).toBe(128000 + 8192);

    // Press 'r' to reset maxWindow back to default
    sendKeys(comp, ["r"]);
    expect(saved.context.maxWindow).toBe(128000);

    // Move to rho and verify project override indicator is displayed
    sendKeys(comp, [DOWN]);
    const onRho = renderText(comp);
    expect(onRho).toContain("context.rho");
    expect(onRho).toContain("[project override: 0.7]");

    // Edit rho via inline text modal: reject invalid value first, then commit 0.85
    sendKeys(comp, [ENTER]);
    // Clear existing "0.8" via ctrl+u, type "2.5", confirm -> validation error
    sendKeys(comp, ["\x15", "2", ".", "5", ENTER]);
    expect(renderText(comp)).toContain("Must be ≤ 0.99");
    sendKeys(comp, ["\x15", "0", ".", "8", "5", ENTER]);
    expect(saved.context.rho).toBe(0.85);

    // Tab jumps to next section: Consolidation (Precip & Palim)
    sendKeys(comp, [TAB]);
    expect(renderText(comp)).toContain("── Consolidation (Precip & Palim)");
    expect(renderText(comp)).toContain("context.Emin");

    // Tab again -> Palim Climb Policy; Shift+Tab -> back to Consolidation
    sendKeys(comp, [TAB]);
    expect(renderText(comp)).toContain("── Palim Climb Policy");
    expect(renderText(comp)).toContain("context.climb.enabled");
    sendKeys(comp, [SHIFT_TAB]);
    expect(renderText(comp)).toContain("context.Emin");

    // Esc back to Home, Esc again closes
    sendKeys(comp, [ESC]);
    expect(renderText(comp)).toContain("── Categories");
    expect(renderText(comp)).toContain("Search:");
    expect(closed).toBe(false);
    sendKeys(comp, [ESC]);
    expect(closed).toBe(true);
  });

  it("supports direct live search on the Home category selector screen (bare /realctx2 settings)", () => {
    let saved: Config = structuredClone(DEFAULT_CONFIG);
    let closed = false;
    const comp = new Realctx2SettingsComponent({
      config: saved,
      configPath: "/tmp/config.json",
      onSave: (next) => {
        saved = next;
      },
      onClose: () => {
        closed = true;
      },
      theme: plainTheme,
    });

    // Bare Home screen displays the search input and all categories
    const initial = renderText(comp);
    expect(initial).toContain("Search:");
    expect(initial).toContain("── Categories");
    expect(initial).toContain("Context");
    expect(initial).toContain("Memory");

    // Typing directly filters both matching categories and settings
    for (const ch of "memory") comp.handleInput(ch);
    const filteredCat = renderText(comp);
    expect(filteredCat).toContain("── Categories");
    expect(filteredCat).toContain("Memory");
    expect(filteredCat).toContain("── Settings (");
    // Enter on top matching category opens Memory screen
    sendKeys(comp, [ENTER]);
    expect(renderText(comp)).toContain("realctx2 settings › Memory");

    // Esc back to Home (search still active), Esc clears search back to full category list
    sendKeys(comp, [ESC]);
    expect(renderText(comp)).toContain("── Settings (");
    sendKeys(comp, [ESC]);
    expect(renderText(comp)).toContain("Endpoints & Providers");
    expect(closed).toBe(false);

    // Type a parameter name directly from Home and edit it right there
    for (const ch of "tauClose") comp.handleInput(ch);
    const filteredParam = renderText(comp);
    expect(filteredParam).toContain("Intent close threshold (tauClose)");
    expect(filteredParam).toContain("context.tauClose");
    sendKeys(comp, [ENTER, "\x15", "0", ".", "8", "8", ENTER]);
    expect(saved.context.tauClose).toBe(0.88);

    // Esc clears search, second Esc closes
    sendKeys(comp, [ESC, ESC]);
    expect(closed).toBe(true);
  });

  it("configures endpoints (decision + headers + masked secret) and pi aux models & roles", () => {
    let saved: Config = structuredClone(DEFAULT_CONFIG);
    const comp = new Realctx2SettingsComponent({
      config: saved,
      configPath: "/tmp/config.json",
      initialCategory: "endpoints",
      availableModels: [
        { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
        { provider: "openai", id: "gpt-4.1-mini", name: "GPT-4.1 Mini" },
      ],
      onSave: (next) => {
        saved = next;
      },
      onClose: () => undefined,
      theme: plainTheme,
    });

    // Opened directly into Endpoints & Providers
    const prov = renderText(comp);
    expect(prov).toContain("realctx2 settings › Endpoints & Providers");
    expect(prov).toContain("── Endpoints");
    expect(prov).toContain("── Auxiliary LLM");
    expect(prov).toContain("── Aux Bash Guard");

    // Enter Decision Model Endpoint
    sendKeys(comp, [ENTER]);
    expect(renderText(comp)).toContain("Enable decision endpoint");
    // Toggle enabled -> reveals Connection & Limits sections
    sendKeys(comp, [ENTER]);
    expect(saved.providers.decision).not.toBeNull();
    const enabledView = renderText(comp);
    expect(enabledView).toContain("── Connection & Authentication");
    expect(enabledView).toContain("── Limits & Pi Integration");

    // Move to Endpoint URL (down from Enabled -> Test endpoint -> format -> url)
    sendKeys(comp, [DOWN, DOWN, DOWN, ENTER]);
    for (const ch of "https://api.example/v1/systemone") comp.handleInput(ch);
    sendKeys(comp, [ENTER]);
    expect(saved.providers.decision?.url).toBe("https://api.example/v1/systemone");

    // Move to API key (literal): down past model & apiKeyEnv -> apiKey
    sendKeys(comp, [DOWN, DOWN, DOWN, ENTER]);
    for (const ch of "super-secret-9999") comp.handleInput(ch);
    // Secret modal must NOT echo typed secret in plaintext
    const modalView = renderText(comp);
    expect(modalView).not.toContain("super-secret-9999");
    expect(modalView).toContain("••••••••");
    sendKeys(comp, [ENTER]);
    expect(saved.providers.decision?.apiKey).toBe("super-secret-9999");
    const maskedOut = renderText(comp);
    expect(maskedOut).toContain("••••9999");
    expect(maskedOut).not.toContain("super-secret-9999");

    // Move to Custom HTTP headers (past apiKeyFile -> headers) and add "X-Env: prod"
    sendKeys(comp, [DOWN, DOWN, ENTER]);
    expect(renderText(comp)).toContain("+ Add header…");
    sendKeys(comp, [ENTER]);
    for (const ch of "X-Env: prod") comp.handleInput(ch);
    sendKeys(comp, [ENTER]);
    expect(saved.providers.decision?.headers).toEqual({ "X-Env": "prod" });
    // Delete header with 'd'
    sendKeys(comp, ["d"]);
    expect(saved.providers.decision?.headers).toBeUndefined();

    // Back out to Endpoints & Providers, jump to Harness Models section, enter pi aux harness
    sendKeys(comp, [ESC, ESC]);
    // Sections: Endpoints (0) -> Auxiliary LLM (1) -> Aux Bash Guard (2) -> Harness Models (3)
    sendKeys(comp, [TAB, TAB, TAB, ENTER]);
    expect(renderText(comp)).toContain("realctx2 settings › Endpoints & Providers › pi aux harness & roles");
    // Open Default aux model -> Model picker opens with availableModels
    sendKeys(comp, [ENTER]);
    const picker = renderText(comp);
    expect(picker).toContain("anthropic/claude-sonnet-4-5");
    expect(picker).toContain("openai/gpt-4.1-mini");
    // Select first model (down from inherit -> anthropic/claude-sonnet-4-5)
    sendKeys(comp, [DOWN, ENTER]);
    expect(saved.providers.aux.pi.model).toBe("anthropic/claude-sonnet-4-5");

    // Jump to Per-Role Overrides section, open janus.scribe, edit thinking level via enum picker
    sendKeys(comp, [TAB, ENTER]);
    expect(renderText(comp)).toContain("janus.scribe");
    // Move to thinking level (down from model override -> thinking)
    sendKeys(comp, [DOWN, ENTER]);
    // Enum picker: inherit (0), off (1), minimal (2), low (3), medium (4), high (5)...
    sendKeys(comp, [DOWN, DOWN, DOWN, ENTER]); // low
    expect(saved.providers.aux.pi.roles?.["janus.scribe"]?.thinking).toBe("low");
  });

  it("supports Memory multi-enum checklist, enum picker, string-list editor, and global / search", () => {
    let saved: Config = structuredClone(DEFAULT_CONFIG);
    const comp = new Realctx2SettingsComponent({
      config: saved,
      configPath: "/tmp/config.json",
      initialCategory: "memory",
      onSave: (next) => {
        saved = next;
      },
      onClose: () => undefined,
      theme: plainTheme,
    });

    expect(renderText(comp)).toContain("realctx2 settings › Memory");
    expect(renderText(comp)).toContain("── Graph Weights & Soft Caps");

    // Global search with '/' for "instructions.include"
    sendKeys(comp, ["/"]);
    for (const ch of "instructions.include") comp.handleInput(ch);
    expect(renderText(comp)).toContain("Included instruction sources");
    // Open multi-enum checklist
    sendKeys(comp, [ENTER]);
    expect(renderText(comp)).toContain("[x] agents");
    // Toggle off "agents"
    sendKeys(comp, [" "]);
    expect(saved.instructions.include).toEqual(["claude", "local", "rules"]);

    // Escape checklist, search for "evolution.policy", pick "rules"
    sendKeys(comp, [ESC, "\x15"]);
    for (const ch of "evolution.policy") comp.handleInput(ch);
    sendKeys(comp, [ENTER]);
    // Current is "teacher" (index 0); move down twice to "rules"
    sendKeys(comp, [DOWN, DOWN, ENTER]);
    expect(saved.evolution.policy).toBe("rules");

    // Search for "guard.deny", open string-list editor, add a pattern
    sendKeys(comp, ["\x15"]);
    for (const ch of "guard.deny") comp.handleInput(ch);
    sendKeys(comp, [ENTER]);
    sendKeys(comp, ["a"]);
    for (const ch of "terraform destroy*") comp.handleInput(ch);
    sendKeys(comp, [ENTER]);
    expect(saved.providers.aux.guard.deny).toContain("terraform destroy*");
  });
});

describe("/realctx2 settings command & Host.reloadConfig", () => {
  it("dispatches settings subcommand, validates categories, provides completions, and live-reloads Host", async () => {
    const cwd = tmp("settings-cwd-");
    const home = tmp("settings-home-");
    const layout = new Layout(home);
    const adapter = new FakeHarness(new FakeAux());
    let seenDecisionCfg: unknown = undefined;
    const host = new Host({
      adapter,
      cwd,
      sessionId: "sess-settings",
      trusted: false,
      layout,
      decision: new FakeDecision(),
      onDecisionConfig: (c) => {
        seenDecisionCfg = c;
      },
    });
    await host.start();

    const printed: string[] = [];
    const opened: Array<string | undefined> = [];
    const ioWithUI: CommandIO = {
      hasUI: true,
      print: (t) => printed.push(t),
      notify: () => undefined,
      confirm: async () => false,
      openSettings: async (cat) => {
        opened.push(cat);
      },
    };

    // Opens settings screen and forwards category
    await runCommand(host, "settings", ioWithUI);
    await runCommand(host, "settings memory", ioWithUI);
    expect(opened).toEqual([undefined, "memory"]);

    // Invalid category prints helpful error
    await runCommand(host, "settings nonexistent", ioWithUI);
    expect(printed.at(-1)).toContain('Unknown settings category "nonexistent"');

    // Non-TUI fallback prints config path and category summaries
    const ioNoTui: CommandIO = {
      hasUI: false,
      print: (t) => printed.push(t),
      notify: () => undefined,
      confirm: async () => false,
    };
    await runCommand(host, "settings", ioNoTui);
    expect(printed.at(-1)).toContain(layout.configFile);
    expect(printed.at(-1)).toContain("Context (context)");
    expect(printed.at(-1)).toContain("Memory (memory)");

    // Completions include settings and its categories
    const cmd = buildCommand(host);
    expect(cmd.completions?.("set")).toContain("settings");
    expect(cmd.completions?.("settings c")).toEqual(["context"]);
    expect(cmd.completions?.("settings ")).toEqual(SETTINGS_CATEGORIES.map((c) => c.id));
    expect(findCategory("endpoints")?.id).toBe("providers");

    // Host.reloadConfig mutates host.cfg in place and notifies onDecisionConfig
    const next = loadGlobalConfig(layout);
    next.context.rho = 0.72;
    next.providers.decision = { format: "systemone", url: "https://live.example/v1/systemone", model: "jev-live", registerInPi: true };
    saveConfig(layout, next);
    host.reloadConfig();
    expect(host.cfg.context.rho).toBe(0.72);
    expect(host.cfg.providers.decision?.model).toBe("jev-live");
    expect(seenDecisionCfg).toMatchObject({ model: "jev-live" });

    // Confirm loadConfig picks up the persisted values for future sessions
    expect(loadConfig(layout).config.context.rho).toBe(0.72);

    await host.shutdown({ spawnWorker: false });
    cleanupTmp();
  });

  it("wires /realctx2 settings through PiExtension in TUI mode to ctx.ui.custom and persists + live-reloads", async () => {
    const cwd = tmp("pi-ext-settings-cwd-");
    const home = tmp("pi-ext-settings-home-");
    const prevHome = process.env.REALCTX2_HOME;
    const prevNoWorker = process.env.REALCTX2_NO_WORKER;
    process.env.REALCTX2_HOME = home;
    process.env.REALCTX2_NO_WORKER = "1";
    try {
      const { default: realctx2 } = await import("../src/adapters/pi/index.ts");
      const handlers = new Map<string, (...args: any[]) => any>();
      const commands = new Map<string, any>();
      const registeredProviders = new Map<string, any>();
      const piMock = {
        on: (ev: string, fn: any) => {
          handlers.set(ev, fn);
          return () => undefined;
        },
        registerTool: () => undefined,
        registerCommand: (name: string, def: any) => commands.set(name, def),
        registerEntryRenderer: () => undefined,
        registerProvider: (name: string, cfg: any) => registeredProviders.set(name, cfg),
        unregisterProvider: (name: string) => registeredProviders.delete(name),
        getAllTools: () => [],
        getSettings: () => ({}),
        appendEntry: () => undefined,
        sendMessage: () => undefined,
      };

      await realctx2(piMock as any);
      expect(commands.has("realctx2")).toBe(true);

      // Completions work for both subcommand and `settings <category>`
      const cmdDef = commands.get("realctx2");
      expect(cmdDef.getArgumentCompletions("set").map((x: any) => x.value)).toContain("settings");
      expect(cmdDef.getArgumentCompletions("settings mem").map((x: any) => x.value)).toEqual(["settings memory"]);
      expect(cmdDef.getArgumentCompletions("settings maint").map((x: any) => x.value)).toEqual(["settings system"]);

      const sessionCtx = {
        cwd,
        hasUI: true,
        mode: "tui",
        isProjectTrusted: () => false,
        sessionManager: {
          getSessionId: () => "pi-settings-sess",
          getSessionFile: () => undefined,
          getBranch: () => [],
          getEntry: () => undefined,
          buildSessionProjection: () => ({ entries: [] }),
        },
        modelRegistry: {
          getAvailable: () => [{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }],
          getAll: () => [],
        },
        model: { provider: "anthropic", id: "claude-sonnet-4-5", contextWindow: 200000 },
        getContextUsage: () => ({ tokens: 1000 }),
        ui: {
          notify: () => undefined,
          setStatus: () => undefined,
          confirm: async () => false,
          editor: async () => undefined,
          custom: async (factory: any) => {
            let resolveDone!: () => void;
            const p = new Promise<void>((r) => {
              resolveDone = r;
            });
            const comp = await factory(
              { requestRender: () => undefined, terminal: { rows: 36 } },
              plainTheme,
              {},
              () => resolveDone(),
            );
            // Opened via bare `/realctx2 settings`: starts on Home category selector with search
            const homeView = renderText(comp);
            expect(homeView).toContain("Search:");
            expect(homeView).toContain("── Categories");
            expect(homeView).toContain("Endpoints & Providers");
            // Open Endpoints & Providers (first category), enable decision endpoint, set URL + model, then close
            sendKeys(comp, [ENTER, ENTER, ENTER]); // enter Providers, enter Decision endpoint, enable it
            sendKeys(comp, [DOWN, DOWN, DOWN, ENTER]); // URL (past Test endpoint & Wire format)
            for (const ch of "https://dec.local/v1/systemone") comp.handleInput(ch);
            sendKeys(comp, [ENTER, DOWN, ENTER]); // model
            for (const ch of "jev-2") comp.handleInput(ch);
            sendKeys(comp, [ENTER, ESC, ESC, ESC]); // save, exit subscreen, exit category, exit home
            await p;
          },
        },
      };

      await handlers.get("session_start")!({ reason: "new" }, sessionCtx);
      expect(registeredProviders.has("realctx2-decision")).toBe(false);

      await cmdDef.handler("settings", sessionCtx);

      // Saved to disk AND live-reloaded into pi's classifier provider immediately!
      const savedDisk = loadGlobalConfig(new Layout(home));
      expect(savedDisk.providers.decision?.url).toBe("https://dec.local/v1/systemone");
      expect(savedDisk.providers.decision?.model).toBe("jev-2");
      expect(registeredProviders.has("realctx2-decision")).toBe(true);

      await handlers.get("session_shutdown")!({}, sessionCtx);
    } finally {
      if (prevHome === undefined) delete process.env.REALCTX2_HOME;
      else process.env.REALCTX2_HOME = prevHome;
      if (prevNoWorker === undefined) delete process.env.REALCTX2_NO_WORKER;
      else process.env.REALCTX2_NO_WORKER = prevNoWorker;
      cleanupTmp();
    }
  });
});

describe("endpoint secrets & auth resolution (pplx-embed-v2 / pplx-decider-v1.3)", () => {
  it("resolves literal, env var (including $VAR), raw token file, and KEY=VALUE env file secrets", () => {
    const dir = tmp("settings-secrets-");
    const envFile = join(dir, "pplx-embed.env");
    const rawFile = join(dir, "raw.key");
    const multiEnvFile = join(dir, "multi.env");
    writeFileSync(envFile, "# systemd EnvironmentFile\nEMBED_API_KEY=\"secret-from-env-file\"\n", "utf8");
    writeFileSync(rawFile, "Bearer   raw-file-token-777  \n", "utf8");
    writeFileSync(multiEnvFile, "HOST=0.0.0.0\nDECIDER_API_KEY='decider-secret-123'\n", "utf8");

    const prevEmbed = process.env.TEST_EMBED_SECRET_ENV;
    process.env.TEST_EMBED_SECRET_ENV = "  Bearer env-token-42  ";
    try {
      // Literal secret trims & strips accidental "Bearer " prefix
      expect(resolveApiKey({ apiKey: "  Bearer lit-key-1 " })).toBe("lit-key-1");
      expect(resolveApiKeyInfo({ apiKey: "lit-key-1" })).toEqual({ key: "lit-key-1", source: "literal" });

      // Env var tolerates optional leading $
      expect(resolveApiKey({ apiKeyEnv: "$TEST_EMBED_SECRET_ENV" })).toBe("env-token-42");
      expect(resolveApiKeyInfo({ apiKeyEnv: "$TEST_EMBED_SECRET_ENV" })).toEqual({
        key: "env-token-42",
        source: "env",
        envVar: "TEST_EMBED_SECRET_ENV",
      });

      // Unset env var reports clear warning
      const missingInfo = resolveApiKeyInfo({ apiKeyEnv: "REALCTX2_DEFINITELY_UNSET_KEY" });
      expect(missingInfo.source).toBe("none");
      expect(missingInfo.key).toBeUndefined();
      expect(missingInfo.warning).toContain("REALCTX2_DEFINITELY_UNSET_KEY");

      // Secret file: systemd EnvironmentFile (KEY=VALUE) and raw single-line file
      expect(readSecretFromFile(envFile)).toEqual({ key: "secret-from-env-file" });
      expect(readSecretFromFile(rawFile)).toEqual({ key: "raw-file-token-777" });
      expect(readSecretFromFile(multiEnvFile)).toEqual({ key: "decider-secret-123" });
      expect(readSecretFromFile(multiEnvFile, "DECIDER_API_KEY")).toEqual({ key: "decider-secret-123" });
      expect(resolveApiKeyInfo({ apiKeyFile: envFile })).toMatchObject({
        key: "secret-from-env-file",
        source: "file",
      });

      // Custom Authorization header deduplication (never emits both Authorization and authorization)
      const h = buildAuthHeaders({
        apiKey: "winner-key",
        headers: { Authorization: "Bearer stale", "X-Custom": "yes" },
      });
      expect(h.authorization).toBe("Bearer winner-key");
      expect(h.Authorization).toBeUndefined();
      expect(h["X-Custom"]).toBe("yes");

      // Custom Authorization header recognized when no apiKey/apiKeyEnv/apiKeyFile
      expect(resolveApiKeyInfo({ headers: { Authorization: "Bearer custom-hdr" } }).source).toBe("header");

      // Saving inline secrets writes config.json with mode 0600
      const layout = new Layout(join(dir, "home"));
      const cfg = structuredClone(DEFAULT_CONFIG);
      cfg.providers.decision = { format: "systemone", url: "http://127.0.0.1:8891/v1/systemone", model: "pplx-decider-v1.3", apiKey: "top-secret-key" };
      saveConfig(layout, cfg);
      const mode = statSync(layout.configFile).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      if (prevEmbed === undefined) delete process.env.TEST_EMBED_SECRET_ENV;
      else process.env.TEST_EMBED_SECRET_ENV = prevEmbed;
      cleanupTmp();
    }
  });
});

describe("live endpoint testing (testEndpoint) & settings Test buttons", () => {
  it("tests decision, late-interaction, and dense endpoints with Bearer auth, 401 diagnostics, and 404 /v1/models discovery", async () => {
    const dir = tmp("endpoint-test-");
    const embedEnvFile = join(dir, "embed.env");
    writeFileSync(embedEnvFile, "EMBED_API_KEY=embed-secret-xyz\n", "utf8");

    const prevDecider = process.env.TEST_DECIDER_API_KEY;
    process.env.TEST_DECIDER_API_KEY = "decider-secret-abc";
    try {
      const seenHeaders: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
      const mockFetch: EndpointFetchLike = async (url, init) => {
        seenHeaders.push({ url, method: init.method, headers: init.headers });
        const auth = init.headers.authorization ?? init.headers.Authorization;

        // Simulate pplx-decider-v1.3-server
        if (url.includes(":8891/v1/systemone")) {
          if (auth !== "Bearer decider-secret-abc") {
            return {
              ok: false,
              status: 401,
              text: async () => JSON.stringify({ error: { type: "invalid_api_key", message: "Missing or invalid Authorization: Bearer <key> header", code: 401 } }),
              json: async () => ({ error: { type: "invalid_api_key", message: "Missing or invalid Authorization: Bearer <key> header", code: 401 } }),
            };
          }
          const body = JSON.parse(init.body ?? "{}");
          if (body.model !== "pplx-decider-v1.3") {
            return {
              ok: false,
              status: 404,
              text: async () => JSON.stringify({ error: { message: `model '${body.model}' is not served here; see GET /v1/models`, code: "model_not_found" } }),
              json: async () => ({}),
            };
          }
          return {
            ok: true,
            status: 200,
            text: async () => "",
            json: async () => ({ answers: { probe: { type: "noul", noul: 0.94 } }, usage: { input_tokens: 12, output_tokens: 0 } }),
          };
        }
        if (url.includes(":8891/v1/models")) {
          return {
            ok: true,
            status: 200,
            text: async () => "",
            json: async () => ({ object: "list", data: [{ id: "pplx-decider-v1.3" }, { id: "perplexity/pplx-decider-latest" }] }),
          };
        }

        // Simulate pplx-embed-v2-server (multivector 128d)
        if (url.includes(":8890/v1/embeddings")) {
          if (auth !== "Bearer embed-secret-xyz") {
            return {
              ok: false,
              status: 401,
              text: async () => JSON.stringify({ error: { type: "authentication_error", message: "missing or invalid API key", code: "invalid_api_key" } }),
              json: async () => ({}),
            };
          }
          const row = Array.from({ length: 128 }, (_, i) => (i === 0 ? 1 : 0));
          return {
            ok: true,
            status: 200,
            text: async () => "",
            json: async () => ({ data: [{ index: 0, shape: [4, 128], embedding: [row, row, row, row] }] }),
          };
        }

        // Simulate dense embedding server
        if (url.includes(":8892/v1/embeddings")) {
          if (auth !== "Bearer dense-literal-key") {
            return { ok: false, status: 401, text: async () => '{"error":{"message":"invalid api key"}}', json: async () => ({}) };
          }
          return {
            ok: true,
            status: 200,
            text: async () => "",
            json: async () => ({ data: [{ index: 0, embedding: [0.6, 0.8, 0] }] }),
          };
        }

        return { ok: false, status: 404, text: async () => "not found", json: async () => ({}) };
      };

      const cfg = structuredClone(DEFAULT_CONFIG);
      // 1. Decision endpoint: 401 when secret missing
      cfg.providers.decision = {
        format: "systemone",
        url: "http://127.0.0.1:8891/v1/systemone",
        model: "pplx-decider-v1.3",
      };
      const decFail = await testEndpoint("decision", cfg, { fetch: mockFetch });
      expect(decFail.ok).toBe(false);
      expect(decFail.status).toBe(401);
      expect(decFail.summary).toContain("401");
      expect(decFail.detail).toContain("DECIDER_API_KEY");

      // 2. Decision endpoint: 200 with apiKeyEnv
      cfg.providers.decision.apiKeyEnv = "TEST_DECIDER_API_KEY";
      const decOk = await testEndpoint("decision", cfg, { fetch: mockFetch });
      expect(decOk.ok).toBe(true);
      expect(decOk.summary).toContain("p=0.94");
      expect(decOk.authSummary).toBe("Bearer via $TEST_DECIDER_API_KEY");
      expect(decOk.detail).not.toContain("decider-secret-abc");

      // 3. Decision endpoint: 404 discovers served models via authenticated GET /v1/models
      cfg.providers.decision.model = "wrong-model";
      const dec404 = await testEndpoint("decision", cfg, { fetch: mockFetch });
      expect(dec404.ok).toBe(false);
      expect(dec404.status).toBe(404);
      expect(dec404.availableModels).toEqual(["pplx-decider-v1.3", "perplexity/pplx-decider-latest"]);
      expect(dec404.detail).toContain("Served models: pplx-decider-v1.3");

      // 4. Late-interaction embedding endpoint: 200 with apiKeyFile (systemd env file)
      cfg.providers.embedding.late = {
        url: "http://127.0.0.1:8890/v1/embeddings",
        model: "perplexity-ai/pplx-embed-v2-late-9b",
        kind: "multivector",
        dims: 128,
        role: "input_type",
        apiKeyFile: embedEnvFile,
      };
      const lateOk = await testEndpoint("late", cfg, { fetch: mockFetch });
      expect(lateOk.ok).toBe(true);
      expect(lateOk.summary).toContain("4×128");
      expect(lateOk.detail).not.toContain("embed-secret-xyz");

      // 5. Dense embedding endpoint: 200 with literal apiKey (never echoed)
      cfg.providers.embedding.dense = {
        url: "http://127.0.0.1:8892/v1/embeddings",
        model: "text-embedding-3-small",
        kind: "dense",
        dimensions: 3,
        apiKey: "dense-literal-key",
      };
      const denseOk = await testEndpoint("dense", cfg, { fetch: mockFetch });
      expect(denseOk.ok).toBe(true);
      expect(denseOk.summary).toContain("3 dims");
      expect(denseOk.authSummary).toBe("Bearer (••••-key)");
      expect(denseOk.detail).not.toContain("dense-literal-key");
    } finally {
      if (prevDecider === undefined) delete process.env.TEST_DECIDER_API_KEY;
      else process.env.TEST_DECIDER_API_KEY = prevDecider;
      cleanupTmp();
    }
  });

  it("renders Test buttons on all three endpoint screens, runs tests via Enter and 't', masks sensitive headers, and clears stale results on edit", async () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.providers.decision = {
      format: "systemone",
      url: "http://127.0.0.1:8891/v1/systemone",
      model: "pplx-decider-v1.3",
      apiKeyEnv: "REALCTX2_TEST_UNSET_VAR",
      headers: { Authorization: "Bearer super-header-secret-5555", "X-Env": "dev" },
    };
    cfg.providers.embedding.late = {
      url: "http://127.0.0.1:8890/v1/embeddings",
      model: "perplexity-ai/pplx-embed-v2-late-9b",
      kind: "multivector",
      dims: 128,
    };
    cfg.providers.embedding.dense = {
      url: "https://api.openai.com/v1/embeddings",
      model: "text-embedding-3-small",
      kind: "dense",
      dimensions: 1024,
    };

    const tested: string[] = [];
    let resolveTest!: (res: Awaited<ReturnType<typeof testEndpoint>>) => void;
    let saved = structuredClone(cfg);
    let renders = 0;

    const comp = new Realctx2SettingsComponent({
      config: saved,
      configPath: "/tmp/config.json",
      initialCategory: "providers",
      onSave: (next) => {
        saved = next;
      },
      onTestEndpoint: (endpoint) => {
        tested.push(endpoint);
        return new Promise((r) => {
          resolveTest = r;
        });
      },
      onClose: () => undefined,
      theme: plainTheme,
      tui: { requestRender: () => { renders++; } },
    });

    // Enter Decision endpoint screen -> see Test endpoint button & unset env indicator
    sendKeys(comp, [ENTER]);
    const decView = renderText(comp);
    expect(decView).toContain("Test endpoint");
    expect(decView).toContain("[ Test endpoint ]");
    expect(decView).toContain("t test");
    expect(decView).toContain("REALCTX2_TEST_UNSET_VAR (unset)");

    // Select Test endpoint row and press Enter -> enters running state
    sendKeys(comp, [DOWN, ENTER]);
    expect(tested).toEqual(["decision"]);
    expect(renderText(comp)).toContain("⟳ Testing…");

    // Resolve test with success -> shows checkmark, summary, and detail
    resolveTest({
      endpoint: "decision",
      ok: true,
      latencyMs: 31,
      summary: "OK · 31ms (p=0.95)",
      detail: 'Decision endpoint (systemone, model "pplx-decider-v1.3") answered probe with p=0.95 in 31ms.',
      authSummary: "custom Authorization header",
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(renders).toBeGreaterThan(0);
    const doneView = renderText(comp);
    expect(doneView).toContain("✓ OK · 31ms (p=0.95)");
    expect(doneView).toContain("answered probe with p=0.95");

    // Check parent Endpoints & Providers screen reflects the test result
    sendKeys(comp, [ESC]);
    expect(renderText(comp)).toContain("✓ OK · 31ms (p=0.95)");

    // Re-enter Decision endpoint, open Custom HTTP headers -> Authorization value is masked!
    sendKeys(comp, [ENTER, TAB, DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, ENTER]);
    const hdrView = renderText(comp);
    expect(hdrView).toContain("Authorization: Bearer ••••5555");
    expect(hdrView).not.toContain("super-header-secret-5555");
    expect(hdrView).toContain("X-Env: dev");

    // Back to Decision endpoint -> Providers -> Late-interaction embedding endpoint, trigger test via 't' hotkey
    sendKeys(comp, [ESC, ESC, DOWN, ENTER]);
    expect(renderText(comp)).toContain("Late-interaction embedding endpoint");
    expect(renderText(comp)).toContain("[ Test endpoint ]");
    sendKeys(comp, ["t"]);
    expect(tested).toEqual(["decision", "late"]);
    resolveTest({
      endpoint: "late",
      ok: false,
      latencyMs: 12,
      status: 401,
      summary: "401 Unauthorized (secret required/invalid)",
      detail: "Probe failed: http 401: missing or invalid API key. Set EMBED_API_KEY.",
      authSummary: "none",
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(renderText(comp)).toContain("✗ 401 Unauthorized");

    // Check Dense embedding endpoint also has Test endpoint button and responds to 't'
    sendKeys(comp, [ESC, DOWN, ENTER]);
    expect(renderText(comp)).toContain("Dense embedding endpoint");
    expect(renderText(comp)).toContain("[ Test endpoint ]");
    sendKeys(comp, ["t"]);
    expect(tested).toEqual(["decision", "late", "dense"]);
    resolveTest({
      endpoint: "dense",
      ok: true,
      latencyMs: 45,
      summary: "OK · 45ms (1024 dims)",
      detail: "Dense embedding endpoint returned a 1024-dim vector in 45ms.",
      authSummary: "none",
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(renderText(comp)).toContain("✓ OK · 45ms (1024 dims)");

    // Editing a setting on Dense endpoint clears its cached test result
    sendKeys(comp, [TAB, ENTER, "x", ENTER]); // edit URL
    expect(renderText(comp)).not.toContain("✓ OK · 45ms (1024 dims)");
  });
});
