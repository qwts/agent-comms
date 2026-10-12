# Proposed stable broker namespace derivation

This pure disabled companion fixes the preimage for the
[journal's installation namespace](owner-decision-journal-capacity.md). It does
not implement bootstrap, storage, enrollment, trust records or runtime activation.

The broker owns one immutable random 32-byte installation ID, created only by a
future explicit trusted bootstrap ceremony. Derive namespaceDigest as lowercase
SHA-256 hex of the concatenation of ASCII `agent-comms-owner-broker-namespace-v1`
followed by one LF byte, then the raw 32 ID bytes. There is no separator after LF,
length prefix, JSON, hex or base64 encoding of the ID in this preimage.
`deriveOwnerDecisionBrokerNamespace` in `lib/owner-decision-namespace.mjs` accepts
only exactly 32 byte-array bytes, snapshots them and returns this digest. It
performs no filesystem, network, key lookup, randomness or authority operation.

Daemon and native enrollment pin the opaque digest through independently trusted
authenticated binding; they never derive it from a caller's raw ID. The broker
installation ID is separate from rotating receipt/presence/staging keys. Key
rotation, account/principal/daemon re-pairing, revocation and process restart
cannot replace the ID or reset accepted-ID reservations. A path, rotating key ID
or request-supplied value is not installation identity. Missing, corrupt,
ambiguous or mismatched established identity refuses; it never regenerates an
ID automatically. Explicit installation decommissioning remains a separate
owner action and does not erase another producer's unsettled evidence.

The bootstrap and authenticated trust-record schemas, crash-safe persistence,
identity removal/recovery rules and integration tests remain prerequisites. This
derivation helper creates no enrollment, accepts no caller-selected domain and
confers no owner grant. It must not be wired into production discovery or journal
creation before those prerequisites are reviewed.

The checked-in [synthetic vectors](../tests/fixtures/owner-decisions/broker-namespace-v1.json)
were generated independently in Python and crosschecked with Node. Their all-zero,
all-FF and incrementing IDs are public test data, never production identities.
The fixture's SHA-256 is
`559aff92b9dfe47a252d684a019a6b3928bc397c9e911607540289ad1ecac179`.
Run `node --test tests/owner-decision-namespace.test.mjs` for exact raw-byte domain,
view offset, alternate textual encoding, primitive/length refusal and snapshot
checks. No production bootstrap or enrollment acceptance is claimed.
