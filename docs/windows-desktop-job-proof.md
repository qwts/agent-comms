# Desktop job proof candidate

Related to #164. This development tooling is not Windows acceptance evidence.
Execution uses reviewed, pinned tooling on the already authorized target/tasks
after required safety gates. Production categories, pins, deadlines and
breakaway predicates cannot change to make a test pass. See the
[desktop entrypoint](windows-desktop-acceptance.md) for profile and checkpoint
requirements. Original failed Windows receipts remain unchanged.

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

No downloader adapter is added in this batch. Deterministic tests need a reviewed
compile-time-only adapter around the same bounded stream/header/output logic,
never a normal URL selector. Cover declared length above cap, absent length with
overflow, mismatched lengths, zero/truncation, redirects, encoding and stalled
reads. Exact-cap bytes must hash correctly; the next byte refuses before write.
Cover exclusive-create collision, cancellation during read/write and handle-based
deletion/close failure. Keep the fixed HTTPS origin, checksum, 128MiB cap and
60-second budget; no DNS, proxy or certificate changes. A later fixed-origin
positive download must retain exact pinned bytes and cleanup evidence.

## Evidence limits

Local portable validation ran two context tests successfully; seventeen Windows
tests skipped. PowerShell parsing, native compilation and all Windows execution
remain pending. Source review or a future inert pass cannot establish real
standard-user token/profile attestation, actual compiler/startup success,
delivery, capacity, installed-host readiness or production deadline acceptance.
The inert tooling can enter the existing Windows CI lane independently of those
later gates; it must not be represented as already passing them.
