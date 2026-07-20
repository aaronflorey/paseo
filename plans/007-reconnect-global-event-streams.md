# Plan 007: Reconnect dead OpenCode global event streams

> **Executor instructions**: Complete plan 006 first. Follow the state-machine
> requirements exactly and run every verification. Stop rather than add a
> second concurrent stream. Update the index when done.
>
> **Drift check (run first)**:
> `git diff --stat 0721f898e..HEAD -- packages/server/src/server/agent/providers/opencode/global-event-hub.ts packages/server/src/server/agent/providers/opencode/global-event-hub.test.ts packages/server/src/server/agent/providers/opencode-agent.ts packages/server/src/server/agent/providers/opencode-agent.test.ts`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/006-drain-event-callbacks.md`
- **Category**: bug
- **Planned at**: commit `0721f898e`, 2026-07-20

## Why this matters

The hub intentionally disables SDK SSE retries. An unexpected EOF terminates
the listener, but the session keeps the dead subscription cached until `done`
settles; `onEnd` can run first and foreground/external sessions can remain idle
without ever creating a replacement. A live Paseo session needs one serialized,
backed-off reconnect loop and must never treat a dead subscription as ready.

## Current state

- `global-event-hub.ts:95-129` opens `client.global.event` with
  `sseMaxRetryAttempts: 0`; unexpected EOF becomes a terminal error.
- The hub creates a fresh generation for a later subscriber when the prior
  generation's `isClosed` is true.
- `opencode-agent.ts:4169-4214` caches `eventStreamSubscription`,
  `eventStreamReady`, and `eventStreamTask`; only a `subscription.done.finally`
  callback clears readiness.
- `handleEventStreamEnd` runs from `onEnd` before `done` is resolved and can mark
  a foreground turn failed while the dead subscription is still cached.
- `startTurn()` calls `ensureEventStreamReady()`, but externally driven/adopted
  sessions also rely on the persistent event stream while idle.
- Processed message/part identifiers already provide event deduplication; retain
  that state across transport reconnection.

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

- Enabling SDK-managed retries in addition to Paseo retries.
- Replaying full session history after each reconnect.
- Changing event identity/deduplication or terminal turn protocol semantics.

## Git workflow

- Branch: `advisor/007-reconnect-global-event-streams`
- Commit: `fix(opencode): reconnect global event streams`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Reproduce the invalidation race

Add a deterministic test where the stream ends, `onEnd` begins, and another
caller invokes `ensureEventStreamReady()` before the old `done.finally`
microtask. Assert the caller does not receive the old readiness promise and no
event is delivered through two streams. Use deferred promises, not sleeps.

Add an idle externally driven session test: terminate its global stream, expose
a replacement stream from the fake client, and assert the session subscribes
again without requiring `startTurn()`.

**Verify**: targeted tests fail against current code.

### Step 2: Invalidate before terminal notification

Make subscription identity explicit. When a particular subscription ends,
atomically mark that exact subscription unusable before invoking foreground-turn
failure handling or any caller can read readiness. Cleanup from an older
subscription must not clear a newer one; compare identity/generation in every
finally callback.

Wait for plan 006's listener drain before installing a replacement for the same
session.

**Verify**: the microtask-gap test passes and observes no stale ready promise.

### Step 3: Add one cancellable reconnect loop

For every live session that requires external events, maintain one reconnect
promise/task. On unexpected EOF or connection failure, retry with bounded
exponential backoff (small initial delay, capped delay, no zero-delay hot loop).
Reset the attempt count after a stream becomes ready. `startTurn()` may join or
wake the same loop but must not create another subscription.

Session close must cancel pending backoff immediately and await task teardown.
User-initiated close/abort must not schedule reconnect. Keep processed event IDs
across reconnect so replayed transport events do not duplicate timeline items.

**Verify**: fake-timer tests cover repeated failures, backoff cap, success reset,
single-flight calls, and immediate close cancellation.

### Step 4: Preserve turn semantics

An active foreground turn whose stream dies may still emit the existing
`turn_failed`; reconnect is for subsequent/external events and must not synthesize
a successful or canceled turn. A later `startTurn()` must wait for the new ready
stream before prompting. Idle external activity arriving after reconnect must
translate normally exactly once.

**Verify**: OpenCode agent tests assert one terminal event for the failed turn and
normal handling after reconnect.

### Step 5: Finish checks

Run format, both test files, server typecheck, lint, and `git diff --check`.

**Verify**: every command exits 0; diff check is empty.

## Test plan

- Dead readiness is invalidated before `onEnd` side effects.
- Idle sessions reconnect without a new prompt.
- Repeated failures use one capped-backoff loop.
- Concurrent ensure/start callers share one stream.
- Close cancels backoff and prevents reconnect.
- Duplicate events after reconnect remain deduplicated.

## Done criteria

- [ ] A live session never exposes a dead stream as ready.
- [ ] At most one global stream exists per server generation and one reconnect
      task per session.
- [ ] Idle external events recover after unexpected EOF.
- [ ] Targeted tests, typecheck, lint, and format pass.
- [ ] Index updated.

## STOP conditions

- A replacement stream cannot be created until the helper generation rotates.
- The only deduplication identity is transport-local and resets on reconnect;
  report the upstream payload before inventing heuristics.
- Reconnect would require changing wire terminal-event semantics.
- Verification fails twice after a reasonable fix.

## Maintenance notes

Keep SDK retry attempts at zero while Paseo owns this policy; two retry layers
would defeat single-flight guarantees. Diagnostics plan 018 should consume this
state rather than adding a second health tracker.
