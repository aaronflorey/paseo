# Redacted OpenCode health diagnostics

## Status and decision

This document defines the privacy and ownership contract for a future read-only
OpenCode health snapshot. It does not authorize runtime, protocol, or UI changes.

The first implementation should add an **OpenCode health** subsection to the
existing daemon diagnostic. That path already has capability-gated collection,
copy UI, failure isolation, and final text redaction. It can answer whether the
shared helper, event delivery, or project leases look unhealthy without adding a
new wire message.

A per-agent RPC and stall-notice action remain optional later stages. They are
justified only if support evidence shows that the aggregate daemon diagnostic is
not enough to identify the affected agent. Logs alone are not an acceptable
primary interface.

Health collection is observational. It must not restart a helper, reconnect a
stream, dispose a lease, close an agent, or perform any other recovery action.

## Goals and boundaries

The snapshot should help a user or support engineer answer five questions:

1. Is the shared helper starting, alive, stopping, or awaiting confirmed exit?
2. Is shared event transport connected and delivering without shedding
   listeners?
3. Are anonymous session subscriptions ready, reconnecting, backing off, or
   draining?
4. Are project instance leases active, pending, or stuck after failed disposal?
5. Is generation-scoped MCP bookkeeping being released when helpers rotate?

It is not a tracing system, an audit log, or a provider transcript. It reports a
bounded current snapshot plus a few process-lifetime counters. It does not try to
prove that a quiet model call is stuck; it supplies enough context to distinguish
quiet activity from obvious infrastructure failure.

## Ownership model

Every emitted field has one authoritative owner. Owners produce an allowlisted,
keyless copy of their state. A composer may combine those copies, but it must not
reach into an owner's maps or infer a second version of the same metric.

The shared event pipeline has two deliberately separate layers:

- `OpenCodeGlobalEventHub` owns helper-level transport and listener delivery.
- `OpenCodeAgentSession` owns subscription reconnect and backoff. An anonymous
  provider-local registry aggregates those session states without storing an
  emitted identifier.

This distinction matters because the hub can be ready while one subscription is
backing off, and the session can be ready while the shared transport is about to
drain. Combining the states into one enum would hide the responsible lifecycle
owner.

### Proposed inventory

All `*Counts` objects have a fixed set of enum keys. They must never acquire
dynamic keys from runtime state.

