# Owner decisions: staging transport options

This is a review input, not a selected protocol. The merged
[wire contract](owner-decision-wire.md) requires immutable target-daemon staging
and excludes webhook plaintext from the broker. The [source review](owner-decision-source-review.md)
finds no existing native cross-account staging transport. Full cross-account
webhook support remains required. No cipher suite, new key enrollment, IPC
service, wire operation or capacity profile is accepted or enabled here.

## Threat boundary and required binding

The native host may handle its owner's input and principal credential. The
target daemon may handle frozen webhook secrets. Webview/bridge JavaScript,
unrelated same-UID processes, other principals/targets, broker logs and broker
storage must not receive webhook plaintext or principal/presence private keys.
The broker remains the current-authority decision maker. Separate two claims:
excluding plaintext from an honest broker's routing/storage, and confidentiality
against a compromised broker that substitutes destination keys. The second
requires authentication independent of that broker; encryption alone cannot
provide it. Joint review must settle the intended claim explicitly.

Every option must bind installation/namespace, authenticated principal, canonical
target account and soul, permitted operation, upload ID, selected watch and
daemon pairing epoch. Bind descriptor expiry, size/count limits and immutable
snapshot digest. Stage creation must not apply settings or imply human approval
of a later effect. Current target/operation authority is checked at creation and
again by the existing preparation/release rules. Principal secrets never become
daemon credentials. Only preparation binds the finished stage to its one
request ID; upload IDs and request IDs are different namespaces.

## Concrete alternatives

| Option | Binding and custody | Cost and unresolved boundary |
| --- | --- | --- |
| Direct local native-to-target-account IPC | A signed native target helper validates the host's OS code identity and UID on every request. A broker-authorized bounded staging descriptor binds that peer, principal and target; daemon verifies it without receiving the principal secret. Host authenticates the helper's code identity and exact account/daemon pairing. | No payload encryption is needed across an authenticated OS-local channel, and plaintext bypasses broker. Requires a cross-UID service, installation/bootstrap permissions, peer authorization, secure endpoint discovery and grant/revocation semantics. Current same-UID keyd sockets and Node HTTP route do not provide it. A new system helper or broader deployment authority cannot be assumed. |
| Broker opaque relay using RFC 9180 HPKE Auth | Native sender and daemon recipient use an established HPKE implementation. Separately enrolled KEM keys must be bound to the principal and target pairing; enrollment is not provided by p1/d1 or HPKE. | Preserves broker routing, but adds key distribution/custody, framed ciphertext buffering, ordered delivery, replay rejection and native/daemon implementation work. Auth mode authenticates a KEM key holder, not current grants. Broker-only recipient attestation does not defeat malicious key substitution. |
| Broker opaque relay using HPKE Base with separately authenticated setup | An authenticated native/daemon setup binds an ephemeral recipient KEM key and the exact upload context before encryption. Sender authorization must be enforced independently for the complete ciphertext stream. | Avoids a long-lived sender KEM key only if the setup and stream authenticator prove that sender/context binding. Broker authentication by itself is insufficient for the stronger compromised-broker claim. The additional authenticator and independent recipient trust require crypto review; this is not a shortcut to a chosen bespoke protocol. |

For either relay option, a lost stream or pairing/watch change invalidates the
upload rather than resuming cryptographic sequence state. A new upload gets new
context/randomness and remains subject to quotas. Never replay a completed
stage into another request. Metadata/length exposure and private snapshot
retention must be stated separately from payload secrecy.

## Standard APIs and deployment constraints

