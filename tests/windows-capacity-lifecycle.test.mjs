import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanupCapacityRun, retainCapacityFailure } from '../tools/acceptance/windows-capacity-lifecycle.mjs';

function owned({ terminal = true, closed = true, killedCloses = false } = {}) {
  let resolveExit, resolveClose, live = !terminal, kills = 0;
  const exited = new Promise(resolve => { resolveExit = resolve; });
  const stdioClosed = new Promise(resolve => { resolveClose = resolve; });
  if (terminal) resolveExit({ code: 0 });
  if (closed) resolveClose();
  return { exited, stdioClosed, terminal: () => !live, kills: () => kills,
    child: { stdin: { end() {} }, kill() { kills++; if (killedCloses) { live = false; resolveExit({ code: 0 }); resolveClose(); } } } };
}
function setup(fixture = owned(), supervisor = owned()) {
  const receipt = { jobEmptyConfirmed: false, scratchRemoved: false };
  let removed = false;
  return { fixture, supervisor, attached: true, disposed: false, receipt, timeoutMs: 5,
    closeJob: async () => { receipt.jobEmptyConfirmed = true; },
    removeScratch() { removed = true; }, removed: () => removed };
}
test('failed production startup retains its original boundary and confirmed owned cleanup without raw Error data', async () => {
  const inputs = setup(), cleanup = await cleanupCapacityRun(inputs);
  const original = { stage: 'production-startup', check: 'control-deadline', supervisorPhase: 'private-job-assigned',
    message: 'CANARY-secret-body-path', cause: new Error('CANARY-private-cause') };
  const report = retainCapacityFailure(original, { revision: 'old', preflight: 'normal', fixturePhase: 'fixture-pair' }, cleanup);
  assert.equal(report.stage, 'production-startup'); assert.equal(report.check, 'control-deadline');
  assert.equal(report.fixturePhase, 'fixture-pair'); assert.equal(report.preflight, 'normal');
  assert.equal(cleanup.jobEmptyConfirmed, true); assert.equal(cleanup.scratchRemoved, true);
  for (const key of ['fixtureOwnedTerminalConfirmed','fixtureStdioClosedConfirmed','supervisorOwnedTerminalConfirmed','supervisorStdioClosedConfirmed']) assert.equal(cleanup[key], true);
  assert.equal(inputs.removed(), true); assert.equal(inputs.fixture.kills(), 0); assert.equal(inputs.supervisor.kills(), 0);
  assert.equal(JSON.stringify(report).includes('CANARY'), false); assert.deepEqual(cleanup.errors, []);
});
test('cleanup uncertainty remains evidence even when forced supervisor termination succeeds, preserving original startup failure', async () => {
  const inputs = setup(owned(), owned({ terminal: false, closed: false, killedCloses: true }));
  const cleanup = await cleanupCapacityRun(inputs);
  const report = retainCapacityFailure({ stage: 'production-startup', check: 'control-deadline' }, { revision: 'old' }, cleanup);
  assert.equal(report.check, 'control-deadline');
  assert.equal(cleanup.forcedSupervisorTerminationRequested, true); assert.equal(inputs.supervisor.kills(), 1);
  assert.equal(cleanup.supervisorOwnedTerminalConfirmed, true); assert.equal(cleanup.supervisorStdioClosedConfirmed, true);
  assert.deepEqual(cleanup.errors, [{ stage: 'cleanup', check: 'job-exit-unconfirmed' }]);
  assert.equal(inputs.removed(), false); assert.equal(cleanup.scratchRemoved, false);
});
test('terminal exit alone cannot authorize removal while owned stdio is unclosed', async () => {
  const inputs = setup(owned({ closed: false }));
  const cleanup = await cleanupCapacityRun(inputs);
  assert.equal(cleanup.fixtureOwnedTerminalConfirmed, true); assert.equal(cleanup.fixtureStdioClosedConfirmed, false);
  assert.equal(inputs.fixture.kills(), 0); assert.equal(inputs.removed(), false);
  assert.deepEqual(cleanup.errors, [{ stage: 'cleanup', check: 'natural-exit-unconfirmed' }]);
});
test('missing job receipt retains scratch and records failure while cleanup still awaits both owned children', async () => {
  const inputs = setup(); inputs.closeJob = async () => { throw new Error('CANARY-secret'); };
  const cleanup = await cleanupCapacityRun(inputs);
  assert.equal(cleanup.fixtureOwnedTerminalConfirmed, true); assert.equal(cleanup.supervisorOwnedTerminalConfirmed, true);
  assert.equal(cleanup.jobEmptyConfirmed, false); assert.equal(inputs.removed(), false);
  assert.equal(JSON.stringify(cleanup).includes('CANARY'), false);
  assert.deepEqual(cleanup.errors, [{ stage: 'cleanup', check: 'job-exit-unconfirmed' }]);
});
test('paused unattached fixture is signalled only through its owned handle and uncertain terminal remains bounded', async () => {
  const inputs = setup(owned({ terminal: false, closed: false, killedCloses: true })); inputs.attached = false;
  const cleanup = await cleanupCapacityRun(inputs);
  assert.equal(inputs.fixture.kills(), 1); assert.equal(cleanup.forcedFixtureTerminationRequested, true);
  assert.equal(cleanup.fixtureOwnedTerminalConfirmed, true); assert.equal(cleanup.fixtureStdioClosedConfirmed, true);
  assert.equal(cleanup.scratchRemoved, true);
  const unresolved = setup(owned({ terminal: false, closed: false })); unresolved.attached = false;
  const failed = await cleanupCapacityRun(unresolved);
  assert.equal(unresolved.fixture.kills(), 1); assert.equal(failed.fixtureOwnedTerminalConfirmed, false);
  assert.equal(failed.scratchRemoved, false); assert.equal(unresolved.removed(), false);
  assert.equal(failed.supervisorOwnedTerminalConfirmed, true); assert.equal(failed.supervisorStdioClosedConfirmed, true);
  assert.deepEqual(failed.errors, [{ stage: 'cleanup', check: 'natural-exit-unconfirmed' }]);
});


test('failure retention privately copies only valid bounded connector progress', () => {
  const progress = { heartbeatCount: 9, elapsedMs: 9003 };
  const report = retainCapacityFailure({ stage: 'actual-connector-events', check: 'control-deadline', connectorProgress: progress }, { revision: 'old' }, {});
  progress.elapsedMs = 0;
  assert.deepEqual(report.connectorProgress, { heartbeatCount: 9, elapsedMs: 9003 });
  for (const value of [{ ...progress, path: 'CANARY-private' }, { heartbeatCount: 13, elapsedMs: 9003 }]) {
    const refused = retainCapacityFailure({ stage: 'actual-connector-events', check: 'control-deadline', connectorProgress: value }, {}, {});
    assert.equal(refused.connectorProgress, undefined);
  }
});
