# Federation: native compatibility and byte-budget audit

**Status:** Proposed companion engineering review, 2026-10-11.

Related to #28, #118 and #119; issues remain open. This audits current native
semantics against the [candidate wire profile](federation-wire-candidate.md).
The wire candidate now incorporates the lossless option and existing origin IDs;
accepted caps and production behavior are unchanged. Proposed
alternatives below require independent encoding/crypto and native adapter review.

## Current admitted semantics

Sources are the checked-in [message admission](../lib/broker/message-admission.mjs),
[mailbox policy](../lib/broker/mailbox.mjs), [pairing resolver](../lib/broker/pairing.mjs),
[channel post policy](../lib/broker/channels.mjs), [channel metadata](../lib/channel-state.mjs),
[limits](../lib/broker/shared.mjs), [wire](../lib/wire.mjs) and
[retention accounting](../lib/retention.mjs). The reproducible calculator below
records hashes of its direct validator/accounting inputs.

| Field | Actual validation/admission |
| --- | --- |
| Body | JavaScript string; `Buffer.byteLength(body) <= 32768`, not a whole-message plaintext cap |
| Kind | `[a-z][a-z0-9-]{0,31}`; default `message` |
| Refs | At most sixteen strings, each `.length <= 256` UTF-16 code units; no Unicode well-formedness requirement |
| Correlation | Null or string of at most 128 UTF-16 code units |
| Reply | Null or string of at most 128 UTF-16 code units at payload validation; actual admission requires an existing received `msg_UUID`, forty ASCII bytes |
| Depth | Server-derived zero or parent depth plus one, at most eight; a caller-supplied depth is not authority |
| Retry key | 1–128 printable ASCII characters, scoped by sender namespace; content fingerprint includes operation, sender, resolved destination, kind/body/refs/correlation/reply |

`Buffer.byteLength` counts lone UTF-16 surrogates as replacement-character UTF-8
bytes; JSON preserves the original code unit with an escape. Native validation
therefore admits strings that strict CBOR UTF-8 text cannot represent. Refs and
correlation can also contain controls, non-ASCII and lone surrogates. Silent
replacement/normalization would change content and retry fingerprints.

## Addressing and reply provenance

Native soul IDs are exactly lowercase `agent_UUID` (42 ASCII bytes), account
names match `[a-z_][a-z0-9_.-]{0,63}` case-insensitively, and principal IDs are
`principal_UUID` (46 ASCII bytes). Direct resolution accepts a bare soul ID,
`account/agentId` (up to 107 bytes), a unique peer name, or an approved principal.
Names are mutable/ambiguous aliases, not stable federation identity. Messages
store `{account,agentId}` or `{principal}` endpoints; souls additionally retain
a verification snapshot. The candidate's soul-only header strings do not yet
encode the complete native endpoint vocabulary or account ownership.

Soul allowlists and principal grants remain enforced. Principals cannot
impersonate souls; principal-to-principal sends are refused. A principal's local
grant is not implicit remote enrollment authority. Native channel addresses are
`hub:hub_UUID/channel:channel_UUID` (97 ASCII bytes), with explicit membership,
posting capabilities and atomic snapshot fan-out. Copies carry channel address,
post ID and per-member wake metadata. A single remote direct envelope cannot
claim equivalent channel fan-out/atomicity. Neither remote principal grants nor
remote channels should become enabled through address-string coincidence.

Direct replies require the parent message's recipient to be the caller and
its sender to differ from the caller. They do **not** require the new destination
to equal the parent's sender. Channel replies require a copy received by the
caller in the same channel; unlike direct replies, the channel path does not
reject a copy of the caller's own post. Both derive depth from stored parent
state. The destination needs an authenticated mapping from remote references
to received local copies; trusting an asserted depth or looking up an origin
message ID in another broker's mailbox does not preserve provenance. Local
message IDs/sequences are broker-generated and must not be confused with the
federation logical envelope ID.

## Escaped mailbox accounting remains independent

Native wire lines allow 131,072 bytes. Message construction measures
`Buffer.byteLength(JSON.stringify({...message,wake:'waiting'}))` against
126,976 bytes, reserving 4,096 for page framing. Read pages charge each serialized
message plus a separator and stop at the byte/count bound. Retained mailbox
capacity is 10,000 messages / 64 MiB of JSON-serialized messages, with a separate
1,000-unacknowledged count cap. Channel event/batch accounting is additional.

A binary federation message fitting 64 KiB can still fail native escaped-page,
mailbox, reply or policy admission. Conversely, an admitted native string may
need more than 32 KiB once its encrypted metadata is encoded. These are separate
boundaries, not interchangeable size estimates. Federation must preserve native
rejection and finite relay capacity rather than enlarge either silently.

