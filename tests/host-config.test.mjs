import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { readHostConfig } from '../lib/host-config.mjs';
import { brokerPaths, clientPaths } from '../lib/paths.mjs';
import { installOptions } from '../lib/broker/launchagent.mjs';
import { withBroker } from './helpers/broker.mjs';

const defaults = JSON.parse(readFileSync(new URL('../lib/host-defaults.json', import.meta.url), 'utf8'));

test('legacy names and directories remain defaults, including empty overrides', () => {
  const host = readHostConfig({ AGENT_COMMS_SERVICE_LABEL: '', AGENT_COMMS_LOG_DIR: '' }, '/example');
  assert.equal(host.serviceLabel, 'dev.qwts.agent-comms.broker');
  assert.equal(host.credentialName, 'qwts.GeniusBar.principal');
  assert.equal(host.logDir, '/example/Library/Logs/agent-comms');
  assert.equal(host.brokerStateDir, '/example/.local/state/agent-comms-broker');
  assert.equal(host.clientStateDir, '/example/.local/state/agent-comms');
  assert.equal(host.sharedDir, '/Users/Shared/Public/agent-comms');
  assert.deepEqual(host.environment, {});
  assert.ok(Object.isFrozen(host));
});

test('all host directories resolve centrally and survive launchd without its shell environment', () => {
  const env = {
    AGENT_COMMS_SERVICE_LABEL: 'org.example.helper',
    AGENT_COMMS_CREDENTIAL_NAME: 'org.example.owner',
    AGENT_COMMS_LOG_DIR: 'host logs',
    AGENT_COMMS_SHARED_DIR: 'host shared',
    AGENT_COMMS_BROKER_STATE_DIR: 'host broker',
    AGENT_COMMS_CLIENT_STATE_DIR: 'host client',
  };
  const host = readHostConfig(env);
  const options = installOptions({ env, gidOf: () => 800, group: 'agents' });
  assert.equal(options.label, host.serviceLabel);
  assert.throws(() => installOptions({ env: { AGENT_COMMS_SERVICE_LABEL: 'agents' }, group: 'agents', gidOf: () => 800 }), { code: 'usage' });
  assert.equal(options.logDir, path.resolve('host logs'));
  assert.equal(brokerPaths(env).state, path.resolve('host broker'));
  assert.equal(brokerPaths(env).shared, path.resolve('host shared'));
  assert.equal(clientPaths(env).dir, path.resolve('host client'));
  assert.deepEqual(readHostConfig(options.environment), host);
  assert.equal(options.environment.AGENT_COMMS_CREDENTIAL_NAME, env.AGENT_COMMS_CREDENTIAL_NAME);
  const xdg = readHostConfig({ XDG_STATE_HOME: 'custom state' });
  assert.equal(xdg.brokerStateDir, path.resolve('custom state/agent-comms-broker'));
  assert.equal(xdg.clientStateDir, path.resolve('custom state/agent-comms'));
  assert.deepEqual(readHostConfig(xdg.environment), xdg);
});

test('names cannot inject paths, launchctl domains, or keychain commands', () => {
  for (const variable of ['AGENT_COMMS_SERVICE_LABEL', 'AGENT_COMMS_CREDENTIAL_NAME']) {
    for (const value of ['../escape', '/absolute', 'two words', 'name\ncommand', '-option', 'a"b', "a'b", 'a\\b']) {
      assert.throws(() => readHostConfig({ [variable]: value }), { code: 'usage' });
    }
  }
});

test('executable code contains no host app name or duplicated compatibility names', () => {
  for (const dir of ['lib', 'bin']) {
    for (const file of readdirSync(new URL(`../${dir}/`, import.meta.url), { recursive: true })) {
      if (!file.endsWith('.mjs')) continue;
      const code = readFileSync(new URL(`../${dir}/${file}`, import.meta.url), 'utf8');
      assert.doesNotMatch(code, /GeniusBar/i, file);
      for (const name of Object.values(defaults)) assert.ok(!code.includes(name), file);
    }
  }
});

