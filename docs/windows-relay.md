# Windows pipe relay build and provenance

The relay is a prebuilt .NET Framework executable with the Windows GUI
subsystem (`/target:winexe`), inherited binary stdio, and no GUI or console.
It opens the pipe with `TokenImpersonationLevel.Identification` before the
broker handshake. Either input EOF or pipe EOF ends the owned relay; the
JavaScript client still withholds credential-bearing bytes until broker proof.

PowerShell with `DETACHED_PROCESS` exits before running the script on the
pinned Windows tuple. Hidden PowerShell can connect, but the strict private-job
probe observes an extra executable. The new helper avoids the PowerShell host
and runtime C# compiler; it does not admit that extra process or weaken the
classifier. Historical negative runs remain attached to PR #267.

## Build a source checkout

On Windows, run `./scripts/build-windows-relay.ps1` before using the pipe client
or running native pipe tests. It uses the operating system's .NET Framework
compiler and writes an ignored executable and build manifest under `bin/windows`.
Compilation is an explicit build step, never an automatic runtime fallback.
The build requires a source commit from the checkout or release stamp.

The same verified helper also implements the fixed `--sid` and `--inspect`
custody operations. Account names and literal paths arrive as UTF-8 stdin data,
never command arguments or executable code. It uses fresh Windows NTAccount
translation and filesystem ACL/attribute reads on every call, preserving the
existing strict SID/owner/type/link grammar and refusals without a PowerShell
launch per check. The real default account-isolation adapter requires this
artifact and never falls back after verification or execution failure. Explicit
injected runners retain the existing PowerShell adapter contract. The candidate
supervisor admits only the three fixed native argument vectors described here for the
same verified helper and current fixture parent; their resource usage is
included in the existing relay/helper totals. It still refuses other arguments,
unrelated executables, parent mismatches and runtime compilers.

The manifest binds the source commit, C# source digest, binary digest, and
Windows subsystem. Runtime checks those digests and the executable's actual PE
subsystem before starting the fixed bundled path. A missing, corrupted, stale,
or console-subsystem build fails closed with the existing process-error stage.
These are package-integrity checks, not a claim of Authenticode signing.

Custom spawn wrappers receive the same artifact verification by default.
In-memory test doubles must explicitly set `skipRelayVerificationForTests`;
that option is refused with the default real spawn function. Native probes
use verification, including when wrapping spawn to observe the relay.

## Release and acceptance

Windows CI builds the helper before native security tests and retains the
verified build as `windows-pipe-relay`. Release packaging downloads that
artifact from the exact successful main CI run, requires its source commit to
match the release SHA, and verifies source/binary digests before embedding it
in the checksummed archive. A source archive or npm package without a build
requires the explicit Windows build step.

The `relay-startup` diagnostic exercises production relay startup, exact
fixture/relay job membership, resource limits, EOF, natural exit, final empty
job, and owned-child closure, then checks native impersonation and queued-byte
guards. The PowerShell host comparison retains the detached-launch failure
separately. Hosted results do not establish installed owner-desktop acceptance
or the remaining compiler/capacity work under #164.

Legacy compiler controls remain tied to their original source hashes. The
current relay has no runtime compiler; those controls cannot silently claim
to validate this helper.

## Broker startup and delivery candidate

The `relay-candidate-startup` manual workflow task selects the fixed
`260d5dbbd7a27c2b044b3497757ee9b73e649c53` runtime in a disposable standard-user
profile. The driver requires its fixed tree and canonical archive digest;
dispatch cannot supply another runtime revision. The workflow explicitly
builds the helper from the fixed checkout before creating the disposable
account. The account receives only the executable and manifest as read-only
inputs, copies them into its independently approved source archive, verifies
the artifact, and records the source and binary digests. Build preparation is
outside both the standard-user acceptance and measured job; acceptance does
not require the standard user to compile a prebuilt product.
Component approval uses the reviewed commit's canonical digest, never a
mutable tool checkout whose CRLF conversion can differ from archive bytes.