## Reproducible lightweight witnesses

Run `node tools/feasibility/federation-native-budget.mjs`. This calls the actual
payload and message constructors with synthetic identities, not a broker process.
It does not test authentication, parent existence, full send, commit or recovery.
Its forty-byte reply ID is a shape witness; source inspection establishes the
parent-existence requirement. No credentials or real messages are used.

Both well-formed and lone-surrogate bodies reach exactly 32,768 native body
bytes and pass payload/message-construction checks. The lone-surrogate witness
uses `("a" + lone high surrogate)` repeated 8,192 times, sixteen 256-surrogate
refs and a 128-surrogate correlation. Its escaped message is 83,168 bytes,
below 126,976. It is an actual validator counterexample to the earlier candidate's
well-formed-only text rule, not a claim of authenticated/persisted acceptance.

The calculator computes structural CBOR sizes without implementing a serializer,
crypto, network or storage. Maximum metadata uses three-byte BMP characters:
256 UTF-16 units encode to 768 UTF-8 bytes per ref, and 128 units to 384 bytes
for correlation/reply. The earlier candidate bounds of 1,024/512 bytes were conservative UTF-8
allowances, not reachable maxima; the revised candidate uses lossless strings.

| Proposed representation | Encoded plaintext | Candidate wire with maximum header |
| --- | ---: | ---: |
| Well-formed text, payload-validation reply bound | 45,918 | 46,597 |
| Well-formed text, actual forty-byte reply ID | 45,573 | 46,252 |
| Constructed lossless run-array witness, validation reply shape | 54,110 | 54,789 |
| Constructed lossless run-array witness, actual reply ID | 53,765 | 54,444 |

The subsequent [lossless size-bound proof](federation-lossless-bound.md) corrects
these nonmaximal witnesses: alternating three-byte BMP characters and lone
surrogates increases metadata size. Its assumptions yield 56,284 plaintext /
56,963 wire bytes, or 55,876 / 56,555 with actual generated reply IDs. The earlier
54,110 example was never a proven upper bound.

## Recommendations requiring review

Keep the accepted 32 KiB **body** cap and separately bound encrypted metadata
within the accepted 64 KiB wire cap. A well-formed-only profile could budget
45,918 plaintext bytes, but must explicitly disclose its Unicode restriction.
For full native string preservation, one candidate requiring a proven size bound
is a union: well-formed CBOR
text, or a CBOR array of maximal nonempty well-formed text runs and unsigned
integers representing only unpaired surrogate code units. This is an encoding
alternative, not an adopted production construction.

That alternative needs exact canonical rules: reject empty/adjacent text runs,
nonmaximal runs, scalars encoded as integers, paired high/low surrogates encoded
as two integers, and text form containing malformed UTF-8. Test adjacent high
surrogates, high/low pairs across runs, trailing lone surrogates and mixed valid
supplementary characters. Reassembly must preserve code units without silently
normalizing valid pairs. Bound nesting and every array's element count before
allocation: a body can contain 16,384 alternating text/surrogate elements in the
worst-size witness; a conservative parser element ceiling still needs review
for all legal run patterns. The revised profile explicitly specifies these proposed parser bounds.

The constructed 54,110-byte witness includes a 40,963-byte run-array body and
maximum native metadata. It does not prove a global maximum over every legal
run pattern; the linked proof supplies a larger maximum and parser bounds under its stated
canonical-run assumptions; 54,110 must not become a production cap. The existing maximum header adds 679 bytes including
encapsulation, tag, signature and CBOR framing, yielding 54,789 wire bytes.
Endpoint unions, channel context or additional proofs require recalculation.
A narrowly scoped direct soul adapter can avoid implying principal/channel
federation support, but must explicitly declare that limitation and preserve
existing local behavior.

For the earlier nonmaximal 54,789-byte envelope scenario, a 256 MiB relay body budget holds at most
4,899 envelopes, a 32 MiB route budget 612, and a 64 MiB local-per-relay budget
1,224, before any other charged serialized custody metadata. Those byte limits
can bind before their count limits. Charge actual retained bytes, reserve
outcomes atomically, reject growth without eviction, and do not use this
arithmetic as permission to raise caps. Receipt/outcome proof budgets remain
separate as described in the [receipt candidate](federation-receipt-candidate.md).

The proved 56,963-byte scenario instead fits 4,712 relay bodies, 589 per-route
envelopes and 1,178 local-per-relay envelopes before additional metadata. The
proof does not approve the encoding, parser or federation implementation.
