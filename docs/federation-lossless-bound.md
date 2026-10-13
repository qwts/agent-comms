# Federation: lossless run-array size and parser bounds

**Status:** Proposed encoding analysis, 2026-10-11; not production adoption.

Related to #28, #118 and #119; issues remain open. This corrects the nonmaximal
witnesses in the [native compatibility audit](federation-native-compatibility.md).
The [wire candidate](federation-wire-candidate.md) now incorporates this proposed
grammar; neither document approves a serializer, crypto or federation runtime.

## Exact assumptions

Preserve JavaScript UTF-16 code units without normalization. A well-formed string
uses CBOR text, including empty strings. An ill-formed string uses a definite
array of maximal nonempty well-formed text runs and unsigned integers for
**unpaired** surrogate code units. There are no empty or adjacent text runs;
a high/low pair must appear in a well-formed text run, not as two integers.
Integers representing other scalars are refused. All integers/lengths use
shortest CBOR encodings. This is a candidate encoding with development-only references, not a
production codec.

Native body budget is `Buffer.byteLength(s) <= 32768`. A BMP scalar costs one,
two or three UTF-8 bytes; a valid surrogate pair costs four; an unpaired
surrogate costs three replacement-character bytes. Refs have at most sixteen
strings of 256 UTF-16 units each; correlation/reply each allow 128 units. Kind
is at most 32 ASCII bytes; depth is an integer through eight. The six-field
plaintext shape is exactly the existing candidate's kind/body/refs/correlation/
reply/depth array. No endpoint/channel fields or wrappers are added.

Let `h(n)` be a CBOR length/integer header size: 1 byte for `n<24`, 2 for
`n<256`, 3 for `n<65536`, then 5 and 9. Surrogate integers always cost three
bytes. Array elements are counted across the decrypted plaintext tree,
separately from encrypted outer-envelope parsing.

## Body bound and attaining witness

For an ill-formed body, let `U` count unpaired surrogates, `R` nonempty valid
runs, `V` their combined UTF-8 bytes, and `S` the sum of their length headers.
Canonical runs imply `R <= U+1`; native bytes satisfy `3U+V <= B=32768`.
Encoded bytes are `3U+V+S+h(U+R)`.

Write `S=R+E`. Every header increment beyond its first byte requires at least
23 extra run bytes: a two-byte header needs length 24; a three-byte header
needs 256, more than enough for two increments. Therefore:

```text
V >= R + 23E
B >= 3U + V >= 4R - 3 + 23E
S = R + E <= floor((B+3)/4) = 8192
```

For `n=U+R` elements, the minimum native cost is at least
`2n-(n mod 2)`. Thus `n<=16384` at this budget and `h(n)<=3`.
The encoded body is at most **40,963 bytes**. The string
`("a" + unpaired high surrogate)` repeated 8,192 times attains it:
8,192 two-byte text elements, 8,192 three-byte surrogate integers and a
three-byte array header. The well-formed alternative is at most
`32768+h(32768)=32771`, below this bound. Empty text costs one byte; an
all-surrogate body is not maximal.

## UTF-16 metadata bounds

For a metadata string of at most `K` UTF-16 units, a valid run of `k` units
has at most `3k` UTF-8 bytes. A second header byte requires at least eight
units; a third requires at least 86. Each extra header byte therefore consumes
at least seven extra units beyond a one-unit run. With the same `R,U,E`:

```text
K >= U + R + 7E >= 2R - 1 + 7E
S = R + E <= floor((K+1)/2)
U + R <= K
encoded bytes <= 3K + floor((K+1)/2) + h(K)
```

For `K=256` and `K=128`, alternating a three-byte BMP character with an
unpaired high surrogate attains both inequalities. A ref is therefore at most
**899 bytes** (`768+128+3`); correlation/reply at most **450 bytes**
(`384+64+2`). Well-formed alternatives of 771/387 bytes are smaller. This
mixed-run overhead is what the earlier all-surrogate witness missed.

