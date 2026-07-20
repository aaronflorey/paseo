# Plan 005: Lease and route child-session operations by child directory

> **Executor instructions**: Complete plan 004 first. Follow this plan exactly,
> run every verification, and update `plans/README.md` on completion. Do not
> paper over an unknown child directory with the parent directory.
>
> **Drift check (run first)**:
> `git diff --stat 0721f898e..HEAD -- packages/server/src/server/agent/providers/opencode-agent.ts packages/server/src/server/agent/providers/opencode-agent.test.ts packages/server/src/server/agent/providers/opencode/project-instance-leases.ts docs/providers.md docs/agent-lifecycle.md`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/004-share-project-lease-coordinator.md`
- **Category**: bug
- **Planned at**: commit `0721f898e`, 2026-07-20

## Why this matters

OpenCode child sessions can run in a directory different from their parent.
Hydration currently discovers the child directory but recursively lists nested
children through the root directory and performs several child operations
without a matching project lease. This can route requests to the wrong project
instance or allow root-scope cleanup to dispose configuration during an active
child operation.

## Current state

- `opencode-agent.ts:3989-4078` implements `hydrateChildSessions`. Its queue
  stores only session IDs. Recursive `listOpenCodeChildSessions` calls use
  `this.config.cwd`, even after each child's own directory is known.
- Child status and message hydration already have access to a child directory;
  message hydration passes that directory to the SDK but does not acquire a
  project lease for it.
- Provider-child permission/question response paths remember the child
  directory and send replies there, but the session's long-lived scope covers
  only the root directory.
- `opencode-agent.test.ts` contains provider-child question/permission tests,
  including a child under `/workspace/question-child`. Extend these fixtures.
- Plan 004 makes the coordinator shared across clients; all child scopes in this
  plan must use that shared coordinator and the current helper generation.
- `docs/agent-lifecycle.md` defines parent/child relationships; do not change
  archive or visibility semantics.

## Commands you will need

| Purpose   | Command                                                                                                                                                                                                                                                 | Expected on success |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Tests     | `npx vitest run packages/server/src/server/agent/providers/opencode-agent.test.ts packages/server/src/server/agent/providers/opencode/project-instance-leases.test.ts --bail=1`                                                                         | exit 0              |
| Typecheck | `npm run typecheck:server`                                                                                                                                                                                                                              | exit 0              |
| Lint      | `npm run lint -- packages/server/src/server/agent/providers/opencode-agent.ts packages/server/src/server/agent/providers/opencode-agent.test.ts packages/server/src/server/agent/providers/opencode/project-instance-leases.ts`                         | exit 0              |
| Format    | `npm run format:files -- packages/server/src/server/agent/providers/opencode-agent.ts packages/server/src/server/agent/providers/opencode-agent.test.ts packages/server/src/server/agent/providers/opencode/project-instance-leases.ts plans/README.md` | exit 0              |

## Scope

**In scope**:

- `packages/server/src/server/agent/providers/opencode-agent.ts`
- `packages/server/src/server/agent/providers/opencode-agent.test.ts`
- `packages/server/src/server/agent/providers/opencode/project-instance-leases.ts`
- `packages/server/src/server/agent/providers/opencode/project-instance-leases.test.ts`

**Read only**: `docs/providers.md`, `docs/agent-lifecycle.md`.

**Out of scope**:

- Changing how parent/child identities are exposed to the app.
- Holding every discovered child lease for the full parent-session lifetime
  without evidence it is needed.
- Falling back to root cwd when OpenCode reports a concrete child directory.

## Git workflow

- Branch: `advisor/005-lease-child-session-directories`
- Commit: `fix(opencode): lease child session project scopes`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add a cross-directory grandchild regression

Extend the existing child fixtures so a root session in `/workspace/root` has a
child in `/workspace/child`, which has a grandchild in `/workspace/grandchild`.
Record directory arguments for child-list, status, messages, permission reply,
question reply/reject, and instance disposal calls. Assert every operation uses
the directory belonging to the session it targets.

Add a deferred child operation and prove releasing the root scope cannot dispose
the child directory until that operation finishes.

**Verify**: targeted OpenCode agent test fails against current code at the
recursive child-list directory or early disposal assertion.

### Step 2: Carry directory identity through traversal

Change the hydration queue from bare session IDs to records containing at least
`sessionId` and `directory`. Seed the root with `this.config.cwd`; enqueue each
child with its reported directory; use the dequeued directory when asking for
that session's children. Keep cycle/dedup protection keyed by stable session
identity, and do not treat directory as the parent/child identity.

If a child has no usable directory, STOP and report the actual SDK payload and
existing normalization behavior instead of guessing.

**Verify**: the grandchild routing assertions pass.

### Step 3: Introduce a narrow leased-operation helper

Within `OpenCodeAgentSession`, add one internal helper that acquires the shared
manager's project lease for `(current generation, target directory)`, executes
one SDK operation, and releases in `finally`. Use the already-held server
acquisition/generation; do not acquire a second helper ref merely to lease a
directory unless the manager contract requires it.

Apply it to finite child-directory operations: child listing, status/message
hydration, and provider-child permission/question responses. Avoid double
leasing root operations that are already protected by the session root scope.

**Verify**: deferred-operation regression proves disposal waits; response tests
still send exactly once to the child directory.

### Step 4: Cover failure and cancellation cleanup

For each leased helper path, ensure rejected SDK calls and session close release
the lease exactly once. Preserve the original operation error; disposal errors
follow the coordinator's dirty/retry policy and must not mask it.

**Verify**: add rejection tests and run both targeted test files successfully.

### Step 5: Finish checks

Run format, targeted tests, server typecheck, lint, and `git diff --check`.

**Verify**: all commands exit 0 and diff check prints nothing.

## Test plan

- Root/child/grandchild operations use their respective directories.
- A child operation holds the child project lease until settlement.
- Same-directory children share counts with root/client leases from plan 004.
- Different-directory children dispose independently after final use.
- Success, rejection, reply, reject, and close paths release exactly once.

## Done criteria

- [ ] No recursive child listing hard-codes `this.config.cwd` for a known child.
- [ ] Every finite cross-directory child SDK operation has shared lease coverage.
- [ ] No lease leaks or early disposal in success/failure/close tests.
- [ ] Targeted tests, typecheck, lint, and format pass.
- [ ] Index updated.

## STOP conditions

- OpenCode omits a directory for a child whose operation requires one.
- A child operation can outlive the helper generation and no generation identity
  is available at execution time.
- Correctness requires changing parent/child protocol identity or archive rules.
- Verification fails twice after a reasonable fix.

## Maintenance notes

Keep directory routing and lease acquisition in one helper so new child
operations cannot update one without the other. Reviewers should look for any
remaining child-targeted SDK call that bypasses that helper.
