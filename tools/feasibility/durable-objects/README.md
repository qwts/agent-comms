# Local Durable Object storage feasibility probe

Opt-in, synthetic provider engineering evidence for agent-comms #28/#118/#119.
This separate private dev package pins Miniflare 4.20260730.0 and workerd
1.20260730.1 through its lockfile. It changes no root runtime dependency and is
excluded from the published component's `files` list. No deployment configuration,
remote binding, provider account, credential or production federation schema exists.

## Run

Use supported Node on macOS or Linux. Install this package separately:

```sh
cd tools/feasibility/durable-objects
npm ci --ignore-scripts --no-audit --no-fund
PROBE_REPORT=/tmp/agent-comms-do-probe.json npm test
```

Installation obtains public pinned dev dependencies; the probe then operates
locally. Miniflare binds `127.0.0.1` on an ephemeral port, rejects external
subrequests, and persists only within a newly created temporary directory.
Automatic `Request.cf` metadata fetching is explicitly disabled.
It disposes its own runtime and removes its own scratch in `finally`. No existing
broker, app state or service is opened or removed. No telemetry or deploy CLI is
invoked. Omit `PROBE_REPORT` for stdout-only evidence; choose a report path outside
production state.

## What can fail

The actual local SQLite DO implementation is exercised, not an in-memory storage
mock. Assertions cover rollback after body/outcome/counter writes; raced count
admission; independent body/outcome count and byte caps including exact-fit and
one-byte-over evidence; immutable accepted body/evidence after rejection;
duplicate/conflict results at full capacity; retry after an intentionally missing
post-commit response; and protected outcomes surviving body removal and a clean
local-runtime restart. Digests are supplied synthetic labels: this does not test
content authentication or a cryptographic retry binding.

A 512-body sample stores 4 KiB per body. Keyset pages return at most 32 records and
must read at most 64 rows, so a full-population scan fails. The report separates
payload bytes, serialized synthetic outcome bytes and SQLite database bytes. RSS
is the Node test runner only, **excluding workerd**, and is not the Worker memory
limit measurement. Record observed timings, not a performance SLA. The sample is
2 MiB, not the accepted 256 MiB/full-population capacity test.

## Evidence boundaries and next gates

The report includes pass/failure, completed cases and cleanup failure classes;
cleanup does not erase the primary assertion failure. A report-write failure
sets stdout `pass: false` with the fixed `probe-report-write-failed` class; a
subprocess regression also verifies that an earlier assertion remains primary.
Restart is orderly
Miniflare disposal/recreation with the same storage directory. No supported
public Miniflare API was used to abruptly terminate only its workerd child;
abrupt termination is exercised separately with `npm run test:crash`. That test
launches the pinned native workerd executable directly through its public `serve`
CLI and control descriptor, with one loopback socket and private SQLite disk
service. It confirms denied outbound fetches, abruptly sends `SIGKILL` only through
its owned ChildProcess handle, waits for that exact child exit, and starts a new
child against the same scratch. An unrelated sentinel survives. Original committed
body/evidence and body-removed outcomes survive; injected transaction writes stay
absent and retry results remain duplicate/conflict. Cleanup has finite exit waits
and retains scratch if the owned runtime cannot be confirmed stopped. Missing
binary and invalid-config regressions verify bounded cleanup and preserved startup
failures. Reports include Node/workerd versions and worker/test/lock hashes.

This is a local process-crash observation, not power-loss durability or Cloudflare
replication evidence. The pinned workerd schema explicitly marks `localDisk`
experimental; it is used only for this opt-in synthetic probe. No process scanning,
generic kills, inspector port or private Miniflare API is used.

This bounded slice does not test actual federation messages, crypto/codec,
revocation, expiry clocks, hibernation, alarms, PITR, cloud billing/replication,
regional failures or full accepted caps. Those remain in the
[federation acceptance plan](../../../docs/federation-acceptance-plan.md).
Independent crypto review still precedes production protocol implementation;
remote experiments need separate deployment/spending authorization.
