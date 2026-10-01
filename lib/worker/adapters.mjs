// One adapter per harness. Each one says which binary to run, where its final
// message lands, and how a turn's arguments are built, so joining another
// harness is a new entry here rather than a branch in the worker loop.
//
// Codex is the tested default; the rest are shipped from the prototype and are
// exercised only by the adapter table test.

import { fail } from '../errors.mjs';

const flag = (name, value) => (value ? [name, value] : []);

export const ADAPTERS = Object.freeze({
  codex: {
    cmd: 'codex',
    // `codex exec -o FILE` writes its final message to the file.
    answer: 'file',
    args: ({ prompt, out, workspace, model, effort, sandbox }) => [
      'exec', '--json', '--sandbox', sandbox, '-C', workspace, '--skip-git-repo-check', '-o', out,
      ...flag('-m', model),
      ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : []),
      prompt,
    ],
  },
  copilot: {
    cmd: 'copilot',
    answer: 'stdout',
    args: ({ prompt, workspace, model }) => [
      '-p', prompt, '--allow-all-tools', '--disable-builtin-mcps', '-C', workspace, ...flag('--model', model),
    ],
  },
  'command-code': {
    cmd: 'cmd',
    answer: 'stdout',
    args: ({ prompt, model }) => ['-p', prompt, '--yolo', '--max-turns', '80', ...flag('-m', model)],
  },
  opencode: {
    cmd: 'opencode',
    answer: 'stdout',
    args: ({ prompt, workspace, model }) => ['run', '--auto', '--dir', workspace, ...flag('-m', model), prompt],
  },
  devin: {
    cmd: 'devin',
    answer: 'stdout',
    args: ({ prompt, model }) => ['-p', prompt, '--permission-mode', 'dangerous', ...flag('--model', model)],
  },
  grok: {
    cmd: 'grok',
    answer: 'stdout',
    args: ({ prompt, workspace, model }) => [
      '-p', prompt, '--cwd', workspace, '--permission-mode', 'bypassPermissions', ...flag('--model', model),
    ],
  },
  qwen: {
    cmd: 'qwen',
    answer: 'stdout',
    args: ({ prompt, model }) => [prompt, '--approval-mode', 'yolo', ...flag('-m', model)],
  },
  muse: {
    cmd: 'muse',
    answer: 'stdout',
    args: ({ prompt, model }) => ['exec', prompt, '--yolo', '--trust-workspace', ...flag('--model', model)],
  },
});

export const HARNESSES = Object.freeze(Object.keys(ADAPTERS));

export function adapterFor(name, adapters = ADAPTERS) {
  const adapter = adapters[name];
  if (!adapter) fail('unknown-harness', `no adapter for harness ${name}; try one of ${Object.keys(adapters).join(', ')}`);
  return { name, ...adapter };
}
