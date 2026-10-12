# Owner decisions: proposed shared fixture specification

The [wire schemas and state machine](owner-decision-wire.md) are a joint-review
draft for accepted ADR-0077. These fixtures make its bytes and boundary examples
reviewable without introducing a production codec, broker route or owner gate.
Passing their consistency command is not permission to enable owner decisions,
evidence of native custody or completion of any #77 requirement.

## Static artifact and executable consistency

The language-neutral artifact is
[`tests/fixtures/owner-decisions/v1.json`](../tests/fixtures/owner-decisions/v1.json).
All IDs, keys, digests, packages and scenarios are synthetic test inputs. Only
public verification keys are included; they must never be enrolled by an
installation. Package/configuration digest placeholders are codec inputs, not
evidence of real staging or validated packages.

```bash
node tools/acceptance/owner-decision-vectors.mjs
```

This command reads the static artifact and checks exact UTF-8/base64url/digest
bindings, public-key IDs, Ed25519 signatures over ASCII payload segments,
cross-token action/nonce/identity bindings, display lengths and the documented
clock equations. Signature checks also demonstrate that decoding the signed
segment or altering it changes verification. It does not issue a token, create
an identity, load a credential, contact a broker or mutate state. It imports no
production owner-decision implementation, because that implementation does not
exist yet. Its malformed-byte cases are expectations for future independent
Rust/JavaScript consumers; the command explicitly does not claim they pass a
production parser.

| Artifact field | Meaning and required consumer assertion |
| --- | --- |
| `keys` | DER SPKI public bytes and SHA-256 key IDs, plus raw presence public bytes for the existing bot p1 verifier; never first-request trust. |
| `positive` | Exact canonical action JSON/base64url/digest, labeled summary/action text, scalar/byte lengths, complete signed p1/d1 tokens and complete-token receipt digest for every operation/mode. Quoted/backslash/non-ASCII scalar input is included. |
| `displayBoundaries` | 400 scalars accepts, 401 refuses; 500 UTF-8 bytes accepts, 501 refuses; a 64-character account makes a longer otherwise valid reason unpreparable. Signed examples describe bytes only: a refused display must never reach a real issuer. |
| `serialization` | Exact nested ASCII key order, raw Unicode scalar bytes, all required control/string escapes, integer endpoints and zero. These are generic serialization vectors, not allowed operation parameters. |
| `negativeActionBytes` | Original bytes, including duplicate/non-ASCII/unknown keys, invalid UTF-8/surrogates, alternate escapes/escaped slash, noninteger/unsafe numbers, BOM and outside whitespace. Do not pre-parse through a library that loses duplicate keys or invalid bytes. |
| `primitiveCases` | Existing soul UUID versions 1–8/RFC variant versus unrestricted principal UUID groups and request v4; normalized WHATWG HTTPS host spelling including IPv6. Grammar acceptance is separate from target/staging authorization. |
| `receiptClockCases` | Strict receipt time envelope, including future equality, expiry equality, zero/61-second lifetimes, negative and fractional timestamps. |
| `preparationClockCases` | Symmetric 30-second preparation timestamp skew, unchanged broker/stage deadlines and expiry equality. |
| `nativePresenceClockCases` | Existing p1 expiry grace equality and one second beyond it. Preserve these semantics separately from strict d1 expiry. |

Both implementing repositories consume these exact bytes and assert the same
outputs. They must not regenerate the expected bytes with their candidate
codec. Canonical-encoding changes require joint review and an explicit fixture
revision; update neither language's expectations merely to match its output.
The native p1 signer need not serialize JSON in d1's canonical format: its
signature covers its original payload segment, and the proposed presence digest
preserves the whole original token.

## Required implementation cases beyond static examples

