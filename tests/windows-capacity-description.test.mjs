import assert from 'node:assert/strict';
import test from 'node:test';
import { capacityScope, capacityDeployment } from '../tools/acceptance/windows-capacity-description.mjs';

test('specialized candidate descriptions win over shared startup flags and retain acceptance limits', () => {
  const relay = capacityScope({ relayCandidateStartup: true, candidateStartup: true });
  assert.match(relay, /prebuilt-relay/);
  assert.match(relay, /no offered-rate, desktop or installed-host acceptance/);
  const desktopRelay = capacityScope({ relayCandidateStartup: true, desktopContext: {}, candidateStartup: true });
  assert.match(desktopRelay, /current standard-user desktop fixed prebuilt-relay/);
  assert.match(desktopRelay, /no offered-rate or installed-host acceptance/);
  assert.doesNotMatch(desktopRelay, /hosted/);
  assert.match(capacityScope({ desktopContext: {}, candidateStartup: true }), /current standard-user desktop/);
  assert.match(capacityScope({ candidateChannel: true, candidateStartup: true }), /no Broker.start/);
  assert.match(capacityScope({ candidateStorage: true, candidateStartup: true }), /fresh storage prefix/);
  assert.match(capacityScope({ candidateStartup: true }), /no offered-rate stages/);
  assert.match(capacityScope({}), /finite capacity pilot; no benchmark/);
  assert.match(capacityDeployment({ relayCandidate: true, preflight: 'storage' }), /prebuilt .NET relay/);
  assert.match(capacityDeployment({ preflight: 'storage' }), /no Broker.start/);
  assert.match(capacityDeployment({}), /Identification PowerShell connector/);
});
