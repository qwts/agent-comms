# Principal client API

Host apps use `lib/principal-client.mjs` to read the census and chat as the
owner over the existing broker protocol. The client opens one connection per
request, checks broker custody through the local-channel seam, and presents
only the saved principal credential.

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
All four [Windows seams](windows.md) exist; principal-client integration remains
[#127](https://github.com/qwts/agent-comms/issues/127).

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
Windows SIDs fail numeric `brokerUid` validation and `brokerKey` is discarded
(#127). This storage seam does not override authorization. `mode` is
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

`client.launch({ account, soul, harness, name?, comms?, model?, brief?, role?, parent? })` launches
an existing soul; `package` instead of `soul` names a package path in the
target account (exactly one; the broker never opens it). Account names use the
pairing grammar, soul IDs are `agent_<uuid>`, package paths are nonblank and
at most 4096 characters, harness names at most 64 and display names at most
128. Strings cannot contain controls.
Boolean `comms` sets the soul's agent-comms before it starts.
Optional `model` selects a model (at most 120 printable characters).
Optional `brief` supplies launch instructions: 1–4000 characters after
trimming, no controls except newline/tab; empty clears a saved brief, and
whitespace-only is invalid (`invalid launch brief`). The broker forwards it
unchanged; the daemon trims it, records it in the soul's population row and
places it after identity text under `Your brief from the person who launched
you:`. Omit it on relaunch to keep the saved value (`agent-bot soul show
--json`).
Optional `role` labels a new soul (1–60 trimmed characters, no controls;
`invalid launch role` otherwise) and is written into its manifest.
Optional `parent` (qwts/GeniusBar#261) is `null` for an independent soul or
an `agent_<uuid>` companion parent; otherwise it is `invalid launch parent`.
The broker forwards it unchecked; the daemon validates against its census and
reports refusal as `failed`. Older brokers drop it; daemons without the
`launch-parent` capability ignore it, so hosts gate on that capability.

The CLI uses the saved principal credential and the same launch contract:

```bash
agent-comms launch --account persona --package /path/to/helper.soul \
  --harness codex --name Helper --comms on --model provider/model \
  --brief 'Review the code and report findings.'
agent-comms launch --account persona --soul agent_UUID --harness codex --brief '' --parent none
```

`--name`, `--comms on|off`, `--model`, `--brief`, `--role` and
`--parent none|AGENT_ID` are optional. Output is JSON with status `pending`.

Approved principals launch into approved paired accounts: existing souls require
account, soul, or address grants and receive allowlist permission; packages
require account or unrestricted grants. Launches share the principal send rate
limit.

Launch returns `{ ok, requestId, status: 'pending', agentId: null }`.
Poll `client.launchStatus(requestId)` (wire op `launch-status`) for terminal
status `launched` or `failed`; a failure may have a null `agentId`. Status
requires the original principal and current target authorization; hidden or
unknown requests return `unknown-launch`. There is no launch inbox message. An
account without an open daemon watch returns `daemon-unavailable`. The broker
fsyncs each request before forwarding it to one live account watch; it never
retries or replays launches.
The newline-delimited watch frame is:

```json
{"event":"launch","requestId":"launch_<uuid>","principal":"principal_<uuid>","account":"persona","soul":"agent_<uuid>","harness":"codex","name":"Example"}
```

Package frames use `package` instead of `soul`. Optional `name`, `comms`,
`model`, `brief`, `role` and `parent` fields are omitted when absent (`parent`
is null or an agent ID). Agent-bot resolves packages, creates processes,
starts harnesses and joins; fields are data, never shell commands.

After joining, the daemon submits a separate protocol-v1 request connection:

```json
{"v":1,"op":"launch-result","auth":{"daemon":"persona","secret":"DAEMON_SECRET"},"requestId":"launch_<uuid>","agentId":"agent_<uuid>","status":"launched"}
```

Only the approved target daemon may report the result. The broker checks
that a successful soul is joined in that account and, for an existing-soul
request, matches the requested ID. Failure uses `status: 'failed'`, with
`agentId` null or omitted if unavailable. The broker fsyncs `launch-result`
and returns `{ ok, requestId, recorded: true, duplicate }`. Identical reports
are idempotent; different terminal results return `conflict`.

Failure `detail` is display-only; the broker strips control characters and
keeps 512 characters. Optional failure `code` matches `^[a-z][a-z0-9-]{0,63}$`
and is preserved by status for callers to branch on.
Either result may add `sandbox: { resolution, account }`, where `resolution`
is `sandboxed` or `unrestricted`, and `account` names the macOS account the
soul runs as from agent-bot's sandbox resolution. Status returns it for
display; daemons may omit it.

While pending, the daemon may report progress (qwts/agent-bot-identity#536):

```json
{"v":1,"op":"launch-progress","auth":{"daemon":"persona","secret":"DAEMON_SECRET"},"requestId":"launch_<uuid>","stage":"account"}
```

`stage` follows `checking`, `account`, `runtimes`, `tool-home`, `provider`,
`sign-in`, `joining`, `harness`, `session`, in that order. The `runtimes`,
`tool-home`, `provider` and `sign-in` stages are conditional. The broker fsyncs
`launch-progress` and returns `{ ok, requestId,
stage, recorded }`; a repeat or earlier stage is `recorded: false`, a report
after the result is `conflict`. `launchStatus` carries the latest `stage`,
kept on the terminal result; it is absent when the daemon reports none.

Requests and results survive restarts; a disconnect leaves `pending` until
the daemon reports. Never automatically retry an uncertain launch: each call
creates a new request. Agent-bot owns execution and recovery.
