# Private synchronous owner observation composition

A private implementation candidate for [owner decisions](owner-decisions.md)
and [#77](https://github.com/qwts/agent-comms/issues/77).


The disabled coordinator has a private native observation guard candidate.
Production construction, installed artifact provenance, receipt custody, and
readiness remain refused. This adds no daemon public contract or activation.
The source opener no longer constructs the lifetime-locked JavaScript enrollment
store. That store remains available for explicit enrollment/storage fixtures.
The installed source opener refuses until signed provenance is implemented.

A guard lazily acquires the fixed enrollment lock, without creating storage,
using nonblocking Darwin locking. Authentication, input shape, cheap grant
checks, and retained ownership lookup run before the first native scan. The
parent owns its original lock descriptor throughout the synchronous phase; the
observer inherits that open description as FD3. Helper exit or cleanup never
unlocks the parent. The fixed provider accepts only a normal observer; the
separate explicit fixture provider supplies synthetic bootstrap bytes and FD4.
Neither provider retains a lock between operations. Enrollment is acquired
before any overlapping admission journal lock.

Prepare retains the guard through admission and postflush selection before
sending. Prepared retains it through challenge persistence and fresh selection.
Confirm spends presence under a short initial guard, closes before every signer
await, and uses independent short guards for intermediate live checks. After
signer result and confirmed safe terminal closure, a fresh final guard covers
receipt verification, authorization persistence, postflush observation, grants,
watch binding, expiry, and the synchronous decision write. Daemon check retains
its guard through proof verification, durable release, postflush observation,
and the final `mayApply` decision. None of these callbacks may return a promise.

The observer launcher hashes bounded artifact bytes through a descriptor,
checks metadata before and after, and repeats that validation around every
launch. Normal launch has no arguments, empty stdin, an empty environment, and
only FD3. Its strict canonical v2 response is bounded to 24576 bytes, including
an existing projection of at most 16384 decoded bytes. Debug fixture v1 and
normal v2 have separate decoders; fixture absence of authenticated OD evidence
cannot activate the normal provider. There is no runtime compiler, PATH lookup,
key selector, signing API, or new npm runtime dependency.

The native watchdog retains its original eight-second deadline. The synchronous
launcher retains a ten-second elapsed deadline across artifact verification,
child execution, response verification, and decoding. It owns child termination
and pipe closure before returning; an uninterruptible syscall can outlast a
requested timeout. A refused child, unknown terminal, or parent descriptor close poisons the
provider, and the original descriptor is never implicitly closed twice. A close
failure after a socket write cannot retract delivery and must not retry it.

The signing attempt retains its ten-second limit. Its monotonic deadline starts
after initial preparation and durable presence spending, before the first live
check, and is never reset by a scan or await. Explicit elapsed checks supplement
timers because synchronous scans can delay timer callbacks. Postflush failure
suppresses dispatch or positive apply permission while preserving durable spent
state. Release uncertainty records the existing indeterminate outcome. No
implicit effect retry or nonce refund is introduced.

Cooperative enrollment writes are excluded while a guard is held. Protected
ancestry and OD observations remain point-in-time checks; external mapping or
root changes after the last observation are not atomic with persistence or
socket delivery. Broker grants, daemon approval/key/epoch, selected watch, and
principal scope remain independent authority checks.

Compiled observer acceptance uses the actual shared scanner and all 3072 final
source slots. The connected composition uses an explicit synthetic receipt
signer; it proves that no enrollment guard spans its signing or terminal awaits,
not installed signing custody. In a local run, prepare took 659 ms, prepared
592 ms, confirm 2713 ms, and check 612 ms with unchanged deadlines. These are
single-host observations, not performance guarantees or macOS 13 acceptance.
Negative cases cover postflush source corruption, lock replacement, durable
release uncertainty, deadline exhaustion, unknown close, malformed canonical
responses, and unsigned normal refusal. The existing compiled receipt fixture
has fixed synthetic source/head/observation bindings; translating a real
observer digest into those fixture bindings would not prove shared authority.
