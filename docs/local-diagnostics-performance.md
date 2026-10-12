# Local diagnostic performance evidence

This is bounded local evidence for the broker/client instrumentation slice of
[#164](https://github.com/qwts/agent-comms/issues/164), using the proposed
[ENG-0085 budgets](https://github.com/qwts/qwts-agent-sop/blob/fc470c9244ae8018d24df217a03ce29f9bdfcc0e/docs/reference/diagnostic-resource-budgets.md).
Related to [SOP #85](https://github.com/qwts/qwts-agent-sop/issues/85); both issues
remain open. The exact records and source snapshots are retained in the
[evidence directory](../tools/acceptance/evidence/2026-10-12-local-diagnostics/README.md).

## Scope and baseline

Measurements ran on 2026-10-12 UTC, macOS Darwin 27.0.0 arm64, Node v26.11.1,
with 18 logical CPUs. Fresh synthetic broker processes each handled 100 requests
per second for 60 seconds, followed by 1000 diagnostic reports per second for
10 seconds while real requests continued at 100 per second. These are bounded
fixture rates, not product throughput promises. Delivery/read/ack, expected
refusal, uncertain storage and subsequent poisoned-state refusal were checked
before or after each timed workload. Cleanup required natural broker exit and
no surviving helper.

The disabled baseline uses the same instrumented broker with its diagnostic
callback disabled. New request timing reads and imports remain present. These
deltas measure enabled reporting/helper overhead only; they do not establish
total new instrumentation overhead against the preceding runtime. The proposed
budget says to compare with diagnostics disabled but does not define whether
timing reads remain. A pinned pre-change runtime baseline is still required
before claiming total instrumentation acceptance. Native Windows numeric
budgets, packaged host evidence and cross-repository adoption also remain open.

Main/helper RSS and CPU were measured separately using one asynchronous batched
`ps` invocation in both modes. Only the owned broker and its known helper were
accepted, after matching PID, parent PID and executable. Additional RSS includes
the helper and its warmup before deliberate failure. A failed helper had to stay
disabled without respawn. Unread stderr remained unread and had to reach a real
stalled write with finite pending records. The accounting parser claims macOS
only. Driver latency includes real request/refusal processing; observation and
storage checks are the same in each paired mode.

## Results and disposition

Candidate thresholds remain delta p95 at most 2 ms, delta p99 at most 5 ms,
throughput at least 98% of baseline, additional total RSS at most 64 MiB and
natural exit within 2 seconds. Each pair is evaluated independently. No passing
average cancels a failing pair.

| Run/pair | Quiet delta p95/p99, ms | Burst delta p95/p99, ms | Minimum throughput ratio | Additional RSS, MiB | Enabled exit, ms | Disposition |
| --- | --- | --- | --- | --- | --- | --- |
| Quiet healthy, disabled/enabled | 1.847 / 5.990 | 0.417 / 1.232 | 0.999998 | 45.078 | 7.330 | Quiet p99 failed; retained |
| Quiet failed helper, disabled/enabled | -1.163 / -4.092 | 0.617 / 1.692 | 1.000028 | 27.172 | 9.856 | Passed in that run |
| Quiet unread stderr, earlier corrected run | -0.576 / -1.077 | 1.190 / 1.154 | 0.999999 | 44.812 | 14.014 | Passed in that run |
| Counterbalanced healthy, disabled/enabled | -0.895 / -2.635 | 0.166 / -0.042 | 0.999984 | 43.375 | 3.951 | Passed independently |
| Counterbalanced healthy, enabled/disabled | -0.765 / -2.511 | -4.733 / -7.913 | 0.999971 | 44.391 | 8.936 | Passed independently |

All these runs passed functional outcome, queue/in-flight bound and cleanup
assertions. The unread destination's five final samples retained 64 queued
records/21632 bytes and one 338-byte in-flight record; written count stayed 383
while drops rose. Simultaneous broker/helper RSS stayed near 122256–122304 KiB.
This demonstrates an actually stalled destination with finite retained state.

The original synchronous-observer run failed latency thresholds. It invoked
blocking `ps` once in disabled mode and twice in enabled mode, creating unequal
observer load; concurrent runtime suites also overlapped. Its healthy burst
delta p95/p99 was 2.981/5.574 ms, failed-helper quiet 9.900/24.158 ms and unread
burst 9.940/15.755 ms. Its unchanged report is retained as failed diagnosis
evidence, not acceptance. The initial source was not hashed contemporaneously;
the retained source reconstruction is explicitly labelled and is not claimed
as verified exact tested-source provenance.

The corrected all-mode run exited successfully, but runtime suites overlapped
its healthy and failed-helper pairs. Those pairs are confounded and unsuitable
for clean acceptance. Its unread pair ran approximately 01:30:58–01:33:18 UTC
during the coordinated quiet hold and is reported separately above. The next
healthy/failed run, started 01:36:19 UTC and terminal observed 01:41:20 UTC,
retained the healthy p99 failure recorded in the results table.

After that failure, a reviewed counterbalanced experiment ran fresh processes
in disabled/enabled/enabled/disabled order, starting 01:46:26 UTC and terminal
observed 01:51:29 UTC under a new quiet hold. Both opposite-order pairs passed
independently with unchanged thresholds. The full result retains bounded
100-request latency/driver-lateness windows and per-phase CPU/write snapshots.
Quantiles were computed after phase timing stopped. Windows follow the planned
100/s schedule rather than wall-clock bins if the driver falls behind.

In both counterbalanced enabled quiet phases, helper CPU delta was zero at the
OS accounting resolution and the written count stayed one. The later disabled
burst had p99 12.269 ms and driver lateness up to 21.813 ms. This is evidence of
temporal variation without reporting, but it does not establish the cause of
the previous failure. That failure remains unexplained variability, not
disproved. The independently passing pairs support reporting/helper overhead
within candidate budgets in those runs; they do not certify every environment
or complete the outstanding acceptance scope.

## Reproduction and provenance

Use the explicit commands in the [acceptance tool instructions](../tools/acceptance/README.md).
Coordinate quiet intervals; never silently replace a failed or confounded run.
All original JSON records are retained unchanged with SHA-256 hashes. Corrected
runner snapshots match hashes recorded before launch. Runtime sources were
unchanged across all measurements; their hashes accompany the evidence index.
The implementation adds no diagnostic endpoint or production measurement IPC.
