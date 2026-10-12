// Proposed storage specification consistency only. This does not import or test
// a production parser, journal, filesystem allocator, authority or recovery path.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const data = JSON.parse(readFileSync(new URL('../../tests/fixtures/owner-decisions/journal-budget-v1.json', import.meta.url)));
const canonical = v => v && typeof v === 'object'
  ? Array.isArray(v) ? `[${v.map(canonical)}]` : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  : JSON.stringify(v);
const exact = (v, names) => assert.deepEqual(Object.keys(v).sort(), names.split(' ').sort());
const match = (v, re) => assert.equal(typeof v === 'string' && re.exec(v)?.[0] === v, true);
const hash = v => match(v, /^[a-f0-9]{64}$/);
const uuid = v => match(v, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const number = v => assert(Number.isSafeInteger(v) && v >= 0);
const epoch = v => { number(v); assert(v > 0); };
const nullable = (v, check) => { if (v !== null) check(v); };
const operations = ['cold-wake.set', 'revision.adopt', 'revision.approve', 'revision.edit', 'revision.reject'];
const codes = { applied: ['applied'], refused: ['validation-refused', 'authority-refused', 'deadline-expired'], cancelled: ['cancelled'], expired: ['deadline-expired'], indeterminate: ['effect-uncertain'] };
function inspect(r) {
  assert.equal(r.v, 1); uuid(r.requestId); hash(r.payloadDigest);
  if (r.kind === 'acceptance') {
    exact(r, 'v kind requestId principal account soul operation payloadDigest namespaceDigest acceptedAt daemonKey daemonEpoch watchId reservationBytes');
    match(r.principal, /^principal_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    match(r.soul, /^agent_[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    match(r.account, /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/);
    assert(operations.includes(r.operation)); hash(r.namespaceDigest); number(r.acceptedAt);
    hash(r.daemonKey); epoch(r.daemonEpoch); uuid(r.watchId);
    assert([262144, 524288].includes(r.reservationBytes));
  } else if (r.kind === 'authorization') {
    exact(r, 'v kind requestId payloadDigest nonce actionDigest challengeDigest presenceDigest receiptDigest exp daemonKey daemonEpoch watchId');
    match(r.nonce, /^[A-Za-z0-9_-]{43}$/);
    const nonce = Buffer.from(r.nonce, 'base64url'); assert.equal(nonce.length, 32); assert.equal(nonce.toString('base64url'), r.nonce);
    for (const k of ['actionDigest', 'challengeDigest', 'presenceDigest', 'receiptDigest', 'daemonKey']) hash(r[k]);
    number(r.exp); epoch(r.daemonEpoch); uuid(r.watchId);
  } else if (r.kind === 'outcome') {
    exact(r, 'v kind requestId payloadDigest state receiptDigest outcome source reportingDaemonKey reportingDaemonEpoch at');
    assert(Object.hasOwn(codes, r.state)); nullable(r.receiptDigest, hash); exact(r.outcome, 'code effectDigest');
    assert(codes[r.state].includes(r.outcome.code)); nullable(r.outcome.effectDigest, hash); number(r.at);
    assert(['broker', 'daemon'].includes(r.source));
    if (r.source === 'broker') {
      assert.equal(r.reportingDaemonKey, null); assert.equal(r.reportingDaemonEpoch, null);
      assert.notEqual(r.state, 'applied'); assert.equal(r.outcome.effectDigest, null);
    } else { hash(r.reportingDaemonKey); epoch(r.reportingDaemonEpoch); }
    if (r.state === 'applied') assert.notEqual(r.outcome.effectDigest, null);
  } else {
    assert.equal(r.kind, 'reconciliation-reference');
    exact(r, 'v kind requestId payloadDigest originalDaemonKey originalDaemonEpoch reportingDaemonKey reportingDaemonEpoch at finding auditId evidenceDigest');
    for (const k of ['originalDaemonKey', 'reportingDaemonKey', 'evidenceDigest']) hash(r[k]);
    epoch(r.originalDaemonEpoch); epoch(r.reportingDaemonEpoch); number(r.at); uuid(r.auditId);
    assert(['applied', 'refused', 'indeterminate'].includes(r.finding));
  }
}
assert.equal(data.version, 1);
assert.deepEqual(data.limits, { acceptedIds: 4096, framingBytes: 256, scratchPayloadBytes: 32768, namedFileEntries: 24, namedDirectories: 8, entryCharge: 4096, componentBytes: 64, globalReservationBytes: 1048576, globalNamedFileEntries: 16, globalNamedDirectories: 8, globalPayloadBytes: 131072 });
// These independently specified tables must agree with the checked-in fixtures.
const slots = {
  broker: [['acceptance',4096],['original-action',32768],['prepared-challenge',32768],['presence',4096],['receipt',4096],['authorization',4096],['release',4096],['initial-outcome',4096],['observation-reference',2048],['terminal-reference',2048]],
  daemon: [['acceptance-context',4096],['original-action',32768],['prepared-challenge',32768],['presence',4096],['receipt',4096],['preparation',4096],['successful-check',4096],['pre-effect-refused',4096],['entered',4096],['completed',4096],['observation-pair',4352],['terminal-pair',4352],['linked-authoritative-event',16384],['local-lifecycle-outcome',4096]],
};
const l = data.limits;
for (const [name, pairs] of Object.entries(slots)) {
  const s = data.stores[name]; assert.deepEqual(s.slots, pairs.map(([name, payloadCap]) => ({ name, payloadCap })));
  assert.equal(s.reservationBytes, name === 'broker' ? 262144 : 524288);
  const payloadBytes = pairs.reduce((n, [, cap]) => n + cap, 0);
  const slotFramingBytes = pairs.length * l.framingBytes;
  const scratchBytes = l.scratchPayloadBytes + l.framingBytes;
  // Count names, even when two entries hard-link one inode.
  const metadataBytes = (l.namedFileEntries + l.namedDirectories) * l.entryCharge;
  const requiredBytes = payloadBytes + slotFramingBytes + scratchBytes + metadataBytes;
  const globalRequiredBytes = l.globalPayloadBytes + l.globalNamedFileEntries * l.framingBytes + (l.globalNamedFileEntries + l.globalNamedDirectories) * l.entryCharge;
  const installationRequestBytes = l.acceptedIds * s.reservationBytes;
  assert.deepEqual(s.expected, { payloadBytes, slotFramingBytes, scratchBytes, metadataBytes, requiredBytes, installationRequestBytes, globalRequiredBytes, installationReservedBytes: installationRequestBytes + l.globalReservationBytes });
  assert.equal(payloadBytes + slotFramingBytes, name === 'broker' ? 96768 : 131072);
  assert.equal(pairs.length + 1, name === 'broker' ? 11 : 15); // all final names plus scratch
  assert(pairs.length + 1 <= l.namedFileEntries);
  assert(requiredBytes <= s.reservationBytes); assert(globalRequiredBytes <= l.globalReservationBytes);
}
const ids = new Set(); const maximum = {}; const covered = new Set();
for (const v of data.administrativeRecords) {
  assert(!ids.has(v.id)); ids.add(v.id); inspect(v.record); covered.add(v.record.kind);
  const text = canonical(v.record); assert.equal(text, v.canonicalJson);
  assert.equal(createHash('sha256').update(text).digest('hex'), v.sha256);
  assert.equal(Buffer.byteLength(text), v.utf8Bytes);
  assert.equal(v.slot, v.record.kind); assert.equal(v.cap, v.record.kind === 'reconciliation-reference' ? 2048 : 4096);
  assert(v.utf8Bytes <= v.cap); maximum[v.record.kind] = Math.max(maximum[v.record.kind] ?? 0, v.utf8Bytes);
}
assert.deepEqual([...covered].sort(), ['acceptance', 'authorization', 'outcome', 'reconciliation-reference']);
assert.equal(data.administrativeRecords.find(v => v.id === 'acceptance-broker').record.reservationBytes, 262144);
assert.equal(data.administrativeRecords.find(v => v.id === 'acceptance-daemon').record.reservationBytes, 524288);
for (const [state, values] of Object.entries(codes)) for (const code of values) assert(data.administrativeRecords.some(v => v.record.state === state && v.record.outcome.code === code));
for (const finding of ['applied', 'refused', 'indeterminate']) assert(data.administrativeRecords.some(v => v.record.finding === finding));
assert.deepEqual(maximum, { acceptance: 682, authorization: 734, outcome: 553, 'reconciliation-reference': 610 });
// Conservative structural maxima: every legal action is a subset, because
// native display/time checks can only refuse these bounds, never enlarge them.
const wrapperBounds = data.preparedWrapperBounds.records;
assert.deepEqual(wrapperBounds.map(v => v.id), ['approve', 'reject', 'adopt', 'edit', 'off', 'on', 'resume', 'webhook']);
const boundSizes = { action: 0, challenge: 0, stage: 0, wrapper: 0 };
for (const v of wrapperBounds) {
  const action = v.action, r = v.record, challenge = r.challenge;
  exact(action, 'v requestId principal account soul operation parameters');
  assert.equal(action.v, 1); uuid(action.requestId); assert.equal(action.account.length, 64);
  assert(operations.includes(action.operation));
  const p = action.parameters;
  if (['approve', 'reject'].includes(v.id)) exact(p, 'proposalId expectedRevision reason');
  else if (v.id === 'adopt') exact(p, 'stagingId packageDigest expectedRevision reason');
  else if (v.id === 'edit') exact(p, 'stagingId packageDigest expectedRevision reason apply');
  else if (v.id === 'resume') exact(p, 'mode policy');
  else if (v.id === 'webhook') exact(p, 'mode stagingId configurationDigest host');
  else exact(p, 'mode');
  if (Object.hasOwn(p, 'reason')) {
    assert.equal(p.reason, '"'.repeat(500)); assert.equal(Buffer.byteLength(JSON.stringify(p.reason)), 1002);
  }
  if (v.id === 'edit') assert.equal(p.apply, false); // Five bytes rather than true's four.
  if (v.id === 'resume') assert.equal(p.policy, 'workspace'); // Same nine-byte bound as read-only.
  if (v.id === 'webhook') assert.equal(p.host.length, 253);
  exact(r, 'v challenge stage'); assert.equal(r.v, 1);
  exact(challenge, 'requestId principal account soul operation payloadDigest action nonce acceptedAt preparedAt exp daemonKey daemonEpoch watchId');
  for (const k of ['requestId', 'principal', 'account', 'soul', 'operation']) assert.equal(challenge[k], action[k]);
  const actionText = canonical(action), actionBytes = Buffer.byteLength(actionText);
  assert.equal(challenge.action, Buffer.from(actionText).toString('base64url'));
  assert.equal(challenge.payloadDigest, createHash('sha256').update(actionText).digest('hex'));
  assert.equal(challenge.exp, Number.MAX_SAFE_INTEGER); assert.equal(challenge.daemonEpoch, Number.MAX_SAFE_INTEGER);
  assert.equal(challenge.acceptedAt, Number.MAX_SAFE_INTEGER - 180); assert.equal(challenge.preparedAt, challenge.acceptedAt);
  if (Object.hasOwn(p, 'stagingId')) {
    exact(r.stage, 'stagingId kind contentDigest expiresAt');
    assert.equal(r.stage.stagingId, p.stagingId);
    assert.equal(r.stage.kind, v.id === 'webhook' ? 'webhook' : 'package');
    assert.equal(r.stage.contentDigest, p.packageDigest ?? p.configurationDigest);
    assert.equal(r.stage.expiresAt, Number.MAX_SAFE_INTEGER);
  } else assert.equal(r.stage, null);
  const text = canonical(r), challengeBytes = Buffer.byteLength(canonical(challenge)), stageBytes = Buffer.byteLength(canonical(r.stage));
  assert.equal(text, v.canonicalJson); assert.equal(v.utf8Bytes, Buffer.byteLength(text));
  assert.equal(v.actionBytes, actionBytes); assert.equal(v.challengeBytes, challengeBytes); assert.equal(v.stageBytes, stageBytes);
  assert.equal(v.wrapperBytes, v.utf8Bytes - challengeBytes - stageBytes); assert.equal(v.wrapperBytes, 29);
  assert.equal(v.cap, 32768); assert(v.utf8Bytes <= v.cap);
  assert.equal(v.sha256, createHash('sha256').update(text).digest('hex'));
  boundSizes.action = Math.max(boundSizes.action, actionBytes); boundSizes.challenge = Math.max(boundSizes.challenge, challengeBytes);
  boundSizes.stage = Math.max(boundSizes.stage, stageBytes); boundSizes.wrapper = Math.max(boundSizes.wrapper, v.utf8Bytes);
}
assert.deepEqual(boundSizes, { action: 1544, challenge: 2720, stage: 181, wrapper: 2930 });
const revision = v => match(v, /^sha256:[a-f0-9]{64}$/);
const sequence = v => { number(v); assert(v <= 9999999999); };
const head = v => { exact(v, 'seq revision'); sequence(v.seq); revision(v.revision); };
function preimage(v) {
  assert.equal(v.v, 1);
  if (Object.hasOwn(v, 'head')) {
    exact(v, 'v head proposal working'); nullable(v.head, head);
    nullable(v.proposal, p => { exact(p, 'proposalId seq revision parentRevision'); uuid(p.proposalId); sequence(p.seq); revision(p.revision); revision(p.parentRevision); });
    nullable(v.working, w => { exact(w, 'rootDigest inventoryDigest'); hash(w.rootDigest); hash(w.inventoryDigest); });
  } else {
    exact(v, 'v setting webhookDigest resume'); nullable(v.webhookDigest, hash);
    assert(['off', 'on', 'resume', 'webhook'].includes(v.setting.mode));
    exact(v.setting, v.setting.mode === 'resume' ? 'mode policy' : 'mode');
    if (v.setting.mode === 'resume') assert(['read-only', 'workspace'].includes(v.setting.policy));
    nullable(v.resume, r => { exact(r, 'harness sessionDigest toolHomeDigest destinationDigest');
      assert(['codex', 'opencode', 'devin', 'grok'].includes(r.harness)); nullable(r.sessionDigest, hash); hash(r.toolHomeDigest); hash(r.destinationDigest); });
  }
}
const pairIds = new Set(), pairKinds = new Set(); const pairMaximum = { record: 0, preimage: 0, wrapper: 0, pair: 0 };
for (const v of data.reconciliationPairs) {
  assert(!pairIds.has(v.id)); pairIds.add(v.id); exact(v.record, 'v record preimage'); assert.equal(v.record.v, 1);
  const r = v.record.record; exact(r, 'v kind requestId payloadDigest effectId auditId originalDaemonKey originalDaemonEpoch reportingDaemonKey reportingDaemonEpoch at finding basisDigest observedDigest');
  assert.equal(r.v, 1); assert.equal(r.kind, 'reconciliation'); uuid(r.requestId); uuid(r.auditId);
  for (const k of ['payloadDigest', 'originalDaemonKey', 'reportingDaemonKey', 'observedDigest']) hash(r[k]);
  epoch(r.originalDaemonEpoch); epoch(r.reportingDaemonEpoch); number(r.at);
  assert(['indeterminate', 'applied', 'refused'].includes(r.finding)); nullable(r.effectId, uuid); nullable(r.basisDigest, hash);
  if (r.finding !== 'indeterminate') { assert.notEqual(r.effectId, null); assert.notEqual(r.basisDigest, null); }
  preimage(v.record.preimage);
  const text = canonical(v.record), recordBytes = Buffer.byteLength(canonical(r)), preimageText = canonical(v.record.preimage);
  const preimageBytes = Buffer.byteLength(preimageText), wrapper = Buffer.byteLength(text) - recordBytes - preimageBytes;
  assert.equal(createHash('sha256').update(preimageText).digest('hex'), r.observedDigest);
  assert.equal(text, v.canonicalJson); assert.equal(createHash('sha256').update(text).digest('hex'), v.sha256);
  assert.equal(v.cap, 4352); assert.equal(v.utf8Bytes, Buffer.byteLength(text)); assert.deepEqual(v.componentBytes, { record: recordBytes, preimage: preimageBytes });
  assert.equal(v.wrapperBytes, wrapper); assert(recordBytes <= 2048); assert(preimageBytes <= 2048); assert(wrapper <= 256); assert(v.utf8Bytes <= 4352);
  assert.equal(v.slot, r.finding === 'indeterminate' ? 'observation-pair' : 'terminal-pair');
  pairKinds.add(`${Object.hasOwn(v.record.preimage, 'head') ? 'revision' : 'cold'}:${r.finding}`);
  for (const [k, length] of Object.entries({ record: recordBytes, preimage: preimageBytes, wrapper, pair: v.utf8Bytes })) pairMaximum[k] = Math.max(pairMaximum[k], length);
}
assert.equal(pairIds.size, 6); assert.equal(pairKinds.size, 6); assert.equal(pairMaximum.wrapper, 29);
console.log(JSON.stringify({ specificationOnly: true, stores: Object.fromEntries(Object.entries(data.stores).map(([k, v]) => [k, v.expected])), administrativeRecords: ids.size, maximum, preparedWrapperBounds: boundSizes, reconciliationPairs: pairIds.size, pairMaximum }, null, 2));
