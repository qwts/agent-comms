#!/usr/bin/env node

// agent-comms: the one command every harness calls (ADR-0002 decision 6).
// stdout carries one JSON document, or JSON Lines for `inbox watch`;
// diagnostics go to stderr; every failure exits non-zero with a stable code.

import { groupId } from '../lib/platform/account-isolation.mjs';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import process from 'node:process';

import { Broker } from '../lib/broker.mjs';
import { install, installOptions, jobOptions, status, uninstall } from '../lib/broker/launchagent.mjs';
import { admin, call, loadCredential, pair, pairPrincipal, callPrincipal, loadPrincipalCredential, resolveParent, soulContext, vouch, watch } from '../lib/client.mjs';
import { HOST_CONFIG } from '../lib/host-config.mjs';
import { CommsError, fail } from '../lib/errors.mjs';
import { brokerPaths, clientPaths } from '../lib/paths.mjs';
import { taskEventPlan } from '../lib/worker/task-turn.mjs';
import { taskPrompt } from '../lib/worker/prompt.mjs';
import { runWorker } from '../lib/worker/index.mjs';
import { sha256 } from '../lib/broker/shared.mjs';
import * as skill from '../lib/skill.mjs';

const VERSION = '0.3.5';

// Each row owns its positional arity and value flags; help uses the same schema.
const COMMANDS = [
  { name: 'join', args: [], flags: ['name', 'harness', 'parent', 'allow'] },
  { name: 'leave', args: [], flags: [] },
  { name: 'whoami', args: [], flags: [] },
  { name: 'peers', args: [], flags: [] },
  { name: 'send', args: ['TO'], flags: ['body', 'body-file', 'kind', 'key', 'reply-to', 'correlation'] },
  { name: 'inbox read', args: [], flags: ['after', 'limit'] },
  { name: 'inbox watch', args: [], flags: [], booleans: ['full'] },
  { name: 'inbox ack', args: ['MESSAGE_ID'], variadic: true, flags: [] },
  { name: 'task offer', args: ['TO'], flags: ['criteria', 'parent', 'dependencies', 'related-task'] },
  { name: 'task accept', args: ['TASK_ID'], flags: ['revision'] },
  { name: 'task reject', args: ['TASK_ID'], flags: ['revision'] },
  { name: 'task update', args: ['TASK_ID', 'STATE'], flags: ['revision'] },
  { name: 'task cancel', args: ['TASK_ID'], flags: ['revision'] },
  { name: 'task show', args: ['TASK_ID'], flags: [] },
  { name: 'task invocation', args: ['TASK_ID'], flags: ['id', 'phase', 'outcome'] },
  { name: 'task brief', args: ['MESSAGE_ID'], flags: [] },
  { name: 'task list', args: [], flags: ['state', 'after', 'limit'] },
  { name: 'worker run', args: [], flags: ['harness', 'workspace', 'model', 'effort', 'sandbox', 'turn-timeout', 'metrics', 'tier', 'config', 'name', 'parent', 'allow'], booleans: ['allow-full-access'] },
  { name: 'principal pair', args: [], flags: ['name'] },
  { name: 'admin principals', args: [], flags: [] },
  { name: 'admin principal-approve', args: ['CODE'], flags: ['grant'] },
  { name: 'admin principal-revoke', args: ['PRINCIPAL'], flags: [] },
  { name: 'a2a route add', args: ['NAME'], flags: ['url', 'credential-file', 'tenant', 'souls'] },
  { name: 'a2a route remove', args: ['NAME'], flags: [] },
  { name: 'a2a route list', args: [], flags: [] },
  { name: 'a2a send', args: ['ROUTE'], flags: ['text', 'context-id', 'related-task'] },
  { name: 'a2a outbound-show', args: ['REQUEST_ID'], flags: [] },
  { name: 'a2a outbound-list', args: [], flags: ['after', 'limit'] },
  { name: 'a2a cancel', args: ['REQUEST_ID'], flags: [] },
  { name: 'a2a configure', args: [], flags: ['config-file'] },
  { name: 'a2a enroll', args: ['PRINCIPAL'], flags: ['token-file', 'souls', 'operations'] },
  { name: 'a2a revoke', args: ['TOKEN_HASH'], flags: [] },
  { name: 'a2a list', args: [], flags: [] },
  { name: 'a2a serve-status', args: [], flags: [] },
  { name: 'census', args: [], flags: [] },
  { name: 'health', args: [], flags: [] },
  { name: 'account pair', args: [], flags: ['broker'] },
  { name: 'account pairings', args: [], flags: [] },
  { name: 'account approve', args: ['CODE'], flags: [] },
  { name: 'account revoke', args: ['ACCOUNT'], flags: ['kind'] },
  { name: 'account harden', args: ['ACCOUNT'], flags: [], booleans: ['off'] },
  { name: 'account status', args: [], flags: [] },
  { name: 'broker run', args: [], flags: ['group'], booleans: ['single-account'] },
  { name: 'broker install', args: [], flags: ['group'], booleans: ['single-account'] },
  { name: 'broker uninstall', args: [], flags: [] },
  { name: 'broker status', args: [], flags: ['group'] },
  { name: 'broker pairings', args: [], flags: [] },
  { name: 'broker approve', args: ['CODE'], flags: [] },
  { name: 'broker revoke', args: ['ACCOUNT'], flags: [] },
  { name: 'skill', args: [], flags: [] },
  { name: 'skill list', args: [], flags: [] },
  { name: 'skill show', args: ['FEATURE'], flags: [] },
  { name: 'skill path', args: [], flags: [] },
];

