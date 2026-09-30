# Native cloud workflow acceptance / 验收记录

A passing unit test, an installed service descriptor, or a skipped job is not platform acceptance. Require **all seven CI jobs for the exact candidate commit**: three native client/service jobs, three cross-platform artifact consumers, and Linux Docker. The current branch's [Actions runs](https://github.com/WSXYT/pi-cloud-computing/actions/workflows/ci.yml?query=branch%3Awork%2Fcloud-native-ux) identify the immutable commit and logs. Do not use an older green run to approve newer code.

## Latest complete automated gate

Commit `eaeeda5` passed [CI run 36757075509](https://github.com/WSXYT/pi-cloud-computing/actions/runs/36757075509); that run records its full immutable `headSha`. All **seven** jobs passed: Windows 100/100 tests, Linux/macOS 99/99, zero skips, both installers, real installed-service tasks, data-preserving uninstall, all nine artifact combinations and validated result caching/receipt. Subsequent changes still require their own complete CI run.

## Recorded environments

The native-service baseline at commit `abae051daa17b49146699b61b6d64ed17f49264e` passed [all four then-existing jobs](https://github.com/WSXYT/pi-cloud-computing/actions/runs/36741224821), including real Pi execution through each installed service, not just health checks:

| Runner | Reported OS kernel | Node | Pi | Native hosting |
|---|---|---|---|---|
| windows-latest | Windows 10.0.26100 | 24.21.0 | 0.85.1 | Task Scheduler, S4U, least privilege |
| macos-latest | Darwin 25.6.0 | 24.20.0 | 0.85.1 | User launchd agent |
| ubuntu-latest | Linux 6.17.0-1022-azure | 24.21.0 | 0.85.1 | systemd |

Runner images, architecture and tool versions can change; consult the candidate's **Set up job** and native-service log instead of treating `*-latest` as a permanent OS version. These results do not certify every Windows/macOS/Linux release.

The Windows development checkout also passed the expanded **98-test suite, zero failures and zero skips**, including the real ConPTY flow. Production dependency audit reported zero vulnerabilities. Package smoke is run again on each CI candidate.

## What the gates exercise

| 场景 / Scenario | Evidence and boundary |
|---|---|
| Fresh server + local installation | `ci-native-service.mjs` runs the real Worker installer, validates both commit-pinned client command forms, then runs the local installer with their pairing arguments in an isolated Pi profile. A second connection does not redeem the code or duplicate the connection. |
| Background persistence | The installer process exits before health and real-task checks. The native service manager, not an in-process test server, owns execution. Stop removes readiness; restart retains Worker identity and paired access. Uninstall removes service registration/readiness while byte-for-byte preserving configuration, state and the master key. |
| Real remote task | `client-native.test.ts` runs against the installed service with actual Pi, synchronized provider config/skill/tool, remote UI consent, file changes, native conversation merge and runtime credential deletion. A deterministic local model HTTP fixture avoids paid credentials; Pi, tools, filesystem and service execution are real. |
| Enter/F6, focus, literal input | `client-terminal.test.ts` launches **real Pi interactive mode**, using Windows ConPTY or POSIX PTY. It tests default input lock, F6 menus, literal `/cloud-abort 中文 literal` bracketed paste, resize, completion/unlock, and idle F6 preflight cancellation without creating a second task. Both regular/dark and fullscreen/light variants run the same workflow. It does not replace this with RPC. |
| Narrow rendering and append Escape | `client-editor.test.ts` and wizard tests verify cell widths, key routing, Escape/draft retention and theme-based components. Existing editor factories are restored on teardown. |
| Shortcut configuration | Client tests verify default F6, persisted F9 registration after reload, and no registration when disabled. The menu asks users to inspect `/hotkeys` for conflicts; no host API exposes all other extensions' private bindings. Disabled mode uses `/cloud`; ordinary text remains protected by the input hook. |
| Bounded disconnected/stop waiting | Fake-clock tests in `client-waits.test.ts` exercise five retries and a 30-second unconfirmed stop, release local input, and verify the task stays `running`, not falsely completed/aborted. Network tests separately exercise actual pinned TLS/WSS. |
| Consent and certificate changes | Checkbox-state tests, runtime/credential separation, pinned-certificate network tests, expiring/single-use pairing, revocation and structured-error tests. Credentials are off by default. |
| Result preview and offline copies | `client-results.test.ts` verifies validated private copies work offline and rejects malformed/escaping artifacts. Native receipt checks the actual filename/diff is in the single confirmation before any apply. Completion caches results without changing the local project or session; partial failure reports the unfinished phase. |
| Recovery and local changes | Native session tests plus real Pi merge flows cover deferred receipt and preserved local conversation. Result tests reject baseline substitutions, new local files, excluded files and symlinks before writes; failed application preserves recovery materials. |
| Upgrade/state/security | Installer tests retain modified checkouts and reject failed mandatory commands. Corrupt/BOM state tests preserve originals. Windows ACL failure blocks writes, and repeat directory initialization retains child-file access. |
| Task process cleanup | Real process-tree runner test verifies descendants no longer hold inherited handles; RPC tests reject abnormal exit after settlement and test abort. |
| Cross-OS artifacts | Each native job produces real Git bundles/results and native session archives. Three consumer jobs each validate all three producers: **nine source/destination combinations**, Unicode filenames, binary bytes, baseline-guarded apply and native session tails. Only a disposable fixture's absolute repository identity is rebound, after content baselines and source hashes validate; production guards are unchanged. |
| Packaging/Docker | `pack:smoke` installs a real tarball, CLI/assets and extension in an isolated Pi profile. Linux separately builds both production images, runs real Pi via Docker, and checks non-root installation/service lifecycle. |

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
