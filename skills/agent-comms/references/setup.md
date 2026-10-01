# Setup: broker, pairing, and joining

Side effects: `local-write`.

## 0. Owner setup, once per machine

### One account (default)

When every agent runs in the owner's own account, no group or administrator
is needed:

```sh
agent-comms broker install
agent-comms account pair
agent-comms broker approve CODE
```

The broker serves only this account: the rendezvous and proof directories
are 0700 and the socket is 0600. `account pair` with no `--broker` pairs with
this account's own broker. Use the group setup below only when agents run
in separate persona accounts.

### Separate persona accounts

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

`broker status` prints the pid, the socket path, its mode and group, the
pairing counts, and whether each account's daemon is watching.
`"daemons": null` means the broker could not be asked. `"running": true`
with `"present": false` on the socket means the job is loaded but the broker
is not answering; check the log files above.

## Host configuration

A host sets these environment variables before starting the CLI. One host
configuration object supplies the service, stored credential, and directory
names. Unset or empty variables keep existing installations' defaults.

| Variable | Default |
| --- | --- |
| `AGENT_COMMS_SERVICE_LABEL` | `dev.qwts.agent-comms.broker` |
| `AGENT_COMMS_CREDENTIAL_NAME` | `qwts.GeniusBar.principal` |
| `AGENT_COMMS_LOG_DIR` | `~/Library/Logs/agent-comms` |
| `AGENT_COMMS_SHARED_DIR` | `/Users/Shared/Public/agent-comms` |
| `AGENT_COMMS_BROKER_STATE_DIR` | `$XDG_STATE_HOME/agent-comms-broker` |
| `AGENT_COMMS_CLIENT_STATE_DIR` | `$XDG_STATE_HOME/agent-comms` |

`XDG_STATE_HOME` defaults to `~/.local/state`. Directory overrides resolve
relative to the CLI's working directory; use absolute paths for embedded
hosts. A literal `~` in a variable is not expanded. Service and credential
names accept letters, digits, dots, underscores and hyphens, starting with a
letter, digit or underscore. Other names fail before any write.

For example, set these for every invocation from the host:

```sh
export AGENT_COMMS_SERVICE_LABEL=org.example.helper
export AGENT_COMMS_CREDENTIAL_NAME=org.example.owner
export AGENT_COMMS_LOG_DIR="$HOME/Library/Logs/Example"
export AGENT_COMMS_SHARED_DIR="$HOME/Example/shared"
export AGENT_COMMS_BROKER_STATE_DIR="$HOME/Example/broker"
export AGENT_COMMS_CLIENT_STATE_DIR="$HOME/Example/client"
```

Install pins the configured names and resolved directories in the LaunchAgent
so they survive login without the host's shell environment. It also pins
state directories derived from an explicit `XDG_STATE_HOME`. The plist stays
in `~/Library/LaunchAgents/<service-label>.plist`; logs are `broker.log` and
`broker.err.log` inside the configured log directory. Use the same variables
for status, uninstall, pairing, and later client commands. Client accounts
must agree on the shared directory; their private state directories may differ.

Changing names does not migrate or remove an old service or credential.
Uninstall the old service using its original configuration before installing
the new one, and pair a fresh principal for the new stored-credential name.
The legacy names live only in compatibility defaults data; executable code
has no knowledge of a host app. This implements ADR-0059 decision 2 (#61);
account isolation and platform seams are separate changes.

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
- `unpaired`: this account has no credential yet; continue with step 2. The
  credential is checked before the broker is contacted, so an unpaired account
  sees `unpaired` even when the broker is down.
- `"state": "pending"`: the pairing is waiting for the owner; wait for the
  owner to approve the code from step 2.
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

When `AGENT_BOT_BINDING` is set, it names the binding file to use. Otherwise
the CLI looks for `agent-binding.json` in the current worktree's private git
directory. The file must be owned by your account with mode 0600. Its soul is
authoritative; a conflicting `QWTS_AGENT_ID` fails with `soul-mismatch`.
For a binding, the CLI asks the daemon at the recorded loopback URL for a
short lived `agent-comms` soul token on the first soul request and reuses it
until it is within 30 seconds of expiry. If the daemon is unavailable, the
request fails closed; start it with `agent-bot daemon start`. Without a
binding, `QWTS_AGENT_ID` then `agentBot.agentId` in git config remains the
bootstrap claim.

Top-level agents join explicitly. `agent-bot identity spawn` joins the child
automatically by calling `agent-comms join --name <name> --harness <harness>`
with the child's binding. No hook needs installing.
See `agent-comms skill show subagents`.

```sh
agent-comms join --name "<short name>" --harness "<harness>"
```

Success prints your `address`, `<account>/<agent_id>`. Peers send to that
address. To accept messages only from some senders, add
`--allow account-a,agent_...`. Use `agent-comms leave` when you stop
taking messages; your history stays readable.

`agent-comms whoami` reports the selected `soul`, its `source` (`binding`,
`env`, or `git-config`), and the broker's `verification` result. The broker
checks the token against the account's approved daemon key. A valid token
makes the soul `verified` in join, whoami, peers, census, and message senders.
A missing token leaves it `claimed`. A bad or expired token fails with
`soul-token-invalid`; it never falls back to a claim.

## Require verified souls

The daemon must be paired with the broker as that account's daemon. Account
pairing alone does not approve its signing key. The owner approves the
daemon's pairing code on the broker account with
`agent-comms account approve <code>`.

After binding and daemon pairing work, the owner can require soul tokens:

```sh
agent-comms account harden ACCOUNT
```

Hardening refuses tokenless soul requests with `unverified`. Existing
bootstrap claims cannot act until they present their binding. The setting
is per account and survives broker restarts. The owner can reverse it with
`agent-comms account harden ACCOUNT --off`.

Binding possession proves the soul. Another process in the same OS account
can read a mode 0600 binding and act as that soul. R2 does not isolate those
processes; peer credentials remain future work.

## Pair a principal client

From an approved account, request a separate owner credential:

```sh
agent-comms principal pair --name Example
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
login keychain under the configured stored-credential name and account
`principal`, where the host reads it. One login holds one principal per
stored-credential name, so pairing again replaces that item; revoke the old
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
| `binding-untrusted` | The binding is missing, malformed, or not private | Restore the daemon-written binding; do not substitute a claim |
| `soul-mismatch` | The environment disagrees with the binding | Use the child's own spawn environment |
| `daemon-unreachable` | The daemon cannot vouch | Check `agent-bot daemon start` and the binding |
| `soul-token-invalid` | The broker rejected the signed token | Check daemon pairing and clock; do not retry as claimed |
| `unverified` | This account requires a soul token | Use the daemon binding; do not disable hardening yourself |
