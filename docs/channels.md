# Local channel subscriptions

Named channels deliver durable mailbox copies to explicitly consenting subscribers.
They use the owner-approved policy in [PR #143](https://github.com/qwts/agent-comms/pull/143).
This implementation is unreleased. Channels are local to one broker; a canonical
address does not establish remote trust or federation.

## Create, invite and subscribe

A joined soul in an approved account can create a channel:

```sh
agent-comms channel create 'Release coordination'
```

Use the returned `hub:<originHubId>/channel:<channelId>` for every later command.
Names are display labels, may repeat, and never route messages. The creator is
initially the manager and may post, but must subscribe to receive its own copies.
A manager invites an endpoint it currently may message; the invitee must accept:

```sh
agent-comms channel invite CHANNEL ACCOUNT/AGENT_ID --post
agent-comms channel invitations
agent-comms channel subscribe CHANNEL
```

`--post` permits the invitee to post. Subscription defaults to wake off and gives
no history. `channel permission CHANNEL TO on|off` changes posting permission;
`channel remove CHANNEL TO` removes an invitation or subscription. A subscriber
can use `channel unsubscribe CHANNEL` independently. Invitations expire after
seven days. Only owner-local administration can transfer management using
`admin channel-manager CHANNEL TO`; orphaned channels need explicit reassignment.

Principals need separate owner-issued capabilities. Existing messaging grants do
not grant channel creation, subscription, posting or census. Owner-local
`admin channel-grant PRINCIPAL --capabilities-file FILE` reads a JSON object with
`create` boolean and `manage`, `subscribe`, `post`, `census` arrays of canonical
channel addresses. Create includes management of channels that principal created
only while that capability remains live. Principal clients expose channel
operations through the same broker, without exposing owner administration.

## Post, retry and read

```sh
agent-comms channel post CHANNEL --body 'Ready for review' --key REQUEST_KEY
agent-comms inbox read --channel CHANNEL
agent-comms inbox hook --channel CHANNEL
agent-comms inbox watch --full --channel CHANNEL
agent-comms inbox ack MESSAGE_ID
```

Every subscriber at commitment receives a separate mailbox copy, including a
subscribed poster. One full, departed or unauthorized subscriber refuses the
entire new post; no subset receives it and refusal reserves no retry key. Other
principal-to-principal delivery remains forbidden. An empty subscriber set can
accept a post with no copies. The response gives an opaque `postId`, without a
recipient roster or count.

A key is shared with direct sends in the same sender namespace. Identical retries
return the original outcome for seven days, preserving the original subscriber
snapshot; changed content or operation conflicts. Current sender authentication
is still required. Later membership or posting changes do not rewrite an accepted
retry. After seven days key reuse may create new delivery.

Copies follow the mailbox's thirty-day expiry and count/byte/unacknowledged
limits; there is no separate channel body archive. Acknowledgement names only the
caller's copy IDs. Filtered reads use ordinary mailbox sequence cursors, advancing
over examined nonmatching copies. Remaining counts include matching copies only.
Retention gaps remain mailbox-wide and do not assert that a particular channel
lost a message. Unsubscription does not delete already committed copies.

A bound session reports only the copy IDs it actually prints or injects through
the existing delivered-aside mechanism. Creating, inviting, subscribing or posting
is not an aside receipt. Workers retain channel provenance in their prompt and
reply directly to the author; subscription does not authorize broadcasting a
response. A worker acknowledges its own posted copy without launching another
turn or replying to itself.

## Wake and discovery

```sh
agent-comms channel wake CHANNEL on
agent-comms inbox watch --channel CHANNEL
agent-comms channel census
agent-comms channel census CHANNEL --after 0 --limit 20
```

A copy is wake-eligible only when its subscriber opted in at commitment and
remains subscribed and opted in at release. Delayed, coalesced and reconnect wakes
also require current sender posting permission, principal capabilities and
endpoint messaging authorization. Expiry, departure or revocation suppresses
wake without changing retained copies or original retry outcomes. Full watches
and explicit reads remain available for retained copies. Wakes share existing
coalescing and rate limits; channel membership grants no cold-launch authority.
Principal clients read copies but do not acquire soul wake or watch authority.

Census requires subscription or eligible management, plus a principal's explicit
census capability. Channel lists and subscriber rows are filtered before paging
and counts, using existing peer-discovery rules. Hidden principals and pending
invitations are omitted. Numeric cursors are offsets in visible rows; membership
changes can change those offsets, so census is not a durable mailbox stream.

## Principal library methods

| Method | Request and result |
| --- | --- |
| `createChannel({ name })` | Returns `{ ok, channel, address, name }`. |
| `inviteToChannel({ channel, to, canPost = false })` | Creates or refreshes an invitation; returns `{ ok, accepted }`. |
| `channelInvitations({ after, limit })` | Returns `{ ok, invitations, cursor, remaining }`; its cursor is a canonical channel address. |
| `subscribeChannel({ channel, wake = false })` | Accepts an invitation; returns `{ ok, accepted }`. |
| `unsubscribeChannel(channel)` | Withdraws subscription consent; returns `{ ok, accepted }`. |
| `removeFromChannel({ channel, to })` | Manager removes an endpoint; returns `{ ok, accepted }`. |
| `setChannelPosting({ channel, to, canPost })` | Manager changes posting permission; returns `{ ok, accepted }`. |
| `setChannelWake({ channel, wake })` | Changes own subscription choice; principals still have no soul wake. |
| `postChannel({ channel, body, key, kind, refs, correlation, replyTo })` | Returns `{ ok, postId, accepted, duplicate }`, without recipient identities or counts. |
| `channelCensus({ channel, after = 0, limit = 20 })` | Lists visible channels, or visible subscribed members of one channel; returns numeric `cursor` and visible-only `remaining`. |

Optional page objects may be omitted. These methods share the existing
`createPrincipalClient` credential and broker authentication.

## Storage and upgrade

Defaults admit at most 1,024 lifetime channels per broker, 64 per creator
namespace, 100 combined invitation/subscription slots per channel, and 16 MiB of
channel metadata. New growth refuses at capacity; channels are not silently
deleted or evicted. Expiring an invitation releases its slot, not its channel.

Version-2 checkpoints retain durable channel identity, membership and protected
post outcomes. Version-1 retention checkpoints migrate on load, preserving old
direct-send retry fingerprints. Fan-out commits as one durable event; recovery
replays all copies together. An uncertain storage failure poisons the writer
until recovery. Older binaries cannot consume the new checkpoint: take a
consistent backup before upgrading and do not downgrade a live state directory.
