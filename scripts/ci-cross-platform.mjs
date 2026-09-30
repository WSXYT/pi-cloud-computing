import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createGitSnapshot, createGitResultSnapshot, createWorkspaceArchive, materializeWorkspaceArchive, parseWorkspaceArchive, serializeWorkspaceArchive, snapshotDigest, validateGitSnapshot } from '../dist/src/git.js';
import { applyGitSnapshot } from '../dist/src/result.js';
import { mergeSessionTail, parseSessionArchive, serializeSessionArchive } from '../dist/src/session.js';

const [mode, directory] = process.argv.slice(2);
assert.ok(['produce', 'verify'].includes(mode) && directory);
const root = await mkdtemp(join(tmpdir(), 'pi-cloud-cross-'));
const git = (cwd, ...args) => promisify(execFile)('git', args, { cwd });
const archive = entries => parseSessionArchive(entries.map(value => JSON.stringify(value)).join('\n') + '\n');
try {
  if (mode === 'produce') {
    const cwd = join(root, 'repo');
    await mkdir(cwd);
    for (const args of [['init', '-q'], ['config', 'core.autocrlf', 'false'], ['config', 'user.name', 'Cross-platform fixture'], ['config', 'user.email', 'test@example.com']]) await git(cwd, ...args);
    await writeFile(join(cwd, '文件.txt'), 'before\n');
    await writeFile(join(cwd, 'binary.dat'), Buffer.from([0, 255, 13, 10, 128]));
    await git(cwd, 'add', '.');
    await git(cwd, 'commit', '-qm', 'baseline');
    const workspace = await createWorkspaceArchive(cwd);
    await writeFile(join(cwd, '文件.txt'), `after ${process.platform}\n`);
    const result = await createGitResultSnapshot(cwd, workspace.snapshot.baseline, workspace.snapshot);
    const header = { type: 'session', version: 3, id: `cross-${process.platform}`, timestamp: new Date().toISOString(), cwd };
    const submitted = archive([header, { type: 'custom', id: 'base', parentId: null, timestamp: header.timestamp, customType: 'cross-test', data: 'submitted' }]);
    const remote = archive([header, ...submitted.entries, { type: 'custom', id: 'remote', parentId: 'base', timestamp: header.timestamp, customType: 'cross-test', data: `result ${process.platform}` }]);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${process.platform}.json`), JSON.stringify({ platform: process.platform, workspace: serializeWorkspaceArchive(workspace), result, submitted: serializeSessionArchive(submitted), remote: serializeSessionArchive(remote) }));
  } else {
    const files = (await readdir(directory)).filter(file => file.endsWith('.json'));
    assert.equal(files.length, 3, 'Windows, macOS and Linux artifacts are all required');
    for (const file of files) {
      const fixture = JSON.parse(await readFile(join(directory, file), 'utf8'));
      const workspace = parseWorkspaceArchive(fixture.workspace);
      const cwd = join(root, fixture.platform);
      await materializeWorkspaceArchive(workspace, cwd);
      assert.deepEqual(await readFile(join(cwd, 'binary.dat')), Buffer.from([0, 255, 13, 10, 128]));
      const local = await createGitSnapshot(cwd);
      for (const key of ['head', 'indexHash', 'worktreeHash']) assert.equal(local.baseline[key], fixture.result.baseline[key]);
      // The consumer is a new CI checkout, not the sender's absolute path. Rebind only
      // this fixture's repository identity, after checking every content baseline.
      validateGitSnapshot(fixture.result);
      const rebound = { ...fixture.result, baseline: local.baseline };
      rebound.snapshotSha256 = snapshotDigest(rebound);
      await applyGitSnapshot(cwd, rebound);
      assert.equal(await readFile(join(cwd, '文件.txt'), 'utf8'), `after ${fixture.platform}\n`);
      const submitted = parseSessionArchive(fixture.submitted);
      const remote = parseSessionArchive(fixture.remote);
      const merged = mergeSessionTail(submitted, remote, { sessionId: submitted.header.id, baseLeafId: submitted.leafId, lastEntryId: submitted.leafId, entriesSha256: submitted.entriesSha256 });
      assert.deepEqual(merged.entries.map(entry => entry.id), ['base', 'remote']);
      console.log(`PASS artifact compatibility: ${fixture.platform} -> ${process.platform}; Unicode/binary files, guarded result apply, native session tail`);
    }
  }
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
