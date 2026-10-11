# Federation: proposed custody and delivery contract

**Status:** Proposed, supporting [ADR-0028](decisions/ADR-0028-cross-machine-hubs-and-federation.md)
and [#28](https://github.com/qwts/agent-comms/issues/28),
[#118](https://github.com/qwts/agent-comms/issues/118),
[#119](https://github.com/qwts/agent-comms/issues/119).
Choices await owner acceptance/review; no runtime is claimed. #120 channel and
#122 retention approvals are separate from federation.

## Identity, trust and custody

Persist separate opaque `originHubId` (broker) and `relayHubId` (service), not
URLs/names/fingerprints. Origin IDs survive restart/key rotation. #120's address stays
`hub:<originHubId>/channel:<channelId>`; routing adds a selected relay identity.
Soul resolution binds relay/origin/account/soul; `<account>/<agent_id>` stays local.
Aliases select configured routes; bare remote IDs and ambiguous names refuse.

Owner-approved configuration names URL, pinned relay identity/key, private
credential reference and explicit export/import soul-operation scopes. Reuse
A2A's configuration/custody patterns where applicable, not its protocol or
principal mapping. No wildcard export, trust-on-first-use or public registration.
Each broker uses a distinct per-relay key and credential; approved peer pins bind
that key to its origin and permitted soul/account claims. Enrollment proves key
possession through an owner-verified out-of-band challenge. Rotation and recovery
require approval; copying state is not enrollment. No local account, principal,
daemon or binding secret leaves its machine. Discovery/diagnostics/receipts
contain no credentials or content.

Exports require approved local pairing and daemon-verified soul requests.
Imported sender verification records the approved issuing broker and its verified
assertion; it never claims a remote process was independently inspected. The
destination checks current import scope and recipient receive policy. A
remote soul does not become a local principal or acquire mailbox-read, owner,
launch, cold-wake or credential authority. Presence is scoped, expiring
reachability, not harness or human presence.

The relay sees selected broker/soul routing identifiers, timing, sizes and
connection facts. Authenticated encryption to the enrolled destination broker
protects content; origin signatures bind the complete immutable envelope and
selected relay, destination, key epoch and expiry. Destination receipts are
signed and bind that envelope digest. Cipher/key suite, canonical encoding and
rotation vectors require independent review before code; no novel construction
or dependency exception is approved. Compromised brokers read their own mail and lie about their
own souls. The relay can deny service or lie about its own custody, but cannot
forge destination commitment. Revoked peers cannot supply new accepted mail.

## Durable handoffs, retries and loss

An accepted send atomically commits the local outbox, authenticated sender,
resolved destination/relay, content fingerprint, random logical envelope ID,
creation time and immutable expiry. Lifetime is at most thirty days from origin
admission, including time offline; destination retention cannot extend it.
Reject creation times more than 120 seconds in the future and lifetimes longer
than thirty days; old creation times remain valid while the envelope is unexpired.
At `now >= expiresAt` refuse new body admission; never renew expiry on retry.
Persist a clock floor; detected backward wall-clock movement refuses expiry-sensitive
admission/collection until corrected instead of resurrecting expired traffic.

The sender's API key retains #122's seven-day same-fingerprint outcome/conflict
contract; at its deadline key reuse can intentionally create new work. Transport
retries instead retain the original logical ID for the entire envelope lifetime.
Relay and destination atomically reserve a protected dedupe outcome with custody
or mailbox commitment, keyed by relay/origin/logical ID; the fingerprint includes
key epoch and full digest. Rotation cannot create a fresh dedupe namespace.
Same ID/digest returns the original outcome; changed digest conflicts. Retain
terminal outcomes/loss tombstones through `expiresAt + 120 seconds`,
independently of body removal, receipt loss, restart or API-key expiry. Never evict
protected outcomes for capacity. Admission reserves body and outcome capacity
together; insufficient space accepts neither. A day-nine retry after a lost
destination receipt must return the original commitment, not deliver another copy.

| Observed state | Meaning and next action |
| --- | --- |
| Local `queued` | Origin durably accepted; retry the same envelope while valid. |
| Relay `custody` receipt | Relay durably reserved envelope/outcome; no recipient receipt implied. Origin retains retry evidence until destination outcome/expiry. |
| Destination `committed` receipt | Destination atomically committed one mailbox copy and protected outcome. A repeated handoff returns that receipt, even after body expiry. |
| `uncertain` | Handoff may have committed but receipt was lost. Query/retry the same ID; do not mint another envelope. |
| Authenticated `refused` | No commitment. Transient capacity refusal reserves nothing and may retry the same ID; terminal policy refusal reserves a protected outcome or returns capacity refusal. |
| `expired` / `revoked-undelivered` | A never-transmitted body was discarded with a loss tombstone. A transmitted copy without destination proof remains uncertain. |
| `expired-uncertain` | No destination proof before expiry; destination might have committed. Stop transport, preserve uncertainty evidence; no automatic new work. |
| Mailbox ack / task event | Only the authenticated mailbox owner acknowledges; task acceptance/completion requires its existing authorized revision transition. |

Relays retain bodies until destination commitment or expiry. Origins retain a
bounded durable body/outbox until signed destination outcome or expiry, so a
relay crash or lost custody receipt resumes safely. Each copy counts against its
custody budget. Read/watch/ack stay at the owning broker; no mailbox credential
is proxied. Disconnect is neither receipt nor cancellation.
Destination commit precedes any wake; only its account daemon may dispatch it.

Revocation stops new sends, discovery, imports and retries where recorded.
Purge queued bodies with durable loss/uncertainty outcomes according to transmission
evidence; retain protected dedupe records and committed recipient copies.
Remote revocation applies when learned; partitioned state remains unknown.
Route removal follows the same terminal queue policy, with explicit confirmation
of pending loss in the owner operation; re-adding a route does not replay that mail.

Task offers name an origin-qualified task ID and one authoritative origin store.
Versioned transitions are durable authenticated commands carrying stable IDs and
expected revisions; a partition leaves pending/uncertain state, never inferred
acceptance or execution. Preserve immutable offer content and visible task/event
access rules. Local inboxes retain cursor/ack semantics; no global order or exactly-once work.

## Finite proposed defaults and isolation

| Resource | Proposed admission cap |
| --- | --- |
| Broker hub configurations | 8, with separate credentials, grants, queues and discovery |
| Reference relay enrollment | 32 brokers; 100 exported souls per broker |
| Pending envelopes, per origin-to-destination peer route | 1,000 / 32 MiB |
| Pending envelopes, local broker per relay | 2,000 / 64 MiB; all relays 8,000 / 256 MiB |
| Pending envelopes, entire reference relay | 10,000 / 256 MiB |
| Protected transport outcomes, per broker and separately per relay | 100,000 / 32 MiB, counting serialized evidence |
| Wire envelope / plaintext body | 64 KiB / existing 32 KiB and escaped mailbox admission limits |
| Discovery advertisement | Refresh at most every 30 seconds; expire after 120 seconds |

Count and byte caps both apply. Mailbox #122 limits remain 10,000 retained copies,
64 MiB and 1,000 unacknowledged messages, with explicit thirty-day loss/gap
handling. Transport records are a separate finite budget, not another unbounded
message archive. Lowering a cap never deletes accepted state; refuse growth until
usage falls. Relay/body expiry cannot release still-protected outcome capacity.
Disclose metadata and the 288 MiB relay body/outcome budget before deployment;
no cloud bill or service-level agreement is approved.

Multihoming requires explicit selected-route sends; no automatic failover to
another hub, cross-hub census union or channel bridge. Replies retain ingress
route context. Local messages work without any remote configuration. Discovery
filters authorized exports/imports before counts/pages and reports local, remote,
connected, stale and unreachable facts distinctly. GeniusBar may later use the
same CLI/library state; it owns no federation logic. Remote channel subscriptions
remain outside #118/#119's direct/task scope: a future amendment must settle
partitioned admission without weakening #120's local all-or-none snapshot.

## Platform candidate and acceptance slices

Cloudflare documents [Durable Object WebSocket endpoints and hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
and [transactional durable storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).
These are candidate capabilities, not application guarantees. Deployment needs
measured persistence, failure, storage/cost and key-custody evidence first.

The [proposed acceptance plan](federation-acceptance-plan.md) maps existing code
seams, migration checks, handoff failures and shared #118/#119 ownership. Its
implementation sequence starts only after ADR acceptance and crypto review.
Two-machine acceptance and #28's production sequencing gate remain required;
keep all three issues open until their complete requirements have runtime evidence.
