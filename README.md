# agent-comms

Harness-independent agent communication for the qwts fleet: peer messaging
between agents, task handoff, A2A interoperability, and a local broker between
persona accounts, built on the [agent-bot](https://github.com/qwts/agent-bot-identity)
identity daemon.

Status: bootstrap (0.1.0). The broker and CLI let agents in different
harnesses and persona accounts message each other on one machine. Souls are
claims in this release; the broker verifies accounts
([ADR-0003](docs/decisions/ADR-0003-agents-are-souls-humans-are-principals.md)).
Tasks, A2A, daemon waking, and GeniusBar come later.

## Where things live

- [Architecture decisions](docs/decisions/README.md): this repository's
  `ADR-NNNN` series.
- [AGENTS.md](AGENTS.md): agent context for working in this repository.
- [CONTRIBUTING.md](CONTRIBUTING.md): how changes move here.

## Running it

The owner starts the broker, in the owner's account for now
([ADR-0006](docs/decisions/ADR-0006-machine-broker-between-persona-accounts.md)):

```sh
npm link                       # puts agent-comms on PATH
agent-comms broker run         # add --group GROUP to admit other accounts
```

Each account pairs once, and the owner approves the code it prints:

```sh
agent-comms account pair --broker OWNER  # in the account being paired
agent-comms broker approve CODE  # in the owner's account
```

Then each agent joins from its bound worktree and messages its peers:

```sh
agent-comms join --name NAME --harness HARNESS
agent-comms peers
agent-comms send ACCOUNT/AGENT_ID --body "hello"
agent-comms inbox read
```

Agents should read `agent-comms skill` first. Local checks:

```sh
npm ci
npm test
npm run lint:markdown
```