| Consumer / layer | Required focused cases before support can be advertised |
| --- | --- |
| Rust and JavaScript codecs | Every static positive and negative byte example; duplicate fields at every nested object; unknown operation/parameter fields; invalid ID/revision/digest types; maximum nesting/frame/token sizes; padded or noncanonical base64url including nonzero unused trailing bits; wrong key, version, audience or signature; d1/p1/grant/owner-statement audience substitution. |
| Typed display/native adapter | Reconstruct every labeled summary; JSON quote/backslash literals are displayed exactly; controls in reason refuse; every 400/401 and 500/501 boundary; long account/Unicode refuse before prompting; altered staging locator/expected revision changes the payload digest even when its summary is unchanged; no caller prompt override, truncation or automatic local fallback. |
| Broker grants and relay | Every operation and cold-wake mode; wrong principal/account/soul/operation and mixed credential kinds refuse without disclosure; unjoined soul resolved only by its daemon; receive allowlists do not become administrative grants; selected watch disconnect/multiple watches/daemon key reuse after epoch change; duplicate prepare never redelivers work. |
| Broker release journal | Cancel/confirm races have one durable winner; revocation/rotation before release refuses; later revocation does not recall release; check response binds the complete token digest/target/epoch/watch/deadline; repeat checks never return mayApply true; loss of response/restart becomes uncertain. Fsync/directory write failures prevent delivery/release/effects; compaction preserves all accepted-ID tombstones; finite journal admission reserves lifecycle/reconciliation capacity before forwarding and never evicts IDs/evidence; unsettled snapshots retain their staging quotas. |
| Daemon coordinator/application | Async check stays outside current synchronous locks; local writes racing release cause final-lock state refusal; no effect at receipt-expiry equality; consumption precedes effects; all mutation variants including edit apply false and webhook/settings atomicity; duplicate concurrent attempts and crashes before/after every journal/effect boundary. |
| Staging/native custody/cutover | Typed package/webhook snapshot validation, target/principal/request binding, quotas/TTL, no paths/symlinks/secret exports and no broker-held webhook inputs; real signed-host allowed/Node and security denied; protected principal and presence seed; separately pinned native source/version and entitlements; interrupted revoke-before-re-pair cannot restore old authority. |
| Status and reconciliation | Current authority required for principal status even after expiry; revoked principal cannot inspect it; local owner can inspect stranded work through existing local ceremony; no new effects, grants or ID reset; request-linked proof plus actual state required; preexisting matching setting and partial/unknown changes remain indeterminate; changed-epoch daemon may report only owner-local reconciliation, never release/application. |

Record issuer, verifier, exact test name, command/result, reviewed source and
released component tuple for these cases in the
[conformance evidence](owner-decision-conformance.md). Static consistency,
documentation checks and existing target-query/transport tests cannot be used
as substitutes for those implementation or live native results.


## Additive display-policy rejection vectors

[display-rejections-v1.json](../tests/fixtures/owner-decisions/display-rejections-v1.json)
is a separate unsigned policy supplement pinned to the original v1 fixture
SHA-256. It adds rejection cases for Unicode general categories `Cc`, `Cf`,
`Zl` and `Zp`, including bidi overrides/isolates and supplementary format tags.
The original signed v1 positives and canonical encoding are unchanged. This
is a stricter owner-action admission/display policy, not a fixture rewrite or
change to legacy keyd's p1 verifier. Both implementing repositories must adopt
the same rejection policy before claiming compatible native display support.

The codec test checks every frozen rejected scalar, each outside boundary and
all four revision operations, alongside
ordinary RTL letters, combining marks, variation selectors and distinct
precomposed/decomposed spellings. Accepted strings retain exact bytes; this
policy intentionally refuses even linguistically useful format controls such
as ZWJ/ZWNJ rather than silently removing them. The supplement carries no
signature, authority or new cryptographic serialization rule.


The policy is frozen to [Unicode 17.0.0 DerivedGeneralCategory.txt](https://www.unicode.org/Public/17.0.0/ucd/extracted/DerivedGeneralCategory.txt),
SHA-256 `d62e5bab70ca74f099343f71224fa051cb1fdd61a1ab45c0488c44cfc0b6102e`.
The supplement lists inclusive scalar ranges; production uses those explicit
ranges rather than runtime-dependent Unicode property tables. Native consumers
must use the same ranges even when their OS Unicode version differs. A literal
backslash followed by `u202E` is ordinary permitted text; do not interpret it
as a Unicode escape after canonical JSON decoding.
