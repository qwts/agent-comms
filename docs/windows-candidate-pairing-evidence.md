# Corrected-source startup returns, pairing remains unaccepted

The one authorized [candidate-startup run 38241975296](https://github.com/qwts/agent-comms/actions/runs/38241975296)
failed at signed tool `72ecf68f6968649d012b1f136fed636205eb6111`, after
[exact-head/native CI 38241762837](https://github.com/qwts/agent-comms/actions/runs/38241762837)
passed. This used the reviewed [finite startup guard](windows-candidate-startup-guard.md):
360-second parent request deadline and separate 420-second reporting cap, with
unchanged actual production connector/client limits. It does not replace the
[earlier startup deadline failure](windows-candidate-startup-evidence.md).
Related to [#164](https://github.com/qwts/agent-comms/issues/164); the issue remains open.

The failure is `production-startup` / `operation-failed`, with fixed code
`broker-unreachable`, last fixture phase `fixture-pair` and supervisor phase
`private-job-assigned`. The original timeline is:

| Fixed phase | Child elapsed milliseconds |
| --- | ---: |
| fixture-imports | 0 |
| fixture-broker-start | 66 |
| fixture-pair | 153506 |

Reaching `fixture-pair` establishes that the actual pinned `Broker.start()`
returned after 153.440 seconds in this run. The parent request ended after
186.717 seconds, before its 360-second watchdog. This is a real operation
refusal, not an outer diagnostic deadline. No completed run, approval, joins,
delivery, offered-rate stage or capacity comparison is reported.

The interval after the pair marker includes synchronous account/custody and
proof work before the connection request. The pinned pair implementation calls
currentUid, checkBrokerCustody, assertOwnedDir, brokerPin and creates a proof
file before opening the connection. Client open maps generic connector error
or close to `broker-unreachable`. The parent request lasted 186.717 seconds; the child pair marker at
153.506 seconds is independently anchored, so their difference is not an exact
pair or connector duration. This receipt does not distinguish a helper
startup refusal, pipe refusal, stream close or another underlying cause.

All eleven reported diagnostic tool hashes match the exact signed source after
Windows CRLF conversion. The unchanged hardcoded runtime pin is
`2d94b16a17f7d0a8625e6151e97fee844232aab1`, tree
`9c1719821d656e17eb04dc477cc9415e4697f12f`, archive SHA256
`d3465c40e5e11561f22f3aa720f74146aa70b2091dcd09c34c1c4046daea6853`.
Node remains the checksum-verified 24.21.0 tuple. Timing schema, monotonic phase
order and the closed profile match; no source, connector, authentication,
environment, policy or runtime pin was overridden.

Both owned terminals, both stdio closures, empty job and tool scratch removal
are confirmed, with zero tool cleanup errors and no direct forced-termination
flags. Job disposal can terminate members, so this does not establish natural
fixture exit. The bootstrap conservatively retained the profile/account/stage:
`removed: false`, with `capacity-tool-cleanup-unconfirmed` and
`test-profile-cleanup`. That retained failure policy is distinct from the
confirmed tool cleanup receipt. No automatic retry followed.

Original reports are retained byte-for-byte:

- [Acceptance](../tools/acceptance/evidence/2026-10-12-windows-connector/candidate-startup-38241975296/acceptance.json):
  `3bd1894714e40d61ab02b6f9ebdf48aeb56984ff92b231ce8d4bc69911afabe6`.
- [Capacity](../tools/acceptance/evidence/2026-10-12-windows-connector/candidate-startup-38241975296/capacity/capacity.json):
  `b5009a32362afe3385e63db5c9700460ad64ceb27acc1ae8e008e553f44af6a2`.
- [Failure](../tools/acceptance/evidence/2026-10-12-windows-connector/candidate-startup-38241975296/capacity/failure.json):
  `e94509c41621c8dfcac75295f8afd51582dfcf500b89c29b427b5acd504bbf5c`.
- Full log SHA256: `4386c31a8d2d54884f410462c320c8b4b6c13a86856d993ce26c5f3c1e75cb02`.

The [explicit fixed-source refresh](windows-candidate-stage-refresh.md) selects
reviewed connector-stage observability for a later separately authorized run;
it preserves this original failure and its source attribution.

Whole startup-plus-delivery, native Windows capacity and installed desktop/host
acceptance remain open. Older immutable comparison pins are not validated by
this candidate observation. Complete instrumentation/health taxonomy, optional
export with offline/opt-out/backpressure behavior, authorized host consumption,
inspectable local export and cross-process continuity/deduplication also retain
their separate acceptance requirements. No blanket budget acceptance or issue
closure is implied.
