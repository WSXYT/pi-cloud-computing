# Native cloud interaction: investigation and acceptance map

Status: independent completion audit rejected e67012f despite green CI. Corrections now cover display-only context filtering, standard environment credentials, and a real SDK/PTY Escape-to-local-reply loop in both modes (local 143/143). Final exact-commit CI and re-audit remain required. No deployment or publication is authorized.
Goal: `muqftjld-loipjn`. This document records implementation evidence, not a change to the confirmed goal.

## New interaction contract

The new request supersedes the previous locked-editor design. While a remote task runs, ordinary Enter submits to that task, the editor remains editable, and Escape follows focus-aware cancellation/stop semantics. Idle Enter remains local. Remote output must use Pi's native message and tool components, not a log-style Markdown widget.

Credentials that are available and necessary for the chosen provider should be selected by default. Selection is not consent: the final per-task authorization remains mandatory before uploading or using an encrypted bundle.

The user additionally requests a generic plugin integration rather than a named-plugin allowlist. Compatibility must be described by capabilities, with unsupported operations visible rather than silently skipped.

## Baseline findings before implementation

| Concern | Evidence | Required observable result |
|---|---|---|
| Output is a log, not Pi's UI | `src/client.ts` `showTask` builds a Markdown widget from the last 20 preview lines; `src/client-events.ts` flattens structured events | Native assistant/thinking/tool components, streaming updates, error states and expansion |
| Editor locks and requires an append mode | `src/client-editor.ts` swallows ordinary input while locked; `src/client.ts` gates sending on `followUp` | Editable draft; ordinary Enter steers the remote run, native follow-up shortcut queues; idle Enter stays local |
| Escape is not focus-aware | Cloud editor checks literal Escape/Ctrl+C before native handling | Autocomplete/dialog gets cancellation first; task stop remains accessible; Ctrl+C retains native clear/copy semantics |
| Internal counters leak into UI | `cloud.task.running` and `cloud.activeStatus` interpolate task IDs/cursors | Meaningful activity/status in normal UI; counters only in explicit diagnostics |
| Credentials default unchecked | `src/client.ts` pushes the credentials choice with `selected: false` | Available credentials selected, explicit final authorization, actionable missing-auth and opt-out paths |
| Standard plugin dialogs | `src/worker/rpc.ts` recognizes select/confirm/input/editor; `requestUi` serializes dialogs and returns matching IDs | All four dialog types, cancellation, simultaneous requests, timeout, reconnect and response delivery tested |
| Dialog lifetime mismatch | `TaskUiRequest` omits RPC timeout; `ctx.ui.editor` in Pi 0.85.1 has no AbortSignal parameter | No obsolete modal after timeout, task stop or reconnect; no automatic affirmative response |
| Plugin presentation dropped | RPC status/widget/editor-text notifications are not a complete forwarded UI surface | Namespaced lifecycle, preserved local drafts, safe focus ownership and cleanup |
| Custom TUI silently unavailable | Pi RPC `custom()` returns undefined, raw terminal listener is a no-op, component widget factories are ignored | Capability-aware host or explicit unsupported error; never a silent empty return counted as success |
| Plugin custom tool renderers | Local ExtensionAPI exposes tool metadata, not arbitrary remote renderer closures | Execute renderer code in the task process, not deserialize/execute remote JavaScript in the client |

## Verified public Pi capabilities

Inspected repository dependency: `@earendil-works/pi-coding-agent` 0.85.1. Host documentation can be newer; installed dependency declarations/source decide compatibility.

- Public exports include `AssistantMessageComponent`, `ToolExecutionComponent`, `UserMessageComponent`, `CustomEditor`, built-in tool definitions and theme helpers.
- Assistant components accept structured messages and streaming updates; thinking visibility and mouse interaction are implemented by Pi.
- Tool components implement pending/success/error shells, partial output, images, expansion and renderer callbacks. They do not execute the tool themselves.
- Custom message renderers can return actual Pi components; native global expansion passes `expanded` to their renderer. Thinking shortcuts, copy-last-message and transcript reconstruction still need explicit verification; rendering a component alone is not proof those application actions work.
- `AgentSession.bindExtensions({uiContext, mode})` is public. SDK hosts can supply real UI capabilities instead of the CLI RPC mode's no-op custom methods.
- `AgentSession.getToolDefinition(name)` exposes renderer callbacks on the host that loaded the plugin.
- The stock `runRpcMode` installs its own UI context. There is no public option to replace just its custom UI transport.
- SDK sessions are not automatically identical to CLI sessions: resource discovery/trust, tools, model configuration, commands, lifecycle, and built-in integrations must be preserved and tested when replacing the runtime host.

