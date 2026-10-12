# Federation: encrypted envelope review requirements

**Status:** Proposed engineering review, 2026-10-11.

Related to #28, #118 and #119; these issues remain open. The accepted
[delivery contract](federation-contract-proposal.md) establishes custody,
enrollment and expiry policy. This document proposes review inputs, not a wire
schema, cryptographic approval, production implementation or deployment.
Independent crypto review remains required before the production codec/schema.
The separate [provider review](federation-provider-feasibility.md) and synthetic
storage evidence do not validate cryptography or provider production guarantees.

## Threat and custody boundary

Assume the relay can inspect routing metadata, replay, reorder, omit or replace
stored bytes, lie about its own admission and restore old database snapshots.
An enrolled peer is not authorized for another hub, soul or relay scope. A local
hub compromise can expose that hub's private keys and plaintext; encryption
cannot reverse that compromise. TLS complements end-to-end content protection.
Private signing and decryption keys stay at their owning hubs; the relay receives
only its own enrollment/service credentials. Test/dev credentials never become
production enrollment credentials.

The review must separate a valid signature from authorization and durability.
An authentic relay receipt proves that the relay signed a statement, not that its
disk survived. A destination admission receipt means durable mailbox acceptance,
not harness consumption or human reading. An acknowledgement is a distinct
outcome under the owning broker's existing semantics. Lost receipts retain the
same envelope ID and uncertainty; they do not justify a new logical message.

## Immutable-field matrix

Names below describe required meanings, not final field names or encodings.
All origin-authenticated envelope fields remain identical on retry. Public
routing metadata must also be cryptographically bound to recipient ciphertext;
otherwise a relay could substitute context without changing encrypted content.

| Meaning | Producer and verifier | Visibility and binding requirement | Persistence and negative review vectors |
| --- | --- | --- | --- |
| Protocol/version and message domain | Origin; every verifier | Public; signed and encryption context bound; separate domains for envelope, receipt and enrollment | Unknown version/suite, cross-protocol signature reuse, omitted domain |
| Origin hub and signing-key identifier | Origin; relay and destination | Public; signature binds exact key identity and enrollment | Key substitution, expired/revoked enrollment, signer outside hub scope |
| Destination hub and soul identity | Origin; destination and relay authorization | Required route metadata public; exact destination bound to signature and encryption context | Wrong recipient, cross-soul delivery, destination alias ambiguity |
| Recipient encryption-key identifier | Origin from authenticated destination configuration; destination | Public; bound to signature and encryption context | Wrong/stale key, silent key fallback, replacing key during retry |
| Peer enrollment, route and relay scope | Enrolling owner; each admission boundary | Minimum routing scope public and authenticated; no automatic bridging | Reuse at another relay/hub/route, scope widening, restored revoked enrollment |
| Random logical envelope ID | Origin; all custody/dedupe boundaries | Public; signed; stable for the full lifetime | Same ID with changed immutable bytes is conflict; retries use original ID |
| Creation and expiry | Origin; admission and expiry boundaries | Public; authenticated; integer units/ranges fixed by reviewed encoding | Overflow, clock-boundary cases, lifetime above thirty days, old-but-unexpired message |
| Cipher suite and encapsulation | Origin; destination | Public; authenticated with ciphertext and context | Algorithm confusion, unsupported suite, malformed encapsulation |
| Ciphertext and authentication tag | Origin; destination; relay verifies origin signature | Public ciphertext; signature covers the complete immutable encrypted envelope | Truncation, bit flips, reordered fields, changed ciphertext with same ID |
| Plaintext message and optional commitment | Origin; destination | Encrypted; commitment policy requires leakage review below | Body/refs/type substitution, wrong commitment, commitment copied between envelopes |
| Relay admission statement | Relay; origin | Separate signature domain; bind envelope digest, relay identity/scope and declared outcome | Receipt for another envelope/relay, success before atomic reservation, lost reply |
| Destination admission/outcome statement | Destination; origin | Separate signature domain; bind original envelope digest and exact outcome semantics | Relay posing as destination, mailbox admission confused with consumption/ack |

Review must specify which fields are also AEAD associated data or HPKE `info`,
without assuming that a signature alone authenticates encryption context.
Hop telemetry such as retry count and observation time belongs outside the
immutable envelope and cannot alter its signed delivery meaning.

