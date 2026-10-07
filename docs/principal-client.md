# Principal client API

Host apps use `lib/principal-client.mjs` to read the census and chat as the
owner over the existing broker protocol. The client opens one connection per
request, checks broker custody through the local-channel seam, and presents
only the saved principal credential. It adds no transport or dependencies.

## Pair once, then connect

Start the broker in the owner's account. One-account mode is the default;
no group or administrator is needed. Use the same host configuration for
setup and the app, including `AGENT_COMMS_CREDENTIAL_NAME`,
`AGENT_COMMS_SHARED_DIR` and `AGENT_COMMS_CLIENT_STATE_DIR`.

```sh
agent-comms broker run
# In another terminal, or through the host's setup flow:
agent-comms account pair
agent-comms broker approve ACCOUNT_CODE
agent-comms principal pair --name ExampleHost
agent-comms admin principal-approve PRINCIPAL_CODE
```

Approval is a separate owner operation, never a client capability. Optional
`--grant ACCOUNT,AGENT_ID,ACCOUNT/AGENT_ID` on principal approval restricts
which souls the principal may see and chat with. The default grant covers
all souls. Pairing saves the broker UID and mode with the principal secret.

On macOS the client reads the login keychain using the host's configured
credential name and account `principal`. With `AGENT_COMMS_NO_KEYCHAIN=1`,
or on the existing POSIX test implementation, it reads `principal.json`
(`principal.<name>.json` for a non-default credential name) in the client
state directory through the account-isolation seam.
A failed keychain read fails closed; it does not silently try another store.
On Windows two of the four seams exist; see [Windows](windows.md).

## Use the library

Import from the pinned agent-comms release bundled with the host:

```js
import { createPrincipalClient } from './lib/principal-client.mjs';

const client = createPrincipalClient(); // synchronous credential load
const { souls } = await client.census();
const soul = souls.find((row) => row.presence !== 'left');
if (soul) {
  const sent = await client.send({
    to: `${soul.account}/${soul.agentId}`,
    body: 'Hello from the owner',
    key: 'conversation-42-message-1',
  });
  console.log(sent.messageId, sent.wake);
}
const page = await client.inbox({ limit: 20 });
for (const message of page.messages) console.log(message.from, message.body);
if (page.messages.length) await client.ack(page.messages.map((message) => message.id));
```

`createPrincipalClient({ env, timeoutMs, credentialLoader })` defaults to
`process.env`, a 10-second request deadline, and the platform secret store.
An embedding host may inject a synchronous `credentialLoader(clientPaths,
hostConfig, env)` returning its saved `{ principal, secret, brokerUid, mode }`.
It is a storage seam, not an authorization override. `mode` is
`single-account` or `group`; older credentials without it retain `group`.
The client exposes `principal`, not the secret; recreate it after rotating
credentials.

| Method | Request and result |
| --- | --- |
| `census()` | Returns `{ ok, souls }`; each row has account, agentId, name, harness, parent, presence, verification, hardened, daemonWatching, unacked and lastWake. |
| `send({ to, body, key, kind, refs, correlation, replyTo })` | Returns `{ ok, messageId, seq, duplicate, wake }`; duplicate responses omit seq. |
| `inbox({ after = 0, limit = 20 })` | Returns `{ ok, messages, cursor, remaining }` from this principal's unacknowledged mailbox. |
| `ack(ids)` | Returns `{ ok, acknowledged, alreadyAcknowledged }` for this principal's messages only. |

Use the prior page's `cursor` as `after` to page forward. Reading does not
acknowledge. `limit` is at most 100 and pages also have a byte limit. Retain
the same send `key` when retrying an uncertain outcome; keys are scoped to
the principal. Changed content with a used key yields `conflict`. Optional
send fields retain the broker defaults: kind `message`, refs `[]`, and null
correlation and replyTo. A replyTo must name a message this caller received.

Construction and custody checks may throw synchronously; requests otherwise
return promises. Errors have a stable `code`, including `not-approved`,
`unauthenticated`, `unknown-recipient`, `bad-request`, `rate-limited`,
`mailbox-full`, `broker-untrusted`, `broker-unreachable`, and `broker-timeout`.
No operation retries automatically.

Task methods and results: [Tasks](tasks.md).

## Authority and message shape

A principal is never a soul. Principal message endpoints are
`{ principal: 'principal_<uuid>' }`; soul endpoints retain
`{ account, agentId }` and a soul sender's verification. Souls reply using
the principal ID as `to`; the existing worker does this automatically.
Principals have durable inboxes without appearing as census rows or joining
an account daemon's wake stream. Delivery to a principal reports `waiting`;
the app polls its inbox. Principal-to-principal messaging is not supported.

The broker authenticates and checks approval on every request. Revocation
also blocks retries and inbox access. The principal grant bounds census,
sends to souls, and souls allowed to send into the principal inbox. A soul
must still be joined and its account approved to receive new messages.
Its normal receive allowlist applies: null accepts the principal, an empty
list denies it, and a restricted list must contain the exact principal ID.
An account entry does not confer that account's authority on a principal.
Previously accepted sends keep their idempotent result if a recipient leaves
or narrows its allowlist.

