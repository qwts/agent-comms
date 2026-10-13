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
Both broker hub IDs are exact 40-byte `hub_UUID` ASCII text. For kind 1,
`signerId` is the 32-byte relay ID; for kind 2 it is the destination hub text.
`signerKeyId`, `relayId` and `envDigest` are 32-byte strings. Enrollment, route
and envelope IDs are 16-byte strings. Times have the
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

Outcome lookup is scoped by relay ID, origin hub and logical envelope ID, with the
immutable digest stored to detect changes to any destination/route/relay field.
The complete digest binds origin soul as well as destination/route/relay.
Changing any of these fields must not evade conflict detection. Both origin and
custody holders retain the relevant replay evidence through expiry plus 120
seconds. Revocation prevents new authorization but must not silently erase
historical outcome evidence. Snapshot/PITR rollback cannot be detected by a
counter in that same restored database; recovery remains quarantined or bound
to independently maintained monotonic authorization state, pending review.

## Evidence byte accounting

The maximum relay receipt has `C(R)=293` bytes and signed size 360 bytes.
The destination receipt has `C(R)=301` and signed size **368 bytes**. This
includes exact 40-byte broker identities and purpose-dependent signer identity:

```text
relay R: 1+1+1+34+34+17+42+42+34+17+17+34+9+9+1 = 293
destination R: 293 - 34 + 42 = 301
signed receipt: 1 + C(R) + (2+64) = 360 or 368
```

At most **91,180** maximum-size receipts fit 32 MiB before additional retained
outcome/proof/key metadata. This is byte arithmetic, not a guaranteed outcome
capacity or permission to evict protected evidence. Count and byte limits apply
together. A smaller digest cannot replace a promised recoverable proof without
an explicit design decision. Mechanical structural tests cover both purposes;
crypto signatures and physical durability remain unproven.
