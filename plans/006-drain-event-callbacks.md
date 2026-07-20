# Plan 006: Drain in-flight global-event callbacks before release

> **Executor instructions**: Follow every step and verification. Preserve the
> shared-stream fan-out and backlog isolation guarantees. Stop on a STOP
> condition and update `plans/README.md` when complete.
>
> **Drift check (run first)**:
> `git diff --stat 0721f898e..HEAD -- packages/server/src/server/agent/providers/opencode/global-event-hub.ts packages/server/src/server/agent/providers/opencode/global-event-hub.test.ts packages/server/src/server/agent/providers/opencode-agent.ts packages/server/src/server/agent/providers/opencode-agent.test.ts`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `0721f898e`, 2026-07-20

## Why this matters

Closing a global-event subscription removes its listener and resolves `done`
without awaiting that listener's current callback chain. Session close then
releases child context bindings, MCP routing context, and helper references while
an event callback may still be creating or using them. Teardown needs a clear
drain contract without letting queued events continue after close.

## Current state

- `global-event-hub.ts` gives each listener a serialized `eventChain` and
  `pendingEvents` count.
- `subscription.close()` marks the listener closed, removes it, aborts the
  generation when it was last, then resolves `done`; it never awaits that
  listener's `eventChain`.
- `deliverEvent()` checks `listener.closed` before entering `onEvent`, so queued
  callbacks can be skipped after close, but a callback already awaiting cannot
  be canceled.
- `run()` drains chains only for listeners still in the generation's set; a
  manually removed listener is excluded.
- `opencode-agent.ts:4140-4159` event callbacks can register child session URLs
  and context releases and can await permission auto-approval network work.
- `OpenCodeAgentSession.close()` treats subscription/task completion as the gate
  before clearing those resources.

## Commands you will need

| Purpose   | Command                                                                                                                                                                                                                                                                                                                       | Expected on success |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Tests     | `npx vitest run packages/server/src/server/agent/providers/opencode/global-event-hub.test.ts packages/server/src/server/agent/providers/opencode-agent.test.ts --bail=1`                                                                                                                                                      | exit 0              |
| Typecheck | `npm run typecheck:server`                                                                                                                                                                                                                                                                                                    | exit 0              |
| Lint      | `npm run lint -- packages/server/src/server/agent/providers/opencode/global-event-hub.ts packages/server/src/server/agent/providers/opencode/global-event-hub.test.ts packages/server/src/server/agent/providers/opencode-agent.ts packages/server/src/server/agent/providers/opencode-agent.test.ts`                         | exit 0              |
| Format    | `npm run format:files -- packages/server/src/server/agent/providers/opencode/global-event-hub.ts packages/server/src/server/agent/providers/opencode/global-event-hub.test.ts packages/server/src/server/agent/providers/opencode-agent.ts packages/server/src/server/agent/providers/opencode-agent.test.ts plans/README.md` | exit 0              |

## Scope

**In scope**:

- `packages/server/src/server/agent/providers/opencode/global-event-hub.ts`
- `packages/server/src/server/agent/providers/opencode/global-event-hub.test.ts`
- `packages/server/src/server/agent/providers/opencode-agent.ts`
- `packages/server/src/server/agent/providers/opencode-agent.test.ts`

**Out of scope**:

- Reconnect policy; plan 007 handles dead streams.
- Parallel event delivery within one subscriber.
- Canceling arbitrary user callbacks or changing the 1,024-event limit.

## Git workflow

- Branch: `advisor/006-drain-event-callbacks`
- Commit: `fix(opencode): drain event callbacks during teardown`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Pin the subscription drain contract

In `global-event-hub.test.ts`, block the first `onEvent`, enqueue a second event,
call `close()`, and assert:

- close remains pending while the first callback is running;
- the queued second callback never runs after close;
- when the first callback resolves, close and `done` resolve;
- calling close twice returns the same eventual result and does not double-end.

Add a second fast subscriber to prove it continues receiving events while the
first drains.

**Verify**: targeted hub test fails against current code because close resolves
before the first callback.

### Step 2: Implement one idempotent listener teardown path

Refactor listener termination so manual close, callback failure, backlog detach,
and generation end all enter one idempotent state machine. Required ordering:

1. stop accepting/enqueuing work and remove the listener;
2. make queued `deliverEvent` calls short-circuit;
3. await the already-running serialized chain;
4. invoke `onEnd` only for terminal-error paths, at most once;
5. settle `ready` and `done` exactly once.

Keep `close(): Promise<void>` and `done` equivalent as teardown barriers. Prevent
self-deadlock when `deliverEvent` itself reports an error: do not await the full
chain from inside the same chain; schedule terminal finalization after the chain
settles.

**Verify**: all hub tests pass, including callback rejection and backlog detach
cases added for the state machine.

### Step 3: Prove session resources outlive the callback

In `opencode-agent.test.ts`, block an event callback at the point where it uses
or registers child context, begin session close, and assert the release callbacks
and server acquisition remain held. Resolve the callback and assert resources
release exactly once afterward. A closed session must not notify subscribers
with the queued event.

**Verify**: both targeted test files pass.

### Step 4: Finish checks

Run format, tests, server typecheck, lint, and `git diff --check`.

**Verify**: all commands exit 0; no diff-check output.

## Test plan

- Manual close waits for the current callback and skips queued callbacks.
- Fast subscribers are unaffected by a draining slow subscriber.
- Callback rejection, filter rejection, backlog detach, stream EOF, and repeated
  close settle `ready`/`done` once and call `onEnd` at most once.
- Session-owned context and server refs release only after drain.

## Done criteria

- [ ] `subscription.close()` and `done` are real callback-drain barriers.
- [ ] No queued event starts after listener close.
- [ ] No teardown path deadlocks or double-calls `onEnd`.
- [ ] Targeted tests, typecheck, lint, and format pass.
- [ ] Index updated.

## STOP conditions

- An existing caller invokes `close()` from inside its own `onEvent` callback;
  report the call path because it requires an explicit reentrancy contract.
- Correctness requires an unbounded wait on a callback known to be externally
  non-settling; report the callback and owner before adding a timeout.
- The fix serializes different subscribers with each other.
- Verification fails twice after a reasonable fix.

## Maintenance notes

Treat `done` as a resource-safety boundary, not merely an event-source status.
Plan 007's reconnect state machine must wait for this drain before replacing a
subscription for the same session.
