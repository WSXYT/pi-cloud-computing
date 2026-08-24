# Pi Cloud Local Orchestration Plugin

## Goal

Implement the user-facing Pi extension. It runs inside ordinary local Pi, exposes localized `/cloud` commands, packages the current Git/Pi state after explicit confirmation, routes subsequent input to the remote Pi while a task is active, displays remote progress, and safely applies the returned Git/session result.

The approved interaction prototype is stored under this plan's `prototypes/pi-cloud-terminal-flow/`; v4 is the stable, no-JavaScript CLI reference. The actual product is terminal-only.

## Commands

- `/cloud pair <ip:port>`
- `/cloud run <task>`
- `/cloud status`
- `/cloud abort`
- `/cloud apply [task]`
- `/cloud sync`
- `/cloud secrets`
- `/cloud clean`
- `/cloud unpair`
- `/cloud config language <zh-CN|en>`

Use Pi's existing `SelectList`, `SettingsList`, `BorderedLoader`, notifications, status, widgets, and input events. Do not replace the editor or build a general dashboard.

## Pairing

- Connect to the raw IP using TLS only for certificate discovery, show the SHA-256 fingerprint, and require confirmation before trusting it.
- Require the separate one-time pairing code.
- Persist the exact certificate pin and access token in user-scoped extension state with restrictive file permissions; never set a global insecure TLS option.
- Reject changed certificates and provide a clear unpair/re-pair path.

## Submission preflight

`/cloud run` builds a selectable manifest and asks for one final confirmation. Categories include current session, Git snapshot and selected untracked files, global/project Pi packages and resources, provider/model declarations, and authorized secrets. Support one-key select-all. Show sizes, changed/unchanged secret versions, server runner mode, Pi compatibility, platform warnings, and excluded items before upload.

Require a persistent local session and Git repository. Do not upload ephemeral sessions or ignored/unselected files silently.

## Remote handoff

- Mark the active session as cloud-controlled after acceptance.
- Intercept ordinary local input and send it to remote prompt/steer/follow-up queues based on remote state. Local Pi must not process the same input.
- Stream remote assistant/tool/task events into compact temporary `pi-cloud-live` display entries/status without pretending they are final native session entries.
- Reconnect with event cursors after network interruption; permit abort or explicit return-to-local, which creates a divergence requiring branch handling.
- Store enough task state in extension custom entries to recover after local Pi restart.

## Result review and application

- Download and hash-verify result artifacts.
- Show remote commit/ref, diff stats/full diff, tests, warnings, session entry count, and environment changes.
- Validate the local Git snapshot and source session identities before any mutation.
- Import the remote audit ref, then apply only the remote snapshot-to-result patch. On conflicts, stop and leave a recoverable artifact/ref; do not overwrite, reset, or auto-commit unrelated local changes.
- Build the merged native session file atomically, excluding temporary live entries, preserving original session provenance, and switch through Pi's supported session-replacement API. Keep original and remote JSONL artifacts.
- Permit “later” without losing results and provide explicit cleanup.

## Environment and secrets

- Upload only selected changed resources, using hashes to skip unchanged data.
- Local absolute paths/native assumptions become localized warnings; user chose warning-and-continue behavior.
- Secrets require explicit first authorization. Later submissions reference the stored version unless the local value changes. `/cloud secrets` supports inspect-by-name/version, update, and revoke without printing values.

## Sponsor slot

Expose one localized, static server recommendation entry in setup/help. It may show sponsor name and purchase URL only. It must not proxy, receive, or be required for any data flow.

## Verification

Add extension tests with mocked Pi API/UI for command registration, locale selection, manifest selection/all, certificate pinning, changed-certificate rejection, input interception and queue mode, reconnect state, restart restoration, secret version behavior, artifact verification, Git conflict refusal, native session synthesis/switch, and cleanup. Run against the real Worker in the release/e2e plan.
