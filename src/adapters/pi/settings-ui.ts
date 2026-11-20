/**
 * Interactive pi TUI settings screen for `/realctx2 settings`.
 *
 * Hierarchy:
 * - Home screen: categories (Endpoints & Providers, Context, Memory, Index & Storage, Tools/Budgets/System)
 * - Category & subscreens: separated visual sections, aligned labels & values, inline descriptions
 * - Editors: boolean toggles, enum pickers with option descriptions, searchable pi model picker,
 *   numeric/string/secret inputs with live validation, multi-enum checklists, string-list & header-map editors
 * - Global `/` search across every parameter, `Tab`/`[`/`]` section jumping, `←`/`→` quick adjustment, `r` reset
 */
import type { Component, Focusable, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { fuzzyFilter, fuzzyMatch, getKeybindings, Input, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type Config, isSensitiveHeaderName, normalizeEnvVarName, readSecretFromFile } from "../../core/config.ts";
import {
  type ActionEntry,
  type EditableSetting,
  type EnumOption,
  findCategory,
  flattenAllSettings,
  formatModelOverrideValue,
  formatSettingValue,
  getConfigPath,
  getSettingDefault,
  getSettingValue,
  isScalarSetting,
  isSettingModified,
  maskSecret,
  type ModelOverridesSetting,
  parseModelOverrideInput,
  parseSettingInput,
  rawInputValue,
  type ScalarSetting,
  type SearchableSetting,
  SETTINGS_CATEGORIES,
  type SettingEntry,
  type SettingScreenSpec,
  type SettingsDisplayContext,
  setSettingValue,
  stepSettingValue,
  type StringListSetting,
  type StringMapSetting,
} from "../../core/settings-schema.ts";
import {
  type EndpointKind,
  type EndpointModelInfo,
  type EndpointModelsResult,
  type EndpointTestResult,
  fetchEndpointModels,
  modelsUrlFor,
  testEndpoint,
} from "../../providers/test-endpoint.ts";
import { errMsg } from "../../util/errors.ts";

export interface SettingsTheme {
  fg(color: "accent" | "border" | "borderMuted" | "success" | "error" | "warning" | "muted" | "dim" | "text", text: string): string;
  bold(text: string): string;
}

export interface ModelChoice {
  id: string;
  provider: string;
  name?: string;
  contextWindow?: number;
}

export interface Realctx2SettingsOptions {
  /** Initial editable global config (without project overrides baked in). */
  config: Config;
  /** Effective session config (for displaying active project override values). */
  effectiveConfig?: Config;
  /** Keys overridden by trusted project config. */
  projectOverrides?: readonly string[];
  /** Path displayed in header (e.g. ~/.pi/agent/realctx2/config.json). */
  configPath: string;
  /** Live provider health for endpoint status summaries. */
  displayContext?: SettingsDisplayContext;
  /** Available models from pi's modelRegistry for aux model pickers. */
  availableModels?: ModelChoice[];
  /** All known models (configured/available first, then catalog models) for per-model override screens. */
  knownModels?: ModelChoice[];
  /** Optional initial category argument (e.g. "context", "memory", "providers"). */
  initialCategory?: string;
  /** Persist updated global config and reload live host state. */
  onSave: (next: Config) => void;
  /** Optional custom endpoint tester (defaults to live HTTP probe via testEndpoint). */
  onTestEndpoint?: (endpoint: EndpointKind, cfg: Config, signal: AbortSignal) => Promise<EndpointTestResult>;
  /** Optional custom `/v1/models` fetcher for endpoint Model ID pickers (defaults to fetchEndpointModels). */
  onFetchModels?: (endpoint: EndpointKind, cfg: Config, signal: AbortSignal) => Promise<EndpointModelsResult>;
  /** Called when the user closes the settings screen. */
  onClose: () => void;
  theme: SettingsTheme;
  tui?: Pick<TUI, "requestRender"> & { terminal?: { rows?: number } };
}

type ScreenRow =
  | { kind: "section"; title: string; sectionIndex: number }
  | { kind: "entry"; entry: SettingEntry; sectionIndex: number };

type HomeMatch =
  | { kind: "category"; category: (typeof SETTINGS_CATEGORIES)[number] }
  | { kind: "setting"; item: SearchableSetting };

type ViewState =
  | { kind: "home"; input: Input; selected: number }
  | {
      kind: "screen";
      title: string;
      build: (cfg: Config, ctx?: SettingsDisplayContext) => SettingScreenSpec;
      selected: number;
    }
  | { kind: "search"; input: Input; selected: number }
  | { kind: "multi-enum"; entry: StringListSetting; selected: number }
  | { kind: "string-list"; entry: StringListSetting; selected: number }
  | { kind: "string-map"; entry: StringMapSetting; selected: number }
  | { kind: "model-overrides"; entry: ModelOverridesSetting; input: Input; selected: number };

type ModelOverrideRow =
  | { kind: "model"; key: string; name?: string; contextWindow?: number; value: "auto" | number | undefined; custom: boolean }
  | { kind: "add-query"; key: string }
  | { kind: "add-custom" };

type ActiveModal =
  | {
      kind: "text";
      title: string;
      subtitle: string;
      description: string;
      hint: string;
      input: Input;
      error?: string;
      secret?: boolean;
      placeholder?: string;
      onCommit: (raw: string) => string | null;
    }
  | {
      kind: "enum";
      entry: ScalarSetting;
      options: Array<{ value: string | undefined; label: string; description?: string }>;
      selected: number;
    }
  | {
      kind: "model";
      entry: ScalarSetting;
      input: Input;
      selected: number;
    }
  | {
      kind: "endpoint-model";
      endpoint: EndpointKind;
      entry: ScalarSetting;
      input: Input;
      selected: number;
      status: "loading" | "ready" | "error" | "no-url";
      url?: string;
      models: EndpointModelInfo[];
      error?: string;
      abort?: AbortController;
    };

const CUSTOM_MODEL_SENTINEL = "__realctx2_custom_model__";
const INHERIT_MODEL_SENTINEL = "__realctx2_inherit_model__";
const REFRESH_MODELS_SENTINEL = "__realctx2_refresh_models__";

export class Realctx2SettingsComponent implements Component, Focusable {
  readonly capturesViewportInput = true;
  private _focused = false;
  private cfg: Config;
  private readonly effectiveConfig?: Config;
  private readonly projectOverrides: Set<string>;
  private readonly configPath: string;
  private readonly displayCtx?: SettingsDisplayContext;
  private readonly availableModels: ModelChoice[];
  private readonly knownModels: ModelChoice[];
  private readonly onSave: (next: Config) => void;
  private readonly onTestEndpoint?: (endpoint: EndpointKind, cfg: Config, signal: AbortSignal) => Promise<EndpointTestResult>;
  private readonly onFetchModels?: (endpoint: EndpointKind, cfg: Config, signal: AbortSignal) => Promise<EndpointModelsResult>;
  private readonly onClose: () => void;
  private readonly theme: SettingsTheme;
  private readonly tui?: Pick<TUI, "requestRender"> & { terminal?: { rows?: number } };

  private stack: ViewState[] = [];
  private modal: ActiveModal | null = null;
  private flash: { text: string; tone: "success" | "warning" | "error" | "muted" } | null = null;
  private endpointTests: Partial<Record<EndpointKind, { status: "running"; abort: AbortController } | { status: "done"; result: EndpointTestResult }>> = {};
  private endpointModelsCache: Partial<Record<EndpointKind, { fingerprint: string; result: EndpointModelsResult }>> = {};
  private lastVisibleSelectableIndices: Array<{ rowY: number; index: number }> = [];

  constructor(opts: Realctx2SettingsOptions) {
    this.cfg = structuredClone(opts.config);
    this.effectiveConfig = opts.effectiveConfig;
    this.projectOverrides = new Set(opts.projectOverrides ?? []);
    this.configPath = opts.configPath;
    this.displayCtx = opts.displayContext;
    this.availableModels = opts.availableModels ?? [];
    this.knownModels = opts.knownModels?.length ? opts.knownModels : this.availableModels;
    this.onSave = opts.onSave;
    this.onTestEndpoint = opts.onTestEndpoint;
    this.onFetchModels = opts.onFetchModels;
    this.onClose = opts.onClose;
    this.theme = opts.theme;
    this.tui = opts.tui;

    const homeInput = new Input({ prompt: "Search: ", placeholder: "Type to filter categories or any setting..." });
    this.stack = [{ kind: "home", input: homeInput, selected: 0 }];
    if (opts.initialCategory) {
      const cat = findCategory(opts.initialCategory);
      if (cat) {
        const idx = SETTINGS_CATEGORIES.indexOf(cat);
        this.stack[0] = { kind: "home", input: homeInput, selected: Math.max(0, idx) };
        this.stack.push({ kind: "screen", title: cat.title, build: cat.build, selected: 0 });
      }
    }
    this.syncInputFocus();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.syncInputFocus();
  }

  private syncInputFocus(): void {
    const top = this.topView();
    const topHasInput = top.kind === "search" || top.kind === "home" || top.kind === "model-overrides";
    if (this.modal && (this.modal.kind === "text" || this.modal.kind === "model" || this.modal.kind === "endpoint-model")) {
      this.modal.input.focused = this._focused;
      if (topHasInput) top.input.focused = false;
    } else if (topHasInput) {
      top.input.focused = this._focused;
    }
  }

  private topView(): ViewState {
    return this.stack[this.stack.length - 1]!;
  }

  private maxListRows(): number {
    const rows = this.tui?.terminal?.rows ?? 34;
    return Math.max(8, Math.min(18, rows - 14));
  }

  private effectiveDisplayContext(): SettingsDisplayContext | undefined {
    const testEntries = Object.entries(this.endpointTests);
    if (!testEntries.length) return this.displayCtx;
    const mapped: NonNullable<SettingsDisplayContext["endpointTests"]> = {};
    for (const [k, st] of testEntries) {
      if (!st) continue;
      mapped[k as EndpointKind] = st.status === "running" ? { status: "running" } : { status: "done", result: st.result };
    }
    return { ...(this.displayCtx ?? {}), endpointTests: mapped };
  }

  private clearEndpointTest(endpoint: EndpointKind): void {
    const cur = this.endpointTests[endpoint];
    if (cur?.status === "running") cur.abort.abort();
    delete this.endpointTests[endpoint];
  }

  private abortAllTests(): void {
    for (const ep of ["decision", "late", "dense"] as const) {
      const cur = this.endpointTests[ep];
      if (cur?.status === "running") cur.abort.abort();
    }
    if (this.modal?.kind === "endpoint-model") {
      this.modal.abort?.abort();
      this.modal.abort = undefined;
    }
  }

  private close(): void {
    this.abortAllTests();
    this.onClose();
  }

  private endpointConnectionFingerprint(endpoint: EndpointKind, cfg: Config): string {
    const ep = endpoint === "decision" ? cfg.providers.decision : cfg.providers.embedding[endpoint];
    if (!ep) return "disabled";
    return JSON.stringify({
      url: ep.url ?? "",
      apiKey: ep.apiKey ?? "",
      apiKeyEnv: ep.apiKeyEnv ?? "",
      apiKeyFile: ep.apiKeyFile ?? "",
      headers: ep.headers ?? null,
    });
  }

  private invalidateEndpointTests(prev: Config, next: Config): void {
    if (JSON.stringify(prev.providers.decision) !== JSON.stringify(next.providers.decision)) {
      this.clearEndpointTest("decision");
    }
    if (JSON.stringify(prev.providers.embedding.late) !== JSON.stringify(next.providers.embedding.late)) {
      this.clearEndpointTest("late");
    }
    if (JSON.stringify(prev.providers.embedding.dense) !== JSON.stringify(next.providers.embedding.dense)) {
      this.clearEndpointTest("dense");
    }
    for (const ep of ["decision", "late", "dense"] as const) {
      if (this.endpointConnectionFingerprint(ep, prev) !== this.endpointConnectionFingerprint(ep, next)) {
        delete this.endpointModelsCache[ep];
      }
    }
  }

  private runEndpointTest(endpoint: EndpointKind): void {
    const prev = this.endpointTests[endpoint];
    if (prev?.status === "running") prev.abort.abort();
    const abort = new AbortController();
    this.endpointTests[endpoint] = { status: "running", abort };
    const label = endpoint === "decision" ? "Decision" : endpoint === "late" ? "Late embedding" : "Dense embedding";
    this.flash = { text: `Testing ${label} endpoint…`, tone: "muted" };
    this.tui?.requestRender();

    const snapshot = structuredClone(this.cfg);
    const runner = this.onTestEndpoint ?? ((ep: EndpointKind, c: Config, sig: AbortSignal) => testEndpoint(ep, c, { signal: sig }));
    let runPromise: Promise<EndpointTestResult>;
    try {
      runPromise = Promise.resolve(runner(endpoint, snapshot, abort.signal));
    } catch (e) {
      runPromise = Promise.reject(e);
    }
    void runPromise.then(
        (result) => {
          const cur = this.endpointTests[endpoint];
          if (!cur || cur.status !== "running" || cur.abort !== abort) return;
          this.endpointTests[endpoint] = { status: "done", result };
          if (result.availableModels?.length) {
            const fp = this.endpointConnectionFingerprint(endpoint, snapshot);
            const existing = this.endpointModelsCache[endpoint];
            if (!existing || existing.fingerprint !== fp) {
              const epCfg = endpoint === "decision" ? snapshot.providers.decision : snapshot.providers.embedding[endpoint];
              this.endpointModelsCache[endpoint] = {
                fingerprint: fp,
                result: {
                  endpoint,
                  ok: true,
                  url: epCfg?.url ? (modelsUrlFor(epCfg.url) ?? undefined) : undefined,
                  models: result.availableModels.map((id) => ({ id })),
                  authSummary: result.authSummary,
                  latencyMs: 0,
                },
              };
            }
          }
          this.flash = {
            text: result.ok ? `✓ ${label}: ${result.summary}` : `✗ ${label}: ${result.summary}`,
            tone: result.ok ? "success" : "error",
          };
          this.tui?.requestRender();
        },
        (e: unknown) => {
          const cur = this.endpointTests[endpoint];
          if (!cur || cur.status !== "running" || cur.abort !== abort) return;
          const msg = errMsg(e);
          const result: EndpointTestResult = {
            endpoint,
            ok: false,
            latencyMs: 0,
            summary: msg.length > 48 ? `${msg.slice(0, 45)}…` : msg || "Test failed",
            detail: `Endpoint test threw an unexpected error: ${msg}`,
            authSummary: "unknown",
          };
          this.endpointTests[endpoint] = { status: "done", result };
          this.flash = { text: `✗ ${label}: ${result.summary}`, tone: "error" };
          this.tui?.requestRender();
        },
      );
  }

  private commitConfig(next: Config, message: string): void {
    const prev = this.cfg;
    this.cfg = next;
    this.invalidateEndpointTests(prev, next);
    try {
      this.onSave(structuredClone(next));
      this.flash = { text: message, tone: "success" };
    } catch (e) {
      this.flash = { text: `Save failed: ${errMsg(e)}`, tone: "error" };
    }
    this.tui?.requestRender();
  }

  invalidate(): void {
    // Re-rendered dynamically from current state.
  }

  // ───────────────────────────── Input handling

  handleInput(data: string): void {
    if (this.modal) {
      this.handleModalInput(data);
      this.syncInputFocus();
      this.tui?.requestRender();
      return;
    }
    this.flash = null;
    const view = this.topView();
    if (view.kind === "home") this.handleHomeInput(view, data);
    else if (view.kind === "screen") this.handleScreenInput(view, data);
    else if (view.kind === "search") this.handleSearchInput(view, data);
    else if (view.kind === "multi-enum") this.handleMultiEnumInput(view, data);
    else if (view.kind === "string-list") this.handleStringListInput(view, data);
    else if (view.kind === "string-map") this.handleStringMapInput(view, data);
    else if (view.kind === "model-overrides") this.handleModelOverridesInput(view, data);
    this.syncInputFocus();
    this.tui?.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.modal) return undefined;
    if (event.type === "wheel" && event.wheelDelta) {
      const dir = event.wheelDelta < 0 ? -1 : 1;
      this.moveSelection(dir);
      this.tui?.requestRender();
      return { handled: true, render: true };
    }
    if (event.button === "left" && (event.type === "press" || event.type === "click")) {
      const hit = this.lastVisibleSelectableIndices.find((r) => r.rowY === event.y);
      if (!hit) return undefined;
      const view = this.topView();
      if ("selected" in view) view.selected = hit.index;
      if (event.type === "click") this.handleInput("\r");
      else this.tui?.requestRender();
      return { handled: true, focus: true, render: true };
    }
    return undefined;
  }

  private moveSelection(delta: number): void {
    const view = this.topView();
    if (view.kind === "home") {
      const n = this.homeMatches(view).length;
      if (n) view.selected = (view.selected + delta + n) % n;
    } else if (view.kind === "screen") {
      const entries = this.screenEntries(view);
      if (entries.length) view.selected = (view.selected + delta + entries.length) % entries.length;
    } else if (view.kind === "search") {
      const results = this.searchResults(view);
      if (results.length) view.selected = (view.selected + delta + results.length) % results.length;
    } else if (view.kind === "multi-enum") {
      const n = view.entry.options?.length ?? 0;
      if (n) view.selected = (view.selected + delta + n) % n;
    } else if (view.kind === "string-list") {
      const arr = this.getList(view.entry);
      const n = arr.length + 1;
      view.selected = (view.selected + delta + n) % n;
    } else if (view.kind === "string-map") {
      const entries = this.getMapEntries(view.entry);
      const n = entries.length + 1;
      view.selected = (view.selected + delta + n) % n;
    } else if (view.kind === "model-overrides") {
      const n = this.modelOverrideRows(view).length;
      if (n) view.selected = (view.selected + delta + n) % n;
    }
  }

  private isUp(data: string, allowVim = true): boolean {
    const kb = getKeybindings();
    return kb.matches(data, "tui.select.up") || (allowVim && data === "k");
  }

  private isDown(data: string, allowVim = true): boolean {
    const kb = getKeybindings();
    return kb.matches(data, "tui.select.down") || (allowVim && data === "j");
  }

  private isPageUp(data: string): boolean {
    return getKeybindings().matches(data, "tui.select.pageUp");
  }

  private isPageDown(data: string): boolean {
    return getKeybindings().matches(data, "tui.select.pageDown");
  }

  private isConfirm(data: string): boolean {
    return getKeybindings().matches(data, "tui.select.confirm");
  }

  private isCancel(data: string): boolean {
    return getKeybindings().matches(data, "tui.select.cancel");
  }

  private popOrClose(): void {
    if (this.stack.length > 1) this.stack.pop();
    else this.close();
  }

  private openGlobalSearch(): void {
    const input = new Input({ prompt: "/ ", placeholder: "Filter settings by name, key, or description..." });
    this.stack.push({ kind: "search", input, selected: 0 });
  }

  // ── Home view input (category selector + live search)

  private filterCategories(query: string): Array<(typeof SETTINGS_CATEGORIES)[number]> {
    const q = query.trim().toLowerCase();
    if (!q) return [...SETTINGS_CATEGORIES];
    const tokens = q.split(/\s+/).filter(Boolean);
    const scored: Array<{ cat: (typeof SETTINGS_CATEGORIES)[number]; score: number }> = [];
    for (const c of SETTINGS_CATEGORIES) {
      const hay = `${c.title} ${c.id} ${c.aliases?.join(" ") ?? ""}`.toLowerCase();
      if (tokens.every((t) => hay.includes(t))) {
        const starts = c.title.toLowerCase().startsWith(q) || c.id.startsWith(q);
        scored.push({ cat: c, score: starts ? -1000 : -500 });
        continue;
      }
      const m = fuzzyMatch(q, `${c.title} ${c.id}`);
      if (m.matches) scored.push({ cat: c, score: m.score });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.map((s) => s.cat);
  }

  private filterSettingsList(query: string): SearchableSetting[] {
    const all = flattenAllSettings(this.cfg, this.effectiveDisplayContext());
    const q = query.trim().toLowerCase();
    if (!q) return all;
    const tokens = q.split(/\s+/).filter(Boolean);
    const strong: Array<{ item: SearchableSetting; score: number }> = [];
    const fuzzy: Array<{ item: SearchableSetting; score: number }> = [];
    for (const item of all) {
      const label = item.entry.label.toLowerCase();
      const path = item.entry.path.toLowerCase();
      const leaf = path.slice(path.lastIndexOf(".") + 1);
      const scope = `${item.categoryTitle} ${item.sectionTitle}`.toLowerCase();
      const full = `${label} ${path} ${scope} ${item.entry.description.toLowerCase()}`;
      if (label.includes(q) || path.includes(q)) {
        const exact = path === q || label === q || leaf === q;
        strong.push({ item, score: exact ? -3000 : leaf.startsWith(q) || label.startsWith(q) ? -2000 : -1000 });
      } else if (tokens.every((t) => label.includes(t) || path.includes(t) || scope.includes(t))) {
        strong.push({ item, score: -500 });
      } else if (tokens.every((t) => full.includes(t))) {
        strong.push({ item, score: -100 });
      } else {
        const m = fuzzyMatch(q, `${item.entry.label} ${leaf}`);
        if (m.matches) fuzzy.push({ item, score: m.score });
      }
    }
    const list = strong.length > 0 ? strong : fuzzy;
    list.sort((a, b) => a.score - b.score);
    return list.map((s) => s.item);
  }

  private homeMatches(view: Extract<ViewState, { kind: "home" }>): HomeMatch[] {
    const query = view.input.getValue().trim();
    if (!query) {
      return SETTINGS_CATEGORIES.map((category) => ({ kind: "category", category }));
    }
    const cats = this.filterCategories(query).map<HomeMatch>((category) => ({ kind: "category", category }));
    const settings = this.filterSettingsList(query).map<HomeMatch>((item) => ({ kind: "setting", item }));
    const out = [...cats, ...settings];
    if (out.length > 0 && view.selected >= out.length) view.selected = out.length - 1;
    if (out.length === 0) view.selected = 0;
    return out;
  }

  private handleHomeInput(view: Extract<ViewState, { kind: "home" }>, data: string): void {
    const matches = this.homeMatches(view);
    const count = matches.length;
    const query = view.input.getValue();

    if (this.isCancel(data)) {
      if (query.length > 0) {
        view.input.setValue("");
        view.selected = 0;
      } else {
        this.close();
      }
      return;
    }
    if (this.isUp(data, false)) {
      if (count) view.selected = (view.selected - 1 + count) % count;
      return;
    }
    if (this.isDown(data, false)) {
      if (count) view.selected = (view.selected + 1) % count;
      return;
    }
    if (this.isPageUp(data)) {
      if (count) view.selected = Math.max(0, view.selected - Math.max(1, Math.floor(this.maxListRows() / 2)));
      return;
    }
    if (this.isPageDown(data)) {
      if (count) view.selected = Math.min(count - 1, view.selected + Math.max(1, Math.floor(this.maxListRows() / 2)));
      return;
    }
    if (this.isConfirm(data) || (query.length === 0 && matchesKey(data, Key.right))) {
      const cur = matches[view.selected];
      if (!cur) return;
      if (cur.kind === "category") {
        this.stack.push({ kind: "screen", title: cur.category.title, build: cur.category.build, selected: 0 });
      } else {
        this.activateEntry(cur.item.entry);
      }
      return;
    }
    if (matchesKey(data, Key.ctrl("r"))) {
      const cur = matches[view.selected];
      if (cur?.kind === "setting") this.resetEntry(cur.item.entry);
      return;
    }
    // Pressing `/` while search is empty focuses search without inserting a literal `/`
    if (data === "/" && query.length === 0) return;

    const prev = view.input.getValue();
    view.input.handleInput(data);
    if (view.input.getValue() !== prev) view.selected = 0;
  }

  // ── Category / Subscreen input

  private screenRows(view: Extract<ViewState, { kind: "screen" }>): { spec: SettingScreenSpec; rows: ScreenRow[]; entryIndices: number[] } {
    const spec = view.build(this.cfg, this.effectiveDisplayContext());
    const rows: ScreenRow[] = [];
    const entryIndices: number[] = [];
    spec.sections.forEach((sec, si) => {
      rows.push({ kind: "section", title: sec.title, sectionIndex: si });
      for (const entry of sec.items) {
        entryIndices.push(rows.length);
        rows.push({ kind: "entry", entry, sectionIndex: si });
      }
    });
    if (entryIndices.length > 0 && view.selected >= entryIndices.length) {
      view.selected = entryIndices.length - 1;
    }
    return { spec, rows, entryIndices };
  }

  private screenEntries(view: Extract<ViewState, { kind: "screen" }>): SettingEntry[] {
    const { rows, entryIndices } = this.screenRows(view);
    return entryIndices.map((ri) => (rows[ri] as Extract<ScreenRow, { kind: "entry" }>).entry);
  }

  private jumpSection(view: Extract<ViewState, { kind: "screen" }>, dir: -1 | 1): void {
    const { rows, entryIndices } = this.screenRows(view);
    if (!entryIndices.length) return;
    const curRow = rows[entryIndices[view.selected]!]!;
    const curSec = curRow.sectionIndex;
    // Collect first selectable index of each non-empty section
    const sectionStarts: Array<{ sectionIndex: number; entryIdx: number }> = [];
    entryIndices.forEach((ri, ei) => {
      const si = rows[ri]!.sectionIndex;
      if (!sectionStarts.some((s) => s.sectionIndex === si)) {
        sectionStarts.push({ sectionIndex: si, entryIdx: ei });
      }
    });
    if (sectionStarts.length <= 1) return;
    const pos = sectionStarts.findIndex((s) => s.sectionIndex === curSec);
    const nextPos = (pos + dir + sectionStarts.length) % sectionStarts.length;
    view.selected = sectionStarts[nextPos]!.entryIdx;
  }

  private handleScreenInput(view: Extract<ViewState, { kind: "screen" }>, data: string): void {
    const entries = this.screenEntries(view);
    const n = entries.length;
    if (this.isCancel(data) || data === "q") {
      this.popOrClose();
      return;
    }
    if (data === "/") {
      this.openGlobalSearch();
      return;
    }
    if (!n) return;

    if (this.isUp(data)) {
      view.selected = (view.selected - 1 + n) % n;
    } else if (this.isDown(data)) {
      view.selected = (view.selected + 1) % n;
    } else if (this.isPageUp(data)) {
      view.selected = Math.max(0, view.selected - Math.max(1, Math.floor(this.maxListRows() / 2)));
    } else if (this.isPageDown(data)) {
      view.selected = Math.min(n - 1, view.selected + Math.max(1, Math.floor(this.maxListRows() / 2)));
    } else if (matchesKey(data, Key.tab) || data === "]") {
      this.jumpSection(view, 1);
    } else if (matchesKey(data, Key.shift("tab")) || data === "[") {
      this.jumpSection(view, -1);
    } else if (matchesKey(data, Key.left)) {
      const entry = entries[view.selected]!;
      if (isScalarSetting(entry)) {
        this.quickStep(entry, -1);
      }
    } else if (matchesKey(data, Key.right)) {
      const entry = entries[view.selected]!;
      if (entry.kind === "subscreen") {
        this.stack.push({ kind: "screen", title: entry.label, build: entry.build, selected: 0 });
      } else if (entry.kind === "model-overrides") {
        this.activateEntry(entry);
      } else if (isScalarSetting(entry)) {
        this.quickStep(entry, 1);
      }
    } else if (this.isConfirm(data) || data === " ") {
      this.activateEntry(entries[view.selected]!);
    } else if (data === "t") {
      const testAction = entries.find((e): e is ActionEntry => e.kind === "action" && e.action === "test-endpoint");
      if (testAction) this.runEndpointTest(testAction.endpoint);
    } else if (data === "r" || matchesKey(data, Key.backspace)) {
      const entry = entries[view.selected]!;
      if (entry.kind !== "subscreen" && entry.kind !== "action") this.resetEntry(entry);
    }
  }

  // ── Global Search view input

  private searchResults(view: Extract<ViewState, { kind: "search" }>): SearchableSetting[] {
    const query = view.input.getValue().trim();
    const res = this.filterSettingsList(query);
    if (res.length > 0 && view.selected >= res.length) view.selected = res.length - 1;
    if (res.length === 0) view.selected = 0;
    return res;
  }

  private handleSearchInput(view: Extract<ViewState, { kind: "search" }>, data: string): void {
    const results = this.searchResults(view);
    if (this.isCancel(data)) {
      this.stack.pop();
      return;
    }
    if (this.isUp(data, false)) {
      if (results.length) view.selected = (view.selected - 1 + results.length) % results.length;
    } else if (this.isDown(data, false)) {
      if (results.length) view.selected = (view.selected + 1) % results.length;
    } else if (this.isPageUp(data)) {
      view.selected = Math.max(0, view.selected - Math.max(1, Math.floor(this.maxListRows() / 2)));
    } else if (this.isPageDown(data)) {
      view.selected = Math.min(Math.max(0, results.length - 1), view.selected + Math.max(1, Math.floor(this.maxListRows() / 2)));
    } else if (this.isConfirm(data)) {
      const item = results[view.selected];
      if (item) this.activateEntry(item.entry);
    } else if (matchesKey(data, Key.ctrl("r"))) {
      const item = results[view.selected];
      if (item) this.resetEntry(item.entry);
    } else {
      const prev = view.input.getValue();
      view.input.handleInput(data);
      if (view.input.getValue() !== prev) view.selected = 0;
    }
  }

  // ── Multi-enum checklist input

  private handleMultiEnumInput(view: Extract<ViewState, { kind: "multi-enum" }>, data: string): void {
    const opts = view.entry.options ?? [];
    if (this.isCancel(data) || data === "q") {
      this.stack.pop();
      return;
    }
    if (!opts.length) return;
    if (this.isUp(data)) {
      view.selected = (view.selected - 1 + opts.length) % opts.length;
    } else if (this.isDown(data)) {
      view.selected = (view.selected + 1) % opts.length;
    } else if (this.isConfirm(data) || data === " ") {
      const opt = opts[view.selected]!;
      const cur = new Set(this.getList(view.entry));
      if (cur.has(opt.value)) cur.delete(opt.value);
      else cur.add(opt.value);
      // Preserve canonical option order
      const nextArr = opts.map((o) => o.value).filter((v) => cur.has(v));
      const next = setSettingValue(this.cfg, view.entry, nextArr);
      this.commitConfig(next, `Saved ${view.entry.label}`);
    } else if (data === "r") {
      this.resetEntry(view.entry);
    }
  }

  // ── String-list editor input

  private getList(entry: StringListSetting): string[] {
    const v = getSettingValue(this.cfg, entry);
    return Array.isArray(v) ? [...(v as string[])] : [];
  }

  private handleStringListInput(view: Extract<ViewState, { kind: "string-list" }>, data: string): void {
    const list = this.getList(view.entry);
    const total = list.length + 1; // last row is "+ Add item…"
    if (view.selected >= total) view.selected = total - 1;

    if (this.isCancel(data) || data === "q") {
      this.stack.pop();
      return;
    }
    if (this.isUp(data)) {
      view.selected = (view.selected - 1 + total) % total;
    } else if (this.isDown(data)) {
      view.selected = (view.selected + 1) % total;
    } else if (this.isConfirm(data) || (data === "a" && view.selected === list.length)) {
      if (view.selected === list.length) {
        this.openListAddModal(view.entry);
      } else {
        this.openListEditModal(view.entry, view.selected, list[view.selected]!);
      }
    } else if (data === "a") {
      this.openListAddModal(view.entry);
    } else if ((data === "d" || matchesKey(data, Key.delete) || matchesKey(data, Key.backspace)) && view.selected < list.length) {
      const removed = list[view.selected]!;
      const nextList = list.filter((_, i) => i !== view.selected);
      const next = setSettingValue(this.cfg, view.entry, nextList);
      this.commitConfig(next, `Removed "${removed}"`);
      if (view.selected > nextList.length) view.selected = nextList.length;
    } else if (data === "r") {
      this.resetEntry(view.entry);
      view.selected = 0;
    }
  }

  private openListAddModal(entry: StringListSetting): void {
    const input = new Input({ prompt: "> ", placeholder: entry.itemPlaceholder ?? "new item" });
    this.modal = {
      kind: "text",
      title: `Add to ${entry.label}`,
      subtitle: entry.path,
      description: entry.description,
      hint: "Enter to add · Esc to cancel",
      input,
      onCommit: (raw) => {
        const val = raw.trim();
        if (!val) return "Value cannot be empty";
        const list = this.getList(entry);
        const next = setSettingValue(this.cfg, entry, [...list, val]);
        this.commitConfig(next, `Added "${val}"`);
        return null;
      },
    };
  }

  private prefillInput(input: Input, value: string): void {
    input.setValue(value);
    if (value.length > 0) input.handleInput("\x05"); // move cursor to end of prefilled text
  }

  private openListEditModal(entry: StringListSetting, index: number, current: string): void {
    const input = new Input({ prompt: "> ", placeholder: entry.itemPlaceholder ?? "value" });
    this.prefillInput(input, current);
    this.modal = {
      kind: "text",
      title: `Edit item in ${entry.label}`,
      subtitle: `${entry.path}[${index}]`,
      description: entry.description,
      hint: "Enter to save (leave blank to remove) · Esc to cancel",
      input,
      onCommit: (raw) => {
        const val = raw.trim();
        const list = this.getList(entry);
        const nextList = val ? list.map((x, i) => (i === index ? val : x)) : list.filter((_, i) => i !== index);
        const next = setSettingValue(this.cfg, entry, nextList);
        this.commitConfig(next, val ? `Updated "${val}"` : "Removed item");
        return null;
      },
    };
  }

  // ── String-map (HTTP headers) editor input

  private getMapEntries(entry: StringMapSetting): Array<[string, string]> {
    const v = getSettingValue(this.cfg, entry);
    if (!v || typeof v !== "object" || Array.isArray(v)) return [];
    return Object.entries(v as Record<string, string>).filter(([, val]) => typeof val === "string");
  }

  private handleStringMapInput(view: Extract<ViewState, { kind: "string-map" }>, data: string): void {
    const pairs = this.getMapEntries(view.entry);
    const total = pairs.length + 1; // last row is "+ Add header…"
    if (view.selected >= total) view.selected = total - 1;

    if (this.isCancel(data) || data === "q") {
      this.stack.pop();
      return;
    }
    if (this.isUp(data)) {
      view.selected = (view.selected - 1 + total) % total;
    } else if (this.isDown(data)) {
      view.selected = (view.selected + 1) % total;
    } else if (this.isConfirm(data) || (data === "a" && view.selected === pairs.length)) {
      if (view.selected === pairs.length) {
        this.openMapAddModal(view.entry);
      } else {
        const [k, v] = pairs[view.selected]!;
        this.openMapEditValueModal(view.entry, k, v);
      }
    } else if (data === "a") {
      this.openMapAddModal(view.entry);
    } else if ((data === "d" || matchesKey(data, Key.delete) || matchesKey(data, Key.backspace)) && view.selected < pairs.length) {
      const [key] = pairs[view.selected]!;
      const nextMap: Record<string, string> = {};
      for (const [k, v] of pairs) if (k !== key) nextMap[k] = v;
      const next = setSettingValue(this.cfg, view.entry, Object.keys(nextMap).length ? nextMap : undefined);
      this.commitConfig(next, `Removed header "${key}"`);
    } else if (data === "r") {
      const next = setSettingValue(this.cfg, view.entry, undefined);
      this.commitConfig(next, `Cleared ${view.entry.label}`);
      view.selected = 0;
    }
  }

  private openMapAddModal(entry: StringMapSetting): void {
    const input = new Input({ prompt: "Name: ", placeholder: entry.keyPlaceholder ?? "X-Custom-Header" });
    this.modal = {
      kind: "text",
      title: `Add header · ${entry.label}`,
      subtitle: `${entry.path} (step 1 of 2: header name)`,
      description: entry.description,
      hint: "Enter header name (or Name: Value) · Esc to cancel",
      input,
      onCommit: (raw) => {
        const trimmed = raw.trim();
        if (!trimmed) return "Header name cannot be empty";
        // Convenience: allow "Header-Name: value" in one shot
        const colon = trimmed.indexOf(":");
        if (colon > 0) {
          const k = trimmed.slice(0, colon).trim();
          const v = trimmed.slice(colon + 1).trim();
          if (!k) return "Header name cannot be empty";
          const nextMap = Object.fromEntries(this.getMapEntries(entry));
          nextMap[k] = v;
          this.commitConfig(setSettingValue(this.cfg, entry, nextMap), `Saved header "${k}"`);
          return null;
        }
        // Proceed to step 2: header value
        this.openMapEditValueModal(entry, trimmed, "");
        return "__keep_modal__";
      },
    };
  }

  private openMapEditValueModal(entry: StringMapSetting, key: string, currentVal: string): void {
    const sensitive = isSensitiveHeaderName(key);
    const input = new Input({ prompt: `${key}: `, placeholder: sensitive ? "enter secret header value" : (entry.valuePlaceholder ?? "header value") });
    this.prefillInput(input, sensitive ? "" : currentVal);
    this.modal = {
      kind: "text",
      title: `Header value · ${key}`,
      subtitle: sensitive && currentVal ? `${entry.path}.${key} (current: ${this.maskHeaderValue(key, currentVal)})` : `${entry.path}.${key}`,
      description: entry.description,
      hint: sensitive ? "Enter to save · Esc to keep current value" : "Enter to save · Esc to cancel",
      input,
      secret: sensitive,
      placeholder: sensitive ? "enter secret header value" : (entry.valuePlaceholder ?? "header value"),
      onCommit: (raw) => {
        const nextMap = Object.fromEntries(this.getMapEntries(entry));
        nextMap[key] = raw.trim();
        this.commitConfig(setSettingValue(this.cfg, entry, nextMap), `Saved header "${key}"`);
        return null;
      },
    };
  }

  private maskHeaderValue(key: string, value: string): string {
    if (!isSensitiveHeaderName(key)) return value;
    const trimmed = value.trim();
    if (/^bearer\s+/i.test(trimmed)) {
      return `Bearer ${maskSecret(trimmed.replace(/^bearer\s+/i, "").trim())}`;
    }
    return maskSecret(trimmed);
  }

  // ── Per-model override screen (maxWindow, cacheTTL)

  private getModelOverrideMap(entry: ModelOverridesSetting): Record<string, "auto" | number> {
    const raw = getSettingValue(this.cfg, entry);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return { ...(raw as Record<string, "auto" | number>) };
  }

  private setModelOverride(entry: ModelOverridesSetting, modelKey: string, value: "auto" | number): void {
    const nextMap = this.getModelOverrideMap(entry);
    if (value === "auto") delete nextMap[modelKey];
    else nextMap[modelKey] = value;
    const next = setSettingValue(this.cfg, entry, nextMap);
    const label = formatModelOverrideValue(entry, value);
    this.commitConfig(next, `${modelKey} → ${label}`);
  }

  private modelOverrideRows(view: Extract<ViewState, { kind: "model-overrides" }>): ModelOverrideRow[] {
    const map = this.getModelOverrideMap(view.entry);
    const query = view.input.getValue().trim();
    const knownByKey = new Map<string, ModelChoice>();
    for (const m of this.knownModels) {
      knownByKey.set(`${m.provider}/${m.id}`, m);
    }

    const baseRows: Array<Extract<ModelOverrideRow, { kind: "model" }>> = [];
    const seen = new Set<string>();

    // 1. Models that already have active overrides (including custom entries not in the registry)
    const overriddenKeys = Object.keys(map)
      .filter((k) => map[k] !== "auto" && map[k] !== undefined)
      .sort((a, b) => a.localeCompare(b));
    for (const key of overriddenKeys) {
      seen.add(key);
      const meta = knownByKey.get(key);
      baseRows.push({
        kind: "model",
        key,
        name: meta?.name,
        contextWindow: meta?.contextWindow,
        value: map[key],
        custom: !meta,
      });
    }

    // 2. All known models from registry/catalog (configured/available first, preserving order)
    for (const m of this.knownModels) {
      const key = `${m.provider}/${m.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      baseRows.push({
        kind: "model",
        key,
        name: m.name,
        contextWindow: m.contextWindow,
        value: map[key],
        custom: false,
      });
    }

    const matched: ModelOverrideRow[] = query
      ? fuzzyFilter(baseRows, query, (r) => `${r.key} ${r.name ?? ""}`)
      : [...baseRows];

    if (query) {
      const exact = baseRows.some((r) => r.key.toLowerCase() === query.toLowerCase());
      if (!exact) matched.push({ kind: "add-query", key: query });
    } else {
      matched.push({ kind: "add-custom" });
    }

    if (matched.length > 0 && view.selected >= matched.length) view.selected = matched.length - 1;
    if (matched.length === 0) view.selected = 0;
    return matched;
  }

  private handleModelOverridesInput(view: Extract<ViewState, { kind: "model-overrides" }>, data: string): void {
    const rows = this.modelOverrideRows(view);
    if (this.isCancel(data)) {
      if (view.input.getValue().length > 0) {
        view.input.setValue("");
        view.selected = 0;
        return;
      }
      this.stack.pop();
      return;
    }
    if (this.isUp(data, false)) {
      if (rows.length) view.selected = (view.selected - 1 + rows.length) % rows.length;
      return;
    }
    if (this.isDown(data, false)) {
      if (rows.length) view.selected = (view.selected + 1) % rows.length;
      return;
    }
    if (this.isPageUp(data)) {
      if (rows.length) view.selected = Math.max(0, view.selected - Math.max(1, Math.floor(this.maxListRows() / 2)));
      return;
    }
    if (this.isPageDown(data)) {
      if (rows.length) view.selected = Math.min(rows.length - 1, view.selected + Math.max(1, Math.floor(this.maxListRows() / 2)));
      return;
    }
    if (matchesKey(data, Key.ctrl("r"))) {
      const cur = rows[view.selected];
      if (cur?.kind === "model" && cur.value !== undefined && cur.value !== "auto") {
        this.setModelOverride(view.entry, cur.key, "auto");
      }
      return;
    }
    if (this.isConfirm(data)) {
      const cur = rows[view.selected];
      if (!cur) return;
      if (cur.kind === "model") {
        this.openModelOverrideEditModal(view.entry, cur.key, cur.value, cur.contextWindow);
      } else if (cur.kind === "add-query") {
        const key = cur.key;
        this.openModelOverrideEditModal(view.entry, key, undefined, undefined, () => {
          view.input.setValue("");
          view.selected = 0;
        });
      } else {
        this.openModelOverrideAddModal(view.entry);
      }
      return;
    }

    const prev = view.input.getValue();
    view.input.handleInput(data);
    if (view.input.getValue() !== prev) view.selected = 0;
  }

  private openModelOverrideAddModal(entry: ModelOverridesSetting): void {
    const input = new Input({ prompt: "Model: ", placeholder: "provider/model-id (e.g. openai/gpt-6.2-sol)" });
    this.modal = {
      kind: "text",
      title: `Add model · ${entry.label}`,
      subtitle: `${entry.path} (step 1 of 2: model identifier)`,
      description: entry.description,
      hint: 'Enter "provider/model-id" or bare "model-id" · Esc to cancel',
      input,
      onCommit: (raw) => {
        const key = raw.trim();
        if (!key) return "Model identifier cannot be empty";
        const cur = this.getModelOverrideMap(entry)[key];
        this.openModelOverrideEditModal(entry, key, cur);
        return "__keep_modal__";
      },
    };
  }

  private openModelOverrideEditModal(
    entry: ModelOverridesSetting,
    modelKey: string,
    currentVal: "auto" | number | undefined,
    contextWindow?: number,
    onSaved?: () => void,
  ): void {
    const placeholder = entry.zeroLabel ? 'auto, 0 (disable), or tokens' : 'auto or seconds';
    const input = new Input({ prompt: "Value: ", placeholder });
    this.prefillInput(input, currentVal === undefined || currentVal === "auto" ? "auto" : String(currentVal));
    const subParts = [`${entry.path}["${modelKey}"]`, `default: ${entry.defaultSummary(this.cfg)}`];
    if (entry.showContextWindow && contextWindow) subParts.push(`catalog: ${contextWindow.toLocaleString("en-US")} tokens`);
    this.modal = {
      kind: "text",
      title: `${modelKey} · ${entry.label}`,
      subtitle: subParts.join(" · "),
      description: entry.description,
      hint: entry.zeroLabel
        ? 'Enter "auto", 0 (disable context engine), or tokens · Esc to cancel'
        : 'Enter "auto" or seconds ≥ 0 · Esc to cancel',
      input,
      onCommit: (raw) => {
        const parsed = parseModelOverrideInput(entry, raw);
        if (!parsed.ok) return parsed.error;
        this.setModelOverride(entry, modelKey, parsed.value);
        onSaved?.();
        return null;
      },
    };
  }

  // ── Entry activation, quick-step, reset

  private quickStep(entry: ScalarSetting, dir: -1 | 1): void {
    const res = stepSettingValue(this.cfg, entry, dir);
    if (!res.changed) return;
    const val = getSettingValue(res.next, entry);
    this.commitConfig(res.next, `${entry.label} = ${formatSettingValue(entry, val)}`);
  }

  private resetEntry(entry: EditableSetting): void {
    const def = getSettingDefault(entry);
    const next = setSettingValue(this.cfg, entry, structuredClone(def));
    this.commitConfig(next, `Reset ${entry.label} to default`);
  }

  private activateEntry(entry: SettingEntry): void {
    if (entry.kind === "action") {
      if (entry.action === "test-endpoint") this.runEndpointTest(entry.endpoint);
      return;
    }
    if (entry.kind === "subscreen") {
      this.stack.push({ kind: "screen", title: entry.label, build: entry.build, selected: 0 });
      return;
    }
    if (entry.kind === "multi-enum") {
      this.stack.push({ kind: "multi-enum", entry, selected: 0 });
      return;
    }
    if (entry.kind === "string-list") {
      this.stack.push({ kind: "string-list", entry, selected: 0 });
      return;
    }
    if (entry.kind === "string-map") {
      this.stack.push({ kind: "string-map", entry, selected: 0 });
      return;
    }
    if (entry.kind === "model-overrides") {
      const input = new Input({ prompt: "Model: ", placeholder: "Filter known models or type provider/model-id to add..." });
      this.stack.push({ kind: "model-overrides", entry, input, selected: 0 });
      return;
    }
    if (!isScalarSetting(entry)) return;
    if (entry.kind === "boolean") {
      const cur = Boolean(getSettingValue(this.cfg, entry));
      const next = setSettingValue(this.cfg, entry, !cur);
      this.commitConfig(next, `${entry.label} = ${!cur}`);
      return;
    }
    if (entry.kind === "enum") {
      this.openEnumModal(entry);
      return;
    }
    if (entry.endpointModels) {
      this.openEndpointModelModal(entry, entry.endpointModels);
      return;
    }
    if (entry.modelPicker && this.availableModels.length > 0) {
      this.openModelModal(entry);
      return;
    }
    this.openTextModal(entry);
  }

  private openEndpointModelModal(entry: ScalarSetting, endpoint: EndpointKind): void {
    const input = new Input({ prompt: "Filter / Model ID: ", placeholder: "Filter models or type a custom model ID..." });
    const ep = endpoint === "decision" ? this.cfg.providers.decision : this.cfg.providers.embedding[endpoint];
    const url = ep?.url ? modelsUrlFor(ep.url) : null;
    const cur = getSettingValue(this.cfg, entry);
    const curStr = typeof cur === "string" ? cur.trim() : "";

    if (!url) {
      this.modal = {
        kind: "endpoint-model",
        endpoint,
        entry,
        input,
        selected: 0,
        status: "no-url",
        models: [],
        error: ep?.url?.trim()
          ? `Invalid Endpoint URL "${ep.url.trim()}" — fix Endpoint URL or enter model ID manually.`
          : "Set Endpoint URL first to retrieve models from /v1/models.",
      };
      return;
    }

    const fp = this.endpointConnectionFingerprint(endpoint, this.cfg);
    const cached = this.endpointModelsCache[endpoint];
    if (cached && cached.fingerprint === fp && cached.result.ok && cached.result.models.length > 0) {
      const models = cached.result.models;
      const curIdx = curStr ? models.findIndex((m) => m.id === curStr) : -1;
      this.modal = {
        kind: "endpoint-model",
        endpoint,
        entry,
        input,
        selected: curIdx >= 0 ? curIdx : 0,
        status: "ready",
        url: cached.result.url ?? url,
        models,
      };
      return;
    }

    const modal: Extract<ActiveModal, { kind: "endpoint-model" }> = {
      kind: "endpoint-model",
      endpoint,
      entry,
      input,
      selected: 0,
      status: "loading",
      url,
      models: [],
    };
    this.modal = modal;
    this.startEndpointModelsFetch(modal);
  }

  private startEndpointModelsFetch(modal: Extract<ActiveModal, { kind: "endpoint-model" }>): void {
    modal.abort?.abort();
    const abort = new AbortController();
    modal.abort = abort;
    modal.status = "loading";
    modal.error = undefined;

    const snapshot = structuredClone(this.cfg);
    const fp = this.endpointConnectionFingerprint(modal.endpoint, snapshot);
    const runner = this.onFetchModels ?? ((ep: EndpointKind, c: Config, sig: AbortSignal) => fetchEndpointModels(ep, c, { signal: sig }));
    let runPromise: Promise<EndpointModelsResult>;
    try {
      runPromise = Promise.resolve(runner(modal.endpoint, snapshot, abort.signal));
    } catch (e) {
      runPromise = Promise.reject(e);
    }

    void runPromise.then(
      (res) => {
        if (this.modal !== modal || modal.abort !== abort) return;
        modal.abort = undefined;
        modal.url = res.url ?? modal.url;
        if (res.ok) {
          modal.status = "ready";
          modal.models = res.models;
          modal.error = res.models.length === 0 ? "Endpoint returned no models from /v1/models." : undefined;
          if (res.models.length > 0) {
            this.endpointModelsCache[modal.endpoint] = { fingerprint: fp, result: res };
          }
          const q = modal.input.getValue().trim();
          if (!q) {
            const cur = getSettingValue(this.cfg, modal.entry);
            const curStr = typeof cur === "string" ? cur.trim() : "";
            const curIdx = curStr ? res.models.findIndex((m) => m.id === curStr) : -1;
            modal.selected = curIdx >= 0 ? curIdx : 0;
          } else {
            modal.selected = 0;
          }
        } else {
          modal.status = "error";
          modal.models = [];
          modal.error = res.error ?? "Could not fetch /v1/models.";
          modal.selected = 0;
        }
        this.tui?.requestRender();
      },
      (e: unknown) => {
        if (this.modal !== modal || modal.abort !== abort) return;
        modal.abort = undefined;
        modal.status = "error";
        modal.models = [];
        modal.error = errMsg(e) || "Could not fetch /v1/models.";
        modal.selected = 0;
        this.tui?.requestRender();
      },
    );
  }

  private endpointModelChoices(
    modal: Extract<ActiveModal, { kind: "endpoint-model" }>,
  ): Array<{ kind: "model" | "use-typed" | "manual" | "refresh"; value: string; label: string; description?: string; current?: boolean }> {
    const curVal = getSettingValue(this.cfg, modal.entry);
    const curStr = typeof curVal === "string" ? curVal.trim() : "";
    const q = modal.input.getValue().trim();

    const modelChoices = modal.models.map((m) => ({
      kind: "model" as const,
      value: m.id,
      label: m.id,
      description: m.description ?? (m.ownedBy ? `owned by ${m.ownedBy}` : undefined),
      current: m.id === curStr,
    }));
    const matched = q ? fuzzyFilter(modelChoices, q, (m) => `${m.label} ${m.description ?? ""}`) : modelChoices;

    const out: Array<{ kind: "model" | "use-typed" | "manual" | "refresh"; value: string; label: string; description?: string; current?: boolean }> = [...matched];

    if (q) {
      if (!matched.some((m) => m.value === q)) {
        out.push({
          kind: "use-typed",
          value: q,
          label: `Use "${q}"`,
          description: "Set this custom model ID manually",
        });
      }
      out.push({
        kind: "manual",
        value: CUSTOM_MODEL_SENTINEL,
        label: "Enter model ID manually…",
        description: curStr ? `Open manual text editor (current: ${curStr})` : "Open manual text editor",
      });
      return out;
    }

    out.push({
      kind: "manual",
      value: CUSTOM_MODEL_SENTINEL,
      label: "Enter model ID manually…",
      description: curStr ? `Type a custom model ID instead (current: ${curStr})` : "Type a custom model ID instead of picking from /v1/models",
    });

    if (modal.status === "error" || (modal.status === "ready" && modal.url)) {
      out.push({
        kind: "refresh",
        value: REFRESH_MODELS_SENTINEL,
        label: modal.status === "error" ? "↻ Retry /v1/models" : "↻ Refresh /v1/models",
        description: modal.url ? `Re-fetch model list from ${modal.url}` : "Re-fetch model list from /v1/models",
      });
    }

    return out;
  }

  private openEnumModal(entry: ScalarSetting): void {
    const opts: Array<{ value: string | undefined; label: string; description?: string }> = [];
    if (entry.nullLabel) {
      opts.push({ value: undefined, label: entry.nullLabel, description: "Clear override and inherit the default value" });
    }
    for (const o of entry.options ?? []) {
      opts.push({ value: o.value, label: o.label ?? o.value, description: o.description });
    }
    const cur = getSettingValue(this.cfg, entry);
    const curNorm = cur === null || cur === undefined || cur === "" ? undefined : String(cur);
    const idx = Math.max(0, opts.findIndex((o) => o.value === curNorm));
    this.modal = { kind: "enum", entry, options: opts, selected: idx };
  }

  private openModelModal(entry: ScalarSetting): void {
    const input = new Input({ prompt: "Filter: ", placeholder: "Search provider/model..." });
    const cur = getSettingValue(this.cfg, entry);
    const curStr = typeof cur === "string" ? cur : "";
    const choices = this.filteredModelChoices(entry, "");
    const idx = Math.max(0, choices.findIndex((c) => c.value === (curStr || INHERIT_MODEL_SENTINEL)));
    this.modal = { kind: "model", entry, input, selected: idx };
  }

  private filteredModelChoices(entry: ScalarSetting, query: string): Array<{ value: string; label: string; description?: string }> {
    const base: Array<{ value: string; label: string; description?: string }> = [
      { value: INHERIT_MODEL_SENTINEL, label: entry.nullLabel ?? "(inherit / default)", description: "Clear override and inherit default model" },
    ];
    const models = this.availableModels.map((m) => ({
      value: `${m.provider}/${m.id}`,
      label: `${m.provider}/${m.id}`,
      description: m.name && m.name !== m.id ? m.name : `Provider: ${m.provider}`,
    }));
    const q = query.trim();
    const matched = q ? fuzzyFilter(models, q, (m) => `${m.label} ${m.description ?? ""}`) : models;
    return [
      ...(q ? [] : base),
      ...matched,
      { value: CUSTOM_MODEL_SENTINEL, label: "Custom model ID…", description: "Enter any <provider>/<model-id> manually" },
    ];
  }

  private openTextModal(entry: ScalarSetting): void {
    const cur = getSettingValue(this.cfg, entry);
    const isSecret = entry.kind === "secret";
    const input = new Input({ prompt: "> ", placeholder: entry.placeholder ?? "" });
    // For secrets, prefill empty so existing secret is not exposed in clear text unless re-typed
    this.prefillInput(input, isSecret ? "" : rawInputValue(entry, cur));

    const bounds: string[] = [];
    if (entry.min !== undefined) bounds.push(`min ${entry.min}`);
    if (entry.max !== undefined) bounds.push(`max ${entry.max}`);
    if (entry.unit) bounds.push(`unit: ${entry.unit}`);
    if (isSecret && typeof cur === "string" && cur.trim()) bounds.push(`current: ${maskSecret(cur)}`);
    if (entry.kind === "nullable-number") bounds.push("blank = default/null");
    else if (entry.kind === "number-or-auto") bounds.push('number or "auto"');
    else if (entry.kind === "optional-string" || isSecret) bounds.push("blank = clear");
    const def = getSettingDefault(entry);
    bounds.push(`default: ${formatSettingValue(entry, def)}`);

    this.modal = {
      kind: "text",
      title: entry.label,
      subtitle: `${entry.path} (${bounds.join(" · ")})`,
      description: entry.description,
      hint: isSecret ? "Enter to save (blank clears) · Esc to keep" : "Enter to save · Esc to cancel",
      input,
      secret: isSecret,
      placeholder: entry.placeholder,
      onCommit: (raw) => {
        const parsed = parseSettingInput(entry, raw);
        if (!parsed.ok) return parsed.error;
        const next = setSettingValue(this.cfg, entry, parsed.value);
        this.commitConfig(next, `${entry.label} = ${formatSettingValue(entry, parsed.value)}`);
        return null;
      },
    };
  }

  // ── Modal input handling

  private handleModalInput(data: string): void {
    const m = this.modal!;
    if (m.kind === "text") {
      if (this.isCancel(data)) {
        this.modal = null;
        return;
      }
      if (this.isConfirm(data)) {
        const res = m.onCommit(m.input.getValue());
        if (res === "__keep_modal__") return;
        if (res === null) this.modal = null;
        else m.error = res;
        return;
      }
      m.error = undefined;
      m.input.handleInput(data);
      return;
    }

    if (m.kind === "enum") {
      const n = m.options.length;
      if (this.isCancel(data) || data === "q") {
        this.modal = null;
        return;
      }
      if (this.isUp(data)) {
        m.selected = (m.selected - 1 + n) % n;
      } else if (this.isDown(data)) {
        m.selected = (m.selected + 1) % n;
      } else if (this.isConfirm(data) || data === " ") {
        const chosen = m.options[m.selected]!;
        const next = setSettingValue(this.cfg, m.entry, chosen.value);
        this.commitConfig(next, `${m.entry.label} = ${chosen.label}`);
        this.modal = null;
      }
      return;
    }

    if (m.kind === "endpoint-model") {
      const choices = this.endpointModelChoices(m);
      const n = choices.length;
      if (m.selected >= n) m.selected = Math.max(0, n - 1);
      if (this.isCancel(data)) {
        m.abort?.abort();
        m.abort = undefined;
        this.modal = null;
        return;
      }
      if (this.isUp(data, false)) {
        if (n) m.selected = (m.selected - 1 + n) % n;
      } else if (this.isDown(data, false)) {
        if (n) m.selected = (m.selected + 1) % n;
      } else if (this.isPageUp(data)) {
        if (n) m.selected = Math.max(0, m.selected - Math.max(1, Math.floor(this.maxListRows() / 2)));
      } else if (this.isPageDown(data)) {
        if (n) m.selected = Math.min(n - 1, m.selected + Math.max(1, Math.floor(this.maxListRows() / 2)));
      } else if (matchesKey(data, Key.ctrl("r"))) {
        if (m.status !== "no-url") this.startEndpointModelsFetch(m);
      } else if (this.isConfirm(data)) {
        const chosen = choices[m.selected];
        if (!chosen) return;
        if (chosen.kind === "refresh") {
          this.startEndpointModelsFetch(m);
          return;
        }
        m.abort?.abort();
        m.abort = undefined;
        if (chosen.kind === "manual") {
          this.modal = null;
          this.openTextModal(m.entry);
          return;
        }
        const next = setSettingValue(this.cfg, m.entry, chosen.value);
        this.commitConfig(next, `${m.entry.label} = ${chosen.value}`);
        this.modal = null;
      } else {
        const prev = m.input.getValue();
        m.input.handleInput(data);
        if (m.input.getValue() !== prev) m.selected = 0;
      }
      return;
    }

    if (m.kind === "model") {
      const choices = this.filteredModelChoices(m.entry, m.input.getValue());
      const n = choices.length;
      if (m.selected >= n) m.selected = Math.max(0, n - 1);
      if (this.isCancel(data)) {
        this.modal = null;
        return;
      }
      if (this.isUp(data, false)) {
        if (n) m.selected = (m.selected - 1 + n) % n;
      } else if (this.isDown(data, false)) {
        if (n) m.selected = (m.selected + 1) % n;
      } else if (this.isConfirm(data)) {
        const chosen = choices[m.selected];
        if (!chosen) return;
        if (chosen.value === CUSTOM_MODEL_SENTINEL) {
          this.modal = null;
          this.openTextModal(m.entry);
        } else if (chosen.value === INHERIT_MODEL_SENTINEL) {
          const next = setSettingValue(this.cfg, m.entry, undefined);
          this.commitConfig(next, `${m.entry.label} = ${m.entry.nullLabel ?? "default"}`);
          this.modal = null;
        } else {
          const next = setSettingValue(this.cfg, m.entry, chosen.value);
          this.commitConfig(next, `${m.entry.label} = ${chosen.value}`);
          this.modal = null;
        }
      } else {
        const prev = m.input.getValue();
        m.input.handleInput(data);
        if (m.input.getValue() !== prev) m.selected = 0;
      }
    }
  }

  // ───────────────────────────── Rendering

  render(width: number): readonly string[] {
    const w = Math.max(30, width);
    const t = this.theme;
    const border = t.fg("border", "─".repeat(w));
    const lines: string[] = [border];

    // Header: breadcrumb left, flash/path right
    const crumbs = this.breadcrumb();
    const rightText = this.flash
      ? t.fg(this.flash.tone, this.flash.text)
      : t.fg("dim", this.shortPath(this.configPath));
    lines.push(this.spreadRow(` ${t.bold(t.fg("accent", crumbs))}`, `${rightText} `, w));

    this.lastVisibleSelectableIndices = [];

    if (this.modal) {
      lines.push(...this.renderModal(this.modal, w));
    } else {
      const view = this.topView();
      if (view.kind === "home") lines.push(...this.renderHome(view, w, lines.length));
      else if (view.kind === "screen") lines.push(...this.renderScreen(view, w, lines.length));
      else if (view.kind === "search") lines.push(...this.renderSearch(view, w, lines.length));
      else if (view.kind === "multi-enum") lines.push(...this.renderMultiEnum(view, w, lines.length));
      else if (view.kind === "string-list") lines.push(...this.renderStringList(view, w, lines.length));
      else if (view.kind === "string-map") lines.push(...this.renderStringMap(view, w, lines.length));
      else if (view.kind === "model-overrides") lines.push(...this.renderModelOverrides(view, w, lines.length));
    }

    lines.push(border);
    return lines;
  }

  private breadcrumb(): string {
    const parts = ["realctx2 settings"];
    for (const v of this.stack) {
      if (v.kind === "screen") parts.push(v.title);
      else if (v.kind === "search") parts.push("Search");
      else if (v.kind === "multi-enum" || v.kind === "string-list" || v.kind === "string-map" || v.kind === "model-overrides") parts.push(v.entry.label);
    }
    return parts.join(" › ");
  }

  private shortPath(p: string): string {
    const home = process.env.HOME;
    return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  }

  private spreadRow(left: string, right: string, width: number): string {
    const lw = visibleWidth(left);
    const rw = visibleWidth(right);
    if (lw + rw + 2 <= width) {
      return left + " ".repeat(width - lw - rw) + right;
    }
    const maxLeft = Math.max(10, width - rw - 2);
    const truncLeft = truncateToWidth(left, maxLeft);
    const gap = Math.max(1, width - visibleWidth(truncLeft) - rw);
    return truncateToWidth(truncLeft + " ".repeat(gap) + right, width);
  }

  private renderDivider(width: number): string {
    return this.theme.fg("borderMuted", ` ${"┄".repeat(Math.max(1, width - 2))} `);
  }

  private renderSectionHeader(title: string, width: number): string {
    const label = `  ── ${title} `;
    const fill = Math.max(0, width - visibleWidth(label) - 1);
    return truncateToWidth(this.theme.bold(this.theme.fg("muted", label)) + this.theme.fg("borderMuted", "─".repeat(fill)), width);
  }

  private renderDescriptionBox(
    meta: string | undefined,
    description: string,
    width: number,
  ): string[] {
    const t = this.theme;
    const out: string[] = [this.renderDivider(width)];
    if (meta) out.push(truncateToWidth(`  ${meta}`, width));
    for (const line of wrapTextWithAnsi(description, Math.max(16, width - 4))) {
      out.push(t.fg("muted", `  ${line}`));
    }
    return out;
  }

  private siblingEnvVarFor(path: string): string | undefined {
    const dot = path.lastIndexOf(".");
    if (dot < 0) return undefined;
    const sibling = getConfigPath(this.cfg, `${path.slice(0, dot)}.apiKeyEnv`);
    return typeof sibling === "string" ? normalizeEnvVarName(sibling) : undefined;
  }

  private formatEntryDisplayValue(entry: EditableSetting): string {
    const val = getSettingValue(this.cfg, entry);
    const base = formatSettingValue(entry, val);
    if (entry.kind === "model-overrides") return `${base} ›`;
    if (!isScalarSetting(entry)) return base;
    if (entry.envVar && typeof val === "string") {
      const envName = normalizeEnvVarName(val);
      if (envName) {
        const present = Boolean(process.env[envName]?.trim());
        return `${base} (${present ? "set" : "unset"})`;
      }
    }
    if (entry.secretFile && typeof val === "string" && val.trim()) {
      const res = readSecretFromFile(val.trim(), this.siblingEnvVarFor(entry.path));
      return `${base} (${res.key ? "ok" : "unreadable"})`;
    }
    return base;
  }

  private renderSettingMeta(entry: EditableSetting): string {
    const t = this.theme;
    const parts: string[] = [t.fg("accent", entry.path)];
    const def = getSettingDefault(entry);
    parts.push(t.fg("dim", `default: ${formatSettingValue(entry, def)}`));
    if (isSettingModified(this.cfg, entry)) {
      parts.push(t.fg("warning", "modified"));
    }
    if (isScalarSetting(entry) && entry.envVar) {
      const val = getSettingValue(this.cfg, entry);
      const envName = typeof val === "string" ? normalizeEnvVarName(val) : undefined;
      if (envName) {
        const present = Boolean(process.env[envName]?.trim());
        parts.push(present ? t.fg("success", `$${envName} set`) : t.fg("warning", `$${envName} not set in env`));
      }
    }
    if (isScalarSetting(entry) && entry.secretFile) {
      const val = getSettingValue(this.cfg, entry);
      if (typeof val === "string" && val.trim()) {
        const res = readSecretFromFile(val.trim(), this.siblingEnvVarFor(entry.path));
        parts.push(res.key ? t.fg("success", "secret file readable") : t.fg("warning", `secret file: ${res.error}`));
      }
    }
    if (this.projectOverrides.has(entry.path) && this.effectiveConfig) {
      const eff = getConfigPath(this.effectiveConfig, entry.path);
      parts.push(t.fg("warning", `[project override: ${formatSettingValue(entry, eff)}]`));
    }
    parts.push(t.fg("dim", entry.restart ? "next session" : "applies live"));
    return parts.join(t.fg("dim", " · "));
  }

  // ── Render Home (category selector + live search)

  private renderHome(view: Extract<ViewState, { kind: "home" }>, width: number, baseY: number): string[] {
    const t = this.theme;
    const query = view.input.getValue().trim();
    const lines: string[] = [""];
    for (const l of view.input.render(Math.max(20, width - 4))) {
      lines.push(`  ${l}`);
    }
    lines.push("");

    const matches = this.homeMatches(view);
    if (!matches.length) {
      lines.push(t.fg("dim", `  No categories or settings matching "${query}".`));
      lines.push("");
      lines.push(truncateToWidth(t.fg("dim", "  Type to search · Esc clear search"), width));
      return lines;
    }

    if (!query) {
      lines.push(this.renderSectionHeader("Categories", width));
      const labelCol = Math.min(28, Math.max(...SETTINGS_CATEGORIES.map((c) => visibleWidth(c.title))) + 2);
      SETTINGS_CATEGORIES.forEach((cat, idx) => {
        const sel = idx === view.selected;
        const cursor = sel ? t.fg("accent", "▸ ") : "  ";
        const label = cat.title + " ".repeat(Math.max(0, labelCol - visibleWidth(cat.title)));
        const styledLabel = sel ? t.bold(t.fg("accent", label)) : t.fg("text", label);
        const summary = cat.summary(this.cfg, this.effectiveDisplayContext());
        const valMax = Math.max(8, width - 4 - labelCol - 2);
        const styledVal = sel ? t.fg("accent", truncateToWidth(`${summary} ›`, valMax)) : t.fg("muted", truncateToWidth(`${summary} ›`, valMax));
        this.lastVisibleSelectableIndices.push({ rowY: baseY + lines.length, index: idx });
        lines.push(truncateToWidth(`  ${cursor}${styledLabel}${styledVal}`, width));
      });

      const cur = SETTINGS_CATEGORIES[view.selected];
      if (cur) {
        lines.push("");
        lines.push(...this.renderDescriptionBox(t.bold(t.fg("text", cur.title)), cur.description, width));
      }
      lines.push("");
      lines.push(truncateToWidth(t.fg("dim", "  ↑↓ navigate · Enter open category · Type to search all settings · Esc close"), width));
      return lines;
    }

    // Filtered mode: show matching categories + matching settings with section headers
    type VisualHomeRow =
      | { kind: "section"; title: string }
      | { kind: "spacer" }
      | { kind: "match"; match: HomeMatch; matchIndex: number };

    const catMatches = matches.filter((m): m is Extract<HomeMatch, { kind: "category" }> => m.kind === "category");
    const settingMatches = matches.filter((m): m is Extract<HomeMatch, { kind: "setting" }> => m.kind === "setting");
    const visual: VisualHomeRow[] = [];
    let matchIdx = 0;
    if (catMatches.length) {
      visual.push({ kind: "section", title: "Categories" });
      for (const m of catMatches) visual.push({ kind: "match", match: m, matchIndex: matchIdx++ });
    }
    if (settingMatches.length) {
      if (visual.length) visual.push({ kind: "spacer" });
      visual.push({ kind: "section", title: `Settings (${settingMatches.length} match${settingMatches.length === 1 ? "" : "es"})` });
      for (const m of settingMatches) visual.push({ kind: "match", match: m, matchIndex: matchIdx++ });
    }

    const maxVis = Math.max(6, this.maxListRows() - 2);
    const selVisual = visual.findIndex((vr) => vr.kind === "match" && vr.matchIndex === view.selected);
    let start = Math.max(0, Math.min(selVisual - Math.floor(maxVis / 2), visual.length - maxVis));
    if (start > 0 && visual[start - 1]?.kind === "section") start -= 1;
    if (visual[start]?.kind === "spacer" && start + 1 < visual.length) start += 1;
    const end = Math.min(visual.length, start + maxVis);

    const visibleLabels = visual
      .slice(start, end)
      .filter((vr): vr is Extract<VisualHomeRow, { kind: "match" }> => vr.kind === "match")
      .map((vr) => (vr.match.kind === "category" ? vr.match.category.title : vr.match.item.entry.label));
    const maxLabel = Math.min(34, Math.max(16, ...visibleLabels.map((l) => visibleWidth(l))));

    for (let vi = start; vi < end; vi++) {
      const vr = visual[vi]!;
      if (vr.kind === "spacer") {
        lines.push("");
        continue;
      }
      if (vr.kind === "section") {
        lines.push(this.renderSectionHeader(vr.title, width));
        continue;
      }
      const sel = vr.matchIndex === view.selected;
      const cursor = sel ? t.fg("accent", "▸ ") : "  ";
      this.lastVisibleSelectableIndices.push({ rowY: baseY + lines.length, index: vr.matchIndex });
      if (vr.match.kind === "category") {
        const cat = vr.match.category;
        const pad = " ".repeat(Math.max(0, maxLabel - visibleWidth(cat.title)));
        const lbl = sel ? t.bold(t.fg("accent", cat.title + pad)) : t.fg("text", cat.title + pad);
        const right = `${cat.summary(this.cfg, this.effectiveDisplayContext())} ›`;
        const rightMax = Math.max(10, width - 6 - maxLabel);
        lines.push(truncateToWidth(`  ${cursor}${lbl}  ${sel ? t.fg("accent", truncateToWidth(right, rightMax)) : t.fg("muted", truncateToWidth(right, rightMax))}`, width));
      } else {
        const item = vr.match.item;
        const pad = " ".repeat(Math.max(0, maxLabel - visibleWidth(item.entry.label)));
        const lbl = sel ? t.bold(t.fg("accent", item.entry.label + pad)) : t.fg("text", item.entry.label + pad);
        const val = formatSettingValue(item.entry, getSettingValue(this.cfg, item.entry));
        const scope = `${item.categoryTitle} › ${item.sectionTitle}`;
        const right = `${val}  ${t.fg("dim", scope)}`;
        const rightMax = Math.max(10, width - 6 - maxLabel);
        lines.push(truncateToWidth(`  ${cursor}${lbl}  ${sel ? t.fg("accent", truncateToWidth(right, rightMax)) : t.fg("muted", truncateToWidth(right, rightMax))}`, width));
      }
    }

    if (start > 0 || end < visual.length) {
      lines.push(t.fg("dim", `  (${view.selected + 1}/${matches.length})`));
    }

    const cur = matches[view.selected];
    if (cur) {
      lines.push("");
      if (cur.kind === "category") {
        lines.push(...this.renderDescriptionBox(t.bold(t.fg("text", cur.category.title)), cur.category.description, width));
      } else {
        lines.push(...this.renderDescriptionBox(this.renderSettingMeta(cur.item.entry), cur.item.entry.description, width));
      }
    }
    lines.push("");
    lines.push(truncateToWidth(t.fg("dim", "  Type to filter · ↑↓ navigate · Enter open/edit · Ctrl+R reset · Esc clear search"), width));
    return lines;
  }

  // ── Render Category / Subscreen with separated sections

  private renderScreen(view: Extract<ViewState, { kind: "screen" }>, width: number, baseY: number): string[] {
    const t = this.theme;
    const { spec, rows, entryIndices } = this.screenRows(view);
    const lines: string[] = [];

    if (spec.subtitle) {
      lines.push(truncateToWidth(t.fg("muted", `  ${spec.subtitle}`), width));
    }
    lines.push("");

    if (!entryIndices.length) {
      lines.push(t.fg("dim", "  No settings in this view."));
      lines.push("");
      lines.push(t.fg("dim", "  Esc back"));
      return lines;
    }

    const selectedRowIdx = entryIndices[view.selected]!;
    const maxVis = this.maxListRows();

    // Build visual lines including blank spacer before non-first section headers
    const visualRows: Array<{ row: ScreenRow | { kind: "spacer" }; entryIdx?: number }> = [];
    let entryCounter = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      if (r.kind === "section" && i > 0) visualRows.push({ row: { kind: "spacer" } });
      if (r.kind === "entry") {
        visualRows.push({ row: r, entryIdx: entryCounter++ });
      } else {
        visualRows.push({ row: r });
      }
    }

    const selVisualIdx = visualRows.findIndex((vr) => vr.entryIdx === view.selected);
    let start = Math.max(0, Math.min(selVisualIdx - Math.floor(maxVis / 2), visualRows.length - maxVis));
    // Ensure the section header directly preceding the first visible item is shown when right above
    if (start > 0 && visualRows[start - 1]?.row.kind === "section") start -= 1;
    // Avoid starting the viewport on a blank spacer line
    if (visualRows[start]?.row.kind === "spacer" && start + 1 < visualRows.length) start += 1;
    const end = Math.min(visualRows.length, start + maxVis);

    const allEntries = entryIndices.map((ri) => (rows[ri] as Extract<ScreenRow, { kind: "entry" }>).entry);
    const maxLabel = Math.min(36, Math.max(16, ...allEntries.map((e) => visibleWidth(e.label))));

    for (let vi = start; vi < end; vi++) {
      const vr = visualRows[vi]!;
      if (vr.row.kind === "spacer") {
        lines.push("");
        continue;
      }
      if (vr.row.kind === "section") {
        lines.push(this.renderSectionHeader(vr.row.title, width));
        continue;
      }
      const entry = vr.row.entry;
      const sel = vr.entryIdx === view.selected;
      const cursor = sel ? t.fg("accent", "▸ ") : "  ";
      const modDot = entry.kind !== "subscreen" && entry.kind !== "action" && isSettingModified(this.cfg, entry) ? t.fg("warning", "•") : " ";
      const pad = " ".repeat(Math.max(0, maxLabel - visibleWidth(entry.label)));
      const labelStr = sel ? t.bold(t.fg("accent", entry.label + pad)) : t.fg("text", entry.label + pad);

      const valMax = Math.max(8, width - 6 - maxLabel - 3);
      let valStyled: string;
      if (entry.kind === "action") {
        const st = this.endpointTests[entry.endpoint];
        const btn = entry.buttonText ?? "[ Run ]";
        if (st?.status === "running") {
          const txt = truncateToWidth("⟳ Testing…", valMax);
          valStyled = sel ? t.bold(t.fg("accent", txt)) : t.fg("warning", txt);
        } else if (st?.status === "done") {
          const icon = st.result.ok ? "✓" : "✗";
          const txt = truncateToWidth(`${btn}  ${icon} ${st.result.summary}`, valMax);
          valStyled = st.result.ok ? t.fg("success", txt) : t.fg("error", txt);
        } else {
          const txt = truncateToWidth(btn, valMax);
          valStyled = sel ? t.bold(t.fg("accent", txt)) : t.fg("success", txt);
        }
      } else if (entry.kind === "subscreen") {
        const valTrunc = truncateToWidth(`${entry.summary(this.cfg, this.effectiveDisplayContext())} ›`, valMax);
        valStyled = sel ? t.fg("accent", valTrunc) : t.fg("muted", valTrunc);
      } else {
        const valTrunc = truncateToWidth(this.formatEntryDisplayValue(entry), valMax);
        valStyled = sel
          ? t.fg("accent", valTrunc)
          : isSettingModified(this.cfg, entry)
            ? t.fg("warning", valTrunc)
            : t.fg("muted", valTrunc);
      }

      this.lastVisibleSelectableIndices.push({ rowY: baseY + lines.length, index: vr.entryIdx! });
      lines.push(truncateToWidth(`  ${cursor}${labelStr} ${modDot} ${valStyled}`, width));
    }

    if (start > 0 || end < visualRows.length) {
      lines.push(t.fg("dim", `  (${view.selected + 1}/${entryIndices.length})`));
    }

    const selectedEntry = (rows[selectedRowIdx] as Extract<ScreenRow, { kind: "entry" }>).entry;
    lines.push("");
    let meta: string;
    let descText = selectedEntry.description;
    if (selectedEntry.kind === "subscreen") {
      meta = t.fg("accent", selectedEntry.id) + t.fg("dim", " · press Enter to configure");
    } else if (selectedEntry.kind === "action") {
      const st = this.endpointTests[selectedEntry.endpoint];
      if (st?.status === "running") {
        meta = t.fg("accent", selectedEntry.id) + t.fg("warning", " · running live probe…");
        descText = "Sending probe request to endpoint with current URL, model, and authentication settings…";
      } else if (st?.status === "done") {
        const tone = st.result.ok ? "success" : "error";
        meta =
          t.fg("accent", selectedEntry.id) +
          t.fg("dim", " · ") +
          t.fg(tone, st.result.ok ? `✓ ${st.result.summary}` : `✗ ${st.result.summary}`) +
          t.fg("dim", ` · auth: ${st.result.authSummary}`);
        descText = st.result.detail;
      } else {
        meta = t.fg("accent", selectedEntry.id) + t.fg("dim", " · press Enter or t to test");
      }
    } else {
      meta = this.renderSettingMeta(selectedEntry);
    }
    lines.push(...this.renderDescriptionBox(meta, descText, width));

    const multiSec = spec.sections.length > 1;
    const hasTest = allEntries.some((e) => e.kind === "action" && e.action === "test-endpoint");
    const parts = ["↑↓ navigate"];
    if (multiSec) parts.push("Tab next section");
    parts.push("←→ adjust", "Enter edit");
    if (hasTest) parts.push("t test");
    parts.push("r reset", "/ search", "Esc back");
    const hint = `  ${parts.join(" · ")}`;
    lines.push("");
    lines.push(truncateToWidth(t.fg("dim", hint), width));
    return lines;
  }

  // ── Render Global Search

  private renderSearch(view: Extract<ViewState, { kind: "search" }>, width: number, baseY: number): string[] {
    const t = this.theme;
    const lines: string[] = [""];
    for (const l of view.input.render(Math.max(20, width - 4))) {
      lines.push(`  ${l}`);
    }
    lines.push("");

    const results = this.searchResults(view);
    if (!results.length) {
      lines.push(t.fg("dim", "  No matching settings."));
      lines.push("");
      lines.push(t.fg("dim", "  Type to filter · Esc back"));
      return lines;
    }

    const maxVis = Math.max(6, this.maxListRows() - 2);
    const start = Math.max(0, Math.min(view.selected - Math.floor(maxVis / 2), results.length - maxVis));
    const end = Math.min(results.length, start + maxVis);
    const maxLabel = Math.min(34, Math.max(16, ...results.slice(start, end).map((r) => visibleWidth(r.entry.label))));

    for (let i = start; i < end; i++) {
      const item = results[i]!;
      const sel = i === view.selected;
      const cursor = sel ? t.fg("accent", "▸ ") : "  ";
      const pad = " ".repeat(Math.max(0, maxLabel - visibleWidth(item.entry.label)));
      const lbl = sel ? t.bold(t.fg("accent", item.entry.label + pad)) : t.fg("text", item.entry.label + pad);
      const val = formatSettingValue(item.entry, getSettingValue(this.cfg, item.entry));
      const scope = `${item.categoryTitle} › ${item.sectionTitle}`;
      const right = `${val}  ${t.fg("dim", scope)}`;
      const rightMax = Math.max(10, width - 6 - maxLabel);
      this.lastVisibleSelectableIndices.push({ rowY: baseY + lines.length, index: i });
      lines.push(truncateToWidth(`  ${cursor}${lbl}  ${sel ? t.fg("accent", truncateToWidth(right, rightMax)) : t.fg("muted", truncateToWidth(right, rightMax))}`, width));
    }

    if (results.length > maxVis) {
      lines.push(t.fg("dim", `  (${view.selected + 1}/${results.length} matches)`));
    }

    const cur = results[view.selected];
    if (cur) {
      lines.push("");
      lines.push(...this.renderDescriptionBox(this.renderSettingMeta(cur.entry), cur.entry.description, width));
    }
    lines.push("");
    lines.push(truncateToWidth(t.fg("dim", "  Type to filter · ↑↓ navigate · Enter edit · Ctrl+R reset · Esc back"), width));
    return lines;
  }

  // ── Render Multi-Enum checklist

  private renderMultiEnum(view: Extract<ViewState, { kind: "multi-enum" }>, width: number, baseY: number): string[] {
    const t = this.theme;
    const opts = view.entry.options ?? [];
    const active = new Set(this.getList(view.entry));
    const lines: string[] = [
      truncateToWidth(t.fg("muted", `  Toggle values for ${view.entry.path}`), width),
      "",
    ];

    opts.forEach((opt: EnumOption, i: number) => {
      const sel = i === view.selected;
      const checked = active.has(opt.value);
      const cursor = sel ? t.fg("accent", "▸ ") : "  ";
      const box = checked ? t.fg("success", "[x]") : t.fg("dim", "[ ]");
      const label = sel ? t.bold(t.fg("accent", opt.label ?? opt.value)) : t.fg("text", opt.label ?? opt.value);
      this.lastVisibleSelectableIndices.push({ rowY: baseY + lines.length, index: i });
      lines.push(truncateToWidth(`  ${cursor}${box} ${label}`, width));
    });

    const cur = opts[view.selected];
    lines.push("");
    lines.push(...this.renderDescriptionBox(this.renderSettingMeta(view.entry), cur?.description ?? view.entry.description, width));
    lines.push("");
    lines.push(truncateToWidth(t.fg("dim", "  ↑↓ navigate · Space/Enter toggle · r reset to default · Esc back"), width));
    return lines;
  }

  // ── Render String-List editor

  private renderStringList(view: Extract<ViewState, { kind: "string-list" }>, width: number, baseY: number): string[] {
    const t = this.theme;
    const list = this.getList(view.entry);
    const total = list.length + 1;
    const maxVis = this.maxListRows();
    const start = Math.max(0, Math.min(view.selected - Math.floor(maxVis / 2), total - maxVis));
    const end = Math.min(total, start + maxVis);

    const lines: string[] = [
      truncateToWidth(t.fg("muted", `  ${list.length} item${list.length === 1 ? "" : "s"} in ${view.entry.path}`), width),
      "",
    ];

    for (let i = start; i < end; i++) {
      const sel = i === view.selected;
      const cursor = sel ? t.fg("accent", "▸ ") : "  ";
      this.lastVisibleSelectableIndices.push({ rowY: baseY + lines.length, index: i });
      if (i < list.length) {
        const text = list[i]!;
        lines.push(truncateToWidth(`  ${cursor}${sel ? t.bold(t.fg("accent", text)) : t.fg("text", text)}`, width));
      } else {
        const add = "+ Add item…";
        lines.push(truncateToWidth(`  ${cursor}${sel ? t.bold(t.fg("accent", add)) : t.fg("success", add)}`, width));
      }
    }

    if (total > maxVis) lines.push(t.fg("dim", `  (${view.selected + 1}/${total})`));
    lines.push("");
    lines.push(...this.renderDescriptionBox(this.renderSettingMeta(view.entry), view.entry.description, width));
    lines.push("");
    lines.push(truncateToWidth(t.fg("dim", "  ↑↓ navigate · Enter edit/add · a add · d delete · r reset to default · Esc back"), width));
    return lines;
  }

  // ── Render String-Map (HTTP Headers) editor

  private renderStringMap(view: Extract<ViewState, { kind: "string-map" }>, width: number, baseY: number): string[] {
    const t = this.theme;
    const pairs = this.getMapEntries(view.entry);
    const total = pairs.length + 1;
    const maxVis = this.maxListRows();
    const start = Math.max(0, Math.min(view.selected - Math.floor(maxVis / 2), total - maxVis));
    const end = Math.min(total, start + maxVis);

    const lines: string[] = [
      truncateToWidth(t.fg("muted", `  ${pairs.length} header${pairs.length === 1 ? "" : "s"} in ${view.entry.path}`), width),
      "",
    ];

    for (let i = start; i < end; i++) {
      const sel = i === view.selected;
      const cursor = sel ? t.fg("accent", "▸ ") : "  ";
      this.lastVisibleSelectableIndices.push({ rowY: baseY + lines.length, index: i });
      if (i < pairs.length) {
        const [k, v] = pairs[i]!;
        const text = `${k}: ${this.maskHeaderValue(k, v)}`;
        lines.push(truncateToWidth(`  ${cursor}${sel ? t.bold(t.fg("accent", text)) : t.fg("text", text)}`, width));
      } else {
        const add = "+ Add header…";
        lines.push(truncateToWidth(`  ${cursor}${sel ? t.bold(t.fg("accent", add)) : t.fg("success", add)}`, width));
      }
    }

    if (total > maxVis) lines.push(t.fg("dim", `  (${view.selected + 1}/${total})`));
    lines.push("");
    lines.push(...this.renderDescriptionBox(this.renderSettingMeta(view.entry), view.entry.description, width));
    lines.push("");
    lines.push(truncateToWidth(t.fg("dim", "  ↑↓ navigate · Enter edit/add · a add · d delete · r clear all · Esc back"), width));
    return lines;
  }

  // ── Render Per-Model Overrides screen (maxWindow, cacheTTL)

  private formatCompactTokens(tokens: number): string {
    if (tokens >= 1_000_000) {
      const m = tokens / 1_000_000;
      return `${Number.isInteger(m) ? m : Number(m.toFixed(2))}M`;
    }
    return `${Math.round(tokens / 1000)}k`;
  }

  private renderModelOverrides(view: Extract<ViewState, { kind: "model-overrides" }>, width: number, baseY: number): string[] {
    const t = this.theme;
    const map = this.getModelOverrideMap(view.entry);
    const activeCount = Object.values(map).filter((v) => v !== "auto" && v !== undefined).length;
    const rows = this.modelOverrideRows(view);

    const lines: string[] = [
      truncateToWidth(
        t.fg(
          "muted",
          `  Default: ${view.entry.defaultSummary(this.cfg)} · ${activeCount} override${activeCount === 1 ? "" : "s"} · ${this.knownModels.length} known model${this.knownModels.length === 1 ? "" : "s"}`,
        ),
        width,
      ),
      "",
    ];

    for (const l of view.input.render(Math.max(20, width - 4))) {
      lines.push(`  ${l}`);
    }
    lines.push("");

    const maxVis = Math.max(5, this.maxListRows() - 3);
    const start = Math.max(0, Math.min(view.selected - Math.floor(maxVis / 2), Math.max(0, rows.length - maxVis)));
    const end = Math.min(rows.length, start + maxVis);

    for (let i = start; i < end; i++) {
      const row = rows[i]!;
      const sel = i === view.selected;
      const cursor = sel ? t.fg("accent", "▸ ") : "  ";
      this.lastVisibleSelectableIndices.push({ rowY: baseY + lines.length, index: i });

      if (row.kind === "model") {
        const overridden = row.value !== undefined && row.value !== "auto";
        const modDot = overridden ? t.fg("warning", "•") : " ";
        const valText = formatModelOverrideValue(view.entry, row.value);
        const valStyled = sel
          ? t.bold(t.fg(overridden ? (row.value === 0 ? "warning" : "accent") : "accent", valText))
          : overridden
            ? t.fg(row.value === 0 ? "error" : "warning", valText)
            : t.fg("dim", valText);
        const ctxHint =
          view.entry.showContextWindow && row.contextWindow
            ? t.fg("dim", ` (${this.formatCompactTokens(row.contextWindow)})`)
            : row.custom
              ? t.fg("dim", " (custom)")
              : "";
        const leftStyled = `  ${cursor}${modDot} ${sel ? t.bold(t.fg("accent", row.key)) : t.fg("text", row.key)}${ctxHint}`;
        lines.push(this.spreadRow(leftStyled, `${valStyled}  `, width));
      } else if (row.kind === "add-query") {
        const label = `+ Add "${row.key}"…`;
        const right = t.fg("dim", "auto  ");
        lines.push(this.spreadRow(`  ${cursor}  ${sel ? t.bold(t.fg("accent", label)) : t.fg("success", label)}`, right, width));
      } else {
        const label = "+ Add custom model…";
        lines.push(truncateToWidth(`  ${cursor}  ${sel ? t.bold(t.fg("accent", label)) : t.fg("success", label)}`, width));
      }
    }

    if (rows.length > maxVis) {
      lines.push(t.fg("dim", `  (${view.selected + 1}/${rows.length})`));
    }

    lines.push("");
    lines.push(...this.renderDescriptionBox(this.renderSettingMeta(view.entry), view.entry.description, width));
    lines.push("");
    lines.push(
      truncateToWidth(
        t.fg("dim", "  ↑↓ navigate · Enter edit/add · Ctrl+R reset to auto · Type to filter or add model · Esc back"),
        width,
      ),
    );
    return lines;
  }

  // ── Render Modals (Text input, Enum picker, Model picker)

  private renderModal(modal: ActiveModal, width: number): string[] {
    const t = this.theme;
    if (modal.kind === "text") {
      const lines: string[] = [
        "",
        truncateToWidth(`  ${t.bold(t.fg("text", modal.title))}`, width),
        truncateToWidth(`  ${t.fg("dim", modal.subtitle)}`, width),
        "",
      ];
      if (modal.secret) {
        const raw = modal.input.getValue();
        const maskedLine =
          raw.length > 0
            ? `  > ${"•".repeat(Math.min(raw.length, Math.max(8, width - 18)))} ${t.fg("dim", `(${raw.length} char${raw.length === 1 ? "" : "s"})`)}`
            : `  > ${t.fg("dim", modal.placeholder || "(enter secret)")}`;
        lines.push(truncateToWidth(maskedLine, width));
      } else {
        for (const l of modal.input.render(Math.max(20, width - 4))) {
          lines.push(`  ${l}`);
        }
      }
      if (modal.error) {
        lines.push("");
        lines.push(truncateToWidth(`  ${t.fg("error", `✗ ${modal.error}`)}`, width));
      }
      lines.push("");
      lines.push(...this.renderDescriptionBox(undefined, modal.description, width));
      lines.push("");
      lines.push(truncateToWidth(t.fg("dim", `  ${modal.hint}`), width));
      return lines;
    }

    if (modal.kind === "enum") {
      const lines: string[] = [
        "",
        truncateToWidth(`  ${t.bold(t.fg("text", modal.entry.label))}  ${t.fg("dim", modal.entry.path)}`, width),
        "",
      ];
      const curVal = getSettingValue(this.cfg, modal.entry);
      const curNorm = curVal === null || curVal === undefined || curVal === "" ? undefined : String(curVal);
      const maxLbl = Math.min(26, Math.max(10, ...modal.options.map((o) => visibleWidth(o.label))));
      modal.options.forEach((opt, i) => {
        const sel = i === modal.selected;
        const active = opt.value === curNorm;
        const cursor = sel ? t.fg("accent", "▸ ") : "  ";
        const check = active ? t.fg("success", "✓ ") : "  ";
        const pad = " ".repeat(Math.max(0, maxLbl - visibleWidth(opt.label)));
        const lbl = sel ? t.bold(t.fg("accent", opt.label + pad)) : t.fg("text", opt.label + pad);
        const descMax = Math.max(10, width - 8 - maxLbl);
        const desc = opt.description ? t.fg("muted", truncateToWidth(opt.description, descMax)) : "";
        lines.push(truncateToWidth(`  ${cursor}${check}${lbl}  ${desc}`, width));
      });
      const chosen = modal.options[modal.selected];
      lines.push("");
      lines.push(
        ...this.renderDescriptionBox(
          this.renderSettingMeta(modal.entry),
          chosen?.description ? `${chosen.description}\n${modal.entry.description}` : modal.entry.description,
          width,
        ),
      );
      lines.push("");
      lines.push(truncateToWidth(t.fg("dim", "  ↑↓ select · Enter apply · Esc cancel"), width));
      return lines;
    }

    if (modal.kind === "endpoint-model") {
      const lines: string[] = [
        "",
        truncateToWidth(`  ${t.bold(t.fg("text", modal.entry.label))}  ${t.fg("dim", modal.entry.path)}`, width),
      ];
      if (modal.status === "loading") {
        lines.push(truncateToWidth(`  ${t.fg("warning", `⟳ Fetching models from ${modal.url ?? "/v1/models"}…`)}`, width));
      } else if (modal.status === "ready" && modal.models.length > 0) {
        const countLabel = `${modal.models.length} model${modal.models.length === 1 ? "" : "s"}`;
        lines.push(truncateToWidth(`  ${t.fg("success", `✓ ${countLabel}`)} ${t.fg("dim", `from ${modal.url ?? "/v1/models"}`)}`, width));
      } else if (modal.status === "no-url") {
        lines.push(truncateToWidth(`  ${t.fg("muted", `ℹ ${modal.error ?? "Set Endpoint URL first to retrieve models from /v1/models."}`)}`, width));
      } else if (modal.status === "ready") {
        lines.push(truncateToWidth(`  ${t.fg("warning", `ℹ ${modal.error ?? "No models returned by /v1/models."}`)}`, width));
      } else {
        lines.push(truncateToWidth(`  ${t.fg("warning", `⚠ /v1/models unavailable: ${modal.error ?? "request failed"}`)}`, width));
      }
      lines.push("");

      for (const l of modal.input.render(Math.max(20, width - 4))) {
        lines.push(`  ${l}`);
      }
      lines.push("");

      const choices = this.endpointModelChoices(modal);
      const maxVis = Math.max(6, this.maxListRows() - 4);
      const selIdx = Math.min(modal.selected, Math.max(0, choices.length - 1));
      const start = Math.max(0, Math.min(selIdx - Math.floor(maxVis / 2), choices.length - maxVis));
      const end = Math.min(choices.length, start + maxVis);
      for (let i = start; i < end; i++) {
        const c = choices[i]!;
        const sel = i === selIdx;
        const cursor = sel ? t.fg("accent", "▸ ") : "  ";
        const check = c.current ? t.fg("success", "✓ ") : "  ";
        const lbl = sel
          ? t.bold(t.fg("accent", c.label))
          : c.kind === "manual" || c.kind === "refresh"
            ? t.fg("muted", c.label)
            : t.fg("text", c.label);
        const desc = c.description ? t.fg("dim", `  ${c.description}`) : "";
        lines.push(truncateToWidth(`  ${cursor}${check}${lbl}${desc}`, width));
      }
      if (choices.length > maxVis) {
        lines.push(t.fg("dim", `  (${selIdx + 1}/${choices.length})`));
      }
      lines.push("");
      lines.push(...this.renderDescriptionBox(this.renderSettingMeta(modal.entry), modal.entry.description, width));
      lines.push("");
      const hintParts = ["Type to filter or enter custom ID", "↑↓ select", "Enter apply"];
      if (modal.status !== "no-url") hintParts.push("Ctrl+R refresh");
      hintParts.push("Esc cancel");
      lines.push(truncateToWidth(t.fg("dim", `  ${hintParts.join(" · ")}`), width));
      return lines;
    }

    // Model picker
    const lines: string[] = [
      "",
      truncateToWidth(`  ${t.bold(t.fg("text", modal.entry.label))}  ${t.fg("dim", modal.entry.path)}`, width),
      "",
    ];
    for (const l of modal.input.render(Math.max(20, width - 4))) {
      lines.push(`  ${l}`);
    }
    lines.push("");
    const choices = this.filteredModelChoices(modal.entry, modal.input.getValue());
    const maxVis = Math.max(6, this.maxListRows() - 3);
    const start = Math.max(0, Math.min(modal.selected - Math.floor(maxVis / 2), choices.length - maxVis));
    const end = Math.min(choices.length, start + maxVis);
    for (let i = start; i < end; i++) {
      const c = choices[i]!;
      const sel = i === modal.selected;
      const cursor = sel ? t.fg("accent", "▸ ") : "  ";
      const lbl = sel ? t.bold(t.fg("accent", c.label)) : t.fg("text", c.label);
      const desc = c.description ? t.fg("dim", `  ${c.description}`) : "";
      lines.push(truncateToWidth(`  ${cursor}${lbl}${desc}`, width));
    }
    if (choices.length > maxVis) {
      lines.push(t.fg("dim", `  (${modal.selected + 1}/${choices.length})`));
    }
    lines.push("");
    lines.push(...this.renderDescriptionBox(this.renderSettingMeta(modal.entry), modal.entry.description, width));
    lines.push("");
    lines.push(truncateToWidth(t.fg("dim", "  Type to filter · ↑↓ select · Enter apply · Esc cancel"), width));
    return lines;
  }
}
