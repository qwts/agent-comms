# Daemon evidence admission companions

These synthetic conformance vectors exercise private Comms runtime admission.
They are not live daemon output and do not establish a deployed preparation-v2
producer, authenticated transport, owner ceremony or durable journal behavior.

`generate.py` uses independent Python JSON/UTF-8/SHA-256 encoding. It pins the
unchanged `effect-evidence-v2.json` and original `v1.json` action inputs by hash.
For each operation, it supplies typed observation preimages and all three
reconciliation findings, plus no-preparation indeterminate observation.

Revision events use the field insertion order of daemon commit
`13ab9a7878d4a0826162400986c21ccb7ca88d0c`: `schemaVersion:1`, operation-specific
event fields, exact owner-decision authorization/linkage, then ISO timestamp and
LF. They are synthetic instances of that writer format. Their digests replace
the placeholder journal digest in the unchanged v2 completion template, and
the applied pair basis is rebound to that exact completed record. Refusal basis
and observation digests are independently encoded. Cold completion retains its
existing exact template bytes.

The pair contract is pinned to daemon commit
`36a6ecde5a8a49d80d32895a120fb272e412ab2f`. That daemon commit uses preparation-v1;
these v2 synthetic companions do not claim it produced the rebound bytes.
Trust writers in #1052 and observation negatives in #1055 likewise do not
establish a daemon preparation-v2 writer.
Daemon #1056, merged at `0705b08f59ad8ac3a3a7e51630ff0c92fa2bfb47`, now
implements that writer's live trust version and final entry version check.
These independently generated companions remain synthetic; they do not prove
actual producer composition with the Comms admission module.

Regenerate from the repository root:

```sh
python3 tests/fixtures/owner-decisions/daemon-admission-v2/generate.py
```

The runtime tests compare each accepted token's exact digest to these independently
encoded bytes and require retained original event bytes/sequence. Legacy summary
digests alone, absent/mismatched writer authorization, wrong basis, wrong typed
preimage, missing ceremony or inconsistent graph assertions refuse.
