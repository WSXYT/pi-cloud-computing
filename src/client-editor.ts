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
    private readonly cloudKeybindings: KeybindingsManager,
    private readonly getCloudState: () => CloudEditorState,
    private readonly accent: (text: string) => string,
    private readonly cancelAppend: () => void,
    private readonly submitLiteral: (text: string, delivery?: "steer" | "followUp") => void,
    private readonly requestStop: () => void = () => {},
    private readonly toggleCloudThinking: () => void = () => {},
    private readonly prepareFollowUp: () => void = () => {},
    private readonly dequeueCloud: () => void = () => {},
  ) {
    super(tui, theme, cloudKeybindings);
  }

  override handleInput(data: string): void {
    const state = this.getCloudState();
    if (this.cloudKeybindings.matches(data, "app.thinking.toggle")) {
      this.toggleCloudThinking();
      super.handleInput(data);
      return;
    }
    if (this.cloudKeybindings.matches(data, "app.tools.expand")) {
      super.handleInput(data);
      return;
    }
    if (state.append && !(state.busy ?? false) && matchesKey(data, Key.escape)) {
      this.cancelAppend();
      return;
    }
    if ((state.busy ?? state.locked) && (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")))) {
      if (matchesKey(data, Key.escape) && this.isShowingAutocomplete()) {
        super.handleInput(data);
        return;
      }
      this.requestStop();
      return;
    }
    if (state.append && this.cloudKeybindings.matches(data, "app.message.dequeue")) { this.dequeueCloud(); return; }
    const followUp = state.append && this.cloudKeybindings.matches(data, "app.message.followUp");
    if (state.append && (followUp || this.cloudKeybindings.matches(data, "tui.input.submit")) && !this.isShowingAutocomplete() && /^[\/!]/.test(this.getExpandedText().trimStart())) {
      const text = this.getExpandedText();
      this.setText("");
      this.submitLiteral(text, followUp ? "followUp" : "steer");
      return;
    }
    if (followUp && this.getExpandedText().trim()) this.prepareFollowUp();
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
