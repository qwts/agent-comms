# Ephemeral mailbox wake trace context

Related to [#164](https://github.com/qwts/agent-comms/issues/164) and
[agent-bot #1027](https://github.com/qwts/agent-bot-identity/issues/1027).
The direct `send` request and principal SDK `send` accept optional `traceparent`.
After existing authentication and recipient authorization, the broker keeps
only the same exact lowercase version-00, 55-character, nonzero-ID format as
[launch](launch-trace-context.md). Invalid values silently omit context; existing
frame limits still apply. No normalization, baggage or tracestate is supported.
Context supplies correlation, never identity, rights or an instruction.

Only a live daemon `account-watch` event with `event: "wake"` may gain the
optional top-level field. Pending windows and account rate holds retain one
55-character candidate each, alongside their existing message IDs and timers.
Every contributing delivery must supply the identical valid context. Mixed,
missing or invalid contributors permanently omit context for that batch;
acknowledgment, expiry or filtering cannot restore a discarded candidate.
This conservative rule avoids assigning a multi-origin batch a false parent.

Trace context is separate from message objects, durable events, deduplication
fingerprints and stored outcomes. A retry returns its original outcome without
sending a new wake or replacing context. Catch-up and restart wakes have no
context. Channel posts and task-generated messages contribute no context and
therefore suppress a mixed batch's candidate. Wake-off subscriptions retain
existing behavior. The broker does not forward context to soul inbox watches,
full message events, read results, acknowledgments, wake reports, census or
receipts. It adds no prompt text, exporter, diagnostic payload or CLI flag.

The daemon independently validates this optional field and owns wake spans;
its integration is tracked in #1027. Older consumers may ignore it. A compatible
broker and daemon release plus connected acceptance are required before claiming
installed trace continuity. This change does not activate native host transport.

Socket integration tests cover homogeneous and mixed windows, invalid values,
account rate holds, retries, full-watch/read/receipt/journal exclusion, and
reconnect/restart catch-up. Existing launch grammar tests exercise the shared
parser without weakening launch authorization or changing its drop counter.
