# Identity-constrained principal approval

Private admin callers can bind approval to the exact fresh pairing identity:
`{ op: 'principal-approve-exact', code, expectedPrincipal }`, or
`admin principal-approve CODE --expected-principal PRINCIPAL_ID`. The broker
checks that this exact principal is still pending with that code before its
synchronous durable commit. Wrong, revoked, approved or absent identities
refuse without approving another match. Successful replies include the exact
`principal`, `account`, `state` and `grant`. This distinct operation requires `expectedPrincipal`; the CLI flag selects it.
Older brokers refuse the unknown operation before mutation rather than ignoring
an optional constraint. `principal-approve` rejects `expectedPrincipal` on new
brokers; callers must use the exact operation, not version preflight or a
post-approval identity check. The field is not an owner authority credential: this operation remains private-admin only.
Code-only callers retain the existing flow when exactly one pending principal
matches; colliding pending codes now refuse with `ambiguous-code` and no mutation.

