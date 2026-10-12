# Windows production-connector capacity pilot

This opt-in pilot is related to
[#164](https://github.com/qwts/agent-comms/issues/164) and
[SOP #85](https://github.com/qwts/qwts-agent-sop/issues/85); both issues remain
open. It is a finite capacity qualification tool, not benchmark acceptance,
100-request/s product support, packaged host acceptance or desktop evidence.
No successful hosted preflight or capacity result is claimed here. Retain failed
preflights and capacity failures before considering any change to the workload.

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

The existing manual `Windows desktop diagnostics` workflow offers three tasks:
`engine` retains existing engine acceptance; `capacity-preflight` and
`capacity-pilot` select this separate foreground-library probe. Capacity modes
use the disposable standard-user account/profile bootstrap and install no
scheduled task, daemon or host. The workflow remains manual; normal CI runs
only the small admission regressions and empty-job supervisor validation.

The initial hosted preflight
[38202022510](https://github.com/qwts/agent-comms/actions/runs/38202022510), at
head `1e45919a5a6efbf2c345915509963fda671bd2f9`, failed in the standard-user
bootstrap. The upload step found no report files, so none of the six requested
normal/fault/forced cases can be assessed from that run. Its retained full log
has SHA256 `8b9a657633bc18e03cf065f9ed0f4eeeddefd937c38c3f036f0113270674a3d8`.
The relative report argument was resolved through .NET's process directory,
which can differ from PowerShell's location; this is a possible explanation,
not an established cause of the bootstrap failure. The bootstrap now resolves
the FileSystem provider path explicitly and prints a fixed, path-free terminal
summary even if report writing fails. Windows CI deliberately separates those
directories to check that reports follow PowerShell's location.

The second preflight
[38202529932](https://github.com/qwts/agent-comms/actions/runs/38202529932), at
head `bf91367c2ae21950a1796330173514a07c649109`, also failed. Its fixed console
summary records a failed child exit with no bootstrap exception or cleanup
errors. Its retained full-log SHA256 is
`37ce2d742f87e38324f745a15d68420b91025bf01d65e22ca632528373b4b12b`.
The upload step again omitted reports: the action's default hidden-file
exclusion applies to files within `.windows-results/`. This confirmed upload
defect is separate from the earlier directory-resolution hypothesis. The
workflow now enables hidden files only for four named JSON report paths; it
uploads no recursive source, credential or state directories. The console
fallback also records the bounded child bootstrap failure gate and error type.
Neither failed run establishes startup/cleanup or capacity qualification.

The third preflight
[38202921658](https://github.com/qwts/agent-comms/actions/runs/38202921658), at
head `17cdf5a6a2fc34a1c322384acc0b01470bf87099`, retained its report successfully.
Its [retained report](../tools/acceptance/evidence/2026-10-12-windows-connector/preflight-38202921658-acceptance.json)
records `clone-child-owned-inputs` / `RemoteException`, a loaded non-admin
profile, and completed bootstrap cleanup with no errors. Report SHA256 is
`51ea6de477df90104e344ad9b814615e46d5295fafc6b6576811cbf573b8be9a`;
full-log SHA256 is
`8d8937ddd5fbe4669e9ee3929c99ff69fc23314c909758bedcab816e0a59e205`.
No production fixture or offered workload ran. This is consistent with classic
PowerShell promoting Git's native stderr under `Stop`, but the failed report
does not capture Git's exit status. Child clones now minimize informational
output with `--quiet`, suppress native stderr under a scoped `Continue`
preference, restore the prior preference, and explicitly reject a nonzero or
missing native exit status. A classic Windows PowerShell regression exercises
real native children emitting stderr with exit zero and exit seven, preserving
actual command failures without treating informational stderr as failure.

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
