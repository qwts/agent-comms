# Proposed lossless plaintext codec lab

This dev-only reference does not adopt a federation wire profile. No HPKE,
network, enrollment, runtime dependency, or production serializer is included.
An independent Node implementation must use this contract and vectors, rather
than translate the Python implementation.

The sole object is definite, shortest-form CBOR
`[kind, body, refs, correlation, replyTo, depth]`. Kind matches
`[a-z][a-z0-9-]{0,31}`. Depth is an unsigned integer from zero through eight.
Refs has at most sixteen strings, each at most 256 UTF-16 code units.
Correlation and replyTo are null or strings of at most 128 code units.
Body has at most 32,768 bytes under JavaScript Buffer UTF-8 replacement
semantics: each unpaired surrogate costs three bytes; a valid pair costs four.
Reply provenance is outside this codec.

A string with no unpaired surrogate is CBOR UTF-8 text, including empty text.
Otherwise it is a nonempty array of maximal nonempty well-formed text runs
and unsigned surrogate code units (0xD800 through 0xDFFF). Adjacent text runs,
empty text runs, arrays without surrogate integers, and adjacent high/low
surrogate integers are rejected. A valid pair belongs in text. Low/high and
high/high integer sequences remain legal when both are unpaired. Text uses
strict UTF-8: surrogate encodings, overlong sequences and non-scalars fail.
There is no Unicode normalization: composed and decomposed text differ.
Python scalar non-BMP characters and explicitly paired surrogate code units
represent the same JavaScript string and encode identically.

Only arrays, text, unsigned integers and the two optional nulls are admitted.
Reject tags, maps, booleans, negative integers, floats, indefinite lengths,
nonminimal headers, truncation and trailing bytes. Check declared lengths
before slicing or allocating. Reject input over 56,284 bytes before copying
or constructing a view. Bound a body run array to 16,384 elements, a ref run array to 256, and
an optional metadata run array to 128. Progressive UTF-16 unit and
native-byte checks are mandatory.

The proven aggregate bounds are 56,284 encoded bytes, 20,759 decoded nodes
including arrays and nulls, and three nested array containers. A scalar leaf
inside a ref run array has value depth four. These are distinct depth
conventions. See [the proof](../../../docs/federation-lossless-bound.md).
A decoder need not allocate a generic CBOR tree: parse the six-field grammar
directly. No transport claim follows from accepting an isolated plaintext.

`vectors.json` contains literal golden bytes and rejection vectors. JSON
strings denote UTF-16 units; preserve lone surrogates.

Run from the repository root:

```sh
python3 -m unittest discover -s tools/feasibility/lossless-plaintext
node --test tools/feasibility/lossless-plaintext/node-reference.test.mjs
python3 tools/feasibility/lossless-plaintext/interop.py
```

The Python and Node references were independently authored from this contract
and literal vectors before comparison. The black-box runner compares both
encode/decode directions for 4,700 deterministic messages, including all
length-one-through-four strings over eight Unicode classes, header boundaries,
and the attaining maximum witness. It checks 29 malformed byte inputs and four
invalid values. Output cardinalities are checked before comparison. A mismatch
writes `interop-mismatches.json` for diagnosis. Passing establishes agreement
on this corpus, not correctness on every input, a security audit, production
adoption, or independent cryptographic review. The references contain no crypto.
