# Windows production-connector capacity pilot

This opt-in pilot is related to
[#164](https://github.com/qwts/agent-comms/issues/164) and
[SOP #85](https://github.com/qwts/qwts-agent-sop/issues/85); both issues remain
open. It is a finite capacity qualification tool, not benchmark acceptance,
100-request/s product support, packaged host acceptance or desktop evidence.
No successful hosted result is claimed. Retain failures before workload changes.

## Exact production behavior

The tool archives unmodified pre-instrumentation main
`25dfa8362401489503f704c7322ad1314b7e6ddb` and instrumentation head
`e648d71277da72fc50c70ebcbb94c3c8f53c7cf3`. Reports record both commit/tree/archive
hashes, tool/policy/supervisor hashes and the actual Node executable hash. Both
pins use the same checksum-verified Node from the test-only host component
snapshot. That snapshot is not a release registry.

Each fixture loads the production Broker/client defaults in one embedded
process, using a fresh namespace beneath the real standard-user LOCALAPPDATA.
Pairing, joining and delivery/read/ack checks use the actual APIs. Every read
retains the Identification-level PowerShell/.NET pipe connector and its C#
compilation cost. There is no unrestricted Node pipe connection, platform
override, diagnostic replacement or source patch.

The baseline offers 1/s, then 10/s, then 100/s for ten seconds each. A higher
stage runs only after its predecessor qualifies. The candidate can attempt
only stages the baseline reached, and also stops after its own unqualified
stage. Thus a failed baseline stage can still have a matched candidate attempt;
it never authorizes a higher-rate claim. Requested and skipped rates and their
reasons are explicit.

A stage has at most 32 calls in flight, no admission queue, at most 1000 planned
calls, and the production ten-second request deadline. A full slot, missed
offer interval, wrong read result or deadline failure stops admission. The
driver drains admitted calls before continuing. Synchronous custody work is
included in scheduling cost; missed intervals are not hidden by catch-up
traffic. Reports separate planned/offered/admitted/completed counts, completion
within the offer window, drain time, deadline/other failures and latency/driver
lateness. Qualification means this finite schedule admitted and completed all
expected empty reads without those failures. It does not establish steady-state
throughput or the shared diagnostic latency budgets. Sparse delivery checks do
not establish compaction, every internal error or append p99.

## Resource accounting and cleanup

The fixture pauses before production imports. Its supervisor verifies the
owned process identity and assigns a private Windows job before releasing the
handshake. The job limits committed memory to the smaller of 2GiB and one
quarter of physical RAM; the tool requires a minimum 512MiB cap and an additional
512MiB of available headroom. This is committed memory, not RSS or WorkingSet.
Windows rejects commits that exceed the job limit; a resulting failure is
retained, without inferring a throughput result or an unobserved cause.

One restricted CIM query samples only the private job's bounded PID list,
including compiler descendants. PID, parent, creation time, executable and
reviewed command shape are checked. Creation-time comparison uses the CIM
microsecond resolution and an open process handle pins identity during job
assignment. Unexpected descendants fail the pilot. The job caps active processes at 128 and enumerates at most
128 members; observed process history is also bounded.

Main, PowerShell relay, diagnostic helper and C# compiler WorkingSet/CPU are
reported separately. Their simultaneous sampled WorkingSet sum is not a true
instantaneous peak. Cumulative job CPU and peak committed bytes capture
short-lived descendants that disappear between samples. Those units are never
converted to RSS. The supervisor's own CPU/WorkingSet is excluded from the
workload and reported separately. CPU has no numeric pass/fail budget here.
Storage type is explicitly unmeasured.

Normal cleanup drains calls, verifies relay/compiler absence while the fixture
is alive, stops Broker handles, awaits natural fixture exit and checks that the
job has no remaining members. Forced cleanup terminates only the private job,
waits for zero members and awaits owned child handles. Closing the last job
handle also terminates its members if the parent control pipe disappears.
There is no post-parent-exit PID kill. Original failures and cleanup failures
remain separate, and unconfirmed cleanup retains scratch rather than claiming
success. Capacity bootstrap cleanup does not fall back to descendant PID
kills; unexpected account processes retain the disposable account/profile for
review and mark cleanup failed. Reports contain fixed summaries without raw
paths, SIDs, command
lines, credentials or message bodies.

## Manual hosted execution

The manual `Windows desktop diagnostics` workflow offers four tasks:
`engine` retains existing acceptance; `capacity-supervisor` checks supervisor
control under the actual sanitized standard-user environment without importing
production code. It checks the full supervisor after explicit loading of the
classic shell's built-in Utility manifest, preserving EOF/forced-exit/stdio-close
receipts within a 29-second process budget; `capacity-preflight` and
`capacity-pilot` select this separate foreground-library probe. Capacity modes
use the disposable standard-user account/profile bootstrap and install no
scheduled task, daemon or host. The workflow remains manual; normal CI runs
only the small admission regressions and empty-job supervisor validation.

Retained runs and fixes are recorded in the
[preflight evidence history](windows-connector-capacity-evidence.md). No failed
preflight establishes capacity qualification.

After reviewing the exact PR, root dispatches `capacity-preflight` first. It
checks old/new normal startup and cleanup, an injected startup fault and forced
job disposal, with no offered capacity workload. Review any failure before
dispatching `capacity-pilot`. The explicit underlying tool command is:

```sh
node tools/acceptance/windows-connector-capacity.mjs --old OLD_CHECKOUT --new NEW_CHECKOUT --output NEW_DIRECTORY --preflight
```

Omit `--preflight` for the bounded pilot. The command requires the actual
verified standard-user bootstrap environment and Windows Node executable.
This CI bootstrap must never run on an owner's computer. Root alone operates
the separate signed-in desktop lab; hosted results cannot substitute for it.

Retain the entire `windows-engine-acceptance` workflow artifact, containing
the named acceptance, capacity, failure and partial JSON records when present,
including bootstrap cleanup and source archive hashes. Source archives and
extractions stay in disposable scratch and are not uploaded; reproduce them
with `git archive --format=tar` at the recorded exact pins.
Do not check source archives, extracted trees or generated credentials into Git.
An early failure remains failure; cleanup or account provisioning failure must
not be relabelled as a measured connector capacity limit. No release bump or
runtime contract adoption follows from this pilot.
