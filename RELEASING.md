# Release checklist

Use Node 24. Never publish from an unverified working tree.

1. Run `npm ci`, `npm run check`, `npm test`, `npm run pack:smoke` and `npm audit --omit=dev`.
   The package smoke test packs a real tarball, installs it in a fresh consumer, checks deployment assets and the CLI, registers it with Pi, and checks commands over real Pi RPC. It does not use the user's Pi profile or credentials.
2. Push a candidate branch and require every CI job to pass for that exact commit:
   - Windows/macOS/Linux client flows and package installation/loading;
   - real Linux Worker execution with provider, skill, tool, UI response, credential cleanup, Git apply and native session merge;
   - the same real execution through the production Docker bootstrap/image;
   - non-root sudo installation, systemd health, restart and stop for both host and Docker.
   `scripts/ci-install-worker.sh` deliberately changes services/global packages and refuses to run outside ephemeral GitHub Linux runners. Do not run it on a VPS or development machine.
3. Review the diff for credentials/unintended assets, synchronize managed `AGENTS.md`, and merge the passing candidate into `main` without changing its contents. The one-command installers fetch `main`.
4. Confirm the npm version is not already published. Authenticate locally with `npm login --registry=https://registry.npmjs.org`; never paste tokens into issues or chat. Publish with `npm publish --access public` only after the preceding gates pass. Account/2FA failures require the owner; do not weaken authentication.
5. Tag the released commit `v<package.json version>`. Alternatively, with npm Trusted Publishing configured for `release.yml` or `NPM_TOKEN` stored in the protected `npm` GitHub environment, run **Publish npm release** on that exact tag. It reruns CI and refuses a mismatched/non-tag ref. Do not publish the same version twice.
6. Verify registry metadata, `pi-package` keyword, tarball contents and `pi install npm:pi-cloud-computing@<version>` in an isolated profile. Confirm the package is discoverable via npm; Pi gallery indexing is external and may lag. Record the commit, CI URL, npm URL and any remaining indexing delay.

## Public endpoints

Only `GET /health` (boolean readiness/protocol version) and `POST /pair` (one-time code exchange) are public. Pairing is limited to 4 KiB and 60 attempts per Worker per minute; other HTTP and WebSocket operations require a revocable bearer token. Production clients validate the pinned certificate before sending request data. HTTP/WS errors do not return raw filesystem/parser exception text.
