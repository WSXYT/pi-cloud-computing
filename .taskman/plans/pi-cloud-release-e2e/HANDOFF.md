# Pi Cloud End-to-End Release

## Goal

Turn the integrated package into a reproducible self-hosted release and prove the full local-to-cloud-to-local workflow across supported client platforms and a Linux Worker.

## Packaging

- One npm package installs the local Pi extension through its `pi` manifest and exposes the `pi-cloud` server CLI through `bin`.
- Pin supported Pi and Node ranges and fail clearly on incompatible versions.
- Package only built runtime files, locale catalogs, service/Docker assets, README/license, and required metadata.
- Add clean-install and tarball allowlist smoke tests with lifecycle scripts disabled where possible.

## Deployment assets

- Provide localized server setup instructions for a raw VPS IP.
- Provide systemd unit generation/installation and uninstall/cleanup commands.
- Provide a Docker image/runner asset with documented resource/network/mount behavior; Docker remains optional and recommended.
- Document required firewall port and certificate fingerprint verification.
- Do not add a web dashboard, domain requirement, hosted relay, telemetry, or sponsor-controlled data path.

## End-to-end matrix

Automate the core scenario against a temporary Linux Worker:

1. Install/launch Worker and generate IP-SAN self-signed TLS.
2. Pair from a client with fingerprint pin and one-time code.
3. Prepare a private dirty Git repository containing tracked, staged, binary, and selected untracked changes.
4. Synchronize a representative Pi environment and one authorized secret without leaking it to logs/artifacts.
5. Submit a persisted Pi session and task.
6. Stream events, send a follow-up while Pi is running, disconnect/reconnect, and complete.
7. Review/apply the returned patch/ref and switch to the synthesized native session.
8. Verify original local edits remain, remote changes are present, native session context resumes, results persist until cleanup, and revoke/cleanup work.

Run local extension unit tests on Windows, Linux, and macOS CI where available. Run Worker/systemd/Docker tests on Linux; document any CI-only skips.

## Documentation

- Chinese and English README sections for architecture, requirements, install, pairing, commands, runner choice, synchronization categories, secret handling, recovery, cleanup, and troubleshooting.
- Explain that Docker requires Docker but provides the safer isolation boundary; host mode grants Pi the service account's permissions.
- Explain self-signed certificate pinning, IP changes/rotation, and why TLS verification must not be disabled.
- Explain Git-only v1 behavior, result refs/patches, session replacement/provenance, compatibility warnings, and retention selection.
- Reserve a clearly marked sponsor metadata/config location with no real sponsor values required for release.

## Release gates

Typecheck, unit/integration/e2e tests, package smoke install, secret scan, dependency audit, and clean working-tree artifact check must pass. Record unsupported cases explicitly: non-Git workspaces, managed multi-tenant control plane, browser UI, automatic VPS provisioning, and seamless platform-specific binary/plugin translation.