const HELP = `agent-comms ${VERSION}: messages between agents on this machine

Usage:
${COMMANDS.map(({ name, args, variadic, flags, booleans = [] }) =>
    `  agent-comms ${name}${args.map((arg) => ` ${arg}${variadic ? '...' : ''}`).join('')}${flags.map((flag) => ` [--${flag} VALUE]`).join('')}${booleans.map((flag) => ` [--${flag}]`).join('')}`).join('\n')}
  agent-comms --help
  agent-comms --version

send requires --body TEXT or --body-file FILE (use - for stdin).
inbox watch streams JSON Lines until interrupted. --json is accepted; output is JSON by default.
TO is <account>/<agent_id> or a bare agent_id. Souls come from a daemon binding
when present, otherwise from the bootstrap claim. Read \`agent-comms skill\` before first use.
`;

function parse(argv) {
  const positional = [];
  const flags = {};
  const valueFlags = new Set(COMMANDS.flatMap((command) => command.flags));
  const booleanFlags = new Set(['help', 'version', 'json', ...COMMANDS.flatMap((command) => command.booleans ?? [])]);
  let literal = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!literal && arg === '--') {
      literal = true;
      continue;
    }
    if (literal || !arg.startsWith('-') || arg === '-') {
      positional.push(arg);
      continue;
    }
    if (!arg.startsWith('--')) fail('usage', `unknown option ${arg}`);
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (valueFlags.has(name)) {
      const value = inline ?? argv[(i += 1)];
      if (value === undefined || (inline === undefined && value.startsWith('--'))) fail('usage', `--${name} needs a value`);
      flags[name] = value;
    } else if (booleanFlags.has(name)) {
      if (inline !== undefined) fail('usage', `--${name} takes no value`);
      flags[name] = true;
    } else {
      fail('usage', `unknown option --${name}`);
    }
  }
  const schema = COMMANDS.find((entry) => entry.name === positional.slice(0, 3).join(' '))
    ?? COMMANDS.find((entry) => entry.name === positional.slice(0, 2).join(' '))
    ?? COMMANDS.find((entry) => entry.name === positional[0]);
  if (positional.length && !schema) fail('usage', `unknown command ${positional[0]}; see agent-comms --help`);
  for (const flag of Object.keys(flags)) {
    // Global flags work after any command; JSON is the default output.
    if (flag === 'help' || flag === 'version' || flag === 'json') continue;
    if (!schema?.flags.includes(flag) && !schema?.booleans?.includes(flag)) fail('usage', `unknown option --${flag} for ${schema?.name ?? 'agent-comms'}`);
  }
  if (schema && !flags.help && !flags.version) {
    const count = positional.length - schema.name.split(' ').length;
    if (count < schema.args.length || (!schema.variadic && count > schema.args.length)) {
      fail('usage', `${schema.name} expects ${schema.args.join(' ') || 'no positional arguments'}${schema.variadic ? '...' : ''}`);
    }
  }
  return { positional, flags };
}

const integer = (value, name) => {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number)) fail('usage', `--${name} must be an integer`);
  return number;
};

