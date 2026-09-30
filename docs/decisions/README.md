# Architecture decisions (ADR series)

Durable records for decisions owned by this repository. A decision that
changes more than this repository is an ENG record in
[qwts-agent-sop](https://github.com/qwts/qwts-agent-sop/blob/main/docs/decisions/README.md),
and the ADR that depends on it links to it.

## Numbering

`ADR-NNNN`, zero-padded, taken from the originating issue number in this
repository, as ENG records do
([ENG-0035](https://github.com/qwts/qwts-agent-sop/blob/main/docs/decisions/ENG-0035-issue-derived-record-numbers.md)).
Numbers are therefore sparse.

## Format

Short: context, the decision, and consequences, including the ones you did
not like. Each record starts with `**Status:**`, `**Date:**`, and
`**Issue:**` fields. Status is one of `Proposed`, `Accepted`, or
`Superseded by ADR-NNNN`. Records are never rewritten after acceptance;
supersede them instead.

## Index

| ID | Title | Status |
| --- | --- | --- |
