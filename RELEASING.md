# Release checklist

Use Node 24. Never publish from an unverified working tree.

1. Run `npm ci`, `npm run check`, `npm test`, `npm run pack:smoke` and `npm audit --omit=dev`.
   The package smoke test packs a real tarball, installs it in a fresh consumer, checks deployment assets and the CLI, registers it with Pi, and checks commands over real Pi RPC. It does not use the user's Pi profile or credentials.
2. Push a candidate branch and require every CI job to pass for that exact commit. The `minimum-pi` matrix checks Pi 0.85.1 on all three systems; the client/service/Docker matrices use the current development/build version (1.0.0). Both version lanes must pass; a minimum-version policy does not promise every future SDK is compatible:
   - Windows/macOS/Linux client flows, real PTY/ConPTY input and package installation/loading;
   - each platform's installed native service: installer exits, background health, pairing, real Pi provider/skill/tool/dialog execution, credential cleanup, Git apply/native session merge, stop, restart and identity preservation;
   - all nine source/destination artifact-compatibility combinations for Unicode/binary Git files and native session tails;
   - the same real execution through the production Docker bootstrap/image;
   - non-root sudo installation, systemd health, restart and stop for both host and Docker.
   `scripts/ci-native-service.mjs` and `scripts/ci-install-worker.sh` deliberately change services/global packages and refuse to run outside disposable GitHub runners. Do not run them on a VPS or development machine. See `ACCEPTANCE.md` for scope; synthetic model replies do not replace real Pi/OS execution, and artifact compatibility does not claim WAN connectivity testing.
3. Review the diff for credentials/unintended assets, synchronize managed `AGENTS.md`, and merge the passing candidate into `main` without changing its contents. The one-command installers fetch `main`.
4. Confirm the npm version is not already published. Authenticate locally with `npm login --registry=https://registry.npmjs.org`; never paste tokens into issues or chat. Publish with `npm publish --access public` only after the preceding gates pass. Account/2FA failures require the owner; do not weaken authentication.
5. Tag the released commit `v<package.json version>`. Alternatively, with npm Trusted Publishing configured for `release.yml` or `NPM_TOKEN` stored in the protected `npm` GitHub environment, run **Publish npm release** on that exact tag. It reruns CI and refuses a mismatched/non-tag ref. Do not publish the same version twice.
6. Verify registry metadata, `pi-package` keyword, tarball contents and `pi install npm:pi-cloud-computing@<version>` in an isolated profile. Confirm the package is discoverable via npm; Pi gallery indexing is external and may lag. Record the commit, CI URL, npm URL and any remaining indexing delay.

## Public endpoints

Only `GET /health` (boolean readiness/protocol version) and `POST /pair` (one-time code exchange) are public. Pairing is limited to 4 KiB and 60 attempts per Worker per minute; other HTTP and WebSocket operations require a revocable bearer token. Production clients validate the pinned certificate before sending request data. HTTP/WS errors do not return raw filesystem/parser exception text.