function readBody(flags) {
  if (flags.body !== undefined && flags['body-file'] !== undefined) fail('usage', 'use --body or --body-file, not both');
  if (flags.body !== undefined) return flags.body;
  if (flags['body-file'] === '-') return readFileSync(0, 'utf8');
  if (flags['body-file'] !== undefined) return readFileSync(flags['body-file'], 'utf8');
  return fail('usage', 'send needs --body or --body-file');
}

const print = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

// inbox watch speaks JSON Lines, and a reader of its stream (the worker's watch
// child among them) parses one line at a time, so its final error has to be one
// line too or the refusal it carries is never seen.
let jsonLines = false;

async function run(argv, env) {
  const { positional, flags } = parse(argv);
  const [command, sub, ...rest] = positional;
  jsonLines = command === 'inbox' && sub === 'watch';
  const paths = brokerPaths(env, HOST_CONFIG);
  const client = clientPaths(env, HOST_CONFIG);

  if (flags.version) return process.stdout.write(`agent-comms ${VERSION}\n`);
  if (flags.help || !command) return process.stdout.write(HELP);

  const asSoul = async (request) => {
    const context = soulContext(env);
    const soulToken = await vouch(context);
    const payload = request.op === 'join' && request.parent == null ? { ...request, parent: context.parent } : request;
    return call(paths, loadCredential(client), { ...payload, agentId: context.agentId, ...(soulToken ? { soulToken } : {}) });
  };

  switch (command) {
    case 'whoami': {
      const context = soulContext(env);
      return print({ ...(await asSoul({ op: 'whoami' })), soul: context.agentId, source: context.source });
    }
    case 'join': {
      const allow = flags.allow === undefined ? null : flags.allow.split(',').map((entry) => entry.trim()).filter(Boolean);
      return print(await asSoul({
        op: 'join', name: flags.name ?? null, harness: flags.harness ?? null, parent: flags.parent ?? resolveParent(env), allow,
      }));
    }
    case 'leave': return print(await asSoul({ op: 'leave' }));
    case 'peers': return print(await asSoul({ op: 'peers' }));
    case 'send': {
      if (!sub) fail('usage', 'send needs a recipient address');
      return print(await asSoul({
        op: 'send',
        to: sub,
        body: readBody(flags),
        kind: flags.kind ?? 'message',
        key: flags.key ?? randomUUID(),
        replyTo: flags['reply-to'] ?? null,
        correlation: flags.correlation ?? null,
      }));
    }
    case 'inbox': {
      if (sub === 'read') {
        return print(await asSoul({ op: 'read', after: integer(flags.after, 'after'), limit: integer(flags.limit, 'limit') }));
      }
      if (sub === 'ack') {
        if (!rest.length) fail('usage', 'inbox ack needs at least one message id');
        return print(await asSoul({ op: 'ack', ids: rest }));
      }
      if (sub === 'watch') {
        const credential = loadCredential(client);
        const controller = new AbortController();
        const cancel = () => controller.abort();
        process.on('SIGINT', cancel);
        process.on('SIGTERM', cancel);
        try {
          const context = soulContext(env);
          const soulToken = await vouch(context);
          return await watch(paths, credential, { op: 'watch', agentId: context.agentId, ...(soulToken ? { soulToken } : {}), mode: flags.full ? 'full' : 'wake' }, (event) => {
            process.stdout.write(`${JSON.stringify(event)}\n`);
          }, { signal: controller.signal });
        } finally {
          process.off('SIGINT', cancel);
          process.off('SIGTERM', cancel);
        }
      }
      return fail('usage', 'inbox needs read, watch, or ack');
    }
    case 'task': {
      let request;
      if (sub === 'offer') {
        if (!flags.criteria?.trim()) fail('usage', 'task offer needs --criteria TEXT');
        request = { op: 'task-offer', to: rest[0], acceptanceCriteria: flags.criteria,
          parent: flags.parent, relatedTask: flags['related-task'],
          dependencies: flags.dependencies === undefined ? [] : flags.dependencies.split(',') };
      } else if (sub === 'list') {
        request = { op: 'task-list', state: flags.state, after: integer(flags.after, 'after'), limit: integer(flags.limit, 'limit') };
      } else if (sub === 'invocation') {
        if (!flags.id || !['started', 'ended'].includes(flags.phase)
          || (flags.phase === 'started' ? flags.outcome !== undefined : !['completed', 'failed', 'cancelled', 'interrupted'].includes(flags.outcome))) {
          fail('usage', 'task invocation needs --id ID --phase started|ended and --outcome for ended only');
        }
        request = { op: 'task-invocation', taskId: rest[0], invocationId: flags.id, phase: flags.phase, outcome: flags.outcome };
      } else if (sub === 'brief') {
        let message;
        let after = 0;
        for (;;) {
          const page = await asSoul({ op: 'read', after, limit: 100 });
          message = page.messages.find((item) => item.id === rest[0]);
          if (message || !page.remaining) break;
          after = page.cursor;
        }
        if (!message) fail('unknown-message', 'no pending message with that id in your mailbox');
        if (message.kind !== 'task-event') fail('bad-request', 'task brief needs a task-event message');
        let shown;
        try {
          shown = await asSoul({ op: 'task-show', taskId: message.correlation });
        } catch (error) {
          if (error.code !== 'unknown-task') throw error;
        }
        const self = await asSoul({ op: 'whoami' });
        const plan = taskEventPlan(message, shown?.task, self);
        return print({ ...plan, taskId: message.correlation,
          prompt: plan.turn ? taskPrompt({ ...shown, role: plan.role, harness: 'harness', soul: self.agentId }) : null });
      } else if (sub === 'show') {
        request = { op: 'task-show', taskId: rest[0] };
      } else {
        const revision = integer(flags.revision, 'revision');
        if (!Number.isSafeInteger(revision) || revision < 1) fail('usage', 'task transition needs --revision INTEGER greater than zero');
        if (sub === 'update' && !['accepted', 'working', 'input-required', 'completed', 'failed', 'rejected', 'canceled'].includes(rest[1])) {
          fail('usage', 'unknown task state');
        }
        request = { op: `task-${sub}`, taskId: rest[0], revision, ...(sub === 'update' ? { state: rest[1] } : {}) };
      }
      return print(await asSoul(request));
    }
    case 'worker': {
      const worker = runWorker({
        env, harness: flags.harness, workspace: flags.workspace, model: flags.model, effort: flags.effort,
        sandbox: flags.sandbox, turnTimeoutMs: integer(flags['turn-timeout'], 'turn-timeout'),
        metrics: flags.metrics, tier: flags.tier, config: flags.config, allowFullAccess: flags['allow-full-access'],
        name: flags.name, parent: flags.parent ?? resolveParent(env),
        allow: flags.allow === undefined ? null : flags.allow.split(',').map((entry) => entry.trim()).filter(Boolean),
      });
      let stopping;
      const stop = () => (stopping ??= worker.stop());
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      try {
        const address = await worker.ready;
        if (stopping) await worker.stop();
        else process.stdout.write(`${JSON.stringify({ address })}\n`);
      } catch (error) {
        await worker.stop();
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        throw error;
      }
      return undefined;
    }
    case 'principal': {
      const result = await pairPrincipal(paths, client, flags.name, env, HOST_CONFIG);
      process.stderr.write(`Ask the owner to approve this pairing: agent-comms admin principal-approve ${result.code}\n`);
      return print({ ok: true, ...result });
    }
    case 'admin': {
      if (sub === 'principals') return print(await admin(paths, { op: 'principals' }));
      if (sub === 'principal-approve') return print(await admin(paths, {
        op: 'principal-approve', code: rest[0],
        grant: flags.grant === undefined ? null : flags.grant.split(',').map((entry) => entry.trim()).filter(Boolean),
      }));
      return print(await admin(paths, { op: 'principal-revoke', principal: rest[0] }));
    }
    case 'a2a': {
      if (sub === 'route') {
        const [action, name] = rest;
        return print(await admin(paths, { op: `a2a-route-${action}`, name,
          ...(action === 'add' ? { route: { name, url: flags.url, credentialFile: flags['credential-file'],
            tenant: flags.tenant, allowedSouls: flags.souls?.split(',') } } : {}) }));
      }
      if (sub === 'send') return print(await asSoul({ op: 'a2a-send', route: rest[0], text: flags.text,
        contextId: flags['context-id'], relatedTask: flags['related-task'] }));
      if (sub === 'outbound-show' || sub === 'cancel') return print(await asSoul({ op: `a2a-${sub}`, id: rest[0] }));
      if (sub === 'outbound-list') return print(await asSoul({ op: 'a2a-outbound-list',
        after: integer(flags.after, 'after'), limit: integer(flags.limit, 'limit') }));
      if (sub === 'configure') {
        if (!flags['config-file']) fail('usage', 'configure needs --config-file FILE');
        return print(await admin(paths, { op: 'a2a-configure', config: JSON.parse(readFileSync(flags['config-file'], 'utf8')) }));
      }
      if (sub === 'enroll') {
        if (!flags['token-file'] || !flags.souls || !flags.operations) fail('usage', 'enroll needs --token-file, --souls and --operations');
        const token = readFileSync(flags['token-file'], 'utf8').trim();
        if (token.length < 32 || /\s/.test(token)) fail('usage', 'token must be at least 32 characters without whitespace');
        return print(await admin(paths, { op: 'a2a-enroll', principal: rest[0], tokenHash: sha256(token),
          souls: flags.souls.split(','), operations: flags.operations.split(',') }));
      }
      return print(await admin(paths, { op: `a2a-${sub}`, ...(sub === 'revoke' ? { tokenHash: rest[0] } : {}) }));
    }
    case 'census':
    case 'health': return print(await callPrincipal(paths, loadPrincipalCredential(client, HOST_CONFIG), { op: command }));
    case 'account': {
      if (sub === 'pair') {
        // Naming a broker account means the multi-account broker; with none
        // named there is no other account, so the broker is this account's own.
        const brokerAccount = flags.broker ?? env.AGENT_COMMS_BROKER_ACCOUNT;
        const mode = env.AGENT_COMMS_MODE ?? (brokerAccount ? 'group' : 'single-account');
        const result = await pair(paths, client, brokerAccount, undefined, mode);
        process.stderr.write(`Ask the owner to approve this pairing: agent-comms broker approve ${result.code}\n`);
        return print(result);
      }
      if (sub === 'pairings') return print(await admin(paths, { op: 'pairings' }));
      if (sub === 'approve') return print(await admin(paths, { op: 'approve', code: rest[0] }));
      if (sub === 'revoke') return print(await admin(paths, { op: 'revoke', account: rest[0], kind: flags.kind }));
      if (sub === 'harden') return print(await admin(paths, { op: 'harden', account: rest[0], off: flags.off }));
      if (sub === 'status') return print(await call(paths, loadCredential(client), { op: 'pair-status' }));
      return fail('usage', 'account needs pair, status, pairings, approve, revoke, or harden');
    }
    case 'broker': {
      if (sub === 'install') return print(install(installOptions({ group: flags.group, mode: flags['single-account'] || !flags.group ? 'single-account' : 'group', host: HOST_CONFIG })));
      if (sub === 'uninstall') return print(uninstall(jobOptions({ host: HOST_CONFIG })));
      if (sub === 'status') return print(await status({
        ...jobOptions({ paths, host: HOST_CONFIG }), group: flags.group,
        listPairings: () => admin(paths, { op: 'pairings' }),
        listDaemonWatches: () => admin(paths, { op: 'daemon-watches' }),
      }));
      if (sub === 'run') {
        const mode = flags['single-account'] ? 'single-account' : (flags.group ? 'group' : 'single-account');
        const broker = await new Broker({ paths, mode, gid: flags.group === undefined ? null : groupId(flags.group) }).start();
        process.stderr.write(`agent-comms broker listening on ${paths.socket}\n`);
        const shutdown = () => broker.stop().then(() => process.exit(0));
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
        return undefined;
      }
      if (sub === 'pairings') return print(await admin(paths, { op: 'pairings' }));
      if (sub === 'approve') return print(await admin(paths, { op: 'approve', code: rest[0] }));
      if (sub === 'revoke') return print(await admin(paths, { op: 'revoke', account: rest[0] }));
      return fail('usage', 'broker needs run, install, uninstall, status, pairings, approve, or revoke');
    }
    case 'skill': {
      if (!sub) return process.stdout.write(skill.router());
      if (sub === 'list') return print({ ok: true, features: skill.list() });
      if (sub === 'show') return process.stdout.write(skill.show(rest[0]));
      if (sub === 'path') return print({ ok: true, ...skill.location() });
      return fail('usage', 'skill takes list, show FEATURE, or path');
    }
    default:
      return fail('usage', `unknown command ${command}; see agent-comms --help`);
  }
}

run(process.argv.slice(2), process.env).catch((error) => {
  const code = error instanceof CommsError ? error.code : 'internal';
  const failure = { ok: false, error: { code, message: error.message } };
  if (jsonLines) process.stdout.write(`${JSON.stringify(failure)}\n`);
  else print(failure);
  process.stderr.write(`agent-comms: ${error.message}\n`);
  process.exit(code === 'usage' ? 2 : 1);
});