| Proposed field                               | Authoritative owner                                                                 | Update transition                                                                                                                                                                                                                                       | Safe aggregation                                                                                                                     | User question answered                                                                             |
| -------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `helper.generationStateCounts`               | `OpenCodeServerManager`                                                             | Add `starting` when generation startup begins; change to `alive` after readiness; change to `stopping` before termination; change to `unconfirmed_exit` when the bounded termination result is not confirmed; remove only after confirmed exit cleanup. | Counts for the fixed states `starting`, `alive`, `stopping`, and `unconfirmed_exit`.                                                 | Is the shared helper usable, rotating, or still potentially alive after termination was attempted? |
| `helper.aggregateReferenceCount`             | `OpenCodeServerManager`                                                             | Increment in `acquireServer()` and decrement in the returned release function.                                                                                                                                                                          | Sum across current and starting generations.                                                                                         | Is a helper retained because active consumers still reference it?                                  |
| `helper.lastFailureCategory`                 | `OpenCodeServerManager`                                                             | Replace only at startup, readiness, exit, and termination failure boundaries.                                                                                                                                                                           | One of `none`, `spawn_failure`, `startup_timeout`, `early_exit`, `termination_timeout`, or `unknown`.                                | Which lifecycle phase most recently failed without exposing provider output?                       |
| `eventTransport.generationStateCounts`       | `OpenCodeGlobalEventHub`                                                            | Set `connecting` before opening the shared stream, `ready` after the ready promise resolves, `draining` before awaiting queued deliveries, and `closed` before removing the generation.                                                                 | Counts for the fixed states `connecting`, `ready`, `draining`, and `closed`; all zero means no active transport.                     | Is the shared event source connected or shutting down?                                             |
| `eventTransport.activeListenerCount`         | `OpenCodeGlobalEventHub`                                                            | Increment when a listener joins a generation and decrement exactly once in listener teardown.                                                                                                                                                           | Sum across live generations.                                                                                                         | Does the shared stream still have consumers?                                                       |
| `eventTransport.pendingDeliveryCount`        | `OpenCodeGlobalEventHub`                                                            | Increment before queuing an accepted event and decrement in the delivery chain's finalizer.                                                                                                                                                             | Sum across listeners, clamped at zero if an invariant is violated.                                                                   | Is callback delivery accumulating work?                                                            |
| `eventTransport.lastEventAgeBucket`          | `OpenCodeGlobalEventHub`                                                            | Store an internal monotonic instant after accepting a shared event; convert it only while copying the snapshot.                                                                                                                                         | `never`, `under_10_seconds`, `under_1_minute`, `under_5_minutes`, `under_10_minutes`, or `10_minutes_or_more`.                       | Has any shared event arrived recently?                                                             |
| `eventTransport.listenerDetachCounts`        | `OpenCodeGlobalEventHub`                                                            | Increment exactly once when listener teardown is classified.                                                                                                                                                                                            | Fixed category counts for `backlog_limit`, `filter_failure`, `callback_failure`, `transport_failure`, and `normal_close`.            | Are listeners being detached, and for which stable reason?                                         |
| `eventTransport.lastFailureCategory`         | `OpenCodeGlobalEventHub`                                                            | Replace when opening, reading, filtering, or delivering the shared stream fails.                                                                                                                                                                        | One of `none`, `connect_failure`, `unexpected_end`, `filter_failure`, `callback_failure`, or `unknown`.                              | Did transport stop because of a known infrastructure class?                                        |
| `subscriptions.stateCounts`                  | Provider-local anonymous session health registry, updated by `OpenCodeAgentSession` | Set `connecting` before subscribe, `ready` after subscription readiness, `backoff` before the retry delay, `draining` before close waits, and `closed` after close completes.                                                                           | Counts for `connecting`, `ready`, `backoff`, `draining`, and `closed`; closed entries are removed after their final snapshot update. | Are active subscriptions connected, retrying, or shutting down?                                    |
| `subscriptions.reconnectAttemptBucketCounts` | Provider-local anonymous session health registry, updated by `OpenCodeAgentSession` | Update before each reconnect delay and reset after readiness.                                                                                                                                                                                           | Counts in the fixed buckets `zero`, `one`, `two_to_three`, and `four_or_more`.                                                       | Are reconnects isolated or repeatedly failing?                                                     |
| `subscriptions.totalReconnectCount`          | Provider-local anonymous session health registry, updated by `OpenCodeAgentSession` | Increment once after an unexpected subscription end schedules another attempt.                                                                                                                                                                          | Sum across active anonymous entries for the daemon lifetime, using a saturating non-negative integer.                                | Is event delivery flapping even if it is ready now?                                                |
| `leases.generationCount`                     | `OpenCodeProjectInstanceLeaseCoordinator`                                           | Increment when the first directory state is added for a helper generation and decrement when its last clean state is removed.                                                                                                                           | Count only; omit generation keys.                                                                                                    | Are obsolete helper generations still represented in lease bookkeeping?                            |
| `leases.directoryStateCount`                 | `OpenCodeProjectInstanceLeaseCoordinator`                                           | Increment when a directory state is created and decrement after it becomes inactive, has no pending acquisition, and is clean.                                                                                                                          | Count only; omit directory keys.                                                                                                     | How many project instances are represented in the coordinator?                                     |
| `leases.activeDirectoryCount`                | `OpenCodeProjectInstanceLeaseCoordinator`                                           | Recompute from owner state after a successful acquisition and after exactly-once release; a directory is active when its active lease count is greater than zero.                                                                                       | Count matching directory states; omit keys and per-directory lease totals.                                                           | How many project instances are legitimately retained by active operations?                         |
| `leases.pendingDirectoryCount`               | `OpenCodeProjectInstanceLeaseCoordinator`                                           | Recompute from owner state when an acquisition starts and in its finalizer; a directory is pending when its pending acquisition count is greater than zero.                                                                                             | Count matching directory states; omit keys and per-directory acquisition totals.                                                     | Is project setup or dirty cleanup blocking one or more project instances?                          |
| `leases.dirtyDisposalCount`                  | `OpenCodeProjectInstanceLeaseCoordinator`                                           | Increment when final disposal fails and decrement only after a later disposal succeeds.                                                                                                                                                                 | Count dirty directory states; omit keys and failure text.                                                                            | Are failed disposals awaiting a retry?                                                             |
| `mcpMetadata.liveGenerationEntryCount`       | Generation-scoped MCP registry in `opencode-agent.ts`                               | Increment when the first metadata state for a helper generation is created and decrement when its generation cleanup removes that state.                                                                                                                | Count only. Do not count or describe individual registrations.                                                                       | Is generation metadata released as helpers rotate?                                                 |

