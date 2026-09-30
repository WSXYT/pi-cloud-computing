<!-- pi-agents-md:begin version=1 scope=. -->
# Repository Guide

## Project
Node.js 24 TypeScript ESM Pi extension and native Windows/macOS/Linux Worker. Source is `src/`, tests `test/`, deployment `deploy/`, and automation `scripts/`.

## Commands
- Install: `npm ci`
- Validate: `npm run check && npm test`
- Package/install smoke: `npm run pack:smoke`
- Production dependency audit: `npm audit --omit=dev`

## Safety and Recovery
- Keep protocol errors structured; verify certificate pins before credentials or uploads.
- Credentials require explicit consent, encrypted/revocable storage and runtime cleanup.
- Windows private writes fail closed on ACL failure; do not recursively remove child-file inheritance when securing a directory.
- Preserve source, state, session originals and artifacts; never destructive-reset a checkout.
- Apply Git results only after baseline validation. Local wait timeouts never determine remote task outcomes.

## UX and Acceptance
- Preserve local Enter, explicit cloud submit/append, draft recovery and native editor ownership.
- Test both checkbox states and literal slash-prefixed input during active tasks.
- Run real PTY/ConPTY, native installed-service execution on all three systems, cross-platform artifacts, package smoke and Linux Docker gates. Skips/mocks are not platform acceptance.
- Service-install CI scripts are for disposable runners only. See `ACCEPTANCE.md` for measured scope and limitations.
- Require every CI job for the exact release commit; follow `RELEASING.md`.
<!-- pi-agents-md:end -->
