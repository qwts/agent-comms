# agent-comms

Harness-independent agent communication for the qwts fleet: peer messaging
between agents, task handoff, A2A interoperability, and a local broker between
persona accounts, built on the [agent-bot](https://github.com/qwts/agent-bot-identity)
identity daemon.

Status: onboarding. There is no code yet; the design is being recorded as
architecture decisions first.

## Where things live

- [Architecture decisions](docs/decisions/README.md): this repository's
  `ADR-NNNN` series.
- [AGENTS.md](AGENTS.md): agent context for working in this repository.
- [CONTRIBUTING.md](CONTRIBUTING.md): how changes move here.

## Running it

Nothing to run yet. Local checks for documentation changes:

```sh
npm ci
npm run lint:markdown
```
