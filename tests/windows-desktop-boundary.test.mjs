// SOURCE CANDIDATE: inert tests only. No account/profile bootstrap or download.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, open, readFile, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const repo = fileURLToPath(new URL('../', import.meta.url));
const shell = () => path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const clean = root => Object.fromEntries([
  ...['SystemRoot','WINDIR','PATH','COMSPEC','USERPROFILE','LOCALAPPDATA','APPDATA','USERNAME','USERDOMAIN','PROGRAMDATA','PROGRAMFILES']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]),
  // Classic PowerShell must resolve its own modules, matching the CI native lane.
  ['PSModulePath', path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules')],
  ['TEMP',root],['TMP',root],
]);
async function owned(file, args, env, deadlineMs = 15000) {
  const child = spawn(file, args, { env, cwd: repo, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  let terminal = false, bytes = 0, overflow = false;
  const chunks = { stdout: [], stderr: [] };
  for (const name of Object.keys(chunks)) child[name].on('data', part => {
    bytes += part.length;
    if (bytes > 32768) { overflow = true; child.kill(); } else chunks[name].push(part);
  });
  const exited = new Promise(resolve => {
    child.once('exit', code => { terminal = true; resolve(code); });
    child.once('error', () => { terminal = true; resolve(null); });
  });
  const closed = new Promise(resolve => child.once('close', resolve));
  async function within(promise, ms) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('inert boundary terminal/EOF unconfirmed; scratch retained')), ms);
    })]); } finally { clearTimeout(timer); }
  }
  try {
    const code = await within(exited, deadlineMs); await within(closed, 5000);
    assert.equal(overflow, false);
    return { code, stdout: Buffer.concat(chunks.stdout), stderr: Buffer.concat(chunks.stderr) };
  } finally {
    if (!terminal) child.kill();
    await within(exited, 5000); await within(closed, 5000);
  }
}
const args = script => ['-NoLogo','-NoProfile','-NonInteractive','-File',path.join(repo, script)];
async function scratch(t, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.diagnostic(`Retained scratch: ${root}`); return root;
}
test('desktop shared native filesystem/ACL checks use owned scratch and preserve sibling', {
  skip: process.platform !== 'win32', timeout: 180000,
}, async t => {
  const root = await scratch(t, 'comms-desktop-boundary-');
  const result = await owned(shell(), [...args('tests/windows-desktop-filesystem-native.ps1'), '-Root', root], clean(root), 150000);
  if (result.code !== 0) {
    let detail = { kind: 'filesystem-receipt-unavailable', stderrPresent: result.stderr.length > 0 };
    try {
      const file = await open(path.join(root, 'filesystem.json'), 'r');
      const evidence = Buffer.alloc(4097);
      let bytesRead;
      try { ({ bytesRead } = await file.read(evidence, 0, evidence.length, 0)); } finally { await file.close(); }
      if (bytesRead <= 4096) {
        const record = JSON.parse(evidence.subarray(0, bytesRead).toString('utf8'));
        const token = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value) ? value : 'invalid';
        detail = { kind: 'filesystem-native-failed', stage: token(record.failure?.stage),
          exceptionType: token(record.failure?.exceptionType),
          hresult: Number.isSafeInteger(record.failure?.hresult) ? record.failure.hresult : null,
          completedCases: Array.isArray(record.cases) && record.cases.length <= 32 ? record.cases.map(token) : [] };
      }
    } catch { /* Missing or invalid evidence remains a fixed refusal. */ }
    assert.fail(JSON.stringify(detail));
  }
  assert.equal(result.code, 0);
  const bytes = await readFile(path.join(root, 'filesystem.json')); assert.ok(bytes.length <= 4096);
  const receipt = JSON.parse(bytes.toString('utf8'));
  assert.deepEqual(Object.keys(receipt).sort(), ['cases','failure','downloadInvoked','profileAttested','rootRetained','status','v'].sort());
  assert.equal(receipt.v, 1); assert.equal(receipt.status, 'passed'); assert.equal(receipt.failure, null);
  assert.equal(receipt.rootRetained, true); assert.equal(receipt.profileAttested, false); assert.equal(receipt.downloadInvoked, false);
  assert.deepEqual(receipt.cases, ['exact-acl-and-held-chain','relative-root-placement','oversized-root-placement','wrong-root-basename','wrong-root-anchor','held-leaf-rename-refused','held-ancestor-rename-refused',
    'held-leaf-delete-refused','released-leaf-rename-works','released-ancestor-rename-works','wrong-expected-owner',
    'extra-ace','weaker-rights','wrong-inheritance','wrong-propagation','deny-ace','unprotected-dacl',
    'fresh-acl-change-refused','root-junction','root-junction-failure-releases-handle','ancestor-junction','partial-chain-failure-releases-leaf',
    'file-not-directory','file-failure-releases-handle','sibling-content-and-acl-unchanged']);
});
for (const [label, github, disposable] of [
  ['both missing', undefined, undefined], ['CI marker only', 'true', undefined],
  ['disposable marker only', undefined, '1'], ['invalid CI marker', 'false', '1'],
  ['invalid disposable marker', 'true', '0'],
]) test(`original CI bootstrap refuses ${label} before staging or account operations`, {
  skip: process.platform !== 'win32', timeout: 30000,
}, async t => {
  const root = await scratch(t, 'comms-ci-marker-refusal-');
  const sentinel = path.join(root, 'sentinel.txt'); await writeFile(sentinel, 'unchanged');
  const env = clean(root);
  if (github !== undefined) env.GITHUB_ACTIONS = github;
  if (disposable !== undefined) env.AGENT_COMMS_DISPOSABLE_WINDOWS = disposable;
  // No case supplies both valid markers; the original guard precedes all
  // account/stage operations. No disposable claim is made about this account.
  const result = await owned(shell(), [...args('scripts/windows-acceptance-user.ps1'), '-Report', path.join(root, 'report.json'), '-Mode', 'candidate-compiler'], env);
  assert.equal(result.code, 1); assert.match(result.stderr.toString('utf8'), /Disposable GitHub Windows runner required/);
  assert.deepEqual(await readdir(root), ['sentinel.txt']); assert.equal(await readFile(sentinel, 'utf8'), 'unchanged');
});
for (const [label, profile, disposable] of [
  ['both missing', undefined, undefined], ['profile marker only', '1', undefined],
  ['disposable marker only', undefined, '1'], ['invalid profile marker', '0', '1'],
  ['invalid disposable marker', '1', '0'],
]) test(`original Node CI path refuses ${label} without output or workload`, {
  skip: process.platform !== 'win32', timeout: 30000,
}, async t => {
  const root = await scratch(t, 'comms-node-marker-refusal-');
  const env = clean(root);
  if (profile !== undefined) env.AGENT_COMMS_CAPACITY_PROFILE_VERIFIED = profile;
  if (disposable !== undefined) env.AGENT_COMMS_DISPOSABLE_WINDOWS = disposable;
  const result = await owned(process.execPath, [path.join(repo, 'tools/acceptance/windows-connector-capacity.mjs')], env);
  assert.equal(result.code, 1); assert.equal(result.stdout.length, 0);
  const failure = JSON.parse(result.stderr.toString('utf8'));
  assert.equal(failure.status, 'failed'); assert.deepEqual(await readdir(root), []);
});
test('unchanged CI child refuses mismatched SID before cloning or marker issuance', {
  skip: process.platform !== 'win32', timeout: 30000,
}, async t => {
  const root = await scratch(t, 'comms-ci-child-refusal-');
  await mkdir(path.join(root, 'results'));
  const original = await readFile(path.join(repo, 'scripts/windows-acceptance-child.ps1'));
  const copied = path.join(root, 'child.ps1'); await writeFile(copied, original, { flag: 'wx' });
  await writeFile(path.join(root, 'inputs.json'), JSON.stringify({ sid: 'S-1-0-0', mode: 'candidate-compiler' }), { flag: 'wx' });
  const result = await owned(shell(), ['-NoLogo','-NoProfile','-NonInteractive','-File',copied], clean(root));
  assert.equal(result.code, 1); assert.deepEqual(await readFile(copied), original);
  const text = (await readFile(path.join(root, 'results/bootstrap.json'), 'utf8')).replace(/^\uFEFF/, '');
  const receipt = JSON.parse(text);
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.failure.gate, 'validate-profile-token');
  assert.equal(receipt.interactiveTaskGate, 'not-reached');
  assert.deepEqual((await readdir(root)).sort(), ['child.ps1','inputs.json','results']);
  assert.deepEqual(await readdir(path.join(root, 'results')), ['bootstrap.json']);
});
