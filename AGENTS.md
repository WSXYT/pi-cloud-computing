<!-- pi-agents-md:begin version=1 scope=. -->
# Repository Guide

## Project
Node.js 24 TypeScript ESM Pi extension and native Windows/macOS/Linux Worker. Source: `src/`; tests: `test/`; deployment: `deploy/`; automation: `scripts/`.

## Commands
- Install: `npm ci`
- Validate: `npm run check && npm test`
- Package/install smoke: `npm run pack:smoke`
- Published smoke: `PI_CLOUD_SMOKE_PACKAGE=pi-cloud-computing@<version>`.
- Production audit: `npm audit --omit=dev`

## Safety and Recovery
- Pin certificates; check Worker health/capabilities before uploads. Never expose credentials/raw exceptions.
- Never recreate missing tasks automatically. Local timeouts do not establish remote outcomes.
- Preserve abort finalization through process/credential cleanup.
- Credential defaults are not consent: require explicit per-task authorization, encrypted/revocable storage and cleanup. Confirm no-auth endpoints.
- Windows private writes fail closed on ACL errors; never recursively strip child inheritance.
- Preserve source/state/sessions/artifacts; uninstall preserves private data.
- Validate cached results/submission baselines before review. Default to keep; require explicit apply consent and recheck before writes.

## UX and Acceptance
- Idle Enter stays local; running Enter steers cloud. Preserve follow-up/dequeue, drafts, focus-aware Escape and usable stop.
- Keep cloud display cards outside local model context; triggerTurn:false is insufficient.
- Reuse native Pi components; isolate plugins. Require Pi >=0.85.1 stable plus SDK/UI capabilities, never an exact-version whitelist. Fail unsupported capabilities explicitly.
- Test minimum/current Pi, real PTY/ConPTY startup/reload, three-system installed services, cross-platform artifacts, package smoke and Linux Docker. Skips/mocks are not acceptance.
- Service-install CI scripts are disposable-runner only. Record limits in `ACCEPTANCE.md`; require every exact-candidate CI job per `RELEASING.md`.
<!-- pi-agents-md:end -->
