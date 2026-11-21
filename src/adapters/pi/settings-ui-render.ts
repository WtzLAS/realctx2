/** View and modal renderers for the interactive pi TUI settings screen. */
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { normalizeEnvVarName, readSecretFromFile } from "../../core/config.ts";
import {
  type EditableSetting,
  type EnumOption,
  formatModelOverrideValue,
  formatSettingValue,
  getConfigPath,
  getSettingDefault,
  getSettingValue,
  isScalarSetting,
  isSettingModified,
  SETTINGS_CATEGORIES,
} from "../../core/settings-schema.ts";
import type { ActiveModal, HomeMatch, ScreenRow, SettingsRenderContext, ViewState } from "./settings-ui-types.ts";

function breadcrumb(stack: readonly ViewState[]): string {
  const parts = ["realctx2 settings"];
  for (const v of stack) {
    if (v.kind === "screen") parts.push(v.title);
    else if (v.kind === "search") parts.push("Search");
    else if (v.kind === "multi-enum" || v.kind === "string-list" || v.kind === "string-map" || v.kind === "model-overrides") parts.push(v.entry.label);
  }
  return parts.join(" › ");
}

function shortPath(p: string): string {
  const home = process.env.HOME;
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function spreadRow(left: string, right: string, width: number): string {
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

function renderDivider(ctx: SettingsRenderContext, width: number): string {
  return ctx.theme.fg("borderMuted", ` ${"┄".repeat(Math.max(1, width - 2))} `);
}

function renderSectionHeader(ctx: SettingsRenderContext, title: string, width: number): string {
  const label = `  ── ${title} `;
  const fill = Math.max(0, width - visibleWidth(label) - 1);
  return truncateToWidth(ctx.theme.bold(ctx.theme.fg("muted", label)) + ctx.theme.fg("borderMuted", "─".repeat(fill)), width);
}

function renderDescriptionBox(ctx: SettingsRenderContext, meta: string | undefined, description: string, width: number): string[] {
  const t = ctx.theme;
  const out: string[] = [renderDivider(ctx, width)];
  if (meta) out.push(truncateToWidth(`  ${meta}`, width));
  for (const line of wrapTextWithAnsi(description, Math.max(16, width - 4))) {
    out.push(t.fg("muted", `  ${line}`));
  }
  return out;
}

function siblingEnvVarFor(ctx: SettingsRenderContext, path: string): string | undefined {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return undefined;
  const sibling = getConfigPath(ctx.cfg, `${path.slice(0, dot)}.apiKeyEnv`);
  return typeof sibling === "string" ? normalizeEnvVarName(sibling) : undefined;
}

function formatEntryDisplayValue(ctx: SettingsRenderContext, entry: EditableSetting): string {
  const val = getSettingValue(ctx.cfg, entry);
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
    const res = readSecretFromFile(val.trim(), siblingEnvVarFor(ctx, entry.path));
    return `${base} (${res.key ? "ok" : "unreadable"})`;
  }
  return base;
}

function renderSettingMeta(ctx: SettingsRenderContext, entry: EditableSetting): string {
  const t = ctx.theme;
  const parts: string[] = [t.fg("accent", entry.path)];
  const def = getSettingDefault(entry);
  parts.push(t.fg("dim", `default: ${formatSettingValue(entry, def)}`));
  if (isSettingModified(ctx.cfg, entry)) {
    parts.push(t.fg("warning", "modified"));
  }
  if (isScalarSetting(entry) && entry.envVar) {
    const val = getSettingValue(ctx.cfg, entry);
    const envName = typeof val === "string" ? normalizeEnvVarName(val) : undefined;
    if (envName) {
      const present = Boolean(process.env[envName]?.trim());
      parts.push(present ? t.fg("success", `$${envName} set`) : t.fg("warning", `$${envName} not set in env`));
    }
  }
  if (isScalarSetting(entry) && entry.secretFile) {
    const val = getSettingValue(ctx.cfg, entry);
    if (typeof val === "string" && val.trim()) {
      const res = readSecretFromFile(val.trim(), siblingEnvVarFor(ctx, entry.path));
      parts.push(res.key ? t.fg("success", "secret file readable") : t.fg("warning", `secret file: ${res.error}`));
    }
  }
  if (ctx.projectOverrides.has(entry.path) && ctx.effectiveConfig) {
    const eff = getConfigPath(ctx.effectiveConfig, entry.path);
    parts.push(t.fg("warning", `[project override: ${formatSettingValue(entry, eff)}]`));
  }
  parts.push(t.fg("dim", entry.restart ? "next session" : "applies live"));
  return parts.join(t.fg("dim", " · "));
}

function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : Number(m.toFixed(2))}M`;
  }
  return `${Math.round(tokens / 1000)}k`;
}

export function renderSettingsView(ctx: SettingsRenderContext, width: number): readonly string[] {
  const w = Math.max(30, width);
  const t = ctx.theme;
  const border = t.fg("border", "─".repeat(w));
  const lines: string[] = [border];

  const crumbs = breadcrumb(ctx.stack);
  const rightText = ctx.flash ? t.fg(ctx.flash.tone, ctx.flash.text) : t.fg("dim", shortPath(ctx.configPath));
  lines.push(spreadRow(` ${t.bold(t.fg("accent", crumbs))}`, `${rightText} `, w));

  ctx.visibleSelectables.length = 0;

  if (ctx.modal) {
    lines.push(...renderModal(ctx, ctx.modal, w));
  } else {
    const view = ctx.stack[ctx.stack.length - 1]!;
    if (view.kind === "home") lines.push(...renderHome(ctx, view, w, lines.length));
    else if (view.kind === "screen") lines.push(...renderScreen(ctx, view, w, lines.length));
    else if (view.kind === "search") lines.push(...renderSearch(ctx, view, w, lines.length));
    else if (view.kind === "multi-enum") lines.push(...renderMultiEnum(ctx, view, w, lines.length));
    else if (view.kind === "string-list") lines.push(...renderStringList(ctx, view, w, lines.length));
    else if (view.kind === "string-map") lines.push(...renderStringMap(ctx, view, w, lines.length));
    else if (view.kind === "model-overrides") lines.push(...renderModelOverrides(ctx, view, w, lines.length));
  }

  lines.push(border);
  return lines;
}

function renderHome(ctx: SettingsRenderContext, view: Extract<ViewState, { kind: "home" }>, width: number, baseY: number): string[] {
  const t = ctx.theme;
  const query = view.input.getValue().trim();
  const lines: string[] = [""];
  for (const l of view.input.render(Math.max(20, width - 4))) {
    lines.push(`  ${l}`);
  }
  lines.push("");

  const matches = ctx.homeMatches(view);
  if (!matches.length) {
    lines.push(t.fg("dim", `  No categories or settings matching "${query}".`));
    lines.push("");
    lines.push(truncateToWidth(t.fg("dim", "  Type to search · Esc clear search"), width));
    return lines;
  }

  if (!query) {
    lines.push(renderSectionHeader(ctx, "Categories", width));
    const labelCol = Math.min(28, Math.max(...SETTINGS_CATEGORIES.map((c) => visibleWidth(c.title))) + 2);
    SETTINGS_CATEGORIES.forEach((cat, idx) => {
      const sel = idx === view.selected;
      const cursor = sel ? t.fg("accent", "▸ ") : "  ";
      const label = cat.title + " ".repeat(Math.max(0, labelCol - visibleWidth(cat.title)));
      const styledLabel = sel ? t.bold(t.fg("accent", label)) : t.fg("text", label);
      const summary = cat.summary(ctx.cfg, ctx.effectiveDisplayContext());
      const valMax = Math.max(8, width - 4 - labelCol - 2);
      const styledVal = sel ? t.fg("accent", truncateToWidth(`${summary} ›`, valMax)) : t.fg("muted", truncateToWidth(`${summary} ›`, valMax));
      ctx.visibleSelectables.push({ rowY: baseY + lines.length, index: idx });
      lines.push(truncateToWidth(`  ${cursor}${styledLabel}${styledVal}`, width));
    });

    const cur = SETTINGS_CATEGORIES[view.selected];
    if (cur) {
      lines.push("");
      lines.push(...renderDescriptionBox(ctx, t.bold(t.fg("text", cur.title)), cur.description, width));
    }
    lines.push("");
    lines.push(truncateToWidth(t.fg("dim", "  ↑↓ navigate · Enter open category · Type to search all settings · Esc close"), width));
    return lines;
  }

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

  const maxVis = Math.max(6, ctx.maxListRows() - 2);
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
      lines.push(renderSectionHeader(ctx, vr.title, width));
      continue;
    }
    const sel = vr.matchIndex === view.selected;
    const cursor = sel ? t.fg("accent", "▸ ") : "  ";
    ctx.visibleSelectables.push({ rowY: baseY + lines.length, index: vr.matchIndex });
    if (vr.match.kind === "category") {
      const cat = vr.match.category;
      const pad = " ".repeat(Math.max(0, maxLabel - visibleWidth(cat.title)));
      const lbl = sel ? t.bold(t.fg("accent", cat.title + pad)) : t.fg("text", cat.title + pad);
      const right = `${cat.summary(ctx.cfg, ctx.effectiveDisplayContext())} ›`;
      const rightMax = Math.max(10, width - 6 - maxLabel);
      lines.push(truncateToWidth(`  ${cursor}${lbl}  ${sel ? t.fg("accent", truncateToWidth(right, rightMax)) : t.fg("muted", truncateToWidth(right, rightMax))}`, width));
    } else {
      const item = vr.match.item;
      const pad = " ".repeat(Math.max(0, maxLabel - visibleWidth(item.entry.label)));
      const lbl = sel ? t.bold(t.fg("accent", item.entry.label + pad)) : t.fg("text", item.entry.label + pad);
      const val = formatSettingValue(item.entry, getSettingValue(ctx.cfg, item.entry));
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
      lines.push(...renderDescriptionBox(ctx, t.bold(t.fg("text", cur.category.title)), cur.category.description, width));
    } else {
      lines.push(...renderDescriptionBox(ctx, renderSettingMeta(ctx, cur.item.entry), cur.item.entry.description, width));
    }
  }
  lines.push("");
  lines.push(truncateToWidth(t.fg("dim", "  Type to filter · ↑↓ navigate · Enter open/edit · Ctrl+R reset · Esc clear search"), width));
  return lines;
}

function renderScreen(ctx: SettingsRenderContext, view: Extract<ViewState, { kind: "screen" }>, width: number, baseY: number): string[] {
  const t = ctx.theme;
  const { spec, rows, entryIndices } = ctx.screenRows(view);
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
  const maxVis = ctx.maxListRows();

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
  if (start > 0 && visualRows[start - 1]?.row.kind === "section") start -= 1;
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
      lines.push(renderSectionHeader(ctx, vr.row.title, width));
      continue;
    }
    const entry = vr.row.entry;
    const sel = vr.entryIdx === view.selected;
    const cursor = sel ? t.fg("accent", "▸ ") : "  ";
    const modDot = entry.kind !== "subscreen" && entry.kind !== "action" && isSettingModified(ctx.cfg, entry) ? t.fg("warning", "•") : " ";
    const pad = " ".repeat(Math.max(0, maxLabel - visibleWidth(entry.label)));
    const labelStr = sel ? t.bold(t.fg("accent", entry.label + pad)) : t.fg("text", entry.label + pad);

    const valMax = Math.max(8, width - 6 - maxLabel - 3);
    let valStyled: string;
    if (entry.kind === "action") {
      const st = ctx.endpointTests[entry.endpoint];
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
      const valTrunc = truncateToWidth(`${entry.summary(ctx.cfg, ctx.effectiveDisplayContext())} ›`, valMax);
      valStyled = sel ? t.fg("accent", valTrunc) : t.fg("muted", valTrunc);
    } else {
      const valTrunc = truncateToWidth(formatEntryDisplayValue(ctx, entry), valMax);
      valStyled = sel ? t.fg("accent", valTrunc) : isSettingModified(ctx.cfg, entry) ? t.fg("warning", valTrunc) : t.fg("muted", valTrunc);
    }

    ctx.visibleSelectables.push({ rowY: baseY + lines.length, index: vr.entryIdx! });
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
    const st = ctx.endpointTests[selectedEntry.endpoint];
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
    meta = renderSettingMeta(ctx, selectedEntry);
  }
  lines.push(...renderDescriptionBox(ctx, meta, descText, width));

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

function renderSearch(ctx: SettingsRenderContext, view: Extract<ViewState, { kind: "search" }>, width: number, baseY: number): string[] {
  const t = ctx.theme;
  const lines: string[] = [""];
  for (const l of view.input.render(Math.max(20, width - 4))) {
    lines.push(`  ${l}`);
  }
  lines.push("");

  const results = ctx.searchResults(view);
  if (!results.length) {
    lines.push(t.fg("dim", "  No matching settings."));
    lines.push("");
    lines.push(t.fg("dim", "  Type to filter · Esc back"));
    return lines;
  }

  const maxVis = Math.max(6, ctx.maxListRows() - 2);
  const start = Math.max(0, Math.min(view.selected - Math.floor(maxVis / 2), results.length - maxVis));
  const end = Math.min(results.length, start + maxVis);
  const maxLabel = Math.min(34, Math.max(16, ...results.slice(start, end).map((r) => visibleWidth(r.entry.label))));

  for (let i = start; i < end; i++) {
    const item = results[i]!;
    const sel = i === view.selected;
    const cursor = sel ? t.fg("accent", "▸ ") : "  ";
    const pad = " ".repeat(Math.max(0, maxLabel - visibleWidth(item.entry.label)));
    const lbl = sel ? t.bold(t.fg("accent", item.entry.label + pad)) : t.fg("text", item.entry.label + pad);
    const val = formatSettingValue(item.entry, getSettingValue(ctx.cfg, item.entry));
    const scope = `${item.categoryTitle} › ${item.sectionTitle}`;
    const right = `${val}  ${t.fg("dim", scope)}`;
    const rightMax = Math.max(10, width - 6 - maxLabel);
    ctx.visibleSelectables.push({ rowY: baseY + lines.length, index: i });
    lines.push(truncateToWidth(`  ${cursor}${lbl}  ${sel ? t.fg("accent", truncateToWidth(right, rightMax)) : t.fg("muted", truncateToWidth(right, rightMax))}`, width));
  }

  if (results.length > maxVis) {
    lines.push(t.fg("dim", `  (${view.selected + 1}/${results.length} matches)`));
  }

  const cur = results[view.selected];
  if (cur) {
    lines.push("");
    lines.push(...renderDescriptionBox(ctx, renderSettingMeta(ctx, cur.entry), cur.entry.description, width));
  }
  lines.push("");
  lines.push(truncateToWidth(t.fg("dim", "  Type to filter · ↑↓ navigate · Enter edit · Ctrl+R reset · Esc back"), width));
  return lines;
}

function renderMultiEnum(ctx: SettingsRenderContext, view: Extract<ViewState, { kind: "multi-enum" }>, width: number, baseY: number): string[] {
  const t = ctx.theme;
  const opts = view.entry.options ?? [];
  const active = new Set(ctx.getList(view.entry));
  const lines: string[] = [truncateToWidth(t.fg("muted", `  Toggle values for ${view.entry.path}`), width), ""];

  opts.forEach((opt: EnumOption, i: number) => {
    const sel = i === view.selected;
    const checked = active.has(opt.value);
    const cursor = sel ? t.fg("accent", "▸ ") : "  ";
    const box = checked ? t.fg("success", "[x]") : t.fg("dim", "[ ]");
    const label = sel ? t.bold(t.fg("accent", opt.label ?? opt.value)) : t.fg("text", opt.label ?? opt.value);
    ctx.visibleSelectables.push({ rowY: baseY + lines.length, index: i });
    lines.push(truncateToWidth(`  ${cursor}${box} ${label}`, width));
  });

  const cur = opts[view.selected];
  lines.push("");
  lines.push(...renderDescriptionBox(ctx, renderSettingMeta(ctx, view.entry), cur?.description ?? view.entry.description, width));
  lines.push("");
  lines.push(truncateToWidth(t.fg("dim", "  ↑↓ navigate · Space/Enter toggle · r reset to default · Esc back"), width));
  return lines;
}

function renderStringList(ctx: SettingsRenderContext, view: Extract<ViewState, { kind: "string-list" }>, width: number, baseY: number): string[] {
  const t = ctx.theme;
  const list = ctx.getList(view.entry);
  const total = list.length + 1;
  const maxVis = ctx.maxListRows();
  const start = Math.max(0, Math.min(view.selected - Math.floor(maxVis / 2), total - maxVis));
  const end = Math.min(total, start + maxVis);

  const lines: string[] = [truncateToWidth(t.fg("muted", `  ${list.length} item${list.length === 1 ? "" : "s"} in ${view.entry.path}`), width), ""];

  for (let i = start; i < end; i++) {
    const sel = i === view.selected;
    const cursor = sel ? t.fg("accent", "▸ ") : "  ";
    ctx.visibleSelectables.push({ rowY: baseY + lines.length, index: i });
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
  lines.push(...renderDescriptionBox(ctx, renderSettingMeta(ctx, view.entry), view.entry.description, width));
  lines.push("");
  lines.push(truncateToWidth(t.fg("dim", "  ↑↓ navigate · Enter edit/add · a add · d delete · r reset to default · Esc back"), width));
  return lines;
}

function renderStringMap(ctx: SettingsRenderContext, view: Extract<ViewState, { kind: "string-map" }>, width: number, baseY: number): string[] {
  const t = ctx.theme;
  const pairs = ctx.getMapEntries(view.entry);
  const total = pairs.length + 1;
  const maxVis = ctx.maxListRows();
  const start = Math.max(0, Math.min(view.selected - Math.floor(maxVis / 2), total - maxVis));
  const end = Math.min(total, start + maxVis);

  const lines: string[] = [truncateToWidth(t.fg("muted", `  ${pairs.length} header${pairs.length === 1 ? "" : "s"} in ${view.entry.path}`), width), ""];

  for (let i = start; i < end; i++) {
    const sel = i === view.selected;
    const cursor = sel ? t.fg("accent", "▸ ") : "  ";
    ctx.visibleSelectables.push({ rowY: baseY + lines.length, index: i });
    if (i < pairs.length) {
      const [k, v] = pairs[i]!;
      const text = `${k}: ${ctx.maskHeaderValue(k, v)}`;
      lines.push(truncateToWidth(`  ${cursor}${sel ? t.bold(t.fg("accent", text)) : t.fg("text", text)}`, width));
    } else {
      const add = "+ Add header…";
      lines.push(truncateToWidth(`  ${cursor}${sel ? t.bold(t.fg("accent", add)) : t.fg("success", add)}`, width));
    }
  }

  if (total > maxVis) lines.push(t.fg("dim", `  (${view.selected + 1}/${total})`));
  lines.push("");
  lines.push(...renderDescriptionBox(ctx, renderSettingMeta(ctx, view.entry), view.entry.description, width));
  lines.push("");
  lines.push(truncateToWidth(t.fg("dim", "  ↑↓ navigate · Enter edit/add · a add · d delete · r clear all · Esc back"), width));
  return lines;
}

function renderModelOverrides(ctx: SettingsRenderContext, view: Extract<ViewState, { kind: "model-overrides" }>, width: number, baseY: number): string[] {
  const t = ctx.theme;
  const map = ctx.getModelOverrideMap(view.entry);
  const activeCount = Object.values(map).filter((v) => v !== "auto" && v !== undefined).length;
  const rows = ctx.modelOverrideRows(view);

  const lines: string[] = [
    truncateToWidth(
      t.fg(
        "muted",
        `  Default: ${view.entry.defaultSummary(ctx.cfg)} · ${activeCount} override${activeCount === 1 ? "" : "s"} · ${ctx.knownModels.length} known model${ctx.knownModels.length === 1 ? "" : "s"}`,
      ),
      width,
    ),
    "",
  ];

  for (const l of view.input.render(Math.max(20, width - 4))) {
    lines.push(`  ${l}`);
  }
  lines.push("");

  const maxVis = Math.max(5, ctx.maxListRows() - 3);
  const start = Math.max(0, Math.min(view.selected - Math.floor(maxVis / 2), Math.max(0, rows.length - maxVis)));
  const end = Math.min(rows.length, start + maxVis);

  for (let i = start; i < end; i++) {
    const row = rows[i]!;
    const sel = i === view.selected;
    const cursor = sel ? t.fg("accent", "▸ ") : "  ";
    ctx.visibleSelectables.push({ rowY: baseY + lines.length, index: i });

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
          ? t.fg("dim", ` (${formatCompactTokens(row.contextWindow)})`)
          : row.custom
            ? t.fg("dim", " (custom)")
            : "";
      const leftStyled = `  ${cursor}${modDot} ${sel ? t.bold(t.fg("accent", row.key)) : t.fg("text", row.key)}${ctxHint}`;
      lines.push(spreadRow(leftStyled, `${valStyled}  `, width));
    } else if (row.kind === "add-query") {
      const label = `+ Add "${row.key}"…`;
      const right = t.fg("dim", "auto  ");
      lines.push(spreadRow(`  ${cursor}  ${sel ? t.bold(t.fg("accent", label)) : t.fg("success", label)}`, right, width));
    } else {
      const label = "+ Add custom model…";
      lines.push(truncateToWidth(`  ${cursor}  ${sel ? t.bold(t.fg("accent", label)) : t.fg("success", label)}`, width));
    }
  }

  if (rows.length > maxVis) {
    lines.push(t.fg("dim", `  (${view.selected + 1}/${rows.length})`));
  }

  lines.push("");
  lines.push(...renderDescriptionBox(ctx, renderSettingMeta(ctx, view.entry), view.entry.description, width));
  lines.push("");
  lines.push(truncateToWidth(t.fg("dim", "  ↑↓ navigate · Enter edit/add · Ctrl+R reset to auto · Type to filter or add model · Esc back"), width));
  return lines;
}

function renderModal(ctx: SettingsRenderContext, modal: ActiveModal, width: number): string[] {
  const t = ctx.theme;
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
    lines.push(...renderDescriptionBox(ctx, undefined, modal.description, width));
    lines.push("");
    lines.push(truncateToWidth(t.fg("dim", `  ${modal.hint}`), width));
    return lines;
  }

  if (modal.kind === "enum") {
    const lines: string[] = ["", truncateToWidth(`  ${t.bold(t.fg("text", modal.entry.label))}  ${t.fg("dim", modal.entry.path)}`, width), ""];
    const curVal = getSettingValue(ctx.cfg, modal.entry);
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
      ...renderDescriptionBox(
        ctx,
        renderSettingMeta(ctx, modal.entry),
        chosen?.description ? `${chosen.description}\n${modal.entry.description}` : modal.entry.description,
        width,
      ),
    );
    lines.push("");
    lines.push(truncateToWidth(t.fg("dim", "  ↑↓ select · Enter apply · Esc cancel"), width));
    return lines;
  }

  if (modal.kind === "endpoint-model") {
    const lines: string[] = ["", truncateToWidth(`  ${t.bold(t.fg("text", modal.entry.label))}  ${t.fg("dim", modal.entry.path)}`, width)];
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

    const choices = ctx.endpointModelChoices(modal);
    const maxVis = Math.max(6, ctx.maxListRows() - 4);
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
    lines.push(...renderDescriptionBox(ctx, renderSettingMeta(ctx, modal.entry), modal.entry.description, width));
    lines.push("");
    const hintParts = ["Type to filter or enter custom ID", "↑↓ select", "Enter apply"];
    if (modal.status !== "no-url") hintParts.push("Ctrl+R refresh");
    hintParts.push("Esc cancel");
    lines.push(truncateToWidth(t.fg("dim", `  ${hintParts.join(" · ")}`), width));
    return lines;
  }

  const lines: string[] = ["", truncateToWidth(`  ${t.bold(t.fg("text", modal.entry.label))}  ${t.fg("dim", modal.entry.path)}`, width), ""];
  for (const l of modal.input.render(Math.max(20, width - 4))) {
    lines.push(`  ${l}`);
  }
  lines.push("");
  const choices = ctx.filteredModelChoices(modal.entry, modal.input.getValue());
  const maxVis = Math.max(6, ctx.maxListRows() - 3);
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
  lines.push(...renderDescriptionBox(ctx, renderSettingMeta(ctx, modal.entry), modal.entry.description, width));
  lines.push("");
  lines.push(truncateToWidth(t.fg("dim", "  Type to filter · ↑↓ select · Enter apply · Esc cancel"), width));
  return lines;
}
