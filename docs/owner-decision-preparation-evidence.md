# Owner decisions: proposed preparation evidence

This defines the typed expected state retained with the daemon challenge, as part of [effect evidence](owner-decision-effect-evidence.md). It is proposed, disabled and subject to joint review; no runtime conformance is claimed. Common primitives and exact-object rules are defined by that companion.

## Preparation

Exact common shape:
`{v:1,kind:"preparation",requestId,principal,account,soul,operation,payloadDigest,effectId,actionDigest,nonce,acceptedAt,preparedAt,exp,daemonKey,daemonEpoch,watchId,stage,expected}`.

`effectId` is a daemon-generated UUIDv4 allocated and durably fixed with preparation, never chosen by the principal or regenerated on retry.

`stage` is null or exactly `{stagingId,kind,contentDigest,expiresAt}`; kind is `package|webhook`, digest is packageDigest/configurationDigest respectively. It is derived from the daemon-owned immutable descriptor, not arbitrary caller fields. Preparation must hold and compare its authenticated original action and stage namespace separately; this compact record is not a substitute for them.

Revision `expected` is exactly `{kind:"revision",head,proposal,destination}`:

- `head`: null only for adopt; otherwise `{seq,revision}` from the last authoritative revision event.
- `proposal`: null except approve/reject; then `{proposalId,seq,revision,parentRevision}`. The exact proposal record must still be pending, with this base/current head at final entry. Full legacy diff/reason fields are not copied into this evidence; bounded reads validate the immutable stored package and the listed proposal fields.
- `destination`: null except edit with apply=true; then `{rootDigest,beforeInventoryDigest}`. rootDigest hashes a typed local descriptor of the census-selected absolute destination + device/inode identity, and beforeInventoryDigest hashes the bounded preflight inventory including modes/exact bytes. That descriptor and bounded inventory stay in daemon-private staging, not in the broker. No caller path is accepted. This detects relocation/local edits between prepare and final entry. The future final writer rechecks symlink/path constraints and every prepared immutable value under its existing revision lock. For a staged edit, manifest parentRevision must equal signed expectedRevision and stored inventory revision must equal sha256:packageDigest. Current local snapshot rewrites parentRevision before hashing; the broker adapter must preserve the validated parent or refuse, never silently change the signed digest. Existing local behavior is unchanged.

Cold-wake `expected` is exactly `{kind:"cold-wake",setting,webhookDigest,resume}`:

- `setting` is one of `{mode:"off"}`, `{mode:"on"}`, `{mode:"resume",policy:"read-only"|"workspace"}`, `{mode:"webhook"}` using existing wakeSetting normalization. Malformed stored bytes refuse; they are not silently normalized to a prepared off state. Missing/false settings normalize to off.
- `webhookDigest` is null only when no webhook is stored; otherwise configurationDigest of the normalized `{key,url,v:1}` snapshot. Bind an existing stored webhook even when the setting is off, because non-webhook application removes it.
- `resume` is null unless current or desired setting is resume; otherwise `{harness,sessionDigest,toolHomeDigest,destinationDigest}`. harness is one of the existing supported resume harness names (`codex|opencode|devin|grok`). sessionDigest is null when no current recorded session, otherwise SHA-256 of canonical `{harness,policy,sessionId,store,v:1}` after existing normalization (store host/soul, absent legacy store=host; policy absent=null, otherwise existing read-only/workspace). The raw sessionId stays private and must have an explicit adapter input bound (proposed 4096 UTF-8 bytes; refuse overlong, never truncate). toolHomeDigest and destinationDigest bind the actual routed store/worktree selection; typed local descriptors stay in private staging. This is the soul's recorded resume identity, not arbitrary session selection or new session authority. Recompare all four values at final entry.

A preparation record is at most 4096 canonical UTF-8 bytes (with conservative margin for exact identifiers/digests). Native/broker frame bounds and max action display remain separate. Private destination/inventory descriptors use the package stage budgets; bounded reads/path count/depth/size remain prerequisites.

Private digest preimages and quotas are exactly [the local descriptor contract](owner-decision-private-descriptors.md); final entry uses [the shared lock order](owner-decision-locking.md).
