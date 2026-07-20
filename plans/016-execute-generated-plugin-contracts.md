# Plan 016: Execute generated OpenCode plugins in contract tests

> **Executor instructions**: This is a test-hardening plan; do not change plugin
> behavior. Execute the exact generated source under controlled globals, run all
> verification gates, and update `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat 0721f898e..HEAD -- packages/server/src/server/agent/providers/opencode/session-routing-plugin.ts packages/server/src/server/agent/providers/opencode/session-routing-plugin.test.ts packages/server/src/terminal/agent-hooks/opencode/opencode-plugin.ts packages/server/src/terminal/agent-hooks/opencode/opencode.test.ts`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `0721f898e`, 2026-07-20

## Why this matters

Paseo generates two OpenCode JavaScript plugins as strings. Tests currently
prove installation and inspect substrings, but never parse/import the generated
code or invoke its hooks. Syntax errors, wrong callback shapes, credential leaks,
and broken Bun spawn behavior can therefore pass CI while failing only inside a
user's OpenCode helper.

## Current state

- `session-routing-plugin.ts` exports exact generated source. Its
  `tool.execute.before` adds the provider session ID only to internal Paseo tools.
  Its `shell.env` removes bridge URL/token, fetches authenticated loopback
  context, treats 404 as no-op, throws on other non-OK responses, and merges
  returned env.
- `session-routing-plugin.test.ts` verifies config preservation, installation,
  and exact file contents only.
- `opencode-plugin.ts` generates a terminal-activity plugin that maps busy,
  retry, idle, permission asked/replied events and calls `Bun.spawn` only when
  `PASEO_TERMINAL_ID` is set. It swallows spawn and exited-promise failures.
- `opencode.test.ts` asserts source substrings and installer behavior but never
  loads the plugin.
- Generated sources contain no module imports. Tests can write the exact source
  to a unique `.mjs` file in the existing temporary directory and use
  `pathToFileURL`; the `.mjs` suffix avoids Node package-mode ambiguity without
  changing installed `.js` output.

## Commands you will need

| Purpose   | Command                                                                                                                                                                                         | Expected on success |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Tests     | `npx vitest run packages/server/src/server/agent/providers/opencode/session-routing-plugin.test.ts packages/server/src/terminal/agent-hooks/opencode/opencode.test.ts --bail=1`                 | exit 0              |
| Typecheck | `npm run typecheck:server`                                                                                                                                                                      | exit 0              |
| Lint      | `npm run lint -- packages/server/src/server/agent/providers/opencode/session-routing-plugin.test.ts packages/server/src/terminal/agent-hooks/opencode/opencode.test.ts`                         | exit 0              |
| Format    | `npm run format:files -- packages/server/src/server/agent/providers/opencode/session-routing-plugin.test.ts packages/server/src/terminal/agent-hooks/opencode/opencode.test.ts plans/README.md` | exit 0              |

## Scope

**In scope**:

- `packages/server/src/server/agent/providers/opencode/session-routing-plugin.test.ts`
- `packages/server/src/terminal/agent-hooks/opencode/opencode.test.ts`

**Read only**:

- `packages/server/src/server/agent/providers/opencode/session-routing-plugin.ts`
- `packages/server/src/terminal/agent-hooks/opencode/opencode-plugin.ts`

**Out of scope**:

- Changing generated behavior or installer paths.
- Starting a real OpenCode helper or invoking a real Paseo CLI.
- Snapshot/substrings as the sole behavioral proof.

## Git workflow

- Branch: `advisor/016-execute-generated-plugin-contracts`
- Commit: `test(opencode): execute generated plugin contracts`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add a reusable exact-source loader per test file

In each test, write the exported generated source to a unique temporary `.mjs`
path and dynamically import its file URL with a unique query to defeat ESM cache.
Clean up temp files, restored environment values, `globalThis.fetch`, and the
stubbed `globalThis.Bun` in `afterEach`. Never expose the real bridge token in
assertion messages.

Keep the helpers local to their test files unless an existing test utility is an
exact fit.

**Verify**: both generated modules import successfully and return hook objects
with the expected callback names.

### Step 2: Execute the session-routing tool hook

Invoke `tool.execute.before` for `paseo:*`, `paseo_*`, and unrelated tools.
Assert only the first two receive the exact session-ID argument, existing args
remain intact, missing/non-object args do not throw, and unrelated tools do not
change. Use exported session-context constants in assertions rather than copying
secret names when available.

**Verify**: targeted routing-plugin tests pass.

### Step 3: Execute every shell-env branch

Import with controlled bridge URL/token env, then invoke `shell.env` and assert:

- bridge URL and token are deleted from output before any early return or throw;
- missing session ID performs no fetch;
- fetch includes the session ID query and bearer authorization;
- 404 is a no-op, a non-404 error rejects with status but no token;
- valid `{env:{...}}` merges keys while malformed JSON shapes do not;
- fetch rejection still leaves bridge credentials scrubbed.

Because the generated module snapshots process env at import, set env before each
unique import. Do not run tests concurrently if they mutate process env.

**Verify**: all routing-plugin behavioral cases pass.

### Step 4: Execute the terminal-activity plugin

Stub `globalThis.Bun.spawn` with a recorder and resolved/rejected `exited`
promises. Invoke the plugin's `event` hook for every mapped and irrelevant event.
Assert exact argv and ignored stdio, gating when `PASEO_TERMINAL_ID` is missing,
one spawn per mapped event, no spawn for unknown statuses/events, and swallowed
synchronous spawn and asynchronous exit failures.

This plan should record the current executable (`paseo`). Plan 017 changes it
after this behavioral harness exists.

**Verify**: terminal hook tests pass without a real Bun runtime.

### Step 5: Retain installer coverage and finish checks

Keep existing idempotent install/uninstall/path tests. Run format, both test
files, server typecheck, lint, and `git diff --check`.

**Verify**: all commands exit 0; no source file changed.

## Test plan

- Both exact generated sources parse and export the expected plugin factory.
- Session ID mutation is restricted to Paseo tools.
- Shell bridge credentials are scrubbed on success, early return, HTTP error,
  invalid payload, and fetch rejection.
- Terminal event mapping/gating/spawn args and failure swallowing execute.
- Existing installation/idempotency coverage remains green.

## Done criteria

- [ ] Tests execute exact generated strings, not hand-written equivalents.
- [ ] Every conditional branch in both generated plugins has behavioral coverage.
- [ ] Test globals/environment are restored deterministically.
- [ ] Targeted tests, typecheck, lint, and format pass.
- [ ] Only test files and index changed.

## STOP conditions

- Exact source cannot be imported under Node solely because OpenCode/Bun uses a
  different module syntax; report the parse difference before adding transforms.
- Test execution needs network, a real Bun binary, or a real helper.
- A behavioral assertion fails because current source is actually wrong; report
  it as a separate implementation finding rather than fixing behavior here.
- Verification fails twice after a reasonable test-only fix.

## Maintenance notes

Every future generated-plugin behavior change should start in these executable
contracts, then update source. Keep string checks only for installer markers that
are themselves part of the install/uninstall contract.
