import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkOwnerDecisionFrameVectors } from '../tools/acceptance/owner-decision-frame-vectors.mjs';

test('independent frozen vectors match broker bytes and reject every daemon frame across broker slots', () => {
  assert.deepEqual(checkOwnerDecisionFrameVectors(), {
    vectors: 48, brokerPositive: 20, brokerRejectedDaemon: 280, allFrameHashes: 48,
    fixtureSha256: '9c9e9812291b876dd74fca43680393c2def510c0bc953a949dc1ca028f4d80ba',
  });
});
