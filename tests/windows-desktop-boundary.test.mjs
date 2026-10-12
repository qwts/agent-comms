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
  let terminal = false, bytes = 0, overflow = false, eof = false, processExit = null, processExited = false, spawnError = false, failure;
  const state = { terminal: false, eof: false, exitCode: null, killRequested: false, cleanupTerminal: false, cleanupEof: false, processExited: false, spawnError: false, killAccepted: null, stdoutBytes: 0, stderrBytes: 0, cleanupStdoutBytes: 0, cleanupStderrBytes: 0 };
  const chunks = { stdout: [], stderr: [] };
  const byteCounts = { stdout: 0, stderr: 0 };
  for (const name of Object.keys(chunks)) child[name].on('data', part => {
    bytes += part.length; byteCounts[name] += part.length;
    if (bytes > 32768) { overflow = true; child.kill(); } else chunks[name].push(part);
  });
  const exited = new Promise(resolve => {
    child.once('exit', code => { terminal = true; processExited = true; processExit = code; resolve(code); });
    child.once('error', () => { terminal = true; spawnError = true; resolve(null); });
  });
  const closed = new Promise(resolve => child.once('close', code => { eof = true; resolve(code); }));
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
  } catch (error) {
    failure = error; error.ownedState = state;
    state.terminal = terminal; state.eof = eof; state.exitCode = processExit;
    state.stdoutBytes = byteCounts.stdout; state.stderrBytes = byteCounts.stderr;
    throw error;
  } finally {
    if (!terminal) { state.killRequested = true; try { state.killAccepted = child.kill(); } catch { state.killAccepted = false; } }
    try { await within(exited, 5000); await within(closed, 5000); }
    catch (error) { if (!failure) { error.ownedState = state; throw error; } }
    finally { state.cleanupTerminal = processExited; state.cleanupEof = eof; state.processExited = processExited; state.spawnError = spawnError; state.cleanupStdoutBytes = byteCounts.stdout; state.cleanupStderrBytes = byteCounts.stderr; }
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
          exceptionType: token(record.failure?.exceptionType), code: token(record.failure?.code),
          probe: record.probe && typeof record.probe === 'object' ? Object.fromEntries(
            ['substage','terminal','eof','exitCode','stdoutLength','stderrLength','moved','killRequested','cleanupTerminal'].map(key => {
              const value = record.probe[key];
              return [key, key === 'substage' ? token(value) : value === null || typeof value === 'boolean' || Number.isSafeInteger(value) ? value : null];
            })) : null,
          hresult: Number.isSafeInteger(record.failure?.hresult) ? record.failure.hresult : null,
          completedCases: Array.isArray(record.cases) && record.cases.length <= 32 ? record.cases.map(token) : [] };
      }
    } catch { /* Missing or invalid evidence remains a fixed refusal. */ }
    assert.fail(JSON.stringify(detail));
  }
  assert.equal(result.code, 0);
  const bytes = await readFile(path.join(root, 'filesystem.json')); assert.ok(bytes.length <= 4096);
  const receipt = JSON.parse(bytes.toString('utf8'));
  assert.deepEqual(Object.keys(receipt).sort(), ['cases','failure','probe','downloadInvoked','profileAttested','rootRetained','status','v'].sort());
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
  let result;
  // The same inclusive owned deadline covers fixed native imports and original child.
  try { result = await owned(shell(), [...args('tests/windows-desktop-sid-launcher.ps1'), '-Child', copied], clean(root)); }
  catch (error) {
    const evidence = { kind: 'ci-child-terminal-unconfirmed', owned: error.ownedState ?? null, receipt: 'unavailable' };
    try {
      const file = await open(path.join(root, 'results/bootstrap.json'), 'r');
      const bytes = Buffer.alloc(4097); let bytesRead;
      try { ({ bytesRead } = await file.read(bytes, 0, bytes.length, 0)); } finally { await file.close(); }
      if (bytesRead <= 4096) {
        const record = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, ''));
        evidence.receipt = { failed: record.status === 'failed', profileTokenGate: record.failure?.gate === 'validate-profile-token',
          interactiveNotReached: record.interactiveTaskGate === 'not-reached' };
      }
    } catch { /* Never infer receipt absence or cleanup from unavailable evidence. */ }
    assert.fail(JSON.stringify(evidence));
  }
  assert.equal(result.code, 1); assert.deepEqual(await readFile(copied), original);
  const text = (await readFile(path.join(root, 'results/bootstrap.json'), 'utf8')).replace(/^\uFEFF/, '');
  const receipt = JSON.parse(text);
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.failure.gate, 'validate-profile-token');
  assert.equal(receipt.interactiveTaskGate, 'not-reached');
  assert.deepEqual((await readdir(root)).sort(), ['child.ps1','inputs.json','results']);
  assert.deepEqual(await readdir(path.join(root, 'results')), ['bootstrap.json']);
});
// Debugger timing is diagnostic only. The direct unchanged SID test above is
// still the acceptance predicate and keeps its original deadline.
test('diagnostic-only copied SID stage localization', {
  skip: process.platform !== 'win32', timeout: 30000,
}, async t => {
  const root = await scratch(t, 'comms-ci-child-diagnostic-');
  await mkdir(path.join(root, 'results'));
  const original = await readFile(path.join(repo, 'scripts/windows-acceptance-child.ps1'));
  const copied = path.join(root, 'child.ps1'); await writeFile(copied, original, { flag: 'wx' });
  await writeFile(path.join(root, 'inputs.json'), JSON.stringify({ sid: 'S-1-0-0', mode: 'candidate-compiler' }), { flag: 'wx' });
  const stage = path.join(root, 'stages.txt');
  const evidence = { kind: 'diagnostic-only-sid-stages', acceptanceSubstitute: false, completed: false, owned: null, stages: [] };
  try {
    const result = await owned(shell(), [...args('tests/windows-desktop-sid-diagnostic.ps1'), '-Child', copied, '-Stage', stage], clean(root));
    evidence.completed = true; evidence.exitCode = result.code;
  } catch (error) { evidence.owned = error.ownedState ?? null; }
  try {
    const file = await open(stage, 'r'); const bytes = Buffer.alloc(2049); let bytesRead;
    try { ({ bytesRead } = await file.read(bytes, 0, bytes.length, 0)); } finally { await file.close(); }
    if (bytesRead <= 2048) {
      const stages = bytes.subarray(0, bytesRead).toString('utf8').trim().split(/\r?\n/);
      const phases = ['input-parse','identity','sid-compare','catch','receipt','exit'];
      const allowed = new Set(['driver-start','source-read','breakpoints-ready', ...phases,
        ...phases.map(value => `install-${value}`), ...phases.map(value => `installed-${value}`)]);
      if (stages.length <= 32 && stages.every(value => allowed.has(value))) evidence.stages = stages;
    }
  } catch { /* Unavailable stage evidence never supplies an inferred phase. */ }
  assert.deepEqual(await readFile(copied), original);
  t.diagnostic(JSON.stringify(evidence));
});

