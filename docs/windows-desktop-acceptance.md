# Current-user desktop acceptance candidate

Related to #164. This development candidate is distinct from the
disposable CI bootstrap. Its tasks are `candidate-compiler`,
`candidate-startup` and `relay-candidate-startup`; it has no engine installation or capacity mode. It does
not claim installed-host acceptance, interactive task
readiness, shared diagnostic budget acceptance or a cause for historical failures.

The proposed entrypoint is `scripts/windows-desktop-acceptance.ps1 -Task TASK`.
It requires the real current standard-user token, matching default owner and
known profile folders, username and loaded hive. It creates an exclusive
restricted-ACL root beneath real LOCALAPPDATA, refuses reparse ancestors and
holds no-delete handles on that chain throughout the owned Node lifetime.
It downloads the existing checksum-pinned Node archive beneath scratch with a
128MiB compressed-byte cap and one 60-second cancellation budget. Declared
Content-Length is checked when present; actual stream bytes are always counted,
without buffering a full response. Redirects and content decompression are
refused. One exclusive output handle owns both writes and checksum reading;
failed downloads are marked for deletion through that handle before close.
Unknown cancellation/deletion/close outcomes refuse and retain uncertainty.
An OS operation can outlast cancellation. It then passes a bounded private
frame over stdin. Node independently rechecks profile,
root and actual parent through the fixed verification helper. No disposable CI
markers are set. A decoded frame alone is not an owned internal context and
never conveys production authority.

The separate `relay-candidate-startup` task uses the existing immutable
`RELAY_STARTUP_SOURCE` approval, including its source/tree/archive/component
hashes. Fetch that exact commit into a shallow checkout before execution; a
missing object refuses at archive preparation. The task builds only the
approved archive's relay inside the bounded outer job, with a 30-second build
deadline, before the measured fixture/private job starts. The normal artifact
build establishes `Bypass` for that child PowerShell session explicitly; it
does not inherit a caller's process policy or change user/machine policy.
Group Policy still takes precedence. The normal artifact
build child fixes `PATHEXT` to `.EXE`, so classic PowerShell waits for the
fixed compiler executable and observes its exit code in the sanitized environment.
The normal artifact
manifest, source/binary hashes, release stamp and PE subsystem checks still
apply. Neither a source nor an artifact path is accepted from the caller. The
historical compiler/startup tasks and the hosted artifact-input path retain
their existing approvals and behavior.

```powershell
git fetch origin 260d5dbbd7a27c2b044b3497757ee9b73e649c53
./scripts/windows-desktop-acceptance.ps1 -Task relay-candidate-startup
```

