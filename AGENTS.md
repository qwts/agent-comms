# AGENTS.md

Canonical, vendor-neutral agent context for this repository, per
[ENG-0006](https://github.com/qwts/qwts-agent-sop/blob/main/docs/decisions/ENG-0006-agentic-primitives-governance.md).
Harness instruction files live in the user directory
([ENG-0384](https://github.com/qwts/qwts-agent-sop/blob/main/docs/decisions/ENG-0384-harness-config-lives-in-the-user-directory.md)),
not in this repository.

## What this repository is

agent-comms: harness-independent agent communication for the qwts fleet,
built on the agent-bot identity daemon. It is onboarding and holds design
records only. Map: [README.md](README.md).

<!-- governed:shared-agent-discovery:start -->

## Shared agent conventions and skills

PR-first workflow, validation-before-push, commit and PR hygiene, and the
untrusted-input threat model are defined once, for every repo, in the
[org-wide agent conventions](https://github.com/qwts/qwts-agent-sop/blob/main/docs/reference/agent-conventions.md).
Before creating or copying a repo-local skill, consult the reviewed
[shared agent skills](https://github.com/qwts/qwts-agent-sop/blob/74e775ef23d8e7d8f8e693ccc2329f430978c096/skills/README.md)
index. Reuse only the pinned version supplied by the governed harness; a skill
genuinely specific to this repository belongs in its local context.
This repository is governed by
[qwts-agent-sop](https://github.com/qwts/qwts-agent-sop) — its
[shared SOPs](https://github.com/qwts/qwts-agent-sop/blob/main/docs/sop/README.md)
and [engineering decisions](https://github.com/qwts/qwts-agent-sop/blob/main/docs/decisions/README.md)
apply here by default
([ENG-0008](https://github.com/qwts/qwts-agent-sop/blob/main/docs/decisions/ENG-0008-shared-sop-inheritance.md):
inherit by default, vary by explicit delta).
<!-- governed:shared-agent-discovery:end -->

## What is specific to this repository

- **Architecture decisions:** the `ADR-NNNN` series in
  [docs/decisions/](docs/decisions/README.md). Numbering, format, and status
  rules are in that index. A decision that changes more than this repository
  is an ENG record in `qwts-agent-sop` instead, and the ADR links to it.
- **Built on agent-bot:** identities, principals, the daemon, and its `/v1`
  interaction contract belong to
  [agent-bot-identity](https://github.com/qwts/agent-bot-identity). Extend
  them there through their own process; do not fork their semantics here.
- **Docs gate:** every change under `docs/`, plus this file, `README.md`, and
  `CONTRIBUTING.md`, passes the docs-gov check and `npm run lint:markdown`
  before a PR is opened. The check runs from the pinned
  `qwts-agent-docs-gov` capability, the same commit `.github/workflows/ci.yml`
  calls:

  ```bash
  git clone -q https://github.com/qwts/qwts-agent-docs-gov.git /tmp/docs-gov && git -C /tmp/docs-gov checkout -q 67db7dc9c20bc29222fb605b7ff9432fd58a2a3f && node /tmp/docs-gov/tools/docs-gov/docs-gov.mjs --root .
  ```