The owner of `subscriptions.*` should assign an opaque in-memory handle to each
entry solely for removal. That handle is not a snapshot field, diagnostic value,
or dynamic object key. Each session publishes only its enum state and counters.

### State semantics

- `unconfirmed_exit` means termination was requested but process exit was not
  confirmed within the bounded wait. It must remain visible until the existing
  exit cleanup observes confirmation; reporting it as closed would recreate the
  lifecycle bug fixed by the managed-process retention work.
- `draining` begins before awaiting queued callbacks or close work. It ends only
  when the corresponding owner completes teardown.
- A reconnect attempt is counted after an unexpected subscription end and before
  the next delay. Successful readiness resets the current attempt bucket but not
  the process-lifetime total.
- An event age is based on the owner's monotonic clock. Wall-clock times and raw
  durations never leave the owner.
- Counts describe process-local state and reset when the daemon restarts. They are
  diagnostics, not durable telemetry.

## Privacy and redaction contract

The contract is an allowlist. Adding a field requires updating this document and
its canary tests; absence from the allowlist means the field may not be emitted.

### Allowed output

Only these value classes may leave a health owner:

- booleans;
- fixed enums with source-controlled values;
- non-negative counts and fixed-key count records;
- the bounded age buckets defined above;
- stable error categories that cannot embed provider text.

Objects use source-controlled field names. A snapshot is data, not preformatted
provider output. Unknown failures collapse to `unknown`; they do not gain a new
category at runtime.

### Prohibited output

The OpenCode health snapshot must never emit or retain exact IDs, including a
provider session ID; cwd or project path values; helper URL, port, or PID;
runtime settings; commands or arguments; environment names or values; token or
secret material; authorization or header data; MCP names or configuration;
prompts, model text, auth output, or raw upstream errors.

The existing general daemon diagnostic may separately govern fields such as its
own process identity. That does not permit copying those values into the
OpenCode health section. If a value is not required to answer one of the five
questions above, omit it.

### Enforcement boundary

Redaction happens before a snapshot leaves its authoritative owner:

1. The owner reads sensitive internal state.
2. It immediately maps that state to fixed enums, counts, booleans, or age
   buckets.
3. It returns a fresh immutable copy containing only allowlisted fields.
4. The diagnostic composer combines owner snapshots without receiving internal
   keys, runtime objects, or original failure values.
5. The existing `redactDiagnostic()` pass runs on the final text as defense in
   depth.

The final text pass is not the primary privacy boundary. Tests must fail if an
owner snapshot contains a canary placed in any prohibited source, even when the
final formatter would remove it.

### Safe synthetic rendering

The diagnostic text should use fixed labels and a shape like this:

```text
OpenCode health
  Helper: starting=0 alive=1 stopping=0 unconfirmed_exit=0 refs=3
  Event transport: connecting=0 ready=1 draining=0 closed=0 listeners=2 pending=0
  Event age: under_1_minute
  Listener detaches: backlog_limit=0 filter_failure=0 callback_failure=0 transport_failure=0 normal_close=1
  Subscriptions: connecting=0 ready=2 backoff=0 draining=0 closed=0 reconnects=1
  Project leases: generations=1 directories=2 active=2 pending=0 dirty=0
  MCP metadata: live_generation_entries=1
```

Every label is static. Zero-valued fields remain present so support can
distinguish a healthy zero from a collector that silently omitted a field.

## Delivery options

| Option                                           | Benefits                                                                                                                                                                                                                                         | Costs and risks                                                                                                                                                 | Decision                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Extend existing daemon diagnostics and copy flow | Reuses `diagnostics.request` / `diagnostics.response`, the `daemonDiagnostics` capability gate, safe-section failure isolation, final text redaction, and existing user workflow. One aggregate snapshot matches the shared-helper architecture. | Does not put a one-tap action beside a particular stalled agent. The collector needs a provider-local callback rather than reaching into provider internals.    | **Stage 1: selected.**                                                |
| Add a per-agent RPC and stall-notice action      | Can put health beside the agent that prompted the question and hide the action on unsupported hosts.                                                                                                                                             | Adds protocol, compatibility, UI, and targeting complexity. A per-agent view can misleadingly imply that shared helper and transport state belong to one agent. | Optional only after Stage 1 evidence shows a concrete unmet question. |
| Logs only                                        | Useful for developer chronology and already available during deep investigation.                                                                                                                                                                 | Difficult for users to collect, prone to containing values outside this contract, and unable to guarantee a coherent concurrent snapshot.                       | Rejected as the primary interface. Logs may supplement a snapshot.    |

