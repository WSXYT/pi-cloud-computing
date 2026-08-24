# Planning Context

## Intent

- Build a Pi integration with a local client plugin and a server-side Pi executor/plugin.
- Allow creating/dispatching tasks locally for Pi to execute on a cloud server.
- Allow one-click upload of the current conversation and workspace changes for remote execution.
- Allow completed remote changes/results to sync back to the local machine.
- Keep workflow consistent across local and server: plugin packages, providers, Pi configuration, and related settings.
- Reserve a sponsor/provider slot for a future cloud-server vendor integration.

## Current Repository

- `D:/NAS/bc-me/pi-cloud-computing` is currently empty and is not a Git repository.
- Design should therefore define a new project boundary and initial architecture.

## Decisions

- First deployment model: user buys/provisions a VPS from a sponsor/cloud vendor and self-hosts the server component. Sponsor integration is an advertising/recommendation slot, not the execution authority.
- Server worker: a long-running Pi-compatible agent/worker.
- Workspace baseline: Git-first synchronization.
- Provider/plugin/config parity: sync declarations and allow user-selected secrets; user may select all, but secrets are not silently uploaded.
- Server execution isolation: user-selectable mode; Docker/container mode should be documented as the safer choice, while host execution may remain available.
- Return path: remote changes become a commit/patch for local review and confirmation; no silent overwrite.
- Conversation: append remote progress/results into the current local conversation rather than creating only a separate session.
- Authorization: preflight manifest/selection confirmation before submission. After a secret is uploaded once, do not resend it unless it changes.
- Session handoff: after remote submission, ordinary local input is forwarded to the running remote Pi queue (`steer`/`followUp`) rather than executed by a second local Pi. The remote tail therefore remains linear and can be merged natively back into the current session.
- Session divergence: create a branch only if the user explicitly returns to local execution or the local session changes independently while the remote task is active.
- Environment scope: user wants the entire global Pi environment synchronized, subject to explicit category selection/preview rather than an opaque archive.
- Secret storage: server encrypts authorized secrets at rest and supports revocation/rotation; unchanged secrets are referenced by version and not retransmitted.
- Sponsor boundary: sponsor is a recommendation/purchase entry point only and does not receive conversation, workspace, or secret data.
- Connection: pairing code plus HTTPS/WSS over a raw server IP. The server installer generates a self-signed certificate with the IP in its SAN; first pairing verifies and pins the SHA-256 certificate fingerprint. Optional SSH setup may be added as a convenience, but is not core protocol scope.
- Product surface: CLI only. The local Pi plugin exposes `/cloud ...` commands and in-terminal prompts/status; the server exposes `pi-cloud worker ...` commands and a background service. No browser UI or web dashboard.
- Task mode: support both interactive control/status and batch completion.
- Local platforms: Windows, Linux, and macOS in v1; server target is Linux.
- Compatibility policy: warn and record environment differences, then allow execution to continue.
- Retention: selectable during installation; chosen default is to retain project workspace/session/log data until the user deletes it.
- Git requirement: v1 requires Git locally and on the server. First sync bootstraps a private project with a Git bundle/archive; subsequent syncs are incremental.
- Environment categories: sync global runtime resources and configuration needed by the current task (extensions, skills, prompts, themes, settings, models/provider declarations, package sources/versions, selected local resources, authorized secrets). Do not sync unrelated historical sessions or caches by default.
- Internationalization: v1 includes Simplified Chinese (`zh-CN`) and English (`en`). Both the local Pi CLI extension and server CLI follow system locale by default and allow an explicit language setting. Unknown locales fall back to English.
- Protocol localization: transmit stable status/error codes plus structured parameters, not localized prose; each CLI renders messages locally so client/server language choices can differ without changing protocol behavior.

## Constraints

- Pi's local conversation/session state, workspace files, extensions, skills, provider configuration, and secrets are separate categories and should not be treated as one unrestricted archive.
- Remote execution is arbitrary code execution and requires explicit authorization, authentication, isolation, and an auditable task lifecycle.
- Sync needs an explicit conflict policy; bidirectional automatic merge cannot be assumed safe.
- A first release must be smaller than the full "perfect local/cloud parity" vision.

## Open Questions

- None blocking v1 implementation.

## Implementation Defaults

- Server baseline: Linux with Node.js 24, Git, OpenSSL, and systemd where available; Docker is optional and selected during worker setup.
- Pairing: the user compares the SHA-256 fingerprint shown by the server CLI and local Pi plugin, then enters a separate one-time pairing code. The client pins the accepted fingerprint.
- Portability: package declarations and portable resource files are synchronized; absolute paths, shell assumptions, and native dependencies are detected as warnings and may continue by user choice.
- Concurrency: one active remote Pi task per worker in v1, with later submissions queued. This keeps session, resource, and secret ownership deterministic.
- Local commands: `/cloud pair`, `/cloud run`, `/cloud status`, `/cloud abort`, `/cloud apply`, `/cloud sync`, `/cloud secrets`, `/cloud clean`, `/cloud unpair`, and `/cloud config language`.
- Server commands: `pi-cloud worker install`, `start`, `stop`, `status`, `pair`, `tls rotate`, `clean`, and `config set`.
- Session handoff implementation: stream remote output into temporary cloud display entries while running, then create and switch to an atomically synthesized native merged session that excludes temporary display entries and retains the original session as its parent/audit source.
- Git result implementation: store the remote result as an audit ref/commit and apply only the diff between uploaded snapshot and remote result after validating the local snapshot hash; never overwrite or silently commit unrelated local changes.

## Discarded Options

- Treating the entire local `~/.pi/agent` directory as an unrestricted sync archive is rejected for now: it mixes sessions, extensions, settings, provider credentials, caches, and unrelated projects. The user still wants the global runtime environment covered, so the implementation must define a manifest/category model and exclude unrelated session history/caches by default.
- Directly overwriting the local workspace with remote results is rejected as the default: it can destroy local edits and makes conflict recovery opaque.
- Making a hosted multi-tenant service the first target is deferred: the user wants users to provision their own sponsor/cloud VPS first.
- Making both persistent-worker and per-task process execution first-class in v1 is deferred: the worker model is sufficient for the initial interactive workflow.
