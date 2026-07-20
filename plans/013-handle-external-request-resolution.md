# Plan 013: Handle external permission and question resolution events

> **Executor instructions**: Complete plans 005 and 007 first. Follow every
> verification, preserve protocol compatibility, and update the plan index. Stop
> if the existing response type cannot truthfully represent an upstream event.
>
> **Drift check (run first)**:
> `git diff --stat 0721f898e..HEAD -- packages/server/src/server/agent/providers/opencode-agent.ts packages/server/src/server/agent/providers/opencode-agent.test.ts packages/server/src/server/agent/agent-sdk-types.ts packages/protocol/src/agent-types.ts`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: `plans/005-lease-child-session-directories.md`, `plans/007-reconnect-global-event-streams.md`
- **Category**: bug
- **Planned at**: commit `0721f898e`, 2026-07-20

## Why this matters

A permission or question can be answered outside Paseo, for example in another
OpenCode client. The global stream emits resolution events, but Paseo handles
only `permission.asked` and `question.asked`. Pending maps and app attention can
therefore stay stuck, and a later Paseo response can be sent for an already
resolved request.

## Current state

- The pinned SDK event union includes:
  - `permission.replied {sessionID, requestID, reply: once|always|reject}`;
  - `question.replied {sessionID, requestID, answers}`;
  - `question.rejected {sessionID, requestID}`.
- `appendOpenCodeLifecycleEvent` handles the two asked event types but not these
  three resolution types.
- `translateEvent` adds `permission_requested` events to
  `pendingPermissions` and `pendingPermissionDirectories`; entries are deleted
  only after Paseo's own SDK reply succeeds.
- `AgentStreamEvent` already supports `permission_resolved` with
  `requestId` and `AgentPermissionResponse`. `allow` and `deny` are compatible
  with upstream outcomes; no wire-schema change should be needed.
- `agent-manager.ts:onStreamPermissionResolved` removes manager pending state and
  clears attention through the normal emitted state path.
- Known child events are routed by session ID and child cwd. Plan 005 establishes
  directory semantics; resolution itself must not perform another SDK call.

## Commands you will need

| Purpose   | Command                                                                                                                                                                  | Expected on success |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| Test      | `npx vitest run packages/server/src/server/agent/providers/opencode-agent.test.ts --bail=1`                                                                              | exit 0              |
| Typecheck | `npm run typecheck:server`                                                                                                                                               | exit 0              |
| Lint      | `npm run lint -- packages/server/src/server/agent/providers/opencode-agent.ts packages/server/src/server/agent/providers/opencode-agent.test.ts`                         | exit 0              |
| Format    | `npm run format:files -- packages/server/src/server/agent/providers/opencode-agent.ts packages/server/src/server/agent/providers/opencode-agent.test.ts plans/README.md` | exit 0              |

## Scope

**In scope**:

- `packages/server/src/server/agent/providers/opencode-agent.ts`
- `packages/server/src/server/agent/providers/opencode-agent.test.ts`

**Read only**:

- `packages/server/src/server/agent/agent-sdk-types.ts`
- `packages/protocol/src/agent-types.ts`
- pinned SDK generated type declarations under `node_modules`.

**Out of scope**:

- Protocol schema changes unless a STOP condition is reported and separately
  approved.
- Sending an SDK reply in reaction to a resolution event.
- Reconstructing or exposing external answer text when only outcome is needed.

## Git workflow

- Branch: `advisor/013-handle-external-request-resolution`
- Commit: `fix(opencode): consume external request resolutions`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add parent and child resolution regressions

For a parent and a known cross-directory child, emit an asked event, verify it is
pending, then emit each matching resolution variant. Assert one
`permission_resolved` event, removal from `getPendingPermissions()`, removal of
the stored directory, and no SDK reply/reject call. A subsequent
`respondToPermission(requestId, ...)` must reject with no pending request.

Add unrelated session ID and unknown request ID cases; they must not clear or
resolve the tracked request. Add duplicate upstream event coverage.

**Verify**: targeted test fails against current code because pending state stays.

### Step 2: Map upstream outcomes conservatively

Extend lifecycle translation/session handling for the three resolution types:

- `permission.replied` `once`/`always` -> `{behavior: "allow"}`;
- `permission.replied` `reject` -> `{behavior: "deny"}`;
- `question.replied` -> `{behavior: "allow"}`;
- `question.rejected` -> `{behavior: "deny"}`.

Do not invent selected action IDs, messages, updated permissions, or answer
records. If product code requires those optional fields to distinguish a valid
resolution, STOP and report rather than fabricating them.

Filter by target session through existing parent/child routing and emit only for
a request currently pending in this session. Use upstream event identity/normal
dedupe so duplicates settle once.

**Verify**: translation and session tests pass for every outcome.

### Step 3: Clear provider state before dispatch

When consuming a valid resolution, delete both pending maps before publishing
`permission_resolved`. This prevents a synchronous subscriber from racing a
second response. Preserve manager buffering behavior for Paseo-initiated replies;
external events have no in-flight Paseo response and should dispatch normally.

**Verify**: a test subscriber calling `getPendingPermissions()` during the
resolution callback sees the request absent.

### Step 4: Finish checks

Run format, targeted test, server typecheck, lint, and `git diff --check`.

**Verify**: all commands exit 0; no diff-check output.

## Test plan

- Parent permission once/always/reject outcomes.
- Parent question replied/rejected outcomes.
- Known cross-directory child outcomes.
- Unknown request/session and duplicate event no-ops.
- Pending state clears before dispatch; later Paseo response is rejected.

## Done criteria

- [ ] External resolutions clear provider and manager pending state exactly once.
- [ ] No resolution handler sends a second upstream response.
- [ ] Existing protocol types are used without schema narrowing or fabrication.
- [ ] Targeted test, typecheck, lint, and format pass.
- [ ] Index updated.

## STOP conditions

- Upstream resolution cannot be associated with a pending Paseo request ID.
- Existing `AgentPermissionResponse` consumers require information absent from
  the upstream event.
- A wire-schema change appears necessary.
- Child routing cannot determine whether the request belongs to this session.
- Verification fails twice after a reasonable fix.

## Maintenance notes

When the SDK adds new resolution variants, update the exhaustive lifecycle
switch and tests. Outcome mapping is intentionally coarse; do not expose answer
content without a product/privacy requirement.
