# Plan 019: Correct public agent process-isolation copy

> **Executor instructions**: Follow this content-only plan, verify both public
> surfaces agree with provider documentation, and update `plans/README.md` when
> complete.
>
> **Drift check (run first)**:
> `git diff --stat 0721f898e..HEAD -- packages/website/src/llms.ts packages/website/src/components/landing-page.tsx docs/providers.md`

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `0721f898e`, 2026-07-20

## Why this matters

The website and generated `llms.txt` say every agent runs as its own process.
That is false for OpenCode, where one Paseo-managed local `opencode serve`
process is intentionally shared across active sessions to avoid SQLite
contention. Public copy should promise local execution and logical session
isolation without asserting a per-agent OS-process topology.

## Current state

- `packages/website/src/llms.ts` says: “Each agent runs as its own process; Paseo
  handles I/O, persistence, git worktree isolation, schedules, and skills.”
- `packages/website/src/components/landing-page.tsx` FAQ says: “Each agent runs as
  its own process using its own CLI or local integration.”
- `docs/providers.md` is authoritative: OpenCode uses one Paseo-managed
  `opencode serve` process for every active OpenCode agent; SDK directory
  scoping and Paseo project leases isolate project operations; per-agent helper
  processes must not be reintroduced.
- The important product claim remains true: agent runtimes and code stay on the
  user's machine. Do not weaken that claim.

## Commands you will need

| Purpose   | Command                                                                                                                 | Expected on success |
| --------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Typecheck | `npm run typecheck --workspace=@getpaseo/website`                                                                       | exit 0              |
| Build     | `npm run build --workspace=@getpaseo/website`                                                                           | exit 0              |
| Lint      | `npm run lint -- packages/website/src/llms.ts packages/website/src/components/landing-page.tsx`                         | exit 0              |
| Format    | `npm run format:files -- packages/website/src/llms.ts packages/website/src/components/landing-page.tsx plans/README.md` | exit 0              |

## Scope

**In scope**:

- `packages/website/src/llms.ts`
- `packages/website/src/components/landing-page.tsx`

**Read only**: `docs/providers.md`, `docs/product.md`.

**Out of scope**:

- Provider runtime architecture or code.
- A detailed technical explanation in the FAQ.
- Claims that all providers share one process or that process isolation is a
  security boundary.

## Git workflow

- Branch: `advisor/019-correct-process-isolation-copy`
- Commit: `docs(website): correct agent process isolation copy`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Replace the generated-LLM preamble claim

In `llms.ts`, replace the universal per-agent-process sentence with compact copy
that states agents run locally through their own CLI or local integration, while
Paseo supervises the appropriate local runtime and handles I/O, persistence,
worktree isolation, schedules, and skills. If mentioning topology, say some
providers use per-session processes while OpenCode safely shares a local helper.

Do not imply provider API traffic stays local; the existing nearby wording
correctly says agents talk to their APIs as usual.

**Verify**: `rg -n "Each agent runs as its own process" packages/website/src`
returns no matches.

### Step 2: Align the FAQ at user altitude

Update the supported-agents answer with the same local-runtime truth in one or
two sentences. Prefer simple copy: agents run locally via their CLI/integration;
runtime topology varies by provider; Paseo does not replace the provider's model
or API behavior. Mention OpenCode's shared helper only if the sentence remains
clear to a nontechnical reader.

Do not claim Paseo never wraps/modifies integration behavior; it installs hooks
and a session-routing plugin for supported functionality.

**Verify**: manually compare both edited paragraphs, then run
`rg -n "own process|per-agent process" packages/website/src/llms.ts packages/website/src/components/landing-page.tsx`; no universal claim remains.

### Step 3: Finish checks

Run format, website typecheck, website build, targeted lint, and
`git diff --check`.

**Verify**: all commands exit 0; only the two public content sources and index
are modified.

## Test plan

- Generated `llms.txt` source contains the corrected local-runtime statement.
- FAQ and LLM preamble make compatible claims.
- Website typecheck/build proves JSX/template syntax remains valid.
- Search proves the false universal sentence is gone from these public sources.

## Done criteria

- [ ] Public copy no longer promises one OS process per agent.
- [ ] Local execution/code-local value proposition remains explicit.
- [ ] Copy is consistent with `docs/providers.md` shared-helper architecture.
- [ ] Format, typecheck, build, lint, and index update pass.

## STOP conditions

- `docs/product.md` intentionally defines “agent” as an OS process; report the
  terminology conflict.
- The same false claim is generated from a third canonical source rather than
  either in-scope file.
- Correcting the copy would require making a new security/isolation guarantee.
- Verification fails twice after a reasonable fix.

## Maintenance notes

Marketing should describe the user-visible guarantee (local execution and
session/project isolation), not an implementation topology that varies by
provider and may evolve.
