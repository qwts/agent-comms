# Daemon-local preparation v2 vectors

This separate disabled producer contract preserves the v1 fixture and checker.
The daemon writes preparation v2 only: its exact fields are the v1 preparation
fields plus `trustVersion`, a safe odd integer from 1 through 1023. At entry the
daemon must reject a current trust version that differs from the saved version.
This is local durable evidence, not an addition to the public challenge or a
claim that agent-comms implements the daemon's runtime decoder or effect path.
Historical v1 fixtures and decoding contracts remain unchanged.

The sibling `effect-evidence-v2.json` contains all existing operation examples,
entered/completed/refused evidence with rebound preparation digests, and the
reconciliation basis digests affected by those changes. Only preparations use
record version 2; effect and reconciliation records retain version 1. A separate
boundary preparation uses trust version 1023. Closed negative preparations cover
missing, even, zero, 1024, noninteger and extra-key inputs. Entry examples cover
matching and changed trust versions.

Regenerate from the repository root:

```sh
python3 tests/fixtures/owner-decisions/preparation-v2/generate.py
node tools/acceptance/owner-decision-preparation-v2-vectors.mjs
node --test tests/owner-decision-preparation-v2-vectors.test.mjs
```

The Python generator derives only this new fixture from unchanged v1 source
records; both consumed v1 input files have SHA-256 bindings in the fixture.
The independent Node checker validates semantic record unions,
canonical bytes, caps, hashes, request/effect links, negative schemas and trust
entry equality. These are specification vectors, not authority, live entry
validation or Windows/installed-host acceptance.
