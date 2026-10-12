# Owner decisions: proposed broker contract

**Proposed protocol** for accepted
[ADR-0077](decisions/ADR-0077-owner-decisions-through-the-broker.md), not a
released API; [#77](https://github.com/qwts/agent-comms/issues/77).
Agent-comms owns broker authorization/receipts; agent-bot owns mutation and
presence semantics; the native host owns credential custody and prompting.
[Wire schemas](owner-decision-wire.md) define envelopes and boundaries. Joint review is required.
[Observation guards](owner-observation-guard.md) remain private; activation is disabled.

## Prepare and confirm

1. A native principal client submits `owner-decision-prepare` with `account`,
   `soul`, `operation`, typed `parameters` and a client-generated UUID
   `requestId`. Broker authentication accepts only a paired, approved
   principal with target and operation grants. It forwards preparation on
   that account's authenticated daemon watch. No mutation occurs.
2. The daemon resolves its soul, validates parameters and expected revision,
   and durably records a challenge: request ID, principal, operation,
   canonical payload digest, random 32-byte base64url nonce and expiry.
   It returns the challenge through a daemon-authenticated prepared response.
   The broker durably records it before exposing it to the principal. A
   preparation lasts up to 180 seconds; cancellation causes no mutation.
3. The native host independently validates the operation and rebuilds the
   action text from the challenge and parameters. It shows the complete
   bounded summary and requests a `p1` presence assertion with that nonce.
   Native custody and verified signing identity must meet ADR-0077; a method
   name or capability flag proves no support.
4. `owner-decision` confirms the same request with its presence assertion.
   Broker rechecks grants and verifies action, nonce, native key and time.
   It first requires the selected live target watch and unchanged daemon
   pairing epoch, then durably spends the challenge,
   records authorization, signs the receipt and delivers it only to that
   watch. Principal secrets never enter a daemon frame. No live watch returns
   `daemon-unavailable` without spending; a lost delivery after spending is
   reconciled through status, never resubmitted as a new authorized effect.
5. The daemon verifies the receipt and presence and checks its challenge and
   target in its per-soul asynchronous coordinator. It asks the broker
   `owner-decision-check` with the complete-token receipt digest using its
   daemon credential. The broker confirms current principal/account/grant/key
   validity and durably releases this receipt to that daemon, once. With the
   first successful response still live, the daemon takes the existing
   synchronous mutation lock, rechecks all expected state and the receipt
   deadline, then durably consumes its challenge before the effect. No await
   crosses that lock. Its result is recorded through `owner-decision-result`
   and queried by the principal through `owner-decision-status`.

The broker check is the authorization linearization point: revocation that
precedes it refuses; revocation after it cannot undo an authorized operation
already entering application. A lost check response is not automatically
retried into mutation. It is reconciled as an uncertain request.

## Typed operations and immutable input

| Operation | Parameters and daemon validation |
| --- | --- |
| `revision.approve`, `revision.reject` | `proposalId`, `expectedRevision`, bounded `reason`; verify that the proposal belongs to this soul and is pending. |
| `revision.adopt`, `revision.edit` | `stagingId`, `packageDigest`, `expectedRevision`, `reason`; adopt requires `expectedRevision: null` (no revision head), edit requires a revision and explicit boolean `apply`. Use a daemon-owned prepared snapshot, verify its digest, and call existing package validation. |
| `cold-wake.set` | `mode`: `on`, `off`, `webhook` or `resume`; resume requires `policy: "read-only"` or `"workspace"`, never a caller-selected session. Webhook requires a prepared secret snapshot, its digest and public host. Apply existing daemon validation. |

Package and webhook-secret staging require a separate owner-authenticated
preparation path reviewed in agent-bot and the native host. A receipt never instructs the daemon to read an arbitrary host
path, interpret a shell string or accept an unchecked package. Staging limits apply before enabling adopt/edit/webhook. Unsupported operations
refuse; deploying only approve/reject cannot close #77.

Unknown fields, ambiguous addresses and invalid types refuse. Limits are
the smaller of the existing daemon limit and 32 KiB for the complete frame;
`reason` is at most 500 UTF-8 bytes without controls. Error responses never
disclose whether an unauthorized target exists. No discovery authority is
added by preparation.

## Serialization, human action and receipt

Immutable action:
`{ v, requestId, principal, account, soul, operation, parameters }` with `v: 1`.
Action and decoded `d1` receipt payloads use the strict
[canonical UTF-8 encoding](owner-decision-serialization.md). Hash the exact
canonical action bytes with SHA-256; alternate representations refuse.
[Disabled issuer/coordinator](owner-decision-coordinator.md).

The presence action is the one-line text
`Owner decision <operation> for <account>/<soul>: <summary>; request <requestId>; payload sha256:<digest>`.
`summary` uses the exact labeled per-operation grammar in the
[wire specification](owner-decision-wire.md#typed-summary-and-native-display).
It names the proposed change; the digest also binds staging locators and
expected-revision preconditions omitted from the summary. Both verifiers
reconstruct the exact text from validated typed parameters. The complete action
must satisfy keyd's existing printable-text bound of 400 Unicode scalar values
and the additional 500 UTF-8 byte bound. If either fails, refuse preparation;
never truncate, shorten a digest or silently invoke another proof mechanism.
The existing separate local owner ceremony may be offered explicitly. The nonce
and action bind the human ceremony to one immutable request.

```text
d1.<base64url(payload JSON)>.<base64url(Ed25519 signature)>

payload: { v: 1, aud: "agent-comms-owner-decision", brokerKey,
           requestId, principal, account, soul, operation,
           payloadDigest, nonce, presenceKey, presenceDigest, iat, exp }
```

Receipt signature covers the ASCII payload segment exactly as sent. Reject
missing/unknown fields, noncanonical unpadded base64url, invalid key IDs,
wrong audience/version and oversize tokens. Base64url uses the URL-safe
alphabet without `=` padding; decoding and re-encoding must reproduce the
original segment, including zero unused trailing bits. The
32-byte nonce is 43 characters and the 64-byte Ed25519 signature is 86.

`payloadDigest`, `presenceDigest`, `brokerKey`, `presenceKey` and `<digest>`
in the action text are exactly 64 lowercase hexadecimal characters: no
`sha256:` prefix inside a field, uppercase, padding or alternate encoding.
`payloadDigest` and the action's `<digest>` hash the canonical action payload;
`presenceDigest` hashes the complete ASCII `p1` token; `receiptDigest` in
check/result envelopes hashes the complete ASCII `d1` token. `brokerKey` and
`presenceKey` identify enrolled public keys by SHA-256 of DER SPKI bytes;
neither supplies a new trusted key. keyd's `actionDigest` remains lowercase
SHA-256 hex of the action text.
The daemon receives canonical action bytes and that token alongside the
receipt and independently verifies both digest bindings and native presence.

Receipt `iat`/`exp` are nonnegative integers within the range above, in Unix
seconds; `now = floor(unixTimeMilliseconds / 1000)`. Accept only when
`0 < exp - iat <= 60`, `iat <= now + 30` and `now < exp`: the future-time
equality passes; expiry equality refuses. Receipt expiry cannot exceed
preparation or presence expiry; issue only while `now < preparation.exp` and
`now < presence.exp`. No extra receipt expiry grace applies. This leaves
keyd's 60-second issuer lifetime, 120-second verifier bound and 30-second
presence skew unchanged. A clock problem asks
for a fresh ceremony rather than silently extending a receipt.

## State, retries and trust changes

Broker and daemon journals bind request IDs to their immutable payload
digest. A repeated ID with different content is `conflict`. An identical
request returns its recorded status; it never repeats presence or application
automatically. Only the original principal with current grants can read
status; only the target daemon can report a matching result.

Persist authorization/consumption before side effects. Application outcomes are
`applied`, `refused` and `indeterminate`; the state machine separately records
pre-authorization cancellation and expiry. Retain spent-ID tombstones; a
request ID is never reusable. Expired tokens cannot authorize any work, while
an authenticated status query can still read retained outcomes. Keep unsettled
IDs until explicit owner-local reconciliation. Crash after effect but before result, or after authorization
release without proven application, is `indeterminate`. Reconciliation checks
the actual revision/settings and records a result; any new attempt uses a
new request ID and fresh owner presence. Journal write failure refuses work.

Bootstrap provisions broker/native public keys through owner-administered
local setup, bound to account and installation namespace. Public receipt and
presence keys are pinned in each daemon's private configuration; broker presence trust is
protected by its separate service account. Rotation disables the old key
and invalidates pending receipts/challenges before enrollment of its
replacement. Lost/corrupt/mismatched keys disable owner decisions, with a
separate owner-verified recovery ceremony and audit receipt. Clients never
trust a key sent in an unverified frame or silently adopt changed names.

Agent-bot's [pin-attested statement path](owner-decision-conformance.md#dependency-boundaries)
is distinct from this proposal. Existing p1 issuance does not establish the
required native custody. Without protected native presence, no broker receipt
is issued; a host's success claim or local administrator consent is not an
exportable assertion.
