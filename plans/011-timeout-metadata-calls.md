# Plan 011: Bound OpenCode metadata calls inside the global limiter

> **Executor instructions**: Follow every step and targeted verification. Do
> not reduce the existing 30-second catalog timeout. Update `plans/README.md` on
> completion and stop on any STOP condition.
>
> **Drift check (run first)**:
> `git diff --stat 0721f898e..HEAD -- packages/server/src/server/agent/providers/opencode-agent.ts packages/server/src/server/agent/providers/opencode-agent.list-models-timeout.test.ts packages/server/src/server/agent/providers/opencode-agent.test.ts`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `0721f898e`, 2026-07-20

## Why this matters

OpenCode metadata requests share a process-wide concurrency limiter. Catalog
requests are timed, but session startup's provider lookup and session mode
lookup are not. Four non-settling requests can consume every limiter slot,
blocking every later OpenCode client and potentially hanging create/resume or
event translation forever.

## Current state

- `opencode-agent.ts` sets metadata concurrency to four with `p-limit`.
- `fetchModelsFromClient` wraps `provider.list` in a 30-second `withTimeout`
  inside the limiter. `opencode-agent.list-models-timeout.test.ts` explicitly
  proves a 15-second catalog call succeeds; do not restore the old 10-second
  failure.
- `fetchModesFromClient` already uses a 10-second timeout for `app.agents`.
- `populateModelContextWindowCache:1811-1824` uses unbounded `provider.list` and
  is awaited by both create and resume.
- `OpenCodeAgentSession.getAvailableModes:4519-4535` uses unbounded
  `app.agents`; mode-change event translation may await it.
- A timeout must be applied inside the limiter callback so the slot is released
  when the deadline expires.

## Commands you will need

| Purpose   | Command                                                                                                                                                                                                                                                        | Expected on success |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Tests     | `npx vitest run packages/server/src/server/agent/providers/opencode-agent.list-models-timeout.test.ts packages/server/src/server/agent/providers/opencode-agent.test.ts --bail=1`                                                                              | exit 0              |
| Typecheck | `npm run typecheck:server`                                                                                                                                                                                                                                     | exit 0              |
| Lint      | `npm run lint -- packages/server/src/server/agent/providers/opencode-agent.ts packages/server/src/server/agent/providers/opencode-agent.list-models-timeout.test.ts packages/server/src/server/agent/providers/opencode-agent.test.ts`                         | exit 0              |
| Format    | `npm run format:files -- packages/server/src/server/agent/providers/opencode-agent.ts packages/server/src/server/agent/providers/opencode-agent.list-models-timeout.test.ts packages/server/src/server/agent/providers/opencode-agent.test.ts plans/README.md` | exit 0              |

## Scope

**In scope**:

- `packages/server/src/server/agent/providers/opencode-agent.ts`
- `packages/server/src/server/agent/providers/opencode-agent.list-models-timeout.test.ts`
- `packages/server/src/server/agent/providers/opencode-agent.test.ts`

**Out of scope**:

- Changing metadata concurrency.
- Reducing the catalog provider-list deadline below 30 seconds.
- Retrying metadata requests or fabricating modes/models after a timeout.
- Adding timeouts to unrelated session prompt/event calls.

## Git workflow

- Branch: `advisor/011-timeout-metadata-calls`
- Commit: `fix(opencode): bound metadata limiter calls`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Name timeout policies by operation

Replace the single-purpose constant only if needed with explicit constants:
catalog/provider list remains 30 seconds; context-cache provider list should use
the same 30-second tolerance; app agent discovery remains 10 seconds. Keep
messages operation-specific and free of model/provider credentials.

**Verify**: existing 15-second slow catalog test remains green.

### Step 2: Reproduce slot exhaustion

Using fake timers and multiple clients/sessions, start four never-settling
context-cache provider calls, then queue a fifth metadata operation that would
resolve immediately. Assert the fifth is initially queued, then advances once
the first four deadlines expire. Add an equivalent never-settling session
`app.agents` case and prove event processing/mode lookup settles after 10 seconds.

Do not inspect private `p-limit` internals; observe SDK call start and public
promise settlement.

**Verify**: targeted tests fail against current unbounded paths.

### Step 3: Apply deadlines inside limiter callbacks

Wrap `populateModelContextWindowCache`'s `provider.list` with `withTimeout` in the
callback passed to `openCodeMetadataLimit`. Because context-window enrichment is
best effort, preserve existing non-response/error behavior; a timeout must not
hang create/resume. Decide explicitly whether to log-and-continue or propagate
based on existing create/resume error policy, and encode that decision in tests.

Wrap session `getAvailableModes`'s `app.agents` the same way. Preserve the
existing empty/discovered mode policy after failure; do not fabricate `build` or
`plan` modes.

**Verify**: slot-recovery tests and all existing timeout tests pass.

### Step 4: Prove late settlement is harmless

After advancing beyond timeout, reject the underlying fake SDK promises and
assert no unhandled rejection occurs and no stale result mutates caches. Start a
fresh request and assert the limiter still admits it.

**Verify**: targeted tests exit 0 with fake timers restored in `afterEach`.

### Step 5: Finish checks

Run format, targeted tests, typecheck, lint, and `git diff --check`.

**Verify**: all commands exit 0 and diff check is empty.

## Test plan

- Existing 15-second catalog call succeeds; catalog times out only at 30 seconds.
- Four stuck context-cache calls time out and release all slots.
- Stuck session mode discovery times out at 10 seconds and releases its slot.
- Create/resume/event paths settle according to their documented failure policy.
- Late SDK resolve/reject cannot mutate current caches or become unhandled.

## Done criteria

- [ ] Every operation entering the global OpenCode metadata limiter has a finite
      deadline inside the limiter callback.
- [ ] Slow-but-valid catalog behavior remains intact.
- [ ] Slot-recovery regressions pass.
- [ ] Targeted tests, typecheck, lint, and format pass.
- [ ] Index updated.

## STOP conditions

- A metadata call supports an upstream abort signal that must be used to avoid
  resource leakage; report the SDK signature before choosing timeout-only.
- Create/resume correctness requires context-window data and cannot safely
  continue after timeout.
- Applying `withTimeout` outside the limiter is the only proposed solution.
- Verification fails twice after a reasonable fix.

## Maintenance notes

Any new call added to `openCodeMetadataLimit` must choose a named timeout and a
tested fallback/propagation policy. Do not infer that a released limiter slot
cancels the upstream request.
