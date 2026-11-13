// Identity-service notices enter HQ's durable mailbox before their lease is
// acknowledged (HQ plan §4.8, Stage 0 row 11). This module holds no keys and
// knows no transport: the host's identityService verifies every response.
import { createHash } from 'node:crypto';

const DAY = 24 * 60 * 60 * 1000;
const FIELDS = ['app', 'repo', 'event', 'action', 'kind', 'type', 'number', 'title', 'actor', 'url', 'text', 'createdAt'];
const ROUTES = Object.freeze(['/api/daemon/notices/take', '/api/daemon/notices/ack']);
export const NOTICE_ROUTES = ROUTES;
export const NOTICE_DEFAULTS = Object.freeze({ pollIntervalMs: 30_000, count: 10, leaseSeconds: 300, wakeClass: 'none', maxMessages: 1000, maxBytes: 16 * 1024 * 1024, retentionMs: 8 * DAY });
const TABLE = 'notice_mailbox';
const META = 'notice_state';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const HARNESS = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_NOTICE_BYTES = 64 * 1024;

function refusal(message) { return Object.assign(new Error(message), { code: 'host.invalid_request' }); }
function unavailable(message, reason = 'identity_unavailable') { return Object.assign(new Error(message), { code: 'credential_unavailable', noticeReason: reason }); }
const key = (harness, id) => `${harness}:${id}`;
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));

export function noticeOptions(input) {
  if (input === undefined || input === null || input === false) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw refusal('notices config is an object');
  const allowed = new Set(['harnesses', ...Object.keys(NOTICE_DEFAULTS)]);
  for (const name of Object.keys(input)) if (!allowed.has(name)) throw refusal(`unknown notices setting ${name}`);
  if (!Array.isArray(input.harnesses) || input.harnesses.length < 1 || input.harnesses.length > 32
    || input.harnesses.some((h) => typeof h !== 'string' || !HARNESS.test(h)) || new Set(input.harnesses).size !== input.harnesses.length) {
    throw refusal('notices harnesses is a unique list of 1 to 32 harness names');
  }
  const out = { ...NOTICE_DEFAULTS, ...input, harnesses: [...input.harnesses] };
  const ranges = { pollIntervalMs: [1000, 3600_000], count: [1, 50], leaseSeconds: [10, 3600], maxMessages: [1, 100_000], maxBytes: [MAX_NOTICE_BYTES, 1024 * 1024 * 1024], retentionMs: [7 * DAY, 90 * DAY] };
  for (const [name, [lo, hi]] of Object.entries(ranges)) if (!Number.isSafeInteger(out[name]) || out[name] < lo || out[name] > hi) throw refusal(`notices ${name} must be an integer from ${lo} to ${hi}`);
  if (!['none', 'notify'].includes(out.wakeClass)) throw refusal('notices wakeClass is none or notify; external notices never cold-start a Soul');
  return Object.freeze(out);
}

function contentOf(notice) {
  if (!notice || typeof notice !== 'object' || Array.isArray(notice) || typeof notice.id !== 'string' || !ID.test(notice.id)
    || typeof notice.lease !== 'string' || !notice.lease.startsWith(`${notice.id}.`) || notice.lease.length > 1024
    || !/^[A-Za-z0-9_-]+$/.test(notice.lease.slice(notice.id.length + 1))) throw refusal('identity service returned an invalid notice or lease');
  const content = { id: notice.id };
  // Lease tokens, attempts and lease expiry are transport state, never mailbox
  // content. A source cannot choose its provenance, wake class or authority.
  for (const field of FIELDS) if (Object.hasOwn(notice, field)) {
    const value = notice[field];
    if (field === 'type') {
      if (!Array.isArray(value) || value.length > 10 || value.some((x) => typeof x !== 'string' || x.length > 64)) throw refusal('identity service returned invalid notice types');
    } else if (['number', 'createdAt'].includes(field)) {
      if (!Number.isSafeInteger(value) || value < 0) throw refusal(`identity service returned invalid notice ${field}`);
    } else if (typeof value !== 'string') throw refusal(`identity service returned invalid notice ${field}`);
    content[field] = structuredClone(value);
  }
  if (bytes(content) > MAX_NOTICE_BYTES) throw refusal('identity service notice exceeds the mailbox message limit');
  return content;
}

