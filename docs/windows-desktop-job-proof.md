# Desktop job proof candidate

Related to #164. This tooling is not Windows acceptance evidence.
Execution uses reviewed, pinned tooling on the already authorized target/tasks
after required safety gates. Production categories, pins, deadlines and
breakaway predicates cannot change to make a test pass. See the
[desktop entrypoint](windows-desktop-acceptance.md) for profile and checkpoint
requirements. Retain failed receipts. See [archive bytes](windows-candidate-archive-bytes.md).

## Implemented containment tests

`tests/windows-desktop-job-native.test.mjs` uses the existing public Windows
pipe-security lane. It runs inert scratch fixtures, never the desktop entrypoint,
compiler/startup workload, installer or account/profile bootstrap. Roots remain
retained on success and failure. The portable context tests check fixed tasks,
frame bounds and that decoded/caller data cannot forge an owned context.

The independent PowerShell controller retains noninheritable PROCESS handles
with synchronization, limited-query and exact-process termination rights. Native
creation identities are compared while processes remain blocked. It retains
those original handles through failure and waits for actual signals; PIDs or
later absence queries are insufficient. It never obtains a JOB handle.

A separate owner compiles the same helper C# with `DESKTOP_JOB_PROOF` enabled.
The normal compilation must lack its barrier field and both read-handle exposure
properties. No environment, frame or wrapper option enables them. The barrier
runs after atomic job-list creation and membership verification, before resume.
The started marker precedes fixture-frame reading. Before-resume owner death
must leave no marker and signal the retained owner and Node handles.

The entered fixture uses the real classic capacity supervisor and actual
paused-fixture attachment, preserving executable, argv, parent, temp and commit
predicates. The controller then retains owner, Node, supervisor and fixture
handles. Parent loss must signal all four. The actual paused descendant inherits
Node stdout/stderr WRITE ends, so Node exit alone cannot establish EOF.

Only the owner PROCESS handle has `PROCESS_DUP_HANDLE`. Before inducing death,
the controller duplicates the two test-exposed READ pipe handles with
`GENERIC_READ`, noninheritance, no `SAME_ACCESS` and no `CLOSE_SOURCE`. It verifies
pipe type and retains neither writer nor job. The parent-loss owner starts no
competing pumps. After all retained process handles signal, the controller drains
bounded chunks and requires actual `ReadFile` EOF on both readers. Empty
availability is not EOF: broken-pipe `PeekNamedPipe` state requires a read
returning zero bytes or broken pipe. Readers share five seconds and have a
one-MiB cap each. Missing EOF, read failure or unknown close fails the test and
retains scratch. Controller stream closure is observed separately.

A separate explicit outer-termination case requires Node terminal, actual pump
EOF and zero outer members. Termination requests and closing the sole job handle
never establish those facts. Synchronous native calls can themselves block;
polling budgets do not guarantee OS return time.

Finite uncertainty calls `Complete-DesktopOwnedCleanup`, shared with the actual
wrapper finally path and its fixed ten-second stopwatch. Real children terminate
while genuine unfinished tasks withhold EOF evidence. The helper must return
uncertainty without consuming those tasks. Another case starts the same clock
nine seconds earlier to verify that cleanup does not reset its budget. Test
observation tolerance changes no runtime constant. A passing test receipt for
expected uncertainty is never a passed desktop acceptance receipt.

## Inert filesystem and CI refusal tests

`windows-desktop-boundary.test.mjs` calls the same private held-chain/ACL checks
as `Open-DesktopRootChain`. Normal entry still derives real LOCALAPPDATA and the
authenticated profile SID. Helpers cannot issue context or override that entry.
Only dedicated temporary directories and safe junction targets are mutated.

The 25 native assertions cover fixed placement, exact ACL acceptance, malformed
ACL refusal, fresh ACL changes, held leaf/ancestor rename and leaf deletion
refusal, successful rename after release, root/ancestor junction refusal, release
after partial failure, and unchanged sibling content/ACL. Wrong-owner coverage
compares the actual owner against a different expected SID; no ownership or
privilege change occurs. Held no-delete handles do not claim ACL immutability.
No real profile ancestor is modified; all scratch remains retained.

The unchanged CI bootstrap receives five missing/invalid marker pairs, never
both valid markers, and must refuse before staging or account operations.
The byte-identical child script copied into scratch receives a null SID and
must refuse before cloning or marker issuance. Five Node CI marker refusals
must precede output/workload. This establishes negative parity, not positive
profile or disposable-account acceptance.

## Start failure diagnostics

