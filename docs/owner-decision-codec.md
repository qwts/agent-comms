# Owner decisions: disabled pure codec

This internal implementation slice supports [#77](https://github.com/qwts/agent-comms/issues/77)
and the proposed [wire contract](owner-decision-wire.md). It enables no broker
route, native ceremony, receipt issuance, migration or owner capability. No
production route imports either codec module.

## Covered checks

`lib/owner-decision-canonical.mjs` accepts byte arrays, caps their intrinsic size
at 32 KiB, rejects invalid UTF-8, bounds container nesting before JSON parsing,
and compares the decoded value's canonical representation with the original
bytes. This refuses duplicate keys, alternative number/escape spellings,
non-ASCII keys, unpaired surrogates, whitespace and BOM. Unknown ASCII fields
remain a schema check. Failures expose fixed errors, never parser input/text.

`lib/owner-decision-codec.mjs` validates exact action fields and each operation's
parameter shape. It reproduces the payload digest, typed summary and complete
native action text, enforcing both scalar and byte display limits. Identity and
webhook host grammar do not resolve a target or authorize a destination. A
staging identifier/digest does not prove a valid immutable snapshot.

The signed-receipt verifier accepts an independently supplied Ed25519 public
KeyObject. It checks bounded ASCII token framing, canonical base64url and JSON,
exact d1 schema/audience, key identifier, Ed25519 signature over the original
payload segment, receipt lifetime/skew and expiry. It returns decoded fields
and the digest of the complete token. It never learns a trusted key from a token.

## Explicit remaining checks

A valid result is **not authorization to mutate**. Callers must still verify
the separate bot-owned p1 presence proof, enrolled presence custody, original
action and saved challenge bindings, preparation/presence expiry caps, selected
watch/daemon epoch, current grants and revocation, durable single-use release,
final locked state and effect evidence. None of those adapters is supplied by
this codec. No arbitrary verification callback substitutes for them.

Decoded values are ordinary objects, not durable or trusted capabilities. A
consumer must bind its independently verified inputs to its journal and must
not expose a signature-only success as complete owner-decision verification.
Existing p1 semantics remain owned by agent-bot.

## Validation

Run the focused checks with supported Node:

```sh
node --test tests/owner-decision-canonical.test.mjs tests/owner-decision-codec.test.mjs
```

Tests consume the shared action/receipt and malformed-byte fixtures, display
boundaries, signed invalid schemas, independent key mismatch, time equality,
UTF-8/scalar errors, intrinsic byte bounds and adversarial typed-array subclasses.
They establish pure parsing/signature behavior, not live native custody,
broker/daemon interoperability or R1–R4 acceptance. The
[conformance matrix](owner-decision-conformance.md) retains those requirements.
