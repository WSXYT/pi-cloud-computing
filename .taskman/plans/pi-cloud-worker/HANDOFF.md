# Pi Cloud Linux Worker

## Goal

Implement the self-hosted Linux Worker as the `pi-cloud` CLI plus a long-running service. It accepts one active Pi task at a time, queues later tasks, streams Pi events over WSS, persists project/task state until the configured cleanup policy removes it, and supports Docker or explicit host execution.

## CLI

Implement localized commands:

- `pi-cloud worker install|start|stop|status`
- `pi-cloud worker pair`
- `pi-cloud worker tls rotate --ip <address>`
- `pi-cloud worker clean`
- `pi-cloud worker config set language|retention|runner ...`

`install` preflights Node.js 24, Git, Pi, OpenSSL, Linux/systemd, and optional Docker. It creates the data directories, service account/config, TLS material, encryption key, and systemd unit. Do not silently install system packages.

## TLS and pairing

- Generate a self-signed certificate whose SAN contains the configured IP; never use CN-only validation.
- Display SHA-256 fingerprint in `install`, `status`, and `tls rotate`.
- Pairing codes are single-use, high-entropy, rate-limited, and expire after 10 minutes.
- Successful pairing returns a scoped, revocable bearer token only after TLS is established and the pairing code is verified.
- Store token hashes rather than plaintext tokens. Log authentication events without token/secret contents.
- Certificate rotation invalidates existing pins by design and clearly instructs re-pairing.

## Secret storage

- Generate a server-local 256-bit master key with restrictive permissions.
- Store authorized secret bundles encrypted with authenticated encryption (AES-256-GCM or Node's equivalent), unique nonce per write, provider/key identifier as authenticated data, and version metadata.
- Return only secret IDs/versions/hashes to clients.
- Support replacement and revocation; never expose stored values through status or logs.

## Transport

- HTTPS for health, pairing, manifests, and bounded artifact upload/download.
- WSS for task lifecycle, Pi events, queue updates, steer/follow-up messages, and abort.
- Enforce protocol version, content type, artifact size limits, path normalization, hashes, and ownership on every boundary.
- Write uploads to temporary files and atomically promote only after full hash verification.
- Reconnect resumes events from a monotonically increasing event cursor.

## Task execution

- Use Pi's official SDK or RPC mode; do not implement an agent loop.
- Create an isolated per-project/per-task agent directory and workspace populated from verified artifacts.
- Restore the submitted native session in the remote workspace, start Pi from it, stream structured events, and forward user input as prompt/steer/follow-up according to current state.
- One active task globally in v1; persist queued/running/completed/failed/aborted state so restart recovery is explicit.
- On completion, collect the remote native session tail, Git result ref/commit/diff, verification metadata, logs, warnings, and environment delta.

## Runners

- Docker mode is recommended and shown as safer. Use a resource-limited container, explicit workspace/data mounts, minimum authorized secrets, and no Docker socket mount.
- Host mode is opt-in with a prominent warning and runs as the dedicated service account in a task directory.
- Runner capability/status is part of worker discovery and the submission manifest.

## Retention and cleanup

Support retain-until-delete and configurable time-based cleanup. Never delete active tasks. Cleanup secrets only through explicit revoke/delete policy, not ordinary task cleanup.

## Verification

Add integration tests for certificate SAN/fingerprint, pin-compatible TLS, pair-code expiry/reuse/rate limiting, token scoping/revocation, encrypted-secret round trips and tamper rejection, artifact hash/path/size enforcement, queue lifecycle, reconnect cursors, Pi RPC fixture execution, abort/restart recovery, and Git/session result packaging. Include a real Linux smoke script for systemd/Docker paths where CI permits.
