# Immutable mailbox reporting observations

See [scope and interpretation](../../../../docs/diagnostic-mailbox-overhead.md).

Directories retain distinct healthy02, failed01 and changed-source failed02
observations. Failed01 is a failed acceptance result and was not overwritten.
`artifact-hashes.json` records stored and original byte hashes and sizes. Raw
runs and checkpoint NDJSON use deterministic gzip (`mtime=0`); decompression
reproduces the original bytes exactly. Source tar bytes are not duplicated;
the exact commit/tree/archive hashes remain in the result receipts.

Runner snapshots preserve each historical tool identity; failed01 and failed02
also depend on the byte-identical pair module. Current executable runner changes
only both production pins from failed01, with unchanged workload and budgets.
Preflight03 covers the failfast runner at the old pin; preflight04 covers the
changed production pin. Neither is numeric overhead evidence.

Verification receipts preserve original local artifact paths as provenance.
Root independently rehashed failed02's ten artifacts and recomputed all raw
operation and aggregate quantiles. Host observations contain sanitized point
observations, not proof of absolute machine quiet. No secrets, peer identifiers,
message content or diagnostic raw error fields are part of the workload samples.
