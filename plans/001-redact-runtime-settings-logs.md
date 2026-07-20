# Plan 001: Redact OpenCode runtime-settings conflicts

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report; do not improvise. When done, update
> this plan's row in `plans/README.md` unless a reviewer owns the index.
>
> **Drift check (run first)**:
> `git diff --stat 0721f898e..HEAD -- packages/server/src/server/agent/providers/opencode/server-manager.ts packages/server/src/server/agent/providers/opencode-server-manager.test.ts`
> If either file changed, compare the current code with the state below before
> editing. A semantic mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `0721f898e`, 2026-07-20

## Why this matters

OpenCode provider settings may contain API keys, tokens, custom headers, and
inline configuration. The singleton manager currently serializes both the old
and requested settings directly into a warning when clients disagree, bypassing
the logger's path-based redaction because the secrets are already strings. A
configuration conflict must remain diagnosable without exposing any value.

## Current state

- `packages/server/src/server/agent/providers/opencode/server-manager.ts` owns
  the shared helper singleton. Its constructor stores
  `runtimeSettingsKey = JSON.stringify(runtimeSettings ?? {})`; `getInstance()`
  compares that key and logs both serialized strings as
  `existingRuntimeSettings` and `requestedRuntimeSettings`.
- `packages/protocol/src/provider-config.ts` permits arbitrary string values in
  provider runtime `env`, so the serialized strings can contain credentials.
- `packages/server/src/server/logger.ts` redacts known structured authorization
  paths. It cannot redact a secret embedded inside an already-serialized string.
- `packages/server/src/server/agent/providers/opencode-server-manager.test.ts`
  already supplies fake process/runtime dependencies and is the regression-test
  home for this singleton.

The internal comparison may remain exact; the security boundary is that raw
settings and serialized values never reach logs or thrown error messages.

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

**Out of scope**:

- Changing which runtime settings win; plan 003 handles conflict semantics.
- Broad logger-redaction changes.
- Protocol or provider-config schema changes.

## Git workflow

- Branch: `advisor/001-redact-runtime-settings-logs`
- Use one logical commit, e.g. `fix(opencode): redact runtime settings conflicts`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add a canary-secret regression

In `opencode-server-manager.test.ts`, initialize the singleton with runtime
settings containing unique canaries in environment, command, args, and config
content, then request it with different canaries. Capture the warning arguments
using the existing fake logger pattern. Assert that:

- a conflict warning is emitted;
- the warning identifies only safe categories that differ (for example
  `command`, `args`, `env`, or `configContent`), never values;
- `JSON.stringify(capturedWarning)` contains none of the canaries.

Reset the singleton using the existing test cleanup so the test is isolated.

**Verify**: run the targeted Vitest command. It must fail against the current
implementation specifically because a canary appears in the warning.

### Step 2: Replace raw settings in the warning

In `server-manager.ts`, compare settings without placing either settings object
or its JSON representation in logger fields. Emit a structured warning with a
stable message and a value-free list of top-level differing categories. Do not
list environment values, command arguments, inline config content, headers, or
serialized settings. Keep exact equality behavior unchanged for this plan.

Do not assume logger redaction will save an unsafe field; the arguments passed
to `logger.warn` must already be safe.

**Verify**: targeted Vitest exits 0 and the canary absence assertions pass.

### Step 3: Run repository checks

Run format, the targeted test, `npm run typecheck:server`, and targeted lint in
that order.

**Verify**: all four commands exit 0; `git diff --check` prints nothing.

## Test plan

- Existing identical settings still reuse the singleton without a warning.
- Different settings still produce one warning.
- Canaries in every supported runtime-settings value are absent from all log
  arguments and the formatted warning.
- The warning retains value-free diagnostic categories.

## Done criteria

- [ ] No runtime-settings values or serialized settings enter a log call.
- [ ] The targeted server-manager test passes with canary assertions.
- [ ] Typecheck and targeted lint pass.
- [ ] Only in-scope source/test files plus the plan index are modified.
- [ ] `plans/README.md` is updated.

## STOP conditions

- The runtime settings type no longer matches the fields exercised by the test.
- Making the warning safe appears to require changing singleton conflict behavior.
- Any proposed diagnostic includes a value, hash of a secret, or inline config.
- A verification command fails twice after a reasonable fix.

## Maintenance notes

Review future settings fields under the same rule: category names may be logged;
values may not. Plan 003 intentionally changes the conflict from warning-only to
fail-closed and must preserve this redaction guarantee.
