import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export interface SyncPreflightItem {
  id: string;
  label: string;
  description: string;
  selected: boolean;
  required?: boolean;
}

export interface SyncPreflightLabels {
  title: string;
  required: string;
  upload: string;
  cancel: string;
  help: string;
  empty: string;
}

export async function selectSyncItems(
  ctx: ExtensionCommandContext,
  items: SyncPreflightItem[],
  labels: SyncPreflightLabels,
): Promise<Set<string> | null> {
  if (ctx.mode !== "tui") {
    if (!ctx.hasUI) return null;
    const approved = await ctx.ui.confirm(labels.title, items.map((item) => `${item.label}: ${item.description}`).join("\n"));
    return approved ? new Set(items.filter((item) => item.selected).map((item) => item.id)) : null;
  }

  return ctx.ui.custom<Set<string> | null>((tui, theme, _keybindings, done) => {
    const selected = new Set(items.filter((item) => item.selected || item.required).map((item) => item.id));
    let cursor = 0;
    const uploadIndex = items.length;
    const cancelIndex = items.length + 1;

    const refresh = () => tui.requestRender();
    const toggle = (index: number) => {
      const item = items[index];
      if (!item || item.required) return;
      if (selected.has(item.id)) selected.delete(item.id);
      else selected.add(item.id);
    };

    return {
      invalidate: refresh,
      handleInput(data: string) {
        if (matchesKey(data, Key.up)) cursor = Math.max(0, cursor - 1);
        else if (matchesKey(data, Key.down)) cursor = Math.min(cancelIndex, cursor + 1);
        else if (matchesKey(data, Key.space) && cursor < items.length) toggle(cursor);
        else if (matchesKey(data, Key.enter)) {
          if (cursor < items.length) toggle(cursor);
          else if (cursor === uploadIndex) {
            if (selected.size === 0) return;
            done(new Set(selected));
          } else done(null);
        } else if (matchesKey(data, Key.escape)) done(null);
        refresh();
      },
      render(width: number) {
        const lines: string[] = [theme.fg("accent", "─".repeat(Math.max(1, width)))];
        lines.push(...wrapTextWithAnsi(` ${theme.bold(labels.title)}`, Math.max(1, width)));
        lines.push("");
        for (let index = 0; index < items.length; index += 1) {
          const item = items[index];
          if (!item) continue;
          const focused = cursor === index;
          const checked = selected.has(item.id);
          const marker = item.required ? "■" : checked ? "☑" : "☐";
          const suffix = item.required ? `  ${labels.required}` : "";
          const prefix = focused ? theme.fg("accent", "> ") : "  ";
          const color = checked ? "text" : "muted";
          lines.push(truncateToWidth(`${prefix}${theme.fg(color, `${marker} ${item.label}${suffix}`)}`, width));
          for (const line of wrapTextWithAnsi(item.description, Math.max(1, width - 6))) lines.push(truncateToWidth(`      ${theme.fg("dim", line)}`, width));
        }
        lines.push("");
        const uploadPrefix = cursor === uploadIndex ? theme.fg("accent", "> ") : "  ";
        const cancelPrefix = cursor === cancelIndex ? theme.fg("accent", "> ") : "  ";
        lines.push(truncateToWidth(`${uploadPrefix}${theme.fg(selected.size > 0 ? "success" : "dim", `[ ${labels.upload} ]`)}`, width));
        lines.push(truncateToWidth(`${cancelPrefix}${theme.fg("muted", `[ ${labels.cancel} ]`)}`, width));
        lines.push("");
        lines.push(truncateToWidth(` ${theme.fg("dim", selected.size > 0 ? labels.help : labels.empty)}`, width));
        lines.push(theme.fg("accent", "─".repeat(Math.max(1, width))));
        return lines;
      },
    };
  });
}
