# Explicit fixed-source refresh for local connector stage

Related to [#164](https://github.com/qwts/agent-comms/issues/164); the issue remains open.
The [retained full-startup pairing failure](windows-candidate-pairing-evidence.md)
reached Broker.start return but reported generic `broker-unreachable` at pair.
It did not expose the existing local connector stage. Parent and child clocks
are independently anchored, so their difference is not a pair or connector
duration. No cause, production startup-plus-delivery or capacity pass follows.

Reviewed source [#224](https://github.com/qwts/agent-comms/pull/224) merged as
`7d915c24b20d7d6d11001d488efcc9447f9fcfa5`; [merged-main CI 38244431951](https://github.com/qwts/agent-comms/actions/runs/38244431951)
passed. The exact signed reviewed head is
`cb50469ca0b6757c4ab860de582b9b140fc525a0`, tree
`34011276c3e651e6fd5bf7ba1e7c7f373053249e`. The fixed candidate approval and
manual workflow checkout now select that exact source. The Windows CRLF
`git archive` has 4,177,920 bytes and SHA256
`85991a457b19c0f7367ca7a1d7fabbeadd7acb3bf15828f37594a5669c185ef6`.
The tool refuses mismatched tree or archive before imports. No dispatch input
can select another runtime revision. Reproduction uses an existing exact Git
object, without checking in a giant archive:

```bash
git -c core.autocrlf=true archive --format=tar --output=/tmp/agent-comms-stage-candidate.tar cb50469ca0b6757c4ab860de582b9b140fc525a0
```

The reviewed production change preserves only a closed own-data connector stage
as nonenumerable local error metadata through generic wrapping. Public error
codes, wire JSON, pin/proof authentication and ten-second production connector
and client deadlines remain unchanged. Remote broker response fields cannot
inject a stage. The first result or error stays irrevocable before guarded
best-effort disposal; a swallowed disposal failure is not terminal proof.

The development fixture, correlated IPC classifier and failure retention use
the same `lib/platform/windows-pipe-stage.mjs` projector as production. They
select only its fixed primitive stage, never a getter, unknown value, exception
message, cause, path, command or arbitrary object. The candidate's extracted
projector bytes must match the tool's shared projector before imports; the
report adds `pipeStageSha256` beside the existing eleven tool hashes. The
Windows CRLF projector SHA256 is
`93d0ab05570c873359753ed1f5f52d948fea5b3975bd03bd08801ad3198d2d15`,
reproduced from two byte-identical archives and matching the tool module after
the same CRLF conversion. Real child/controller tests retain a fixed startup-timeout through channel close
and owned cleanup, while unknown/accessor metadata is omitted without replacing
the original fixed broker failure. These local stubs qualify mechanics only.

This explicit source refresh is separate from historical evidence. Every raw
report from the original `2d94b16a` archive remains unchanged, including the
storage/channel passes and both startup failures. The immutable old/new capacity
pins remain `25dfa8362401489503f704c7322ad1314b7e6ddb` and
`e648d71277da72fc50c70ebcbb94c3c8f53c7cf3`; this newer candidate is not a comparable
instrumentation-only delta. A later comparable-baseline reconciliation needs
independent review.

The actual one-candidate sequence remains Broker.start, pair/admin approval,
two joins, send/read/ack/empty and stop, with no offered-rate stages. Its trusted
finite watchdog/reporting profile stays 360/420 seconds; channel stays 180/240,
storage 90/120 and old/new controls retain their untimed ninety-second requests.
Node pins, sanitized environment, private job/memory/process/account guards,
cleanup deadlines and conservative failure retention remain unchanged. This is
nonguaranteed diagnostic headroom, not performance acceptance or an extrapolated
storage wall-time budget. Only exact reviewed-head native CI and separate
manual authorization can precede a new candidate-startup run. No rerun or
capacity qualification is implied by this source change.
