<!-- pi-agents-md:begin version=1 scope=. -->
# Repository Guide

## Project
Node.js 24 TypeScript ESM Pi extension and native Windows/macOS/Linux Worker. Source: `src/`; tests: `test/`; deployment: `deploy/`; automation: `scripts/`.

## Commands
- Install: `npm ci`
- Validate: `npm run check && npm test`
- Package/install smoke: `npm run pack:smoke`
- Published-package smoke: set `PI_CLOUD_SMOKE_PACKAGE=pi-cloud-computing@<version>`.
- Production audit: `npm audit --omit=dev`

## Safety and Recovery
- Pin certificates and check Worker health/capabilities before uploads. Never expose credentials or raw exceptions.
- Never recreate missing tasks automatically. Local timeouts do not establish remote outcomes.
- Preserve abort finalization until process/credential cleanup finishes.
- Default credential selection is not consent: require explicit per-task authorization, encrypted/revocable storage and cleanup. No-auth endpoints require confirmation.
- Windows private writes fail closed on ACL errors; never recursively strip child inheritance.
- Preserve source, state, sessions and artifacts. Uninstall preserves private data.
- Validate cached results, preview before consent, and apply only after baseline checks.

## UX and Acceptance
- Idle Enter stays local; running Enter steers cloud. Preserve native follow-up/dequeue, drafts, focus-aware Escape and usable stop.
- Keep cloud display cards out of local model context; triggerTurn:false is insufficient.
- Reuse native Pi components; keep plugin code isolated. Require Pi >=0.85.1 stable plus SDK/UI capability checks, not an exact-version whitelist. Test minimum and current Pi; fail unsupported capabilities explicitly.
- Require real PTY/ConPTY, three-system installed-service execution, cross-platform artifacts, package smoke and Linux Docker. Skips/mocks are not acceptance.
- Service-install CI scripts are disposable-runner only. Record limits in `ACCEPTANCE.md`; require every exact-candidate CI job per `RELEASING.md`.
<!-- pi-agents-md:end -->
