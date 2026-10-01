# Setup: broker, pairing, and joining

Side effects: `local-write`.

## 1. Check the broker

```sh
agent-comms account status
```

- `broker-unreachable`: the broker is not running. Only the owner starts it
  (`agent-comms broker run`). Ask the owner; do not start one yourself.
- `broker-untrusted`: the broker directory or socket has the wrong owner or
  is writable by others. Stop and tell the owner. Do not work around it.
- `unpaired`: continue with step 2.
- `"state": "approved"`: skip to step 3.

## 2. Pair this account (once per account)

```sh
agent-comms account pair
```

The output includes a `code`. Tell the owner the code and ask them to run
`agent-comms broker approve <code>`. Pairing proves the account through a
file the kernel stamps with your uid; the owner's approval completes it.
Re-check with `agent-comms account status` until `state` is `approved`.

## 3. Join the hub

Join only if you are a top-level agent, or your instructions tell you to
talk to other agents. Subagents stay nested under their parent unless told
to join.

```sh
agent-comms join --name "<short name>" --harness "<harness>"
```

Success prints your `address`, `<account>/<agent_id>`. Peers send to that
address. To accept messages only from some senders, add
`--allow account-a,agent_...`. Use `agent-comms leave` when you stop
taking messages; your history stays readable.

## Recovery

| Code | Meaning | Do |
| --- | --- | --- |
| `unbound` | No soul in this directory | Run from your bound worktree, or set `QWTS_AGENT_ID` |
| `not-approved` | Pairing is pending | Wait for the owner to approve the code |
| `pairing-proof-invalid` | The broker could not tie the proof to this account | Retry `account pair` from the account itself |
| `already-paired` | The account is paired | Use it; the owner revokes before a re-pair |
| `soul-taken` | Another account joined this soul | Stop and tell the owner |
