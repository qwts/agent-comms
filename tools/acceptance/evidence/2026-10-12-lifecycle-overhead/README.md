# Lifecycle overhead evidence, 2026-10-12

Related to [#164](https://github.com/qwts/agent-comms/issues/164) and
[PR #225](https://github.com/qwts/agent-comms/pull/225). This directory records
bounded preflight and healthy/failed-helper/unread paired numeric groups. This scoped
macOS embedded-process evidence does not accept other deployment variants,
native Windows, packaged hosts or every lifecycle/transport workload.

## Retained artifacts

- [Preflight 01](preflight-01.json) and [its individual runs](preflight-01-runs.json)
  preserve the earlier functional check. Its [original runner](runner-preflight-01.mjs.txt)
  checked consumed diagnostics before final stop; it did not verify the final
  shutdown output or independent stdio closure. Root review identified that gap.
- [Preflight 02](preflight-02.json) and [its individual runs](preflight-02-runs.json)
  pass all eight cases with final output validation after actual fixture exit,
  helper disappearance and independent child-close receipts. No failed runtime
  attempt preceded either retained preflight.
- [Frozen runner](runner.mjs.txt) is the exact executed development source,
  SHA256 `4a76a5f5e00a77c541cb6e45794a41b355acab2556e16e5a3949e8c6be727408`.
- [Artifact hashes](artifact-hashes.json) identify the retained original files.

Baseline is signed PR #197 head `a618508ab4c4d7185b198c89b1befce513a66b8e`,
tree `d5ecc16b35b8b1a5757a508658c5b0a9ed6716a7`. Candidate is signed PR #225
head `5276f77d6bbcc68e42ef6ba5654495d2df56bc35`, tree
`ab47a9e728bda86d22b28980bd9312c158e0ecc2`. Complete unmodified production
archives are loaded in one embedded Broker/client process with default callbacks.
Both pins already have diagnostic helpers; this compares incremental lifecycle
instrumentation and does not reuse historical no-helper baseline assumptions.

Each pin passes healthy normal cleanup, healthy injected-harness-fault cleanup,
failed-helper normal cleanup and configured-unread normal cleanup. All eight
fixtures confirm owned terminal exit and helper exit. Preflight 02 additionally
confirms stdio closure in all eight cases and final complete-line/allowlist checks
for consumed output. Unread stderr is explicitly disposed only after verified
fixture/helper exit and is not claimed as consumed. All six normal cases
confirm one churn-ready, one persistent-ready, one recovered-ready and one
permission refusal through actual production watch operations. Failed-helper
cases apply to both pins. These bounded preflight counts do not establish
steady-state producer overhead, queue occupancy or a stalled stderr write.

The preflights ran while unrelated native/broad source tests were active. This
is a functional/lifecycle check, not a coordinated numeric quiet interval.
Future numeric runs require root review of the exact runner and a separate
confirmed quiet interval. The [acceptance instructions](../../README.md#incremental-lifecycle-instrumentation-comparison)
define the unchanged paired budgets and scoped watch schedule. Preserve all
future failures and opposite-order results rather than replacing these records.

Source tarballs and extracted trees remain external acceptance artifacts in
the original output directory. Generated credential scratch was removed only
after verified fixture/helper terminal cleanup and is never checked in.

## Healthy-only paired group

[Results](healthy-results.json) and [individual runs](healthy-runs.json) retain
one healthy old/new/new/old group at the corrected exact runner. Both
opposite-order pairs independently pass the unchanged candidate budgets.
[Start observation](healthy-host-start.json) and [terminal receipt](healthy-terminal.json)
record the coordinated interval and its limits. Root and both other agents
held local tests/builds/performance work; root used remote GitHub only. OS,
UI/browser, other-session and external activity were uncontrolled. The start
observation saw load averages 3.043/3.855/4.706 and active WindowServer/WebKit/browser
processes on 18 logical CPUs; this is not absolute machine quiet.

The group started after the retained 12:26:45 UTC observation; terminal completion and
cleanup were observed at 12:31:48 UTC. No failed attempt or rerun occurred.

| Pair | Quiet delta p95/p99, ms | Burst delta p95/p99, ms | Minimum throughput ratio | Added RSS, KiB | Candidate exit, ms |
| --- | --- | --- | --- | --- | --- |
| old/new | 0.078792 / 0.131958 | 0.094209 / 0.128875 | 0.9998537 | 576 | 5.175542 |
| new/old | 0.031667 / 0.022625 | -0.065833 / 0.042833 | 0.9999088 | -1104 | 6.161667 |

All four runs preserve identical timed operation outcomes and actual watch
counts: 70 churn-ready, one persistent-ready, seven recovered-ready and one
watch permission refusal. Each confirms actual fixture exit, helper absence
and independent stdio closure. Each candidate's consumed output contains two
broker.started, one broker.stopped, 62 transport.ready and six
transport.reconnected observations. Best-effort burst drops and shutdown loss
mean diagnostic counts are not authoritative watch or exit receipts.

These results establish incremental steady-state overhead for the stated
healthy-destination workload only. Startup/import/warmup and recovery durations
remain separately reported; CPU is recorded without a pass threshold. Failed-helper and unread groups below retain their own coordinated intervals.

## Failed-helper paired group

[Results](failed-results.json) and [individual runs](failed-runs.json) retain
one failed-helper old/new/new/old group at the same corrected runner and exact
archives. [Start observation](failed-host-start.json) confirms no known prior
owned runner/test/build compute was observed. [Terminal receipt](failed-terminal.json)
records completion observed at 12:43:05 UTC. Root and the other agents held
local compute; OS/UI/browser and external activity remained uncontrolled.
No runtime failure, retry or unchanged rerun occurred.

| Pair | Quiet delta p95/p99, ms | Burst delta p95/p99, ms | Minimum throughput ratio | Added RSS, KiB | Candidate exit, ms |
| --- | --- | --- | --- | --- | --- |
| old/new | 0.029626 / 0.022125 | 0.235625 / 0.133667 | 0.9999939 | 1120 | 5.767375 |
| new/old | -0.021125 / -0.036167 | 0.102042 / -0.039166 | 0.9999448 | -208 | 9.391833 |

Both opposite-order pairs independently pass all unchanged gates. Each pin's
verified helper is terminated while its owning fixture remains live and stays
absent throughout the workload; this treatment applies symmetrically to both
pins. All four runs retain identical canonical/watch counts, actual fixture
exit, helper absence and independent stdio closure. Each candidate retains one
startup observation consumed before helper termination; missing later diagnostic
records do not mean watch or delivery operations failed.

## Configured-unread paired group

[Results](unread-results.json), [individual runs](unread-runs.json),
[start observation](unread-host-start.json) and [terminal receipt](unread-terminal.json)
retain the final unread old/new/new/old group. The exact runner and archive
hashes match both prior groups. Root maintained the coordinated hold; external
OS/UI/browser activity remained uncontrolled. Terminal cleanup was observed
at 12:49:07 UTC. No runtime failure, retry or unchanged rerun occurred.

| Pair | Quiet delta p95/p99, ms | Burst delta p95/p99, ms | Minimum throughput ratio | Added RSS, KiB | Candidate exit, ms |
| --- | --- | --- | --- | --- | --- |
| old/new | -0.018959 / -0.027875 | -0.217750 / -0.167167 | 1.0000172 | 2576 | 4.661583 |
| new/old | -0.013958 / -0.032416 | 0.021374 / 0.121375 | 0.9999844 | -1712 | 4.992792 |

Both opposite-order pairs pass all unchanged gates. All four canonical/watch
outcomes match, with actual fixture exit, helper absence and independent stdio
closure confirmed. Diagnostic bytes consumed are zero by design. The owned
unread pipe is disposed only after verified fixture/helper exit. This proves
neither private queue occupancy nor a particular stalled write; existing bounded
sink regressions provide separate queue/failure evidence.

All six opposite-order pairs pass for this defined embedded-process macOS
workload. This does not accept native Windows, packaged hosts, separate daemon
and CLI deployment, every error path, or unbounded lifecycle traffic. The
1000/s burst is client failures; actual watch workload remains one churn/s and
one reconnect/10s. Startup/import/warmup/recovery and CPU remain separately
reported with their original limits. Issue #164 remains open.

## Independent verification and rebase applicability

Root [independently recomputed all six pairs](root-sixpair-verification.json)
from the retained twelve runs, checking the exact result/run hashes, matching
canonical/watch outcomes and actual fixture/helper/stdio cleanup. Maximum driver
lateness was 256.859ms healthy, 256.558ms failed-helper and 255.523ms unread.
The workload deliberately waits for watch readiness after disconnect, including
production reconnect backoff. Request service latency excludes that watch work;
its scheduling effect remains in driver lateness and total throughput. These
results provide no request scheduling or end-to-end deadline guarantee.

The [rebase applicability audit](rebase-applicability.json) compares the original
measured archive with the lifecycle source rebased onto main
`da9c2c67f879aa8c7929c886d849127c6758a2d9`. All three instrumented runtime files
and their exact patch are byte-identical. Main adds two private owner-receipt
adapter modules, imported only through explicit fixture tests, outside this
production workload. This supports unchanged measured paths after rebase; it
does not relabel archive pins or claim a fresh benchmark of the rebased tree.
