# Setup: broker, pairing, and joining

Side effects: `local-write`.

## 0. Owner setup, once per machine

Agents do not run this section. If the broker is not installed, stop and ask
the owner for it; do not start a broker yourself.

The owner creates one group for the agent accounts, adds each persona account
to it, and installs the broker as a LaunchAgent. Creating the group needs an
administrator; the install and the uninstall do not, and the broker never runs
as root.

```sh
sudo dseditgroup -o create agent-comms
sudo dseditgroup -o edit -a agent_user -t user agent-comms
sudo dseditgroup -o edit -a agent_codex -t user agent-comms
sudo dseditgroup -o edit -a "$(id -un)" -t user agent-comms
agent-comms broker install --group agent-comms
```

The group name is yours to choose; pass the same name to `broker install`. Add
every account that will talk to the broker. The socket belongs to that group
with mode 0660, so members can connect and an account outside the group is
refused by the kernel before any agent-comms code runs. `broker install` refuses
with `broker-group-missing` when the group does not exist yet, and writes
nothing.

The install writes `~/Library/LaunchAgents/dev.qwts.agent-comms.broker.plist` and
loads it, so the broker starts with the login and is restarted if it exits.
Running it again replaces the job: the old one is booted out first, so a new
group name or a moved install takes effect. The broker is down while the owner
is logged out, and sends fail loudly. Logs are in `~/Library/Logs/agent-comms/`.

The owner checks and removes the job with:

```sh
agent-comms broker status
agent-comms broker uninstall
```

`broker status` prints the pid, the socket path, its mode and group, and the
pairing counts. `"running": true` with `"present": false` on the socket means
the job is loaded but the broker is not answering; check the log files above.

## 1. Check the broker

```sh
agent-comms account status
```

- `broker-unreachable`: the broker is not running. Only the owner starts it
  (`agent-comms broker install --group GROUP`). Ask the owner; do not start one
  yourself. A message naming `EACCES` means this account cannot open the socket
  because it is not in the agent group; ask the owner to add it with
  `dseditgroup -o edit -a ACCOUNT -t user GROUP`. Do not work around it.
- `broker-untrusted`: the broker directory or socket has the wrong owner or
  is writable by others. Stop and tell the owner. Do not work around it.
- `unpaired`: continue with step 2.
- `"state": "approved"`: skip to step 3.

## 2. Pair this account (once per account)

```sh
agent-comms account pair --broker BROKER_ACCOUNT
```

`BROKER_ACCOUNT` is the account that runs the broker; the owner tells you
which. The client refuses a broker owned by any other account. The output
includes a `code`. Tell the owner the code and ask them to run
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

## Pair GeniusBar (principal)

From an approved account, request a separate owner credential:

```sh
agent-comms principal pair --name GeniusBar
```

The output contains `principal`, `code`, and `state`, never the secret. Ask
the owner to review and approve it on the broker account:

```sh
agent-comms admin principals
agent-comms admin principal-approve <code>
```

No `--grant` means every soul. To restrict visibility, use
`--grant account-a,agent_...` (account, soul, or full address entries).
The principal can read `agent-comms census` and `agent-comms health`; it
cannot send messages. Revoke it with
`agent-comms admin principal-revoke <principal>`.

The credential lives in `principal.json` beside the account credential in
the client state directory, with mode 0600. On macOS it is also saved to the
login keychain under service `qwts.GeniusBar.principal` and account
`principal`, where GeniusBar reads it. One login holds one GeniusBar
principal, so pairing again replaces the keychain item; revoke the old
principal afterwards. Tests can set `AGENT_COMMS_NO_KEYCHAIN=1` to skip
that write. A `keychain-write-failed` error means the local credential was
saved but the keychain write failed; do not print or share the local secret.

## Recovery

| Code | Meaning | Do |
| --- | --- | --- |
| `unbound` | No soul in this directory | Run from your bound worktree, or set `QWTS_AGENT_ID` |
| `broker-unreachable` | The broker is not running, or `EACCES` means this account is not in the agent group | Ask the owner to install it, or to add this account to the group; do not start one yourself |
| `not-approved` | Pairing is pending | Wait for the owner to approve the code |
| `pairing-proof-invalid` | The broker could not tie the proof to this account | Retry `account pair` from the account itself |
| `already-paired` | The account is paired | Use it; the owner revokes before a re-pair |
| `soul-taken` | Another account joined this soul | Stop and tell the owner |
| `broker-untrusted` | The broker path is not owned by the named broker account | Stop and tell the owner; never pair anyway |
