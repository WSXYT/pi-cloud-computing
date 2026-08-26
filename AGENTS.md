<!-- pi-agents-md:begin version=1 scope=. -->
# Repository Guide

## Scope
- Node.js 24 TypeScript ESM package providing the local Pi extension and Linux Worker.
- Source lives in `src/`; tests mirror behavior in `test/`; deployment assets live in `deploy/` and `scripts/`.

## Commands
- Install: `npm ci`
- Type-check: `npm run check`
- Test: `npm test`
- Build: `npm run build`
- Package smoke test: `npm run pack:smoke`

## Implementation Notes
- Keep protocol payloads structured and localized only at the client/CLI boundary.
- Treat certificate pins, pairing tokens, provider credentials, artifact paths, Git baselines, and session entry IDs as security boundaries.
- Remote workspace changes must return as reviewable artifacts; never overwrite local files without baseline verification.
- Pi credentials are opt-in, encrypted at rest on the Worker, and removed from the temporary runtime directory after execution.

## Verification
- Run `npm run check && npm test` after code changes.
- Run `bash -n scripts/install.sh` after shell installer changes.
- CI validates Ubuntu, Windows, macOS, and both Docker images.
<!-- pi-agents-md:end -->
