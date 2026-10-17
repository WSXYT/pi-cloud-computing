import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { createReviewFile, reviewCloudResult, type ResultReview } from "../src/client-review.js";

const review = (): ResultReview => ({
  title: "Review remote result", taskId: "task-fixture", project: "/work/中文/project", reviewPath: "/private/review.patch", mergeSession: true,
  files: [createReviewFile({ path: "src/中文.ts", status: "modified" }, Buffer.from("before\n"), Buffer.from(Array.from({ length: 80 }, (_, i) => `after ${i}`).join("\n"))),
    createReviewFile({ path: "new.txt", status: "added" }, Buffer.alloc(0), Buffer.from("new file\n"))],
});

function tuiContext(run: (component: Component, terminal: { rows: number }) => void): ExtensionCommandContext {
  return { mode: "tui", hasUI: true, ui: {
    custom<T>(factory: (tui: { terminal: { rows: number }; requestRender(): void }, theme: { fg(color: string, text: string): string; bold(text: string): string }, keys: unknown, done: (value: T) => void) => Component): Promise<T> {
      return new Promise(resolve => {
        const terminal = { rows: 30 };
        const component = factory({ terminal, requestRender() {} }, { fg: (_: string, text: string) => text, bold: (text: string) => text }, {}, resolve);
        run(component, terminal);
      });
    },
  } } as unknown as ExtensionCommandContext;
}

test("review counts added/deleted lines including content resembling diff headers, and describes binary changes", () => {
  const file = createReviewFile({ path: "a", status: "modified" }, Buffer.from("-- old\n"), Buffer.from("++ new\n"));
  assert.equal(file.added, 1); assert.equal(file.removed, 1);
  const binary = createReviewFile({ path: "a.bin", status: "modified" }, Buffer.from([0, 1]), Buffer.from([0, 2, 3]));
  assert.equal(binary.binary, true); assert.equal(binary.afterBytes, 3); assert.equal(binary.added, 0);
  assert.match(binary.patch, /sha256 [a-f0-9]{64}/);
  assert.equal(createReviewFile({ path: "legacy.txt", status: "modified" }, Buffer.from([0xff]), Buffer.from([0xfe])).binary, true);
});

for (const locale of ["en", "zh-CN"] as const) test(`review fits narrow/wide terminals, scrolls diff, resizes, and needs explicit apply (${locale})`, async () => {
  let result: boolean | undefined;
  const ctx = tuiContext((component, terminal) => {
    const render = (width: number, rows: number) => {
      terminal.rows = rows;
      const lines = component.render(width);
      assert.ok(lines.every(line => visibleWidth(line) <= width), lines.join("\n"));
      assert.ok(lines.length <= rows, `${width}x${rows}: ${lines.length}\n${lines.join("\n")}`);
      return lines.join("\n");
    };
    for (const [width, rows] of [[30, 20], [55, 24], [100, 30], [140, 40]]) render(width!, rows!);
    component.handleInput?.("\r"); // file selection only enters the diff, never applies it.
    const first = render(100, 30);
    component.handleInput?.("\x1b[6~");
    assert.notEqual(render(100, 30), first, "page-down must reveal later diff lines");
    component.handleInput?.("\x1b[F");
    assert.match(render(100, 30), /after 79/);
    component.handleInput?.("\x1b[H");
    assert.equal(render(100, 30), first);
    component.invalidate(); render(55, 24);
    component.handleInput?.("\t"); // actions, safely defaulted to keep.
    render(30, 20);
    component.handleInput?.("\x1b[B");
    render(100, 30);
    component.handleInput?.("\r");
  });
  result = await reviewCloudResult(ctx, review(), locale);
  assert.equal(result, true);
});

for (const key of ["\x1b", "\x03", "\t\t\r"]) test(`review keeps results without applying on ${JSON.stringify(key)}`, async () => {
  const ctx = tuiContext(component => {
    component.render(100);
    for (const data of key === "\t\t\r" ? ["\t", "\t", "\r"] : [key]) component.handleInput?.(data);
  });
  assert.equal(await reviewCloudResult(ctx, review(), "en"), false);
});

test("review switches files, sanitizes untrusted display text and marks bounded previews", async () => {
  const value = review();
  value.files[1] = createReviewFile({ path: "bad\x1b]52;c;CLIPBOARD\x07.txt", status: "added" }, Buffer.alloc(0), Buffer.from("x\n".repeat(2500)));
  const ctx = tuiContext(component => {
    component.handleInput?.("\x1b[B");
    const lines = component.render(100).join("\n");
    assert.doesNotMatch(lines, /\x1b\]52/);
    component.handleInput?.("\r"); component.render(100);
    component.handleInput?.("\x1b[F");
    assert.match(component.render(100).join("\n"), /preview truncated/);
    component.handleInput?.("\x1b");
  });
  assert.equal(await reviewCloudResult(ctx, value, "en"), false);
});

test("no-file review stays cancellable; RPC retains diff and scope before consent, headless never applies", async () => {
  const value = { ...review(), files: [] };
  assert.equal(await reviewCloudResult(tuiContext(component => { component.render(30); component.handleInput?.("\r"); }), value, "en"), false);
  let prompt = "";
  const ctx = { mode: "rpc", hasUI: true, ui: { async confirm(_title: string, message: string) { prompt = message; return false; } } } as unknown as ExtensionCommandContext;
  assert.equal(await reviewCloudResult(ctx, review(), "en"), false);
  assert.match(prompt, /src\/中文.ts/); assert.match(prompt, /before/); assert.match(prompt, /after/); assert.match(prompt, /remote conversation/);
  assert.equal(await reviewCloudResult({ hasUI: false } as ExtensionCommandContext, review(), "en"), false);
});
