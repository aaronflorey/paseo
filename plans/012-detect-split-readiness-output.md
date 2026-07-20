# Plan 012: Detect helper readiness across stdout chunk boundaries

> **Executor instructions**: Follow the plan and all verification gates. Keep
> startup diagnostics capped and update `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat 0721f898e..HEAD -- packages/server/src/server/agent/providers/opencode/server-manager.ts packages/server/src/server/agent/providers/opencode-server-manager.test.ts`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `0721f898e`, 2026-07-20

## Why this matters

Node stdout chunking is arbitrary. The helper announces readiness with
`listening on`, but the manager checks only the latest chunk even though it
already retains a capped cumulative buffer. If `listening ` and `on` arrive in
separate chunks, a healthy helper waits until the 30-second startup timeout.

## Current state

- `server-manager.ts:startServer()` appends stdout into an 8,192-character
  capped `stdoutBuffer` for startup errors.
- Its data handler tests `output.includes("listening on")` using only the current
  chunk.
- `opencode-server-manager.test.ts` has `FakeOpenCodeProcess.announceListening()`
  that emits the whole phrase as one buffer and auto-announces by default.

## Commands you will need

| Purpose   | Command                                                                                                                                                                                    | Expected on success |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| Test      | `npx vitest run packages/server/src/server/agent/providers/opencode-server-manager.test.ts --bail=1`                                                                                       | exit 0              |
| Typecheck | `npm run typecheck:server`                                                                                                                                                                 | exit 0              |
| Lint      | `npm run lint -- packages/server/src/server/agent/providers/opencode/server-manager.ts packages/server/src/server/agent/providers/opencode-server-manager.test.ts`                         | exit 0              |
| Format    | `npm run format:files -- packages/server/src/server/agent/providers/opencode/server-manager.ts packages/server/src/server/agent/providers/opencode-server-manager.test.ts plans/README.md` | exit 0              |

## Scope

**In scope**: the server-manager source and test at the paths above.

**Out of scope**:

- Replacing readiness text with port polling.
- Changing the 30-second timeout or startup buffer cap.
- Broad stdout/stderr log behavior.

## Git workflow

- Branch: `advisor/012-detect-split-readiness-output`
- Commit: `fix(opencode): detect split helper readiness output`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add arbitrary split tests

Give `FakeOpenCodeProcess` a method to emit caller-supplied stdout chunks. With
auto-announce disabled, test every boundary inside `listening on`, plus a split
where unrelated prefix text precedes the phrase. Acquisition must resolve after
the final chunk without advancing to the startup timeout.

Also assert incomplete text does not mark ready.

**Verify**: targeted test fails against current code for at least one split.

### Step 2: Check cumulative capped output

After appending each chunk, check readiness against `stdoutBuffer`, not only
`output`. Preserve the settled guard, timeout clearing, capped diagnostic text,
and one-time resolution. Do not duplicate uncapped output solely for matching.

**Verify**: all boundary tests and existing startup failure tests pass.

### Step 3: Finish checks

Run format, targeted test, typecheck, lint, and `git diff --check`.

**Verify**: all commands exit 0; diff check prints nothing.

## Test plan

- Every phrase boundary is detected.
- Prefix/suffix noise is accepted as before.
- Incomplete or wrong phrases do not resolve readiness.
- Readiness resolves once and startup error diagnostics remain capped.

## Done criteria

- [ ] Readiness is independent of stdout chunk boundaries.
- [ ] No startup timing/cap policy changed.
- [ ] Targeted test, typecheck, lint, and format pass.
- [ ] Index updated.

## STOP conditions

- Current OpenCode no longer emits a stable readiness phrase.
- The cumulative buffer can discard the phrase prefix before its suffix arrives
  under the current cap logic; report the exact scenario before adding storage.
- Verification fails twice after a reasonable fix.

## Maintenance notes

If the upstream readiness text changes, update the matcher and split-boundary
table together. Never assume a Node stream data event aligns with a line.
