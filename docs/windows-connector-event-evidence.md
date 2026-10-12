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
Reports include a distinct scope and connector-helper source hash. No result is
claimed yet.
