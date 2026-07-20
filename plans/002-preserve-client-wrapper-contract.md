# Plan 002: Preserve the full derived-provider client contract

> **Executor instructions**: Follow the plan exactly, including every
> verification. Stop on a STOP condition instead of widening scope. Update this
> plan's row in `plans/README.md` when complete unless the dispatcher owns it.
>
> **Drift check (run first)**:
> `git diff --stat 0721f898e..HEAD -- packages/server/src/server/agent/provider-registry.ts packages/server/src/server/agent/provider-registry-wrap.test.ts packages/server/src/server/agent/agent-sdk-types.ts`
> Compare all changed interface members with the checklist below before editing.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `0721f898e`, 2026-07-20

## Why this matters

Custom profiles and model overrides are implemented by wrapping a base
`AgentClient`. The wrapper currently drops the third `createSession` argument
and several optional client methods. For OpenCode this can disable persistent
sessions, command discovery, native archive behavior, and helper shutdown only
when a derived provider is used, making the failure configuration-dependent.

## Current state

- `packages/server/src/server/agent/provider-registry.ts:391-488` defines
  `wrapClientProvider`. Its `createSession` callback accepts only
  `(config, launchContext)` and calls `inner.createSession(...)` without
  `AgentCreateSessionOptions`.
- The same returned object delegates catalog/import/availability methods but
  omits client-level `listCommands`, `archiveNativeSession`,
  `unarchiveNativeSession`, and `shutdown`.
- `packages/server/src/server/agent/agent-sdk-types.ts:684-737` is the contract:
  `createSession(config, launchContext?, options?)` and the optional methods
  above are part of `AgentClient`.
- `packages/server/src/server/agent/providers/opencode-agent.ts` consumes
  `options?.persistSession` in `createSession`, implements native archive hooks,
  and shuts down the shared helper in `shutdown`.
- `packages/server/src/server/agent/provider-registry-wrap.test.ts` already has
  compile-time and runtime coverage for `wrapSessionProvider`; extend that
  pattern to the client wrapper instead of creating a second test style.

## Commands you will need

| Purpose   | Command                                                                                                                                                         | Expected on success |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Test      | `npx vitest run packages/server/src/server/agent/provider-registry-wrap.test.ts --bail=1`                                                                       | exit 0              |
| Typecheck | `npm run typecheck:server`                                                                                                                                      | exit 0              |
| Lint      | `npm run lint -- packages/server/src/server/agent/provider-registry.ts packages/server/src/server/agent/provider-registry-wrap.test.ts`                         | exit 0              |
| Format    | `npm run format:files -- packages/server/src/server/agent/provider-registry.ts packages/server/src/server/agent/provider-registry-wrap.test.ts plans/README.md` | exit 0              |

## Scope

**In scope**:

- `packages/server/src/server/agent/provider-registry.ts`
- `packages/server/src/server/agent/provider-registry-wrap.test.ts`

**Read only**:

- `packages/server/src/server/agent/agent-sdk-types.ts`

**Out of scope**:

- Changing the `AgentClient` interface.
- Changing provider/profile resolution or model merge semantics.
- Changing session-level wrapper behavior except where a regression proves it
  prevents correct client delegation.

## Git workflow

- Branch: `advisor/002-preserve-client-wrapper-contract`
- One commit: `fix(server): preserve derived provider client contract`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Make interface drift testable

Extend `provider-registry-wrap.test.ts` with a typed fake `AgentClient` whose
optional methods record arguments and `this` binding. Reach `wrapClientProvider`
through the smallest test seam: prefer exporting it through an explicitly named
test-only internals object from `provider-registry.ts`, matching local internals
patterns. Do not make it part of a public package API.

Add a compile-time exhaustive list of client methods intentionally handled by
the wrapper. Use `satisfies`/key checks so a future `AgentClient` method addition
fails typecheck until the wrapper policy is updated.

**Verify**: targeted Vitest compiles; at least one new runtime assertion fails
against the current wrapper.

### Step 2: Forward the complete contract

Update `wrapClientProvider` so:

- `createSession` accepts and forwards `options` unchanged as the third arg;
- provider identity is remapped only in config/handle shapes, as today;
- `listCommands`, `archiveNativeSession`, `unarchiveNativeSession`, and
  `shutdown` are exposed only when the inner method exists;
- delegated optional methods preserve `this` binding and return/rejection
  behavior;
- each lifecycle call executes exactly once.

Keep the existing catalog/model decoration and import mapping unchanged.

**Verify**: targeted Vitest exits 0 with exact argument, provider-remap, return
value, `this`, and once-only assertions.

### Step 3: Exercise absent optionals and interface coverage

Add a fake without optional hooks and assert the wrapper also omits them rather
than installing misleading no-op functions. Include `persistSession: false` and
another opaque option value in the `createSession` assertion so the test proves
the same object reaches the inner client.

**Verify**: targeted Vitest exits 0; `npm run typecheck:server` exits 0.

### Step 4: Finish repository checks

Run format, targeted test, typecheck, lint, and `git diff --check`.

**Verify**: every command exits 0 and diff check has no output.

## Test plan

- Third `createSession` options argument is forwarded by identity.
- Config, resume handle, overrides, and imported persistence retain the existing
  provider remapping.
- Every optional client hook delegates once with correct arguments and `this`.
- Missing optional hooks remain `undefined`.
- Compile-time method accounting breaks when `AgentClient` gains an unhandled
  member.

## Done criteria

- [ ] Derived OpenCode profiles expose the same client capabilities as the base.
- [ ] The client wrapper has exhaustive compile-time member accounting.
- [ ] Targeted test, typecheck, and lint pass.
- [ ] No public interface or unrelated source file changes.
- [ ] Plan index updated.

## STOP conditions

- The wrapper cannot be tested without exporting a public API.
- A newly discovered client method needs provider-ID remapping whose semantics
  are unclear.
- Delegating `shutdown` would make multiple wrappers shut down a still-owned
  shared client; report the ownership graph before proceeding.
- Verification fails twice after a reasonable fix.

## Maintenance notes

The exhaustive key list is deliberate: adding an `AgentClient` member must force
a wrapper decision. Reviewers should scrutinize lifecycle hooks and provider-ID
mapping more closely than mechanical delegates.