Stage 1 should add a synchronous provider callback to
`DaemonDiagnosticsOptions`. The OpenCode subsection is wrapped in `safeSection`
like other daemon sections. If OpenCode is unused, render fixed zero values or a
single static `inactive` enum rather than omitting the section based on a
sensitive key.

No new capability is needed for Stage 1 because the entire diagnostic copy flow
is already gated by `server_info.features.daemonDiagnostics`. Do not simulate
health on an older host with multiple legacy calls.

If the optional per-agent stage is later approved, use the dotted pair
`agent.opencode.health.request` and `agent.opencode.health.response`. New response
fields must be optional and backward-compatible. Detection occurs once through
`server_info.features.opencodeHealth`; downstream UI reads a clean supported or
unsupported state, with no fallback RPC fan-out. The implementation must add a
dated comment in this form, replacing the version placeholder with the actual
release version:

```ts
// COMPAT(opencodeHealth): added in v0.2.X, remove after 2027-01-20 once daemon floor >= v0.2.X.
```

The optional request may target an existing agent reference, but the response
contains no identifier field. The action copies a read-only snapshot. It does
not offer automatic restart or any other mutation because an apparently quiet
agent can be healthy, helper state is shared, and recovery may disrupt unrelated
agents.

## Concurrency requirements

Snapshot collection must be cheap and synchronous:

- Each owner returns a fresh immutable value. No returned array, map, set, or
  nested object aliases mutable owner state.
- Snapshot methods do not return a promise and do not acquire an awaited lock.
- Hot event delivery may update primitive counters, enum state, and monotonic
  instants, but it must not await diagnostic work or format text.
- Collection reads fields once into locals, then constructs the copy. A snapshot
  may reflect either side of an in-progress transition, but every field must be
  internally valid and non-negative.
- Teardown counters use exactly-once guards already present in listener and lease
  lifecycle paths. Diagnostics must not add a second teardown path.
- Error categorization occurs at the failure boundary. Snapshot collection never
  parses a stored error later.

These rules favor an instantaneously consistent owner snapshot over a globally
atomic snapshot. The latter would require cross-owner locking in latency-sensitive
paths and would not improve the support questions this diagnostic answers.

## Follow-up implementation tickets

Each ticket below is independently reviewable. Dependencies are explicit; no
ticket silently requires a later ticket.

### A. Add owner snapshots

**Dependencies:** none.

**Likely source paths:**

- `packages/server/src/server/agent/providers/opencode/health.ts` (new shared
  allowlisted types, age bucketing, and stable category helpers)
- `packages/server/src/server/agent/providers/opencode/server-manager.ts`
- `packages/server/src/server/agent/providers/opencode/global-event-hub.ts`
- `packages/server/src/server/agent/providers/opencode/project-instance-leases.ts`
- `packages/server/src/server/agent/providers/opencode-agent.ts`

**Likely test paths:**

- `packages/server/src/server/agent/providers/opencode-server-manager.test.ts`
- `packages/server/src/server/agent/providers/opencode/global-event-hub.test.ts`
- `packages/server/src/server/agent/providers/opencode/project-instance-leases.test.ts`
- `packages/server/src/server/agent/providers/opencode-agent.test.ts`

**Acceptance:**

- Each inventory field has exactly the owner and transitions named above.
- Snapshot methods are synchronous and return fresh readonly objects whose prior
  values do not change after the owner transitions.
- Unit tests take snapshots during deferred startup, reconnect, event delivery,
  lease acquisition, dirty cleanup, and close transitions without deadlock.
- Tests place distinct canaries in every prohibited internal source and assert
  that serialized owner snapshots contain none of them.
- Age boundaries and every stable failure category have table-driven tests;
  unexpected failures become `unknown`.
- Existing backlog, callback-drain, termination-timeout, and lease cleanup tests
  remain green with no awaited diagnostic work in their hot paths.

