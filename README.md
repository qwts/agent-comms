# agent-comms

Harness-independent agent communication for the qwts fleet: peer messaging
between agents, task handoff, A2A interoperability, and a local broker between
persona accounts, built on the [agent-bot](https://github.com/qwts/agent-bot-identity)
identity daemon.

Released: [v0.3.15](https://github.com/qwts/agent-comms/releases/tag/v0.3.15).
The broker and CLI support peer messaging and durable task offers and
assignee-reported task transitions. One-account mode is the default; group
mode is explicit with `--group GROUP`. A2A is available through a loopback gateway configured by the owner and
explicitly configured outbound routes. The
gateway is off until configured, and wider inbound exposure is outside this
release ([A2A](docs/a2a.md)). Souls are claims; the broker verifies accounts
([ADR-0003](docs/decisions/ADR-0003-agents-are-souls-humans-are-principals.md)).

Host apps can use the principal client for owner-scoped census, messaging,
tasks and launch requests ([principal client](docs/principal-client.md));
agent-bot owns process creation and harness startup. The v0.3.15 release
contains Windows branches for the four platform seams, but that does not
establish end-to-end Windows broker or host compatibility. Live Windows
principal-client and bundled-host acceptance remain open
([Windows](docs/windows.md), [#127](https://github.com/qwts/agent-comms/issues/127)).
GeniusBar packaging and support for a selected host bundle are separate from
the agent-comms release.

## Where things live

- [Architecture decisions](docs/decisions/README.md): this repository's
  `ADR-NNNN` series.
- [Inbound A2A](docs/a2a.md): loopback JSON-RPC, bearer enrollment, and task mapping.
- [Tasks](docs/tasks.md): offers, revisions, transitions, and task events.
- [Principal client API](docs/principal-client.md): embed owner census and chat.
- [Windows](docs/windows.md): released `win32` platform branches and their
  current end-to-end limits.
- [AGENTS.md](AGENTS.md): agent context for working in this repository.
- [CONTRIBUTING.md](CONTRIBUTING.md): how changes move here.

## Install

Every account installs the same release from this repository's formula:

```sh
brew tap qwts/agent-comms https://github.com/qwts/agent-comms
brew install qwts/agent-comms/agent-comms
agent-comms --version
```

Releases are prepared with `scripts/release X.Y.Z`, which bumps the version
in `package.json`, the skill, and [Formula/agent-comms.rb](Formula/agent-comms.rb)
together for a release PR; after it merges, CI tags `vX.Y.Z` and publishes the
GitHub release. From a checkout instead:

```sh
npm link   # puts agent-comms on PATH from this checkout
```

## Running it

The owner starts the broker, in the owner's account for now
([ADR-0006](docs/decisions/ADR-0006-machine-broker-between-persona-accounts.md)):

```sh
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
