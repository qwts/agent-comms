// Private short synchronous source guard. Enrollment always precedes admission.
import * as fs from 'node:fs';
import { acquireOwnerJournalLock } from './owner-journal-lock.mjs';
import { isNativeObserver, isFixtureObserver } from './owner-observer-native.mjs';
const root = '/Library/Application Support/AgentComms/owner-enrollment';
const fixtures = new WeakSet();
export const isFixtureEnrollmentGuard = value => fixtures.has(value);
const fail = () => { throw new Error('owner-observer-unavailable'); };
function provider(observer, sourceRoot, fixtureInput) {
  let poisoned = false;
  return Object.freeze({ open() {
    if (poisoned) fail();
    let fd = acquireOwnerJournalLock(sourceRoot, { createIfEmpty: false }), closed = false;
    const observe = () => { if (closed || poisoned) fail(); return observer.observe(fd, fixtureInput); };
    const close = () => {
      if (closed) return; closed = true; const owned = fd; fd = undefined;
      try { fs.closeSync(owned); } catch { poisoned = true; fail(); }
    };
    try { const snapshot = observe(); return Object.freeze({ snapshot, observe, close }); }
    catch (error) { try { close(); } catch { poisoned = true; } throw error; }
  } });
}
export function createFixedEnrollmentGuard(observer) {
  if (!isNativeObserver(observer)) fail(); return provider(observer, root);
}
export function createFixtureEnrollmentGuard({ observer, sourceRoot, bootstrap, rootFd, syntheticFixture = false } = {}) {
  if (!syntheticFixture || !isFixtureObserver(observer)) fail();
  const value = provider(observer, sourceRoot, Object.freeze({ bootstrap: Buffer.from(bootstrap), rootFd }));
  fixtures.add(value); return value;
}
