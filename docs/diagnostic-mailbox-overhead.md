# Mailbox diagnostic reporting overhead

This local macOS evidence advances #164 without completing its platform or host
acceptance. It measures process-start diagnostics off versus enabled reporting
on the same production archive. Existing producer calls and duration timing
remain in both configurations; this does not measure total instrumentation cost.

## Distinct immutable observations

| Group | Both source pins | Runner SHA256 prefix | Result |
| --- | --- | --- | --- |
| healthy02 | `f5195ee0894b8b2c8d3f9f5946948b20f82a5b12` | `90d33f58` | Both pairs passed |
| failed01 | `f5195ee0894b8b2c8d3f9f5946948b20f82a5b12` | `83c2abf1` | First pair failed p95 budgets; stopped before run three |
| failed02 | `f0eafb4faffa757b46310c25792dd126ea611f76` | `c0caf7da` | Both changed-source pairs passed |

Failed01 remains failed: aggregate p95 increased 2.182042 ms and delivered-read
p95 increased 2.210751 ms, exceeding the unchanged 2 ms budget. PR242 added a
recognized-token disabled return before detail construction and rate-clock work,
while retaining the late reentrant failure guard. Failed02 measures that changed
implementation. These sequential observations do not establish causation for
failed01 or isolate the optimization's effect. Healthy02 is an earlier source
pin; no healthy measurement of the changed implementation is claimed.

The [immutable evidence directory](../tools/acceptance/evidence/2026-10-12-mailbox-diagnostics/README.md)
retains separate results, failure records, raw runs, checkpoints, tool snapshots,
host observations, exact hashes and independent verification receipts.

## Workload and boundaries

Each completed run schedules 72000 requests over 720 seconds: 1200 fresh sends,
1200 delivered reads, 1200 grant-filtered censuses, 1200 fresh acknowledgments,
66480 empty reads and 720 wrong-secret refusals. Four recipients rotate at
100 sends/account/minute and 25 sends/pair/minute, below unchanged 120/30 limits.
There are 720 watch churns, 72 owned reconnects and one persistent watch per run.
Request service latency excludes watch waits; driver lateness is retained.

Failed mode observes the exact writer helper, kills it after warmup, verifies
its disappearance and rejects observed respawn/replacement. Off has no helper;
helper killing is inapplicable. This proves neither helper restart nor lossless
capture. Consumed diagnostic records pass the strict profile; no queue plateau,
blocked-write or unread-destination acceptance is claimed.

Opposite-order pairs are off/on and on/off. Each operation and aggregate require
p95 increase at most 2 ms, p99 at most 5 ms, throughput ratio at least 0.98,
additional sampled RSS at most 64 MiB and both natural shutdowns at most 2 s.
The failfast module persists each pair after both cleaned runs, refusing the
next run or mode on failure. Thresholds and production deadlines never changed.

RSS samples include one embedded Broker/client process and its writer helper,
excluding the orchestration driver. One-second sampling does not establish an
absolute peak. Shutdown includes stop, actual process exit, helper disappearance
and stdio closure. Local helperless enabled work after failure remains measured.

## Changed-source failed02 result

Both archives use tree `902aee03358f482f382c2b830822b4cbde5f71fe`, tar SHA256
`f89a7ab7d0af897893fefc728910e75263ec17cedf69d0a62e3b05b0eebac5d6`.
Tool identity includes runner SHA256
`c0caf7dae5358c6ef20cf761347cc4a48c1807d9987d0d01fd4442b3343bfe65`
and pair-module SHA256
`37290b1872c809df0104e9f4551884de5ad35f3822ec0ae27a0e4c095c3473bb`.

| Metric | Off/on | On/off |
| --- | --- | --- |
| Aggregate p95 increase | -0.022374 ms | -0.080959 ms |
| Aggregate p99 increase | -0.215251 ms | -0.466541 ms |
| Throughput ratio | 1.000082 | 1.000534 |
| Additional sampled RSS | -4704 KiB | 496 KiB |

Every operation passed the unchanged budgets. All four runs completed exact
canonical/watch counts and 72000 raw samples each; every operation and aggregate
quantile was independently recomputed. All 48 checkpoints are retained, twelve
per run. Actual terminal and stdio closure were confirmed throughout; off had no
helper and enabled helpers were gone. Shutdown took 4.141/3.931/4.423/4.437 ms.
Driver lateness reached 1370.978 ms, so no scheduling deadline guarantee follows.

Other agents held local builds/tests during measurement, but external machine
activity was uncontrolled. This is macOS reporting/sink evidence only. Windows,
native connector, packaged host, live-host consumption, OTLP, offline-export
command cost and changed-source healthy/unread measurements remain outside this
receipt. No unread group or further numeric run was authorized or performed.
