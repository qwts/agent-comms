import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Broker } from '../lib/broker.mjs';
import { createA2A, wireTask } from '../lib/broker/a2a.mjs';
import { createMailbox } from '../lib/broker/mailbox.mjs';
import { createPairing } from '../lib/broker/pairing.mjs';
import { createTasks } from '../lib/broker/tasks.mjs';
import { sha256 } from '../lib/broker/shared.mjs';
import { apply, EventLog } from '../lib/state.mjs';
import { withBroker } from './helpers/broker.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ac-a2a-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let at = Date.now();
  const broker = new Broker({ paths: { state: root }, mode: 'single-account', now: () => (at += 3000) });
  const log = new EventLog(root);
  const commit = (record) => { log.append(record); apply(broker.state, record); };
  const soul = `agent_${randomUUID()}`;
  const principal = `principal_${randomUUID()}`;
  commit({ t: 'pair-request', account: 'owner', hash: sha256('secret') });
  commit({ t: 'pair-approve', account: 'owner' });
  commit({ t: 'join', account: 'owner', agentId: soul, allow: null });
  commit({ t: 'principal-request', principal, hash: sha256('principal secret') });
  commit({ t: 'principal-approve', principal, grant: [soul] });
  const watches = { delivery: () => ({ wake: 'waiting', notify: () => {} }) };
  const pairing = createPairing(broker, commit, watches);
  const mailbox = createMailbox(broker, commit, pairing, watches);
  const tasks = createTasks(broker, commit, mailbox, pairing);
  const operate = (principal, payload) => {
    const request = pairing.inboundRequest(principal, payload);
    return ({ 'task-offer': tasks.offer, 'task-show': tasks.show, 'task-list': tasks.list,
      'task-cancel': (request) => tasks.transition({ ...request, state: 'canceled' }) })[request.op](request);
  };
  const gateway = createA2A(broker, operate);
  const address = `owner/${soul}`;
  const config = { enabled: true, host: '127.0.0.1', port: 0,
    skills: [{ id: 'review', soul: address, name: 'Review', description: 'Review work', tags: ['review'] }] };
  gateway.admin({ op: 'a2a-configure', config });
  const token = '0123456789abcdef'.repeat(4);
  const enroll = (extra = {}) => gateway.admin({ op: 'a2a-enroll', tokenHash: sha256(token), principal,
    souls: [address], operations: ['SendMessage', 'GetTask', 'CancelTask', 'ListTasks'], ...extra });
  enroll();
  const headers = { authorization: `Bearer ${token}`, 'a2a-version': '1.0' };
  const request = (method, params = {}, extraHeaders = {}) => gateway.dispatch({ ...headers, ...extraHeaders }, 'review', { jsonrpc: '2.0', id: 1, method, params });
  const message = { messageId: 'external-1', role: 'user', parts: [{ text: 'Review café', mediaType: 'text/plain', metadata: { source: 'test' } }] };
  return { root, broker, log, commit, soul, principal, address, gateway, config, token, headers, enroll, request, message, tasks, pairing };
}

test('A2A conformance: card, SendMessage, GetTask, ListTasks and CancelTask', (t) => {
  const f = fixture(t);
  const card = f.gateway.card(f.config.skills[0]);
  assert.equal(card.protocolVersion, '1.0');
  assert.equal(card.preferredTransport, 'JSONRPC');
  assert.deepEqual(card.security, [{ bearer: [] }]);
  assert.equal(card.securitySchemes.bearer.scheme, 'bearer');
  assert.deepEqual(card.skills.map((skill) => skill.id), ['review']);
  assert.deepEqual(card.capabilities, { streaming: false, pushNotifications: false });
  const sent = f.request('SendMessage', { message: { ...f.message, contextId: 'remote/context' } });
  assert.equal(sent.status, 200);
  const task = sent.body.result;
  assert.equal(task.kind, 'task');
  assert.equal(task.contextId, 'remote/context');
  assert.equal(task.status.state, 'submitted');
  assert.equal(task.metadata.localState, 'offered');
  assert.deepEqual(task.history[0].parts, f.message.parts);
  assert.equal(f.log.replay().tasks.get(task.id).a2a.contextId, 'remote/context');
  assert.equal(f.broker.state.tasks.get(task.id).acceptanceCriteria, 'Review café');
  assert.deepEqual(f.request('GetTask', { id: task.id }).body.result, task);
  assert.deepEqual(f.request('GetTask', { id: task.id, historyLength: 0 }).body.result.history, []);
  assert.deepEqual(f.request('ListTasks').body.result, { tasks: [task], nextPageToken: '' });
  assert.equal(f.request('CancelTask', { id: task.id }).body.result.status.state, 'canceled');
  assert.equal(f.request('CancelTask', { id: task.id }).body.error.code, -32002);
  assert.equal(f.request('GetTask', { id: 'missing' }).body.error.code, -32001);
  assert.equal(f.request('GetTask', { id: task.id, historyLength: -1 }).body.error.code, -32602);
  const second = f.request('SendMessage', { message: f.message }).body.result;
  assert.ok(second.contextId.startsWith('context_'));
  const page = f.request('ListTasks', { pageSize: 1 }).body.result;
  assert.equal(page.nextPageToken, '1');
  assert.equal(f.request('ListTasks', { pageToken: '1' }).body.result.tasks[0].id, second.id);
  for (const [state, wire] of [['accepted', 'working'], ['input-required', 'input-required'], ['auth-required', 'auth-required'], ['failed', 'failed']]) {
    assert.equal(wireTask({ ...f.broker.state.tasks.get(task.id), state }).status.state, wire);
  }
});

