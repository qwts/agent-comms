# Federation: candidate v1 receipt profile

**Status:** Proposed review candidate, 2026-10-11. Not crypto approved.

Related to #28, #118 and #119; issues remain open. This accompanies the
[candidate wire profile](federation-wire-candidate.md); its `H`, domain constants,
CBOR restrictions, temporal gates and independent review requirements apply.
No production codec, proof mechanism or deployment is implemented here.

## Signed statement and durability meaning

A signed receipt is `C([R, receiptSignature])`, with a 64-byte Ed25519 signature
on `D_receipt || C(R)`. `R` is exactly fourteen elements:

```text
[1, kind, signerId, signerKeyId, signerEnrollmentId,
 originHubId, destinationHubId, relayId, routeId, envelopeId,
 envDigest, expiresMs, committedAtMs, outcome]
```

`kind=1,outcome=1` means relay custody admitted; `kind=2,outcome=2` means
destination mailbox admitted. Other pairs are refused in this candidate.
`signerId`, `signerKeyId`, both hub IDs, `relayId` and `envDigest` are 32-byte
strings. Enrollment, route and envelope IDs are 16-byte strings. Times have the
header's integer bounds; expiry matches `H[15]`. Match every scope/envelope field to the header and authenticated enrollment,
including receipt purpose; foreign receipts are refused.

For kind 1, `signerId=H[11]` and `signerEnrollmentId=H[10]`; resolve
`signerKeyId` from that relay enrollment's authorized receipt keys. For kind 2,
`signerId=H[3]` and `signerEnrollmentId=H[9]`; resolve the key from the
destination peer enrollment. Never substitute origin enrollment `H[8]` or a
same-key record from another scope. Receipt times obey the temporal gate above.

Signatures authenticate statements, not physical durability. Emit receipts only
after atomic body/outcome reservation. Mailbox admission does not prove reading
or acknowledgement. Forwarded native outcomes, signed refusal, expiry/loss proof
and uncertainty queries remain completeness gates, not invented successes.

Outcome lookup is scoped by origin hub, origin soul and envelope ID, with the
immutable digest stored to detect changes to any destination/route/relay field.
Changing those fields must not evade conflict detection. Both origin and
custody holders retain the relevant replay evidence through expiry plus 120
seconds. Revocation prevents new authorization but must not silently erase
historical outcome evidence. Snapshot/PITR rollback cannot be detected by a
counter in that same restored database; recovery remains quarantined or bound
to independently maintained monotonic authorization state, pending review.

## Evidence byte accounting

The 344-byte receipt alone already exceeds the synthetic full-cap probe's
335/336-byte outcome labels. At most 97,541 such receipts fit 32 MiB before
any extra outcome data; actual storage charges must include all retained
serialized proof/key metadata. The count and byte limits apply together, so a
real admission may reach byte capacity before 100,000 outcomes. No eviction or
larger cap follows from this calculation. A smaller stored digest is not a
substitute for a promised recoverable proof without an explicit design decision.

