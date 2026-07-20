# Plan 018: Specify redacted OpenCode health diagnostics

> **Executor instructions**: This is a design/spike deliverable, not an
> implementation authorization. Complete the prerequisite lifecycle plans,
> inspect the live code, write the design document, and update the plan index.
> Do not change source or protocol files under this plan.
>
> **Drift check (run first)**:
> `git diff --stat 0721f898e..HEAD -- packages/server/src/server/agent/providers/opencode-agent.ts packages/server/src/server/agent/providers/opencode/global-event-hub.ts packages/server/src/server/agent/providers/opencode/server-manager.ts packages/server/src/server/agent/providers/opencode/project-instance-leases.ts packages/server/src/server/session/daemon/diagnostics.ts packages/app/src/subagents/opencode-stall.ts packages/app/src/subagents/opencode-stall-notice.tsx docs/providers.md docs/architecture.md`

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans 001, 004, 006, 007, 009, and 010
- **Category**: direction
- **Planned at**: commit `0721f898e`, 2026-07-20

## Why this matters

The app can warn that an OpenCode agent may be stalled after ten minutes, but
neither users nor support can distinguish a dead helper, disconnected global
stream, detached backlog subscriber, stuck project disposal, or simply a quiet
model call. A redacted health snapshot would make those cases actionable, but
the data boundary must be designed before implementation because helper config,
session IDs, paths, MCP headers, and environment can contain sensitive data.

## Current state

- `packages/app/src/subagents/opencode-stall.ts` is presentation-only: it uses
  translated parent/child activity and a ten-minute threshold.
- `opencode-stall-notice.tsx` renders a passive warning and no diagnostic action.
- `OpenCodeAgentClient.getDiagnostic()` reports binary resolution and auth command
  output, not helper/event/lease state.
- `global-event-hub.ts` knows generation open/closed state, listener pending
  counts, backlog-limit detaches, and stream terminal errors internally.
- `server-manager.ts` owns helper generations, URL/port, ref counts, process
  lifecycle, and managed-process identity. Plan 009 distinguishes unconfirmed
  force kill from confirmed exit.
- `project-instance-leases.ts` owns active/pending/dirty counts by generation and
  normalized directory. Paths must not be exposed.
- `session/daemon/diagnostics.ts` already builds a redacted text diagnostic with
  safe sections; its Providers section currently reports only availability.
- `docs/providers.md` documents one shared helper and directory-scoped leases.
  The design must preserve that vocabulary and architecture.

## Commands you will need

| Purpose            | Command                                                                             | Expected on success |
| ------------------ | ----------------------------------------------------------------------------------- | ------------------- | ------------- | ------ | ----------- | --- | ---------- | -------------------------------------------------- | --------------------------------------------------------------------------- |
| Format             | `npm run format:files -- docs/opencode-health-diagnostics.md plans/README.md`       | exit 0              |
| Format check       | `npm run format:check:files -- docs/opencode-health-diagnostics.md plans/README.md` | exit 0              |
| Secret-word review | `rg -n "token                                                                       | secret              | authorization | header | environment | cwd | session ID | project path" docs/opencode-health-diagnostics.md` | every match appears in a prohibition/redaction rule, never an example value |

## Scope

**In scope**:

- `docs/opencode-health-diagnostics.md` (create)

**Read only**:

- the source/docs paths in the drift check
- `docs/security.md` if present, otherwise `SECURITY.md`
- `docs/design.md` and `docs/coding-standards.md` for future UX/implementation
  conventions

**Out of scope**:

- Source code, protocol schemas, UI components, telemetry, logging, or analytics.
- Exact user/session/project identifiers, paths, URLs/ports, prompts, model text,
  config values, environment, MCP configs/headers, or auth output.
- A “restart helper” button or any recovery mutation.

## Git workflow

- Branch: `advisor/018-design-opencode-health-diagnostics`
- Commit: `docs(opencode): design redacted health diagnostics`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Inventory observable states and owners

Create `docs/opencode-health-diagnostics.md` with a table mapping each proposed
field to its authoritative owner, update transition, safe aggregation, and user
question answered. At minimum cover:

- helper generation: alive/starting/stopping/unconfirmed-exit and aggregate refs;
- global stream: connecting/ready/backoff/draining/closed, reconnect attempts,
  last-event age bucket, active listener count, backlog detach count/reason;
- project leases: aggregate active/pending directory count and dirty-disposal
  count, never directory keys;
- MCP generation metadata: live entry count only;
- session-local reconnect/stream state counts, never provider session IDs.

Use prerequisite plans' final code as truth, not the old excerpts above.

**Verify**: every field has exactly one owner and named transition source.

### Step 2: Define the privacy/redaction contract

Add an explicit allowlist of emitted types: booleans, enums, counts, bounded age
buckets, and stable error categories. Add an explicit denylist covering exact
IDs, cwd/project paths, helper URL/port/PID unless already safely governed by the
existing daemon diagnostic, runtime settings, commands/args, env names/values,
tokens, headers, MCP names/configs, prompts, and raw upstream errors.

Specify that redaction occurs before the snapshot leaves its owner; generic final
text redaction is defense in depth, not the primary boundary. Provide synthetic
safe examples with no real paths/values.

**Verify**: secret-word review command has only policy matches.

### Step 3: Compare delivery options and choose one

Evaluate at least:

1. add an OpenCode subsection to existing daemon diagnostics/copy flow;
2. add a capability-gated per-agent health RPC and stall-notice action;
3. logs only.

Recommend one staged path. Prefer the existing diagnostics collector for a first
read-only implementation unless per-agent UX materially requires protocol work.
If recommending a new RPC, name the dotted request/response namespace, require
optional/backward-compatible fields, a single `server_info.features.*` gate, and
the repository's dated `COMPAT` comment. No fallback RPC fan-out.

**Verify**: the document states decision, alternatives, tradeoffs, and why no
recovery mutation is included.

### Step 4: Write implementation/test follow-up slices

End the design with independently reviewable follow-up tickets: owner snapshots,
diagnostic composition/redaction tests, optional protocol capability, optional
stall UX, and docs/support guidance. Give exact likely source/test paths and
machine-checkable acceptance criteria for each. Include concurrency snapshot
rules (immutable copy, no awaited locks in hot event delivery).

**Verify**: each slice can land without requiring a later slice except where an
explicit dependency is stated.

### Step 5: Finish document checks

Run format, format check, secret-word review, and `git diff --check`.

**Verify**: commands succeed; only the new doc and plan index changed.

## Test plan

This plan writes no runtime code. The design must prescribe future tests for:

- redacted snapshots with canaries in every sensitive source;
- concurrent snapshot reads during stream reconnect/lease transitions;
- age bucketing and bounded error categories;
- absent/old-daemon capability behavior if protocol work is selected;
- stall-notice action visibility without automatic recovery.

## Done criteria

- [ ] New design doc identifies one owner for every proposed metric.
- [ ] Allowlist/denylist and canary-testing strategy are explicit.
- [ ] One delivery approach is selected with staged implementation tickets.
- [ ] No source/protocol/UI file changed.
- [ ] Format, privacy review, diff check, and index update pass.

## STOP conditions

- Any prerequisite plan remains incomplete and its final state changes a metric's
  meaning.
- A useful diagnostic appears to require exact paths, session IDs, config values,
  or raw upstream errors.
- The only proposed UX automatically restarts or mutates the helper/session.
- The design cannot identify a single authoritative owner for a metric.

## Maintenance notes

The document should become the privacy contract for future implementation.
Reviewers should reject ad hoc health logs or UI fields that bypass its allowlist
or duplicate state ownership.
