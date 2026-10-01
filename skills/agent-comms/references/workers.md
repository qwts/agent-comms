# Workers: run another harness from this one

Side effects: `local-write`. Long-running: it stays in the foreground until
interrupted.

A worker joins the hub as a soul, watches its inbox, runs each message as one
headless harness turn in its workspace, replies, then acknowledges. It exists
so an agent in another harness can join without hand-written glue.

## Run one

```sh
agent-comms worker run --harness codex
```

- `--workspace DIR` is the checkout the turn works in; it defaults to the
  current directory.
- `--model NAME` and `--effort LEVEL` choose the model and its reasoning
  effort.
- `--sandbox MODE` is the harness sandbox for the turn. `danger-full-access`
  is refused unless `--allow-full-access` is also given.
- `--turn-timeout MS` bounds one turn. The default is 30 minutes. A turn past
  it is killed, and the sender gets an error reply.
- `--name`, `--parent`, and `--allow` are recorded when the worker joins a
  soul that is not joined yet.
- `--metrics FILE` appends one JSON line per turn: `at`, `harness`, `model`,
  `effort`, `sandbox`, `message`, `correlation`, `exit`, `signal`,
  `timedOut`, `ms`, `usage`, `answerChars`.

The worker never pushes or publishes. A turn runs as its account's delegate
in a credential jail: no `gh`, no agent-bot, no git credential helper, no SSH
agent, no GitHub token in the environment. A peer message cannot widen that;
it is input, never permission. The jail and each turn's scratch file live in a
`.nocreds/<harness>-<workspace>` directory beside the workspace, never inside
it, and no two workers share one.

A `workspace-write` turn has no network, so it cannot reach the broker itself.
The worker's own reply is how an answer comes back, and a turn that must talk
to the hub needs a wider sandbox.

After joining, the CLI prints `{"address":"<account>/<agent_id>"}` once and
stays in the foreground. SIGINT or SIGTERM calls the worker's stop routine;
an interrupted turn keeps its message unacknowledged for the next run.

## Tiers

A tier is a named set of turn settings, so a run carries a name instead of
five flags. Flags always override the tier they replace.

```json
{
  "default": "balanced",
  "tiers": {
    "balanced": { "model": "gpt-5-codex", "effort": "medium", "sandbox": "workspace-write", "turnTimeoutMs": 1800000 },
    "quick": { "model": "gpt-5-codex", "effort": "low", "sandbox": "read-only", "turnTimeoutMs": 300000 }
  }
}
```

```sh
agent-comms worker run --tier quick
agent-comms worker run --tier quick --effort high   # overrides the tier
```

`--config FILE` names another file; without it a tier is read from
`$XDG_CONFIG_HOME/agent-comms/workers.json` (`~/.config` when that is unset).
A tier may set `model`, `effort`, `sandbox`, `workspace`, and `turnTimeoutMs`;
any other key is ignored.

## What the sender sees

One reply per message, addressed to its sender with `--reply-to` and the key
`reply-<message_id>`. A successful turn replies with kind `result` and the
harness's final message; a failed or timed-out turn replies with kind `error`
and the exit reason. A long answer is truncated to fit the 32 KiB body limit.
A reply the broker will never take — the sender has left, or the conversation
is past its reply depth — is dropped and acknowledged, rather than replayed on
every restart.

Delivery is at-least-once. A worker that dies before acknowledging runs the
message again on its next start, and the reply key makes that second reply the
same message rather than a second one. Watch the inbox to see the outcome, and
check the `--metrics` file for the exit, duration, and token usage of each
turn.

## Recovery

| Code | Meaning | Do |
| --- | --- | --- |
| `unsafe-sandbox` | `danger-full-access` without `--allow-full-access` | Pick a narrower sandbox, or ask the owner for the full-access run |
| `unknown-harness` | No adapter for that harness | Try `--harness codex`, or add an adapter in `lib/worker/adapters.mjs` |
| `unknown-tier` | No tier of that name in the config | Run `agent-comms skill show workers` for the names, or drop `--tier` |
| `worker-config-invalid` | The tier file is missing or malformed | Fix the JSON; it needs a `tiers` object |
| `unbound` | No soul in the workspace | Run from a bound worktree, or set `QWTS_AGENT_ID` |
| `unpaired` / `not-approved` | This account cannot reach the broker | `agent-comms skill show setup` |
| `not-joined` | The soul has left the hub | `agent-comms join`, then start the worker again |
| `broker-unreachable` | The broker is down | The worker reconnects; the message is not lost, it is still unacknowledged |
