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

`H` is an array of seventeen elements, in the following order. Identifiers are opaque authenticated-enrollment bytes. Existing identity mapping
and enrollment format remain review gates.

| Index | Meaning | Exact candidate type and bounds |
| --- | --- | --- |
| 0 | Version | unsigned integer `1` |
| 1 | HPKE suite | exact array `[32, 1, 1]` |
| 2 | Origin hub ID | byte string, 32 bytes |
| 3 | Destination hub ID | byte string, 32 bytes |
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
| 16 | Encoded plaintext length | unsigned integer, `0..32768`, equal to actual decrypted byte length |

Both peers explicitly authorize the origin/destination hub and soul pair,
route, relay and key IDs. Hub A's key is not authority for hub B. Relays check origin signatures and their
own scope; destinations check complete peer/recipient-key scope before admission.
Moving an envelope to another relay or route changes signed context and is
not a retry. No automatic fallback or rewrapping is inferred.

## Temporal admission candidate

For **new** admission at trusted local time `now`, require `now < expiresMs`
(expiry equality rejects) and `createdMs <= now + 120000`. The two-minute
future-creation tolerance is proposed, not accepted policy; it permits only
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
| `body` | well-formed UTF-8 text; at most 32,768 bytes |
| `refs` | array of at most sixteen well-formed text strings; each at most 256 UTF-16 code units and 1,024 UTF-8 bytes |
| `correlation` | null or text of at most 128 UTF-16 code units and 512 UTF-8 bytes |
| `replyTo` | same representation as correlation; destination resolves authorization separately |
| `depth` | unsigned integer `0..8`; destination validates chain semantics |

The entire encoded `P`, not only body text, must fit 32,768 bytes. This maps
current message fields but is not evidence of native API compatibility: the
current broker separately caps body bytes and escaped mailbox admission.
For example a 32,768-byte body plus metadata does not fit this profile. Review
must resolve this boundary explicitly before adopting the profile; do not
silently narrow accepted forwarding semantics. Principal/channel addressing, reply provenance and soul-ID compatibility also
require adapter review.

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

The signature covers every header field, encapsulation and ciphertext; HPKE
context/AAD also bind the header. No public plaintext commitment appears. Local
retry evidence can retain a private fingerprint; recipients verify AEAD and
signed ciphertext. Any additional commitment needs leakage/purpose review.

Durably store `E` before handoff. Retries send identical bytes without
reencryption, refreshed expiry, changed route/key or new signature, including
after rotation. Same-ID/different-digest is conflict; exact retries consult
retained outcomes before fresh-capacity rejection.

## Receipt profile

The [candidate receipt profile](federation-receipt-candidate.md) fixes signer
and enrollment mapping, outcome meaning and protected evidence accounting.

## Structural size vectors and review gates

Structural budgets include CBOR headers, not crypto vectors or base64/JSON.
At maximum header bounds, `C(H)` is 543 bytes. The four-element envelope is:

```text
1 + 543 + (2 + 32) + (3 + 32784) + (2 + 64) = 33431 bytes
```

Reject wire input above 65,536 bytes before decoding. Transport framing or
wrappers require separate accounting; this calculation includes neither.

| Structural vector | Required result |
| --- | --- |
| `P=C(["message", "a" repeated 32752, [], null, null, 0])` | exactly 32,768 bytes; fits plaintext cap |
| Same vector with body length 32,753 | 32,769 bytes; refused before encryption |
| Body length 32,768 with otherwise minimal metadata | 32,784 bytes; refused; native compatibility question exposed |
| Maximum header, `ct` length 32,784, `enc` 32, signature 64 | exactly 33,431 bytes |
| Same header with nonminimal integer encoding or altered array length | refused, even if cryptographic verification could otherwise succeed |
| Receipt at maximum types/times | `C(R)` 277 bytes; signed receipt 344 bytes |

The signed receipt is 344 bytes; its separate profile explains why real outcome
byte capacity can bind before the 100,000-entry count cap.

Required negative vectors cover each header/receipt field changed alone,
wrong hub/recipient key/enrollment/relay, cross-domain signature reuse,
unknown suite/version, low-order/invalid KEM inputs as required by RFC 9180,
invalid Ed25519 signatures, malformed UTF-8, trailing bytes, type confusion,
all integer/length boundaries, exact expiry/protection boundaries and
byte-identical lost-response retries. Pin versions and require two implementations to agree on RFC and application
crypto vectors. None of the application crypto vectors, codec or deployment has
been executed here.
