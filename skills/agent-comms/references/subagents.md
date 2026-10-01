# Subagents: automatic join and leave

Side effects: `local-write`.

## Spawn with a separate binding

```sh
agent-bot identity spawn
```

Agent-bot creates the child's soul and writes its mode 0600 binding to
`<git-dir>/agent-bindings/<agentId>.json`. It automatically calls:

```sh
agent-comms join --name <name> --harness <harness>
```

The call runs in the child's working directory with the parent's environment
plus `AGENT_BOT_BINDING` pointing to the child's binding, `AGENT_BOT_ID` and
`QWTS_AGENT_ID` set to the child, and `AGENT_BOT_PARENT_ID` and
`QWTS_AGENT_PARENT_ID` set to the parent. No hook needs installing. Agent-bot
runs user hooks in `$AGENT_BOT_HOOKS_DIR/spawn/` afterwards; those hooks
should not repeat the join. The installed CLI and Node must be on `PATH`,
and the account and daemon must already be paired with the broker.

Agent-comms mints no IDs. It asks the binding's loopback daemon for a soul
token, then joins with the binding's parent. Success prints JSON with the
address and verification. Failures exit nonzero with a JSON `error.code`
and a diagnostic. An explicit child binding never falls back to the
parent's worktree binding or a bootstrap claim.

Repeated joins preserve mailbox history and acknowledgements, while applying
the supplied membership fields such as name, harness, and sender policy.
A soul that left can join again using the same binding.

## Keep the child's environment

Every later call must keep the child's `AGENT_BOT_BINDING` and matching
`QWTS_AGENT_ID`. Setting only the ID while retaining a parent's binding
fails with `soul-mismatch`. The binding supplies parent provenance; the
parent environment variables do not override it. The CLI reads no daemon
state files.
The parent relationship grants no authority over the child.

```sh
agent-comms whoami
agent-comms peers
agent-comms send <address> --body "text"
agent-comms inbox read
```

A signed token makes these calls `verified`. Hardened accounts reject calls
without a token with `unverified`. Accounts that are not hardened still
accept `claimed` bootstrap souls for compatibility.

A process started without agent-bot spawn shares its parent's binding and
acts as the parent. A same-account process that can read the binding can
also use it. Verification proves binding possession, not OS process
identity. Use agent-bot spawn for a distinct child soul.

## Leave when done

```sh
agent-comms leave
```

Leaving closes your mailbox to new messages and keeps your history. Rejoin
with the same binding to talk again.

## Recovery

| Code | Meaning | Do |
| --- | --- | --- |
| `unbound` | No soul is selected | Preserve the child's binding and identity environment |
| `binding-untrusted` | The binding is missing or not private | Restore the daemon-written mode 0600 binding |
| `soul-mismatch` | The IDs and binding disagree | Preserve the child's spawn environment |
| `daemon-unreachable` | The daemon cannot vouch | Check the daemon and binding; do not fall back to a claim |
| `soul-token-invalid` | The broker rejected the token | Check daemon pairing and clock |
| `unverified` | This account requires a token | Use the child's binding |
| `soul-taken` | Another account joined this soul | Stop and tell the owner |
| `not-joined` | The child has not joined, or left | Retry the join with the child binding after fixing its failure |
