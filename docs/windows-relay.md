# Windows pipe relay build and provenance

The relay is a prebuilt .NET Framework executable with the Windows GUI
subsystem (`/target:winexe`), inherited binary stdio, and no GUI or console.
It opens the pipe with `TokenImpersonationLevel.Identification` before the
broker handshake. Either input EOF or pipe EOF ends the owned relay; the
JavaScript client still withholds credential-bearing bytes until broker proof.

PowerShell with `DETACHED_PROCESS` exits before running the script on the
pinned Windows tuple. Hidden PowerShell can connect, but the strict private-job
probe observes an extra executable. The new helper avoids the PowerShell host
and runtime C# compiler; it does not admit that extra process or weaken the
classifier. Historical negative runs remain attached to PR #267.

## Build a source checkout

On Windows, run `./scripts/build-windows-relay.ps1` before using the pipe client
or running native pipe tests. It uses the operating system's .NET Framework
compiler and writes an ignored executable and build manifest under `bin/windows`.
Compilation is an explicit build step, never an automatic runtime fallback.
The build requires a source commit from the checkout or release stamp.

The manifest binds the source commit, C# source digest, binary digest, and
Windows subsystem. Runtime checks those digests and the executable's actual PE
subsystem before starting the fixed bundled path. A missing, corrupted, stale,
or console-subsystem build fails closed with the existing process-error stage.
These are package-integrity checks, not a claim of Authenticode signing.

Custom spawn wrappers receive the same artifact verification by default.
In-memory test doubles must explicitly set `skipRelayVerificationForTests`;
that option is refused with the default real spawn function. Native probes
use verification, including when wrapping spawn to observe the relay.

## Release and acceptance

Windows CI builds the helper before native security tests and retains the
verified build as `windows-pipe-relay`. Release packaging downloads that
artifact from the exact successful main CI run, requires its source commit to
match the release SHA, and verifies source/binary digests before embedding it
in the checksummed archive. A source archive or npm package without a build
requires the explicit Windows build step.

The `relay-startup` diagnostic exercises production relay startup, exact
fixture/relay job membership, resource limits, EOF, natural exit, final empty
job, and owned-child closure, then checks native impersonation and queued-byte
guards. The PowerShell host comparison retains the detached-launch failure
separately. Hosted results do not establish installed owner-desktop acceptance
or the remaining compiler/capacity work under #164.

Legacy compiler controls remain tied to their original source hashes. The
current relay has no runtime compiler; those controls cannot silently claim
to validate this helper.

## Broker startup and delivery candidate

The `relay-candidate-startup` manual workflow task selects the reviewed
`ba75753e8e99e7c475baff9bfa139721276b5b06` runtime in a disposable standard-user
profile. The driver requires its fixed tree and canonical archive digest;
dispatch cannot supply another runtime revision. It explicitly builds the
helper from that verified archive before private-job startup and records
the source and binary digests. Build preparation is outside the measured job.

The driver captures the actual connector's fixed executable and arguments
through inert streams, with artifact verification enabled. The supervisor
then admits only that executable/argv, the fixture, and the existing diagnostic
writer; runtime compiler descendants are not admitted for this candidate.
It exercises Broker startup, pairing and approval, two agent joins, one
send/read/ack/empty-read cycle, natural shutdown, empty-job confirmation and
owned process/stdio cleanup under the existing bounded startup profile.

This is a separate functional candidate. The historical `candidate-*` tasks,
compiler digests, old/new comparison pins, classification guards, and
deadlines remain unchanged. A hosted pass does not establish owner-desktop,
installed-host, offered-rate capacity, or numeric overhead acceptance.