The driver captures the actual connector's fixed executable and arguments
through inert streams, with artifact verification enabled. The supervisor
then admits only that executable/argv, the fixture, and the existing diagnostic
writer; runtime compiler descendants are not admitted for this candidate.
It exercises Broker startup, pairing and approval, two agent joins, one
send/read/ack/empty-read cycle, natural shutdown, empty-job confirmation and
owned process/stdio cleanup under the existing bounded startup profile.

The first run with workflow prebuild, [39169322836](https://github.com/qwts/agent-comms/actions/runs/39169322836),
passed source/component approval, artifact verification and Broker startup,
then failed during pairing with `broker-timeout`. It did not reach approval,
joins or delivery. Its failure receipt confirms owned fixture/supervisor exit,
stdio closure, empty job and scratch removal. The outer bootstrap nevertheless
retains the profile because its conservative cleanup gate refuses any
`failure.json`; its `capacity-tool-cleanup-unconfirmed` and `test-profile-cleanup`
results remain failures. This is diagnostic progress, not a passing Windows
acceptance result. Pairing and outer cleanup reconciliation remain under #164.
That historical run used the earlier `ba75753e` runtime, before native custody.

The phase-observation follow-up [39172469383](https://github.com/qwts/agent-comms/actions/runs/39172469383)
confirmed profile disposal with no bootstrap cleanup errors while retaining the
failed pairing. It observed 22.1 seconds in account resolution, then 23.0 seconds
in the remaining proof validation before a roughly 4 ms append. The pairing
request was persisted, but its client deadline had elapsed. The fixed runtime
candidate above removes those default PowerShell launches and retains the
existing request limits.
The first native-custody candidate [39173624245](https://github.com/qwts/agent-comms/actions/runs/39173624245)
then exposed a separate 30-second startup refusal in the existing PowerShell
durable-replacement path (`storage-failed`); owned and bootstrap cleanup passed.
The fixed helper also implements `--replace` using the same `MoveFileExW` flags
(`REPLACE_EXISTING | WRITE_THROUGH`, without `COPY_ALLOWED`). Validated sibling
paths remain child environment data, and failures or ambiguous timeouts still
poison the writer for recovery without retry. Real default replacement no longer
launches PowerShell or a runtime compiler; injected runners keep their adapter.

The complete native candidate [39174227116](https://github.com/qwts/agent-comms/actions/runs/39174227116)
passed Broker startup, pairing/approval, two joins, one send/read/ack/empty-read
cycle, natural exit, an empty job and scratch removal. The standard-user and
bootstrap reports both passed, with the profile removed and no cleanup errors.
The observed account resolver and remaining proof-validation phases took about
27 ms and 29 ms in that run; these are functional diagnostic observations, not
capacity or performance acceptance. The client's 10-second request deadline and
the durable replacement's 30-second failure bound are unchanged. The following
status normalization also keeps a failed operation explicitly failed even when
disposal succeeds; native reader regressions cover missing and conflicting
status/exit combinations.

The follow-up cleanup reader distinguishes that operation failure from disposal
proof only for the single prebuilt-relay candidate. It requires explicit true
receipts for both owned processes, both stdio closures, the empty job and scratch
removal, explicit false forced-termination flags, and an empty error array.
Missing, malformed, uncertain, forced or legacy failure receipts still retain
the profile. Successful disposal never changes the failed operation into a pass.
Fixed pairing phases additionally observe the real account resolver and log
append while forwarding their arguments, receiver, results and exceptions;
account names, paths and proof data are not retained.

This is a separate functional candidate. The historical `candidate-*` tasks,
compiler digests, old/new comparison pins, classification guards, and
deadlines remain unchanged. A hosted pass does not establish owner-desktop,
installed-host, offered-rate capacity, or numeric overhead acceptance.
