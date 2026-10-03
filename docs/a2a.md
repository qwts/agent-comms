# Inbound A2A

The broker's optional loopback gateway implements A2A 1.0.1 JSON-RPC over
HTTP, negotiating version `1.0`. It offers work through the same task and
mailbox operations as the CLI. Outbound calls and wider exposure are outside
this release ([ADR-0005](decisions/ADR-0005-a2a-at-the-broker-edge.md)).

## Owner configuration

The listener is off without configuration. Pair and approve a principal
using `principal pair` and `admin principal-approve --grant`, then select
exposed souls in a JSON configuration file:

```json
{
  "enabled": true,
  "host": "127.0.0.1",
  "port": 8080,
  "skills": [{
    "id": "review",
    "soul": "ACCOUNT/AGENT_ID",
    "name": "Review",
    "description": "Review proposed work",
    "tags": ["review"]
  }]
}
```

```sh
agent-comms a2a configure --config-file gateway.json
agent-comms a2a enroll PRINCIPAL --token-file bearer.txt \
  --souls ACCOUNT/AGENT_ID --operations SendMessage,GetTask,CancelTask,ListTasks
agent-comms a2a list
agent-comms a2a serve-status
agent-comms a2a revoke TOKEN_HASH
```

Enrollment takes an owner-generated random bearer token of at least 32
characters from a file. Only its SHA-256 hash is sent to the admin socket
and stored; CLI output never includes the token. Configuration lives in
`a2a.json` in the broker's private state directory, owned by the broker
account with mode 0600. Configure requires a broker restart for listener
changes. Enrollment and revocation take effect immediately. Other bind
hosts are refused. Port zero selects an ephemeral port, shown in status.

Each skill has a POST endpoint `/a2a/SKILL_ID` and a card at
`/a2a/SKILL_ID/.well-known/agent-card.json`. The root
`/.well-known/agent-card.json` advertises the first configured skill's
endpoint. Each card lists only owner-selected skills for that endpoint's
soul, text input/output, HTTP bearer security, and no streaming or push
notifications. Send `Authorization: Bearer TOKEN`, `A2A-Version: 1.0`, and
`Content-Type: application/json` with every JSON-RPC POST.

An unmapped or revoked credential returns HTTP 401 before dispatch. A
mapped credential missing the requested soul or method returns HTTP 403.
Its principal must remain approved, its current broker grant must cover the
recipient, and task offers must satisfy the soul's receive allowlist.
Message text cannot widen any permission. Credentials cannot act as a soul.

## Methods and states

`SendMessage` creates a task offer with acceptance criteria formed by joining
text parts with newlines. Its original message, part metadata, media types,
and opaque context ID persist with the task in the event log. A missing
context ID is generated per task. The task's local ID is the gateway's
server-assigned ID. Retries can create new offers; send idempotency is not
implemented. Sending into an existing task is explicitly unsupported.

`GetTask` reads that record; `historyLength: 0` omits the inbound message.
Positive lengths return the single stored inbound message. `CancelTask`
reads the current revision and asks the task store to cancel as the offerer.
Cancellation is best effort and does not stop execution directly. Terminal
tasks return `TaskNotCancelable`; hidden or missing tasks return
`TaskNotFound`. Reads and cancellations are restricted to the enrolled
principal's offers to the endpoint's soul.

`ListTasks` accepts `pageSize` (1–100) and the opaque `pageToken` returned as
`nextPageToken`; an empty next token ends pagination. It returns only the
principal's offers to that endpoint's soul. Pages use the underlying visible
list's cursor, so filtering can produce empty pages with a next token.
Additional filters are refused.

| Local state | A2A state |
| --- | --- |
| offered | submitted |
| accepted, working | working |
| input-required | input-required |
| completed | completed |
| canceled | canceled |
| failed | failed |
| rejected | rejected |

Task metadata keeps `localState` and `revision`. The adapter also preserves
`auth-required` if supplied by a future task backend; the current task store
has no such transition. No credential workflow is inferred from text.

Only `text/plain` text parts are supported. Data, files, other media types,
and unknown part fields return `ContentTypeNotSupported`. Extensions and
nonempty send configurations return `UnsupportedOperation`; no extension
is advertised. Unsupported versions return `VersionNotSupported`.

## Issue 89 closeout

Solution as built: the broker owns a loopback HTTP gateway, private owner
configuration, and a hashed bearer-to-principal map. Standard JSON-RPC
methods create, query, list, and cancel durable local task records through
existing authorization and rate limits. Conformance and refusal fixtures
cover the adapter, with HTTP and admin CLI integration tests.

Patterns used: gateway at the edge, an anti-corruption layer with explicit
state mapping, and deny by default. Deltas: text is the only supported part
kind; task continuation, extensions, and send configuration are visibly
refused. Each selected soul uses its own endpoint and card. No outbound
route, wider listener, or cross-machine routing was added.
