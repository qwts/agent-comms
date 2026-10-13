# Private supervised broker session

Related to #77. The dedicated `bin/owner-supervised-broker.mjs` entrypoint is
for a separately reviewed immutable native-supervisor distribution. It is not
selected by the ordinary broker CLI and does not enable owner decisions.
No installer, service registration, account migration or runtime activation is
included. The ordinary broker API, CLI and authentication remain unchanged.

## Trust boundary

Root-controlled launch registration, complete immutable code closure, the
separate broker service UID and protected namespace establish installation
trust independently. Hostile arbitrary code running as that broker UID is
outside this service-account boundary. Node cannot attest anonymous-pipe
provenance. A copied client and simulated hello can imitate protocol success;
neither a JavaScript brand nor the returned installation digest proves protected
installation. The digest is session correlation only.

The entrypoint accepts no arguments or environment-selected configuration. It
acquires fixed inherited FD3 for requests and FD4 for replies. The native
launcher must provide both as nonblocking, close unrelated descriptors, clear
loader/environment selectors, and validate the exact runtime/code closure.
The flat hello configuration supplies existing state/shared directories, socket
group GID and broker/owner UID/GUID/namespace binding. Node checks exact fields,
primitive types, actual broker UID, canonical absolute paths and decoded normal
v2 observation bindings. It does not replace native custody or group checks.

## Protocol and ownership

Four-byte big-endian lengths bound requests to 32768 bytes and replies to 65536
bytes. The larger reply cap accommodates the existing 24576-byte native envelope
encoded as base64url plus fixed reply metadata. Canonical UTF-8 JSON, exact
schemas, sequence/session/installation consistency and strict normal v2 decoding
reject malformed, fixture, oversized and changed responses.

The launcher owns the enrollment flock. A synchronous scope opens with a fresh
observation, permits repeated observations, and closes only after the native
worker/source terminal and lock-close reply. No Node enrollment flock is taken.
The production coordinator factory consumes this private observation path when
bound, closes it synchronously, then still refuses activation: protected receipt
and physical journal eligibility are absent. No lock is retained across signing
or another asynchronous operation in these consumers.

Monotonic EAGAIN retries use 15 seconds for hello, 10 seconds per later exchange,
and one non-resetting 10-second scope budget. These depend on native nonblocking
FD setup; they do not bound a blocking syscall from a counterfeit parent. The
trusted native supervisor independently owns deadlines and child termination.
A 100 ms idle probe has no heartbeat timeout: EAGAIN is healthy; EOF or any
unexpected byte poisons the session and stops the dedicated broker. Protocol,
source drift and close failures poison permanently and close owned channel ends.
Signal handlers are installed before broker startup awaits. Shutdown stops the
broker before requesting session close; a latched failure cannot become success
through a later signal. A two-second timer begins before asynchronous stop.
Rejection exits immediately with failure; a stop that yields but never settles
reaches hard process exit, which terminates ingress but does not establish durable
cleanup. The JavaScript timer cannot interrupt synchronous session close (whose
nonblocking exchange budget is 10 seconds), a blocking syscall, or kernel-stuck
work. It is not a two-second total shutdown guarantee; the native supervisor
independently owns termination. Unknown terminal states remain unproven.

## Validation scope

Synthetic parent tests use actual inherited child descriptors, strict normal v2
vectors, the production factory, and an actual dedicated-entry broker with
pairing, join, read and SIGTERM shutdown. A short test-only Node helper uses a private pipe-handle API to set nonblocking
flags on shared inherited descriptions and confirms actual idle EAGAIN before
client import. Its actual terminal is checked; this is not native-launcher flag
acceptance. They prove client composition and
protocol refusal, not root installation, signed native launch, native worker
cleanup, nonblocking flag assignment or physical/receipt support. Installed
cross-language acceptance must establish those facts, both slices and the
minimum macOS deployment target before any support or activation claim.
