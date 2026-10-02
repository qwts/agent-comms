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
or on the existing POSIX test implementation, it reads `principal.json` in
the configured client state directory through the account-isolation seam.
A failed keychain read fails closed; it does not silently try another store.
Windows remains the explicit `platform-not-implemented` seam.

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
The returned object exposes `principal` but not the secret. Recreate the
client after rotating credentials. There is no persistent connection to close.

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

## Issue 64 closeout

Implemented requirements: the documented module provides census, send and
inbox; recipient receive rules and principal grants are enforced in the
existing mailbox handlers; client authority is only its principal credential;
`tests/principal-client.test.mjs` exercises pairing through acknowledgment
against a real one-account broker. Tests also cover restricted grants,
revocation, impersonation, mailbox isolation, idempotency, persistence,
validation, limits, and platform credential loading.

Patterns used: the existing protocol, durable event log and mailbox policy,
and the local-channel, secret-store and account-isolation seams. The broker
previously supported only principal reads, so this adds principal message
endpoints and mailboxes, plus a small worker reply-routing adjustment. There
are no deviations from ADR-0007 amendment 1 or new dependencies. Launch and
host application implementation remain in their separate issues.

## Request a daemon launch

`client.launch({ account, soul, harness, name? })` launches an existing soul;
use `package` instead of `soul` for a package path in the target account.
Exactly one is required. The broker never opens that path. Account names
follow the pairing grammar, soul IDs are `agent_<uuid>`, package paths are
nonblank strings of at most 4096 characters, harness names at most 64, and
optional display names at most 128. Strings cannot contain control characters.
The daemon validates package contents and supported harnesses locally.

The principal must be approved and the target account paired and approved.
Existing souls require the principal's account, soul, or address grant and
receive allowlist permission; they may have left the hub. Packages require
an account grant or the unrestricted default grant. Soul-only grants cannot
create new souls. Launches share the principal send rate limit.

The result is `{ ok, requestId, status: 'pending', agentId: null }`.
Poll `client.launchStatus(requestId)` (wire op `launch-status`) for the same
shape with terminal status `launched` or `failed`. A successful result names
the joined soul; a failure may have a null agentId. Status access requires
the original principal and current target authorization. Unknown or hidden
requests return `unknown-launch`. There is no launch message in the inbox.

An account without an open daemon watch fails with `daemon-unavailable`.
An accepted request is fsynced as `launch-request` before forwarding to
exactly one live account-watch connection. It is never broadcast or retried.
The new newline-delimited watch frame is:

```json
{"event":"launch","requestId":"launch_<uuid>","principal":"principal_<uuid>","account":"persona","soul":"agent_<uuid>","harness":"codex","name":"Example"}
```

For a package, the frame contains `package` instead of `soul`; `name` is
omitted when absent. The account's agent-bot daemon owns process creation,
package resolution, harness startup, and joining through the existing join
contract. Neither the client nor broker starts a harness or joins on its
behalf. The daemon must interpret fields as data, never as a shell command.

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

A failure may carry `detail`, the daemon's reason as display text (for example
a soul without a GitHub identity). The broker replaces control characters with
spaces, trims it, and keeps at most 512 characters; a blank detail is dropped,
and one on a `launched` report is ignored. It is recorded with the result and
`launchStatus` returns it as `detail` when present. Hosts show it as plain
text only. A different detail for the same request is a `conflict`.

Requests and results survive broker restarts. A disconnect or crash after
dispatch leaves the outcome `pending` until the daemon reports; it does not
prove startup failed. The broker does not resend pending launches on
reconnect or restart. Each launch call creates a new request, so callers
must not automatically retry an uncertain launch response. Daemon execution
and recovery belong to agent-bot; this contract is exercised with a fake
account daemon in `tests/launch.test.mjs`.
