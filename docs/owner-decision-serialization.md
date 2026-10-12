# Owner decisions: proposed canonical serialization

This encoding is part of the proposed [receipt contract](owner-decisions.md)
and [wire schemas](owner-decision-wire.md), subject to joint comms/bot/native
review. It changes no existing p1 encoding or verifier semantics. The
[shared fixture specification](owner-decision-fixtures.md) records byte examples.

Action and decoded `d1` receipt payloads use canonical UTF-8 JSON, without
BOM or whitespace outside strings:

- Object keys must be the ASCII field names allowed by the applicable schema,
  sorted recursively by unsigned ASCII bytes. Reject duplicate, unknown and
  non-ASCII keys. Arrays preserve order;
  booleans and null use their JSON literals.
- Numbers are integers in `[-9007199254740991, 9007199254740991]`, written in
  decimal with an optional minus followed by digits. Zero is `0`; reject
  negative zero, leading zeros, plus signs, decimal points and exponent forms.
- Strings contain Unicode scalar values; reject invalid UTF-8 and unpaired
  surrogates. The following code spans show actual JSON bytes, not a string
  literal containing another encoding. Escape quotation mark and backslash as
  `\"` and `\\`, and U+0008/0009/000A/000C/000D as
  `\b`/`\t`/`\n`/`\f`/`\r`. Escape other U+0000–001F values as
  lowercase `\u00xx`. Emit all other characters as
  their UTF-8 bytes, including `/` and non-ASCII characters. Do not normalize
  Unicode or allow alternative escapes for those characters.

Only bounded strings, objects, arrays, booleans, null and these integers are
permitted. Reject bytes differing from this canonical encoding; hash the
canonical action bytes with SHA-256.
