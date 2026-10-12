# Local diagnostic measurement artifacts

These records accompany the [performance disposition](../../../../docs/local-diagnostics-performance.md).
All JSON reports are byte-for-byte copies of the original output. No failed or
confounded result was removed. Corrected runner snapshots are retained as text;
paths/imports reflect the original tool location, so these copies are not entrypoints.

`observer-sync.reconstructed.mjs.txt` is a later reconstruction, not a verified
exact tested-source snapshot: the initial runner was not hashed before launch.
The other source hashes match their contemporaneous pre-launch records.

| Artifact | SHA-256 |
| --- | --- |
| [counterbalanced.json](counterbalanced.json) | `631f09d3846320c65b8519231dbab996eaba1669f1559cdfb7805913976537cf` |
| [counterbalanced.mjs.txt](counterbalanced.mjs.txt) | `d303068e421d98d71ce67899d145bbd7a73d0975468feff37e90fcc871cd9f89` |
| [observer-async.json](observer-async.json) | `0a1ad236b7d28d139350f42ad0aebaba0be44bfeb439871e00299099e90a21a9` |
| [observer-async.mjs.txt](observer-async.mjs.txt) | `5a1b45d2417d60d0f5fcb392982f2534a3976f955b4b67474da0475e2486cb0d` |
| [observer-sync.json](observer-sync.json) | `d4649be3da7c59767fbed6cbac7ce2e64b74aa3534403bd8d69739e058ec31e1` |
| [observer-sync.reconstructed.mjs.txt](observer-sync.reconstructed.mjs.txt) | `4e38d39a2c8ec8e017f44d30a3dea3a19f151cfa21cd03ddf5a8dc95eec1761f` |
| [quiet-pairs.json](quiet-pairs.json) | `4c69600e2aff66bb62e598d05213969d18d5cc6cee7db87d0ca148cc02ffbddc` |
| [quiet-pairs.mjs.txt](quiet-pairs.mjs.txt) | `eb3698deded2180fe694a800671683e0db131e0ce75d1ed4d8da4ec5855d5cdc` |

## Measured runtime sources

These files were unchanged across all four runs. The disabled baseline retained
new instrumentation reads/imports, so it does not establish total overhead
against the preceding runtime. See the disposition for remaining acceptance gaps.

| Source | SHA-256 |
| --- | --- |
| [lib/diagnostics.mjs](../../../../lib/diagnostics.mjs) | `1c561f1eb13b0593c92b050016ebfee9da65e25bca3e2e3ef49d3a5db6977d3a` |
| [lib/client.mjs](../../../../lib/client.mjs) | `2bee70707c2e54c8e94a2853d98dc0f40db82855c908e25e7f1f14e07517c461` |
| [lib/broker.mjs](../../../../lib/broker.mjs) | `786a34888f125d7c81b23bd003ef38f1a0e7d6d6c379e554ed4ec51e1c00a30b` |
| [lib/platform/local-channel.mjs](../../../../lib/platform/local-channel.mjs) | `7c74567825a84ae2e893a5a6ee34c8e6408b29ac30d6d5c935560993ba02b925` |
| [lib/platform/diagnostic-stderr.mjs](../../../../lib/platform/diagnostic-stderr.mjs) | `0b41d209569a4227e8dc393c323369f2668f963cf3fb311f63970a8a81e3e214` |
| [lib/diagnostic-writer.mjs](../../../../lib/diagnostic-writer.mjs) | `6ef390447f24a04b63c6f10bfe16af2e3bee9f77fab7596680eda6c397e42efe` |
| [lib/diagnostic-fd.mjs](../../../../lib/diagnostic-fd.mjs) | `744248da4a9f23ea929e29d8fe8d73e9838eb42a038a22f0ba492f1f51efd642` |