This ticket can land unused by diagnostics because the new APIs are read-only
and covered at their owners.

### B. Compose the daemon diagnostic

**Dependencies:** A.

**Likely source paths:**

- `packages/server/src/server/session/daemon/diagnostics.ts`
- `packages/server/src/server/session/daemon/daemon-session.ts`
- `packages/server/src/server/session.ts`
- `packages/server/src/server/agent/agent-manager.ts`

**Likely test paths:**

- `packages/server/src/server/session/daemon/daemon-session.test.ts`
- a focused new `packages/server/src/server/session/daemon/diagnostics.test.ts` if
  direct formatter coverage is clearer than session-level assertions

**Acceptance:**

- The existing diagnostic includes one deterministic `OpenCode health` section
  with the fixed labels shown above.
- Collection reaches the provider through one injected callback and never reads
  provider maps or keys in the daemon diagnostic module.
- Owner-collector failures are isolated by `safeSection` and do not prevent other
  diagnostic sections from rendering.
- Tests inject canaries into owner internals, collector failures, and formatter
  inputs; neither the structured snapshot nor final copied text contains them.
- The final text still passes `redactDiagnostic()` and the existing
  `daemonDiagnostics` capability remains the only gate.

This ticket delivers the selected user-facing path and does not depend on the
optional tickets.

### C. Add support guidance

**Dependencies:** B.

**Likely documentation paths:**

- `docs/providers.md`
- `docs/development.md`
- this document

**Acceptance:**

- Guidance explains each fixed state and category using the shared-helper and
  project-instance-lease vocabulary.
- Troubleshooting differentiates quiet activity, reconnect backoff, backlog
  shedding, dirty disposal, and unconfirmed helper exit.
- Guidance tells users how to copy the existing diagnostic and does not recommend
  automatic recovery or ad hoc logging of prohibited values.

This ticket depends only on the shipped Stage 1 output.

### D. Add an optional per-agent protocol capability

**Dependencies:** A and documented evidence that Stage 1 cannot answer a real
support question. It does not depend on C.

**Likely source paths:**

- `packages/protocol/src/messages.ts`
- `packages/server/src/server/session.ts`
- `packages/server/src/server/websocket-server.ts`
- `packages/client/src/daemon-client.ts`

**Likely test paths:**

- `packages/protocol/src/messages.test.ts`
- the focused server session test for message dispatch
- the focused client test for capability detection and response handling

**Acceptance:**

- The message names are exactly `agent.opencode.health.request` and
  `agent.opencode.health.response`.
- New response leaves are optional, structural, and parse in both old-client/new-
  daemon directions covered by protocol tests.
- One `server_info.features.opencodeHealth` gate and one dated `COMPAT` cleanup
  comment own compatibility behavior.
- Unsupported hosts yield one clean unsupported state; tests assert that no
  legacy request fan-out occurs.
- Payload snapshots satisfy the owner-level canary suite before serialization.

This ticket can land with client API coverage and no UI; its value must be
demonstrated before approval.

### E. Add an optional stall diagnostic action

**Dependencies:** D. It does not depend on C.

**Likely source paths:**

- `packages/app/src/subagents/opencode-stall.ts`
- `packages/app/src/subagents/opencode-stall-notice.tsx`

**Likely test paths:**

- `packages/app/src/subagents/opencode-stall.test.ts`
- a focused app browser test for the rendered copy action

**Acceptance:**

- The copy action appears only for a possibly stalled OpenCode agent when the
  single capability gate reports support.
- Absent and old-host capability fixtures hide the action and issue no fallback
  calls.
- Activating the action requests and copies the redacted snapshot; it does not
  restart, abort, reconnect, dispose, or otherwise mutate runtime state.
- Presentation follows the existing warning-alert and compact-form-factor
  conventions, with a pure selector covered by unit tests and rendered behavior
  covered by the focused browser test.

This optional ticket is the only one that changes the stall notice.

## Review checklist

- Every proposed field has one owner and one named update boundary.
- Emitted values are limited to the allowlist, with fixed field and enum names.
- Owner-level canary tests enforce the prohibition boundary before formatting.
- Snapshot collection is synchronous, immutable, and lock-free in hot delivery.
- Stage 1 reuses the existing diagnostic and capability gate.
- Optional protocol work uses one dotted request/response pair and one gate.
- No diagnostic path mutates helper, stream, lease, or agent state.
