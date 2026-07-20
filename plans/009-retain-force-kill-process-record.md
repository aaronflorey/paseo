# Plan 009: Retain managed-process records after an unconfirmed force kill

> **Executor instructions**: Follow the plan step by step, run each verification,
> and update `plans/README.md`. Do not mark a process dead without an exit signal.
>
> **Drift check (run first)**:
> `git diff --stat 0721f898e..HEAD -- packages/server/src/server/agent/providers/opencode/server-manager.ts packages/server/src/server/agent/providers/opencode-server-manager.test.ts packages/server/src/utils/tree-kill.ts`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `0721f898e`, 2026-07-20

## Why this matters

`kill-timeout` explicitly means SIGKILL was sent but the child never reported
exit. The OpenCode manager currently deletes the managed-process record anyway,
removing the daemon's only durable evidence of a possibly live orphan. The
record must remain until an actual exit event or later stale-process reaping can
confirm the process is gone.

## Current state

- `packages/server/src/utils/tree-kill.ts` returns one of `already-exited`,
  `terminated`, `killed`, or `kill-timeout`; the last is the only unconfirmed
  outcome.
- `server-manager.ts:416-445` logs a warning for `kill-timeout` but then always
  removes `managedProcessId`/pending record metadata.
- The server process `exit` listener calls `removeManagedServerRecord(server)`,
  so a later real exit already has a cleanup path.
- `opencode-server-manager.test.ts` contains `FakeManagedProcesses` and a fake
  terminator that currently always exits and returns `terminated`.

## Commands you will need

| Purpose   | Command                                                                                                                                                                                    | Expected on success |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| Test      | `npx vitest run packages/server/src/server/agent/providers/opencode-server-manager.test.ts --bail=1`                                                                                       | exit 0              |
| Typecheck | `npm run typecheck:server`                                                                                                                                                                 | exit 0              |
| Lint      | `npm run lint -- packages/server/src/server/agent/providers/opencode/server-manager.ts packages/server/src/server/agent/providers/opencode-server-manager.test.ts`                         | exit 0              |
| Format    | `npm run format:files -- packages/server/src/server/agent/providers/opencode/server-manager.ts packages/server/src/server/agent/providers/opencode-server-manager.test.ts plans/README.md` | exit 0              |

## Scope

**In scope**:

- `packages/server/src/server/agent/providers/opencode/server-manager.ts`
- `packages/server/src/server/agent/providers/opencode-server-manager.test.ts`

**Read only**: `packages/server/src/utils/tree-kill.ts`.

**Out of scope**:

- Changing signal order or tree-kill timeout durations.
- Reaping stale process records globally.
- Treating SIGKILL delivery as confirmed exit.

## Git workflow

- Branch: `advisor/009-retain-force-kill-process-record`
- Commit: `fix(opencode): retain unconfirmed helper process record`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add an unconfirmed-kill fake mode

Let `FakeOpenCodeServerRuntime` return `kill-timeout` without emitting process
exit. Start/acquire/release a helper, await record creation, trigger shutdown,
and assert the managed-process record remains with its original PID/port. Assert
the timeout warning occurs and manager acquisition state no longer advertises
the generation as usable.

Then emit the fake process's exit event and assert the record is removed exactly
once.

**Verify**: targeted test fails against current code at the retained-record
assertion.

### Step 2: Make record removal outcome-aware

In `killServer`, return immediately after logging a `kill-timeout` without
clearing `managedProcessId` or `managedProcessRecord`. Preserve cleanup for
`already-exited`, `terminated`, and `killed`; preserve the process exit listener
as the eventual cleanup for an unconfirmed outcome. Manager routing state may be
cleared so no new work uses the generation, but durable process evidence stays.

Handle a still-pending `managedProcessRecord` promise: if it resolves after the
timeout it must also remain until exit, not be removed by a detached callback.

**Verify**: targeted tests pass for immediate and delayed record creation.

### Step 3: Finish checks

Run format, targeted test, server typecheck, lint, and `git diff --check`.

**Verify**: all commands exit 0; diff check is empty.

## Test plan

- Confirmed exit outcomes remove records as before.
- `kill-timeout` retains both already-resolved and pending records.
- Later exit removes retained record once.
- Timed-out generation is not reused for new acquisitions.

## Done criteria

- [ ] Unconfirmed force kill never deletes process evidence.
- [ ] Confirmed exits still clean up records.
- [ ] No helper generation remains routable after shutdown/rotation.
- [ ] Targeted test, typecheck, lint, and format pass.
- [ ] Index updated.

## STOP conditions

- Another lifecycle path removes the same record immediately after
  `killServer`; identify it rather than weakening the assertion.
- The managed-process registry cannot retain a record after daemon shutdown.
- A fix requires changing generic tree-kill semantics.
- Verification fails twice after a reasonable fix.

## Maintenance notes

Plan 018 may expose an unconfirmed helper in redacted diagnostics. Plan 010 must
also treat `kill-timeout` as non-terminal for generation resource cleanup.
