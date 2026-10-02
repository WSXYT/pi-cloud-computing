# Native cloud workflow acceptance / 验收记录

A passing unit test, an installed service descriptor, or a skipped job is not platform acceptance. Require **all seven CI jobs for the exact candidate commit**: three native client/service jobs, three cross-platform artifact consumers, and Linux Docker. The current branch's [Actions runs](https://github.com/WSXYT/pi-cloud-computing/actions/workflows/ci.yml?query=branch%3Afeat%2Fnative-cloud-interaction) identify the immutable commit and logs. Do not use an older green run to approve newer code.

## Audit correction / 完成审核后的补验

The independent completion audit rejected `e67012f` despite its seven green CI jobs: `triggerTurn: false` did not exclude custom display messages from later model context; standard provider environment credentials were missed; and the PTY tests lacked a single real-execution → Escape → cleanup → local-reply flow. These were actual gaps, not waived by the earlier CI passes.

- The client context hook now removes only cloud display cards, retaining visible history and genuine merged messages. `client-context.test.ts` exercises Pi's actual `convertToLlm`; real provider-request assertions check that unmerged cloud content is absent.
- The scanner collects portable standard environment credentials only for the selected provider into the private consent bundle, never the resource archive. API-key names follow pinned Pi 0.85.1; machine-local ADC files, AWS profiles and metadata URLs are not implicitly copied. Default selection still requires final per-task consent.
- `client-execution-terminal.test.ts` runs both regular/fullscreen against a real SDK Worker and fixture HTTP model: real streaming, actual editor Escape, remote connection closure, finalization and credential-file deletion, then Enter and a real local model reply. It asserts no extra cloud task, unchanged local files and no remote-display contamination of the local request.
- Local correction gate: **143/143**, zero failures/skips, check/build/package smoke passed and production audit zero. Exact-commit seven-job CI remains required; use the immutable SHA and Actions run above, not historical counts below.

## Earlier native SDK candidate gates

