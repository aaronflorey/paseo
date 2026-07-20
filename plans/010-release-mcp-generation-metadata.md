# Plan 010: Release MCP registration metadata with helper generations

> **Executor instructions**: Complete plans 004 and 009 first if they have been
> started in the same branch. Follow all gates and update the plan index. Keep
> MCP config values out of logs and diagnostics.
>
> **Drift check (run first)**:
> `git diff --stat 0721f898e..HEAD -- packages/server/src/server/agent/providers/opencode-agent.ts packages/server/src/server/agent/providers/opencode-agent.test.ts packages/server/src/server/agent/providers/opencode/server-manager.ts packages/server/src/server/agent/providers/opencode-server-manager.test.ts packages/server/src/server/agent/providers/opencode/test-server-manager.ts`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/004-share-project-lease-coordinator.md`
- **Category**: security
- **Planned at**: commit `0721f898e`, 2026-07-20

## Why this matters

MCP registration state is stored in a strong module-level map keyed by helper
generation. Values include serialized MCP configuration, which can contain
environment values and headers. Entries are cleared only by full client
shutdown, so ordinary helper rotation retains dead-generation metadata and
credentials indefinitely.

## Current state

- `opencode-agent.ts:318-321` declares
  `Map<object, Map<string,{serializedConfig, ready}>>`.
- `serializeOpenCodeMcpConfig` includes the complete config; local/remote MCP
  shapes may contain env and headers.
- `registerOpenCodeProjectMcpServers:4787-4823` creates per-generation,
  per-project entries and removes only failed registrations.
- `OpenCodeAgentClient.shutdown()` clears the whole map, but
  `server-manager.ts` kills/rotates individual generations during ordinary use
  without notifying this registry.
- Plan 004 places generation-owned lease state under the shared manager. Follow
  the same lifecycle ownership principle.
- Plan 009 establishes that `kill-timeout` is not a confirmed generation end;
  cleanup must wait for a real exit in that case.

## Commands you will need

| Purpose   | Command                                                                                                                                                                                                                                                                                                                                                                                              | Expected on success |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Tests     | `npx vitest run packages/server/src/server/agent/providers/opencode-agent.test.ts packages/server/src/server/agent/providers/opencode-server-manager.test.ts --bail=1`                                                                                                                                                                                                                               | exit 0              |
| Typecheck | `npm run typecheck:server`                                                                                                                                                                                                                                                                                                                                                                           | exit 0              |
| Lint      | `npm run lint -- packages/server/src/server/agent/providers/opencode-agent.ts packages/server/src/server/agent/providers/opencode-agent.test.ts packages/server/src/server/agent/providers/opencode/server-manager.ts packages/server/src/server/agent/providers/opencode-server-manager.test.ts packages/server/src/server/agent/providers/opencode/test-server-manager.ts`                         | exit 0              |
| Format    | `npm run format:files -- packages/server/src/server/agent/providers/opencode-agent.ts packages/server/src/server/agent/providers/opencode-agent.test.ts packages/server/src/server/agent/providers/opencode/server-manager.ts packages/server/src/server/agent/providers/opencode-server-manager.test.ts packages/server/src/server/agent/providers/opencode/test-server-manager.ts plans/README.md` | exit 0              |

## Scope

**In scope**:

- `packages/server/src/server/agent/providers/opencode-agent.ts`
- `packages/server/src/server/agent/providers/opencode-agent.test.ts`
- `packages/server/src/server/agent/providers/opencode/server-manager.ts`
- `packages/server/src/server/agent/providers/opencode-server-manager.test.ts`
- `packages/server/src/server/agent/providers/opencode/test-server-manager.ts`

**Out of scope**:

- Changing MCP wire/config shapes or conflict equality.
- Logging serialized configs, environment values, headers, or project paths.
- Treating `kill-timeout` as terminal.

## Git workflow

- Branch: `advisor/010-release-mcp-generation-metadata`
- Commit: `fix(opencode): release generation MCP metadata`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add observable generation-resource ownership

Extend the shared manager contract with a generic, narrowly named way to attach
an idempotent cleanup callback to a concrete generation. The production manager
must invoke callbacks exactly once after confirmed process exit (natural exit or
confirmed termination), then remove its callback set. The test manager needs a
deterministic method to end a generation.

Do not couple `server-manager.ts` to MCP types. Do not run generation cleanup on
`kill-timeout` until a later real exit event arrives.

**Verify**: server-manager tests cover natural exit, confirmed kill, kill-timeout
then exit, duplicate exit, and manager shutdown.

### Step 2: Register MCP-map cleanup once per generation

When the first MCP metadata map is created for a generation, register one
generation cleanup that deletes that exact entry. Avoid one callback per project
and avoid capturing the serialized config in the callback. Full client shutdown
may still clear/reset the registry, but late generation callbacks must be safe
and must not delete a newer generation's entry.

If an explicit lifecycle registry would be substantially larger than a
`WeakMap`, STOP and present both options. A `WeakMap` is acceptable only if tests
prove dead generations cannot remain strongly reachable from the registry and
full-test reset semantics remain deterministic.

**Verify**: OpenCode agent tests expose a test-only entry count or lifecycle
probe without exposing values; rotation returns the count to baseline.

### Step 3: Test repeated rotation and credential canaries

Register a project MCP config with unique canary values, end its generation,
start another generation, and register a different config for the same project.
Assert no stale conflict occurs and the old entry is absent. Confirm that live
same-generation conflicting configs still reject as before and no log/error
contains canaries.

**Verify**: both targeted test files pass.

### Step 4: Finish checks

Run format, targeted tests, server typecheck, lint, and `git diff --check`.

**Verify**: all commands exit 0 with no diff-check output.

## Test plan

- Natural/confirmed generation end deletes MCP metadata once.
- `kill-timeout` retains metadata until actual exit.
- Repeated rotation does not grow live entry count.
- New generation can register changed config without stale conflict.
- Live-generation conflict behavior and credential redaction remain intact.

## Done criteria

- [ ] Dead confirmed generations retain no MCP registration entry.
- [ ] Cleanup follows manager generation lifecycle exactly once.
- [ ] No secret-bearing values are logged or exposed by test seams.
- [ ] Targeted tests, typecheck, lint, and format pass.
- [ ] Index updated.

## STOP conditions

- There is no reliable confirmed-generation-end event.
- Generation cleanup would run before an outstanding acquisition/project lease
  finishes.
- A proposed test seam exposes serialized configs or secret values.
- Verification fails twice after a reasonable fix.

## Maintenance notes

Use the generic generation-resource owner for future generation-keyed state.
Reviewers should verify cleanup is delayed after an unconfirmed force kill and
that callbacks do not retain the secret-bearing value they clean.
