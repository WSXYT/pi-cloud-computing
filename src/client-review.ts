import { isUtf8 } from "node:buffer";
import { formatSize, generateUnifiedPatch, truncateHead, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, SelectList, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { safeDisplayText } from "./client-events.js";
import { sha256 } from "./environment.js";
import type { GitSnapshotFile } from "./git.js";
import { translate, type MessageKey, type MessageParams } from "./i18n.js";
import type { Locale } from "./protocol.js";

export interface ReviewFile {
  path: string;
  status: GitSnapshotFile["status"];
  patch: string;
  added: number;
  removed: number;
  binary: boolean;
  beforeBytes: number;
  afterBytes: number;
}

export function createReviewFile(file: GitSnapshotFile, before: Buffer, after: Buffer): ReviewFile {
  const binary = before.includes(0) || after.includes(0) || !isUtf8(before) || !isUtf8(after);
  const diff = binary ? `binary: ${before.length} → ${after.length} bytes; sha256 ${sha256(after)}\n`
    : generateUnifiedPatch(file.path, before.toString("utf8"), after.toString("utf8"));
  const lines = diff.split("\n").slice(3);
  return {
    path: file.path, status: file.status, binary, beforeBytes: before.length, afterBytes: after.length,
    patch: `${file.status} ${file.path} (${file.mode ?? "100644"})\n${diff}`,
    added: binary ? 0 : lines.filter(line => line.startsWith("+")).length,
    removed: binary ? 0 : lines.filter(line => line.startsWith("-")).length,
  };
}

export interface ResultReview {
  title: string;
  taskId: string;
  project: string;
  files: ReviewFile[];
  reviewPath: string;
  mergeSession: boolean;
}

/** Display-only review. Consent never bypasses applyGitSnapshot's independent baseline checks. */
export async function reviewCloudResult(ctx: ExtensionCommandContext, review: ResultReview, locale: Locale): Promise<boolean> {
  const tr = (key: MessageKey, params: MessageParams = {}) => translate(locale, key, params);
  const plain = (text: string) => safeDisplayText(text).replace(/[\r\n\t]+/g, " ");
  const apply = tr(review.mergeSession ? "review.receive" : "review.apply");
  const scope = tr(review.mergeSession ? "cloud.receiveConfirm" : "review.scope");
  const added = review.files.reduce((sum, file) => sum + file.added, 0);
  const removed = review.files.reduce((sum, file) => sum + file.removed, 0);
  const summary = tr("review.summary", { files: review.files.length, added, removed });
  if (!ctx.hasUI) return false;
  if (ctx.mode !== "tui") {
    const preview = truncateHead(safeDisplayText(review.files.map(file => file.patch).join("\n")), { maxLines: 100, maxBytes: 10_000 });
    return ctx.ui.confirm(review.title, [summary, tr("review.checks"), scope, preview.content,
      tr("review.saved", { path: plain(review.reviewPath) })].join("\n\n"));
  }
  return ctx.ui.custom<boolean>((tui, theme, keys, done) => {
    let focus: "files" | "diff" | "actions" = review.files.length ? "files" : "actions";
    let selected = 0, offset = 0, pageSize = 5;
    let cache: { width: number; selected: number; lines: string[] } | undefined;
    const previews = review.files.map(file => {
      const preview = truncateHead(file.patch, { maxLines: 1000, maxBytes: 40_000 });
      return safeDisplayText(preview.content) + (preview.truncated ? `\n${tr("review.limited")}` : "");
    });
    const listTheme = {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.fg(focus === "files" || focus === "actions" ? "accent" : "text", text),
      description: (text: string) => theme.fg("muted", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      noMatch: (text: string) => theme.fg("muted", text),
    };
    const files = new SelectList(review.files.map((file, index) => ({ value: String(index),
      label: `${file.status === "added" ? "A" : file.status === "deleted" ? "D" : "M"}  ${plain(file.path)}`,
    })), 4, listTheme);
    files.onSelectionChange = item => { selected = Number(item.value); offset = 0; cache = undefined; };
    files.onSelect = () => { focus = "diff"; };
    files.onCancel = () => done(false);
    const actions = new SelectList([
      { value: "later", label: tr("review.later") },
      { value: "apply", label: apply },
    ], 2, listTheme);
    actions.onSelect = item => done(item.value === "apply");
    actions.onCancel = () => done(false);
    const matches = (data: string, action: Parameters<typeof keys.matches>[1], fallback: Parameters<typeof matchesKey>[1]) =>
      typeof keys.matches === "function" ? keys.matches(data, action) : matchesKey(data, fallback);
    const hint = (action: Parameters<typeof keys.getKeys>[0], fallback: string) =>
      typeof keys.getKeys === "function" ? keys.getKeys(action).join("/") || "—" : fallback;
    const tab = () => { focus = focus === "files" ? "diff" : focus === "diff" ? "actions" : review.files.length ? "files" : "actions"; };
    const diffLines = (width: number) => {
      if (cache?.width === width && cache.selected === selected) return cache.lines;
      const lines = review.files.length ? (previews[selected] ?? "").split("\n").flatMap(line => {
        const color = line.startsWith("+") ? "toolDiffAdded" : line.startsWith("-") ? "toolDiffRemoved" : line.startsWith("@@") ? "accent" : "text";
        return wrapTextWithAnsi(theme.fg(color, line || " "), Math.max(1, width));
      }) : [theme.fg("muted", tr("cloud.noChanges"))];
      cache = { width, selected, lines };
      return lines;
    };
    return {
      invalidate() { cache = undefined; files.invalidate(); actions.invalidate(); },
      handleInput(data: string) {
        if (matches(data, "tui.select.cancel", Key.escape) || matchesKey(data, Key.ctrl("c"))) { done(false); return; }
        if (matchesKey(data, Key.tab)) tab();
        else if (matchesKey(data, Key.shift("tab"))) {
          focus = focus === "actions" && review.files.length ? "diff" : focus === "diff" ? "files" : "actions";
        } else if (focus === "files") files.handleInput(data);
        else if (focus === "actions") actions.handleInput(data);
        else if (matches(data, "tui.select.confirm", Key.enter)) focus = "actions";
        else {
          const max = Math.max(0, (cache?.lines.length ?? 0) - pageSize);
          if (matches(data, "tui.select.up", Key.up)) offset--;
          else if (matches(data, "tui.select.down", Key.down)) offset++;
          else if (matches(data, "tui.select.pageUp", Key.pageUp)) offset -= pageSize;
          else if (matches(data, "tui.select.pageDown", Key.pageDown)) offset += pageSize;
          else if (matchesKey(data, Key.home)) offset = 0;
          else if (matchesKey(data, Key.end)) offset = max;
          offset = Math.max(0, Math.min(max, offset));
        }
        tui.requestRender();
      },
      render(width: number) {
        width = Math.max(1, width);
        const fit = (line: string) => truncateToWidth(line, width);
        const section = (text: string, active: boolean) => theme.fg(active ? "accent" : "muted", `${active ? "●" : "○"} ${text}`);
        const rows = Math.max(16, tui.terminal.rows - 4); // Leave room for Pi’s native editor/footer.
        const wide = width >= 90;
        const scopeLines = focus === "actions" ? wrapTextWithAnsi(theme.fg("warning", tr(review.mergeSession ? "review.receiveScope" : "review.scope")), width) : [];
        const leftWidth = wide ? Math.min(36, Math.floor(width * 0.34)) : width;
        const rightWidth = wide ? width - leftWidth - 3 : width;
        const fileLines = review.files.length ? [section(tr("review.files"), focus === "files"),
          ...(wide || focus === "files" ? files.render(leftWidth) : [theme.fg("text", plain(review.files[selected]!.path))])] : [];
        const bodyHeight = Math.max(1, Math.min(18, rows - 13 - scopeLines.length - (wide ? 0 : fileLines.length)));
        pageSize = bodyHeight;
        const diff = diffLines(rightWidth);
        offset = Math.max(0, Math.min(offset, diff.length - pageSize));
        const file = review.files[selected];
        const stats = file ? `${file.binary ? tr("review.binary") : `+${file.added} −${file.removed}`} · ${formatSize(file.beforeBytes)} → ${formatSize(file.afterBytes)}` : "";
        const heading = `${section(tr("review.diff"), focus === "diff")}  ${stats}  ${Math.min(diff.length, offset + 1)}–${Math.min(diff.length, offset + pageSize)}/${diff.length}`;
        const diffView = diff.slice(offset, offset + pageSize);
        const body: string[] = [];
        if (wide) {
          body.push(`${truncateToWidth(fileLines[0] ?? "", leftWidth, "", true)} ${theme.fg("dim", "│")} ${truncateToWidth(heading, rightWidth)}`);
          for (let row = 0; row < bodyHeight; row++) {
            body.push(`${truncateToWidth(fileLines[row + 1] ?? "", leftWidth, "", true)} ${theme.fg("dim", "│")} ${diffView[row] ?? ""}`);
          }
        } else body.push(...fileLines, fit(heading), ...diffView);
        const lines = [theme.fg("accent", "─".repeat(width)), theme.fg("accent", theme.bold(` ${plain(review.title)}`)),
          theme.fg("text", ` ${summary}`), theme.fg("dim", ` ${plain(review.project)} · ${plain(review.taskId)}`),
          theme.fg("success", ` ${tr("review.checks")}`), "", ...body,
          theme.fg("dim", "─".repeat(width)), section(tr("review.actions"), focus === "actions"), ...actions.render(width),
          theme.fg("muted", tr("review.saved", { path: plain(review.reviewPath) })),
          theme.fg("dim", tr("review.help", { up: hint("tui.select.up", "↑"), down: hint("tui.select.down", "↓"), enter: hint("tui.select.confirm", "Enter"), cancel: hint("tui.select.cancel", "Esc") })),
        ];
        // Keep scope visible even on narrow screens; it is not an implied consent or a validation result.
        lines.splice(lines.length - 2, 0, ...scopeLines);
        return lines.map(fit);
      },
    };
  });
}
