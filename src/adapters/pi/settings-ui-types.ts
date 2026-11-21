/** Shared types for the interactive pi TUI settings screen. */
import type { Input, TUI } from "@earendil-works/pi-tui";
import type { Config } from "../../core/config.ts";
import type {
  ModelOverridesSetting,
  ScalarSetting,
  SearchableSetting,
  SETTINGS_CATEGORIES,
  SettingEntry,
  SettingScreenSpec,
  SettingsDisplayContext,
  StringListSetting,
  StringMapSetting,
} from "../../core/settings-schema.ts";
import type {
  EndpointKind,
  EndpointModelInfo,
  EndpointModelsResult,
  EndpointTestResult,
} from "../../providers/test-endpoint.ts";

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

export type ScreenRow =
  | { kind: "section"; title: string; sectionIndex: number }
  | { kind: "entry"; entry: SettingEntry; sectionIndex: number };

export type HomeMatch =
  | { kind: "category"; category: (typeof SETTINGS_CATEGORIES)[number] }
  | { kind: "setting"; item: SearchableSetting };

export type ViewState =
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

export type ModelOverrideRow =
  | { kind: "model"; key: string; name?: string; contextWindow?: number; value: "auto" | number | undefined; custom: boolean }
  | { kind: "add-query"; key: string }
  | { kind: "add-custom" };

export type EndpointModelChoice = {
  kind: "model" | "manual" | "refresh" | "use-typed";
  value: string;
  label: string;
  description?: string;
  current?: boolean;
};

export type ActiveModal =
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

export type EndpointTestState =
  | { status: "running"; abort: AbortController }
  | { status: "done"; result: EndpointTestResult };

export interface SettingsRenderContext {
  readonly cfg: Config;
  readonly effectiveConfig?: Config;
  readonly projectOverrides: ReadonlySet<string>;
  readonly configPath: string;
  readonly knownModels: readonly ModelChoice[];
  readonly theme: SettingsTheme;
  readonly stack: readonly ViewState[];
  readonly modal: ActiveModal | null;
  readonly flash: { text: string; tone: "success" | "warning" | "error" | "muted" } | null;
  readonly endpointTests: Partial<Record<EndpointKind, EndpointTestState>>;
  readonly visibleSelectables: Array<{ rowY: number; index: number }>;
  maxListRows(): number;
  effectiveDisplayContext(): SettingsDisplayContext | undefined;
  homeMatches(view: Extract<ViewState, { kind: "home" }>): HomeMatch[];
  screenRows(view: Extract<ViewState, { kind: "screen" }>): { spec: SettingScreenSpec; rows: ScreenRow[]; entryIndices: number[] };
  searchResults(view: Extract<ViewState, { kind: "search" }>): SearchableSetting[];
  getList(entry: StringListSetting): string[];
  getMapEntries(entry: StringMapSetting): Array<[string, string]>;
  maskHeaderValue(key: string, value: string): string;
  getModelOverrideMap(entry: ModelOverridesSetting): Record<string, "auto" | number>;
  modelOverrideRows(view: Extract<ViewState, { kind: "model-overrides" }>): ModelOverrideRow[];
  endpointModelChoices(modal: Extract<ActiveModal, { kind: "endpoint-model" }>): EndpointModelChoice[];
  filteredModelChoices(entry: ScalarSetting, query: string): Array<{ value: string; label: string; description?: string }>;
}

export const CUSTOM_MODEL_SENTINEL = "__realctx2_custom_model__";
export const INHERIT_MODEL_SENTINEL = "__realctx2_inherit_model__";
export const REFRESH_MODELS_SENTINEL = "__realctx2_refresh_models__";
