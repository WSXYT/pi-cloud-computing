import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import * as sdk from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { SdkToolPresentations, type ToolPresentation } from "../src/worker/sdk-tool-presentations.js";

test("cloud tool renderer uses Pi's shared renderer state and expansion without executing the tool locally", async () => {
  sdk.initTheme("dark");
  const views: ToolPresentation[] = [], errors: string[] = [];
  const definition = sdk.defineTool({
    name: "read", label: "Custom override", description: "fixture", parameters: Type.Object({ name: Type.String() }),
    async execute() { assert.fail("presentation must not execute a tool"); },
    renderCall(args, _theme, context) {
      context.state.fixture ??= new Set([args.name]);
      return new Text(`CUSTOM_CALL ${args.name}`, 0, 0);
    },
    renderResult(result, options, _theme, context) {
      assert.ok(context.state.fixture instanceof Set);
      assert.ok(context.state.fixture.has("example"));
      return new Text(`${options.expanded ? "EXPANDED" : "COLLAPSED"} ${context.isError ? "ERROR" : "OK"} ${result.content[0]?.type === "text" ? result.content[0].text : ""}`, 0, 0);
    },
  });
  const session = { getToolDefinition: () => definition, getAllTools: () => [{ name: definition.name, sourceInfo: { source: "local" } }] } as unknown as sdk.AgentSession;
  const host = new SdkToolPresentations(sdk, session, process.cwd(), view => views.push(view), truncateToWidth, code => errors.push(code));
  try {
    host.apply({ type: "tool_execution_start", toolCallId: "call", toolName: definition.name, args: { name: "example" } });
    host.apply({ type: "tool_execution_update", toolCallId: "call", toolName: definition.name, args: { name: "example" }, partialResult: { content: [{ type: "text", text: "partial" }], details: {} } });
    await delay(70);
    host.apply({ type: "tool_execution_end", toolCallId: "call", toolName: definition.name, result: { content: [{ type: "text", text: "final result" }], details: {} }, isError: true });
    await delay(70);
    for (const width of [30, 60, 100]) host.render("call", width, true);
    assert.deepEqual(errors, []);
    assert.ok(views.some(view => view.lines.join("\n").includes("COLLAPSED")));
    assert.ok(views.some(view => view.lines.join("\n").includes("EXPANDED ERROR final result")));
    assert.ok(views.every(view => view.lines.every(line => visibleWidth(line) <= view.width)));
    const count = views.length;
    host.render("call", 100, true);
    assert.equal(views.length, count, "identical snapshots must not grow the task journal");
    host.close(); host.render("call", 80, false);
    assert.equal(views.length, count);
  } finally { host.close(); }
});
