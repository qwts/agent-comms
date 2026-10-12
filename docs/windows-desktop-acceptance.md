# Current-user desktop acceptance candidate

Related to #164. This unexecuted development candidate is distinct from the
disposable CI bootstrap. Its only tasks are `candidate-compiler` and
`candidate-startup`; it has no engine installation or capacity mode. It does
not claim a successful Windows run, installed-host acceptance, interactive task
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
