import {
  DynamicBorder,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type SelectItem,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";

export interface CloudMenuItem extends SelectItem {
  value: string;
}

export async function selectCloudMenu(
  ctx: ExtensionCommandContext,
  title: string,
  status: string[],
  items: CloudMenuItem[],
  help: string,
): Promise<string | null> {
  if (ctx.mode !== "tui") {
    if (!ctx.hasUI) return null;
    const selected = await ctx.ui.select(
      title,
      items.map((item) => item.label),
    );
    return items.find((item) => item.label === selected)?.value ?? null;
  }
  return ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(
      new DynamicBorder((text: string) => theme.fg("accent", text)),
    );
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    for (const line of status)
      container.addChild(new Text(theme.fg("muted", line), 1, 0));
    container.addChild(new Text("", 0, 0));
    const list = new SelectList(items, Math.min(items.length, 10), {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    });
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(null);
    container.addChild(list);
    container.addChild(new Text(theme.fg("dim", help), 1, 0));
    container.addChild(
      new DynamicBorder((text: string) => theme.fg("accent", text)),
    );
    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });
}
