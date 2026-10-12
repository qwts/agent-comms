# Pinned-runtime diagnostic overhead evidence

This is scoped macOS evidence for the local instrumentation delivered by
[PR #188](https://github.com/qwts/agent-comms/pull/188), related to
[#164](https://github.com/qwts/agent-comms/issues/164) and
[SOP #85](https://github.com/qwts/qwts-agent-sop/issues/85); both issues remain
open. It uses the proposed
[ENG-0085 budgets](https://github.com/qwts/qwts-agent-sop/blob/fc470c9244ae8018d24df217a03ce29f9bdfcc0e/docs/reference/diagnostic-resource-budgets.md).
The [earlier reporting-only evidence](local-diagnostics-performance.md), including
failed and confounded measurements, remains retained unchanged. Its disabled
callback baseline kept instrumentation timing reads. This comparison instead
loads complete unmodified production source archives from before and after
the instrumentation change.

## Exact source and workload

The baseline is main `25dfa8362401489503f704c7322ad1314b7e6ddb`; the candidate
is PR #188 head `e648d71277da72fc50c70ebcbb94c3c8f53c7cf3`. Each process loads
its archive's production Broker/client defaults, with no diagnostic callback
replacement, source patch or fixture-only report injection. This is **one
embedded Broker/client process**, not a separate daemon and CLI deployment.
Both pins use unchanged runtime defaults and the same executable and driver.

Each run performs 100 real requests/s for 60 seconds, followed by 10 seconds at
the same rate with 1000 actual local client failures/s. One send/read/ack per
1000 requests respects default account/pair send limits; every 100th request
is an ordinary unauthenticated refusal and the rest are empty reads. The burst
calls the production client against an absent local endpoint and requires
`broker-unreachable` at both pins. The baseline client emitted no diagnostic
for this path and had no helper; that absence is not a helper-lifecycle pass.
The candidate uses its default diagnostic producer and helper.

Delivery/read/ack is checked before and after timing. Ordinary stop/restart
recovery is checked afterward. These sparse successful appends do not establish
isolated append p99, compaction, uncertain-storage behavior or overhead for
every internal-error path. Existing storage regressions remain separate.

## Results and limits

The healthy coordinated quiet interval started 2026-10-12 at 02:34:00 UTC;
terminal completion and cleanup were observed at 02:38:51 UTC. A separate
failed/unread interval started at 03:08:52 UTC and terminal cleanup was observed
at 03:18:24 UTC. Root and both other agents held local runtime/tests/builds
during each interval. The environment was Darwin 27.0.0 arm64, Node v26.11.1, 18 logical CPUs. Fresh processes ran in
old/new/new/old order. All six opposite-order pairs independently passed
unchanged candidate thresholds: delta p95 at most 2ms, delta p99 at most 5ms, throughput
at least 98% of baseline, additional main-plus-helper RSS at most 64MiB and
candidate natural exit within two seconds.

| Mode and pair | Quiet delta p95/p99, ms | Burst delta p95/p99, ms | Minimum throughput ratio | Additional RSS, MiB | Candidate exit, ms |
| --- | --- | --- | --- | --- | --- |
| Healthy old/new | -0.064 / -0.115 | 0.044 / 0.034 | 1.000002 | 46.359 | 5.510 |
| Healthy new/old | 0.016 / 0.026 | 0.333 / 0.475 | 0.999995 | 46.203 | 5.573 |
| Failed old/new | 0.014 / 0.015 | -0.049 / -0.045 | 0.999960 | 0.453 | 5.011 |
| Failed new/old | -0.027 / -0.054 | 0.030 / 0.113 | 0.999959 | 0.000 | 6.125 |
| Unread old/new | -0.020 / -0.039 | 0.045 / 0.017 | 0.999985 | 45.859 | 6.017 |
| Unread new/old | -0.021 / -0.025 | 0.200 / 0.261 | 1.000025 | 44.859 | 5.158 |

Every run completed identical timed outcomes: 6909 empty reads, seven sends,
seven delivered reads, seven acks, 70 unauthenticated refusals and 10000 burst
failures. A separate startup warmup failure brings the recorded local-failure
count to 10001. Consumed healthy/failed candidate diagnostic output passed
body/secret/path canaries and bounded-profile checks. All twelve processes
exited naturally and all six candidate helpers were confirmed absent. Each run
passed two delivery checks and one ordinary recovery check. No stale owned
fixture remained.

This supports steady-state total new instrumentation overhead **for this
defined embedded-process workload with healthy, failed and unread destinations**.
Runtime import, broker startup and warmup are reported separately and are not assessed under
the steady-state delta thresholds. CPU seconds are recorded as supporting OS
accounting evidence; this probe has no CPU pass/fail threshold. The passing
pairs do not disprove earlier reporting-only variability or accept every
environment and operation.

The failed mode kills only the candidate's verified helper while its owning
fixture is live. That helper stays absent throughout the workload; the old
client had no helper and its helper-failure result remains not applicable.
One warmup line was consumed before each candidate helper was killed. Peak
RSS compares the highest simultaneously sampled main-plus-helper sum in each
run, including the startup sample before failure. A zero peak difference does
not mean instrumentation allocated no memory or that the helper had no startup
cost.

Unread stderr remains unread throughout each run. Its reported destination is
configured unread; the tool does not inspect private queues or establish that
a write blocked. Final five candidate main-plus-helper RSS samples ranged from
176448–178080KiB and 176048–177696KiB in the two unread runs. These five
samples do not establish a long-duration plateau. Numeric RSS evidence does
not prove queue counts or a stalled write without direct observation. Earlier reporting-only measurements and
bounded writer regressions retain those separate observations. Native Windows
numeric evidence, packaged host evidence, other deployment variants, cross-repository
adoption and the remaining #164 workstreams stay open. A Windows capacity pilot
must retain the production Identification-level PowerShell/.NET connector and
account for its relay processes before any 100-request/s budget claim; hosted
Windows and signed-in desktop evidence remain distinct.

## Preflight, cleanup and provenance

The [evidence index](../tools/acceptance/evidence/2026-10-12-total-instrumentation/README.md)
retains all bounded preflight attempts, both successful and failed, plus the
unchanged healthy and failed/unread results and individual runs. The first
failure exposed the macOS `ps` executable-column truncation; the second exposed `/tmp` resolving to
`/private/tmp` in the helper import. Both rejected mismatched identity checks
before any timed workload. Their fixtures/helpers were independently verified
and terminated; terminal exit was confirmed and credential scratch retained.
The original failure records remain unchanged.

The frozen preflight passes normal startup/default failure/natural shutdown and
an injected harness startup fault for both pins. The fault occurs after the
owned fixture and any helper have been observed, before any workload. Actual
runtime archive sources remain unmodified. An earlier terminal fixture whose
helper state was never observed retains scratch rather than claiming cleanup
was proven. Abnormal cleanup signals a raw helper PID only while the verified
owning fixture remains live, awaits the owned ChildProcess terminal and
preserves fixed-stage original and cleanup failures separately.

The exact tested runner is retained with SHA-256
`0437dcc8af4ce34a7e5fa7f7e16041bade7bbc63f2a0e0a80c2f8b25c253403a`.
The report pins both trees, source-archive hashes and the Node executable hash.
Source tarballs and disposable credentials are not checked into Git. Follow
the [tool instructions](../tools/acceptance/README.md) to extract the exact Git
objects, retain complete archives as external run artifacts and verify their
hashes. Further timed runs require a separately coordinated quiet interval;
each result must be retained without replacing earlier failures.

See separate [mailbox reporting observations](diagnostic-mailbox-overhead.md)
for later producer pins, a retained failed pair and changed-source helper-loss results.
