# Named channels: proposed contract

**Status:** Owner-approved policy (2026-10-11), pending repository review, for
[ADR-0004 Amendment 1](decisions/ADR-0004-durable-mailbox-and-waking.md#proposed-amendment-1-local-first-named-channels),
[issue #120](https://github.com/qwts/agent-comms/issues/120).
The owner approved both access and delivery/lifecycle policies in the
orchestration session. No channel implementation is claimed. This details all seven
requirements: soul/principal operations, durable subscriber copies and filters,
subscription waking, authorization, census, stable future addresses and every
harness. Remote transport remains in #28/#118/#119. Mailbox retention depends on
[#122 / PR #141](https://github.com/qwts/agent-comms/pull/141), not a permanent
channel history store.

## Proposed policy

1. **Identity and eligibility.** Persist an opaque broker `originHubId` and
   generated `channelId`; address channels as
   `hub:<originHubId>/channel:<channelId>`. IDs survive restart, key rotation
   and future remote routing; they approve no federation trust or transport.
   A hub-local name (1–128 UTF-8 bytes) is an immutable display alias; duplicates
   are allowed to avoid hidden-name collision leaks. Only canonical IDs route. A joined soul in an approved account may create a channel.
   An approved principal needs an owner-issued channel-create capability. The
   creator is the sole initial manager and has channel posting permission
   without subscribing (principals still need post capability). Only the local
   owner may replace/transfer this one manager. The manager must remain a joined
   soul in an approved account or an approved principal with channel management
   capability.
2. **Consent and least privilege.** Managers invite self or endpoints they may currently message,
   revoke membership and set posting permission; they cannot delegate management
   or edit endpoint allowlists/grants. An invite names one soul or principal;
   only that authenticated endpoint can inspect/accept its pending invite,
   including channel ID/name, posting permission and expiry, without a roster.
   Acceptance requires a currently joined/approved soul or approved principal
   with subscribe capability. An invite
   defaults to no posting permission until a manager grants it. Invitations
   expire after seven days; subscribing without an invite is refused. Subscribers
   may unsubscribe while authenticated even after subscribe capability is revoked.
   Invitations and new subscriptions grant no history. Creators must subscribe explicitly too. Principal capabilities are
   separate create, manage, subscribe, post and census operations, scoped to
   explicit channel IDs (create is local-broker scoped and includes management
   of channels it creates; this live derived grant satisfies manager eligibility).
   Existing messaging grants imply none of them.
   Revocation disables the corresponding operation, including derived management.
   Manager mutation replies expose no membership-existence flags.
3. **Authorize the complete snapshot.** A new post requires a currently
   eligible sender with posting permission and, for a principal, post capability.
   It targets every subscribed endpoint at commit, including the sender's own
   subscribed inbox. Explicit self-subscription permits this self-copy only;
   ordinary direct self-send rules remain unchanged. Every other copy must pass
   current direct-message endpoint authorization, including receive allowlists,
   principal grants and the existing prohibition on principal-to-principal sends.
   A left/revoked endpoint, revoked subscription capability or newly disallowed
   recipient blocks the entire new post with a typed unavailable error exposing
   no recipient identity. The broker never silently skips a subscriber; its
   unsubscribe or manager removal is needed before later posts can proceed.
4. **Atomic copies, bounded retries.** Preflight every copy against message,
   retained-count/byte, unacknowledged and rate limits, then commit one durable
   fan-out event before success or waking. Any failed admission commits no
   copies and reserves no retry key. Each copy has its own message ID, mailbox
   order, receipt and retention; a post has a stable opaque post ID. Sender
   results reveal no recipient roster, hidden count or per-recipient wake state.
   Zero subscribers is an accepted empty snapshot with the same opaque outcome,
   no body/history and normal sender rate/dedupe charges.
   The sender namespace/key fingerprint binds authenticated sender identity,
   operation tag, canonical destination and complete content. Direct sends and
   posts share the key namespace; cross-operation key reuse conflicts.
   For seven days from acceptance, an identical retry returns the original
   outcome and never changes the stored membership snapshot; changed content or
   channel conflicts. Current sender authentication remains required, but later
   membership/policy changes do not redeliver or invalidate an accepted retry.
   At the exact deadline the key is reusable and may deliver again. Retry
   records survive restart/body expiry and share #122's sender budgets: 100,000
   entries/32 MiB, counting serialized snapshot and outcome. Protected capacity
   refuses new posts. Store fingerprints, endpoint/message IDs and outcomes,
   without another body archive. Checkpoints retain only per-mailbox body copies;
   their 30-day expiry, loss evidence and gap receipts follow #122 independently.
5. **Read, receipts and asides.** Inbox read/watch can filter by canonical
   channel ID through the same APIs for every harness. Examining nonmatching
   messages may advance a mailbox session cursor; it acknowledges nothing.
   Mailbox-level gaps remain visible and do not claim unrelated loss came from
   this channel. Message ack applies only to the caller's explicit copy IDs;
   gap ack remains separate. Reads/receipts produce no sender group-read report.
   A bound session that actually prints/injects channel copies follows
   [ADR-0008 Amendment 2](decisions/ADR-0008-daemon-vouching-and-the-wake-plane.md#amendment-2-delivered-asides-2026-10-06):
   report only those IDs under existing best-effort rules. API reads, JSON pipes,
   subscriptions and posts do not fabricate an aside-delivery report.
6. **Subscriber wake choice.** Subscribe defaults to no channel wake;
   the subscriber alone may opt in or change that choice. Existing per-soul
   coalescing/rate limits apply after durable delivery. Subscription cannot
   enable cold wake; the owner's existing per-soul setting still governs it.
   Principals have durable inboxes and no soul wake.
7. **Discovery stays filtered.** Channel census metadata is visible only to current
   subscribers/managers; principal census capability is additionally required.
   Each roster row must independently pass existing discovery authorization:
   soul callers see self and currently discoverable peers; principal callers
   see souls covered by their grant and their own principal row. Other principal
   identities stay hidden. Membership/management never expands discovery. Filter
   before counts, pages and cursors; omit hidden totals and use indistinguishable
   errors for inaccessible channels. Owner-local administration retains its
   existing authority. Unsubscribed nonmanagers lose channel discovery but retain
   access to their already delivered copies.
8. **Finite metadata admission, no implicit deletion.** Proposed defaults are
   1,024 lifetime channel records per broker, 64 per creator namespace (paired
   account for souls, principal ID otherwise), 100 combined pending-invite/
   subscriber slots per channel and 16 MiB serialized channel metadata per broker.
   Reject any metadata growth at an applicable cap; never evict a channel or
   subscription for capacity. Invite acceptance reuses its slot. Removal or
   invite expiry releases its slot, not the channel record or alias. Creator
   IDs and counts survive credential rotation, departure and revocation; no
   fresh namespace is minted by those events or manager transfer. Owner-configured finite overrides
   may raise/lower admission, without deleting existing data. No delete, rename,
   history clear or ownership garbage collection is authorized.
   Orphaned channels require explicit owner manager reassignment. These caps
   bound channel metadata, not every existing broker collection.

## Approval and consequences

The approved policy covers the address/alias rule; creator and manager eligibility;
invite consent/capabilities and self-copy exception; no history; wake default;
filtered discovery; seven-day retries; capacity refusal without eviction; and atomic
fan-out. A slow, full, left or newly unauthorized subscriber can stop the whole
channel until capacity clears or membership changes. This availability cost is
intentional in the proposed all-or-none contract. Admission/availability refusal
leaks aggregate pressure; repeated probes may infer it. No hidden-membership
non-inference guarantee is claimed. Permanent channel metadata
consumes finite slots until a separately approved lifecycle policy exists.

Wire names, encodings, indexes, checkpoint schema and exact byte-accounting
implementation and tuning these finite resource defaults are engineering
decisions within this policy, with versioned validation and tests. They cannot widen grants, add eviction or change retry
semantics. Repository review remains pending. Owner approval is not runtime evidence
or approval of cross-hub enrollment, multi-homing or relay.

## Conformance boundary

Tests must prove consent and capability revocation; self-copy versus forbidden
principal-to-principal delivery; no partial commit on full/invalid recipients;
retry snapshot stability through membership change, restart and exact-window
reuse; count/byte/metadata refusal without eviction; no independent body archive;
late subscription and unsubscribe behavior; filtered paging with independent
copy/gap ack; correct delivered-aside reporting; opt-in/coalesced wakes; hidden
roster rows excluded before counts/pages; and identical behavior across harnesses.
