# Opt-in local acceptance tools

## Windows production-connector capacity pilot

The manual Windows workflow has separate no-workload `capacity-supervisor`
`capacity-attach` and one-sample `capacity-sample` diagnostics, the single-old-pin `capacity-startup`
production startup/disposal probe without offered requests, `capacity-channel`
for actual pinned default channel prepare/stale probes without Broker/listener, and `capacity-custody`
for the actual pinned current-account and three-directory custody API without a
Broker or connector. The separate `capacity-connector` observes actual unconsumed connector events
after prepare/main probe, without Broker/listener/workload. These precede `capacity-preflight` and
`capacity-pilot` tasks. The [capacity pilot contract](../../docs/windows-connector-capacity.md)
describes exact source pins, the actual Identification-level PowerShell connector,
fixed 1/10/100 requests/s stages, bounded admission, owned job accounting and
cleanup. These are hosted standard-user finite capacity observations, not
benchmark, signed-in desktop or host acceptance. No load runs in normal CI.

The separate `candidate-startup` task attempts one corrected-source Broker
startup, pair/admin approval, two joins, send/read/ack/empty and natural stop.
Its current fixed source is reviewed PR [#224](https://github.com/qwts/agent-comms/pull/224)
head `cb50469ca0b6757c4ab860de582b9b140fc525a0`, tree
`34011276c3e651e6fd5bf7ba1e7c7f373053249e`, Windows CRLF archive SHA256
`85991a457b19c0f7367ca7a1d7fabbeadd7acb3bf15828f37594a5669c185ef6`.
The [explicit source refresh](../../docs/windows-candidate-stage-refresh.md) preserves
the original `2d94b16a` reports without relabelling them as current-pin evidence.
The [first refreshed-source attempt](../../docs/windows-candidate-connector-stage-evidence.md)
failed at pair with the existing local `startup-timeout` stage; no underlying
helper cause or startup-plus-delivery acceptance is inferred.
The tool refuses a tree or digest mismatch before extraction/import. This
single candidate report has no old/new comparison or offered-rate stages;
the existing capacity pins remain unchanged. The first reviewed manual attempt failed; its
[retained receipt](../../docs/windows-candidate-startup-evidence.md)
does not establish corrected native startup or capacity. Resource/profile guards and
owned cleanup remain unchanged. The first attempt used a 90-second watchdog; the
[reviewed full-startup guard](../../docs/windows-candidate-startup-guard.md)
selects 360s requests/420s reporting as finite diagnostic headroom. Known production refusal
codes and only the existing closed local Windows connector stage are retained
through correlated fixture IPC using the shared own-data projector; error text,
accessors, unknown metadata and causes are excluded. Local stub IPC tests establish classification and cleanup mechanics,
not production pipe acceptance.

The separate `candidate-storage` control uses the same fixed candidate source
and bootstrap to isolate actual prepare, EventLog construction, file custody,
empty replay and public compacting maintenance, without calling Broker.start
or creating listeners, stale probes, A2A startup, delivery or rate offers.
Fixed phases bracket each API; real child IPC regressions cover a maintenance
failure and registered cleanup. The production storage subprocess stays in the
private job without command, environment or timeout changes. Its configured
child timeout does not establish terminal/stdio closure. Only owned-handle/job
receipts establish cleanup. The original-pin [retained storage-only pass](../../docs/windows-candidate-storage-evidence.md)
does not establish whole Broker startup, delivery or capacity.

The manual `candidate-channel` task uses that same approved correction archive
for actual prepare and both stale APIs, with no Broker.start, storage or load.
Fixed candidate controls retain bounded parent request duration and relative
fixed child phase timing. Startup selects 360s requests/420s reporting as a
finite diagnostic guard; storage retains 90s requests/120s reporting;
only candidate-channel selects 180s requests and 240s reporting, from a closed
trusted mode. Production connector and old/new diagnostic budgets are unchanged. Missing/invalid timing cannot qualify a pass.
The [first retained channel failure](../../docs/windows-candidate-channel-evidence.md)
records the actual prepare/main durations and incomplete admin window without
claiming a stall or capacity. The original-pin [subsequent scoped pass](../../docs/windows-candidate-channel-evidence.md#revised-scoped-channel-pass)
records both completed stale APIs and proven cleanup, leaving whole startup
separate. See the [control and timing scope](../../docs/windows-candidate-startup-evidence.md#fixed-source-channel-control-and-timing).

The manual `candidate-compiler` task derives the exact fixed production worker
through its public spawn seam, validates its command and source hashes, and
removes only the final pipe `Run` call. Four controls run in
implicit/explicit/explicit/implicit order, each with a 15-second work deadline.
Explicit controls import the exact built-in Utility manifest under the verified
Windows PowerShell home. Up to six ordered .NET-written markers retain bounded
elapsed times and manifest booleans; stderr is counted without retaining text.
Each paused fixture is assigned to the existing private job before shell spawn,
using the same exact descendant command guard. Terminal, stdio, empty-job and
scratch-cleanup uncertainty skips all remaining controls. Separate bounded
supervisor, attach and cleanup budgets remain diagnostic overhead; the existing
15-minute bootstrap watchdog is unchanged. Reports retain the compiler helper,
runner, supervisor, controller, lifecycle and fixed worker source hashes.
These derived controls make no pipe connection, Broker startup or workload and
do not establish actual connector acceptance, capacity or installed-host support.
The existing supervisor samples every 250ms with one request in flight and a
5-second request deadline; at least one exact-command relay observation is
required. Sampling failures stop the control, and the sampler drains before
fixture/job cleanup. Samples cannot prove the command of every short-lived
descendant; the private job contains all descendants regardless.

## Total instrumentation comparison with actual source archives

The separate macOS-only probe compares complete unmodified production trees:
pre-change main `25dfa8362401489503f704c7322ad1314b7e6ddb` and PR #188 head
`e648d71277da72fc50c70ebcbb94c3c8f53c7cf3`. It archives both exact Git objects,
retains archive/tree/source-runner hashes, and loads each archive's default
Broker and client in **one embedded process**. It does not replace diagnostic
callbacks, patch runtime source or claim a separate daemon/CLI deployment.
Both objects must already exist locally; extraction needs Git and `tar`.
The scoped healthy/failed/unread results and all preflight attempts are retained
in the
[total instrumentation evidence](evidence/2026-10-12-total-instrumentation/README.md),
with [interpretation and remaining limits](../../docs/local-diagnostics-total-overhead.md).

The bounded startup/default-failure/normal-and-fault-cleanup preflight does not run the
timed workload. It retains separate old/new source and lifecycle evidence,
including an injected harness startup failure after the default helper is
observed and before any workload. Runtime archive sources remain unmodified:

```sh
node tools/acceptance/diagnostic-total-overhead.mjs --output /tmp/comms-total-preflight --preflight
```

After tool review and a coordinated quiet interval, use a new output directory:

```sh
node tools/acceptance/diagnostic-total-overhead.mjs --output /tmp/comms-total-overhead --modes healthy
```

Each mode runs old/new/new/old, about five minutes. Omitting `--modes` selects
healthy, failed and unread destinations in sequence, about fourteen minutes.
Each opposite-order pair independently retains the unchanged candidate latency,
throughput, helper-inclusive RSS and natural-exit thresholds. Earlier failures
must remain retained; this is not a rerun that overwrites prior evidence.

At 100 real requests/s, a fixed cycle performs one send/read/ack per 1000
requests, an unauthenticated refusal every 100 requests, and otherwise empty
reads. This respects unmodified default send limits. The 10-second burst adds
1000 actual local client `broker-unreachable` failures/s against an absent
endpoint. The old client did not emit diagnostics for those failures; absence
of its helper is recorded, not treated as a fabricated failure/lifecycle pass.
Actual operation counts and errors must match at both pins. Sparse successful
appends are covered, but this is not isolated append p99, compaction or every
internal-error-path acceptance. Delivery/ack and ordinary recovery are checked.
Uncertain-storage behavior retains its separate existing regression evidence.

Steady-state comparisons include the new timing reads and reporting behavior
for this workload. Runtime import, broker startup and warmup are reported
separately. The parent samples only its owned main/direct diagnostic helper,
verifies executable/parent/command identity, and retains separate RSS/CPU.
CPU seconds are recorded as supporting evidence; CPU has no pass/fail threshold
in this probe.
Failed helpers are killed only while their verified owning fixture is live;
no restart is allowed. Unread stderr is never consumed; this probe reports RSS
plateau evidence, not private queue counts or direct proof of a blocked write.
Existing bounded writer regressions provide those separate observations.

The fixture stops actual Broker handles and disconnects naturally; no
`process.exit` substitutes for shutdown. Parent disconnect also disposes the
fixture. Cleanup awaits the owned process terminal state, retains credential
scratch on unconfirmed cleanup, and preserves fixed-stage original/cleanup
failures. An early terminal fixture whose helper state was never observed
retains scratch rather than claiming cleanup was proven.
Completed individual runs, progress, failures and source archives are retained
under the selected evidence directory. Reports contain fixed outcome and
resource summaries, not credentials, message bodies, runtime paths or peer IDs.

Native Windows capacity qualification is separate: keep the production
Identification-level PowerShell/.NET connector and account for those relay
processes. Hosted standard-user and signed-in desktop evidence remain distinct.
This tool does not run Windows or certify its numeric budgets.

## Diagnostic resource and latency budgets

The standalone diagnostic probe uses fresh single-account broker processes and
synthetic credentials/messages. It compares reporting disabled/enabled for
healthy, deliberately failed, and unread stderr destinations. Each process runs
100 requests per second for 60 seconds, followed by a 10-second burst of 1000
diagnostic reports per second while real requests continue at 100 per second.
The six sequential runs take about seven minutes. Coordinate a quiet interval
with other sessions before measuring; concurrent suites invalidate a clean
paired latency claim. This is excluded from default `npm test` and runtime imports.

On macOS with a supported Node executable, run explicitly:

```sh
node tools/acceptance/local-diagnostics.mjs > /tmp/comms-diagnostic-budgets.json
```

To select named destination pairs, use `--modes healthy,failed`. The diagnostic
counterbalanced run is separate and takes about five minutes:

```sh
node tools/acceptance/local-diagnostics.mjs --counterbalanced healthy > /tmp/comms-diagnostic-counterbalanced.json
```

This runs disabled/enabled/enabled/disabled with fresh processes. Both opposite
order pairs retain their individual pass/fail results under the same thresholds;
a passing average cannot cancel a failing pair. Each phase also reports fixed
100-request windows of latency and driver scheduling lateness, diagnostic
write/drop snapshots and sampled main/helper CPU deltas. These windows follow
the planned 100/s schedule rather than wall-clock bins if the driver falls
behind. Quantiles are computed after timing stops. Driver lateness and CPU can
help locate variation but do not establish its cause.

The baseline disables reporting in the same instrumented broker. It retains
request timing reads, so it does not measure their overhead against an older
source revision. One asynchronous `ps` invocation samples only the owned broker
and its known helper; PID, parent PID and executable must match. Main/helper
RSS and CPU are reported separately and their simultaneous RSS sum is compared
with the disabled baseline. Helper warmup is included before deliberate failure.
The failed destination must stay disabled without respawn. The unread destination
must reach a real queue plateau and stalled in-flight write.

The report includes both phases, latency/throughput deltas, finite queue peaks,
cumulative drops, synthetic outcome checks, and natural broker exit without
surviving helpers. It contains no credentials, message bodies, paths or stable
identity IDs. macOS accounting evidence does not certify Linux, native Windows
budgets, packaged host integration or the remainder of #164.

The bounded startup-failure and owned-child cleanup probe is separate:

```sh
node tools/acceptance/local-diagnostics.mjs --cleanup-check
```

On failure, cleanup signals a helper only while its owned parent is live and
identity still matches, then awaits the owned broker's terminal exit. If exit or
helper cleanup cannot be confirmed, disposable `ac-diag-budget-*` scratch is
retained for manual review; the original failure and cleanup failures stay
separate in the internal aggregate. No raw failure stack is printed.

## State format compatibility acceptance

This opt-in harness tests actual source revisions on disposable state. It covers
the released v0.3.16 event-log reader, PR #141 checkpoint version 1, and PR #145
checkpoint version 2 with channel copies and retry outcomes. The exact commits,
generated fixture names and required assertions are pinned in
[the manifest](state-format-manifest.json). It does not establish full host
acceptance, Windows acceptance, power-loss guarantees or a supported downgrade.

## Run

Use a supported Node version, Git and `tar` on macOS or Linux. No package install
is needed. From this checkout:

```sh
npm run test:format-compatibility
```

The command performs no network access. All three pinned commits must already
exist in the local Git object database. A shallow CI checkout can fetch these
public source objects explicitly before running the command:

```sh
git fetch --no-tags origin \
  98a0abb1d507563655fad435bdd26b047bbc9586 \
  5d46dc7ea03ecfe8b3ec5963909b1d8b4a3f8c13 \
  cc9073db95db680cb4be2b5a42f845ec492fc79e
npm run test:format-compatibility
```

For an opt-in CI job, use a standard GitHub-hosted macOS or Linux runner,
read-only repository permissions, the repository's pinned checkout/Node actions,
the explicit fetch above and this separate command. It is excluded from default
`npm test`; that command gains no network or historical-source dependency.
Archive the output directory as evidence. No workflow is enabled by this change.

The runner prints its new temporary output directory. An explicit destination
must be new or empty:

```sh
npm run test:format-compatibility -- --output /tmp/comms-format-evidence
```

The directory contains exact source archives, the manifest, generated fixture
logs, `test.log` and `results.json` with environment, commit pins and before/after
SHA-256 hashes. Fixtures contain only newly generated identities, credentials'
hashes and synthetic messages. Temporary broker state is removed after testing;
the evidence directory remains for review and can then be deleted.

## What the evidence proves

The harness starts the actual released broker, pairs a disposable account,
joins two generated souls, accepts messages and acknowledges one copy. Actual
v1 and v2 brokers then migrate that history and return the original retry result.
The v2 broker creates a channel, commits two separate subscriber copies and
acknowledges only one. Restart must recover both copies, their independent
receipts, the membership snapshot and the original post outcome.

Older reader and broker-startup probes use copies of those emitted checkpoints
and event tails. They assert the exact refusal and every authoritative log byte.
Compatible restart must recover original IDs, bodies, receipts and retry
outcomes after each probe. Injected torn tails end without a newline, including
one inside a UTF-8 sequence; complete records are never reconstructed or guessed.

## Known downgrade limitation

**Never open upgraded state with an old binary.** The released reader refuses
intact v1/v2 checkpoints without modifying the log. With a torn suffix, however,
it truncates that suffix before discovering the unsupported checkpoint. The
harness confirms that every complete checkpoint and event byte survives, and a
compatible reader recovers all committed outcomes, but unconditional downgrade
non-mutation is false. Tests label this as a confirmed limitation, not downgrade
acceptance. The v1 reader validates first and refuses v2 even with a torn suffix
without changing any byte.

A future host migration guard should check the selected binary's supported
format against durable host metadata before opening authoritative state. Refuse
an incompatible launch before the old process runs; do not rely on its reader
to protect a newer format. This harness does not implement that guard, authorize
format rollback, restore a pre-upgrade backup or prove platform installation and
recovery behavior. Those host/release acceptance obligations remain separate.

## Local provider feasibility

The separate opt-in [Durable Object probe](../feasibility/durable-objects/README.md)
uses pinned dev-only vendor tooling and synthetic storage records. It measures
local atomicity, capacity, persisted outcomes and paging, not production federation
or cloud guarantees. It is excluded from the root runtime package and default
test command.