This candidate supersedes the former locked-running-editor contract. Code commit `3531bd1b37ea583fc867c0a3afbb855550f6b912` passed [all seven jobs in run 36998291775](https://github.com/WSXYT/pi-cloud-computing/actions/runs/36998291775): Windows **139/139**, Linux/macOS/Docker **138/138**, zero failures or skips. Each native job passed package smoke and installed-service execution; the production Docker runner and all nine cross-platform artifact combinations passed. Production dependency audit reports zero vulnerabilities. Documentation-only follow-up commits still require their own seven-job gate, identifiable in the Actions link above.

Earlier runs are not counted as passes: `36995109755` exposed PTY fixtures sending Windows Ctrl+Q on POSIX (corrected to native Alt+Enter); `36996900451` exposed a transient notification being replaced before observation (completion guidance is now retained in the transcript) and one macOS task-start stall with insufficient diagnostic detail. The latter gained live task/event-tail diagnostics, not a longer timeout; its historical cause remains unproven. The subsequent complete run passed without weakening stop, credential-cleanup or input assertions.

- Actual Pi assistant/tool components stream and restore one transcript card after a real Pi restart; regular/fullscreen PTY exercises thinking/tool expansion, literal input, Enter steering and configured follow-up.
- `client-plugin-terminal.test.ts` runs an isolated SDK plugin through a real Worker, authenticated socket and local PTY: custom component closure, Chinese input, resize, native confirm, queue display, configured dequeue, real stop/cleanup and local editing (four variants).
- `sdk-entry.test.ts` proves enqueue/dequeue ordering and idempotent repeat requests. `client-native.test.ts` additionally retrieves real SDK queued input, then stops and checks cleanup/local model continuation. Unconfirmed local outbox and acknowledged SDK queues are distinct; recovery copies never automatically resubmit.
- Current-provider/model credentials default selected only when detected in the scanned bundle; explicit final authorization and opt-out/no-auth checks remain. Credential parsing never executes shell commands.
- Worker capability `taskUiVersion: 1` is required before upload. Pi SDK **0.85.1** is pinned, including two narrow theme/keybinding adapters. Plugin callbacks run cloud-side, not in the client.
- Unsupported global/editor/persistent-surface and controlled-overlay APIs fail explicitly. This is not universal plugin compatibility; see README limits. Offline custom tool views retain cached widths. This candidate has not been deployed or published.

## Historical 0.2.1 corrective acceptance

Commit `0928f148c03b2fa037b16894ce4e63f17b99bad0` passed [all seven jobs in run 36880585734](https://github.com/WSXYT/pi-cloud-computing/actions/runs/36880585734): Windows **115/115**, Linux/macOS **114/114**, zero test failures or skips. All three installed native services and the Docker runner passed the extended real-Pi streaming → stop → runtime credential cleanup → local conversation test. Each native job also passed package smoke, and all nine cross-platform artifact combinations passed.

The first repair run (`36853475162`, commit `99f1be1`) exposed two additional defects rather than passing: journal replay lost the `finalizing` flag between journal append and snapshot replacement, and the Docker service image could not resolve its globally installed Pi through the new native entry path. The fix preserves journal finalization state (with a regression test) and links the image's pinned Pi installation into module resolution. The failed run is not counted as acceptance. Any later commit, including documentation-only changes, still requires its own seven-job pass.

Real use after 0.2.0 exposed missing phase diagnostics, an unclear credential path, ineffective Escape stop, and output hidden by the custom-editor path. Read-only triage also found an old deployed Worker (`5d62621`, Pi 0.84.2) and a nearly full disk. Neither failed submission had been acknowledged. The old client did not record the exact timed-out HTTP request; disk pressure is evidence, **not proof of the historical errno**. Earlier green CI did not cover these combinations.

The corrective suite now requires:

- Explicit pre-upload rejection of legacy/unhealthy Workers; retained drafts; separate no-auth confirmation when credentials are unchecked.
- Upload cancellation and response-stall diagnostics with byte counts; structured, path-free storage failures over HTTP/WS; failed durable storage prevents new task execution.
- Recovery errors never send `task_create`; an unknown remote outcome stays unknown, and errors remain visible without triggering local model turns.
- Four real PTY/ConPTY flows (regular/fullscreen × completion/Escape abort), including streaming text, final transcript output, tool errors and literal slash append.
- Each installed-service real-Pi test additionally streams indefinitely, stops the actual task, verifies runtime credential removal, and obtains a normal **local model reply after cancellation**. Docker runs the same extended test. Host Workers use the Pi entry from their own installation on all platforms.

Fault-injection unit tests establish error handling, not the historical cause or platform acceptance. Exact-commit seven-job CI and package smoke remain required before approving this candidate. No production restart, upgrade or task replay was performed during read-only triage; authorized cleanup was restricted to old, reconstructible download caches.

## Previous complete automated gates

The finalization run on `e12676a` exposed a macOS duplicate-start race. Fix `033895810b9800948d11fd0f13760018092759b7` passed [all seven jobs in run 36807606641](https://github.com/WSXYT/pi-cloud-computing/actions/runs/36807606641). Repeated launchd start preserves the running PID, and a per-directory lifetime lease rejects duplicate Workers before task recovery can mutate live state. `worker-instance.test.ts` verifies rejection and a subsequent clean restart. This later result supersedes the failed finalization attempt; no failed run was reinterpreted as success.

Commit `994ecd12ec92f18778e560294a288f7f8ba54641` passed [CI run 36762715581](https://github.com/WSXYT/pi-cloud-computing/actions/runs/36762715581). All **seven** jobs passed: Windows 101/101 tests, Linux/macOS 100/100, zero skips, both terminal modes, both installers, real installed-service tasks, data-preserving uninstall, all nine artifact combinations and validated result caching/receipt. Subsequent commits, including documentation finalization, still require their own complete CI run.

## Recorded environments

The native-service baseline at commit `abae051daa17b49146699b61b6d64ed17f49264e` passed [all four then-existing jobs](https://github.com/WSXYT/pi-cloud-computing/actions/runs/36741224821), including real Pi execution through each installed service, not just health checks:

| Runner | Reported OS kernel | Node | Pi | Native hosting |
|---|---|---|---|---|
| windows-latest | Windows 10.0.26100 | 24.21.0 | 0.85.1 | Task Scheduler, S4U, least privilege |
| macos-latest | Darwin 25.6.0 | 24.20.0 | 0.85.1 | User launchd agent |
| ubuntu-latest | Linux 6.17.0-1022-azure | 24.21.0 | 0.85.1 | systemd |

The expanded run `36762715581` recorded Linux x64 / AMD EPYC 9V74, Windows x64 / AMD EPYC 7763, and macOS arm64 / Apple M1 (Virtual), with the OS kernels and Node versions above.

Runner images, architecture and tool versions can change; consult the candidate's **Set up job** and native-service log instead of treating `*-latest` as a permanent OS version. These results do not certify every Windows/macOS/Linux release.

The Windows development checkout also passed the expanded **98-test suite, zero failures and zero skips**, including the real ConPTY flow. Production dependency audit reported zero vulnerabilities. Package smoke is run again on each CI candidate.

## What the gates exercise

| 场景 / Scenario | Evidence and boundary |
|---|---|
| Fresh server + local installation | `ci-native-service.mjs` runs the real Worker installer, validates both commit-pinned client command forms, then runs the local installer with their pairing arguments in an isolated Pi profile. A second connection does not redeem the code or duplicate the connection. |
| Background persistence | The installer process exits before health and real-task checks. The native service manager, not an in-process test server, owns execution. Stop removes readiness; restart retains Worker identity and paired access. Uninstall removes service registration/readiness while byte-for-byte preserving configuration, state and the master key. |
| Real remote task | `client-native.test.ts` runs against the installed service with actual Pi, synchronized provider config/skill/tool, remote UI consent, file changes, native conversation merge and runtime credential deletion. It also stops a second streaming task, verifies credential cleanup and confirms local model continuation. A deterministic local model HTTP fixture avoids paid credentials; Pi, tools, filesystem and service execution are real. |
| Enter/F6, focus, literal input | `client-terminal.test.ts` launches **real Pi interactive mode**, using Windows ConPTY or POSIX PTY. It tests editable running input, native follow-up/dequeue routing, F6 menus, literal `/cloud-abort 中文 literal` bracketed paste, resize, streamed/final/error output, completion or Escape abort/unlock, and idle F6 preflight cancellation without creating a second task. Both regular/dark and fullscreen/light variants run the same workflow. It does not replace this with RPC. |
| Narrow rendering and focus-aware Escape | `client-editor.test.ts` and wizard tests verify cell widths, key routing, Escape/draft retention and theme-based components. Existing editor factories are restored on teardown. |
| Shortcut configuration | Client tests verify default F6, persisted F9 registration after reload, and no registration when disabled. The menu asks users to inspect `/hotkeys` for conflicts; no host API exposes all other extensions' private bindings. Disabled mode uses `/cloud`; ordinary text remains protected by the input hook. |
| Bounded disconnected/stop waiting | Fake-clock tests in `client-waits.test.ts` exercise five retries and a 30-second unconfirmed stop, release local input, and verify the task stays `running`, not falsely completed/aborted. Network tests separately exercise actual pinned TLS/WSS. |
| Consent and certificate changes | Checkbox-state tests, runtime/credential separation, pinned-certificate network tests, expiring/single-use pairing, revocation and structured-error tests. Detected current-provider/model credentials default selected, but upload/reuse requires explicit final per-task consent. |
| Result preview and offline copies | `client-results.test.ts` verifies validated private copies work offline and rejects malformed/escaping artifacts. Native receipt checks the actual filename/diff is in the single confirmation before any apply. Completion caches results without changing the local project or session; partial failure reports the unfinished phase. |
| Recovery and local changes | Native session tests plus real Pi merge flows cover deferred receipt and preserved local conversation. Result tests reject baseline substitutions, new local files, excluded files and symlinks before writes; failed application preserves recovery materials. |
| Upgrade/state/security | Installer tests retain modified checkouts and reject failed mandatory commands. Corrupt/BOM state tests preserve originals. Windows ACL failure blocks writes, and repeat directory initialization retains child-file access. |
| Task process cleanup | Real process-tree runner test verifies descendants no longer hold inherited handles; RPC tests reject abnormal exit after settlement and test abort. |
| Cross-OS artifacts | Each native job produces real Git bundles/results and native session archives. Three consumer jobs each validate all three producers: **nine source/destination combinations**, Unicode filenames, binary bytes, baseline-guarded apply and native session tails. Only a disposable fixture's absolute repository identity is rebound, after content baselines and source hashes validate; production guards are unchanged. |
| Packaging/Docker | `pack:smoke` installs a real tarball, CLI/assets and extension in an isolated Pi profile. Linux separately builds both production images, runs real Pi via Docker, and checks non-root installation/service lifecycle. |

## Approved on-site exclusions / 已确认的现场排除

The user declined to provide an on-site environment and explicitly allowed checks that cannot reliably be performed to remain unverified. Accordingly, graphical IME candidate/composition windows, physical reboot recovery, and live cross-OS site/WAN connectivity are **not acceptance blockers for this delivery**. They remain **unverified**, not passed. This does not waive any native-platform, security, package or seven-job CI gate.

用户确认不提供现场环境，实在无法验收可以不验收。上述三项据此不阻断本次交付；不得用字节注入冒充图形输入法、用进程重启冒充机器重启、用制品互换冒充现场网络验证。

## Scope limits — do not overclaim

- PTY/ConPTY tests verify terminal input bytes, Chinese text/paste and resizing. They do **not** certify every graphical IME's composition UI, every terminal emulator, theme, font or full-screen setting. Preserve native Pi editor/keybinding behavior; report emulator-specific failures with its name and version.
- CI tests service registration, detached operation and stop/start. It does not reboot GitHub-hosted machines. Windows has a boot trigger; the macOS user agent loads at user login, **not before login**. Do not claim a tested physical reboot or macOS logout persistence.
- Cross-platform CI exchanges real artifacts. It does not claim live cross-OS WAN routing, firewall, DNS or VPN testing; deployed network reachability remains an operator check.
- Native `host` execution is **not a sandbox**. The service account can access what that account can access. Windows S4U lacks network-share/domain credentials. Docker is optional Linux isolation, not a substitute for native Windows/macOS checks.
- No npm publication or main-branch deployment is implied by a verification-branch CI pass. Follow `RELEASING.md`, and never publish a candidate with a required failing or skipped gate.

## Reproduce

```bash
npm ci
npm run check
npm test
npm run pack:smoke
npm audit --omit=dev
```

`ci-native-service.mjs` and `ci-install-worker.sh` intentionally modify service/global installation state and refuse non-disposable hosts. Do not spoof their CI guard on your own computer. `ci-cross-platform.mjs produce <dir>` and `verify <dir>` operate only on newly created temporary repositories; verification requires all three producer artifacts from the same CI run.