## Full shape, elements and finite caps

The maxima can coexist in one plaintext:

```text
1 array header + 34 kind + 40963 body + (1 + 16*899) refs
+ 450 correlation + 450 reply + 1 depth = 56284 bytes
```

A currently generated native parent ID is forty ASCII bytes, encoded in 42
bytes, reducing plaintext to **55,876**. The 56,284 bound conservatively retains
the payload validator's 128-unit reply allowance, including possible legacy
state; it is not a claim that a new arbitrary reply ID passes parent lookup.

Keeping the candidate's maximum 559-byte header gives total wire overhead of
679 bytes, hence **56,963** and **56,555** bytes respectively, below 65,536.
Actual 42-byte native soul IDs would shrink the header, but this calculation
retains the candidate's conservative allowance. Native escaped-page admission,
address authorization and reply provenance remain separate gates.

The maximum total array-element count is:

```text
6 + 16384 + 16 + 16*256 + 128 + 128 = 20758
```

Including the root gives **20,759 decoded nodes**, maximum depth **3**:
plaintext array → refs array → run array. With an actual reply ID the count
is 20,631 nodes. A body run array has at most 16,384 elements; each ref run
array at most 256, correlation/reply at most 128. Bounds must be checked before
allocation; this analysis is not evidence that an existing decoder enforces them.
Outer envelope/header/suite parsing is a separate tree, also at depth three.

At 56,963 bytes per retained envelope, the 256 MiB relay body cap permits at
most 4,712 such envelopes, the 32 MiB route cap 589, and the 64 MiB
local-per-relay cap 1,178, before additional charged custody metadata. Count and
byte caps both apply; nothing here authorizes eviction or higher caps. The
receipt/outcome evidence budget remains independent.

## Independent finite checker and validation scope

Run `python3 tools/feasibility/federation-lossless-bound.py`. It has fixed,
small DP populations and no runtime package dependency. The dynamic program
exhaustively merges equivalent states over five UTF-16 classes: one-, two- and
three-byte BMP units, high surrogates and low surrogates. A pending-high state
handles valid pairs versus replacement-byte lone surrogates; states track
native bytes, active-run bytes, completed run size/count and unpaired count.
This captures size-relevant distinctions without sampling concrete characters.

The checker verifies every structural state through twelve native body bytes
and eight UTF-16 units against the inequalities, plus attaining full-budget
witnesses and CBOR header thresholds at 23/24, 255/256 and 65535/65536. The
initial run visited 4,069 merged states and completed below one second. Small
DP is an independent check of the argument, not a replacement for its proof.

`node tools/feasibility/federation-native-budget.mjs` independently checks the
corrected structural maxima and retains the earlier explicitly nonmaximal
witnesses. Actual native payload/message-construction checks on the corrected
string pattern produce 76,832 escaped bytes, below 126,976. These checks do not
exercise authenticated send, parent existence, commit, parser interoperability
or crypto. Independent implementations and canonical rejection vectors remain
required before any production adoption.

## Fresh consistency checks versus retained evidence

The historical 4,069-state and 4,700-message results above describe the earlier
candidate. The consistency revision freshly passed six Node laboratory tests,
five Python tests, 4,700-message bidirectional agreement with 29 malformed
inputs/four invalid values, the finite bound checker and synthetic current
native validator witnesses. No authenticated send, parent lookup, provider
persistence or application crypto was tested.

`node --test tools/feasibility/lossless-plaintext/envelope-budget.test.mjs`
mechanically serializes the entire candidate header, envelope and both receipt
purposes. It checks 559-byte header, 56,963-byte maximum envelope, 56,555-byte
actual-reply scenario and 360/368-byte receipts. The accompanying arithmetic
checks 4,712/589/1,178 body slots and at most 91,180 largest receipts before
other metadata. These are structural bounds, not promised service capacity.
