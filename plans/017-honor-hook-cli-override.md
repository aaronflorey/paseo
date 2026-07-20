# Plan 017: Honor `PASEO_HOOK_CLI` in the OpenCode terminal plugin

> **Executor instructions**: Complete plan 016 first. Follow all gates, preserve
> event mapping and fire-and-forget behavior, and update the index when done.
>
> **Drift check (run first)**:
> `git diff --stat 0721f898e..HEAD -- packages/server/src/terminal/agent-hooks/opencode/opencode-plugin.ts packages/server/src/terminal/agent-hooks/opencode/opencode.test.ts packages/server/src/terminal/terminal.ts packages/server/src/terminal/agent-hooks/agent-hook-installer.ts docs/terminal-activity.md`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/016-execute-generated-plugin-contracts.md`
- **Category**: bug
- **Planned at**: commit `0721f898e`, 2026-07-20

## Why this matters

Terminal launch injects an absolute `PASEO_HOOK_CLI` so hooks use the same CLI
installation as the daemon, even when PATH is different. Shell and Windows hook
commands honor it, but the generated OpenCode plugin hard-codes `paseo`. Hook
activity can silently disappear in packaged or unusual installations despite a
correct terminal environment.

## Current state

- `terminal.ts:406-445` prepends the CLI bin directory to PATH and injects an
  absolute `PASEO_HOOK_CLI` when resolution succeeds.
- `agent-hook-installer.ts:136-149` uses `${PASEO_HOOK_CLI:-paseo}` on shell and
  `%PASEO_HOOK_CLI%` with a `paseo` fallback on Windows.
- `opencode-plugin.ts` generates
  `Bun.spawn(["paseo", "hooks", "opencode", event], ...)`.
- Plan 016's executable contract tests invoke the exact generated plugin under a
  stubbed Bun runtime. Extend those tests; do not return to substring-only proof.
- `docs/terminal-activity.md` describes provider hook reporting. Update it only
  if it currently claims a different executable-resolution rule.

## Commands you will need

| Purpose   | Command                                                                                                                                                                                                     | Expected on success |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Test      | `npx vitest run packages/server/src/terminal/agent-hooks/opencode/opencode.test.ts --bail=1`                                                                                                                | exit 0              |
| Typecheck | `npm run typecheck:server`                                                                                                                                                                                  | exit 0              |
| Lint      | `npm run lint -- packages/server/src/terminal/agent-hooks/opencode/opencode-plugin.ts packages/server/src/terminal/agent-hooks/opencode/opencode.test.ts`                                                   | exit 0              |
| Format    | `npm run format:files -- packages/server/src/terminal/agent-hooks/opencode/opencode-plugin.ts packages/server/src/terminal/agent-hooks/opencode/opencode.test.ts docs/terminal-activity.md plans/README.md` | exit 0              |

## Scope

**In scope**:

- `packages/server/src/terminal/agent-hooks/opencode/opencode-plugin.ts`
- `packages/server/src/terminal/agent-hooks/opencode/opencode.test.ts`
- `docs/terminal-activity.md` only if its executable-resolution wording needs an
  update

**Read only**:

- `packages/server/src/terminal/terminal.ts`
- `packages/server/src/terminal/agent-hooks/agent-hook-installer.ts`

**Out of scope**:

- Terminal PATH construction or CLI path discovery.
- Event names, activity mapping, stdio, or retry behavior.
- Shell/Windows hook command changes.

## Git workflow

- Branch: `advisor/017-honor-hook-cli-override`
- Commit: `fix(opencode): honor terminal hook CLI path`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add override/fallback executable tests

Using plan 016's exact-source execution helper, set
`PASEO_HOOK_CLI=/tmp/Paseo CLI/bin/paseo` before invoking a mapped event and
assert the first spawn argv element is that complete string, including spaces.
It must be one array element; no shell interpolation. Clear/empty the variable
and assert the first element falls back to `paseo`.

Also set PATH to a value without Paseo and prove the override path is still used.

**Verify**: targeted test fails against current hard-coded source.

### Step 2: Resolve executable at hook execution

In `OPENCODE_PLUGIN_SOURCE`, choose
`process.env.PASEO_HOOK_CLI || "paseo"` and pass that string as argv element zero
to `Bun.spawn`. Resolve inside `runPaseoHook` (or immediately before spawn) so
the current terminal environment is honored. Keep terminal-ID gating, args,
ignored stdio, and failure swallowing unchanged.

Do not construct a shell command string and do not split the override path.

**Verify**: executable tests pass for override with spaces and fallback.

### Step 3: Check documentation and finish

Read `docs/terminal-activity.md`. If it describes hook executable resolution,
state that terminal hooks prefer `PASEO_HOOK_CLI` and fall back to `paseo`; if it
does not discuss resolution, leave it unchanged. Run format, targeted test,
server typecheck, lint, and `git diff --check`.

**Verify**: all commands exit 0; any doc change is narrowly relevant.

## Test plan

- Absolute override path, including spaces, is argv[0].
- Empty/missing override falls back to `paseo`.
- PATH absence does not affect an explicit override.
- All mapped event args, terminal gating, and failure swallowing stay unchanged.

## Done criteria

- [ ] Generated OpenCode hook follows the same executable contract as other
      terminal hooks.
- [ ] No shell quoting/splitting is introduced.
- [ ] Exact-source behavioral test passes.
- [ ] Typecheck, lint, format, and index update pass.

## STOP conditions

- OpenCode strips `PASEO_HOOK_CLI` from the plugin process environment.
- Bun spawn requires a different path representation than a single argv string.
- Plan 016 executable harness is not present/green.
- Verification fails twice after a reasonable fix.

## Maintenance notes

Keep executable resolution consistent across plugin-file and command-file hook
strategies. Packaged-path regressions should be tested with paths containing
spaces because those catch accidental shell construction.
