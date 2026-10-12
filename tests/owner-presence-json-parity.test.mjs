// Frozen public-only cross-producer p1 parser conformance. These tokens were
// signed under synthetic ephemeral public keys; no private material is retained.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyPresence } from '../lib/vendor/agent-bot-presence/identity-presence.mjs';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/owner-decisions/presence-json-parity-v1.json',import.meta.url)));
test('all thirty frozen p1 JSON grammar cases match unchanged bot-owned verifier',()=>{
  assert.equal(fixture.cases.length,30);let accepted=0;
  for(const c of fixture.cases){
    const verify=()=>verifyPresence(c.token,{key:c.publicKeyBase64,action:c.action,nonce:c.nonce,now:c.nowMilliseconds});
    if(c.nodeVerifierAccepted){assert.doesNotThrow(verify,c.name);accepted++;}else assert.throws(verify,{code:'presence-invalid'},c.name);
  }
  assert.equal(accepted,15);
});
