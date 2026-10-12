# Fixed frame conformance vectors

These frozen synthetic vectors test storage integrity framing and producer-role
separation. Payloads are repeated bytes, not typed actions, preparations,
receipts or evidence. Successful decoding grants no lifecycle or mutation
authority and establishes no allocation, full-flush or platform support.

`generate.py` independently generates one-byte and maximum payload cases for
all ten broker and fourteen daemon slots, using Python's standard `struct`,
`json` and `hashlib`. The frozen contract is agent-comms commit
`6b90f825b5651a50718046379e5adbea193cbabf`. No producer codec is imported by
the generator. Each vector carries the complete 128-byte header/trailer, exact
payload recipe, slot ID/cap and full frame SHA-256. Reconstruct the payload
region with zero padding to its fixed cap; do not treat `role` as a selectable
runtime codec option.

Regenerate and check from the repository root:

```sh
python3 tests/fixtures/owner-decisions/fixed-frames-v1/generate.py
node tools/acceptance/owner-decision-frame-vectors.mjs
node --test tests/owner-decision-frame-vectors.test.mjs
```

The exact fixture is 51,213 bytes, SHA-256
`9c9e9812291b876dd74fca43680393c2def510c0bc953a949dc1ca028f4d80ba`.
The checked-in generator reproduces it byte for byte. The Node checker verifies
all 48 frame hashes and context/payload/frame digests, exact broker encoding and
decoding for 20 vectors, and refusal of all 28 daemon vectors against all ten
broker slots (280 negative checks). The default test suite includes this check;
Python is needed only for explicit regeneration.

The daemon owner independently checked the same frozen fixture against
[agent-bot PR #1009](https://github.com/qwts/agent-bot-identity/pull/1009), exact
source `f9060a2757e13e2fddb46c50ede9575665b23485`: all 28 daemon encode/decode
cases matched and every broker vector refused against all fourteen daemon
slots (280 negative checks). Root independently fetched and inspected that
pure codec and canonical JSON dependency, then reproduced those daemon results
and all 48 hashes. These are exact-source review receipts, not a daemon runtime
dependency or permission to copy or import its implementation here. The daemon
owner may consume this shared fixture through its own pinned tests.