The first owner-machine wrapper attempt at merged `0f14a5b2` exited 1 at
`archive-source`; its shallow checkout lacked the historical pinned source.
Its retained receipt confirms actual Node terminal, stream closure, empty outer
job, handle closure and assignment before resume, with no cleanup uncertainty.
The 26 native desktop safety cases passed independently. Neither observation
proves Broker startup or delivery. The repaired-relay task is tracked in
[#272](https://github.com/qwts/agent-comms/issues/272); its actual desktop result
must be recorded separately.

The existing runner shares its actual source archive verification, compiler
controls, startup/delivery fixture, supervisor, classification, resource limits,
private-job assignment and cleanup. The desktop context selects no source,
connector, timeout, UID, executable category or capacity rate. Temporary files,
case state, source archives and output reside under scratch; real USERPROFILE,
LOCALAPPDATA and APPDATA remain unchanged. The original CI entrypoint and markers
retain their behavior. Production library files are unchanged.

Compiler controls retain their 15-second work limits and four-control ordering.
Startup retains the 360-second parent request and 420-second reporting cap,
with unchanged production ten-second request/connector limits. Child release
still follows private-job assignment. Unexpected descendants remain refusals.
The test-only inert canary console detachment is not applied to the production
helper. Actual job/token/native access failure must not trigger elevation or
predicate relaxation.

Case cleanup still requires actual owned terminals, stdio closure and an empty
private job before case scratch removal. The wrapper owns Node separately and
retains bounded stdout/stderr plus fixed metadata in the evidence root. It never
scans or terminates all current-user processes, deletes accounts/profiles/tasks,
or modifies owner credentials. Evidence root is deliberately retained. A timeout
can request owned termination; it cannot establish actual OS exit or descendant
cleanup. Natural versus forced outcomes remain separate.

## Outer ownership and pending proof

The wrapper creates one unnamed, noninheritable outer Job Object with
`KILL_ON_JOB_CLOSE`, a 128-process cap and a committed-memory cap of the smaller
of 2GiB and one quarter of physical RAM. It requires 512MiB additional available
headroom. This is a combined cap for Node and all descendants, including
supervisors; each existing inner job retains its original limits. Memory is
committed bytes, not RSS. No breakaway flags or compatibility fallbacks exist.

`CreateProcessW` uses `CREATE_SUSPENDED` and the extended job-list attribute to
place Node in the outer job atomically at creation, eliminating the death gap
before a separate assignment call. The handle-list attribute admits only the
three child stdio handles. The wrapper verifies outer membership before
`ResumeThread`; task data is written only afterward. Unsupported attributes,
existing-job incompatibility or assignment refusal fail without task work.

The wrapper supervises task work for at most fifteen minutes before requesting
outer-job termination. It allows one shared ten-second cleanup grace for Node
terminal, both stream EOFs and zero outer-job members. Exceptions share that
same grace; they cannot restart it. Initial native setup failure allows at most
five seconds of process-handle waiting before attempting all owned closes.
No infinite terminal or stream wait exists. The downloader has its original
60-second cancellation budget plus five seconds for actual task completion;
unfinished completion produces retained uncertainty, never a blocking await.

Only completed tasks have their results consumed. On missing proof at grace
expiry, safe-handle release is requested without FileStream disposal/flush waits
on active pumps, the sole outer job handle is closed and the fixed receipt
records `cleanupUncertain`. Native pipe-handle release may be deferred by active
IO references; it is not claimed as observed EOF. Kernel handle close initiates
containment but does not substitute for terminal/member/stream evidence.
The sole outer-handle close is recorded separately. Supervisor and fixture jobs nest normally; their
existing success/cleanup assertions remain required. Unknown termination,
membership, stream or handle-close outcomes never produce a successful receipt.
A synchronous native or managed-to-kernel call can itself block beyond these
budgets; the finite bounds govern explicit polling and waiting, not a guaranteed
OS return time. No cleanup path adds an infinite wait or pending-task disposal
wait. Evidence root remains retained for all uncertain outcomes.

The wrapper writes `desktop.json` while verified ancestry handles are still held.
A complete, otherwise successful checkpoint has status `awaiting-final-cleanup`
and `finalOutcomeRequiresProcessExit: true`; it never says `passed`. Acceptance
requires that complete checkpoint, all required terminal/EOF/member/close fields,
no recorded uncertainty, and independently observed actual wrapper exit code
zero. Failed checkpoints remain `failed`. Missing, partial or unreadable evidence
cannot pass. Subsequent held-handle or environment-restoration failure forces
exit code one without rewriting through an unprotected path. Checkpoint IO
failure cannot skip held-handle disposal attempts or restoration of TEMP/TMP.
Every owned close is attempted; unknown cleanup retains uncertainty and evidence.

Wrapper death closes the sole outer handle and invokes the kernel termination
property. That property alone is not independent proof of descendant terminal
closure. The proposed [native proof matrix](windows-desktop-job-proof.md)
requires retained external process handles, actual nested jobs and pipe lifetime
checks. No such test, syntax gate or native execution has run. Root-chain
no-delete handles, ACL/reparse/replacement races, access-denied behavior, CI
parity and source/Node pin negatives remain pending too.

Execution uses the final reviewed, pinned tool commit only on the already
authorized target and tasks, after the required safety and native gates pass.
Retain every failed receipt. Compiler success is no pipe/delivery proof; startup success is no matched baseline/candidate capacity proof. Existing
CI failures remain unchanged historical evidence. Repository runner inventories
are scoped: the accessible agent-comms and GeniusBar endpoints list Linux ARM64
runners only, while GeniusBar packaging specifies `[self-hosted, Windows, X64]`.
That label contract establishes neither online capacity nor cross-repository access.