Read references: Pi `docs/extensions.md`, `docs/tui.md`, `docs/rpc-extension-ui.md`, `docs/keybindings.md`, `docs/themes.md`, `docs/sdk.md`; extension examples `rpc-demo.ts`, `modal-editor.ts`; SDK examples `06-extensions.ts`, `12-full-control.ts`; installed `extensions/types.d.ts`, `extensions/runner.js`, `rpc/rpc-mode.js`, native message/tool components and SDK declarations.

### Capability probe (not acceptance)

A temporary isolated SDK probe loaded only fixture extensions and used an in-memory session and isolated profile. No provider call or user credential was used.

It verified that a TUI-only extension command can call a host-supplied custom UI implementation through the public SDK, render its component, receive an input event, and resolve its original callback result including a `Set` without serializing the callback/result through JSON. It also verified access to the fixture's tool renderer through the public session API.

The first probe iterations exposed two harness assumptions: the Pi TUI package does not export the keybinding manager constructor assumed by the probe, and `noTools: all` removes extension tools from the registry. Correcting the probe to supply its unused keybinding interface and disable built-in tools, not extension tools, produced a pass. No product behavior was changed or accepted on this basis.

This does NOT verify network delivery, terminal focus, overlays, cancellation, arbitrary plugins, or browsers.

## Proposed generic implementation boundary

1. Keep structured agent output and use the existing native Pi renderer for assistant/tool events in the local transcript.
2. For generic custom plugin interaction, investigate an isolated SDK-based task host that supplies Pi UI APIs and exchanges scoped UI updates and input over the authenticated task connection. Plugin callbacks/renderers stay inside the task process. Do not run received code in the client or mirror the complete remote Pi screen.
3. Reuse Pi TUI components/rendering; do not build a separate terminal engine. Bound frame sizes, frame rates, input ownership, dialog IDs, and lifecycle. Preserve disconnect/abort cleanup and replay guarantees.
4. Distinguish the remote plugin's UI from local editor/session controls. Arbitrary editor replacement, global raw-key hooks and background panels must not seize local input or overwrite drafts.
5. Browser/local-service workflows and plugins directly spawning terminals or reading physical devices cannot be promised transparent support merely by forwarding Pi APIs. A remote localhost URL is not a usable local URL. Any forwarding or local execution needs an explicit supported mechanism and consent; never expose arbitrary remote ports or run remote-supplied commands automatically.
6. The stock RPC route can support standard dialogs, but cannot fulfill generic custom TUI support by a client-only patch. The user approved the SDK task-host execution-layer adjustment after reviewing this limitation.
7. The user permits designing explicitly authorized local capabilities where necessary, not blanket access. Default to cloud-side plugin execution. Any local operation must identify its purpose and narrow scope, support refusal, and must not automatically execute a remote-supplied command or expose arbitrary ports. Broad compatibility remains an acceptance claim to prove, not a guarantee inferred from the SDK probe.

8. Implementation exposed two missing public exports in Pi 0.85.1: the active theme instance and constructible application keybindings manager. After asking explicitly, the user delegated the choice; selected narrowly scoped, read-only internal adapters with an exact supported-version check. No Pi source modification or additional privilege is allowed. New Pi versions need fresh compatibility tests; unsupported versions must fail visibly rather than silently degrade.

## Acceptance matrix to implement

- Real Pi regular/fullscreen: structured assistant text/thinking, built-in and extension tool call/result/error, partial updates, expansion, selection/copy, resize, theme invalidation, no duplicate transcript after reconnect.
- Real input: editable draft, Enter steering, follow-up shortcut, queued-message visibility and editing, images, slash/bang intent, autocomplete Escape versus stop, local conversation after terminal outcome.
- Standard dialogs: confirm/select/input/editor; rejected/cancelled/empty/multiline responses; simultaneous requests; focus ownership; stop and disconnect while a dialog is open; remote timeout before a late response.
- Generic custom UI: fixture plugins with no cloud-specific imports; closures and non-JSON callback results; keyboard/mouse, custom tool renderers, overlay/resize/disposal. No automatic approval on unsupported calls.
- Credentials: selected by default only when available, explicit final consent, opt-out/no-auth confirmation, cached bundle authorization, runtime cleanup and no credential output.
- Recovery/security: no automatic task recreation, finalizing preserved, pin before upload, bounded backpressure, safe protocol errors, no out-of-scope port/command exposure.
- End to end: real process stop and cleanup, file and session return, local continuation, package installation; exact-commit seven-job CI. Fixture probes and unit mocks do not replace these gates.

## Final verification checkpoint

