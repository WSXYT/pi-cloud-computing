import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

test("shell installer guides language, role, IP, Pi reuse, and pairing", async () => {
  const script = await readFile("scripts/install.sh", "utf8");
  assert.match(script, /选择语言 \/ Choose language/);
  assert.match(script, /What do you want to install/);
  assert.match(script, /Found existing Pi/);
  assert.match(script, /api\.ipify\.org/);
  assert.match(script, /pair-command=/);
  assert.match(script, /Copy the complete \/cloud-pair line/);
  assert.match(script, /merge --ff-only FETCH_HEAD/);
  assert.match(script, /client language "\$LANGUAGE"/);
  assert.match(script, /worker health/);
  assert.doesNotMatch(script, /reset --hard|fs\.writeFileSync/);
});

test("PowerShell installer reuses Pi and configures the selected language", async () => {
  const script = await readFile("scripts/install.ps1", "utf8");
  assert.match(script, /Get-Command pi/);
  assert.match(script, /Found existing Pi/);
  assert.match(script, /client language \$Language/);
  assert.doesNotMatch(script, /Set-Content|reset --hard/);
  assert.match(script, /输入 \/cloud/);
});

const exec = promisify(execFile);

test("Bash installer parses and exposes explicit Docker network authorization", async () => {
  await exec("bash", ["-n", "scripts/install.sh"]);
  const { stdout } = await exec("bash", ["scripts/install.sh", "--help"]);
  assert.match(stdout, /--docker-network none\|bridge/);
});

