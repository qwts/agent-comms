import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { bindOwnerDecisionChallenge as bind } from '../lib/owner-decision-challenge.mjs';
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/owner-decisions/v1.json', import.meta.url)));
const canonical = v => v && typeof v === 'object'
  ? Array.isArray(v) ? `[${v.map(canonical)}]` : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  : JSON.stringify(v);
const bytes = v => Buffer.from(canonical(v));
const reject = fn => assert.throws(fn, { message: 'invalid-owner-decision' });
function prepared(vector = fixtures.positive[0]) {
  const action = JSON.parse(vector.actionJson);
  const options = { originalActionBytes: Buffer.from(vector.actionJson), acceptedAt: 2000000000,
    daemonKey: 'a'.repeat(64), daemonEpoch: 1, watchId: '11111111-1111-4111-8111-111111111111',
    nowMilliseconds: 2000000000000 };
  if (Object.hasOwn(action.parameters, 'stagingId')) options.stageExpiresAt = 2000000100;
  const challenge = { requestId: action.requestId, principal: action.principal, account: action.account,
    soul: action.soul, operation: action.operation, payloadDigest: vector.payloadDigest,
    action: options.originalActionBytes.toString('base64url'), nonce: Buffer.alloc(32, 7).toString('base64url'),
    acceptedAt: options.acceptedAt, preparedAt: options.acceptedAt, exp: options.stageExpiresAt ?? 2000000180,
    daemonKey: options.daemonKey, daemonEpoch: options.daemonEpoch, watchId: options.watchId };
  return { challenge, options, vector };
}
test('every operation binds original action, digest and typed display to the saved challenge', () => {
  for (const vector of fixtures.positive) {
    const { challenge, options } = prepared(vector);
    const result = bind(bytes(challenge), options);
    assert.deepEqual(result.challenge, challenge);
    assert.equal(result.actionText, vector.actionText);
    assert.equal(result.payloadDigest, vector.payloadDigest);
  }
});
test('every saved identity, action, digest and selected daemon binding must match', () => {
  const { challenge, options } = prepared();
  for (const field of ['requestId', 'principal', 'account', 'soul', 'operation', 'payloadDigest', 'daemonKey', 'watchId']) {
    reject(() => bind(bytes({ ...challenge, [field]: challenge[field] + 'x' }), options));
  }
  for (const field of ['acceptedAt', 'daemonEpoch']) reject(() => bind(bytes({ ...challenge, [field]: challenge[field] + 1 }), options));
  const altered = JSON.parse(options.originalActionBytes);
  altered.parameters.reason = 'Different reviewed content';
  reject(() => bind(bytes({ ...challenge, action: bytes(altered).toString('base64url') }), options));
  for (const action of [challenge.action + '=', 'A', '', 'A'.repeat(33000)]) reject(() => bind(bytes({ ...challenge, action }), options));
  for (const nonce of ['', 'A'.repeat(42), 'A'.repeat(42) + 'B', challenge.nonce + '=']) reject(() => bind(bytes({ ...challenge, nonce }), options));
  for (const field of Object.keys(challenge)) {
    const missing = { ...challenge }; delete missing[field];
    reject(() => bind(bytes(missing), options));
  }
  reject(() => bind(bytes({ ...challenge, extra: true }), options));
});
test('deadline is exact minimum, with bounded skew and no extension on duplicates', () => {
  const { challenge: c, options: o } = prepared();
  const check = (change, opts = {}) => bind(bytes({ ...c, ...change }), { ...o, ...opts });
  check({ preparedAt: c.acceptedAt - 30, exp: c.acceptedAt + 150 });
  reject(() => check({ preparedAt: c.acceptedAt - 31, exp: c.acceptedAt + 149 }));
  check({ preparedAt: c.acceptedAt + 30 });
  reject(() => check({ preparedAt: c.acceptedAt + 31 }));
  reject(() => check({ preparedAt: c.acceptedAt + 30, exp: c.exp + 30 }));
  check({}, { nowMilliseconds: c.exp * 1000 - 1 });
  reject(() => check({}, { nowMilliseconds: c.exp * 1000 }));
  reject(() => check({}, { nowMilliseconds: (c.acceptedAt - 31) * 1000 }));
  check({}, { nowMilliseconds: (c.acceptedAt - 30) * 1000 });
  for (const n of [-1, 1.5, Number.MAX_SAFE_INTEGER, NaN, Infinity, '2000000000']) {
    reject(() => check({ acceptedAt: n }, { acceptedAt: n }));
    reject(() => check({ preparedAt: n }));
  }
  for (const n of [-1, 1.5, NaN, Infinity, '2000000000000']) reject(() => check({}, { nowMilliseconds: n }));
});
test('staging deadline is independently required and never extends original acceptance', () => {
  const vector = fixtures.positive.find(v => Object.hasOwn(JSON.parse(v.actionJson).parameters, 'stagingId'));
  const { challenge: c, options: o } = prepared(vector);
  reject(() => bind(bytes(c), { ...o, stageExpiresAt: undefined }));
  reject(() => bind(bytes(c), { ...o, stageExpiresAt: c.exp + 1 }));
  reject(() => bind(bytes(c), { ...o, nowMilliseconds: c.exp * 1000 }));
  bind(bytes({ ...c, exp: c.acceptedAt + 180 }), { ...o, stageExpiresAt: c.acceptedAt + 500 });
  reject(() => bind(bytes({ ...c, exp: c.acceptedAt + 500 }), { ...o, stageExpiresAt: c.acceptedAt + 500 }));
  const unstaged = prepared();
  reject(() => bind(bytes(unstaged.challenge), { ...unstaged.options, stageExpiresAt: c.exp }));
});
test('malformed options and canonical input failures expose no input text', () => {
  const { challenge, options } = prepared();
  reject(() => bind(bytes(challenge), null));
  for (const field of Object.keys(options)) {
    const hostile = { ...options };
    Object.defineProperty(hostile, field, { get() { throw new Error('secret-canary'); } });
    reject(() => bind(bytes(challenge), hostile));
  }
  for (const input of [Buffer.from(' secret-canary'), Buffer.from(' ' + canonical(challenge)), bytes(null), bytes([])]) reject(() => bind(input, options));
});
