#!/usr/bin/env node

// agent-comms: the one command every harness calls (ADR-0002 decision 6).
// stdout carries one JSON document, or JSON Lines for `inbox watch`;
// diagnostics go to stderr; every failure exits non-zero with a stable code.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import process from 'node:process';

import { Broker } from '../lib/broker.mjs';
import { admin, call, loadCredential, pair, resolveSoul, stream } from '../lib/client.mjs';
import { CommsError, fail } from '../lib/errors.mjs';
import { brokerPaths, clientPaths } from '../lib/paths.mjs';
import * as skill from '../lib/skill.mjs';

const VERSION = '0.1.0';

const HELP = `agent-comms ${VERSION}: messages between agents on this machine

Usage:
  agent-comms join [--name NAME] [--harness NAME] [--parent AGENT_ID] [--allow LIST]
  agent-comms leave
  agent-comms whoami
  agent-comms peers
  agent-comms send TO (--body TEXT | --body-file FILE | --body-file -)
                   [--kind KIND] [--key KEY] [--reply-to MESSAGE_ID] [--correlation ID]
  agent-comms inbox read [--after CURSOR] [--limit N]
  agent-comms inbox watch          streams JSON Lines until interrupted
  agent-comms inbox ack MESSAGE_ID...
  agent-comms account pair | account status
  agent-comms broker run [--group GROUP] | broker pairings
  agent-comms broker approve CODE | broker revoke ACCOUNT
  agent-comms skill | skill list | skill show FEATURE | skill path
  agent-comms --version

TO is <account>/<agent_id> or a bare agent_id. The soul is QWTS_AGENT_ID or
the worktree's agentBot.agentId; in this release it is a claim, and the
broker verifies only the account. Read \`agent-comms skill\` before first use.
`;

const VALUE_FLAGS = new Set([
  'name', 'harness', 'parent', 'allow', 'body', 'body-file', 'kind', 'key', 'reply-to', 'correlation',
  'after', 'limit', 'group',
]);

function parse(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--') || arg === '--') {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (VALUE_FLAGS.has(name)) {
      const value = inline ?? argv[(i += 1)];
      if (value === undefined) fail('usage', `--${name} needs a value`);
      flags[name] = value;
    } else if (['help', 'version'].includes(name)) {
      flags[name] = true;
    } else {
      fail('usage', `unknown option --${name}`);
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

function groupId(name) {
  if (/^\d+$/.test(name)) return Number(name);
  try {
    // macOS keeps groups in Directory Services, not /etc/group.
    const out = execFileSync('/usr/bin/dscl', ['.', '-read', `/Groups/${name}`, 'PrimaryGroupID'], { encoding: 'utf8' });
    const id = out.match(/PrimaryGroupID:\s*(\d+)/)?.[1];
    if (id) return Number(id);
  } catch {
    // not macOS, or no such group
  }
  try {
    const line = readFileSync('/etc/group', 'utf8').split('\n').find((entry) => entry.startsWith(`${name}:`));
    if (line) return Number(line.split(':')[2]);
  } catch {
    // no /etc/group
  }
  return fail('usage', `cannot resolve group ${name}; pass its numeric id`);
}

const print = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

async function run(argv, env) {
  const { positional, flags } = parse(argv);
  const [command, sub, ...rest] = positional;
  const paths = brokerPaths(env);
  const client = clientPaths(env);

  if (flags.version) return process.stdout.write(`agent-comms ${VERSION}\n`);
  if (flags.help || !command) return process.stdout.write(HELP);

  const asSoul = (request) => call(paths, loadCredential(client), { ...request, agentId: resolveSoul(env) });

  switch (command) {
    case 'whoami': {
      const credential = loadCredential(client);
      return print({ ok: true, account: credential.account, agentId: resolveSoul(env), verification: 'claimed' });
    }
    case 'join': {
      const allow = flags.allow === undefined ? null : flags.allow.split(',').map((entry) => entry.trim()).filter(Boolean);
      return print(await asSoul({
        op: 'join', name: flags.name ?? null, harness: flags.harness ?? null, parent: flags.parent ?? null, allow,
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
        return stream(paths, credential, { op: 'watch', agentId: resolveSoul(env) }, (event) => {
          process.stdout.write(`${JSON.stringify(event)}\n`);
        });
      }
      return fail('usage', 'inbox needs read, watch, or ack');
    }
    case 'account': {
      if (sub === 'pair') {
        const result = await pair(paths, client);
        process.stderr.write(`Ask the owner to approve this pairing: agent-comms broker approve ${result.code}\n`);
        return print(result);
      }
      if (sub === 'status') return print(await call(paths, loadCredential(client), { op: 'pair-status' }));
      return fail('usage', 'account needs pair or status');
    }
    case 'broker': {
      if (sub === 'run') {
        const broker = await new Broker({ paths, gid: flags.group === undefined ? null : groupId(flags.group) }).start();
        process.stderr.write(`agent-comms broker listening on ${paths.socket}\n`);
        const shutdown = () => broker.stop().then(() => process.exit(0));
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
        return undefined;
      }
      if (sub === 'pairings') return print(await admin(paths, { op: 'pairings' }));
      if (sub === 'approve') return print(await admin(paths, { op: 'approve', code: rest[0] }));
      if (sub === 'revoke') return print(await admin(paths, { op: 'revoke', account: rest[0] }));
      return fail('usage', 'broker needs run, pairings, approve, or revoke');
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
  print({ ok: false, error: { code, message: error.message } });
  process.stderr.write(`agent-comms: ${error.message}\n`);
  process.exit(code === 'usage' ? 2 : 1);
});
