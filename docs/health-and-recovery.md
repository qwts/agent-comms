# Authenticated health and recovery

Both principal client factories expose `health()`. It sends the existing
`{op:"health"}` operation through the same credential or host-owned transport
as `census()`. A pending principal receives `not-approved`; an invalid or revoked
principal receives `unauthenticated`. Account and daemon credentials cannot
substitute for principal authentication. The storage-poison guard still runs
before health dispatch and can return `storage-failed`.

## Additive health metadata

Existing fields retain their meaning: `uptimeMs`, `eventLogBytes`, `pairings`
with account/principal counts, and `watches`. Those existing health counts are
broker-wide; census remains filtered by the principal's grant before rows are
built. No new global queue, message, task, diagnostic sink or drop statistics
are exposed.

The additive fields are:

| Field | Meaning |
| --- | --- |
| `buildVersion` | Validated running package version, or null when unavailable/invalid. |
| `buildSource` | `running` with a valid version, otherwise `unknown`. |
| `capabilities.v` | Version 1 of this capability metadata object. |
| `capabilities.diagnosticRecordVersion` | Version 1 of the supported closed private diagnostic record format. |
| `capabilities.diagnosticExportVersion` | Version 1 of the supported `agent-comms.diagnostic-export` artifact. |

Build metadata is read once at module initialization and shared with diagnostic
production and offline export. Health does not reread package metadata on each
request. The version is descriptive metadata, not a signed artifact identity,
release acceptance or native platform/custody proof.

Capabilities describe implemented formats. They do not assert complete shared
profile compliance, enabled capture, successful writes, complete diagnostic
coverage or availability of records from an earlier process. Producer opt-out
does not remove format support. There is no new wire protocol version in this
object. Health fields are not accepted as private diagnostic records by the
strict export projector.

## Recovery taxonomy over existing codes

Public error codes are append-only. Branch on `code`, never message text or
diagnostic event names. This table documents existing behavior; it adds no
public code, detail, automatic retry or bypass. Unknown codes require the
operation's contract to be consulted rather than an inferred retry policy.

| Existing codes | Meaning and recovery |
| --- | --- |
| `credential-invalid`, `keychain-read-failed` | Local credential construction/read failed. Correct the selected credential store before constructing the client again; do not fall back to a different identity. |
| `not-approved`, `unauthenticated` | Approval is pending, or authentication is invalid/revoked. Resolve the existing approval/pairing state. Repeating a mutation does not grant authority. |
| `broker-untrusted` | Custody or proof validation refused. Correct the broker installation/pin through the existing trusted procedure. Never ignore the check or substitute an unverified endpoint. |
| `broker-unreachable`, `broker-timeout`, `bad-response` | A connection, request deadline or response failed. Read-only health/status can be attempted again after connectivity is checked. A failed mutation response does not prove the mutation did not occur; reconcile using its existing operation-specific identity before another attempt. |
| `storage-failed` | Broker storage is uncertain. Stop the broker, correct storage and restart to recover before retrying. Health is subject to this refusal too. A visible complete log line can be recovered after the original call failed. |
| `bad-request`, `unknown-operation` | Fix the typed request or client/server operation mismatch. Repeating unchanged invalid input will not repair it. |
| `unknown-recipient`, `forbidden` | The target is unavailable to this caller or the operation is disallowed. Check grants and participant capabilities; hidden targets are not existence disclosures. Health success never broadens census or messaging grants. |
| `rate-limited`, `mailbox-full` | Existing rate or mailbox capacity limits refused work. Follow the operation's rate/capacity policy; do not create new keys to evade limits or discard unacknowledged messages. |
| `conflict`, `revision-mismatch`, `invalid-transition` | Retained idempotency content, task revision or state transition disagrees. Read current operation state and retain the original identity; do not silently change content under the same key or force a transition. |
| `cursor-expired`, `gap-changed`, `message-expired` | Retention or acknowledged-loss state changed. Follow [mailbox retention](mailbox-retention.md): use the bounded resume/gap metadata, reread changed gaps before acknowledgment, and do not infer that expired bodies remain recoverable. |
| `internal` | An unexpected handler failure occurred. Preserve the public result and inspect bounded local diagnostics. No generic replay guarantee follows from this code. |

Principal methods do not retry automatically. The account watch has its own
existing retry loop for `broker-unreachable` and `broker-timeout`; this is not
a general mutation retry mechanism. Mailbox admission, delivery, acknowledgment
and task completion remain separate states. See [local diagnostics](local-diagnostics.md)
for best-effort observation limits and [principal client](principal-client.md)
for the authenticated API.
