# Windows channel preparation diagnosis

This continues [observer sample evidence](windows-capacity-sample-evidence.md)
for [#164](https://github.com/qwts/agent-comms/issues/164), which remains open.
No production startup or capacity fix is claimed.

After that scoped PASS, the one separately reviewed
[old-pin startup-only run 38223141150](https://github.com/qwts/agent-comms/actions/runs/38223141150)
at unchanged `fa11e009` failed `production-startup/control-deadline`, with
fixture phase `fixture-broker-start` and supervisor `private-job-assigned`.
No completed cases or offered-rate stages exist; pairing and delivery were not
reached. Observer control PASS does not establish production Broker startup.
All six tool source hashes match the same signed Windows checkout.

Its owned cleanup confirms an empty private job, fixture and supervisor
terminal/stdio closure, scratch removal and zero cleanup errors. No direct
forced termination was requested, but job disposal can terminate its members;
natural fixture exit is not claimed. The parent conservatively retained
profile/account/stage because failure.json exists. Original raw hashes:

- [Acceptance](../tools/acceptance/evidence/2026-10-12-windows-connector/startup-38223141150/acceptance.json):
  `9bebc0b2ffc8043bc9eafb48c71c461c9016b274053f2441f8cf20fc14303be6`.
- [Capacity](../tools/acceptance/evidence/2026-10-12-windows-connector/startup-38223141150/capacity/capacity.json):
  `c56e9629e6ce49457a51ac686bbb981ab0eb1130e527a508d6cb9826dc1b97b9`.
- [Failure](../tools/acceptance/evidence/2026-10-12-windows-connector/startup-38223141150/capacity/failure.json):
  `8af051590e96735f436cc59cf7d94e81aa3d9bbcf17c50374b056fe6bbff870b`.
- Full run log: `b1d68a6638943b86eb5381fef5de0f58e58230c7c644e2d80f6e6f837089049f`.

This preserves the original unresolved production boundary after correcting the
dev-only observer. It does not implicate the custody calls already exercised
separately, establish a connector cause, or qualify capacity. No retry or
broader preflight/pilot follows automatically.

The next separately reviewed `capacity-channel` discriminant has scope
`channel-prepare-and-stale-probes`. It calls the actual old pinned default
channel `prepare()` on owned scratch, then each actual `removeStaleSocket()`
production connector API, with fixed before/after IPC phases. The minimal
channel context supplies only fields the real prepare/stop APIs use, with no
Broker construction or listeners. The actual default stop API is registered
before prepare can acquire its lock and runs on normal fixture stop or failure
cleanup. Parent private-job/terminal/scratch cleanup remains authoritative.

The discriminant skips EventLog, replay and maintenance; a PASS cannot establish
Broker.start equivalence. It creates no workload, monkeypatches no production
source or connector and changes no environment, policy, guard or deadline. The
same ninety-second request bound and owned lifecycle apply. Reports identify
the distinct scope, original fixed failure phase and channel-helper source hash.
Unit tests use stand-ins explicitly to check refusal propagation, ordered async
boundaries, cleanup registration and path/error canaries; they are not native
production evidence. Native CI and one separately reviewed hosted run are
required before any result claim; no startup/preflight/pilot retry is queued.
