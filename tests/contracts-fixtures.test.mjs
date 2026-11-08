// Runs every soul-contracts wire/v1 and task/v1 fixture against the agent-comms
// codecs (platform PDR-0024, ADR-0300). Fixtures are read from the pinned
// soul-contracts revision, never copied here. The checkout is cached under
// node_modules/.cache; with no cache and no network the test fails, never
// skips.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CommsError } from '../lib/errors.mjs';
import { compileSchema, isDateTime } from '../lib/contracts/json-schema.mjs';
import { CONTRACT_SCHEMAS } from '../lib/contracts/schemas.mjs';
import { parseStrict } from '../lib/contracts/strict-json.mjs';
import { mirrorActionRecord, mirrorTaskCommitment, mirrorTaskRecord } from '../lib/contracts/task-v1.mjs';
import { admitDirectiveOrQuery, admitFrame, frameRoutedMessage } from '../lib/contracts/wire-v1.mjs';

const VENDOR = fileURLToPath(new URL('../lib/vendor/soul-contracts/', import.meta.url));
const SOURCE = JSON.parse(readFileSync(join(VENDOR, 'source.json'), 'utf8'));
const SEAMS = ['wire/v1/', 'task/v1/'];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function checkout() {
  const parent = fileURLToPath(new URL('../node_modules/.cache/', import.meta.url));
  const cache = join(parent, `soul-contracts-${SOURCE.commit}`);
  if (existsSync(join(cache, 'fixtures'))) return cache;
  mkdirSync(parent, { recursive: true });
  const work = mkdtempSync(join(parent, 'soul-contracts-fetch-'));
  try {
    const git = (...args) => execFileSync('git', ['-C', work, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    git('init', '-q');
    git('fetch', '-q', '--depth', '1', SOURCE.repository, SOURCE.commit);
    git('checkout', '-q', 'FETCH_HEAD');
    const head = execFileSync('git', ['-C', work, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.equal(head, SOURCE.commit, 'fetched soul-contracts revision');
    rmSync(join(work, '.git'), { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
    renameSync(work, cache);
  } catch (error) {
    rmSync(work, { recursive: true, force: true });
    throw new Error(`cannot fetch soul-contracts ${SOURCE.commit}: ${error.stderr?.toString().trim() || error.message}`);
  }
  return cache;
}

const ROOT = checkout();
const fixtures = ['positive', 'negative'].flatMap((kind) => readdirSync(join(ROOT, 'fixtures', kind))
  .filter((name) => name.endsWith('.json'))
  .map((name) => ({ kind, name, ...JSON.parse(readFileSync(join(ROOT, 'fixtures', kind, name), 'utf8')) })))
  .filter((f) => SEAMS.some((seam) => f.schema.startsWith(seam)));

const CODECS = {
  'task/v1/task-record.schema.json': mirrorTaskRecord,
  'task/v1/task-commitment.schema.json': mirrorTaskCommitment,
  'task/v1/action-record.schema.json': mirrorActionRecord,
  'wire/v1/directive-or-query.schema.json': admitDirectiveOrQuery,
  // A positive frame carries no context: admit it just before its expiry,
  // with exactly the capabilities it requires.
  'wire/v1/wire-frame.schema.json': (input, context = {}) => admitFrame(input, {
    now: context.now === undefined ? Date.parse(parseLoose(input).expires_at) - 1000 : Date.parse(context.now),
    negotiatedCapabilities: context.negotiated_capabilities ?? parseLoose(input).required_capabilities,
  }),
};
const parseLoose = (input) => (typeof input === 'string' ? JSON.parse(input) : input);

test('vendored schemas match their pinned provenance and the soul-contracts revision', () => {
  assert.deepEqual(Object.keys(SOURCE.files).sort(), CONTRACT_SCHEMAS.map((p) => `schemas/${p}`).sort());
  for (const [path, digest] of Object.entries(SOURCE.files)) {
    const vendored = readFileSync(join(VENDOR, path));
    assert.equal(sha256(vendored), digest, `${path} hash`);
    assert.ok(vendored.equals(readFileSync(join(ROOT, path))), `${path} equals soul-contracts ${SOURCE.commit}`);
  }
  for (const seam of SEAMS) {
    const upstream = readdirSync(join(ROOT, 'schemas', seam)).map((name) => `${seam}${name}`);
    assert.deepEqual(upstream.filter((p) => !CONTRACT_SCHEMAS.includes(p)), [], `every ${seam} schema is implemented`);
  }
});

test('every wire/v1 and task/v1 schema has positive and negative fixtures', () => {
  for (const path of CONTRACT_SCHEMAS) {
    assert.ok(fixtures.some((f) => f.schema === path && f.kind === 'positive'), `${path} positive`);
    assert.ok(fixtures.some((f) => f.schema === path && f.kind === 'negative'), `${path} negative`);
  }
});

for (const fixture of fixtures) {
  test(`${fixture.kind}/${fixture.name}`, () => {
    const codec = CODECS[fixture.schema];
    assert.ok(codec, `no codec for ${fixture.schema}`);
    const input = fixture.input_raw ?? fixture.input;
    if (fixture.kind === 'positive') {
      assert.equal(fixture.expect.schema, 'valid');
      const mirrored = codec(input, fixture.context);
      assert.deepEqual(mirrored, fixture.input, 'mirrored unchanged');
      assert.ok(Object.isFrozen(mirrored), 'mirror is frozen');
      return;
    }
    assert.throws(() => codec(input, fixture.context), (error) => {
      assert.ok(error instanceof CommsError, `refused with a CommsError, got ${error}`);
      assert.equal(error.code, fixture.expect.error ?? 'bad-request');
      return true;
    });
  });
}

test('a routed message frames to a record its own admission accepts', () => {
  const positive = fixtures.find((f) => f.name === 'wire-frame.sealed-task-wake.json').input;
  const frame = frameRoutedMessage({
    messageId: positive.message_id,
    destinationSoul: positive.destination_soul,
    destinationEpoch: positive.destination_epoch,
    expiresAt: Date.parse(positive.expires_at),
    payloadSize: positive.payload_size,
    wakeClass: positive.wake_class,
    requiredCapabilities: positive.required_capabilities,
    sealed: positive.sealed,
  });
  assert.deepEqual(frame, positive);
  assert.deepEqual(admitFrame(JSON.stringify(frame), { now: Date.parse(positive.expires_at) - 1,
    negotiatedCapabilities: positive.required_capabilities }), positive);
  assert.throws(() => frameRoutedMessage({ messageId: 'message_1', destinationSoul: positive.destination_soul,
    expiresAt: Date.now(), payloadSize: 1, wakeClass: 'notify' }), { code: 'bad-request' }, 'no destination epoch');
  assert.throws(() => frameRoutedMessage({ messageId: 'message_1', destinationSoul: positive.destination_soul,
    destinationEpoch: 1, expiresAt: Date.now(), payloadSize: 256 * 1024 + 1, wakeClass: 'notify' }), { code: 'frame_too_large' });
});

test('admission requires a clock and the negotiated capabilities', () => {
  const positive = fixtures.find((f) => f.name === 'wire-frame.notify-unsealed.json').input;
  assert.throws(() => admitFrame(positive, { negotiatedCapabilities: [] }), TypeError);
  assert.throws(() => admitFrame(positive, { now: 0 }), TypeError);
});

test('the validator fails closed on schema keywords it does not implement', () => {
  assert.throws(() => compileSchema({ type: 'object', patternProperties: {} }), /unsupported schema keyword patternProperties/);
  assert.throws(() => compileSchema({ type: 'string', format: 'uri' }), /unsupported format uri/);
  assert.throws(() => compileSchema({ type: 'object', additionalProperties: {} }), /only additionalProperties false/);
});

test('strict JSON refuses duplicate keys at any depth and keeps JSON.parse semantics', () => {
  assert.throws(() => parseStrict('{"a":1,"a":2}'), /duplicate key "a"/);
  assert.throws(() => parseStrict('{"a":{"b":1,"\\u0062":2}}'), /duplicate key "b"/);
  assert.throws(() => parseStrict('[{"x":1},{"y":2,"y":3}]'), /duplicate key "y"/);
  assert.throws(() => parseStrict('{"a":NaN}'), SyntaxError);
  assert.throws(() => parseStrict('{"a":1} trailing'), SyntaxError);
  assert.deepEqual(parseStrict(' {"a":[1,"}",{"b":null}],"c":"\\"{"} '), { a: [1, '}', { b: null }], c: '"{' });
});

test('date-time follows RFC 3339', () => {
  for (const ok of ['2026-11-08T18:00:00Z', '2026-02-28T23:59:59.5+05:30', '2024-02-29t00:00:00z']) assert.ok(isDateTime(ok), ok);
  for (const bad of ['2026-11-08', '2026-11-08T18:00Z', '2026-02-29T00:00:00Z', '2026-11-08T24:00:00Z', '2026-11-08T18:00:00+2400']) {
    assert.ok(!isDateTime(bad), bad);
  }
});
