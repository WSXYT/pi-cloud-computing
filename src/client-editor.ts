import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

export interface CloudEditorState {
  locked: boolean;
  busy?: boolean;
  append: boolean;
  status: string | undefined;
}

export class CloudEditor extends CustomEditor {
  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    private readonly getCloudState: () => CloudEditorState,
    private readonly accent: (text: string) => string,
    private readonly cancelAppend: () => void,
    private readonly submitLiteral: (text: string) => void,
    private readonly requestStop: () => void = () => {},
  ) {
    super(tui, theme, keybindings);
  }

  override handleInput(data: string): void {
    const state = this.getCloudState();
    if (state.append && matchesKey(data, Key.escape)) {
      this.cancelAppend();
      return;
    }
    if ((state.busy ?? state.locked) && (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")))) {
      this.requestStop();
      return;
    }
    if (state.append && matchesKey(data, Key.enter) && /^[\/!]/.test(this.getExpandedText().trimStart())) {
      const text = this.getExpandedText();
      this.setText("");
      this.submitLiteral(text);
      return;
    }
    if (state.locked && !state.append) {
      if (this.onExtensionShortcut?.(data)) return;
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.ctrl("d"))) super.handleInput(data);
      return;
    }
    super.handleInput(data);
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    const status = this.getCloudState().status;
    if (!status || width < 5 || lines.length < 2) return lines;
    const label = truncateToWidth(status, width - 4, "");
    const fill = Math.max(0, width - visibleWidth(label) - 4);
    lines[0] = this.borderColor("─") + this.accent(` ${label} `) + this.borderColor("─".repeat(fill + 1));
    return lines;
  }
}
