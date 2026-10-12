import { boundedBrokerCode } from './windows-corrected-startup.mjs';
import { validConnectorProgress } from './windows-capacity-control.mjs';
// Dev-only owned-handle cleanup. No PID signaling or raw failure serialization.
export async function cleanupCapacityRun({ fixture, supervisor, attached, disposed, closeJob, receipt, removeScratch, timeoutMs = 5000 }) {
  const errors = [];
  const result = { fixtureOwnedTerminalConfirmed: false, fixtureStdioClosedConfirmed: false,
    supervisorOwnedTerminalConfirmed: false, supervisorStdioClosedConfirmed: false,
    forcedSupervisorTerminationRequested: false, forcedFixtureTerminationRequested: false,
    jobEmptyConfirmed: receipt.jobEmptyConfirmed === true, scratchRemoved: false, errors };
  async function settled(owned, prefix) {
    let timer;
    try {
      await Promise.race([Promise.all([
        owned.exited.then(() => { result[`${prefix}OwnedTerminalConfirmed`] = true; }),
        owned.stdioClosed.then(() => { result[`${prefix}StdioClosedConfirmed`] = true; }),
      ]), new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error()), timeoutMs); })]);
      return true;
    } catch { return false; }
    finally { clearTimeout(timer); }
  }
  if (!disposed) {
    try { await closeJob(); } catch { errors.push({ stage: 'cleanup', check: 'job-exit-unconfirmed' }); }
  }
  result.jobEmptyConfirmed = receipt.jobEmptyConfirmed === true;
  if (!supervisor.terminal()) {
    try { supervisor.child.stdin.end(); } catch { errors.push({ stage: 'cleanup', check: 'control-closed' }); }
  }
  if (!await settled(supervisor, 'supervisor')) {
    errors.push({ stage: 'cleanup', check: 'job-exit-unconfirmed' });
    if (!supervisor.terminal()) {
      result.forcedSupervisorTerminationRequested = true;
      try { supervisor.child.kill(); } catch { /* The bounded wait records uncertainty. */ }
    }
    if (!await settled(supervisor, 'supervisor')) errors.push({ stage: 'cleanup', check: 'forced-job-exit-unconfirmed' });
  }
  if (!attached && !fixture.terminal()) {
    result.forcedFixtureTerminationRequested = true;
    try { fixture.child.kill(); } catch { /* The bounded wait records uncertainty. */ }
  }
  if (!await settled(fixture, 'fixture')) errors.push({ stage: 'cleanup', check: 'natural-exit-unconfirmed' });
  if (!result.jobEmptyConfirmed && !errors.some((entry) => entry.check === 'job-exit-unconfirmed')) {
    errors.push({ stage: 'cleanup', check: 'job-exit-unconfirmed' });
  }
  if (!errors.length) {
    try { removeScratch(); result.scratchRemoved = true; receipt.scratchRemoved = true; }
    catch { errors.push({ stage: 'cleanup', check: 'scratch-retained' }); }
  }
  return result;
}

// The original is already classified by the driver. Select fields explicitly;
// never spread the Error or copy an arbitrary message/cause/property.
export function retainCapacityFailure(original, { revision, preflight, fixturePhase }, ownedCleanup) {
  return { status: 'failed', stage: original.stage, check: original.check,
    ...(boundedBrokerCode(original.brokerCode) ? { brokerCode: original.brokerCode } : {}),
    ...(original.supervisorPhase ? { supervisorPhase: original.supervisorPhase } : {}),
    ...(validConnectorProgress(original.connectorProgress) ? { connectorProgress: { ...original.connectorProgress } } : {}),
    ...(revision === 'old' || revision === 'new' || revision === 'candidate' ? { revision } : {}),
    ...(preflight === 'normal' || preflight === 'fault' || preflight === 'forced' || preflight === 'custody' || preflight === 'candidate-startup' ? { preflight } : {}),
    ...(fixturePhase ? { fixturePhase } : {}), ownedCleanup };
}
