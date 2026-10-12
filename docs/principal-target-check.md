# Principal target-grant query

`principal-target-check` narrows agent-bot's existing revision and cold-wake
principal checks. It queries current target grants; it is not a signed
decision receipt, presence proof or mutation relay. The separate [operation-grant administration](owner-operation-grants.md) is a
prerequisite; native custody, complete operation authorization, receipts and migration remain [#77](https://github.com/qwts/agent-comms/issues/77).

The raw broker protocol accepts `agentId` and principal authentication. A
successful response contains `{ principal, agentId, account }`. The broker
resolves the account from its soul record, including departed souls, and
requires that account's current approval and the principal's current grant.
A caller-supplied `account` refuses. A null grant is unrestricted; otherwise
the existing account, soul-ID or qualified-address matching applies.

Before a soul's first join, only an unrestricted or exact soul-ID grant passes,
returning `account: null`. Account/address grants cannot establish ownership
then. A known soul with a revoked account never takes this pre-join path.
`unauthorized-target` refuses without target details. Account, daemon and A2A
credentials cannot use the query. Mailbox receive rules do not authorize owner
administration.

The client binds the query to the command's immutable parsed soul ID, never
credential JSON, display text or the caller's OS account. It validates the
principal and target echoed by the broker before continuing. Older brokers
refuse the operation; targeted clients never downgrade to `health` or consent.
Other owner gates retain their existing behavior.

This is a check at request time, not a receipt binding a subsequent effect or
an atomic authorization/application transaction. Existing separate-account
and soul-marker safeguards remain required by agent-bot. See the
[principal API](principal-client.md) for ordinary messaging authority and custody.
