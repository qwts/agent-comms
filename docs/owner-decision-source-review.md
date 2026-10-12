# Owner decisions: companion source review

This bounded review informs proposed companion contracts for #77. It does not
complete joint native-host/bot review or enable any owner operation. R1–R4 and
the accepted policy remain unchanged. The merged contract is comms
`e8fe09cb932d6c42295a78f595384fae11abc5a8`.

## Source pins and method

Bot main is `2483898e40badb2b5e6c58f473b55a2bac5d57e4`; host main is
`43d40597ada19bbcab35708db5b29907d0f8ad97`. GitHub commit comparisons identified
changed paths before current source was read. Host bridge, entitlements and native
helper paths are unchanged from local `fe4eb5259b44c20bba6c1e1863bda93003e2ec6b`;
no bundled runtime was cloned. Current host `components.json` pins comms
v0.4.3 at `ec5f8031335734aaffb96d1120ad2795ef65d7db` and bot v0.10.64 at
`abe0426074d8d7ecfd747454139c945827dfa376`. Host native helper remains its
separate v0.10.62 snapshot, `19d7dfaa72cbbb259a988c55c65ac75c3425f3d0`, plus
the documented atomic first-use seed correction.

Source references below are relative to those pinned bot/host repositories.
They identify implementation seams, not newly discovered authorization bypasses
in the existing local consent path.

## Concrete gaps

| Source | Consequence for the proposed adapter |
| --- | --- |
| Bot `soul-revisions.mjs:64–72` publishes history using a temporary file and exclusive link, without fsync or a request binding. `:180–188` appends before applying files; `:250–264` publishes them individually. | Existing history/audit alone cannot prove a broker request durably completed. Define request-linked effect intent/completion records and file/directory flush boundaries. A crash before proven completion remains indeterminate even when desired bytes are present. |
| Bot `soul-revisions.mjs:189–195`, `agent-identity.mjs:358–367` release the revision lock before an awaited append callback. | Edit without apply needs a shared synchronous final mutation adapter. Do not await under `withLock` or nest public functions that acquire the same lock. |
| Bot `cold-wake-settings.mjs:50–61` replaces settings then removes a webhook outside that lock; `:113–115` saves webhook then changes its setting. `wake-webhook.mjs:50–55` uses a separate secret lock; `:71–72` deletes without it. | Define fixed locking across all existing local writers, exact prepared expected state, and durable phases across settings and secret files. Partial publication cannot become applied merely because one file matches. |
| Bot `soul-package.mjs:296–333` offers bounded reads; current revision callers omit limits. `:335–409` performs two inventory passes; `:420–438` hashes canonical inventory. | Upload limits must bound transport bytes, paths, entries, depth and validation reads separately. Preserve bot's normalization, generated-file filtering, package formats and canonical digest. An archive digest is insufficient. |
| Bot `soul-revisions.mjs:359` rejects a pending proposal without checking its head. | The new final adapter must enforce the contract's immutable expected revision for reject as well as approve. Existing local behavior is not silently changed by this proposal. |
| Bot current `agent-daemon.mjs:828–855` uses existing principal/local-path revision routes. `comms-client.mjs:816–828` accepts ordinary ready events and handles launch/wake. | These are not owner-decision/staging schemas. Add strict selected-watch/epoch validation without launch recovery or automatic mutation replay. No generic auth callback or caller path becomes a staging adapter. |
| Host `bridge/bridge.mjs:104–108` uses the credential-backed JS client; `src-tauri/Entitlements.plist` has no data-protection access group. Bot `owner-presence.mjs:340–363` discards raw p1. | Native principal custody, typed transport and a raw assertion adapter remain prerequisites. The released ordinary transport factory alone does not satisfy them. |
| Host `src-tauri/src/bridge.rs:7020–7085` tracks mutable local staging paths in memory with a 24-hour window; `:7358–7372` trims reasons and limits them to 200 characters. | Keep this supported local ceremony. A separate typed broker path needs daemon-owned immutable 180-second staging and byte-preserving reason validation; it cannot reuse this staging record or silently trim signed input. |
| Host `keyd/src/server.rs:722–733` accepts only same-UID peers. `keyd/UPSTREAM.md:14` still describes the JS pin as matching the .62 native snapshot. | Direct cross-account native IPC is new work. Keep native/JS pins separate and correct provenance in a host-owned PR; no custody claim follows from a JS update. |

## Next review sequence

First review the [staging transport options](owner-decision-staging-options.md),
including peer/key binding and the broker threat boundary. Only then specify
upload frames and complete webhook transport; no unsupported-webhook substitute
shrinks scope. In parallel, review constant-size effect evidence and the exact
crash/reconciliation matrix, then derive finite journal reservations from the
maximum encoded records and transitions. Numeric limits must reserve every
accepted ID through terminal status and read-only reconciliation without
evicting IDs or unsettled evidence. Native custody/cutover and live negative
tests remain independent gates before runtime enabling.
