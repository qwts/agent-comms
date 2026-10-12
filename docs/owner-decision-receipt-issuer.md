# Disabled owner-decision receipt producer

The internal [issuer](../lib/owner-decision-issuer.mjs) produces canonical `d1`
receipts for the [owner-decision protocol](owner-decisions.md). No route imports
it. It does not acquire keys, authorize an operation, consume a nonce, journal
an authorization, release work or dispatch a daemon event. Those remain the
responsibility of the custody-checked, journal-backed coordinator.

Inputs are the retained prepared wrapper and independently saved admission,
complete native `p1` token, independently enrolled presence public key, broker
receipt private key and trusted current clock. The issuer snapshots admission
bytes and fields, validates the retained challenge and stage with the existing
prepared decoder, and checks presence with the pinned bot-owned verifier.
Receipt, presence and selected daemon vouch key identities must all differ.
No token field chooses or enrolls a key.

Issuance time is the current clock floored to epoch seconds. Expiry is the
minimum of issuance plus 60 seconds, the saved preparation deadline (including
its stage cap), and presence expiry. Equality with any expiry refuses issuance;
the presence verifier's historical skew allowance never extends a new receipt.
The issuer signs the canonical unpadded base64url payload segment, then checks
the complete result through the existing joint action/challenge/presence/receipt
verifier. Only the receipt token, its complete-token digest and typed payload
are returned. Errors have a fixed message and contain no source data.

[Public synthetic vectors](../tests/fixtures/owner-decisions/issuer-v1.json)
cover every shared action. Their disclosed test seed is not a deployed key.
The fixture pins the existing source vectors by SHA-256 and contains exact
prepared bytes, clock, receipt payload, complete token and digest so the daemon
can reproduce and verify the producer bytes. Tests additionally cover shortened
preparation and stage deadlines, presence expiry without grace, substituted
keys, wrong action/nonce/audience, reconnect bindings and hostile input accessors.

A valid receipt alone never establishes current enrollment, owner presence
custody, operation grants, one-shot release or successful application. The
production native custody provider and durable coordinator must enforce those
requirements before this producer is reachable from any owner operation.
