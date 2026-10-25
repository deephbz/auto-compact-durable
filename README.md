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
`0.1.1`. Node 22.19 or later.

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
- `hcCompactExtension({history, record, method, lastRequest, workingBudget, trigger})`:
  a `beforeCompact` hook. `method` returns `keepset` (default), `summary`, or
  `native`. If the chosen method fails, the hook records a `native-fallback`
  with the reason and pi-durable writes its own summary.
  - `summary`: the model's working-state summary, the Rarebit conversation
    record (newest first, 12k-token cap, over the full durable history), and an
    index of dropped tool results.
  - `keepset`: Pi's keepset. One planning request returns
    `{summary, keep}`, where `keep` names tool outputs (`t1`, `t2`, ...) of the
    replaced range. The summary holds the working-state summary, kept outputs
    verbatim, the conversation record, and the dropped index. The keep cap is
    min(20000, W/4). The cap counts installed text, including headers, fences,
    and cut marks. One block is cut at 8000 tokens. An unknown label or a plan
    over the cap is rejected. `./keepset` exports the planner, budget, and fit
    check.
- Fit: the hook makes an estimated fit check before it returns a summary.
  Durable's native placement owns the installed context. The summary, kept
  tail, and prompt overhead must fit under the compaction trigger (`trigger`,
  else W). Otherwise the hook falls back with
  `the summary does not fit: ...`.
  - Estimate: pi-ai's estimator on what pi-ai sends: 3.5 characters per token.
    Thinking and tool-call arguments count as text. An image counts as 4800
    characters.
  - Prompt overhead: placement omits the system entries of the kept context
    and writes one baseline of the current sections and tools. A section or
    tool patch before the cut stays in the prompt. The hook replays every
    system message of the history and captured request with pi-ai's
    `getCurrentSystemMessage`, including any request-level system prompt and
    tools, and takes the larger estimate. A plan saved before a restart keeps
    its overhead as a floor. System entries in the kept tail count once as
    overhead.
  - Tail: the hook reads `history` again after the planner or summary model
    answers, so output that arrived meanwhile counts. If `history` is absent or
    fails, the hook falls back with
    `the fit check cannot read the history: ...`. It never assumes an empty
    tail.
  - Race: the conversation can still grow between the fit check and durable's
    placement. Placement owns that window.
- Cache reuse: the planning request is the last real request of the provider
  session plus one appended user message. `lastRequest(sessionId)` returns that
  captured `Context` (AmPi's Cache Goblin wrapper captures it). The planner
  sets `PLANNER_REQUEST` on its stream options with the prefix length. The
  wrapper marks the prefix as usual and sends the appended message unmarked.
  With no captured request, or a prefix that does not cover the replaced range,
  the hook falls back with `no cache reuse: <gap>`.
- Restart: the first run pins the method, keep cap, and fit limit in the task
  memo. The plan memo pins the plan and planner model before validation. A
  restarted node installs the memoized plan without a second planning request.
  A new plan after restart has no captured request, so the hook falls back with
  `no cache reuse: no request captured`.
- Caveats: prefix identity holds only while payload modifiers (Cache Goblin
  marks, other `onPayload` hooks) and cache TTL stay unchanged between the last
  request and planner. Planner spend is not exactly-once. A crash after the
  answer and before the memo write pays again.
- `CompactRecord`: one receipt per compaction, including method, task ID,
  attempts, reason, trigger, sections, kept and dropped outputs, planner usage,
  cache facts, and any rejected plan.

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
