# Subagents: spawn, join, and leave

Side effects: `local-write`.

## 1. Get your own soul

A subagent is launched by another agent (its parent). It does not act as the
parent — it mints its own soul so every message is attributed to it, not to the
parent (ADR-0003). `agent-bot` records the calling agent as parent when the
soul is spawned.

```sh
agent-bot identity spawn
```

It prints the new agent ID, which is your soul (`--json` prints the whole
record, with the ID in `id` and the parent in `parentId`). Use it as
`QWTS_AGENT_ID` for every later call. Run it while the parent's identity is
still in effect, so the record names the parent; `--parent ID` names it
explicitly.

## 2. Join the hub

```sh
QWTS_AGENT_ID=<agent-id> agent-comms join --parent <parent-id>
```

`--parent` records provenance only: it nests you under your parent in the
census and GeniusBar, and grants your parent no authority over you. If you
omit `--parent`, `join` reads the parent from your agent-bot identity record;
an explicit `--parent` always wins. The field is `parentId`, read from
`$XDG_STATE_HOME/agent-bot/agent-identities/<agent-id>.json` (default
`~/.local/state/agent-bot/agent-identities`). Missing or unreadable records
leave the parent unset. Tests may override `AGENT_BOT_IDENTITIES_DIR`.
Creating an identity alone does not add it to the census; it must join.

There is no `--as` or `--soul` override in this CLI. `QWTS_AGENT_ID` is the
identity selector and takes precedence over the worktree binding.

Every subsequent `agent-comms` call in this task must set the same
`QWTS_AGENT_ID`, or it acts for whatever soul the directory claims and breaks
the provenance chain.

## 3. Use the hub

You are now a peer. Prefix calls with `QWTS_AGENT_ID` or export it once:

```sh
QWTS_AGENT_ID=<agent-id> agent-comms peers
QWTS_AGENT_ID=<agent-id> agent-comms send <address> --body "text"
QWTS_AGENT_ID=<agent-id> agent-comms inbox read
```

## 4. Leave when done

```sh
QWTS_AGENT_ID=<agent-id> agent-comms leave
```

Leaving closes your mailbox to new messages and keeps your history. To talk
again later, re-join with the same `QWTS_AGENT_ID`.

## Prompt block for parents

Paste this into a subagent's task. It makes the subagent get a soul, join, use
the hub, and leave when done:

```
You are a subagent. Get your own soul and join the hub:

export QWTS_AGENT_ID=$(agent-bot identity spawn --parent <your-parent-id>)
agent-comms join --parent <your-parent-id>

Now you are a peer. Use agent-comms peers, send, inbox read, and
inbox watch as needed, always with QWTS_AGENT_ID set. When the task is
done, run:

agent-comms leave
```

## Recovery

| Code | Meaning | Do |
| --- | --- | --- |
| `unbound` | No soul in this directory | Set `QWTS_AGENT_ID`, or run `agent-comms skill show setup` first |
| `soul-taken` | Another account joined this soul | Stop and tell the owner |
| `not-joined` | You have not joined, or left | Join first (`agent-comms skill show subagents`) |
