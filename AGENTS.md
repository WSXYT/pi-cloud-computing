<!-- pi-agents-md:begin version=1 scope=. -->
# Repository Guide

## Scope
- Node.js 24 TypeScript ESM: local Pi extension and Linux Worker.
- Source: `src/`; tests: `test/`; deployment: `deploy/` and `scripts/`.
- Pi loads `src/client.ts`; CLI runs `dist/src/cli.js`. Package source and built assets.

## Commands
- Install: `npm ci`
- Check/test: `npm run check && npm test`
- Build: `npm run build`
- `npm run pack:smoke` verifies real tarball installation, CLI and Pi loading in isolation.
- Shell syntax: `bash -n scripts/install.sh scripts/ci-install-worker.sh`.

## Safety and Recovery
- Keep protocol payloads structured; localize at client/CLI boundaries. Never echo raw HTTP/WS exceptions.
- Verify certificate pins before sending credentials or uploads.
- Credentials require explicit consent, encrypted storage and runtime cleanup.
- Retry creates a new task on its original Worker; renew consent and retain history. Reconnect resumes existing execution.
- Reuse uploads only after authenticated content-addressed existence checks.
- Preserve locked, atomic private state writes; never delete prior state to bypass Windows contention.
- Verify Git/session baselines before applying results; retain originals and reviewable artifacts.
- Exclude `pi-cloud-live` and `pi-cloud-task` from synchronized history.

## UX and Release
- `/cloud` guides isolation, transfer scope and result return; confirm before uploads.
- Exercise recovery, apply and native merge against real Pi.
- Linux/Docker checks require real execution; Windows skips are not passes.
- Installer tests must block real package/service operations. `ci-install-worker.sh` is exclusively for ephemeral GitHub Linux runners.
- Follow `RELEASING.md`; require CI for the exact release commit.
<!-- pi-agents-md:end -->
