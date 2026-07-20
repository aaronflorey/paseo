# Plan 008: Bound OpenCode session abort during close

> **Executor instructions**: Complete plan 006 first. Follow all verification
> gates and update the plan index. Preserve the separate interactive interrupt
> behavior and its compatibility comment.
>
> **Drift check (run first)**:
> `git diff --stat 0721f898e..HEAD -- packages/server/src/server/agent/providers/opencode-agent.ts packages/server/src/server/agent/providers/opencode-agent.test.ts`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: `plans/006-drain-event-callbacks.md`
- **Category**: bug
- **Planned at**: commit `0721f898e`, 2026-07-20

## Why this matters

OpenCode's `session.abort` can fail to settle. `OpenCodeAgentSession.close()`
awaits it without a deadline before deleting ephemeral provider state and before
the `finally` block releases session context and helper references. One stuck SDK
request can therefore block agent close and lifecycle cleanup indefinitely.

## Current state

- `opencode-agent.ts:514-545` defines `abortOpenCodeSession`; it catches failures
  but directly awaits `client.session.abort` with no timeout.
- `OpenCodeAgentSession.close():4639-4678` drains the event stream, calls that
  helper, deletes ephemeral provider state, then releases context/server in
  `finally`.
- `interrupt():3696-3713` already bounds the interactive abort wait at two
  seconds and has a `COMPAT` explanation. Do not merge close semantics into
  interrupt or fabricate an interrupt acknowledgement.
- `opencode-agent.test.ts` already asserts close calls abort; extend that test
  harness with a never-settling abort.

## Commands you will need

| Purpose   | Command                                                                                                                                                                  | Expected on success |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| Test      | `npx vitest run packages/server/src/server/agent/providers/opencode-agent.test.ts --bail=1`                                                                              | exit 0              |
| Typecheck | `npm run typecheck:server`                                                                                                                                               | exit 0              |
| Lint      | `npm run lint -- packages/server/src/server/agent/providers/opencode-agent.ts packages/server/src/server/agent/providers/opencode-agent.test.ts`                         | exit 0              |
| Format    | `npm run format:files -- packages/server/src/server/agent/providers/opencode-agent.ts packages/server/src/server/agent/providers/opencode-agent.test.ts plans/README.md` | exit 0              |

## Scope

**In scope**: `opencode-agent.ts` and `opencode-agent.test.ts` at the paths above.

**Out of scope**:

- Changing interactive `interrupt()` timing or compatibility behavior.
- Retrying abort, canceling the underlying SDK promise, or changing provider
  session persistence policy.

## Git workflow

- Branch: `advisor/008-bound-close-abort`
- Commit: `fix(opencode): bound session abort during close`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add the hanging-abort regression

Configure `TestOpenCodeClient.session.abort` to return a never-settling promise.
Use fake timers. Begin close and assert context/server releases have not occurred
before the configured deadline. Advance through the deadline and assert close
settles, all `finally` releases execute once, and a value-free timeout warning is
logged. Ensure the test does not leave a pending real timer.

**Verify**: targeted test fails against current code because close never settles.

### Step 2: Bound only the close abort helper

Add a named close-abort timeout constant near existing OpenCode timing constants
(two seconds is consistent with interrupt unless current tests establish another
deadline). Wrap the SDK abort request with the existing `withTimeout` helper
inside `abortOpenCodeSession`'s `try`. Treat timeout like other abort failures:
log at warning level and continue cleanup. Do not await the underlying promise
again and do not let its eventual settlement produce an unhandled rejection.

**Verify**: hanging, successful, not-found, response-error, and thrown abort
tests all pass.

### Step 3: Finish checks

Run format, targeted test, server typecheck, lint, and `git diff --check`.

**Verify**: all exit 0 with no diff-check output.

## Test plan

- Successful close abort remains awaited.
- Never-settling abort times out and releases resources once.
- Late reject after timeout is handled without unhandled rejection.
- Not-found remains quiet; other response/throw failures remain warnings.
- Interactive interrupt tests remain unchanged and green.

## Done criteria

- [ ] Close cannot wait forever on `session.abort`.
- [ ] Event callback drain still precedes abort and resource release.
- [ ] Helper/context cleanup always executes.
- [ ] Targeted test, typecheck, lint, and format pass.
- [ ] Index updated.

## STOP conditions

- `withTimeout` does not attach rejection handling to the losing promise.
- OpenCode close requires confirmation of abort before releasing a safety-critical
  resource; report the evidence rather than extending the timeout indefinitely.
- Fixing close changes interactive interrupt event semantics.
- Verification fails twice after a reasonable fix.

## Maintenance notes

The timeout is a teardown liveness guard. It is not proof that the upstream
session stopped, so logs and future diagnostics must describe it as unconfirmed.
