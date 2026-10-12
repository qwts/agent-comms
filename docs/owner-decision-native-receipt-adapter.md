# Native receipt process adapter

This disabled source connects the reviewed operation-specific command to an
actual compiled native worker in explicit synthetic tests. It does not construct
a production signing capability or change broker readiness. Installed native
provenance, protected public observation, receipt custody, and physical journal
support remain prerequisites for activation.

`lib/platform/owner-receipt-wire.mjs` snapshots exact own data fields, bounds the
canonical command to 131072 bytes, preserves the complete ASCII p1 token, and
accepts only an exact canonical response of at most 1024 bytes. The response must
match the intended request ID and broker enrollment head and encode exactly 64
signature bytes. Cryptographic verification and final authority checks remain
in the issuer/coordinator; framing alone is not authority.

`createOwnerReceiptNativeFixtureInvoker` is deliberately fixture-only. Its
explicit path/hash checks protect disposable test artifacts from changes and do
not establish signed installation or key custody. It allocates independent
result and terminal promises before launch, charges queued and synchronous
verification time to one original elapsed deadline, uses fixed empty arguments
and environment with private pipes, and bounds output and error channels. Errors,
timeout, or abort reject the result but do not certify process termination. Only
actual process/stdio close produces the terminal receipt. The caller retains
capacity until that separate receipt. Synchronous OS calls cannot be preempted;
a late return refuses rather than receiving a new deadline allowance.

The compiled-worker integration uses the real pairing, watch, journal, issuer,
and coordinator with explicitly synthetic enrollment/public observations. All
eleven frozen commands are signed in native CryptoKit and verified independently
in JavaScript. Retry retains the exact stored receipt bytes and does not launch a
second worker, which matters because CryptoKit randomizes Ed25519 signatures.
Actual child cancellation, broker close, and grant revocation during native work
must leave no authorization or owner event, with owned terminal cleanup.

The unchanged bot-owned p1 verifier is checked against the shared thirty-case
public JSON fixture. Raw token aliases keep their exact receipt-binding digest;
their canonical nonce remains the replay identity. Native parser parity does not
normalize the signed payload or tighten inherited extra-field behavior.

The counterpart source is `native_receipt_worker.rs` in true-line/geniusbar,
sharing its reviewed fixed native enrollment reader. Its normal path verifies
the fixed broker-role root index, owner mapping, actual UID/GUID, complete source,
operation command, fixed System Keychain candidate, fresh source, and safe close.
No private seed is returned to JavaScript. This change has no production native
observation adapter, no runtime compiler fallback, and no route activation.

The next connected slice is a production adapter with protected artifact and
public observation provenance, fresh per-await checks, and independently owned
terminal closure. It must not hold a parent enrollment lock across a child await
or infer custody from an executable path/hash. Installed signed nonroot custody,
macOS 13 execution, ceremonies, physical readiness, and R1–R4 remain unaccepted.
