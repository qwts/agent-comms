# Owner decisions: proposed transport envelopes

This disabled engineering draft completes the [wire schemas](owner-decision-wire.md)
and [receipt contract](owner-decisions.md). Joint comms/bot/native-host review
remains required before implementation. [Lifecycle rules](owner-decision-lifecycle.md)
control every transition; envelope availability alone grants no authority.

## Implemented watch identity prerequisite

Account-watch `ready` now adds UUIDv4 `watchId`, positive safe-integer
`daemonEpoch` and `daemonKey` (SHA-256 of approved daemon DER SPKI). The daemon
compares the key with its own paired vouch key. Joint daemon review confirmed
additive-field compatibility. Soul-watch ready remains unchanged.

Each socket has a frozen, ephemeral binding. Internal selection chooses one
live socket; later checks revalidate that exact socket, account/daemon approval,
key and epoch. Reconnect creates a fresh ID; it cannot replace a saved selection.
Delayed revoked-stream close callbacks cannot erase replacement watch sets.
No owner route, event dispatch or capability advertisement is enabled.
The remaining envelopes below are proposed.

## Envelopes and daemon binding

Use the existing protocol `v: 1`, custody-checked channel and authentication
envelope. Principal operations accept only principal authentication; daemon
operations accept only daemon authentication. Neither accepts `sender`,
`agentId` or alternate identity fields. The broker reconstructs the immutable
action `{ v: 1, requestId, principal, account, soul, operation, parameters }`
from authenticated identity and validated input. `action` below carries these
canonical bytes as canonical unpadded base64url, not an independently parsed
object whose original bytes were lost. `payloadDigest` hashes decoded bytes.

Each account watch receives a broker-generated `watchId` and its current
`daemonEpoch`/`daemonKey` in its `ready` event. `daemonKey` is SHA-256 of the
approved daemon Ed25519 public key's DER SPKI. The broker selects exactly one
live watch for a preparation and durably records those three bindings and its
acceptance time `acceptedAt` before forwarding. A
second watch cannot replace it for that request. Disconnect before authorization
does not spend the challenge; cancellation or expiry permits a new request and
ceremony. A replacement pairing invalidates every pending request for its old
epoch even when its public key is unchanged. No queued event is replayed into
application on reconnect/restart. A daemon-authenticated report/check may use a
fresh connection, but must match the recorded key, epoch and selected watch ID.

The tables list fields in addition to `v`, `op` and the existing `auth`.
Result values use the existing success/error response wrapper. Every error has
only a bounded public code/message; errors reveal no unauthorized target,
principal secret, webhook input or arbitrary daemon text.

Public protocol error codes are exactly `bad-request`, `conflict`,
`owner-decision-unavailable`, `owner-decision-unsupported`, `daemon-unavailable`,
`preparation-stale`, `rate-limited`, `journal-capacity`, `storage-failed` and
`presence-invalid`.
Existing principal/daemon authentication failures retain the existing
`unauthenticated`/`not-approved` envelope behavior. After authentication,
unauthorized/unknown targets or request IDs all use
`owner-decision-unavailable`, never an existence-specific code. Unsupported
platform/custody/capability uses `owner-decision-unsupported`; missing selected
watch uses `daemon-unavailable`; changed preparation/epoch uses
`preparation-stale`. Invalid schema/limits use `bad-request`; reused immutable
IDs/content/results use `conflict`. No code distinguishes secret-staging
contents. Messages are fixed public wording, at most 200 UTF-8 bytes with no
controls; native cancellation/unavailability never becomes a synthetic p1.

| Principal request | Exact additional fields | Success value |
| --- | --- | --- |
| `owner-decision-prepare` | `{ requestId, account, soul, operation, parameters }` | Status value below; a prepared value includes the original challenge. Duplicate identical input only reads its recorded value, never redelivers preparation. |
| `owner-decision` | `{ requestId, payloadDigest, presence }` | Status value. `presence` is the complete ASCII p1 token; verify against the saved challenge/action/enrolled presence key before spending. |
| `owner-decision-status` | `{ requestId }` | Status value after current principal and both grants are checked, including after token expiry. No token is needed. |
| `owner-decision-cancel` | `{ requestId }` | Status value; cancellation succeeds only in `preparing`/`prepared`. Later calls observe existing state and never revoke released work or refund a nonce. |

Status is exactly `{ requestId, payloadDigest, state, challenge, outcome }`.
`challenge` is null except in `prepared`; `outcome` is null except for
`applied`, `refused`, `cancelled`, `expired` or `indeterminate`. It is then
`{ code, effectDigest }`. Outcome codes map exactly: applied → `applied`,
refused → `validation-refused`, `authority-refused`, `deadline-expired` or
`storage-refused`,
cancelled → `cancelled`, expired → `deadline-expired`, indeterminate →
`effect-uncertain`. Compacted terminal details use `details-retired` with the
retained state. `effectDigest` is SHA-256 of the canonical request-linked daemon
evidence record, or null if no effect is proven. That record's typed mutation
schema is a companion bot-review prerequisite, never arbitrary supplied JSON. Never return the d1 receipt or a reusable release response to
the principal. Status after revocation uses the existing non-disclosing refusal;
the owner-local reconciliation path remains separate.

