# Synthetic RFC 9180 backend evaluation (not a production protocol)

The evaluated backend is `hpke = 0.14.0`, source tag
`9c2e9bbda684414c3d6c760838b46adf48c71ee5`, independently downloaded crate SHA-256
`dd5130e119706b4d8c2180da6126f7e60b6c38c2d340d539219f57051f0a7af7`.
Default features are disabled; only alloc/getrandom/x25519/chacha are selected.
Cargo.lock pins 46 registry dependencies; every local archive was hashed against
its lockfile checksum (artifacts/dependency-checksums.json). Checksum integrity
is not an audit of the dependencies. Cargo reports 0.14.1 now available; this
test intentionally retains its reviewed exact 0.14.0 input and claims no audit
or latest-version endorsement.

Commands: `node verify-inputs.mjs`,
`MACOSX_DEPLOYMENT_TARGET=13.0 cargo +1.96.1 run --locked --offline`,
`swiftc interop.swift -o interop-apple && ./interop-apple`, then
`MACOSX_DEPLOYMENT_TARGET=13.0 cargo +1.96.1 run --locked --offline -- apple`.
The official CFRG RFC vector snapshot shipped with the crate is
`origrfc-5f503c5.json` (upstream commit
5f503c564da00b0687b3de75f1dfbdfc4079ad31). An independent download at that pin
matches the crate file byte-for-byte, SHA-256
`61fc662f01996cd06d713dacf5e133167bd309a1f329442d53f1e21a47b3ede6`.
Auth mode 2, KEM 0x0020,
KDF 0x0001, AEAD 0x0003 passes 257 sequential decryption cases and 3 exporter
cases. Fresh synthetic Auth sender/recipient tests refuse wrong sender key,
info, AAD and ciphertext. Rust Auth sender -> Apple CryptoKit recipient and
Apple CryptoKit Auth sender -> Rust recipient both pass. No real identity,
credential, broker, owner-enrolled key or production dependency was used.

The Rust binary's LC_BUILD_VERSION is minos 13.0 (SDK 27.0); this is deployment
target evidence only. The tests ran on macOS 27, not an actual macOS 13 host.
Apple CryptoKit HPKE is macOS 14+, so it is only an independent interop oracle,
not the production backend for the host's macOS 13 baseline. Rust toolchain
1.97.1 and the existing keyd pin 1.96.1 both passed these commands. The crate
MSRV is 1.85; selected transitive dependencies declare up to 1.87. Actual
macOS 13 execution and signed release integration remain prerequisites. Node does not need an HPKE implementation or npm runtime
dependency; it must not handimplement the RFC key schedule.

The [proposed custody record](../../../../docs/owner-decision-staging-custody.md)
contains the complete two-key recommendation and remaining review prerequisites.
Run commands from this directory. `cargo fetch --locked` obtains the pinned
backend; set `CARGO_HTTP_MULTIPLEXING=false` if a local HTTP2 proxy prevents Cargo
index access. Interop artifacts contain fresh synthetic private keys and stay
ignored; do not enroll them or substitute real identities. Apple interop requires
macOS 14+ and Swift; the Rust vector test does not require CryptoKit.

Primary references: RFC9180 https://www.rfc-editor.org/rfc/rfc9180.html;
backend https://github.com/rozbb/rust-hpke/tree/9c2e9bbda684414c3d6c760838b46adf48c71ee5;
CFRG vectors https://github.com/cfrg/draft-irtf-cfrg-hpke/blob/5f503c564da00b0687b3de75f1dfbdfc4079ad31/test-vectors.json;
Apple https://developer.apple.com/documentation/cryptokit/hpke;
Apple Auth recipient https://developer.apple.com/documentation/cryptokit/hpke/recipient.
