# Owner decisions: proposed broker contract

**Proposal only:** this describes the candidate protocol for
[ADR-0077](decisions/ADR-0077-owner-decisions-through-the-broker.md), not a
released API. The issue remains [#77](https://github.com/qwts/agent-comms/issues/77).
Agent-comms owns broker authorization/receipts; agent-bot owns mutation and
presence semantics; the native host owns credential custody and prompting.
Every field and fixture needs joint review before implementation.

## Prepare and confirm

1. A native principal client submits `owner-decision-prepare` with `account`,
   `soul`, `operation`, typed `parameters` and a client-generated UUID
   `requestId`. Broker authentication accepts only a paired, approved
   principal with target and operation grants. It forwards preparation on
   that account's authenticated daemon watch. No mutation occurs.
2. The daemon resolves its soul, validates parameters and expected revision,
   and durably records a challenge: request ID, principal, operation,
   canonical payload digest, random 32-byte base64url nonce and expiry.
   It returns the challenge through a daemon-authenticated result. A
   preparation lasts 180 seconds; it can be cancelled without mutation.
3. The native host independently validates the operation and rebuilds the
   action text from the challenge and parameters. It shows the complete
   bounded summary and requests a `p1` presence assertion with that nonce.
   Native custody and verified signing identity must meet ADR-0077. Merely
   setting a method name or capability flag is not evidence of support.
4. `owner-decision` confirms the same request with its presence assertion.
   Broker rechecks grants and verifies action, nonce, native key and time.
   It first requires a live target watch, then durably spends the challenge,
   records authorization, signs the receipt and delivers it only to that
   watch. Principal secrets never enter a daemon frame. No live watch returns
   `daemon-unavailable` without spending; a lost delivery after spending is
   reconciled through status, never resubmitted as a new authorized effect.
5. The daemon verifies the receipt and presence, rechecks its challenge,
   target and expected revision under its per-soul mutation lock, and asks the broker `owner-decision-check`
   with the receipt digest using its daemon credential. The broker confirms
   current principal/account/grant/key validity and durably marks this
   receipt released to that daemon, once. The daemon then durably marks its
   challenge spent before entering the mutation. Its result is recorded
   through `owner-decision-result` and queried by the principal through
   `owner-decision-status`.

The broker check is the authorization linearization point: revocation that
precedes it refuses; revocation after it cannot undo an authorized operation
already entering application. A lost check response is not automatically
retried into mutation. It is reconciled as an uncertain request.

## Typed operations and immutable input

| Operation | Parameters and daemon validation |
| --- | --- |
| `revision.approve`, `revision.reject` | `proposalId`, `expectedRevision`, bounded `reason`; verify that the proposal belongs to this soul and is pending. |
| `revision.adopt`, `revision.edit` | `stagingId`, `packageDigest`, `expectedRevision`, `reason`; edit also requires explicit boolean `apply`. Use a daemon-owned prepared snapshot, verify its digest, and call existing package validation. |
| `cold-wake.set` | `mode`: `on`, `off`, `webhook` or `resume`; `session` is required only for `resume`. Apply existing daemon policy and session validation. |

Staging requires a separate owner-authenticated preparation path reviewed in
agent-bot. A receipt never instructs the daemon to read an arbitrary host
path, interpret a shell string or accept an unchecked package. Stage expiry,
size and retention must be bounded before enabling adopt/edit. Unsupported
operations refuse; deploying only approve/reject cannot close #77.

Unknown fields, ambiguous addresses and invalid types refuse. Limits are
the smaller of the existing daemon limit and 32 KiB for the complete frame;
`reason` is at most 500 UTF-8 bytes without controls. Error responses never
disclose whether an unauthorized target exists. No discovery authority is
added by preparation.

## Serialization, human action and receipt

The immutable action payload is
`{ v, requestId, principal, account, soul, operation, parameters }` with `v: 1`.
Define its canonical UTF-8 JSON recursively: object keys in ascending ASCII
order; arrays preserve order; strings use JSON escaping; booleans and null
use their JSON literals. Only bounded strings, objects, arrays, booleans,
null and safe integers are permitted. Reject duplicate keys, noncanonical
encodings and unknown fields; hash these exact bytes with SHA-256.
Cross-language fixtures must fix non-ASCII and escaping behavior.

The presence action is the one-line text
`Owner decision <operation> for <account>/<soul>: <summary>; request <requestId>; payload sha256:<digest>`.
`summary` names every decision-relevant parameter and is independently derived
from validated typed parameters; both verifiers reconstruct the exact text.
It must fit the native trusted prompt
in full, capped at 500 UTF-8 bytes. If it does not fit, refuse preparation;
never truncate. keyd's existing `actionDigest` hashes those text bytes. The
nonce and action therefore bind the human ceremony to one immutable request.

```text
d1.<base64url(payload JSON)>.<base64url(Ed25519 signature)>

payload: { v: 1, aud: "agent-comms-owner-decision", brokerKey,
           requestId, principal, account, soul, operation,
           payloadDigest, nonce, presenceKey, presenceDigest, iat, exp }
```

Receipt signature covers the ASCII payload segment exactly as sent. Reject
missing/unknown fields, noncanonical unpadded base64url, invalid key IDs,
wrong audience/version and oversize tokens. `brokerKey` and `presenceKey`
identify enrolled public keys by SHA-256 of DER SPKI bytes; neither supplies
a new trusted key. `presenceDigest` hashes the complete ASCII `p1` token.
The daemon receives canonical action bytes and that token alongside the
receipt and independently verifies both digest bindings and native presence.

Receipt `iat`/`exp` are whole Unix seconds, with
`0 < exp - iat <= 60`. Receipt expiry is no later than preparation or presence
expiry; issue only while each is unexpired. Reject receipts when `iat` is
over 30 seconds ahead, or local time is at or after `exp` (`now >= exp`); no extra expiry
grace. This receipt policy does not change keyd's 60-second issuer lifetime,
120-second verifier bound or 30-second presence skew. A clock problem asks
for a fresh ceremony rather than silently extending a receipt.

## State, retries and trust changes

Broker and daemon journals bind request IDs to their immutable payload
digest. A repeated ID with different content is `conflict`. An identical
request returns its recorded status; it never repeats presence or application
automatically. Only the original principal with current grants can read
status; only the target daemon can report a matching result.

Persist authorization/consumption before side effects. Terminal outcomes are
`applied`, `refused` and `indeterminate`; retain spent IDs through at least
the last possible receipt acceptance. After that, reject expired tokens
before consulting retained status. Keep unsettled IDs until explicit owner
reconciliation. Crash after effect but before result, or after authorization
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

Current agent-bot
[owner-statement behavior](https://github.com/qwts/agent-bot-identity/blob/64b1c170ed25f4943e01a9f20334c065fd92d661/docs/owner-statements.md)
keeps challenge authorization disabled until pin integrity is protected.
This proposal neither enables that fallback nor claims existing `p1`
issuance meets the strengthened native storage boundary. No native presence
means no broker receipt. Existing local administrator consent does not become
an exportable assertion merely because a host says it succeeded.
