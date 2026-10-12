# Diagnostic backpressure evidence

The retained macOS Node v26.11.1 functional tests exercise actual production
stderr helpers with an unread pipe, a stopped helper, and a killed helper.
They use the existing private test-owned sink stats and IPC seam, without a
public stats API or production source change. The fixture deliberately injects
its sink into the broker and floods fixed observations; it is separate from
the default-callback numeric mailbox workload.

## Live plateau and terminal failure

Unread and stopped modes require the same live helper and an enabled sink.
Within the original 500 samples at 20 ms spacing, five consecutive samples
must show one pending write, exactly 64 queued records, unchanged written
count and increasing drops. Every sample checks the 32 KiB queue and 512-byte
in-flight caps. A disabled sink fails this live plateau gate. Killed-helper
coverage separately requires terminal disablement, empty queued/in-flight
work, bounded continuing drops and no replacement helper.

Actual send, delivered read, acknowledgment, empty read and authentication
refusal checks retain canonical behavior under pressure. Post-operation live
samples retain the plateau and growing drops. Natural fixture exit and helper
disappearance precede disposal of the owned unread stderr pipe and confirmation
of actual child stdio closure. Existing fill and shutdown deadlines remain;
these are functional test deadlines, not an OS-wide hard deadline guarantee.

## Retained scope

[Evidence and manifest](../tools/acceptance/evidence/2026-10-12-diagnostic-backpressure/README.md)
retain both original three-pass logs. The second emits at most eight sanitized
fixed-field records per mode, with counts, byte totals and cleanup booleans;
no PID, path, body or identifier is retained. It is not a raw IPC archive.

This proves the tested private sink/transport plateau and failure independence.
It does not prove saturation in the separate numeric unread mailbox workload,
performance budgets, kernel/helper memory bounds, Windows acceptance or
lossless diagnostic capture. Production queue, rate and byte limits remain
unchanged.
