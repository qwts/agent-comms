# Full-startup finite diagnostic guard

This extends the [fixed-candidate startup evidence](windows-candidate-startup-evidence.md)
for [#164](https://github.com/qwts/agent-comms/issues/164), which remains open.

After the separately retained storage-prefix and channel passes, only the
closed fixed `candidate-startup` profile selects a 360-second parent request
watchdog and a separate 420-second reporting cap. Channel remains 180/240;
storage remains ninety/120. The immutable old/new controls retain their original
untimed ninety-second requests. The controller/fixture select exact closed
profiles; IPC duration or cap fields cannot negotiate an increase. Reports state
both selected bounds, with at most 64 private monotonic phase observations.
Out-of-range timing remains unavailable without clamping or replacing an
original failure. Only fixed broker-timeout is added to the bounded code
allowlist; no message, path, exception cause or arbitrary code is serialized.

This is diagnostic headroom, not a derived worst-case guarantee or performance
acceptance. Prepare has been observed at 61.416 and 78.854 seconds; the two
stale windows take about ten seconds each. Actual fresh storage includes two
durable replacements with configured thirty-second child timeouts; configured
timeouts are not descendant terminal guarantees. The storage pass has no
per-phase wall-time record and its cumulative CPU is not added to channel
elapsed time. Full startup additionally creates listeners, starts disabled A2A
collaborators, and executes actual account pairing/proof/credential operations
not yet measured by these controls. Several synchronous custody helpers have
no separate per-call timeout. The finite watchdog bounds this diagnostic; it
does not establish a guaranteed platform startup duration.

The actual sequence remains Broker.start, pair/admin approval, two joins,
send/read/ack/empty and natural stop on the unchanged reviewed correction
archive. Existing production ten-second connector and client request limits,
credential/custody/authentication checks, private job/process/profile guards,
cleanup deadlines and failure retention remain intact. Any actual refusal or
client timeout fails the run. There are no injected connectors, overridden
sources, changed runtime pins, offered rates or automatic retries. Exact-head
native CI and separate manual authorization precede one full-startup run.
Candidate success cannot validate the older immutable comparison pins; any
later baseline reconciliation requires independent review.

The subsequent [retained pairing failure](windows-candidate-pairing-evidence.md)
reached an actual Broker.start return within this guard; it does not qualify
the complete startup-plus-delivery sequence.
