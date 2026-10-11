# Principal clients with host-owned transports

`createPrincipalClientFromTransport({ principal, request })` exposes the same
typed methods using a public principal ID and host-owned `request(payload)`
function. It does not load a credential, read host configuration or attach an
auth object. A native backend can retain its secret and submit authenticated
requests itself; the library supplies only operation data. No placeholder
secret or credential loader is needed.

The transport returns the broker result as a promise, propagates typed errors
and performs its own deadlines, broker custody/pin checks and authentication.
The factory does not retry or fall back to a saved credential. `principal` is
display metadata, not proof of authentication; the broker determines identity
from the backend's credential and enforces current approval/grants. The backend
must bind that public ID to its authenticated session and restrict exposed
operations. Results and errors pass through unchanged, including synchronous
transport failures.

Both factories rebuild the same allowlisted operation payloads; caller-supplied
auth, sender and operation overrides are omitted. This is a transport seam,
not an app-only custody or presence implementation. Native storage, trusted
IPC, pairing/cutover and live negative-access evidence remain host work under
[#77](https://github.com/qwts/agent-comms/issues/77). No owner-decision or admin
operation is added. Owner policy is accepted in
[ADR-0077](decisions/ADR-0077-owner-decisions-through-the-broker.md); joint
protocol/native review and conformance evidence remain prerequisites before
enabling that capability.

See the [principal API](principal-client.md) for method, payload and result contracts.