for (const shell of process.platform === "win32" ? ["bash", "powershell"] : ["bash"]) {
  test(`${shell} client installer checks failures and preserves existing sources`, { timeout: 90_000 }, async (t) => {
    // Real installer control flow, with isolated external-command stubs: no downloads, global installs or service changes.
    const root = await mkdtemp(join(tmpdir(), "pi-cloud-installer-"));
    const bin = join(root, "bin");
    const source = join(root, "source");
    const log = join(root, "commands.log");
    await mkdir(bin);
    await mkdir(join(source, ".git"), { recursive: true });
    t.after(() => rm(root, { recursive: true, force: true }));
    const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      PI_CLOUD_SOURCE_DIR: source.replace(/\\/g, "/"), PI_CLOUD_TEST_LOG: log.replace(/\\/g, "/") };
    for (const name of ["node", "npm", "git", "pi"]) {
      await writeFile(join(bin, name), `#!/usr/bin/env bash
printf '%s\\n' '${name} '"$*" >> "$PI_CLOUD_TEST_LOG"
case '${name}: '"$*" in
  'node: -p '*) printf '24\\n' ;;
  'node: --version') printf 'v24.18.1\\n' ;;
  'node: '*client' language '*) [ "$PI_CLOUD_TEST_FAIL" != 'language' ] || exit 9 ;;
  'npm: --version') printf '12.0.2\\n' ;;
  'npm: prefix --global') dirname "$(dirname "$0")" ;;
  'npm: ci --ignore-scripts') [ "$PI_CLOUD_TEST_FAIL" != 'npm-ci' ] || exit 9 ;;
  'npm: run build') [ "$PI_CLOUD_TEST_FAIL" != 'build' ] || exit 9 ;;
  'git: '*status' --porcelain') [ "$PI_CLOUD_TEST_FAIL" != 'dirty' ] || printf ' M local.ts\\n' ;;
  'git: '*fetch' origin main') [ "$PI_CLOUD_TEST_FAIL" != 'fetch' ] || exit 9 ;;
  'git: '*merge' --ff-only FETCH_HEAD') [ "$PI_CLOUD_TEST_FAIL" != 'merge' ] || exit 9 ;;
  'pi: install '*) [ "$PI_CLOUD_TEST_FAIL" != 'pi-install' ] || exit 9 ;;
  *) printf 'Unexpected ${name} invocation\\n' >&2; exit 99 ;;
esac
exit 0
`, { mode: 0o755 });
      await writeFile(join(bin, `${name}.cmd`), `@echo off\r\necho ${name} %*>> "%PI_CLOUD_TEST_LOG%"\r\n` + ({
        node: 'if "%~1"=="-p" (\r\necho 24\r\nexit /b 0\r\n)\r\nif "%~1"=="--version" (\r\necho v24.18.1\r\nexit /b 0\r\n)\r\nif "%PI_CLOUD_TEST_FAIL%"=="language" exit /b 9\r\n',
        npm: 'if "%~1"=="--version" (echo 12.0.2 & exit /b 0)\r\nif "%~1"=="ci" if "%PI_CLOUD_TEST_FAIL%"=="npm-ci" exit /b 9\r\nif "%~1"=="run" if "%PI_CLOUD_TEST_FAIL%"=="build" exit /b 9\r\n',
        git: 'if "%~3"=="status" if "%PI_CLOUD_TEST_FAIL%"=="dirty" echo  M local.ts\r\nif "%~3"=="fetch" if "%PI_CLOUD_TEST_FAIL%"=="fetch" exit /b 9\r\nif "%~3"=="merge" if "%PI_CLOUD_TEST_FAIL%"=="merge" exit /b 9\r\n',
        pi: 'if "%PI_CLOUD_TEST_FAIL%"=="pi-install" exit /b 9\r\n',
      }[name]) + 'exit /b 0\r\n');
    }
    // Fail closed if a version probe/fixture breaks: never fall through to a real package manager or service command.
    for (const name of ["winget", "sudo", "apt-get", "brew", "curl", "docker", "systemctl", "install"]) {
      await writeFile(join(bin, name), `#!/usr/bin/env bash\nprintf '%s\\n' 'BLOCKED ${name}' >> "$PI_CLOUD_TEST_LOG"\nexit 99\n`, { mode: 0o755 });
      await writeFile(join(bin, `${name}.cmd`), `@echo off\r\necho BLOCKED ${name}>> "%PI_CLOUD_TEST_LOG%"\r\nexit /b 99\r\n`);
    }
    const command = shell === "bash" ? "bash" : "powershell.exe";
    const args = shell === "bash" ? ["scripts/install.sh", "--client", "--lang", "en", "--yes"] : ["-NoProfile", "-NonInteractive", "-File", resolve("scripts/install.ps1"), "-Language", "en", "-Role", "client"];
    for (const failure of ["dirty", "fetch", "merge", "npm-ci", "build", "pi-install", "language"]) {
      await writeFile(log, "");
      await assert.rejects(() => exec(command, args, { env: { ...env, PI_CLOUD_TEST_FAIL: failure }, timeout: 15_000 }), `${failure} must fail the installer`);
      const calls = await readFile(log, "utf8");
      assert.doesNotMatch(calls, /BLOCKED/, "the test fixture must not request system changes");
      const stage = { dirty: /git .*status --porcelain/, fetch: /git .*fetch origin main/, merge: /git .*merge --ff-only FETCH_HEAD/,
        "npm-ci": /npm ci/, build: /npm run build/, "pi-install": /pi install/, language: /client language en/ }[failure]!;
      assert.match(calls, stage, "must reach the intended failure, not pass due to an unrelated parser error");
      assert.doesNotMatch(calls, /reset --hard/);
      if (["dirty", "fetch", "merge", "npm-ci", "build"].includes(failure)) assert.doesNotMatch(calls, /pi install/);
      if (failure !== "language") assert.doesNotMatch(calls, /client language/);
    }
    await writeFile(log, "");
    const success = await exec(command, args, { env: { ...env, PI_CLOUD_TEST_FAIL: "" }, timeout: 15_000 });
    assert.match(success.stdout, /Local extension installed/);
    assert.match(success.stdout, /\/cloud/);
    const calls = await readFile(log, "utf8");
    assert.match(calls, /merge --ff-only FETCH_HEAD/);
    assert.match(calls, /client language en/);

    await rm(join(source, ".git"), { recursive: true });
    const sentinel = join(source, "keep.txt");
    await writeFile(sentinel, "user data");
    await assert.rejects(() => exec(command, args, { env, timeout: 15_000 }));
    assert.equal(await readFile(sentinel, "utf8"), "user data", "an existing non-Git directory must never be removed");
  });
}
