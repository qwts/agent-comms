# Windows connector event diagnosis

This follows the [channel failure](windows-capacity-channel-evidence.md) for
[#164](https://github.com/qwts/agent-comms/issues/164), which remains open.
The admin stale API returned its Promise but did not complete; a synchronous
call/spawn stall is excluded for that run. No asynchronous cause or production
fix is established. All earlier raw failures remain retained unchanged.

The separately reviewed `capacity-connector` diagnostic runs the actual old
pinned default channel prepare and main stale probe, then calls the actual
pinned `connectWindowsPipe` for the admin pipe directly. It derives the same
admin name with actual `pipeNameFor`, default label and the SID returned by
prepare, kept private. It supplies only that pipe argument: no connector
parameters, subprocesses, production source or environment are overridden.
No Broker, listener, EventLog, replay, maintenance or workload is created.
This is an event/liveness seam, not Broker.start equivalence or capacity.

The raw connector stays unconsumed: no read, resume or data listener. Fixed
connect/error/end/close events, allowlisted refusal stage/code, safe stream-state
booleans and up to twelve one-second heartbeats are observed. The diagnostic
keeps a referenced twelve-second observation timer; the production connector's
own ten-second timer is unchanged. Its snapshot precedes caller-owned destroy,
so later teardown cannot invent an operation event or natural closure. An error
listener remains through disposal to prevent an unhandled late stream error.
No Error, cause, arbitrary message, path, pipe name, SID or command is serialized.
The parent validates the fixed observation shape and bounds before retaining it.

The outcome distinguishes refusal-and-close, close-without-refusal, connection
and observation deadline. A completed diagnostic reports these observations
without treating silence, connection to an unexpected listener, or its deadline
as a correct refusal. Its outer PASS means observation and owned cleanup
completed, not healthy production transport. Raw disposal is followed by the
existing actual private-job accounting check and normal stop. Existing job,
identity, descendant, memory, ninety-second request and cleanup bounds apply.
Missing job/terminal/stdio receipts still retain scratch/profile/account/stage.

Unit tests explicitly use stand-ins to check event order, refusal privacy,
silent-close distinction, snapshot immutability, referenced observation bounds,
fixed shape validation, exact API arguments and owned cleanup. They establish
no native connector result. Exact-head native CI and root review must precede
one hosted diagnostic; no startup/preflight/pilot retry is authorized here.
Reports include a distinct scope and connector-helper source hash.


The [first connector-event run](https://github.com/qwts/agent-comms/actions/runs/38228125681)
failed at signed source `87d29cb63369eb69d4c2a703f96ee32cfa8405b8`, after its
[exact-head CI](https://github.com/qwts/agent-comms/actions/runs/38227915466)
passed. All eight tool source hashes match that commit with Windows checkout
line endings. The original report records `actual-connector-events`,
`control-deadline`, fixture phase `connector-heartbeat`, and supervisor phase
`private-job-assigned`; `runs` is empty. Actual prepare and the main stale probe
completed, and the admin connector returned and reached the heartbeat loop.
No completed event snapshot or heartbeat count was retained. This cannot
distinguish an unresolved observation from synchronous disposal preventing the
reply; it establishes no causal production fix or capacity result.

Both owned process terminals and stdio closures, empty job and tool scratch
removal are confirmed with zero tool cleanup errors and no direct forced
termination request. Job disposal can terminate members, so natural fixture
exit is not claimed. The parent conservatively retained profile/account/stage
because failure evidence exists (`removed=false`,
`capacity-tool-cleanup-unconfirmed` and `test-profile-cleanup`). Original raw
reports remain byte-for-byte retained:

| Report | SHA256 |
| --- | --- |
| [acceptance](../tools/acceptance/evidence/2026-10-12-windows-connector/connector-38228125681/acceptance.json) | `7730c81ef6c81e7a4e8586f7a72b84cf56ab3e671efd961564c1619eafe43627` |
| [capacity](../tools/acceptance/evidence/2026-10-12-windows-connector/connector-38228125681/capacity/capacity.json) | `037f8e68b2ebe3f264953c7a7c26c96293aabdc702214e449f981a0981f902eb` |
| [failure](../tools/acceptance/evidence/2026-10-12-windows-connector/connector-38228125681/capacity/failure.json) | `d661f0688e367230f8b818832a5a0191658d3dad7b2ca5f5b0c088320a31bcae` |

The downloaded full workflow log SHA256 is
`2f95bee4a8e3da946583e000f62bd09d230ad36cad0125ff8236b99792a15ac2`.
It can be retrieved with `gh run view 38228125681 --log`.

The next bounded diagnostic delta marks observation completion and entry/return
of caller-owned raw disposal. Heartbeat/completion metadata contains only a
monotonic count from zero through twelve and actual elapsed milliseconds up to
ninety seconds. An elapsed value outside that bound refuses with a fixed error;
it is not clamped into false evidence. The parent stores private bounded copies
and snapshots progress before cleanup. These fields do not change production
source, connector arguments, timers, environment, policy or existing deadlines.
Timer proximity only suggests an interval; it does not prove causality. Source
review, full local checks and exact-head native CI precede any separately
authorized follow-up observation. No startup/preflight/pilot follows here.