- Code candidate `3531bd1` passed all seven CI jobs: https://github.com/WSXYT/pi-cloud-computing/actions/runs/36998291775. Windows 139/139; Linux/macOS/Docker 138/138; no failures/skips. Native services, package installation, real SDK task execution/stop/credential cleanup/local continuation and nine artifact combinations passed.
- Native input, queue display/dequeue recovery, default provider/model credential selection and terminal session restoration are implemented and covered; the older outstanding-work notes below are chronological records, not current task status.
- Unsupported global/editor/persistent-surface/session-replacement/controlled-overlay plugin APIs remain explicit capability limits documented in README, not accepted features. No generic local command/port authorization was added. Offline custom tool views use cached sizes; arbitrary terminals, IMEs and paid providers are not claimed tested.
- Production dependency audit: zero vulnerabilities. Failed preliminary CI runs and the unproven historical macOS startup stall are recorded in ACCEPTANCE.md. No timeouts were extended to obtain the passing gate.

## Historical implementation checkpoints (superseded by final verification)

- Branch: `feat/native-cloud-interaction`; release baseline remains `7c34f48`.
- Added `src/client-transcript.ts`: actual Pi assistant/user/tool components, terminal-control sanitization, per-cursor replay deduplication, and compact latest-message/tool snapshots rather than one saved copy per token.
- `src/client.ts` now creates a single `pi-cloud-native` transcript entry for each TUI task and updates native components in place. RPC clients retain their supported text/event representation. The old TUI Markdown preview widget is removed.
- `CloudTaskState.nativeTranscript` retains structured display snapshots; native display entries are excluded from authoritative session merging. Thinking visibility follows its initial Pi setting and native Ctrl+T; Ctrl+O expands the native tools.
- The running status no longer exposes an event counter.
- First focused component/client/session/real-terminal run: 17/17 passed. Latest focused native transcript/editor and four real-terminal scenarios: 8/8 passed, including Ctrl+T and Ctrl+O through actual PTY/ConPTY. These are incremental checks, not full platform acceptance.
- SDK/transport foundation added: `worker/sdk-session.ts` creates a real Pi SDK session against the isolated profile; `worker/sdk-components.ts` keeps component factories/callback results in the task process and serializes focus. `component-protocol.ts` validates bounded component frames, keyboard/mouse input and dimensions; only SGR and Pi's caret marker survive, not clipboard/title/cursor commands.
- The existing authenticated task WebSocket now has scoped `task_component` / `task_component_input` messages. Component snapshots are ephemeral, coalesced and resumable while the process is alive, not journaled per repaint. `client-components.ts` hosts them in Pi's own custom-component slot, ignores late revisions/closed IDs, and retains a Ctrl+C task-stop path while the plugin owns Escape.
- Foundation tests: 16/16 (SDK session, real child-process frame routing, authenticated loopback WebSocket recovery, actual Pi Input component editing, cancellation/disposal, bounds and terminal-injection checks). A focused run including all four real-terminal variants passed 11/11. These remain incremental checks, not installed-service or full plugin acceptance.
- A broader 29-test run found an external Pi update notification interfering with a terminal fixture (28 passed, 1 failed). The terminal fixture now sets `PI_SKIP_VERSION_CHECK=1`, as other isolated harnesses already do, rather than extending an action timeout; all four terminal variants passed afterward.
- Standard dialog lifetime is now implemented in `worker/sdk-dialogs.ts`: concurrent IDs, validated selections, empty/multiline values, timeout/AbortSignal cancellation and fail-closed shutdown. `extension_ui_closed` removes the pending Worker request and aborts the corresponding local dialog without sending a late reply. TUI multiline editing uses Pi's `ExtensionEditorComponent` with explicit cancellation rather than leaving an obsolete modal open. Explicit task stop dismisses all dialogs. Latest build plus dialog/client-wait checks: 5/5 passed; broader SDK-dialog/client/RPC checks: 19/19 passed. SDK dialogs are now connected through the SDK UI host.
- `worker/sdk-entry.ts` and `worker/sdk-ui.ts` now run through the task bootstrap. Preparation copies only the required runtime modules; plugin code remains outside the Worker service process. The host runs standard dialogs/custom components, emits structured session events, handles append/abort commands, and calls session_shutdown before disposal. Explicit capability errors remain for unimplemented global/editor/persistent-surface APIs; do not advertise those as supported.
- Actual SDK entry verification: real Worker host test passed (20.8s) including provider/skill/tool, dialog, streaming, stop, runtime credential removal, result return and local continuation. `test/sdk-entry.test.ts` also passes a real isolated process with a cloud-agnostic custom-component plugin, original Set closure result, standard confirmation and shutdown marker, with no model invocation. SDK startup initially failed with ERR_PACKAGE_PATH_NOT_EXPORTED from CommonJS resolution of Pi's ESM-only entry; fixed against the pinned npm CLI layout, preserving bounded startup-phase diagnostics. Two narrow theme/keybinding adapters require exactly Pi 0.85.1 and fail explicitly for other SDK versions.
- Plugin tool-renderer bridge now runs native ToolExecutionComponent inside the SDK task, preserving renderCall/renderResult shared state. Validated style-only row snapshots travel as task events for restoration; local native tool rows display those snapshots without executing remote code. Scoped viewport requests re-render live rows at the requested width/expansion state. Real Worker test with a fixture custom renderer passed (15.3s), and focused renderer/protocol/transcript tests passed 6/6, including replay without duplicate rows. Current limitations: final/offline views retain cached widths; persistent custom surfaces still need coverage. Tool ownership now uses Pi source metadata, so plugins overriding built-in names are not skipped; duplicate width/content/expansion snapshots are suppressed. A focused 5/5 run covers the built-in-name override and snapshot suppression. This is not yet real-terminal plugin renderer acceptance.
- Credential-default first pass: `client-credentials.ts` inspects only the already-scanned bundle for the selected provider, recognizes API keys/OAuth/custom-model auth and resolved variable references, and does not execute command-based secrets. Available matching credentials start selected; unrelated credentials do not. Final explicit per-task consent and the opt-out/no-auth decision are unchanged. Credential helper plus all three real-Pi flows passed 4/4 (including selected-by-default and explicitly deselected fixtures). Provider/model-specific overrides, missing-credential guidance and consent wording still need full review.
- Still pending: complete scoped UI capabilities (especially persistent components and full renderer lifecycle); editable cloud input semantics; plugin focus/cancellation/timeout/reconnect end-to-end; default credential consent changes; real session-reload display recovery; complete cross-platform/package gates and documentation alignment. Session replacement/reload currently fails explicitly in the SDK foundation rather than silently escaping task ownership; this is a capability limitation, not a compatibility pass. The native-output milestone is now complete; overall feature/platform acceptance is not. Native-input is the current milestone.
- Latest verification: full `npm test` **138/138** passed with no skips. Earlier runs exposed a loaded-host server-test timeout (isolated 3/3 passed) and Windows temporary-directory cleanup ENOTEMPTY; the latter fixture now uses bounded removal retries, without weakening assertions. The 138/138 run precedes the final help-copy and follow-up shortcut edits; rerun the full suite at final acceptance.
- Added `client-plugin-terminal.test.ts`: real isolated SDK + Worker + authenticated WebSocket + actual local Pi PTY, both regular/fullscreen, approve/stop cases 4/4. Tests Chinese component input, resize, original closure, native confirm, modal focus isolation, Ctrl+C actual stop and runtime cleanup, and local editor afterward. Initial fixture used unsupported `y` confirmation; corrected to Pi's documented Enter selection.
- Real terminal completion cases now restart Pi on the same session, expand restored output, and assert exactly one native transcript card and one Worker task. Focused output/preflight/terminal checks 12/12 passed.
- Worker capability `taskUiVersion: 1` is now advertised and validated. Submission rejects a missing/incompatible task UI before scanning/uploading; old task restoration stays untouched. Dedicated legacy/task-UI/storage tests keep the draft and create no task.
- Native follow-up fix: Pi treats Ctrl+Q/Alt+Enter as regular Enter when its LOCAL agent is idle; the cloud editor now preserves the configured follow-up intent through the native input hook (and literal slash path). All four real-terminal cases verify Enter→steer and Ctrl+Q→followUp without running the local model. Native queued-message display/dequeue editing remains outstanding.
- Editable-input first pass is active: running Enter appends with steer semantics, configured follow-up delivery is retained, idle Enter stays local, and Escape first dismisses native autocomplete before stopping cloud work. Preparation still prevents accidental submission. Real terminal tests retain literal slash input and now submit ordinary input without entering an append mode.
- Current Windows worktree validation: full `npm test` passed **130/130**, zero failures/skips; package install smoke passed. Real client/native merge tests now assert ordinary cloud append, no local agent turn, and additional input surviving socket replacement; bounded-wait tests assert the unacknowledged input remains queued after local wait expiry. These local passes do not replace exact-commit cross-platform CI or the remaining feature acceptance.
- The latest LSP error probe found no reported errors but all 8 checks were inconclusive (push-only server or timeout), so it is not a clean sweep. TypeScript build and the focused test commands did pass.

Production deployment, npm publishing, and use of real paid-provider credentials remain out of scope without new authorization.
