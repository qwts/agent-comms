# Broker-local enrollment record codec

The internal `lib/owner-enrollment-codec.mjs` validates public records for the
broker-owned source required by ADR-0077 section 4. It performs no filesystem
operations, enrollment, signing, key creation or authority checks. No runtime
route imports it. A valid chain explicitly reports custody, durability and
authorization as unverified. The protected loader and installation writer do
not exist yet.

## Encoding and records

Every record is canonical sorted-key UTF-8 JSON without a newline. Duplicate or
unknown fields, alternate encodings, invalid UTF-8, noninteger numbers and extra
bytes refuse with one fixed error. Enrollment/revocation records are at most
4096 bytes; audits and confirmations are at most 512 bytes.

Every record contains `v: 1`, its exact `kind`, `namespaceDigest` and a local
`revision`. Namespace is the existing installation-derived SHA-256 digest;
decoding cannot generate or restore it. Revisions range from 1 through 1024.

| Kind | Additional exact fields |
| --- | --- |
| `broker-owner-enrollment` | `previousDigest`, `transactionId`, `at`, `service`, `receiptKey`, `presenceKey`, `decisionEvidenceDigest` |
| `broker-owner-revocation` | `previousDigest`, `transactionId`, `at`, `service`, `enrollmentDigest`, `decisionEvidenceDigest` |
| `broker-owner-audit` | `recordDigest`, `transactionId`, `decisionEvidenceDigest` |
| `broker-owner-confirmation` | `recordDigest`, `auditDigest` |

`previousDigest` is null only at revision 1; otherwise it names the exact
preceding record bytes. Other digests are lowercase 64-character SHA-256 hex.
Transaction IDs are canonical UUIDv4. `at` is a nonnegative safe Unix-second
integer for audit, never proof of fresh presence.

`service` is exactly `{platform: "darwin", brokerUid}` with a nonzero unsigned
32-bit UID. That is schema validation: a future protected loader must separately
prove the actual service UID, its difference from the actual owner UID, private
custody, installation provenance and absence of souls.

Each key is exactly `{alg: "ed25519", publicKey, keyId}`. Public keys are raw
32-byte canonical unpadded base64url. Key IDs are SHA-256 of the canonical
Ed25519 SPKI DER. Receipt and presence pins must differ. The codec has no
caller-selected daemon key: per-attempt alias checks use the authenticated
selected watch binding at admission, issuance and release.

## Confirmed structural chain

The chain API accepts 1–1024 exact `{record, audit, confirmation}` byte triples.
All three records agree on namespace and contiguous local revision. Audits bind
the exact record digest, transaction and decision-evidence digest; confirmations
bind the exact record and audit digests. Transactions cannot repeat, and the
service UID cannot change within a chain.

The initial state has no active pair. Enrollment requires that state and is
allowed only through revision 1023. Revocation names the digest of the exact
active enrollment and clears the entire pair. Revision 1024 is reserved for
terminal revocation. Active-to-active replacement, partial triples, gaps,
reordering, resets and malformed records refuse; no accepted prefix is returned
on a malformed suffix. Returned records are immutable independent snapshots.

The broker-local revision is independent of the daemon's local chain sequence.
Cross-store consistency compares namespace, exact paired key IDs and service,
never revision equality. Each revision only invalidates bindings belonging to
its own source.

## Missing authority and storage evidence

An evidence digest or audit record cannot authorize installation. The existing
native principal-cutover assertions cannot install or revoke trust keys. A
separate exact trust ceremony, independently installed verification pin, fresh
presence and single-use verification are still required.

The future store must use bounded fixed names, private custody and immutable
exclusive publication under its lock. It must establish record, audit and
confirmation durability before acknowledgement. Partial publication, uncertain
flushes, unexpected files or links, and pending revocation must refuse authority
without falling back to an old active prefix. Explicit recovery must establish
durability after a crash; the codec's complete visible triples cannot do so.
Key mismatch or missing state must never trigger automatic key generation.
Hash chaining alone does not detect consistent deletion or rollback.

The logical record limits imply at most 5 MiB of public payload capacity, before
metadata, temporary-publication and terminal-revocation reservation overhead.
They do not establish physical reservation or power-loss support. No writer,
private-key layout, cleanup policy or deployment is introduced here.

## Validation

The public fixture `tests/fixtures/owner-decisions/broker-enrollment-v1.json`
contains canonical enrollment, audit, confirmation and revocation bytes and
digests independently checked in Node and Python and by the daemon team. Its
UID is illustrative, not an installation value or a custody claim. Tests cover
exact vectors, malformed records and chain links, snapshot isolation, and all
1024 transitions through the final reserved revocation slot.
