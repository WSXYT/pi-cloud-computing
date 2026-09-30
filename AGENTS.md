<!-- pi-agents-md:begin version=1 scope=. -->
# Repository Guide

## Project
Node.js 24 TypeScript ESM Pi extension and Worker. Source is `src/`, tests are `test/`, deployment is `deploy/` and `scripts/`. Native service implementations target Windows, macOS and Linux; implementation is not proof of platform acceptance.

## Commands
- Install: `npm ci`
- Validate: `npm run check && npm test`
- Package/install smoke: `npm run pack:smoke`

## Safety and Recovery
- Keep protocol payloads structured; never expose raw HTTP/WS exceptions.
- Verify certificate pins before sending credentials or uploads.
- Require explicit consent for credentials; preserve encrypted, revocable storage and runtime cleanup. Windows private writes must fail closed when ACL setup fails.
- Preserve user source/state; never destructive-reset existing checkouts.
- Apply Git results only after baseline validation; preserve reviewable originals and artifacts.

## UX and Release
- Treat `/cloud` onboarding, pairing, transfer consent, recovery, and result return as acceptance-critical.
- Include tests for both checkbox states, locked input, and literal slash-prefixed append during active tasks.
- Use Pi native editor and theme APIs; component/RPC tests do not replace real terminal acceptance.
- Verify native services on each target OS plus Linux Docker execution; skips and mocks are not passes.
- Require CI for the exact release commit.
<!-- pi-agents-md:end -->
