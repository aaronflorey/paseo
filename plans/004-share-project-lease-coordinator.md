# Plan 004: Share project-instance leases across all OpenCode clients

> **Executor instructions**: Follow each step and verification. Do not change
> the documented one-helper/final-lease disposal architecture. Update the plan
> index on completion unless the dispatcher owns it.
>
> **Drift check (run first)**:
> `git diff --stat 0721f898e..HEAD -- packages/server/src/server/agent/providers/opencode-agent.ts packages/server/src/server/agent/providers/opencode/server-manager.ts packages/server/src/server/agent/providers/opencode/project-instance-leases.ts packages/server/src/server/agent/providers/opencode/project-instance-leases.test.ts packages/server/src/server/agent/providers/opencode/test-server-manager.ts docs/providers.md`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `0721f898e`, 2026-07-20

## Why this matters

The OpenCode helper is process-wide, but every `OpenCodeAgentClient` currently
has a private project lease coordinator. Two derived/model clients can therefore
both believe they hold the last lease for the same helper generation and
directory; closing one can dispose project state still used by the other. Lease
counts must share the helper manager's lifetime and ownership boundary.

## Current state

- `opencode-agent.ts:1336-1355` constructs a new
  `OpenCodeProjectInstanceLeaseCoordinator` in every client constructor.
- `opencode-agent.ts:1375-1405` acquires a server ref and then a project lease
  keyed by `server.generation` plus normalized directory.
- `project-instance-leases.ts` serializes acquire/release for one coordinator,
  calls `client.instance.dispose({directory})` after the final active lease,
  marks failed disposal dirty, and retries before the next acquire.
- `server-manager.ts` is the shared process owner returned by static
  `getInstance()`; `OpenCodeServerManagerLike` is also implemented by
  `test-server-manager.ts`.
- `docs/providers.md` requires one shared OpenCode process and final same-directory
  lease disposal. This plan fixes ownership without changing that policy.
- Existing `project-instance-leases.test.ts` covers overlapping leases only
  through a single coordinator, directory isolation, retry, and concurrency.

## Commands you will need

| Purpose   | Command                                                                                                                                                                                                                                                                                                                                                                                                                    | Expected on success |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Tests     | `npx vitest run packages/server/src/server/agent/providers/opencode/project-instance-leases.test.ts packages/server/src/server/agent/providers/opencode-agent.test.ts packages/server/src/server/agent/providers/opencode-server-manager.test.ts --bail=1`                                                                                                                                                                 | exit 0              |
| Typecheck | `npm run typecheck:server`                                                                                                                                                                                                                                                                                                                                                                                                 | exit 0              |
| Lint      | `npm run lint -- packages/server/src/server/agent/providers/opencode-agent.ts packages/server/src/server/agent/providers/opencode/server-manager.ts packages/server/src/server/agent/providers/opencode/project-instance-leases.ts packages/server/src/server/agent/providers/opencode/project-instance-leases.test.ts packages/server/src/server/agent/providers/opencode/test-server-manager.ts`                         | exit 0              |
| Format    | `npm run format:files -- packages/server/src/server/agent/providers/opencode-agent.ts packages/server/src/server/agent/providers/opencode/server-manager.ts packages/server/src/server/agent/providers/opencode/project-instance-leases.ts packages/server/src/server/agent/providers/opencode/project-instance-leases.test.ts packages/server/src/server/agent/providers/opencode/test-server-manager.ts plans/README.md` | exit 0              |

## Scope

**In scope**:

- `packages/server/src/server/agent/providers/opencode-agent.ts`
- `packages/server/src/server/agent/providers/opencode/server-manager.ts`
- `packages/server/src/server/agent/providers/opencode/project-instance-leases.ts`
- `packages/server/src/server/agent/providers/opencode/project-instance-leases.test.ts`
- `packages/server/src/server/agent/providers/opencode/test-server-manager.ts`
- `packages/server/src/server/agent/providers/opencode-agent.test.ts`

**Read only**: `docs/providers.md`.

**Out of scope**:

- Changing when final-lease disposal occurs.
- Disabling disposal or using a process-global key without generation identity.
- Child-directory routing; plan 005 builds on this coordinator.

## Git workflow

- Branch: `advisor/004-share-project-lease-coordinator`
- Commit: `fix(opencode): share project lease accounting`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Write the cross-client regression

Create two `OpenCodeAgentClient` instances that share one test server manager,
generation, and directory but use observable SDK clients. Open one scope/session
through each. Release the first and assert `instance.dispose` has not run;
release the second and assert exactly one disposal for that directory. Repeat
with distinct directories and assert independent final disposal.

Prefer a narrow exported test seam for `openProjectScope` only if existing
session construction cannot express the lifecycle without unrelated setup.

**Verify**: targeted `opencode-agent.test.ts` fails against current code because
the first release disposes early.

### Step 2: Move coordinator ownership to the shared manager

Make the lease coordinator a lifecycle-owned member of
`OpenCodeServerManagerLike`/`OpenCodeServerManager`, constructed once per manager
with the manager logger and cleared on manager shutdown. Update the test manager
to provide the same contract. Remove the per-client coordinator construction;
`openProjectScope` must acquire through the manager-owned coordinator.

Keep keys as both server generation identity and normalized directory. Keep the
disposer supplied by the current acquisition's SDK client, and preserve dirty
retry serialization.

**Verify**: project lease, OpenCode agent, and server-manager targeted tests pass.

### Step 3: Prove generation and shutdown isolation

Add tests that the same directory in two server generations has independent
counts and that manager shutdown clears coordinator state only after helper
shutdown begins. A new manager must not inherit state from an old manager.

**Verify**: targeted tests pass; no test depends on global ordering.

### Step 4: Finish checks

Run format, all three test files, typecheck, lint, and `git diff --check`.

**Verify**: every command exits 0; diff check is empty.

## Test plan

- Two clients/same generation/same normalized directory dispose only after the
  second release.
- Equivalent path spellings share a lease key.
- Different directories and different generations are independent.
- Dirty disposal still retries before the next acquire.
- Shutdown/reset does not leak state into a new manager.

## Done criteria

- [ ] No `OpenCodeAgentClient` constructs a private lease coordinator.
- [ ] Lease ownership matches shared helper-manager ownership.
- [ ] Cross-client regression passes.
- [ ] Existing dirty/retry behavior remains covered.
- [ ] Targeted tests, server typecheck, lint, and format pass.
- [ ] Index updated.

## STOP conditions

- The manager object is not shared by every derived OpenCode client at runtime.
- Moving ownership creates an import cycle that affects runtime initialization;
  report the cycle rather than hiding it with `any` or dynamic imports.
- Correctness appears to require dropping generation identity or final disposal.
- Verification fails twice after a reasonable fix.

## Maintenance notes

Any future OpenCode client factory must receive the same manager object to join
lease accounting. Reviewers should verify the coordinator is cleared at the
manager lifecycle boundary, not whenever any wrapper client shuts down.
