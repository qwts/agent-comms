# Pairing and membership observations

Related to [#164](https://github.com/qwts/agent-comms/issues/164) and the
[private local diagnostic profile](local-diagnostics.md).

Seven fixed broker observations distinguish pending credential requests,
approval and authenticated membership registration:

| Event | Operation | Stage | Code | Outcome |
| --- | --- | --- | --- | --- |
| `pairing.account-pending` | `pairing.account` | `request` | `pending` | `succeeded` |
| `pairing.daemon-pending` | `pairing.daemon` | `request` | `pending` | `succeeded` |
| `pairing.principal-pending` | `pairing.principal` | `request` | `pending` | `succeeded` |
| `pairing.account-approved` | `pairing.account` | `approval` | `approved` | `succeeded` |
| `pairing.daemon-approved` | `pairing.daemon` | `approval` | `approved` | `succeeded` |
| `pairing.principal-approved` | `pairing.principal` | `approval` | `approved` | `succeeded` |
| `membership.joined` | `membership.join` | `commit` | `joined` | `succeeded` |

Each event follows successful canonical mutation. Daemon approval additionally
follows revocation of old-generation watches. A pending request still requires
owner approval; approval does not prove a client is connected. A successful join
records registration, including an accepted repeated join that updates canonical
membership. It does not establish ongoing presence, delivery or task completion.
Restart recovery does not replay these observations.

Duration is the local monotonic operation duration in whole milliseconds,
including validation and canonical commit, not time spent awaiting human approval.
There are no per-event details, peer IDs, names, proof data, approval codes, public
keys or credentials. Expected validation, permission and repeated-approval
refusals preserve their existing public errors and emit no success observation;
this slice does not introduce comprehensive refusal diagnostics.

Events use the shared rate, queue and 512-byte record limits. Diagnostic callback
failure cannot alter canonical results. The [process-start opt-out](diagnostic-opt-out.md)
disables built-in producers, and [explicit offline export](diagnostic-export.md)
reconstructs only the approved tuples. No new disk store or network route is
added. Combined-producer numeric overhead and native Windows/packaged-host
acceptance remain separate work; prior lifecycle measurements do not cover these
new observations.