function checkedReply(reply) {
  if (!reply || !Number.isInteger(reply.status) || reply.status < 200 || reply.status >= 300) throw unavailable('identity service notice request was refused');
  const body = reply.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw unavailable('identity service returned no notice response');
  return body;
}

// Timers are injected by tests; an actual plugin uses bounded, unref'd timers.
// start/stop can repeat. A stopped generation never writes custody or sends
// an ack after a late network response, and simultaneous pulls share one pass.
export function createNoticePump({ store, identityService, events, log, clock, options, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const config = noticeOptions(options);
  let active = false;
  let generation = 0;
  let pending;
  let pendingEpoch;
  let timer;
  let failures = 0;
  let revoked = false;
  let last = null;
  let lastFailure = null;

  const harnessOf = (harness) => {
    if (!config?.harnesses.includes(harness)) throw refusal('notice queue is not configured for this harness');
    return harness;
  };
  const live = (epoch) => active && epoch === generation && !revoked;
  const rows = async (harness) => {
    harnessOf(harness);
    return store.tx((tx) => tx.list(TABLE).map(([, row]) => row).filter((r) => r.harness === harness && r.state === 'ready'));
  };
  const prune = (tx, now) => {
    for (const [id, row] of tx.list(TABLE)) {
      // Unconsumed messages never silently disappear. Consumed rows remain as
      // dedup tombstones longer than the service's seven-day queue retention.
      if (row.state === 'consumed' && row.consumed_at + config.retentionMs <= now) tx.delete(TABLE, id);
    }
  };
  async function custody(harness, content, epoch) {
    const digest = createHash('sha256').update(JSON.stringify(content)).digest('hex');
    return store.tx((tx) => {
      if (!live(epoch)) return null;
      const now = clock.now();
      prune(tx, now);
      const id = key(harness, content.id);
      const previous = tx.get(TABLE, id);
      if (previous) {
        if (previous.content_digest !== digest) throw refusal('a notice ID was reused for different content');
        return { message: previous, duplicate: true };
      }
      const next = (tx.get(META, 'sequence') ?? 0) + 1;
      if (!Number.isSafeInteger(next)) throw refusal('notice mailbox sequence exhausted');
      const message = { message_id: content.id, harness, sequence: next, received_at: now, state: 'ready', provenance: ['external-untrusted'], wake_class: config.wakeClass, content_digest: digest, notice: content };
      const stored = tx.list(TABLE);
      if (stored.length >= config.maxMessages || stored.reduce((n, [, r]) => n + bytes(r), bytes(message)) > config.maxBytes) throw unavailable('HQ notice mailbox is full; upstream lease remains unacknowledged', 'mailbox_full');
      tx.put(TABLE, id, message);
      tx.put(META, 'sequence', next);
      return { message, duplicate: false };
    });
  }
  async function pass(epoch) {
    const result = { received: 0, committed: 0, duplicates: 0, acknowledged: 0 };
    for (const harness of config.harnesses) {
      if (!live(epoch)) break;
      const body = checkedReply(await identityService.call('POST', ROUTES[0], { harness, count: config.count, lease_seconds: config.leaseSeconds, type: 'discussion,issue,pr,review,comment' }));
      if (!live(epoch)) break;
      if (body.harness !== harness || !Array.isArray(body.notices) || body.notices.length > config.count) throw unavailable('identity service returned a different or invalid notice queue');
      // Validate the whole batch before acknowledging any part of it.
      const batch = body.notices.map((notice) => ({ content: contentOf(notice), lease: notice.lease }));
      for (const { content, lease } of batch) {
        if (!live(epoch)) break;
        const held = await custody(harness, content, epoch);
        if (!held || !live(epoch)) break;
        result.received += 1;
        result[held.duplicate ? 'duplicates' : 'committed'] += 1;
        if (!held.duplicate) {
          try { events.publish('notices.custody', { harness, message_id: content.id, sequence: held.message.sequence, provenance: ['external-untrusted'], wake_class: config.wakeClass }); }
          catch { log.warn('notice custody notification unavailable; read the durable mailbox', { reason: 'notification_unavailable' }); }
        }
        if (!live(epoch)) break;
        // A network error here never rolls back custody. On lease expiry the
        // next take repeats this record, dedups, and acknowledges its new lease.
        const ack = checkedReply(await identityService.call('POST', ROUTES[1], { harness, ids: [lease] }));
        if (!live(epoch)) break;
        const categories = [ack.acked, ack.stale, ack.missing];
        if (categories.some((ids) => !Array.isArray(ids)) || categories.flat().length !== 1 || categories.flat()[0] !== content.id) throw unavailable('identity service returned an invalid notice acknowledgement');
        result.acknowledged += ack.acked.length;
      }
    }
    return result;
  }
  function schedule(epoch) {
    if (!live(epoch)) return;
    clearTimer(timer);
    const delay = failures ? Math.min(60_000, 1000 * (2 ** Math.min(failures - 1, 6))) : config.pollIntervalMs;
    timer = setTimer(() => { timer = undefined; pull().catch(() => {}); }, delay);
    timer?.unref?.();
  }
  function pull() {
    if (!config || !active || revoked) return Promise.reject(unavailable(revoked ? 'device revoked: re-enroll before pulling notices' : 'notice ingestion is not running'));
    if (pending && pendingEpoch === generation) return pending;
    clearTimer(timer);
    const epoch = generation;
    pendingEpoch = epoch;
    const run = pass(epoch).then((result) => {
      if (live(epoch)) { failures = 0; lastFailure = null; last = { at: clock.now(), ...result }; }
      return result;
    }, (error) => {
      if (live(epoch)) {
        failures += 1;
        revoked = error?.code === 'device_revoked';
        lastFailure = revoked ? 'device_revoked' : error?.noticeReason === 'mailbox_full' ? 'mailbox_full' : 'ingestion_unavailable';
        // Never log an upstream body, lease token, notice text or exception
        // message. It may contain an untrusted payload or a credential.
        log.warn('notice ingestion paused', { code: revoked ? 'device_revoked' : 'credential_unavailable', reason: lastFailure });
      }
      throw error;
    }).finally(() => { if (pending === run) pending = undefined; schedule(epoch); });
    pending = run;
    return pending;
  }
  return Object.freeze({
    start() {
      if (!config || active) return;
      active = true; revoked = false; failures = 0; lastFailure = null; generation += 1;
      // Do not wait on the uplink to start the broker or admit local work.
      pull().catch(() => {});
    },
    stop() { active = false; generation += 1; clearTimer(timer); timer = undefined; },
    pull,
    reconnect: pull,
    list: rows,
    async acknowledge(harness, ids) {
      harnessOf(harness);
      if (!Array.isArray(ids) || ids.length > 100 || ids.some((id) => typeof id !== 'string' || !ID.test(id))) throw refusal('notice acknowledgement names up to 100 message IDs');
      return store.tx((tx) => {
        const acked = [];
        for (const id of new Set(ids)) {
          const row = tx.get(TABLE, key(harness, id));
          if (!row) continue;
          tx.put(TABLE, key(harness, id), { message_id: row.message_id, harness, sequence: row.sequence, received_at: row.received_at, content_digest: row.content_digest, state: 'consumed', consumed_at: row.consumed_at ?? clock.now() });
          acked.push(id);
        }
        prune(tx, clock.now());
        return { acked };
      });
    },
    status: () => ({ configured: Boolean(config), running: active, revoked, failures, lastFailure, last }),
  });
}
