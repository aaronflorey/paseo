# Plan 003: Reject conflicting OpenCode helper runtime settings

> **Executor instructions**: Complete plans 001 and 002 first. Follow every
> verification gate and update `plans/README.md` when done. Stop and report on a
> STOP condition; do not introduce a second OpenCode helper as a workaround.
>
> **Drift check (run first)**:
> `git diff --stat 0721f898e..HEAD -- packages/server/src/server/agent/providers/opencode/server-manager.ts packages/server/src/server/agent/providers/opencode-server-manager.test.ts packages/server/src/server/agent/provider-registry.ts packages/server/src/server/agent/provider-registry.test.ts docs/custom-providers.md docs/providers.md`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: `plans/001-redact-runtime-settings-logs.md`, `plans/002-preserve-client-wrapper-contract.md`
- **Category**: bug
- **Planned at**: commit `0721f898e`, 2026-07-20

## Why this matters

All OpenCode clients intentionally share one helper process. Today the first
client's command, environment, and inline configuration silently win; later
profiles with different credentials or binaries receive only a warning and run
against the wrong helper. Until helper-global settings can be routed safely, a
clear value-free rejection is safer than cross-profile credential confusion.

## Current state

- `server-manager.ts:getInstance()` compares serialized runtime settings and
  returns the existing singleton even when they differ.
- `provider-registry.ts:704-730` materializes derived profiles that may each
  carry distinct runtime settings.
- `opencode-agent.ts:133-142` session context includes launch-context env, but
  helper launch settings are resolved once in `server-manager.ts:280-287`.
  Therefore a later profile cannot repair a helper-global mismatch per session.
- `docs/providers.md` documents the intentional one-process OpenCode design and
  project instance lease model. Keep that architecture.
- `docs/custom-providers.md` currently presents profiles as independent places
  for credentials/custom binaries; it must explicitly describe the OpenCode
  shared-helper restriction and the fail-closed result.
- Protocol compatibility is not involved: this is daemon-local validation and
  must not change a wire schema.

## Commands you will need

| Purpose   | Command                                                                                                                                                                                                                                                                                                                              | Expected on success |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| Tests     | `npx vitest run packages/server/src/server/agent/providers/opencode-server-manager.test.ts packages/server/src/server/agent/provider-registry.test.ts --bail=1`                                                                                                                                                                      | exit 0              |
| Typecheck | `npm run typecheck:server`                                                                                                                                                                                                                                                                                                           | exit 0              |
| Lint      | `npm run lint -- packages/server/src/server/agent/providers/opencode/server-manager.ts packages/server/src/server/agent/provider-registry.ts packages/server/src/server/agent/providers/opencode-server-manager.test.ts packages/server/src/server/agent/provider-registry.test.ts`                                                  | exit 0              |
| Format    | `npm run format:files -- packages/server/src/server/agent/providers/opencode/server-manager.ts packages/server/src/server/agent/provider-registry.ts packages/server/src/server/agent/providers/opencode-server-manager.test.ts packages/server/src/server/agent/provider-registry.test.ts docs/custom-providers.md plans/README.md` | exit 0              |

## Scope

**In scope**:

- `packages/server/src/server/agent/providers/opencode/server-manager.ts`
- `packages/server/src/server/agent/providers/opencode-server-manager.test.ts`
- `packages/server/src/server/agent/provider-registry.ts`
- `packages/server/src/server/agent/provider-registry.test.ts`
- `docs/custom-providers.md`

**Read only**: `docs/providers.md`, `packages/protocol/src/provider-config.ts`.

**Out of scope**:

- Starting one helper per profile or project.
- Moving credentials onto OpenCode session requests without upstream proof.
- Any protocol schema, capability flag, or fallback path.

## Git workflow

- Branch: `advisor/003-reject-conflicting-runtime-settings`
- Commit: `fix(opencode): reject conflicting shared helper settings`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Define canonical helper-global equality

In `server-manager.ts`, centralize comparison of every setting that affects
helper launch: command/binary, command arguments, runtime environment, and
inline OpenCode config. Treat missing and explicitly empty values consistently
only if they produce the same launch. Do not compare per-session launch-context
environment here.

Expose a value-free mismatch description for plan 001's safe diagnostic. Do not
include values or serialized settings in an error.

**Verify**: add table tests for identical, reordered environment keys, changed
env value, changed command, changed args, and changed config. Targeted tests pass.

### Step 2: Fail closed before returning the singleton

Change `getInstance()` so a helper-global mismatch throws a stable error before
returning the existing manager. The message must explain that OpenCode uses one
shared helper and conflicting profile runtime settings cannot coexist, while
naming only safe field categories. The existing helper must remain alive and
unchanged after rejection.

Add canary assertions inherited from plan 001 to prove the error and logs contain
no value. Identical settings must still reuse the exact manager instance.

**Verify**: server-manager tests exit 0.

### Step 3: Surface profile construction failures cleanly

Add/adjust registry coverage for two OpenCode profiles with identical settings
and with conflicting settings. The conflict must surface deterministically at
registry materialization or first client construction; it must never leave a
partially registered derived provider that points at the wrong helper. Preserve
the complete wrapper contract from plan 002.

Do not catch the error and fall back to the first profile.

**Verify**: both targeted test files pass.

### Step 4: Document the constraint

Update the OpenCode/custom-profile section in `docs/custom-providers.md`: all
OpenCode clients in a daemon share one local helper; helper-global command/env/
inline config must match; a mismatch is rejected; use one shared configuration
or a separate Paseo daemon/home when true isolation is required. Do not claim
per-profile OpenCode helper processes exist.

**Verify**: `npm run format:check:files -- docs/custom-providers.md` exits 0.

### Step 5: Finish checks

Run format, targeted tests, typecheck, lint, and `git diff --check`.

**Verify**: all exit 0 with no diff-check output.

## Test plan

- Canonically identical settings reuse the singleton.
- Every helper-global category mismatch is rejected.
- Rejection contains categories but no canary values.
- Existing helper remains usable after a rejected request.
- Registry never exposes a derived provider backed by the wrong settings.

## Done criteria

- [ ] No OpenCode client silently inherits conflicting helper settings.
- [ ] One shared-helper architecture remains intact.
- [ ] Error/log paths are value-free.
- [ ] Targeted tests, server typecheck, lint, and docs format pass.
- [ ] Index updated.

## STOP conditions

- Upstream SDK documentation proves a supposedly global setting is safely
  routeable per request; report the evidence before redesigning.
- Rejecting during registry construction would make all unrelated providers
  unavailable and no narrower deterministic boundary exists.
- A fix requires a second helper process, wire change, or credential fallback.
- Tests fail twice after a reasonable fix.

## Maintenance notes

This is a deliberate fail-closed boundary, not the final multi-profile design.
If OpenCode later supports per-request configuration, replace the rejection only
with executable isolation tests and update the docs in the same change.
