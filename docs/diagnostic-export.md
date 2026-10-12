# Inspect a selected local diagnostic capture

Related to [#164](https://github.com/qwts/agent-comms/issues/164) and the private
[local diagnostic profile](local-diagnostics.md). This explicit offline command
reconstructs approved records from a user-selected capture. It discovers no
logs, contacts no broker or daemon, reads no credentials, creates no diagnostic
files and uploads nothing. Existing OS file permissions control the selected
input. This is not an authenticated live-host consumption interface or permission
for a host to scrape harness logs.

```sh
agent-comms diagnostics export --input /tmp/comms-capture.jsonl
agent-comms diagnostics export --input - --from-unix-ms 1791763200000 --until-unix-ms 1791849600000
```

Input is required explicitly. `-` reads stdin; a named input must open as a
regular file. Named opens use nonblocking mode before the regular-file check,
so a FIFO cannot block waiting for its writer. The command does not change file
permissions, follow a log directory, tail, seek to recent records or change
broker retention. It returns one compact JSON artifact on stdout. Saving it by
shell redirection is a separate explicit operator action. There is no output
file option or persistent export configuration.

Time bounds are nonnegative safe Unix millisecond integers: `from` is inclusive,
`until` exclusive. Omitted bounds are open; when both are supplied, `from` must
precede `until`. Each complete valid record is filtered independently, so an
out-of-order clock does not terminate inspection. The scan starts at the input
beginning and stops at its first resource limit. A selected time range does not
guarantee that the relevant part of a larger capture was reached.

## What the artifact means

The artifact has schema `agent-comms.diagnostic-export`, version `v: 1`, the
exporter's own running build provenance, export wall time, source kind,
requested time bounds, observed minimum/maximum accepted timestamps, limits,
coverage counters and reconstructed `events`. Missing/invalid exporter package
metadata is `buildVersion: null`, `buildSource: unknown`. Source event versions
remain separate unverified claims. No input filename, path, raw hash, error
excerpt, hostname, account or supplied command text is stored.

`source.authenticity` is always `unverified`, and `diagnosticCompleteness` is
always `unknown`. A structurally valid record does not prove its source,
identity, permission or truth. EOF says only that this input stream ended;
supervisor capture gaps, failed writers, earlier losses, crash-tail loss and
missing components remain unknown. These records cannot replace delivery state,
security receipts, presence or task completion.

| Status | Meaning |
| --- | --- |
| `input-processed` | Input reached EOF without a processing limit or I/O failure; coverage still reports rejected, oversized and partial lines. |
| `limited` | A byte, line, record or output limit stopped the scan; only the inspected prefix is covered. |
| `input-failed` | Reading or input cleanup failed, or its deadline expired; already accepted evidence is retained and the command exits nonzero. |

Coverage records inspected bytes, complete lines, accepted records, rejected
lines, oversized lines, out-of-range records, exact duplicates, identity
collisions, an incomplete final line, EOF and finite limit/failure reasons.
Named files also compare size and modification/change timestamps internally
before and after reading. `sourceChanged: true` warns of an observed change;
false does not prove a coherent immutable snapshot or detect every mutation.
For stdin or unavailable comparison it is null. No inode, timestamp fingerprint
or path from that comparison enters the artifact.

Deduplication applies only to retained in-range records, keyed by component,
session ID and event ID. Exact reconstructed duplicates are omitted; a different
record with the same identity is counted as a collision and omitted, preserving
the first. It does not deduplicate separate host/engine incidents or establish
cross-process trace continuity. Accepted `diagnostics.dropped` records retain
their observed cumulative count. Counts are not summed across sessions or
captures, and absent drop reports do not prove no losses.

## Privacy and bounds

The exporter accepts only the current closed version-1 component/event/stage/
operation/code/outcome tuples, UUIDv4 local identifiers, bounded build provenance,
nonnegative safe integer measurements and exact per-event primitive details.
It rejects unsupported fields, schema versions, invalid combinations and
malformed data, then builds a fresh object. It never copies arbitrary source
JSON, paths, messages, bodies, prompts, tools, Error properties, context, links,
baggage or tracestate. Mixed supervisor text is counted without retaining it.
This structural allowlist does not authenticate allowed IDs or build strings.

Fixed limits cannot be raised with CLI flags:

| Resource | Limit |
| --- | --- |
| Input bytes inspected by the parser | 1 MiB |
| Complete lines examined | 4096 |
| Retained records and identity-map entries | 512 |
| One complete input line, including LF | 512 bytes |
| Serialized artifact, including metadata | 320 KiB |
| Reserved metadata allowance | 8 KiB |
| Each parser read | 4096 bytes |
| Node-owned stdin high-water mark | At most 64 KiB |
| Input open/read/cleanup phase | 5 seconds |
| Output phase | 2 seconds, plus at most 2 seconds for supervised cleanup |

`inputBytes` counts the prefix inspected by the parser. Node can prefetch input
beyond that prefix before the stream is disposed, including when a record limit
stops processing partway through a chunk. Named-file reads use a 4096-byte
high-water mark; stdin uses the bounded Node-owned high-water mark above. The
byte cap describes inspected coverage, not an exact count of bytes fetched by
the operating system or proof that the source was read only through that offset.

The parser retains one 512-byte line buffer. Oversized lines discard bytes until
LF without growing a string or buffer, still charging the global byte and line
limits. Huge whitespace and malformed JSON cannot bypass those limits. UTF-8 is
decoded strictly only after a complete bounded line; a trailing partial line or
UTF-8 sequence is counted and never exported as a record. Counters saturate at
`Number.MAX_SAFE_INTEGER`. Artifact assembly stays within record/serialized-byte
bounds and verifies the final size before writing.

Stdin uses Node-owned stream reads, not a blocking filesystem read on a pipe.
Its owned stream is disposed on completion/limit/error/deadline, including when
another process keeps the writer open. Named-file stream close and descriptor
cleanup share the input deadline. The one-shot CLI exits after output completion
or refusal, so pending input I/O cannot extend its process lifetime indefinitely.

Stdout can use synchronous OS writes. The command therefore owns one unblocked
supervisor and one writer, with one bounded artifact IPC message, minimal helper
environments, no preload hooks and no respawn. Only the writer touches stdout.
The supervisor's deadline, cancellation or CLI disconnect kills its writer and
waits for actual child close. Success requires writer acknowledgment, successful
exit and close, followed by supervisor acknowledgment and successful close.
The CLI does not append another JSON document after a partial output failure.
Output failures use fixed stderr codes without source text or paths. If cleanup
cannot be confirmed, the command fails and makes no all-processes-gone claim.
Simultaneous abrupt loss of both CLI and supervisor while the writer is blocked
is not covered by that parent-loss guarantee.

Open/argument refusals return the existing CLI error envelope with fixed safe
messages. A partial `input-failed` artifact exits 1. A resource-limited artifact
exits 0 with explicit coverage. An output failure can leave an incomplete
artifact; consumers must require complete JSON and a successful output receipt.

## Defaults and acceptance scope

Export runs only when explicitly invoked, including offline. It adds no network
route, collector, SDK dependency, background capture, disk rotation or implicit
upload. Existing local stderr diagnostics remain enabled by default; the
[producer opt-out](diagnostic-opt-out.md) disables new built-in
observations without preventing an explicit export of an existing capture.
Optional OTLP configuration/consent acceptance remains open; absence of this
command proves only that this export was not requested.

Portable tests cover strict reconstruction, real producer records, time edges,
privacy canaries, bounded parsing, duplicate/collision scope and partial input
faults. Real CLI tests cover file/stdin operation without credentials or network,
nonblocking FIFO refusal on POSIX, idle stdin, unread output and CLI parent loss
with owned helper exit checks. Source mutation is reported without snapshot
claims. Installed Windows and packaged-host acceptance require their own exact
platform evidence. This slice does not establish numeric overhead, live host
consumption, OTLP delivery, cross-process trace continuity or complete #164
acceptance.
