# Disabled protected receipt signing integration

The journal, issuer and asynchronous coordinator connect the existing reserved
presence slot to a private signing attempt. This source remains disabled. The
production [capability](../lib/platform/owner-receipt-capability.mjs) refuses;
there is no accepted installed receipt provider, listener or activation. The
[compiled native adapter tests](owner-decision-native-receipt-adapter.md) exercise
the operation-specific native worker without establishing installed custody.
The explicit synthetic capability tests real pairing, grants, watch bindings
and filesystem journal behavior without establishing native custody, physical
reservation, daemon effects or completed [#77 acceptance](owner-decisions.md).

## Journal and asynchronous lifetime

`beginSigning(requestId, presenceBytes)` validates the current prepared prefix
and proof, requires current preparation and strict presence expiry, then writes
and completes the requested flush of the existing immutable presence slot.
Only afterward does it return an opaque same-instance one-use handle. No new
slot, format or reservation is introduced. Canonical challenge nonce bytes are
the replay identity across retained requests; the raw presence-token digest is
only the exact receipt binding. Alternate unused signature base64url bits can
change that digest without changing the verified signature or nonce.

`finishSigning(handle, {receiptBytes, authorizationBytes})` consumes the handle
before validation or I/O. It requires the exact unchanged retained prefix and
publishes the existing receipt and authorization slots in order. Cancellation,
expiry, another outcome, changed bytes or uncertain storage prevents completion.
An interrupted publication never acknowledges authorization. Reopen and explicit
flush recovery do not recreate handles or permit another signing attempt;
visible presence-only prefixes remain spent and non-authorizing. Existing
`recordAuthorization` is retained for storage fixtures, not a restart signing API.

The coordinator snapshots its authenticated request before suspension. It
checks current credential, principal approval, ordinary and scoped grants,
account/daemon approval, selected socket/watch/key/epoch, exact public pins,
namespace, UID and private source-custody receipt after each await and immediately
before synchronous authorization publication. Finish uses a fresh clock. There
is no await inside the existing journal lock and no async gap between final
checks and journal mutation. After flush, deadline/socket/source checks precede
one exact event; no token or event escapes before durable authorization.

There are at most 32 pending invocations globally and four per principal, one
per request. Cancellation, coordinator/ingress close and the ten-second deadline
abort continuations. Timeout is not process exit: result and owned terminal
receipts are separate. Only confirmed terminal **and** safe descriptor closure
release invocation capacity, independently of result settlement (whose private
candidate wait is still bounded by ten seconds). Rejected, false or missing terminal receipts remain
charged; no retry/refund is inferred. A launch throw is conservatively charged.
Cancel/close before the deferred launch starts no signer. Late private candidates
cannot revive cancelled/expired/closed requests. Broker restart cannot resume
an interrupted signing attempt. These are process-crash/requested-flush claims,
not measured power-loss or unconditional storage guarantees.

## Native command contract for the next producer

The native operation is `issue-decision-receipt`, not arbitrary message signing.
Canonical UTF-8 JSON, at most 131072 bytes, has exactly:

| Field | Type and binding |
| --- | --- |
| `v`, `op` | `1`, `"issue-decision-receipt"` |
| `namespaceDigest` | Existing lowercase 64-hex installation namespace |
| `brokerLocalRevision` | Current confirmed broker chain integer 1–1023 |
| `brokerEnrollmentHeadDigest` | SHA-256 of exact canonical last enrollment record payload |
| `observationDigest` | SHA-256 of exact canonical protected outer inspection bytes |
| `prepared`, `originalAction` | Canonical unpadded base64url; decoded canonical bytes each at most 32768 |
| `presence` | Complete ASCII `p1`, at most 4096 bytes; preserved exactly |
| `iat`, `exp` | Nonnegative safe integer epoch seconds |

No caller path, private key, key selector, arbitrary segment, unsigned alternate
format or generic authorization callback is accepted. The native helper selects
keys from its fixed complete confirmed source, validates protected mapping and
process/peer identities, exact observation/head/revision/namespace and three-key
separation, and independently validates action, preparation, stage and pinned
presence audience/action/nonce/signature/time. It reconstructs the existing exact
canonical `d1` payload segment. Caller `iat` is the pre-await candidate time;
native code must not replace it at a second boundary. Require
`exp = min(iat + 60, challenge.exp, p1.exp)` and
`iat <= floor(nativeNow / 1000) < exp` under the same-host clock assumption,
plus current preparation/presence validity. Clock jumps violating those bounds
refuse. JS re-verifies the exact signature against intended public key, action,
saved context and fresh finish clock, including `iat <= finishSecond < exp`.
Private receipt key material never enters JS.

The exact canonical response is at most 1024 bytes:
`{v:1,kind:"owner-decision-receipt-signature",requestId,brokerEnrollmentHeadDigest,signature}`.
Request ID uses the existing UUIDv4 grammar; head matches the command;
`signature` is canonical unpadded base64url for exactly 64 bytes. The private
invocation adapter must separately establish actual terminal/safe close before
publishing this result to the coordinator. It cannot certify exit from timeout.
The synthetic internal result carries only raw signature bytes. Native response
request-ID/head/schema validation and its owned terminal adapter remain explicit
prerequisites; this fixture is not a native adapter or production fallback.

## Public source and host counterpart

Root/joint review selected bootstrap v2 at the existing fixed owner-UID filename,
adding required protected `publicSocket`; v1 refuses with no fallback. Both
account GUIDs and UIDs are independently matched through protected mapping and
local OpenDirectory. The outer four-field inspection container and XPC protocol
remain v1. Both inner records become v2 with no `pinsRevision` alias:

- Installation: exact `v`, `kind`, `namespaceDigest`, `publicSocket`, `brokerUid`,
  `ownerUid`, `brokerAccountGuid`, `ownerAccountGuid`, `helperProtocol`,
  `helperService`, `helperIdentifier`, `brokerLocalRevision`,
  `brokerEnrollmentHeadDigest`. Kind remains `geniusbar-native-installation`;
  protocol is 1 and service/identifier are `app.geniusbar.owner-admin`.
- Pins: exact `v`, `kind`, `namespaceDigest`, `brokerLocalRevision`,
  `brokerEnrollmentHeadDigest`, `receiptKey`, `presenceKey`,
  `service:{platform:"darwin",brokerUid}`. Kind remains
  `geniusbar-native-enrollment-pins`; pins use the existing Ed25519 KeyPin schema.

Inner canonical strings each fit 4096 bytes, outer canonical bytes 16384. Local
revision/head/namespace/broker UID agree exactly; account GUIDs use the existing
lowercase UUID grammar, not a new UUIDv4 restriction. Host and daemon counters
are independent and never compared for equality. The head hashes the last
canonical RECORD payload, not its frame, triple or confirmation.

The true-line native helper owns the proposed fixed read-only source reader and
opaque snapshot/handler join. It must scan all 3072 fixed slots, complete triples
and suffixes, refuse pending/corrupt/revoked state, and revalidate exact retained
slot hashes, inodes, custody, root mapping and OS identities before response.
A private opaque source receipt binds that snapshot; its fingerprint is never a
public authority boolean or caller field. Public projection is consistency data
without protected transport/provenance. No socket location is learned from an
initial reply or ordinary broker environment override. Future native receipt
signing must share that reviewed decoder/source rather than fork its semantics.
The native reader, protected key lifecycle, signing/terminal adapter, installer,
physical journal support and daemon current-trust/effect checks remain enabling
prerequisites. Source-only changes create no protected root or key.

## Evidence

Tests cover private candidate retention, exact one-use handles, canonical nonce
aliases across IDs, restart, real SIGKILL boundaries, publication faults,
revocation/expiry/cancellation/ingress close during awaits, fresh credentials,
socket and source changes, rejected terminal receipts and finite capacity.
[Public signing vectors](../tests/fixtures/owner-decisions/protected-signing-v1.json)
reuse every frozen issuer signature; disclosed synthetic keys are not deployed.
The paired display companion SHA-256
`2c2c7b75cf105db6e66e04c4e8d0ddf9ca844905b40e09a23a8ea11e4a02dec2`
is byte-identical in comms #221 and agent-bot #1043 at `1ced801d`; neither adoption
establishes native display or owner-operation acceptance.
