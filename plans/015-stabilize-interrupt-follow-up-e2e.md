# Plan 015: Track the interrupted OpenCode tool call by exact identity

> **Executor instructions**: Follow every step and targeted test. The real E2E
> requires configured OpenCode credentials; a skip is not proof of completion.
> Update `plans/README.md` only after the required configured run is green.
>
> **Drift check (run first)**:
> `git diff --stat 0721f898e..HEAD -- packages/server/src/server/daemon-e2e/opencode-send-interrupt.real.e2e.test.ts packages/server/src/server/agent/providers/opencode/tool-call-mapper.ts packages/server/src/server/agent/providers/opencode/tool-call-mapper.test.ts packages/server/src/server/agent/providers/opencode-agent.test.ts docs/opencode-global-event-baseline.md`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `0721f898e`, 2026-07-20

## Why this matters

The real interrupt test observes a running shell call, interrupts the agent, then
searches the latest timeline again by command text. Its failure diagnostics show
a failed bash call exists, yet the predicate times out. Capturing the exact
`callId` at the running transition distinguishes a brittle rediscovery bug from
a real provider mapping bug and keeps the follow-up-turn assertion meaningful.

## Current state

- `opencode-send-interrupt.real.e2e.test.ts:56-79` finds a sleep tool call by
  shell detail whose command includes `sleep 60`.
- `waitForRunningBashToolCall` returns `void` and may succeed from stream data or
  any running bash/shell timeline entry without returning identity.
- `waitForSleepToolCallTerminal` repeatedly rediscovers by command text, then
  returns a terminal call ID.
- The explicit interrupt test expects the terminal status to be `failed`, sends
  a follow-up token, and requires an idle successful turn with no system error.
- `docs/opencode-global-event-baseline.md` records that this test times out even
  while recent tool calls show a failed bash entry.
- `tool-call-mapper.test.ts` is the focused home for stable OpenCode call-ID
  mapping across status updates.

## Commands you will need

| Purpose    | Command                                                                                                                                                                                                                                                                                                                                                                                | Expected on success                                      |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Unit tests | `npx vitest run packages/server/src/server/agent/providers/opencode/tool-call-mapper.test.ts packages/server/src/server/agent/providers/opencode-agent.test.ts --bail=1`                                                                                                                                                                                                               | exit 0                                                   |
| Real E2E   | `npx vitest run packages/server/src/server/daemon-e2e/opencode-send-interrupt.real.e2e.test.ts --maxWorkers=1 --bail=1`                                                                                                                                                                                                                                                                | configured run executes and passes; skip is insufficient |
| Typecheck  | `npm run typecheck:server`                                                                                                                                                                                                                                                                                                                                                             | exit 0                                                   |
| Lint       | `npm run lint -- packages/server/src/server/daemon-e2e/opencode-send-interrupt.real.e2e.test.ts packages/server/src/server/agent/providers/opencode/tool-call-mapper.ts packages/server/src/server/agent/providers/opencode/tool-call-mapper.test.ts packages/server/src/server/agent/providers/opencode-agent.test.ts`                                                                | exit 0                                                   |
| Format     | `npm run format:files -- packages/server/src/server/daemon-e2e/opencode-send-interrupt.real.e2e.test.ts packages/server/src/server/agent/providers/opencode/tool-call-mapper.ts packages/server/src/server/agent/providers/opencode/tool-call-mapper.test.ts packages/server/src/server/agent/providers/opencode-agent.test.ts docs/opencode-global-event-baseline.md plans/README.md` | exit 0                                                   |

## Scope

**In scope**:

- `packages/server/src/server/daemon-e2e/opencode-send-interrupt.real.e2e.test.ts`
- `packages/server/src/server/agent/providers/opencode/tool-call-mapper.ts` only
  if the identity regression proves a production bug
- `packages/server/src/server/agent/providers/opencode/tool-call-mapper.test.ts`
- `packages/server/src/server/agent/providers/opencode-agent.test.ts` only for a
  provider-level identity regression
- `docs/opencode-global-event-baseline.md`

**Out of scope**:

- Weakening expected interrupted status or follow-up success.
- Matching “any failed shell call” after interrupt.
- Increasing timeouts to hide identity mismatch.
- Changing interrupt implementation without a failing mapper/provider unit test.

## Git workflow

- Branch: `advisor/015-stabilize-interrupt-follow-up-e2e`
- Commit: `test(opencode): track interrupted tool call identity` for test-only;
  use a separate `fix(opencode): preserve tool call identity` commit only if a
  production mapper fix is proven.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Return the running call identity

Refactor the running wait helper to return `{callId, name, command}` from a
timeline entry that is both running and matches the exact intended `sleep 60`
command. Stream activity may prompt polling but must not let the helper return
without an identity. Include recent call IDs, commands, and statuses in timeout
diagnostics.

**Verify**: TypeScript compiles and the explicit interrupt test passes the
captured ID to the terminal wait helper.

### Step 2: Wait only for that call ID

Replace command-text rediscovery after interrupt with lookup by the captured
`callId`. Assert that exact call becomes `failed`; if it disappears, completes,
or is replaced by a different ID, fail with both identities and recent timeline
entries. Keep the next-turn token and no-system-error assertions unchanged.

**Verify**: real E2E in a configured environment no longer times out when the
captured call is already terminal.

### Step 3: Pin mapper identity across status transitions

Add a deterministic unit fixture representing the upstream running and failed
updates for one tool call. Assert both translate to the same Paseo `callId` and
the later event updates status rather than creating a second logical item.

If this test fails, fix only the central mapper/translation identity derivation,
then rerun provider unit tests. Do not add test-only aliasing in the real E2E.

**Verify**: both unit test files pass.

### Step 4: Update the baseline only after execution

After a non-skipped configured real run passes, append a dated follow-up to
`docs/opencode-global-event-baseline.md` describing exact-ID tracking and the
command/result. Preserve the historical failure. If the test skips, do not mark
the baseline resolved.

**Verify**: doc names the exact real E2E command and successful execution date.

### Step 5: Finish checks

Run format, unit tests, a configured real E2E, typecheck, lint, and
`git diff --check`.

**Verify**: all checks pass; the real test reports executed, not skipped.

## Test plan

- Running and failed updates for one upstream call retain one `callId`.
- E2E captures the intended command's identity before interrupt.
- Exact call reaches `failed`.
- Follow-up turn reaches idle, returns token, and emits no system error.
- Diagnostics distinguish disappearance, ID replacement, wrong terminal status,
  and timeout.

## Done criteria

- [ ] The real test never rediscovers the interrupted call by command after
      capture.
- [ ] Stable mapper identity has focused unit coverage.
- [ ] Configured real E2E executes and passes.
- [ ] Existing semantic assertions are not weakened.
- [ ] Typecheck, lint, format, docs, and index are updated.

## STOP conditions

- Upstream legitimately changes tool call IDs across running/terminal updates.
- Timeline compaction removes the captured call before the 45-second wait.
- The real provider test cannot execute because credentials/binary are absent.
- Fixing identity requires changing the public protocol ID contract.
- Verification fails twice after a reasonable fix.

## Maintenance notes

Identity-first waits should be the pattern for mutable timeline items. Model
output can vary, but once a concrete call is observed its lifecycle assertions
must never switch to another matching command.
