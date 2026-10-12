import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createWatchDelivery } from '../lib/broker/watch.mjs';

class Socket extends EventEmitter {
  destroyed = false;
  writable = true;
  events = [];
  write(line) { this.events.push(JSON.parse(line)); return true; }
  destroy() { this.destroyed = true; this.writable = false; }
  closed() { this.destroy(); this.emit('close'); }
}
function fixture({ limits, unacked = () => [] } = {}) {
  const key = generateKeyPairSync('ed25519').publicKey;
  const broker = { state: { pairings: new Map([['owner', { state: 'approved' }]]),
    daemons: new Map([['owner', { state: 'approved', epoch: 1, publicKey: key.export({ type: 'spki', format: 'pem' }) }]]),
    souls: new Map() }, accountWatchers: new Map(), watchers: new Map(), limits };
  const watches = createWatchDelivery(broker, () => ({}), unacked, () => {});
  const open = (request = {}) => { const socket = new Socket(); watches.accountWatch(request, socket, { account: 'owner' }); return socket; };
  return { broker, watches, open, key };
}

test('watch identity is broker generated, unique, immutable and bound to exact SPKI', () => {
  const { watches, open, key } = fixture();
  const one = open({ watchId: 'chosen', daemonEpoch: 99, daemonKey: 'chosen' });
  const two = open();
  const first = one.events[0];
  assert.deepEqual(Object.keys(first).sort(), ['daemonEpoch', 'daemonKey', 'event', 'watchId']);
  assert.equal(first.event, 'ready');
  assert.equal(first.daemonEpoch, 1);
  assert.equal(first.daemonKey, createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex'));
  assert.match(first.watchId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.notEqual(first.watchId, two.events[0].watchId);
  const selected = watches.selectAccountWatch('owner');
  assert.equal(selected.socket, one);
  assert.equal(Object.isFrozen(selected.binding), true);
  assert.throws(() => { selected.binding.watchId = 'other'; }, TypeError);
  one.closed();
  assert.equal(watches.accountWatchBinding(selected.socket), null);
  assert.equal(watches.selectAccountWatch('owner').socket, two);
  // Explicit fresh selection cannot change the original request's selection.
  assert.equal(selected.socket, one);
  assert.equal(watches.accountWatchBinding(new Socket()), null);
});

test('current pairing, epoch, key, membership and writable state independently invalidate selection', () => {
  for (const mutate of [
    (b) => { b.state.pairings.get('owner').state = 'revoked'; },
    (b) => { b.state.daemons.get('owner').state = 'revoked'; },
    (b) => { b.state.daemons.get('owner').epoch++; },
    (b) => { b.state.daemons.get('owner').publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }); },
    (b) => { b.accountWatchers.delete('owner'); },
    (_b, s) => { s.writable = false; },
    (_b, s) => { s.destroy(); },
  ]) {
    const { broker, watches, open } = fixture();
    const socket = open();
    assert.ok(watches.accountWatchBinding(socket));
    mutate(broker, socket);
    assert.equal(watches.accountWatchBinding(socket), null);
    assert.equal(watches.selectAccountWatch('owner'), null);
  }
});

test('late old-stream close after rotation cannot erase replacement watch set', () => {
  const { broker, watches, open } = fixture();
  const old = open();
  watches.revokeDaemon('owner');
  broker.state.daemons.get('owner').epoch++;
  const replacement = open();
  old.closed();
  assert.equal(watches.selectAccountWatch('owner').socket, replacement);
  assert.equal(watches.accountWatchBinding(old), null);
  assert.equal(replacement.events[0].daemonEpoch, 2);
  assert.notEqual(replacement.events[0].watchId, old.events[0].watchId);
  replacement.closed();
  assert.equal(watches.selectAccountWatch('owner'), null);
});


test('account rate holds merge separate windows with conservative sticky trace context', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  const trace = '00-11111111111111111111111111111111-2222222222222222-01';
  const other = '00-33333333333333333333333333333333-4444444444444444-01';
  for (const contexts of [[trace, trace], [trace, other], [trace, undefined], [undefined, trace], [trace, other, trace]]) {
    const waiting = [];
    const { broker, watches, open } = fixture({
      limits: { wakeWindowMs: 100, wakeRateMs: 1000 }, unacked: () => waiting,
    });
    const soul = 'agent-held';
    broker.state.souls.set(soul, { agentId: soul, account: 'owner', joined: true });
    broker.state.mailboxMeta = new Map();
    broker.state.messages = new Map();
    broker.state.mailboxes = new Map();
    const socket = open();
    const notify = (id, context) => {
      const message = { id, seq: waiting.length + 1 };
      waiting.push(message);
      watches.delivery(soul, message, context).notify(message);
    };
    const wakes = () => socket.events.filter(event => event.event === 'wake');
    notify('initial', trace);
    t.mock.timers.tick(100);
    assert.equal(wakes().length, 1);
    assert.equal(wakes()[0].traceparent, trace);
    waiting.length = 0;
    for (const [index, context] of contexts.entries()) {
      notify(`held-${index}`, context);
      // Flush each distinct coalescing window while the same rate hold remains armed.
      t.mock.timers.tick(100);
      assert.equal(wakes().length, 1);
    }
    t.mock.timers.tick(1000 - contexts.length * 100 - 1);
    assert.equal(wakes().length, 1, 'hold cannot release before the rate boundary');
    t.mock.timers.tick(1);
    const held = wakes()[1];
    assert.equal(wakes().length, 2);
    assert.equal(held.count, contexts.length);
    assert.deepEqual(held.messageIds, contexts.map((_, index) => `held-${index}`));
    assert.equal(held.cursor, 1);
    assert.equal(Object.hasOwn(held, 'traceparent'), contexts.every(context => context === trace));
    if (Object.hasOwn(held, 'traceparent')) assert.equal(held.traceparent, trace);
    socket.closed();
    t.mock.timers.tick(1000);
    assert.equal(wakes().length, 2, 'closing the stream leaves no further wake');
  }
});
