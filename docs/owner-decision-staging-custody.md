# Owner decisions: proposed staging key custody

This complete policy proposal accompanies the [staging options](owner-decision-staging-options.md)
and [source review](owner-decision-source-review.md) for accepted ADR-0077. It
requires owner approval of the additive two-key enrollment/custody policy and
joint crypto/native review before production selection or runtime enablement.
R1–R4 remain in scope. The [synthetic backend evaluation](../tools/dev/owner-decision-hpke/README.md)
is interoperability evidence only; it freezes no production suite or framing.

Prefer a reviewed Rust RFC9180 backend in the signed native host and a typed
Rust daemon helper, with broker-opaque relay. Auth mode binds a separately
owner-enrolled native sender X25519 key and separately owner-enrolled daemon
recipient X25519 key. Do not convert/reuse Ed25519 p1/receipt/vouch keys.
HPKE Auth proves possession of the enrolled sender key, not code attestation,
owner presence, nonrepudiation or delivery/replay safety. Native signing
identity verification and owner-secret preparation are separate controls.
Retain direct authenticated local IPC as an alternative transport; current
same-UID keyd IPC does not authenticate cross-UID native peers and therefore
requires new signed-peer/audit-token plus bootstrap/access-control engineering.
Opaque relay keeps broker from learning webhook plaintext and supports the
existing cross-account broker path at the cost of new pins and ciphertext
admission/replay journaling.

The native sender private X25519 seed belongs in a dedicated Data Protection
Keychain item, `WhenUnlockedThisDeviceOnly`, restricted to the reviewed signed
native host access group/designated requirement. It is not Secure Enclave
X25519 custody. The signed Rust process loads it into bounded zeroizing memory
only for a typed owner-authenticated staging operation; JavaScript, shell,
Node, generic encrypt/export callbacks and unsigned security CLI cannot read
it or drive an arbitrary decryption/encryption oracle. Native webhook entry
must keep URL/key out of the JS bridge, argv and logs. Package staging uses a
native-selected immutable source, not caller paths.

The target daemon recipient private key may use the daemon's existing trust
boundary: an exclusively created regular no-symlink file under its owned 0700
state directory, 0600 with matching UID (equivalent reviewed SID custody when
supported), atomically and durably created by the typed Rust helper. The target
account already owns webhook plaintext and is explicitly trusted; this does
not claim signed-host exclusion against arbitrary processes in that target
account. If that stronger boundary is required, a separately authenticated
service/keychain deployment is a new policy/design choice. No generic secret
export/decrypt RPC exists; the helper opens only a bounded typed stage for the
fixed namespace, validates it, and installs the immutable daemon snapshot.

Owner enrollment pins both public key IDs independently of first broker
traffic. The native owner verifies the daemon fingerprint from its owner-local
installation/pairing source and the daemon verifies the native sender binding
from the owner-local enrollment action. Store account, installation, principal,
operation scope and epoch beside those pins. Existing broker Ed25519/presence
approval is not permission to silently adopt X25519 pins. Present this complete
additive two-key enrollment/custody proposal for owner review alongside the
concrete native-custody design; approval does not claim implementation.

Loss/corruption never regenerates an existing enrolled key silently: fail
closed, revoke the old staging binding and operation authority before replacement,
invalidate all old stages/pending requests, and explicitly owner-enroll fresh
keys. No broker backup, escrow, sync or private-key recovery. Same signed update
may retain the item/pin; changed signing identity or installation must re-enroll.
Removal first revokes grants/pins and drains/refuses in-flight work, then deletes
the native keychain item, daemon private-key file and settled secret stages,
zeroizes process-held copies, and retains nonsecret accepted-ID/effect tombstones.
Unknown effect outcomes retain private snapshots/quota until owner-local
reconciliation; deletion never becomes proof of no effect.

Before production selection, joint crypto review must cover current backend
source/dependency versions and Rust APIs, X25519 low-order/error handling,
CSPRNG failure, secret lifetime/zeroization, sender/recipient independent key
binding, Auth's recipient-forgery property, info/AAD canonical namespace and
lengths, ciphertext one-shot/replay rules, bounded framing/quota admission,
durable error/crash semantics, native designated requirement and keychain
negative tests, actual macOS 13 execution and full removal/recovery races.
Only after this review should a companion staging transport freeze suite,
header/framing/TTL schema and implementation. No production crypto is frozen.