// Isolate the original child's first cmdlet without debugger instrumentation.
for (const mode of ['autoload','management-import','utility-import']) test(`diagnostic-only classic module boundary: ${mode}`, {
  skip: process.platform !== 'win32', timeout: 30000,
}, async t => {
  const root = await scratch(t, 'comms-ci-content-diagnostic-');
  await writeFile(path.join(root, 'inputs.json'), JSON.stringify({ sid: 'S-1-0-0', mode: 'candidate-compiler' }), { flag: 'wx' });
  const stage = path.join(root, 'stages.txt');
  const evidence = { kind: 'diagnostic-only-classic-module', mode, acceptanceSubstitute: false, completed: false, owned: null, stages: [] };
  try {
    const result = await owned(shell(), [...args('tests/windows-desktop-content-diagnostic.ps1'), '-Root', root, '-Mode', mode], clean(root));
    evidence.completed = true; evidence.exitCode = result.code;
  } catch (error) { evidence.owned = error.ownedState ?? null; }
  try {
    const file = await open(stage, 'r'); const bytes = Buffer.alloc(257); let bytesRead;
    try { ({ bytesRead } = await file.read(bytes, 0, bytes.length, 0)); } finally { await file.close(); }
    if (bytesRead <= 256) {
      const stages = bytes.subarray(0, bytesRead).toString('utf8').trim().split(/\r?\n/);
      if (stages.length <= 6 && stages.every(value => ['content-start','import-start','import-complete','command-start','command-complete','content-complete'].includes(value))) evidence.stages = stages;
    }
  } catch { /* No inferred progress from unavailable evidence. */ }
  t.diagnostic(JSON.stringify(evidence));
});

test('desktop downloader shared transfer uses deterministic responses and owned files', {
  skip: process.platform !== 'win32', timeout: 180000,
}, async t => {
  const root = await scratch(t, 'comms-desktop-download-');
  const result = await owned(shell(), [...args('tests/windows-desktop-downloader-native.ps1'), '-Root', root], clean(root), 150000);
  const file = await open(path.join(root, 'downloader.json'), 'r');
  const bytes = Buffer.alloc(4097); let bytesRead;
  try { ({ bytesRead } = await file.read(bytes, 0, bytes.length, 0)); } finally { await file.close(); }
  assert.ok(bytesRead <= 4096);
  const receipt = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, ''));
  const token = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value) ? value : 'invalid';
  assert.equal(result.code, 0, JSON.stringify({ stage: token(receipt.failure?.stage),
    exceptionType: token(receipt.failure?.exceptionType),
    hresult: Number.isSafeInteger(receipt.failure?.hresult) ? receipt.failure.hresult : null }));
  assert.deepEqual(receipt, { v: 1, status: 'passed', cases: [
    'normal-proof-entrypoint-absent','success-known-length','success-unknown-length',
    'success-exact-cap','invalid-negative-length-refused',
    'status-refused','encoding-refused','declared-zero-refused','declared-over-cap-refused',
    'empty-unknown-refused','short-body-refused','long-body-refused','read-failure-deleted',
    'unknown-over-cap-deleted','create-new-collision-preserved','sibling-preserved',
  ], failure: null, networkInvoked: false, rootRetained: true, nativeCloseProven: false, httpAbortProven: false });
});