The API cannot join, act as a soul, read another mailbox, approve pairings,
launch processes, or access the admin channel. Client options cannot replace
protocol authentication or sender fields. The broker enforces these limits
even when a caller bypasses the library. Message content grants no additional
authority to a worker.

## Request a daemon launch

`client.launch({ account, soul, harness, name?, comms?, model?, brief?, role? })` launches
an existing soul; use `package` instead of `soul` for a package path in the target account.
Exactly one is required. The broker never opens that path. Account names
follow the pairing grammar, soul IDs are `agent_<uuid>`, package paths are
nonblank strings of at most 4096 characters, harness names at most 64, and
optional display names at most 128. Strings cannot contain control characters.
Optional boolean `comms` sets the soul's agent-comms before it starts.
Optional `model` selects a model (at most 120 printable characters).
Optional `brief` supplies the launch instructions: after trimming it must be
1–4000 characters, with no control characters except newline and tab. The
explicit empty string clears a saved brief; whitespace-only strings are invalid.
Invalid values fail with `bad-request` and `invalid launch brief`. The broker
records and forwards the original string unchanged; the daemon trims it,
records it in the soul's population row, and places it after the identity text
under `Your brief from the person who launched you:`. Omitting `brief` on a
relaunch preserves the saved value, reported by `agent-bot soul show --json`.
Optional `role` is a short label for a new soul (1–60 characters after
trimming, no control characters; `invalid launch role` otherwise), forwarded
unchanged; the daemon writes it into the spawned soul's manifest.
The daemon validates package contents and supported harnesses locally.

The CLI uses the saved principal credential and the same launch contract:

```bash
agent-comms launch --account persona --package /path/to/helper.soul \
  --harness codex --name Helper --comms on --model provider/model \
  --brief 'Review the code and report findings.'
agent-comms launch --account persona --soul agent_UUID --harness codex --brief ''
```

Use a real Agent ID in place of `agent_UUID`. `--name`, `--comms on|off`,
`--model`, and `--brief` are optional. Output is JSON, including without `--json`;
a successful request reports `pending`, before the daemon starts the soul.

Approved principals may launch into approved paired accounts. Existing souls
require account, soul, or address grants and receive allowlist permission;
packages require an account or unrestricted grant. Launches share the
principal send rate limit.

The result is `{ ok, requestId, status: 'pending', agentId: null }`.
Poll `client.launchStatus(requestId)` (wire op `launch-status`) for the same
shape with terminal status `launched` or `failed`. A successful result names
the joined soul; a failure may have a null agentId. Status access requires
the original principal and current target authorization. Unknown or hidden
requests return `unknown-launch`. There is no launch message in the inbox.

An account without an open daemon watch fails with `daemon-unavailable`.
An accepted request is fsynced as `launch-request` before forwarding to
exactly one live account-watch connection. It is never broadcast or retried.
The newline-delimited watch frame is:

```json
{"event":"launch","requestId":"launch_<uuid>","principal":"principal_<uuid>","account":"persona","soul":"agent_<uuid>","harness":"codex","name":"Example"}
```

Package frames contain `package` instead of `soul`. Optional `name`, `comms`,
`model`, and `brief` are omitted when absent. Agent-bot owns package resolution,
process creation, harness startup and joining. All fields are data, never shell
commands.

After joining, the daemon submits a separate protocol-v1 request connection
(the existing watch is a one-way event stream):

```json
{"v":1,"op":"launch-result","auth":{"daemon":"persona","secret":"DAEMON_SECRET"},"requestId":"launch_<uuid>","agentId":"agent_<uuid>","status":"launched"}
```

Only the approved target daemon may report the result. The broker checks
that a successful soul is joined in that account and, for an existing-soul
request, matches the requested ID. Failure uses `status: 'failed'`, with
`agentId` null or omitted if unavailable. The broker fsyncs `launch-result`
and returns `{ ok, requestId, recorded: true, duplicate }`. Identical reports
are idempotent; different terminal results return `conflict`.

A failure may add `detail`, display-only text that `launchStatus` returns.
The broker strips control characters and keeps 512 characters.
Either result may add `sandbox: { resolution, account }` (`sandboxed` or
`unrestricted`, and the macOS account the soul runs as, from agent-bot's
sandbox resolution); `launchStatus` returns it as reported, so a client can
show "Runs as …". A daemon that does not know the field sends nothing.

While pending, the daemon may report progress (qwts/agent-bot-identity#536):

```json
{"v":1,"op":"launch-progress","auth":{"daemon":"persona","secret":"DAEMON_SECRET"},"requestId":"launch_<uuid>","stage":"account"}
```

`stage` is `checking`, `account`, `joining`, `harness` or `session`, in that
order. The broker fsyncs `launch-progress` and returns `{ ok, requestId,
stage, recorded }`; a repeat or earlier stage is `recorded: false`, a report
after the result is `conflict`. `launchStatus` carries the latest `stage`,
kept on the terminal result; it is absent when the daemon reports none.

Requests and results survive restarts. A disconnect leaves the outcome
`pending` until the daemon reports. Never automatically retry an uncertain
launch: every call creates a new request. The broker never replays launches;
agent-bot owns execution and recovery. `tests/launch.test.mjs` exercises the
contract with a fake daemon.
