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

The signed channel head `8da5b88ffffd56b4427b2320f273557a6dd8d2fb` passed
[native/overall CI 38224400047](https://github.com/qwts/agent-comms/actions/runs/38224400047).
Its single [channel-only run 38224601406](https://github.com/qwts/agent-comms/actions/runs/38224601406)
failed `channel-prepare-and-stale-probes/control-deadline` at
`channel-stale-admin`, supervisor `private-job-assigned`. Actual default
prepare and the first main-pipe stale probe completed. The second admin stale
probe did not emit its completion marker. This does not distinguish synchronous
call/spawn delay from asynchronous event/timer liveness. All seven tool source
hashes match that signed Windows checkout. No Broker, listener, EventLog, replay,
maintenance or workload ran.

Owned cleanup confirms empty job, both child terminal/stdio closures, scratch
removal and zero errors, with no direct forced termination requested. Job disposal
may terminate members; natural fixture exit is not claimed. Parent profile/account/
stage remain retained conservatively because failure.json exists. Raw hashes:

- [Acceptance](../tools/acceptance/evidence/2026-10-12-windows-connector/channel-38224601406/acceptance.json):
  `29d224fe55f062273bd4437711df4edb7a72b806a47d150c02368bd122564dcc`.
- [Capacity](../tools/acceptance/evidence/2026-10-12-windows-connector/channel-38224601406/capacity/capacity.json):
  `0597e281d68d83e3e7619fd74c4ecb442402be82befc6869a155f17ce088fc00`.
- [Failure](../tools/acceptance/evidence/2026-10-12-windows-connector/channel-38224601406/capacity/failure.json):
  `a4f0ab15bdc47075b538288325840246fd05874ebe311a6f921529e84cf5b1a1`.
- Full run log: `60ac28fd7a26ad887ccb332491a21cd8bde0da29e029ef4de0a944dc4e3111bd`.

Exact old-pin source inspection shows removeStaleSocket awaits only connect/error.
Its production connector installs its ten-second timer after spawning the relay,
and the same channel caches currentUid during prepare. Neither observation proves
the failure cause. The next minimal marker records each actual stale API call's
return before awaiting its unchanged Promise. This separates synchronous call/spawn
stall from a returned but unresolved Promise, without altering production source,
connector parameters, environment, policy, guards or deadlines. No further run is
authorized by these retained results.

The return-marker head `74dafeb423019b38635c953436de469b1fb77235` passed
[native/overall CI 38225733425](https://github.com/qwts/agent-comms/actions/runs/38225733425).
The one [channel-only run 38225963055](https://github.com/qwts/agent-comms/actions/runs/38225963055)
failed at `channel-stale-admin-returned`, with the same control deadline and
supervisor phase. Prepare and the main stale probe completed; the admin call
returned its Promise, but awaiting it did not complete. This excludes a
synchronous call/spawn stall in this run, without establishing the asynchronous
event/timer cause. All seven source hashes match the signed Windows checkout.

Empty job, both owned terminal/stdio closures, scratch removal and zero cleanup
errors are confirmed. No direct forced termination was requested; job disposal
is not a natural-exit claim. Parent profile/account/stage remain retained because
failure.json exists. No Broker/listener/EventLog/replay/maintenance/workload ran.
Original raw hashes:

- [Acceptance](../tools/acceptance/evidence/2026-10-12-windows-connector/channel-38225963055/acceptance.json):
  `baf7e8959c9966e2c934c985ad7b08103bc7cb04461423979830dd4d5cd68e7e`.
- [Capacity](../tools/acceptance/evidence/2026-10-12-windows-connector/channel-38225963055/capacity/capacity.json):
  `1ad31ea2a84331534a19d483cf457bb1d01a0bb717b528cf351f2a838c5c1a2e`.
- [Failure](../tools/acceptance/evidence/2026-10-12-windows-connector/channel-38225963055/capacity/failure.json):
  `a6e27015d160ad8bd3c2e2d0be366c15c2e689dae128e558fba06d83e940e1ba`.
- Full run log: `bc4a957781550ceee9891c17d18b1c4d778850ad2f126ce5958e0b4a094dda68`.

All original failures remain unchanged. No production correction, capacity
qualification or further run is inferred from this result.

The proposed next [connector event diagnostic](windows-connector-event-evidence.md)
observes the actual unconsumed connector's bounded lifecycle without overrides.
