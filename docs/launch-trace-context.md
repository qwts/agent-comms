# Ephemeral launch trace context

Related to [principal launch](principal-client.md#request-a-daemon-launch),
[#164](https://github.com/qwts/agent-comms/issues/164) and
[agent-bot #983](https://github.com/qwts/agent-bot-identity/issues/983);
both issues remain open. This is a principal launch propagation slice, with
no return/wake propagation, exporter, CLI flag or host release.

Optional `traceparent` is untrusted correlation data with no authority. The
broker forwards only an exact 55-character lowercase W3C version-00 value
(`00-<32 hex trace ID>-<16 hex parent ID>-<2 hex flags>`), with both IDs nonzero,
unchanged on the account-watch launch event. Two lowercase hex flag digits are
preserved. Format validity does not prove trusted provenance or grant rights.
No baggage or tracestate propagates.

Invalid or wrong-type values are silently omitted and increment a bounded
local `traceparent_dropped` counter after ordinary principal authentication,
target validation and grant checks. Existing frame limits, approval,
credentials, rate limits and durable-before-delivery ordering remain in force.
Oversized frames still fail under their existing limits; optional context does
not exempt them. Omission preserves existing behavior. Older brokers may
ignore the field; this change does not update an installed host or daemon.

Native host adoption also needs its transport field allowlist updated; the
[host transport work](https://github.com/true-line/geniusbar/pull/378) does not
establish support for this optional field. A newer SDK alone does not establish
installed end-to-end trace propagation through that host.

The broker constructs its durable launch target separately from the watch
event. The trace value never enters launch records/state, launch
status/progress/results, wake events, or diagnostic context/links. Daemon
progress/result fields cannot write it back into broker state. Broker restart
does not recover or replay launch trace context.

The [local diagnostic counter](local-diagnostics.md) carries only the
saturating cumulative integer, with the existing finite queue, event-byte,
rate and failure bounds. It never serializes supplied values or trace/span
IDs. A failed diagnostic cannot change launch success, refusal or storage
recovery behavior. This counter is not a durable audit receipt.