## Content commitments and equality leakage

A public unkeyed digest of plaintext can disclose equality and allow guessing
low-entropy messages. The accepted content-fingerprint requirement needs a
precise purpose: local retry comparison can use private local evidence; a
recipient-verifiable plaintext commitment can be inside encryption. A public
digest of the complete immutable ciphertext can bind receipts/dedupe without
being presented as a plaintext fingerprint. Random encryption changes ciphertext
between separately created messages; retries must retain the original encrypted
bytes. Select the construction only after reviewing equality leakage, key
custody, conflict semantics and the accepted contract together.

## Standard construction candidates

These are alternatives for review, not a selected composite protocol.

- [HPKE, RFC 9180](https://www.rfc-editor.org/rfc/rfc9180.html) supplies standard
  KEM/KDF/AEAD suites and vectors. Base-mode recipient encryption plus an explicit
  origin signature is a candidate; Auth mode alone must not be assumed to provide
  publicly verifiable relay-origin signatures. HPKE does not supply application
  replay prevention, plaintext-length hiding or recipient-compromise forward
  secrecy. Its context and randomness requirements remain part of the review.
- [Ed25519, RFC 8032](https://www.rfc-editor.org/rfc/rfc8032.html) is a candidate
  signature primitive with published vectors. Specify exact domain-separated
  signed bytes and variant; do not interchange Ed25519, Ed25519ctx and Ed25519ph.
- [Deterministic CBOR, RFC 8949 section 4.2](https://www.rfc-editor.org/rfc/rfc8949.html#section-4.2)
  is one encoding candidate. A protocol profile still needs types, numeric bounds,
  duplicate-key refusal, unknown-field policy and exact deterministic rules.
- [Cloudflare CIRCL HPKE](https://github.com/cloudflare/circl/tree/main/hpke)
  is an existing implementation candidate for independent interoperability
  vectors. It is Go code, not evidence of Node/Workers API suitability or an
  audited adapter for this application. Pin and inspect an implementation and its
  relevant verification/audit history before depending on it.
- [libsodium sealed boxes](https://doc.libsodium.org/public-key_cryptography/sealed_boxes)
  are an established alternative with documented format, but deliberately do not
  authenticate the sender. They cannot alone satisfy origin signatures; a full
  wrapper and implementation review would still be necessary. No custom
  cryptographic construction is proposed here.

## Replay, rotation and restoration

Deduplication atomically reserves an outcome with admission before acknowledging
success. A valid signature does not bypass capacity, expiry, route authorization
or a retained conflict. Evidence stays protected through expiry plus 120 seconds;
restoration that loses evidence must expose uncertainty rather than claim
exactly-once delivery. Thirty-day offline operation requires explicit decisions
on retaining old verification/decryption keys and rejecting newly submitted
messages from revoked keys. Rotation must not silently re-encrypt an already
accepted retry under a new key and pretend it has identical immutable bytes.

PITR can restore previously revoked enrollment and remove recent outcomes.
Review an external monotonic enrollment/revocation authority or an explicit
quarantined recovery/re-enrollment procedure; a counter stored only in the same
restored database cannot detect its own rollback. Provider PITR availability is
not a solution to this trust problem. No automatic provider-region failover,
credential reuse or cross-hub bridging follows from recovery support.

## Exact size and verification gates

Calculate bytes from the selected encoded representation, not character counts:
plaintext including its metadata/commitment, encapsulation, AEAD tag, public
header, key identifiers, signature, framing and any base64 expansion. Demonstrate
that the accepted 32 KiB plaintext and 64 KiB wire limits include the intended
fields; escaped mailbox admission remains independently enforced. Bound parsing
before allocation and reject unsupported lengths/types, duplicate fields,
noncanonical forms and trailing data. Outcomes must account for the actual
serialized proof/key metadata inside the 32 MiB evidence budget; the synthetic
335/336-byte labels do not establish this fit.

Before production implementation, require two implementation/vector agreement,
field-by-field tamper and cross-scope tests, malformed encoding corpus, retry
byte stability, key rotation/revocation scenarios, restored-state uncertainty
and exact maximum-size vectors. Review dependencies, constant-time/native API
behavior and key erasure limitations separately. No deployment, account creation
or spending is authorized by this review proposal.
