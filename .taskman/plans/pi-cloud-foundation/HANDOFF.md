# Pi Cloud Shared Foundation

## Goal

Create the repository and shared implementation used by both the local Pi extension and Linux Worker. Keep this as one npm package with one version, one protocol, and one dependency graph; do not create a monorepo unless an actual build boundary appears.

## Technical direction

- TypeScript ESM targeting Node.js 24.
- Package exports shared modules plus a `pi-cloud` bin and declares the local extension through the package `pi` manifest.
- Prefer Node stdlib. The expected runtime dependency is `ws` for WebSocket transport; Pi packages remain peer dependencies where appropriate.
- Tests use Node's built-in test runner against compiled output or a minimal existing TypeScript runner selected during scaffolding.
- Protocol version starts at `1` and every frame/artifact manifest carries it.

## Shared contracts

Define strict TypeScript contracts and runtime validation for:

- Worker identity/capabilities and Pi version compatibility.
- Pairing, token authentication, certificate fingerprint metadata, and revocation.
- Task create/start/queue/steer/follow-up/abort/status/complete/fail lifecycle.
- Upload/download artifact metadata, content hashes, resumable offsets if inexpensive, and bounded sizes.
- Environment manifest categories, package sources/versions, portable resources, warnings, secret versions, and selected transfer items.
- Stable error/status codes with structured interpolation parameters.
- Remote Pi RPC events and task result metadata.

## i18n

- Add `zh-CN` and `en` catalogs.
- Detect system locale, allow explicit override, and fall back to English.
- Keep protocol and persisted records locale-neutral.
- Add a catalog parity test so missing keys fail CI.

## Environment manifest

Inspect the active Pi agent directory and current project, then describe rather than blindly archive:

- Global settings, model/provider declarations, package specs and enabled filters.
- Global extensions, skills, prompts, themes, and selected local resources.
- Project `.pi` resources relevant to the current task.
- Pi/Node/platform versions and compatibility warnings.
- Secret source/version hashes without exposing secret values in logs or manifests.
- Exclude sessions other than the current session, caches, logs, model stores, temporary files, and unrelated projects by default.

## Git synchronization

- Require a Git repository and Git binary.
- Build a deterministic task snapshot without mutating the user's branch or index. Include current HEAD, tracked modifications, staged modifications, and selected untracked files.
- Bootstrap private repositories through Git bundle/object transfer plus a snapshot tree/ref.
- Return a remote result ref/commit and a binary-safe diff from snapshot to result.
- Validate snapshot identity before local application. Never reset, checkout over, commit, or overwrite unrelated local changes.

## Session synchronization

- Serialize the current active Pi branch from `SessionManager` data into a remote session file with a remote cwd.
- Record the submitted `sessionId`, base leaf, entry IDs, and content hash.
- Collect only entries created remotely after the base cursor.
- Provide a synthesizer that builds a new merged native Pi JSONL session atomically: copy the source active branch, exclude temporary `pi-cloud-live` display entries, remap remote IDs/parents as needed, append supported native entry types, set the remote tail as leaf, and preserve parent-session provenance.
- Validate malformed/orphaned/duplicate entries and unsupported future session versions before switching.

## Verification

Cover deterministic hashing, i18n parity/fallback, manifest exclusions, secret redaction, Git snapshot/patch round trips including binary and untracked files, session tail remapping, corrupted artifacts, and protocol validation. Run typecheck, tests, and package smoke checks before closing this plan.
