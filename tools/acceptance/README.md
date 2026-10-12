# Opt-in local acceptance tools

## Windows production-connector capacity pilot

The manual Windows workflow has separate no-workload `capacity-supervisor`
and `capacity-attach` diagnostics, then `capacity-preflight` and
`capacity-pilot` tasks. The [capacity pilot contract](../../docs/windows-connector-capacity.md)
describes exact source pins, the actual Identification-level PowerShell connector,
fixed 1/10/100 requests/s stages, bounded admission, owned job accounting and
cleanup. These are hosted standard-user finite capacity observations, not
benchmark, signed-in desktop or host acceptance. No load runs in normal CI.

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
