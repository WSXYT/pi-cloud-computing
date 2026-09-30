import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, platform, release } from 'node:os';
import { basename, delimiter, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

// System service installation belongs ONLY on disposable CI hosts, never a developer machine.
if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Disposable GitHub runner required');
const exec = promisify(execFile);
const root = await mkdtemp(join(process.env.RUNNER_TEMP, 'pi-cloud-native-'));
const source = resolve('.');
const cli = join(source, 'dist/src/cli.js');
const env = { ...process.env, PI_CLOUD_SOURCE_DIR: source, PI_CLOUD_DATA_DIR: join(root, 'worker'), PI_CLOUD_CLIENT_STATE: join(root, 'client.json'), PI_CODING_AGENT_DIR: join(root, 'client-agent'), PATH: `${join(source, 'node_modules', '.bin')}${delimiter}${process.env.PATH}` };
const run = async (command, args) => {
  const label = command === process.execPath ? args.slice(1, 3).join(' ') : basename(command);
  console.log(`START ${label}`);
  const pending = exec(command, args, { env, timeout: command === 'powershell.exe' || command === 'bash' || args.includes('--test') ? 180_000 : 30_000, maxBuffer: 8 * 1024 * 1024 });
  pending.child.stdin?.end();
  const result = await pending;
  console.log(`DONE ${label}`);
  return result;
};
const cloud = (...args) => run(process.execPath, [cli, ...args]);
const health = async (expected) => {
  for (let attempt = 0; attempt < 30; attempt++) {
    const ok = await cloud('worker', 'health').then(() => true, () => false);
    if (ok === expected) return;
    await delay(1000);
  }
  throw new Error(`Worker health did not become ${expected}`);
};
try {
  console.log(`Native service acceptance: ${platform()} ${release()}, Node ${process.version}, commit ${process.env.GITHUB_SHA}`);
  if (process.platform === 'win32') {
    await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(source, 'scripts/install.ps1'), '-Role', 'worker', '-Language', 'en', '-Ip', '127.0.0.1', '-Revision', process.env.GITHUB_SHA]);
  } else {
    await run('bash', [join(source, 'scripts/install.sh'), '--worker', '--lang', 'en', '--ip', '127.0.0.1', '--runner', 'host', '--yes', '--revision', process.env.GITHUB_SHA]);
  }
  // The installer process has exited. Only the native service manager can keep this Worker alive.
  await health(true);
  const before = JSON.parse((await cloud('worker', 'status')).stdout);
  const { stdout } = await cloud('worker', 'pair');
  const pairLine = stdout.split(/\r?\n/).find(line => line.startsWith('pair-command=/cloud-pair '));
  assert.ok(pairLine, 'Missing complete pairing command');
  const args = pairLine.slice('pair-command=/cloud-pair '.length).split(' ');
  assert.ok(stdout.includes('client-command-posix=') && stdout.includes('client-command-powershell='), 'Both verified one-click commands are required');
  assert.ok(stdout.includes(process.env.GITHUB_SHA), 'Installer commands must pin this exact commit');
  if (process.platform === 'win32') {
    await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(source, 'scripts/install.ps1'), '-Role', 'client', '-Language', 'en', '-PairUrl', args[0], '-Fingerprint', args[1], '-Code', args[2], '-Revision', process.env.GITHUB_SHA]);
  } else {
    await run('bash', [join(source, 'scripts/install.sh'), '--client', '--lang', 'en', '--yes', '--pair-url', args[0], '--fingerprint', args[1], '--code', args[2], '--revision', process.env.GITHUB_SHA]);
  }
  await cloud('client', 'pair', ...args); // Used code must not be redeemed twice.
  const client = JSON.parse(await readFile(env.PI_CLOUD_CLIENT_STATE, 'utf8'));
  assert.equal(client.connections.length, 1);
  assert.equal(client.activeWorkerId, before.workerId);
  env.PI_CLOUD_TEST_SERVICE_URL = args[0];
  env.PI_CLOUD_TEST_SERVICE_DIR = env.PI_CLOUD_DATA_DIR;
  console.log((await run(process.execPath, ['--test', '--test-name-pattern=real Worker Pi', join(source, 'dist/test/client-native.test.js')])).stdout);
  delete env.PI_CLOUD_TEST_SERVICE_URL;
  delete env.PI_CLOUD_TEST_SERVICE_DIR;
  if (process.platform === 'linux') await run('sudo', ['systemctl', 'stop', 'pi-cloud-worker.service']);
  else await cloud('worker', 'stop');
  await health(false);
  if (process.platform === 'linux') await run('sudo', ['systemctl', 'start', 'pi-cloud-worker.service']);
  else await cloud('worker', 'start');
  await health(true);
  assert.equal(JSON.parse((await cloud('worker', 'status')).stdout).workerId, before.workerId);
  await cloud('client', 'pair', ...args);
  console.log('PASS: installer exit, native background health, pairing/repeat, real task/tool/dialog/result return, credential cleanup, stop, restart, identity preservation');
} catch (error) {
  console.error(await readFile(join(env.PI_CLOUD_DATA_DIR, 'worker.log'), 'utf8').catch(error => `Worker log unavailable: ${error.code ?? 'READ_FAILED'}`));
  if (process.platform === 'darwin') console.error((await run('launchctl', ['print', `gui/${process.getuid()}/com.wsxyt.pi-cloud-worker`]).catch(e => ({ stdout: e.message }))).stdout);
  if (process.platform === 'win32') console.error((await run('schtasks.exe', ['/Query', '/TN', 'PiCloudWorker', '/V', '/FO', 'LIST']).catch(e => ({ stdout: e.message }))).stdout);
  if (process.platform === 'win32') {
    console.error((await run('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json"]).catch(e => ({ stdout: e.message }))).stdout);
    console.error((await run('powershell.exe', ['-NoProfile', '-Command', "Get-ChildItem -LiteralPath $env:PI_CLOUD_DATA_DIR -Force | Select-Object Name,Length | ConvertTo-Json"]).catch(e => ({ stdout: e.message }))).stdout);
  }
  throw error;
} finally {
  if (process.platform === 'linux') {
    await run('sudo', ['systemctl', 'stop', 'pi-cloud-worker.service']).catch(() => {});
    await run('sudo', ['rm', '-f', '/etc/systemd/system/pi-cloud-worker.service']);
    await run('sudo', ['systemctl', 'daemon-reload']);
  } else if (process.platform === 'darwin') {
    await cloud('worker', 'stop').catch(() => {});
    await rm(join(homedir(), 'Library/LaunchAgents/com.wsxyt.pi-cloud-worker.plist'), { force: true });
  } else {
    await cloud('worker', 'stop').catch(() => {});
    await run('schtasks.exe', ['/Delete', '/TN', 'PiCloudWorker', '/F']).catch(() => {});
  }
  await rm(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
}
