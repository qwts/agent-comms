# Corrected-source Windows startup remains unaccepted

This continues [production startup diagnosis](windows-capacity-startup-evidence.md)
for [#164](https://github.com/qwts/agent-comms/issues/164), which remains open.
No corrected native startup or capacity is qualified.


Production stale-probe settlement repair [#219](https://github.com/qwts/agent-comms/pull/219)
merged as `e12ed22e4f3c1c3585470a6f3c8fb4ce0cb3a0e0`, with
[main CI 38232608397](https://github.com/qwts/agent-comms/actions/runs/38232608397)
passed. Constructor tests demonstrate irreversible live detection before
cleanup, fixed refusal on close-before-connect and safe late stream errors.
This repairs real source defects without establishing their role in prior
hosted timeouts. It is post-0.5.2 source, not a new released tuple.

The separate candidate tool at signed
`3e12dc8d3fe6b1be5a3b390a7e5b1ea67c6218b2`, tested tree
`a454490f45f4f2c387a59dd87157705332469bc8`, passed
[exact-head/native CI 38233486142](https://github.com/qwts/agent-comms/actions/runs/38233486142).
Local full tests passed 616 total / 604 pass / twelve existing native skips /
zero failures or cancellations; focused controller/lifecycle/candidate tests
passed 30/30, including real correlated fixture failure IPC through cleanup.
The one authorized [candidate-startup run 38233745086](https://github.com/qwts/agent-comms/actions/runs/38233745086)
failed at `production-startup` / `control-deadline`, with last fixture phase
`fixture-broker-start` and supervisor phase `private-job-assigned`. No broker
refusal code was received and no completed run, pairing or delivery is claimed.

The actual source pin `2d94b16a17f7d0a8625e6151e97fee844232aab1` has tree
`9c1719821d656e17eb04dc477cc9415e4697f12f`, identical to merged #219's tree.
The Windows CRLF archive SHA256
`d3465c40e5e11561f22f3aa720f74146aa70b2091dcd09c34c1c4046daea6853`
matched the hardcoded approval before extraction/import and was independently
reproduced. All nine reported tool hashes match the exact signed source after
Windows CRLF conversion. Node remained the checksum-verified 24.21.0 tuple.
The report contains only this candidate source, with no old/new comparison,
offered stages or capacity qualification. Original reports remain unchanged:

- [Acceptance](../tools/acceptance/evidence/2026-10-12-windows-connector/candidate-startup-38233745086/acceptance.json):
  `e51ab9d12d5557417eae1f735957620946e7cd298c0ae97091ab8c65c94da251`.
- [Capacity](../tools/acceptance/evidence/2026-10-12-windows-connector/candidate-startup-38233745086/capacity/capacity.json):
  `a274e0fa2663b454b41109c51c758089ae7d031394ab855985de83886a5d54bb`.
- [Failure](../tools/acceptance/evidence/2026-10-12-windows-connector/candidate-startup-38233745086/capacity/failure.json):
  `58d96450d8b2a8084580b540c09f3ca9f72b57db221526219ef8c5da2d33d37c`.
- Full run log: `17b24b1e5a0e60351bd6a2e04e7c451d3f0171651483e09210fbf319e2517875`.

Empty private job, both owned terminals, both stdio closures and tool scratch
removal are confirmed with zero tool cleanup errors and no direct force flags.
Job disposal may terminate members, so natural fixture exit is not inferred.
The bootstrap conservatively retained the profile/account/stage because
failure.json exists, reporting `capacity-tool-cleanup-unconfirmed` and
`test-profile-cleanup`. Cleanup proof does not turn the startup failure into
a successful production case. No retry or broader preflight/pilot followed.

Exact candidate source inspection shows that Broker.start performs prepare,
EventLog construction/replay and initial compacting maintenance before stale
probes and listeners. Fresh maintenance uses synchronous Windows durable
replacement for append/compaction through the actual PowerShell helper. Those
storage calls were excluded from previous custody/channel controls. This is a
source-level untested seam, not evidence of a particular failing call,
PowerShell cause or remedy. Corrected native startup and capacity remain open.


## Fixed-source storage-prefix control

The separate manual `candidate-storage` control loads the same hardcoded,
verified correction archive and creates a real production Broker instance.
It registers actual Broker.stop cleanup before actual channel prepare can
acquire a lock. Fixed phases bracket Broker construction, prepare, EventLog
construction, assertLogFile, replay and public maintain with compact enabled.
It requires an empty replay (sequence zero and next expiry Infinity), matching
the constructor's private expiry to the actual fresh startup state; this is
not an emulation of arbitrary recovered Broker state. All implementations,
paths, storage and maintenance defaults come from the unmodified candidate.

The fixture still pauses before production imports until private-job attachment.
The startup request retains ninety seconds, the same memory/process/profile
guards and original failure plus owned cleanup reporting. Production nested
PowerShell/compiler descendants belong to that private job. The production
Windows durable replacement helper's configured thirty-second spawnSync timeout
is unchanged and does not itself prove helper/descendant exit or stdio closure.
No child command, policy, environment, deadline or implementation is replaced.
The report separately records this lifetime-observation limit, the storage
diagnostic module hash and the verified production archive hash; transient
descendants remain included in cumulative job accounting.

The control omits Broker.start, stale probes, listeners, A2A startup, delivery
and rate offers. It cannot establish complete Broker startup or capacity.
Focused stub tests verify sequence, fresh-state refusal, fixed phase privacy
and cleanup registration at every boundary; real child/controller IPC verifies
correlated maintenance failure survives channel close without raw error data.
Native CI exercises those mechanics; only a separately authorized manual
standard-user run can test the actual candidate storage APIs. The subsequent
[storage-only pass](windows-candidate-storage-evidence.md) validates that defined
prefix without changing the failed whole-startup result.