A refused `DesktopOwnedJob.Start` preserves its first fixed stage, exception type,
HResult and immediately captured error from SetLastError-enabled native calls.
Cleanup has separate first-failure fields and at most 32 fixed operation results;
later cleanup does not replace the original failure. Attribute sizing retains its
expected false/required-size behavior. No exception message, path, environment,
command or process identity is serialized.

A bounded projector compares actual type identity in the compiled helper assembly
and admits only fixed stages and
primitive field types. Missing diagnostics, including argument-binding failures,
produce `start-diagnostic-unavailable`. The protected-path checkpoint has an
8192-byte UTF-8 bound. Start failure still exits 1 with cleanup uncertainty.

Process terminality comes only from the existing retained-handle wait. Requests,
safe-handle disposal and successful raw closes do not imply job emptiness or pipe
EOF; those observations remain explicitly unavailable on this path. Allocation
release exceptions are recorded and all remaining cleanup attempts still run.
The existing five-second startup cleanup clock and all launch guards remain.
Inert record tests cover first-failure latching, independent cleanup failure,
later cleanup results, cleanup-only failure, native-before-buffer cleanup latching, same-fullname forged
assembly refusal, foreign-type refusal and an invalid
limit that refuses before native calls. These new tests remain unexecuted on
Windows; syntax/source review establishes no new native cleanup evidence.

## Environment serialization regression

A desktop attempt failed at `environment` with `InvalidCastException` before
process creation. The wrapper now stores fixed allowlisted entries as strings;
the shared serializer keeps strict casts and all validation/order/size limits.
An unexecuted classic regression requires original Join-Path cast failure and
actual corrected-map admission without native calls. PSObject wrapping remains
a hypothesis until reproduced. Input-escaping failure launched no wrapper. No compiler acceptance follows.

## Remaining native matrix

| Case | Required evidence |
| --- | --- |
| Node exits first / retained stdout | A contained descendant outlives Node; no completion until actual empty membership and EOF, or forced failure with actual cleanup. |
| Incompatible assignment | No resume/task marker; owned suspended child terminates; no breakaway fallback. |
| Handle inheritance inventory | Only expected stdio is inherited; no child-held outer job handle. Never duplicate JOB merely to inspect it. |
| Resource-cap refusal | Outer limits include all descendants; original inner limits remain; refusal and actual cleanup are separate facts. |
| Query/close/pipe failure | Every close is attempted; uncertain outcome never produces acceptance. No normal injection selector. |
| Native denied access | Refusal and partial-handle cleanup, affecting only owned scratch. |
| Root replacement/reparse races | Native blocked mutation or fresh refusal, with retained identities and unchanged sibling sentinel. |
| Checkpoint/restore failure | Protected-path checkpoint cannot imply success; held closes and TEMP/TMP restoration still run; actual exit determines final outcome. |

## Download gates

The shared production transfer/cleanup implementation has a separately compiled
`DESKTOP_DOWNLOAD_PROOF` entrypoint. Normal compilation must expose no proof
entrypoint; a native reflection assertion enforces this. No environment, frame or
URL selector enables it. The production adapter keeps its fixed HTTPS origin,
checksum pins, 128MiB cap and 60-second cancellation timer. Response lengths below
`-1` now refuse explicitly; only `-1` means unknown length.

The deterministic native owner supplies generated streams and metadata, while
using real exclusive CREATE_NEW output, same-handle hashing and failed-file
deletion. Cases cover status/encoding/length refusal, empty/short/long bodies,
read failure, unknown-length overflow, exact-cap success and unchanged collision
and sibling content/ACL. Hash/content verification streams fixed-size chunks;
no archive-sized array is allocated. The existing owner bounds process lifetime,
stdio and actual terminal/EOF evidence; scratch remains retained.

These cases remain unexecuted for this revision. They do not prove actual
HttpWebRequest Abort or native close success. Cancellation barriers, stalled
reads and injected deletion/close failures remain separate gates; no cleanup
failure adapter is included. A later fixed-origin positive download must retain
exact pinned bytes and cleanup evidence. No DNS, proxy or certificate changes
are permitted.

## Evidence limits

For this downloader revision, portable validation passed eighteen tests and
skipped seventeen Windows tests. Syntax-only PowerShell parsing passed; its C#
compilation and Windows execution remain pending. This does not replace prior
containment evidence or establish real standard-user token/profile attestation,
actual compiler/startup success, delivery, capacity, installed-host readiness or
production deadline acceptance. New inert cases can enter the existing Windows
CI lane independently of those later gates and must not be represented as
already passing them.
