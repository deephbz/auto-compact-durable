# @hypercarrier/auto-compact-durable

HyperCarrier Auto Compact on [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable).
pi-durable owns the compaction task, the cut, and the history. This package
supplies the budget mapping and the summary.

## Install

```sh
npm install @hypercarrier/auto-compact-durable
```

The package needs a pi-durable host. Install these peers at exactly `1.4.0`:
`@earendil-works/pi-durable`, `@earendil-works/pi-ai`, and
`@earendil-works/chord`. It depends on
[`@hypercarrier/rarebit-durable`](https://www.npmjs.com/package/@hypercarrier/rarebit-durable)
`0.1.0`. Node 22.19 or later.

## API

- `workingBudget(window, {budgetTokens, modelBudgetTokens})`: the working
  budget W, resolved as Pi's Auto Compact resolves it: the per-model budget,
  else the global one, else the window, never above the window.
  `compactTrigger(window, {thresholdPercent, ...})`: the context size at which
  the host calls `compact()` itself, the threshold share of W. Both live in
  `@hypercarrier/auto-compact-durable/budget`, which imports nothing, so a host
  can use the same rule without loading pi-durable.
- `compactionSettings(opts)`: the harness compaction settings. The verbatim
  keep defaults to min(20000, W/4) when a budget is set.
- `hcCompactExtension({history, record})`: a `beforeCompact` hook that writes
  three sections: the model's working-state summary, the Rarebit conversation
  record (newest first, 12k-token cap, over the full durable history), and an
  index of dropped tool results. If the model call fails, it records a
  `native-fallback` and pi-durable writes its own summary.
- `CompactRecord`: one receipt per compaction (method, reason, trigger,
  sections).

Not ported from the Pi extension: artifact handoff turns and input custody. A
durable run never loses input during compaction.

## Status

Version 0.1.0 is the first release. The API follows HyperCarrier's AmPi host
and may change in minor versions until 1.0.

- 0.1.0 was published by hand and has no npm provenance. Later versions publish
  from CI with provenance.
- Standalone CI proves: the TypeScript typecheck, a smoke test over synthetic
  durable history (budget rules, summary sections, the hook with a fake host
  API, the native fallback), and the packed file list, a plain Node import of
  the built `dist`, and a TypeScript consumer compile, on Node 22 and 24.
- CI does not prove behavior inside a running pi-durable node. The end-to-end
  tests need the AmPi daemon and stay in HyperCarrier (private):
  `apps/ampi/test/compact.test.ts`, which drives `/auto-compact` through the
  daemon, and `apps/ampi/test/budget-parity.test.ts`, which compares the budget
  rule with Pi's Auto Compact controller.
