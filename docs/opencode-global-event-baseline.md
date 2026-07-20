# OpenCode Global Event Verification

Date: 2026-07-19

## Objective

Record the verified `/global/event` compatibility boundary used by Paseo's OpenCode provider.

## Environment

- `opencode --version`: `1.18.3`
- `@opencode-ai/sdk`: `1.18.3` (exact pin)
- `which opencode`: `opencode`
- `node --version`: `v22.20.0`
- `npm --version`: `10.9.3`

Each OpenCode test file was run independently with:

```bash
/opt/homebrew/bin/timeout 420s npx vitest run <file> --maxWorkers=1
```

## 1.18.3 wire shapes

The global stream can deliver legacy event objects, flat sync records (`{ type: "sync", name, id, data }`), or nested sync envelopes (`payload.syncEvent`). OpenCode 1.18.3 also emits `session.next.*` text, reasoning, retry, and tool events, and may place a streaming delta directly on `message.part.updated.properties.delta`. Paseo normalizes these at one boundary before directory filtering or session routing. The normalized event retains the upstream directory, event ID, session/part/tool identity, and supports the legacy shapes for older OpenCode binaries.

OpenCode can mirror the same logical update through more than one event family. The adapter streams deltas immediately, emits only residual final content, and bounds its upstream-event identity registry to 4,096 entries per session. Unknown same-directory sessions are held briefly because child output can precede the event that establishes the parent relationship; cross-directory events are rejected before that routing step.

Paseo shares one `/global/event` connection across OpenCode sessions on the same server. Each session's directory predicate must run before the event enters that subscriber's serialized backlog. Filtering only inside the subscriber callback lets unrelated project traffic exhaust the backlog and permanently detach the session, which stops both foreground reasoning and provider-subagent updates.

## Baseline

Before the provider change, the OpenCode matrix had 16 passing files and 4 failing files:

- `packages/cli/tests/e2e/opencode-invalid-model.test.ts`: Vitest reports "No test suite found in file".
- `packages/server/src/server/agent/providers/opencode-agent.test.ts`: `plan mode blocks edits while build mode can write files` did not observe a completed tool call.
- `packages/server/src/server/daemon-e2e/opencode-initial-prompt-wait.real.e2e.test.ts`: brittle unavailable-model assertion received an auth failure from the upstream API.
- `packages/server/src/server/daemon-e2e/opencode-send-interrupt.real.e2e.test.ts`: timed out waiting for an interrupted sleep tool call, even though the recent bash tool call status was `failed`.

## Post-Change Result

After switching to `/global/event`, removing polling recovery, and replacing the brittle initial-prompt model case with `opencode/big-pickle`, the OpenCode matrix had 18 passing files and 2 baseline-equivalent failing files:

- `packages/cli/tests/e2e/opencode-invalid-model.test.ts`: unchanged; Vitest still reports "No test suite found in file".
- `packages/server/src/server/daemon-e2e/opencode-send-interrupt.real.e2e.test.ts`: unchanged; still times out after the interrupted sleep tool call is already marked `failed`.

The previously failing provider unit file now passes, and `packages/server/src/server/daemon-e2e/opencode-initial-prompt-wait.real.e2e.test.ts` passes with `opencode/big-pickle`.

One live reasoning-dedup matrix run returned no reasoning content; an immediate targeted rerun passed. This appears model-output dependent rather than related to the event-stream change.

## CLI Runner Follow-Up

On 2026-07-20, the invalid-model regression moved from the orphaned Vitest path to the numbered CLI runner script `packages/cli/tests/37-opencode-invalid-model.test.ts`. The historical "No test suite found" results above remain the baseline for the old file; the replacement is intentionally executed by the CLI runner with `npx tsx`, not Vitest.

After `npm run build:server`, the targeted command passed:

```bash
npx tsx packages/cli/tests/37-opencode-invalid-model.test.ts
```

The runner coverage now requires an invalid OpenCode model to terminate with a nonzero result, clearly report failure without reporting completion, and leave any emitted agent in a terminal error state.

## Focused Verification

- `npm run typecheck`
- `npm run lint`
- `git diff --check`
- `npx vitest run packages/server/src/server/agent/providers/opencode-agent.test.ts --maxWorkers=1`
- `npx vitest run packages/server/src/server/agent/providers/opencode-agent.error-handling.real.e2e.test.ts --maxWorkers=1`
- `npx vitest run packages/server/src/server/daemon-e2e/opencode-initial-prompt-wait.real.e2e.test.ts --maxWorkers=1`
