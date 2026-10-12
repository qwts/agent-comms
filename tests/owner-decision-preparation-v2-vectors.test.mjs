import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';

test('independent preparation v2 checker validates semantic schemas, rebound evidence and trust entry cases', () => {
  const result = JSON.parse(execFileSync(process.execPath, ['tools/acceptance/owner-decision-preparation-v2-vectors.mjs'], {encoding:'utf8'}));
  assert.equal(result.status, 'specification-consistency-only');
  assert.equal(result.boundaryTrustVersion, 1023); assert.equal(result.records, 42); assert.equal(result.negativePreparations, 6); assert.equal(result.entryCases, 2);
});
