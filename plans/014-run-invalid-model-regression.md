# Plan 014: Put the OpenCode invalid-model regression in the CLI runner

> **Executor instructions**: Follow this plan without running the full CLI test
> suite locally. Use the exact single-file command below. Update the plan index
> when done and stop if test number 37 has been claimed.
>
> **Drift check (run first)**:
> `git diff --stat 0721f898e..HEAD -- packages/cli/tests/run-all.ts packages/cli/tests/e2e/opencode-invalid-model.test.ts packages/cli/tests/37-opencode-invalid-model.test.ts packages/cli/tests/helpers/test-daemon.ts docs/opencode-global-event-baseline.md`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `0721f898e`, 2026-07-20

## Why this matters

The invalid-model CLI scenario is a standalone script under `tests/e2e`, while
the local CLI runner discovers only root files matching
`/^\d{2}-.*\.test\.ts$/`. It is therefore absent from the actual test matrix,
and its current fallback branch can accept exit zero as long as a weak
completed/running combination is avoided. The regression should enforce a
bounded terminal failure in the runner CI already executes.

## Current state

- `packages/cli/tests/run-all.ts` discovers numbered root test files, builds the
  server stack once, and executes each with `npx tsx`.
- The highest prefix at planning time is 36; duplicate lower numbers already
  exist. Use `37-opencode-invalid-model.test.ts` only if still free.
- `packages/cli/tests/e2e/opencode-invalid-model.test.ts` starts an isolated
  daemon and runs `paseo run --provider opencode/adklasldkdas hello`.
- If the command exits nonzero it only checks generic error text. If it exits
  zero, it accepts most states and asserts only that run did not say completed
  while inspect still says running.
- `docs/opencode-global-event-baseline.md` records this file as failing Vitest
  with “No test suite found”; update that historical result with the new runner
  coverage, not by pretending it was a Vitest suite.
- Repository rules prohibit the full local test suite. Build once, then execute
  only the new numbered script.

## Commands you will need

| Purpose      | Command                                                                                                                               | Expected on success             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Build        | `npm run build:server`                                                                                                                | exit 0                          |
| Targeted E2E | `npx tsx packages/cli/tests/37-opencode-invalid-model.test.ts`                                                                        | exit 0, test prints pass banner |
| Typecheck    | `npm run typecheck:server`                                                                                                            | exit 0                          |
| Lint         | `npm run lint -- packages/cli/tests/37-opencode-invalid-model.test.ts`                                                                | exit 0                          |
| Format       | `npm run format:files -- packages/cli/tests/37-opencode-invalid-model.test.ts docs/opencode-global-event-baseline.md plans/README.md` | exit 0                          |

## Scope

**In scope**:

- `packages/cli/tests/37-opencode-invalid-model.test.ts` (create)
- `packages/cli/tests/e2e/opencode-invalid-model.test.ts` (delete after port)
- `docs/opencode-global-event-baseline.md`

**Read only**:

- `packages/cli/tests/run-all.ts`
- `packages/cli/tests/helpers/test-daemon.ts`
- nearby numbered CLI tests.

**Out of scope**:

- Editing runner discovery; the numbered file should work with it unchanged.
- Fixing provider invalid-model behavior if the strengthened test exposes a real
  production bug; report it separately.
- Running `npm run test:local --workspace=@getpaseo/cli` locally.

## Git workflow

- Branch: `advisor/014-run-invalid-model-regression`
- Commit: `test(cli): run OpenCode invalid model regression`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Reserve the next test prefix

Run `find packages/cli/tests -maxdepth 1 -name '37-*.test.ts' -print`. It must
print nothing. If occupied, select the next free two-digit prefix, update this
plan/index references, and report the drift before editing.

**Verify**: selected target appears exactly once after creation.

### Step 2: Port to the numbered script style

Create the numbered root file with the standard `#!/usr/bin/env npx tsx`, pass
banners, top-level `try/finally`, and `createE2ETestContext` isolation used by
nearby tests. Ensure cleanup always stops the daemon. Preserve the invalid model
input and bounded command/inspect timeouts.

Strengthen the contract:

- `paseo run` must exit nonzero within its timeout;
- combined output must clearly indicate failure and must not report completed;
- if an agent ID is emitted, poll/inspect to a terminal error state and assert it
  is neither running nor completed;
- timeout is failure, never an accepted branch.

Use stable JSON output for inspect/status if the CLI supports it; otherwise use
the established parser from a nearby numbered test.

**Verify**: after build, the single-file E2E exits 0.

### Step 3: Remove the orphan and update the baseline

Delete the old `tests/e2e` script only after the numbered test passes. Update
`docs/opencode-global-event-baseline.md` with a dated follow-up: it is now a CLI
runner script, the targeted command, and the observed pass. Preserve the
historical before/post-change facts.

**Verify**: `test ! -e packages/cli/tests/e2e/opencode-invalid-model.test.ts`
exits 0, and `rg -n "37-opencode-invalid-model" docs/opencode-global-event-baseline.md packages/cli/tests/run-all.ts packages/cli/tests` finds the new test/docs.

### Step 4: Finish checks

Run format, build, the targeted script, typecheck, lint, and `git diff --check`.

**Verify**: all commands exit 0; no full suite was run.

## Test plan

- Invalid model terminates with a nonzero CLI result inside 45 seconds.
- Output reports failure and never completion.
- Any persisted agent reaches error, not running/completed.
- Isolated daemon/home are removed in `finally`.
- Runner discovery sees the numbered file automatically.

## Done criteria

- [ ] Exactly one runnable invalid-model CLI test exists.
- [ ] The test has a numbered root filename discovered by `run-all.ts`.
- [ ] Weak exit-zero behavior is no longer accepted.
- [ ] Targeted E2E, build, typecheck, lint, and format pass.
- [ ] Baseline doc and index updated.

## STOP conditions

- Prefix 37 is occupied or runner discovery changed.
- The environment lacks the OpenCode binary/auth needed by the existing CLI
  matrix; report whether CI provides it rather than adding an unconditional skip.
- Strengthened assertions expose a production invalid-model lifecycle bug.
- Test requires the user's daemon on port 6767.
- Verification fails twice after a reasonable fix.

## Maintenance notes

Keep provider-backed CLI tests isolated from the production Paseo home/daemon.
If the runner gains explicit single-test filtering, update the verification
command here and in testing docs rather than running the full matrix.
