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
import { fuzzyFilter, fuzzyMatch, getKeybindings, Input, Key, matchesKey } from "@earendil-works/pi-tui";
import { type Config, isSensitiveHeaderName } from "../../core/config.ts";
import {
  type ActionEntry,
  type EditableSetting,
  findCategory,
  flattenAllSettings,
  formatModelOverrideValue,
  formatSettingValue,
  getSettingDefault,
  getSettingValue,
  isScalarSetting,
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
  type EndpointModelsResult,
  type EndpointTestResult,
  fetchEndpointModels,
  modelsUrlFor,
  testEndpoint,
} from "../../providers/test-endpoint.ts";
import { errMsg } from "../../util/errors.ts";
import { renderSettingsView } from "./settings-ui-render.ts";
import {
  type ActiveModal,
  CUSTOM_MODEL_SENTINEL,
  type EndpointModelChoice,
  type EndpointTestState,
  type HomeMatch,
  INHERIT_MODEL_SENTINEL,
  type ModelChoice,
  type ModelOverrideRow,
  type Realctx2SettingsOptions,
  REFRESH_MODELS_SENTINEL,
  type ScreenRow,
  type SettingsRenderContext,
  type SettingsTheme,
  type ViewState,
} from "./settings-ui-types.ts";

export type { ModelChoice, Realctx2SettingsOptions, SettingsTheme };

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
  private endpointTests: Partial<Record<EndpointKind, EndpointTestState>> = {};
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
    this.prefillInput(input, isSecret ? "" : rawInputValue(cur));

    const bounds: string[] = [];
    if (entry.min !== undefined) bounds.push(`min ${entry.min}`);
    if (entry.max !== undefined) bounds.push(`max ${entry.max}`);
    if (entry.zeroLabel && (entry.kind === "integer" || entry.kind === "number")) bounds.push(entry.zeroLabel);
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
    const ctx: SettingsRenderContext = {
      cfg: this.cfg,
      effectiveConfig: this.effectiveConfig,
      projectOverrides: this.projectOverrides,
      configPath: this.configPath,
      knownModels: this.knownModels,
      theme: this.theme,
      stack: this.stack,
      modal: this.modal,
      flash: this.flash,
      endpointTests: this.endpointTests,
      visibleSelectables: this.lastVisibleSelectableIndices,
      maxListRows: () => this.maxListRows(),
      effectiveDisplayContext: () => this.effectiveDisplayContext(),
      homeMatches: (v) => this.homeMatches(v),
      screenRows: (v) => this.screenRows(v),
      searchResults: (v) => this.searchResults(v),
      getList: (e) => this.getList(e),
      getMapEntries: (e) => this.getMapEntries(e),
      maskHeaderValue: (k, v) => this.maskHeaderValue(k, v),
      getModelOverrideMap: (e) => this.getModelOverrideMap(e),
      modelOverrideRows: (v) => this.modelOverrideRows(v),
      endpointModelChoices: (m): EndpointModelChoice[] => this.endpointModelChoices(m),
      filteredModelChoices: (e, q) => this.filteredModelChoices(e, q),
    };
    return renderSettingsView(ctx, width);
  }
}
