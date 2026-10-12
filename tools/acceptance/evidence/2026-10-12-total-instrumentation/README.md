# Total instrumentation evidence, 2026-10-12

The [interpretation and limits](../../../../docs/local-diagnostics-total-overhead.md)
cover this scoped macOS archive comparison. Related to
[#164](https://github.com/qwts/agent-comms/issues/164) and
[SOP #85](https://github.com/qwts/qwts-agent-sop/issues/85); both issues remain
open. The [earlier reporting-only evidence](../2026-10-12-local-diagnostics/README.md)
is unchanged, including all failed and confounded results. This update adds eight failed/unread
runs without replacing the original healthy evidence.

## Retained records

[artifact-hashes.json](artifact-hashes.json) records SHA-256 and byte length for
every retained original JSON record and the exact frozen runner snapshot.

| Artifact | Meaning |
| --- | --- |
| [Preflight 01 failure](preflight-01-failure.json) and [disposition](preflight-01-disposition.json) | Truncated macOS `ps` executable identity; no timed workload; verified terminal cleanup, scratch retained |
| [Preflight 02 failure](preflight-02-failure.json) and [partial runs](preflight-02-partial-runs.json) | Helper import resolved `/tmp` to `/private/tmp`; prior old cases completed; no timed workload; verified terminal cleanup, scratch retained |
| [Preflight 03](preflight-03-success.json) | Four startup/normal-or-fault cleanup cases passed after identity corrections |
| [Preflight 04](preflight-04-success.json) | Four cases passed after directly owned abnormal termination handling was corrected |
| [Frozen preflight 05](preflight-05-frozen-success.json) | Four cases passed at the exact healthy-run runner; absent old helper has null lifecycle result |
| [Healthy results](healthy-results.json) | Both opposite-order pairs pass unchanged candidate thresholds |
| [Healthy individual runs](healthy-runs.json) | All four outcomes, latency/lateness windows, CPU/RSS samples, startup and natural cleanup |
| [Failed/unread results](failed-unread-results.json) | Four independent pairs pass unchanged candidate thresholds |
| [Failed/unread individual runs](failed-unread-runs.json) | All eight outcomes, latency/lateness windows, CPU/RSS samples and natural cleanup |
| [Frozen runner](runner.mjs.txt) | Exact tested source, SHA-256 `0437dcc8af4ce34a7e5fa7f7e16041bade7bbc63f2a0e0a80c2f8b25c253403a` |

Preflight 01's runner hash was recorded before launch and in its later
disposition. Preflight 02 records its runner hash in the original failure; the
later successful records also contain their runner hashes. Those intermediate
runner source snapshots were not retained, so no exact intermediate-source
reconstruction is claimed. The frozen runner snapshot is verified against the
hash recorded in preflight 05 and the healthy result.

The fault cases inject a harness failure after identity observation, before a
timed workload. They do not patch either runtime archive. CPU seconds are
recorded, not gated. Sparse appends and one embedded Broker/client process
limit the claim; compaction, every internal error and native Windows numeric
evidence remain open. Failed helpers are checked for no respawn. Unread stderr
is configured but never consumed, and no private queue count or direct stalled
write is claimed.

## Source archives and reproduction

Both complete production source archives were retained outside Git during the
run. They contain no generated credentials. Their exact identities are:

| Revision | Commit | Tree | Tar SHA-256 |
| --- | --- | --- | --- |
| Old | `25dfa8362401489503f704c7322ad1314b7e6ddb` | `125c504a11148b2eec922f915683fb32d1366b48` | `03825d8bc712fdc1e844316635cca495c3d87ee884f255f81c9dfc731e68a67c` |
| New | `e648d71277da72fc50c70ebcbb94c3c8f53c7cf3` | `a3bdaab0a6fa7068b293ab34dea66bba670b4e43` | `ca84dcec8c2a219025b936b953c3a48b3d387591fc114c8034af865fe711f25b` |

The tool needs these objects already present in the local Git database. It
writes `old.tar`, `new.tar`, extracted source trees and JSON records into a new
output directory. Preserve that directory as an external acceptance artifact;
do not check source tarballs, extracted trees or generated broker credentials
into Git. The archive bytes can also be regenerated using
`git archive --format=tar COMMIT` and checked against the hashes above. Use the
explicit commands in the [acceptance instructions](../../README.md), the same
actual supported Node executable for both pins and a coordinated quiet interval.

The healthy run started at 02:34:00 UTC and terminal cleanup was observed at
02:38:51 UTC on 2026-10-12. Root and both other agents held runtime/tests/builds
through that interval. Each opposite-order pair retains its own pass/fail;
passing averages never cancel a failure. The separate failed/unread run started
at 03:08:52 UTC and terminal cleanup was observed at 03:18:24 UTC on the same
date, under a new coordinated hold. Its eight runs and four individual pair
results are retained unchanged. Every owned process and candidate helper exit
was confirmed. Both source-archive hashes, Node executable hash and exact runner
hash match the healthy comparison. No retry occurred.