[RFC 9180](https://www.rfc-editor.org/rfc/rfc9180.html) defines Base, PSK, Auth
and AuthPSK, application `info` and per-message AAD. Auth proves possession of
a sender KEM key. HPKE does not supply application key enrollment, grant
authorization or general replay protection. Ordered multi-message contexts must
be discarded on unrecoverable loss. It does not define the application's wire
encoding. These properties constrain either relay option; they do not select
its identity or framing scheme.

[Node v24.21 crypto](https://nodejs.org/download/release/v24.21.0/docs/api/crypto.html)
provides DH, HKDF, AEAD and DHKEM encapsulate/decapsulate; the latter arrived in
24.7. The documented API does not expose complete HPKE Auth setup/key scheduling.
Bot supports Node 20+, so a 24.7-only API cannot become an implicit baseline.
Zero npm runtime dependencies is compatible with a native backend or a separately
reviewed standards implementation, but primitives alone are not such evidence.
The local shell is Node 26.11.1, not the host's pinned Node 24.21.0; its feature
probe is not bundled-runtime acceptance.

[Apple CryptoKit HPKE](https://developer.apple.com/documentation/cryptokit/hpke)
offers sender/recipient and authenticated modes. Apple's documentation metadata
marks it macOS 14+, while the host declares macOS 13.0. Using it alone would
change the supported minimum. [Apple's XPC peer requirement API](https://developer.apple.com/documentation/xpc/xpc_connection_set_peer_code_signing_requirement(_:_:))
is available from macOS 12, but API availability does not prove cross-account
service reachability or installation rights.

[OpenSSL's HPKE API](https://docs.openssl.org/3.5/man3/OSSL_HPKE_CTX_new/)
implements RFC 9180 including Auth and was added in 3.2; Node's linked OpenSSL
does not make that C API a JavaScript API. A pinned native OpenSSL adapter or an
existing [Rust HPKE implementation](https://github.com/rozbb/rust-hpke) are
candidates for evaluation, not approved dependencies. Current host/keyd Cargo
manifests contain no HPKE implementation. Existing Ed25519 receipt/presence
keys must not be silently converted to KEM keys or reused as encryption keys.

## Bounded recommendation and next slice

Evaluate a pinned Rust RFC 9180 backend first, with `rust-hpke` as the initial
candidate, rather than implementing the full construction in Node. Its project
documents Auth support, RFC known-answer tests and selectable features. It also
states that it has no paid audit; a historical review of version 0.8 is not an
audit of a new pin or this embedding. Confirm current published source, lockfile,
feature graph, license, minimum Rust version and security advisories before
selecting it. Existing host/keyd manifests already use Rust dependencies; bot's
zero npm rule does not authorize adding one to its Node runtime. Native backend
ownership and packaging in both host and target daemon require explicit review.

The initial evaluation source is tagged v0.14.0 at
`9c2e9bbda684414c3d6c760838b46adf48c71ee5`;
its [pinned manifest](https://github.com/rozbb/rust-hpke/blob/9c2e9bbda684414c3d6c760838b46adf48c71ee5/Cargo.toml)
requires Rust 1.85, within the host helper's pinned 1.96.1 toolchain. Verify
the published crate checksum before adding a dependency. Limit evaluation to
classical RFC suites with explicit features and defaults disabled; its defaults
also enable post-quantum algorithms outside this proposal. This is a test
candidate pin, not dependency acceptance or a production suite selection.

The next implementable slice is an isolated test-only native evaluation: RFC
vectors for Base and Auth, two independent implementations interoperating,
tamper/order/context-loss tests, and macOS 13 build/deployment evidence. Use
synthetic keys only. It must expose no production RPC, credential load, keychain
item, enrollment or runtime capability. Select the production mode and exact
upload framing after that evidence and independent crypto review. Keep direct
IPC as the alternative if its cross-UID service can be established without
unapproved installation authority; do not develop both production transports.

ADR-0077 section 4 explicitly approves receipt and presence key enrollment. It
does not name a daemon staging KEM key, reciprocal host KEM key or independent
native-host pin of the daemon. Treat the additional custody/enrollment burden
as unresolved, rather than infer approval from the general use of separate keys.
Concrete owner decision for a relay design: approve owner-local enrollment and
native pinning of a distinct daemon staging public key for each installation and
target account, with explicit fingerprint verification, audited replacement and
invalidation of pending uploads on change. If Auth is selected, also approve a
separate native sender KEM key bound to that principal. Neither key grants an
owner operation or changes receipt/presence keys. Private-key storage, recovery
and removal behavior must accompany that decision before production setup.

## Review prerequisite

Root and bot/native-host owners must review the threat claim, transport,
independent identity/key binding, platform baseline and dependency ownership
before an exact upload schema is frozen. Crypto review must cover RFC vectors,
cross-implementation interoperability, key substitution, unknown-key/target
misbinding, downgrade, truncated/reordered/duplicate streams, context loss,
key erasure and failure-message leakage. Native IPC additionally needs real
allowed-host/denied-Node/denied-security and cross-UID endpoint evidence. Then
derive frame/count limits and durable reservation arithmetic together with
effect evidence. No production codec or runtime capability is justified by this
options document.