test('CLI install, status, principal pair, and uninstall use only host-selected names', async () => {
  await withBroker(async ({ root, env, cli }) => {
    // Intercept only OS commands in the child, keeping the CLI, filesystem,
    // principal pairing protocol, and broker real. Never touch a login item
    // or the test runner account's keychain, on any platform.
    const preload = path.join(root, 'platform.mjs');
    const capture = path.join(root, 'commands.jsonl');
    writeFileSync(preload, `
      import cp from 'node:child_process';
      import os from 'node:os';
      import { appendFileSync } from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      os.homedir = () => ${JSON.stringify(root)};
      const record = (value) => appendFileSync(${JSON.stringify(capture)}, JSON.stringify(value) + '\\n');
      cp.execFileSync = (file, args) => {
        record({ file, args });
        if (file === '/usr/bin/dscl') return 'PrimaryGroupID: 800';
        if (file === '/bin/launchctl') return 'state = running\\npid = 123\\nlabel = org.example.helper';
        throw new Error('unexpected executable: ' + file);
      };
      cp.spawnSync = (file, args, options) => {
        if (file !== '/usr/bin/security') throw new Error('unexpected executable: ' + file);
        record({ file, args, input: options.input });
        return { status: 0, stderr: '' };
      };
      syncBuiltinESMExports();
    `);
    const custom = {
      ...env,
      NODE_OPTIONS: `--import=${preload}`,
      AGENT_COMMS_SERVICE_LABEL: 'org.example.helper',
      AGENT_COMMS_CREDENTIAL_NAME: 'org.example.owner',
      AGENT_COMMS_LOG_DIR: path.join(root, 'host logs'),
      AGENT_COMMS_NO_KEYCHAIN: '0',
    };
    const run = async (args) => {
      const result = await cli(args, undefined, custom);
      assert.equal(result.exit, 0, JSON.stringify(result));
      return result.json;
    };
    const installed = await run(['broker', 'install', '--group', 'agents']);
    assert.equal(installed.label, custom.AGENT_COMMS_SERVICE_LABEL);
    assert.equal(installed.logDir, custom.AGENT_COMMS_LOG_DIR);
    assert.equal(installed.plist, path.join(root, 'Library/LaunchAgents/org.example.helper.plist'));
    const plist = readFileSync(installed.plist, 'utf8');
    for (const key of ['AGENT_COMMS_SERVICE_LABEL', 'AGENT_COMMS_CREDENTIAL_NAME', 'AGENT_COMMS_LOG_DIR', 'AGENT_COMMS_SHARED_DIR', 'AGENT_COMMS_BROKER_STATE_DIR', 'AGENT_COMMS_CLIENT_STATE_DIR']) {
      assert.ok(plist.includes(custom[key]), key);
    }
    assert.ok(plist.includes(path.join(custom.AGENT_COMMS_LOG_DIR, 'broker.log')));
    assert.ok(plist.includes(path.join(custom.AGENT_COMMS_LOG_DIR, 'broker.err.log')));
    const status = await run(['broker', 'status']);
    assert.equal(status.label, custom.AGENT_COMMS_SERVICE_LABEL);
    assert.equal(status.running, true);
    assert.equal(status.socket.path, path.join(env.AGENT_COMMS_SHARED_DIR, 'broker.sock'));
    await run(['principal', 'pair', '--name', 'Example']);
    assert.ok(existsSync(path.join(env.AGENT_COMMS_CLIENT_STATE_DIR, 'principal.json')));
    const removed = await run(['broker', 'uninstall']);
    assert.equal(removed.label, custom.AGENT_COMMS_SERVICE_LABEL);
    assert.equal(existsSync(installed.plist), false);
    const records = readFileSync(capture, 'utf8');
    const calls = records.trim().split('\n').map(JSON.parse);
    assert.ok(calls.some(({ input }) => input?.startsWith('add-generic-password -U -s org.example.owner -a principal -X ')));
    assert.ok(calls.some(({ args }) => args[0] === 'print' && args[1] === `gui/${process.getuid()}/org.example.helper`));
    assert.equal(calls.filter(({ args }) => args[0] === 'bootout' && args[1] === `gui/${process.getuid()}/org.example.helper`).length, 2);
    for (const name of Object.values(defaults)) {
      assert.ok(![plist, records, JSON.stringify(installed), JSON.stringify(status), JSON.stringify(removed)].join('\n').includes(name));
    }
    assert.equal(existsSync(path.join(root, 'Library/LaunchAgents', `${defaults.serviceLabel}.plist`)), false);
    assert.equal(existsSync(path.join(root, 'Library/Logs/agent-comms')), false);
  });
});
