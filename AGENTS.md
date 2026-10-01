<!-- pi-agents-md:begin version=1 scope=. -->
# Repository Guide

## Project
Node.js 24 TypeScript ESM Pi extension and native Windows/macOS/Linux Worker. Source is `src/`, tests `test/`, deployment `deploy/`, automation `scripts/`.

## Commands
- Install: `npm ci`
- Validate: `npm run check && npm test`
- Package/install smoke: `npm run pack:smoke`
- Published-package smoke: set `PI_CLOUD_SMOKE_PACKAGE=pi-cloud-computing@<version>` for the same command.
- Production audit: `npm audit --omit=dev`

## Safety and Recovery
- Pin certificates before credentials/uploads. Keep protocol failures structured; never expose raw exceptions or credentials.
- Distinguish transfer phases and storage failures. Check Worker compatibility/health before uploads; never recreate a missing task automatically.
- Credentials need explicit per-task consent, encrypted/revocable storage and runtime cleanup; no-auth endpoints require explicit confirmation.
- Windows private writes fail closed on ACL failure; never recursively strip child-file inheritance.
- Preserve source, state, sessions and artifacts; never destructive-reset checkouts. Uninstall preserves configuration, credentials and task data.
- Validate cached results before saving. Preview before consent; apply only after baseline checks. Local timeouts never determine remote outcomes.

## UX and Acceptance
- Preserve local Enter, explicit cloud submit/append, drafts and native editor ownership. Stop controls must remain usable while locked.
- Test checkbox states, literal slash input, visible streamed/errors output, real cancellation/credential cleanup and local conversation afterward.
- Require real PTY/ConPTY, installed-service execution on all three systems, cross-platform artifacts, package smoke and Linux Docker. Skips/mocks are not platform acceptance.
- Service-install CI scripts are for disposable runners only. `ACCEPTANCE.md` records measured scope and limitations.
- Require every CI job for the exact release commit; follow `RELEASING.md`.
<!-- pi-agents-md:end -->
