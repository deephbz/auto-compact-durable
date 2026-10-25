# Auto Compact Durable agent entry point

`@hypercarrier/auto-compact-durable` supplies HyperCarrier's compaction policy
and summary to hosts built on pi-durable. pi-durable owns the compaction task,
the cut, and the history. The host owns storage, scheduling, and models.

## Read order

1. [README.md](README.md): purpose, install, API, status, known issues.
2. [src/index.ts](src/index.ts) and [src/budget.ts](src/budget.ts): the whole
   implementation, with its design comments.
3. [docs/maintainers/releasing.md](docs/maintainers/releasing.md): releases.

## Rules

- `src/budget.ts` imports nothing, so a host can read the budget rule without
  loading pi-durable. Keep it that way.
- Pin `@hypercarrier/rarebit-durable` and the `@earendil-works/*` peers
  exactly.
- Commits use the GitHub identity `deephbz` with its noreply address. A commit
  message, pull request, tag, or tracked file carries no agent session or
  thread ID.
- Tracked files carry no local path, host name, personal email, or real session
  data. Use synthetic examples.
- This repository is public. Run
  `git-privacy-scan --ref HEAD --base "$(git config privacy.baseline)" range`
  before every push. Never print a detected value.
- A release is a pushed version tag; CI publishes
  ([releasing](docs/maintainers/releasing.md)).
