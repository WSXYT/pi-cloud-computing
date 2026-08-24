# Pi Cloud Computing

Build a CLI-only Pi package that hands a local Pi session and Git workspace to a self-hosted Linux Worker, keeps subsequent local input routed to the remote Pi queue, and safely returns native session history plus reviewed Git changes.

## Product boundary

- Local surface: Pi extension commands under `/cloud` on Windows, Linux, and macOS.
- Server surface: `pi-cloud worker` CLI and background service on Linux.
- No web dashboard or hosted control plane in v1.
- Users provision their own VPS; the sponsor is a static recommendation/purchase link and never receives task data.
- Raw-IP HTTPS/WSS with an automatically generated self-signed certificate, manual SHA-256 fingerprint verification, certificate pinning, one-time pairing code, and revocable tokens.
- Git repositories only in v1. Git, Node.js 24, Pi, and OpenSSL are required; Docker is optional but presented as safer than host execution.
- Runtime environment synchronization covers relevant global Pi packages/resources/settings/provider declarations and explicitly authorized secrets, but excludes unrelated historical sessions and caches.
- i18n includes `zh-CN` and `en`; protocol messages use stable codes and structured parameters.

## Plan breakdown

1. `pi-cloud-foundation`: create the single-package TypeScript project, protocol contracts, i18n, hashing/archive helpers, environment manifests, Git snapshot/result primitives, and native session-tail synthesis.
2. `pi-cloud-worker`: implement the Linux Worker CLI/service, self-signed TLS lifecycle, pairing/authentication, encrypted secret storage, artifact transfer, task queue, Pi RPC execution, and Docker/host runners.
3. `pi-cloud-orchestration`: implement the local Pi extension commands/TUI, preflight selection, environment/secret synchronization, remote event and input routing, result review/application, native session replacement, and sponsor slot.
4. `pi-cloud-release-e2e`: complete cross-platform/package installation flows, systemd/Docker assets, end-to-end tests, security/operations documentation, and package smoke checks.

## Ordering

- Foundation is required by both Worker and local extension.
- Worker is completed before the local extension is finalized against the real transport.
- Release/e2e work starts after the Worker and local extension integrate.

## Key invariants

- Never disable TLS verification globally; pin the accepted self-signed certificate fingerprint.
- Never upload secrets without explicit preflight authorization; persist only encrypted bundles and support revoke/rotate.
- Never overwrite local files or append arbitrary bytes to an active Pi session.
- Validate Git and session base identities before applying results.
- Preserve the original local session and remote session artifact for audit/recovery.
- A compatibility warning may continue only after being shown in the submission manifest.
