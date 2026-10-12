// Proposed source candidate tests. Validation is intentionally held for review.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeDesktopFrame, isOwnedDesktopContext } from '../tools/acceptance/windows-desktop-context.mjs';
import { readFileSync } from 'node:fs';
const pins = JSON.parse(readFileSync(new URL('./fixtures/windows-host-components.json', import.meta.url)));
const valid = { v:1,task:'candidate-compiler',root:'C:\\Users\\test\\AppData\\Local\\agent-comms-desktop-'+'a'.repeat(32),
  parentPid:123,nodeArchiveSha256:pins.node.sha256['win-x64'],nodeExecutableSha256:'b'.repeat(64) };
const bytes = value => Buffer.from(JSON.stringify(value));
test('desktop frame admits only fixed tasks and exact bounded pinned data', () => {
  assert.deepEqual(decodeDesktopFrame(bytes(valid)),valid);
  assert.equal(decodeDesktopFrame(bytes({...valid,task:'candidate-startup'})).task,'candidate-startup');
  for(const patch of [{task:'engine'},{task:'capacity-pilot'},{task:'candidate-channel'},{root:'relative'},
    {root:'C:\\'+'x'.repeat(241)},{parentPid:0},{parentPid:1.5},{nodeArchiveSha256:'c'.repeat(64)},
    {nodeExecutableSha256:'B'.repeat(64)},{v:2},{timeout:999999},{source:'C:\\caller'}]) {
    assert.throws(()=>decodeDesktopFrame(bytes({...valid,...patch})),/desktop-context-refused/);
  }
  for(const bad of [Buffer.alloc(4097),Buffer.from('{'),Buffer.from([0xff]),bytes(null)]) assert.throws(()=>decodeDesktopFrame(bad));
});
test('caller data and decoded frame cannot forge owned desktop context', () => {
  assert.equal(isOwnedDesktopContext(valid),false);
  assert.equal(isOwnedDesktopContext(decodeDesktopFrame(bytes(valid))),false);
  assert.equal(isOwnedDesktopContext(Object.freeze({...valid,rootVerified:true,administrator:false})),false);
});
