<!-- pi-agents-md:begin version=1 scope=. -->
# Repository Guide

## Project
Node.js 24 TypeScript ESM Pi extension and native Windows/macOS/Linux Worker. Source is `src/`, tests `test/`, deployment `deploy/`, automation `scripts/`.

## Commands
- Install: `npm ci`
- Validate: `npm run check && npm test`
- Package/install smoke: `npm run pack:smoke`
- Production audit: `npm audit --omit=dev`

## Safety and Recovery
- Keep protocol errors structured; verify certificate pins before credentials or uploads.
- Credentials require explicit consent, encrypted/revocable storage and runtime cleanup.
- Windows private writes fail closed on ACL failure; never recursively strip child-file inheritance when securing directories.
- Preserve source, state, session originals and artifacts; never destructive-reset checkouts.
- Validate cached results before saving. Preview before consent; apply only after baseline checks. Local wait timeouts never determine remote outcomes.
- Service uninstall preserves configuration, credentials and task data.

## UX and Acceptance
- Preserve local Enter, explicit cloud submit/append, drafts and native editor ownership.
- Test both checkbox states and literal slash-prefixed active-task input.
- Require real PTY/ConPTY, installed-service execution on all three systems, cross-platform artifacts, package smoke and Linux Docker. Skips/mocks are not platform acceptance.
- Service-install CI scripts are for disposable runners only. `ACCEPTANCE.md` records measured scope and limitations.
- Require every CI job for the exact release commit; follow `RELEASING.md`.
<!-- pi-agents-md:end -->
