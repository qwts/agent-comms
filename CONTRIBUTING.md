# Contributing

This repository is governed by
[qwts-agent-sop](https://github.com/qwts/qwts-agent-sop): its shared SOPs
and engineering decisions apply here by default
([ENG-0008](https://github.com/qwts/qwts-agent-sop/blob/main/docs/decisions/ENG-0008-shared-sop-inheritance.md)).

- **Workflow:** branch → PR → review → merge, per the shared
  [branch, PR, and review SOP](https://github.com/qwts/qwts-agent-sop/blob/main/docs/sop/branch-pr-review.md).
  Run the local gates in [AGENTS.md](AGENTS.md) before opening or updating a
  PR.
- **Decisions:** issue-first. Open an issue holding the why, then add the ADR
  citing it, per [docs/decisions/README.md](docs/decisions/README.md).
- **Features:** follow the
  [feature-lifecycle SOP](https://github.com/qwts/qwts-agent-sop/blob/main/docs/sop/feature-lifecycle.md):
  open the feature issue form before the code exists.
- **Security:** see the org
  [security policy](https://github.com/qwts/.github/blob/main/SECURITY.md);
  report vulnerabilities privately, never in a public issue.
- **CI for outside pull requests:** a pull request from a fork runs only on
  GitHub-hosted runners and receives no secrets. Self-hosted runners take only
  pushes, maintainer-started runs (manual and merge queue), and pull requests
  whose branch lives in this repository. Workflows from outside contributors
  wait until a maintainer approves them.
