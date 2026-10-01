// The credential jail. A harness turn runs as its account's delegate
// (ENG-0339): the owner delegates work, never the ability to push, so the
// turn must find no GitHub or git credential path at all. The jail is a
// directory of stubs and overrides that the turn's environment points at.

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Matched by prefix rather than listed one by one, so a credential variable
// added to agent-bot later cannot slip past a name this file never saw.
const SECRET = /^(GH_|GITHUB_|COPILOT_GITHUB_TOKEN|QWTS_|AGENT_BOT|CLAUDE|AI_AGENT)/;

// agent-bot mints installation tokens on demand through its own shim, so it
// has to fail in a turn however the turn reaches it.
const STUBBED = ['agent-bot', 'gh'];

const STUB = (tool) => `#!/bin/sh\necho "${tool}: no credentials in a harness worker" >&2\nexit 1\n`;

// GIT_CONFIG_GLOBAL does not reach a helper or hook set in repo or worktree
// config, so the same four overrides have to be injected as GIT_CONFIG_* pairs.
const OVERRIDES = [['credential.helper', ''], ['agentBot.app', ''], ['agentBot.agentId', '']];

// Two workers in sibling checkouts, or two harnesses in one checkout, must not
// share a jail: opencode keeps one database per data dir and would lock the
// other worker out of its own.
export const defaultJailRoot = (harness, workspace) => path.join(
  path.dirname(workspace), '.nocreds', `${harness}-${path.basename(workspace)}`,
);

export function buildJail({ harness, workspace, env = process.env, root = defaultJailRoot(harness, workspace) }) {
  const bin = path.join(root, 'bin');
  const hooks = path.join(root, 'hooks');
  const zdot = path.join(root, 'zdot');
  const gitconfig = path.join(root, 'gitconfig');
  for (const dir of [root, bin, hooks, zdot]) mkdirSync(dir, { recursive: true });
  writeFileSync(gitconfig, '[user]\n\tname = harness worker\n\temail = worker@localhost\n');
  for (const tool of STUBBED) writeFileSync(path.join(bin, tool), STUB(tool), { mode: 0o755 });
  // ~/.zshenv puts agent-bot back on PATH in every zsh the harness spawns, so
  // harness shells get an empty profile directory instead.
  writeFileSync(path.join(zdot, '.zshenv'), '');

  const overrides = [...OVERRIDES, ['core.hooksPath', hooks]];
  const harnessEnv = { ...env };
  for (const key of Object.keys(harnessEnv)) if (SECRET.test(key)) delete harnessEnv[key];
  delete harnessEnv.SSH_AUTH_SOCK;
  delete harnessEnv.BASH_ENV;
  Object.assign(harnessEnv, {
    PATH: [bin, ...(env.PATH ?? '').split(path.delimiter).filter((dir) => dir && !dir.includes('agent-bot'))].join(path.delimiter),
    GH_CONFIG_DIR: root,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: '/usr/bin/false',
    GIT_CONFIG_COUNT: String(overrides.length),
    ...Object.fromEntries(overrides.flatMap(([key, value], i) => [[`GIT_CONFIG_KEY_${i}`, key], [`GIT_CONFIG_VALUE_${i}`, value]])),
    ZDOTDIR: zdot,
  });

  if (harness === 'opencode') {
    // opencode keeps one SQLite database per data dir, so concurrent workers
    // lock each other out; each gets its own, carrying only the auth file.
    const data = path.join(root, 'xdg-data', 'opencode');
    mkdirSync(data, { recursive: true });
    const auth = path.join(env.HOME ?? '', '.local', 'share', 'opencode', 'auth.json');
    if (existsSync(auth)) copyFileSync(auth, path.join(data, 'auth.json'));
    harnessEnv.XDG_DATA_HOME = path.join(root, 'xdg-data');
  }

  return { root, bin, hooks, env: harnessEnv };
}
