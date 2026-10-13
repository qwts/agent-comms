# Federation: candidate v1 encrypted wire profile

**Status:** Proposed review candidate, 2026-10-11. Not crypto approved.

Related to #28, #118 and #119; issues remain open. This concretizes the
[crypto review requirements](federation-crypto-review.md), not a production
codec, enrollment protocol or deployment. Independent crypto/native compatibility review precedes implementation; these
constants do not amend accepted custody policy.

## Construction and encoding

The candidate uses RFC 9180 Base mode with KEM `0x0020`
DHKEM(X25519, HKDF-SHA256), KDF `0x0001` HKDF-SHA256 and AEAD `0x0001`
AES-128-GCM. The suite has published [RFC 9180 Appendix A.1 vectors](https://www.rfc-editor.org/rfc/rfc9180.html#appendix-A.1).
One fresh single-shot context seals each new envelope. No external nonce, PSK
or HPKE Auth-mode key is used.

Origin signatures use [RFC 8032 ordinary Ed25519](https://www.rfc-editor.org/rfc/rfc8032.html),
not ph/ctx. Signing/encryption keys are distinct, without conversion/reuse.
SHA-256 identifies signed envelopes, not plaintext.

`C(x)` below means [RFC 8949 core deterministic CBOR](https://www.rfc-editor.org/rfc/rfc8949.html#section-4.2.1)
under this restricted profile: definite-length arrays, unsigned integers,
byte/text strings and the explicitly allowed null values only. Integers and
lengths use shortest encodings. Maps, tags, negative integers, floats,
indefinite lengths, booleans and trailing bytes are refused. Arrays have exactly
the specified cardinality; extensions require a new version. UTF-8 must be
well formed; no normalization or case folding changes authenticated strings.
Reject noncanonical representations before verification. Check bounds before
allocation/crypto; maximum nesting is four.

`ASCII(s)` means the exact ASCII bytes, and `0x00` is one terminal zero byte.
Application domains, separate from HPKE internal labels:

```text
D_info    = ASCII("agent-comms/federation/hpke/v1") || 0x00
D_aad     = ASCII("agent-comms/federation/aad/v1") || 0x00
D_sign    = ASCII("agent-comms/federation/envelope/v1") || 0x00
D_digest  = ASCII("agent-comms/federation/digest/v1") || 0x00
D_receipt = ASCII("agent-comms/federation/receipt/v1") || 0x00
```

## Immutable public header

`H` is an array of seventeen elements, in the following order. Broker IDs preserve the persisted `hub_UUID` identity (40 ASCII bytes, lowercase UUID); relay/key/enrollment IDs remain distinct authenticated-enrollment bytes. Enrollment and endpoint mapping remain review gates.

| Index | Meaning | Exact candidate type and bounds |
| --- | --- | --- |
| 0 | Version | unsigned integer `1` |
| 1 | HPKE suite | exact array `[32, 1, 1]` |
| 2 | Origin hub ID | ASCII text, exactly 40 bytes, existing `hub_UUID` grammar |
| 3 | Destination hub ID | same as index 2 |
| 4 | Origin soul ID | ASCII text, 1–128 bytes, pattern `[A-Za-z0-9._:-]+` |
| 5 | Destination soul ID | same as index 4 |
| 6 | Origin signing-key ID | byte string, 32 bytes |
| 7 | Recipient encryption-key ID | byte string, 32 bytes |
| 8 | Origin peer-enrollment ID | byte string, 16 bytes |
| 9 | Destination peer-enrollment ID | byte string, 16 bytes |
| 10 | Relay-enrollment ID | byte string, 16 bytes |
| 11 | Relay ID | byte string, 32 bytes |
| 12 | Route ID | byte string, 16 bytes |
| 13 | Random logical envelope ID | byte string, 16 CSPRNG bytes |
| 14 | Creation time | integer milliseconds since Unix epoch, `0..2^53-1` |
| 15 | Expiry time | same range; greater than creation; lifetime at most 2,592,000,000 ms |
| 16 | Encoded plaintext length | unsigned integer, `0..56284`, equal to actual decrypted byte length |

Peers authorize the complete origin/destination soul, relay, route and key
context. Relays check origin signatures and their scope; destinations check
recipient-key and peer scope. Hub A's key grants no authority for hub B.
Changed relay/route context is not a retry; no automatic fallback or rewrapping.

## Temporal admission candidate

For **new** admission at trusted local time `now`, require `now < expiresMs`
(expiry equality rejects) and `createdMs <= now + 120000`. The two-minute
future-creation tolerance follows the accepted contract; it permits only
bounded clock error, never extends expiry or the thirty-day lifetime. Reject
outside this interval rather than refreshing signed times. Receipt commitment
requires `createdMs - 120000 <= committedAtMs < expiresMs` and a commitment
actually performed within the local new-admission gate.

A verified historical retained outcome is different from new admission: after
expiry, an exact authenticated retry may return its already committed proof,
but cannot reinsert a body or reserve a new success. Its original commitment
time must satisfy the interval above; verification does not require that time
to be recent. Refuse a receipt claiming a future commitment beyond verifier
`now + 120000`. Retention/uncertainty rules apply independently; an absent
outcome after expiry cannot be manufactured from a valid signature.

## Encrypted message and coverage

The candidate plaintext `P` is `C([kind, body, refs, correlation, replyTo, depth])`:

| Element | Candidate requirement |
| --- | --- |
| `kind` | text matching `[a-z][a-z0-9-]{0,31}` |
| `body` | lossless string below; at most 32,768 native UTF-8 replacement bytes |
| `refs` | array of at most sixteen lossless strings; each at most 256 UTF-16 code units |
| `correlation` | null or lossless string of at most 128 UTF-16 code units |
| `replyTo` | same representation as correlation; destination resolves authorization separately |
| `depth` | unsigned integer `0..8`; destination validates chain semantics |

A well-formed string is CBOR text, including empty text. An ill-formed string
is a nonempty array of maximal nonempty well-formed text runs and unsigned
integers representing unpaired surrogate code units `0xD800..0xDFFF` only.
Reject empty/adjacent text runs, arrays without surrogate integers, nonmaximal
runs and adjacent high/low surrogate integers: a valid pair belongs in text.
Low/high and high/high unpaired sequences remain legal. Text uses strict UTF-8;
reject malformed encodings, normalization and code-unit replacement.

The entire encoded `P` fits **56,284 bytes**, independently of the unchanged
32,768-byte native body cap and escaped mailbox admission. Check the input cap
before copying/view construction. Parse the exact six-field grammar with at
most **20,759 decoded nodes**, including root/arrays/nulls; body run arrays
have at most 16,384 elements, ref run arrays 256, optional metadata run arrays
128. There are at most three nested array containers; a scalar inside a ref
run array has value depth four. Check declared lengths, cumulative native body
bytes and UTF-16 units before allocation. The
[lossless proof](federation-lossless-bound.md) and
[development lab contract](../tools/feasibility/lossless-plaintext/CONTRACT.md)
define the candidate grammar and bounds; neither is production adoption.

Direct soul-only scope excludes principal/channel federation. Account mapping,
reply provenance and depth require native adapter review; local behavior stays
unchanged.

```text
(enc, ct) = HPKE.SealBase(pkRecipient,
                         info = D_info || C(H),
                         aad  = D_aad  || C(H),
                         pt   = P)
U         = C([H, enc, ct])
sig       = Ed25519.Sign(skOrigin, D_sign || U)
E         = C([H, enc, ct, sig])
envDigest = SHA256(D_digest || E)
```

`enc` is exactly 32 bytes, `sig` exactly 64, and `ct` exactly `H[16]+16`
bytes. Verification uses the enrollment-selected public key, never an
attacker-provided key. Relays cannot verify plaintext claims; destinations
check plaintext length, strict decoding, native admission and declared context.
An authenticated signature still does not authorize a revoked or foreign scope.
No public plaintext commitment appears. Any additional commitment requires
leakage/purpose review.

Durably store `E` before handoff. Retries send identical bytes without
reencryption, refreshed expiry, changed route/key or new signature, including
after rotation. Same-ID/different-digest is conflict; exact retries consult
retained outcomes before fresh-capacity rejection.

## Receipt profile

The [candidate receipt profile](federation-receipt-candidate.md) fixes signer
and enrollment mapping, outcome meaning and protected evidence accounting.

## Structural size vectors and review gates

CBOR-only structural bounds, excluding transport wrappers: `C(H)` is 559 bytes:

```text
1 + 1 + 5 + 2*42 + 2*130 + 2*34 + 3*17 + 34 + 17 + 17 + 2*9 + 3 = 559
```

Terms follow header order. The four-element envelope is:

```text
1 + 559 + (2 + 32) + (3 + 56300) + (2 + 64) = 56963 bytes
```

Reject wire input above 65,536 bytes before decoding. Transport framing or
wrappers require separate accounting; this calculation includes neither.

| Structural vector | Required result |
| --- | --- |
| `P=C(["message", "a" repeated 32752, [], null, null, 0])` | 32,768 bytes; accepted |
| Same vector with body length 32,753 | 32,769 bytes; accepted |
| Body length 32,768 with otherwise minimal metadata | 32,784 bytes; accepted; body plus one byte is refused |
| Maximum header, `ct` length 56,300, `enc` 32, signature 64 | exactly 56,963 bytes |
| Same header with nonminimal integer encoding or altered array length | refused, even if cryptographic verification could otherwise succeed |
| Receipt at maximum types/times | relay `C(R)` 293 / signed 360; destination `C(R)` 301 / signed 368 bytes |

Receipt byte capacity can bind before the outcome count cap.

Required negative vectors cover each header/receipt field changed alone,
wrong hub/recipient key/enrollment/relay, cross-domain signature reuse,
unknown suite/version, low-order/invalid KEM inputs as required by RFC 9180,
invalid Ed25519 signatures, malformed UTF-8, trailing bytes, type confusion,
all integer/length boundaries, exact expiry/protection boundaries and
byte-identical lost-response retries. Pin versions and require two implementations to agree on RFC and application
crypto vectors. The lab tests plaintext/structure only; crypto, enrollment and runtime remain
unproven.