test('refusals precede work: identity, permissions, grants, receive policy and revocation', (t) => {
  const f = fixture(t);
  const send = () => f.request('SendMessage', { message: f.message });
  for (const authorization of [undefined, 'Bearer unknown', 'Basic secret']) {
    assert.equal(f.request('SendMessage', { message: f.message }, { authorization }).status, 401);
  }
  f.enroll({ operations: ['GetTask'] });
  assert.equal(send().status, 403);
  f.enroll({ souls: [] });
  assert.equal(send().status, 403);
  f.enroll();
  f.commit({ t: 'principal-approve', principal: f.principal, grant: [] });
  assert.equal(send().body.error.code, -32004);
  f.commit({ t: 'principal-approve', principal: f.principal, grant: [f.soul] });
  f.broker.state.souls.get(f.soul).allow = [];
  assert.equal(send().body.error.code, -32004);
  f.broker.state.souls.get(f.soul).allow = null;
  f.gateway.admin({ op: 'a2a-revoke', tokenHash: sha256(f.token) });
  assert.equal(send().status, 401);
  f.enroll();
  f.commit({ t: 'principal-revoke', principal: f.principal });
  assert.equal(send().status, 401);
  assert.equal(f.broker.state.tasks.size, 0);
  assert.equal(f.broker.state.messages.size, 0);
});

test('version, parts and extensions fail visibly; wire fields cannot forge authentication', (t) => {
  const f = fixture(t);
  assert.equal(f.request('SendMessage', { message: f.message }, { 'a2a-version': '1.1' }).body.error.code, -32009);
  assert.equal(f.request('Other').body.error.code, -32601);
  assert.equal(f.gateway.dispatch(f.headers, 'review', []).body.error.code, -32600);
  for (const part of [{ file: { uri: 'file:///secret' } }, { data: { permission: 'all' } }, { text: 'x', mediaType: 'text/html' }]) {
    assert.equal(f.request('SendMessage', { message: { ...f.message, parts: [part] } }).body.error.code, -32005);
  }
  assert.equal(f.request('SendMessage', { message: { ...f.message, extensions: ['required'] } }).body.error.code, -32004);
  assert.equal(f.request('SendMessage', { message: f.message }, { 'a2a-extensions': 'required' }).body.error.code, -32004);
  assert.equal(f.request('SendMessage', { message: { ...f.message, taskId: 'existing' } }).body.error.code, -32004);
  assert.equal(f.broker.state.tasks.size, 0);
  assert.throws(() => f.tasks.list({ auth: { principal: f.principal }, inbound: true }), { code: 'unauthenticated' });
  const persisted = readFileSync(path.join(f.root, 'a2a.json'), 'utf8');
  assert.ok(!persisted.includes(f.token));
  assert.equal(statSync(path.join(f.root, 'a2a.json')).mode & 0o777, 0o600);
  assert.throws(() => f.gateway.admin({ op: 'a2a-configure', config: { ...f.config, host: '0.0.0.0' } }), { code: 'bad-request' });
  const replay = createA2A(f.broker, () => assert.fail('must not run'));
  replay.load();
  assert.equal(replay.admin({ op: 'a2a-list' }).callers[sha256(f.token)].principal, f.principal);
});

