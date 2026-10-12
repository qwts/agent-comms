# Identity-constrained principal approval

Private admin callers can bind approval to the exact fresh pairing identity:
`{ op: 'principal-approve', code, expectedPrincipal }`, or
`admin principal-approve CODE --expected-principal PRINCIPAL_ID`. The broker
checks that this exact principal is still pending with that code before its
synchronous durable commit. Wrong, revoked, approved or absent identities
refuse without approving another match. Successful replies include the exact
`principal`, `account`, `state` and `grant`. The optional field is not an owner
authority credential: this operation remains private-admin only.
Code-only callers retain the existing flow when exactly one pending principal
matches; colliding pending codes now refuse with `ambiguous-code` and no mutation.

