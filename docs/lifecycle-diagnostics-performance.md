# Incremental lifecycle diagnostic overhead

Related to [#164](https://github.com/qwts/agent-comms/issues/164),
[PR #225](https://github.com/qwts/agent-comms/pull/225) and
[SOP #85](https://github.com/qwts/qwts-agent-sop/issues/85). All six
opposite-order pairs pass the unchanged proposed ENG-0085 budgets for this
specific embedded Broker/client macOS workload. This is scoped evidence, not
native Windows, packaged-host or complete observability acceptance.

## Exact source and workload

The baseline is `a618508ab4c4d7185b198c89b1befce513a66b8e`; the candidate is
`5276f77d6bbcc68e42ef6ba5654495d2df56bc35`. Both complete production source
archives use default diagnostic callbacks, unchanged runtime defaults and the
same Node v26.11.1 executable on Darwin 27.0.0 arm64, 18 logical CPUs. Both
already contain the bounded sink/helper; this measures the incremental
[lifecycle producers](lifecycle-diagnostics.md), unlike the historical
[total instrumentation comparison](local-diagnostics-total-overhead.md).
Archive, runner and Node hashes are retained in the
[evidence index](../tools/acceptance/evidence/2026-10-12-lifecycle-overhead/README.md).

Each fresh process performs 100 actual requests/s for 60 seconds, then ten
seconds at that rate with 1000 actual local client failures/s. Sparse send/read/ack
and expected permission refusals retain canonical behavior at both pins. Actual
watch work is one churn/s and one persistent watch reconnected through its
owned channel every ten seconds: 70 churn-ready, one initial persistent-ready,
seven recovered-ready and one watch refusal per run. The diagnostic burst is
client failures, not 1000 lifecycle completions/s.

Watch work is outside request service latency; its scheduling effect remains
in driver lateness and total throughput. Maximum recorded driver lateness is
256.859ms healthy, 256.558ms failed-helper and 255.523ms unread, consistent with
the deliberate reconnect wait/backoff. The results establish no request
scheduling or end-to-end deadline guarantee. Startup/import/warmup and ordinary
broker stop/restart recovery are separately reported, outside steady-state
latency thresholds. CPU is recorded without a pass threshold.

## Results and failure behavior

Each mode runs old/new/new/old. Every opposite-order pair independently passes
p95 increase at most 2ms, p99 at most 5ms, completed throughput at least 98%,
additional simultaneous main-plus-helper RSS at most 64MiB and natural exit
within two seconds. No failed runtime attempt or unchanged rerun occurred.

| Mode/order | Quiet delta p95/p99, ms | Burst delta p95/p99, ms | Minimum throughput ratio | Added RSS, KiB | Candidate exit, ms |
| --- | --- | --- | --- | --- | --- |
| Healthy old/new | 0.078792 / 0.131958 | 0.094209 / 0.128875 | 0.9998537 | 576 | 5.175542 |
| Healthy new/old | 0.031667 / 0.022625 | -0.065833 / 0.042833 | 0.9999088 | -1104 | 6.161667 |
| Failed old/new | 0.029626 / 0.022125 | 0.235625 / 0.133667 | 0.9999939 | 1120 | 5.767375 |
| Failed new/old | -0.021125 / -0.036167 | 0.102042 / -0.039166 | 0.9999448 | -208 | 9.391833 |
| Unread old/new | -0.018959 / -0.027875 | -0.217750 / -0.167167 | 1.0000172 | 2576 | 4.661583 |
| Unread new/old | -0.013958 / -0.032416 | 0.021374 / 0.121375 | 0.9999844 | -1712 | 4.992792 |

All twelve runs preserve matching canonical/watch outcomes and confirm actual
fixture exit, helper absence and independent stdio closure. Failed mode
terminates each pin's verified helper while the owning fixture is live and
checks no respawn. Consumed output is checked through child close for exact
allowlisted fields/tuples and body/secret/path canaries. Healthy candidate
records include successful local readiness and recovery; best-effort burst or
shutdown loss never replaces canonical outcomes or exit receipts.

Unread stderr remains unconsumed, with zero bytes inspected. Its owned pipe
is disposed only after fixture/helper exit. A configured unread destination
proves neither private queue occupancy nor a particular blocked write. Existing
bounded sink regressions retain those separate checks. RSS and sparse appends
do not prove long-duration plateaus, compaction or isolated storage overhead.

## Coordination, provenance and applicability

Root and both other agents held local tests/builds/performance work for each
approved group. Start/terminal observations and their activity limits are
retained: healthy followed the 12:26:45 UTC observation and terminal cleanup was
observed at 12:31:48; failed-helper terminal at 12:43:05; unread terminal at
12:49:07 on 2026-10-12. OS/UI/browser, other sessions and external activity were
uncontrolled. These agreements and observations are not absolute machine quiet.

Both eight-case preflights and their exact runners remain retained. Root review
found that the first runner checked output before final stop. The corrected
runner independently awaits child close after fixture/helper exit, then checks
consumed complete lines, including shutdown output. Preflight 02 passes all
eight cases; original evidence is not overwritten or relabeled.

Root independently recomputed all six pair results from twelve raw runs. The
source rebase onto main `da9c2c67f879aa8c7929c886d849127c6758a2d9` preserves
byte-identical measured runtime files and the exact three-file instrumentation
patch. Main adds private owner-receipt fixture adapters with no production
consumer on this workload. The retained applicability audit supports these
unchanged paths; it is not a new benchmark of the rebased archive. Original
archive pins and hashes stay unchanged. Native Windows numeric budgets,
packaged hosts, separate daemon/CLI deployment, other error paths and the
remaining #164 workstreams stay open.