Challenge is exactly
`{ requestId, principal, account, soul, operation, payloadDigest, action, nonce, acceptedAt, preparedAt, exp, daemonKey, daemonEpoch, watchId }`.
The host verifies the decoded action equals its original request and public
principal in every field, computes its digest and summary itself, checks the
deadline, and rejects any mismatch before the native ceremony.

| Broker event on selected daemon watch | Exact event fields |
| --- | --- |
| `owner-decision-prepare` | `{ event, requestId, principal, account, soul, operation, parameters, payloadDigest, action, acceptedAt, daemonKey, daemonEpoch, watchId }` |
| `owner-decision` | `{ event, requestId, action, presence, receipt, receiptDigest, daemonKey, daemonEpoch, watchId }` |
| `owner-decision-cancel` | `{ event, requestId, payloadDigest, daemonKey, daemonEpoch, watchId }`; best effort, never authority to mutate. |

`acceptedAt` is broker-origin authenticated metadata, not caller/daemon input.
The daemon accepts it only on the custody-verified broker watch, journals it
unchanged and checks `acceptedAt <= daemonNow + 30` and
`daemonNow < acceptedAt + 180` before preparation. It computes the exact expiry
using that original acceptance cap and any stage deadline; a duplicate never
refreshes acceptedAt. Broker and host compare it with the broker's persisted
challenge. Unsafe/noninteger/negative timestamp arithmetic or failed bounds
refuses rather than extending deadlines.

Daemon requests always contain
`{ requestId, payloadDigest, daemonKey, daemonEpoch, watchId }` in addition
to their operation-specific fields below. Authentication independently verifies
the current approved account/daemon pairings; echoed bindings are not authority.

| Daemon request | Operation-specific fields | Success value |
| --- | --- | --- |
| `owner-decision-prepared` | `{ nonce, preparedAt, exp, stage }` | `{ requestId, state }`, where state is the recorded lifecycle value. First acceptance journals prepared before replying/exposing it; repeats or late responses return the current authorized/terminal state without moving it backward. Altered saved bindings/content conflict. |
| `owner-decision-check` | `{ receiptDigest }` | `{ requestId, payloadDigest, receiptDigest, daemonKey, daemonEpoch, watchId, state, mayApply, exp }`; only the first durably released check can answer `state: "released", mayApply: true`. Every repeat has `mayApply: false`. `exp` is the saved receipt expiry. |
| `owner-decision-result` | `{ receiptDigest, state, outcome, reconciliation }` | `{ requestId, state, recorded }`; state is applied/refused/indeterminate, outcome uses the status schema. `receiptDigest` is null only for refusal before issuance; `reconciliation` is null except for an owner-local reconciliation record. |

The prepared request carries `stage:null` for an unstaged action, otherwise the
exact public `{stagingId,kind,contentDigest,expiresAt}` from the daemon
[preparation evidence](owner-decision-preparation-evidence.md). The broker checks
its action binding and exact three-way expiry cap before retaining the
[prepared wrapper](owner-decision-journal-records.md#producer-owned-slots).
This adds no field to the public challenge or signed d1 bytes.

`receiptDigest` is lowercase SHA-256 hex of the entire ASCII
`d1.<payload segment>.<signature segment>` token, including both dots and
prefix, with no newline. `presenceDigest` hashes the equivalent complete ASCII
p1 token. Do not substitute the decoded payload hash or a JSON hash of a token.
The daemon compares all receipt fields with its own saved challenge and exact
action; the broker compares check/result against the saved issued token digest.
`recorded` is a boolean: true for a newly persisted result, false for an exact
duplicate. `mayApply` is always a boolean; state is one of the lifecycle table's
literal strings. `auditId` in reconciliation is a lowercase version-4 UUID;
`evidenceDigest` is lowercase SHA-256 hex of the durable evidence record.
Results are monotonic: exact duplicate reports are idempotent, conflicting
reports refuse, and only explicit reconciliation can resolve indeterminate.

Receipt schema, canonical action/d1 encoding, signature coverage, key IDs and
time bounds remain those in the parent contract. Existing p1 is verified under
agent-bot's owned protocol, separately from the stricter new d1 codec. Preserve
the complete returned p1 bytes so the presence digest cannot be changed by
re-serialization. Refuse a malformed/oversize token before decoding; p1 and d1
are each at most 4096 ASCII bytes, subject to the complete-frame cap.