test('HTTP card, JSON-RPC, parse errors and loopback lifecycle', async (t) => {
  const f = fixture(t);
  t.after(() => f.gateway.stop());
  await f.gateway.start();
  const address = f.gateway.admin({ op: 'a2a-serve-status' }).address;
  assert.equal(address.address, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const card = await (await fetch(`${base}/.well-known/agent-card.json`)).json();
  assert.equal(card.url, `${base}/a2a/review`);
  const post = (body, headers = f.headers) => fetch(card.url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  assert.equal((await post('{}', {})).status, 401);
  assert.equal((await (await post('{')).json()).error.code, -32700);
  const response = await post(JSON.stringify({ jsonrpc: '2.0', id: 'http-1', method: 'SendMessage', params: { message: f.message } }));
  assert.equal(response.headers.get('a2a-version'), '1.0');
  assert.equal((await response.json()).result.status.state, 'submitted');
});

test('admin CLI configures gateway without exposing tokens', async () => {
  await withBroker(async ({ cli, root, owner, accounts }) => {
    const { writeFileSync } = await import('node:fs');
    const pending = await cli(['principal', 'pair', '--name', 'external'], accounts.alice, { AGENT_COMMS_NO_KEYCHAIN: '1' });
    assert.equal(pending.exit, 0);
    await cli(['admin', 'principal-approve', pending.json.code, '--grant', accounts.bob]);
    const configFile = path.join(root, 'gateway.json');
    writeFileSync(configFile, JSON.stringify({ enabled: true, host: '127.0.0.1', port: 0,
      skills: [{ id: 'review', soul: `${owner}/${accounts.bob}`, name: 'Review', description: 'Review', tags: [] }] }));
    assert.equal((await cli(['a2a', 'configure', '--config-file', configFile])).exit, 0);
    const tokenFile = path.join(root, 'token');
    writeFileSync(tokenFile, 'a'.repeat(64), { mode: 0o600 });
    const enrolled = await cli(['a2a', 'enroll', pending.json.principal, '--token-file', tokenFile,
      '--souls', `${owner}/${accounts.bob}`, '--operations', 'SendMessage,GetTask,CancelTask,ListTasks']);
    assert.equal(enrolled.exit, 0);
    assert.equal((await cli(['a2a', 'list'])).json.callers[enrolled.json.tokenHash].principal, pending.json.principal);
    assert.equal((await cli(['a2a', 'serve-status'])).json.listening, false);
    assert.equal((await cli(['a2a', 'revoke', enrolled.json.tokenHash])).exit, 0);
  }, { brokerOptions: { mode: 'single-account' } });
});

test('gateway retains task isolation and shared mailbox rate limits', (t) => {
  const f = fixture(t);
  const task = f.request('SendMessage', { message: f.message }).body.result;
  const other = `principal_${randomUUID()}`;
  f.commit({ t: 'principal-request', principal: other, hash: sha256('other secret') });
  f.commit({ t: 'principal-approve', principal: other, grant: [f.soul] });
  f.enroll({ principal: other });
  assert.equal(f.request('GetTask', { id: task.id }).body.error.code, -32001);
  assert.equal(f.request('CancelTask', { id: task.id }).body.error.code, -32001);
  assert.deepEqual(f.request('ListTasks').body.result.tasks, []);
  f.enroll();
  f.gateway.admin({ op: 'a2a-configure', config: { ...f.config, skills: [...f.config.skills,
    { id: 'other', soul: 'owner/other-soul', name: 'Other', description: 'Other', tags: [] }] } });
  f.enroll({ souls: [f.address, 'owner/other-soul'] });
  const hidden = f.gateway.dispatch(f.headers, 'other', { jsonrpc: '2.0', id: 2, method: 'GetTask', params: { id: task.id } });
  assert.equal(hidden.body.error.code, -32001);
  const before = f.broker.state.messages.size;
  f.broker.limits = { ...f.broker.limits, sendsPerPairPerMinute: 1 };
  assert.equal(f.request('SendMessage', { message: f.message }).body.error.code, -32004);
  assert.equal(f.broker.state.messages.size, before);
  f.broker.limits = { ...f.broker.limits, sendsPerPairPerMinute: 30, unackedPerMailbox: 0 };
  assert.equal(f.request('SendMessage', { message: f.message }).body.error.code, -32004);
  assert.equal(f.broker.state.messages.size, before);
});

test('a socket caller cannot attach A2A wire metadata to a task', (t) => {
  const f = fixture(t);
  const forged = { contextId: 'context_forged', message: { messageId: 'x', role: 'user', parts: [{ text: 'x' }] } };
  const { task } = f.tasks.offer({ auth: { principal: f.principal, secret: 'principal secret' }, to: f.address,
    acceptanceCriteria: 'Do it', a2a: forged });
  assert.equal(task.a2a, undefined);
});
