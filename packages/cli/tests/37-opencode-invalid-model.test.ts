#!/usr/bin/env npx tsx

import assert from "node:assert";
import { createE2ETestContext } from "./helpers/test-daemon.ts";

const INVALID_PROVIDER_MODEL = "opencode/adklasldkdas";
const RUN_TIMEOUT_MS = 45_000;
const INSPECT_DEADLINE_MS = 15_000;
const AGENT_ID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

interface RunOutput {
  agentId?: unknown;
}

interface InspectOutput {
  Id?: unknown;
  Status?: unknown;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractAgentId(stdout: string): string | null {
  const parsed = parseJson(stdout) as RunOutput | null;
  if (parsed && typeof parsed.agentId === "string") {
    return parsed.agentId;
  }
  return stdout.match(AGENT_ID_PATTERN)?.[0] ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

console.log("=== OpenCode Invalid Model Regression ===\n");

const ctx = await createE2ETestContext({ timeout: RUN_TIMEOUT_MS });

try {
  console.log("Test 1: invalid OpenCode model terminates in an error state");
  const run = await ctx.paseo(["run", "--provider", INVALID_PROVIDER_MODEL, "hello", "--json"], {
    timeout: RUN_TIMEOUT_MS,
  });
  const output = `${run.stdout}\n${run.stderr}`;
  const agentId = extractAgentId(run.stdout);

  if (agentId) {
    const deadline = Date.now() + INSPECT_DEADLINE_MS;
    let lastStatus: string | null = null;
    while (Date.now() < deadline) {
      const inspect = await ctx.paseo(["inspect", agentId, "--json"], { timeout: 5_000 });
      assert.strictEqual(
        inspect.exitCode,
        0,
        `inspect failed\nstdout:\n${inspect.stdout}\nstderr:\n${inspect.stderr}`,
      );
      const parsed = parseJson(inspect.stdout) as InspectOutput | null;
      assert(parsed, `inspect did not return JSON\nstdout:\n${inspect.stdout}`);
      assert.strictEqual(parsed.Id, agentId, "inspect returned a different agent");
      assert.strictEqual(typeof parsed.Status, "string", "inspect omitted the agent status");
      lastStatus = parsed.Status;
      if (lastStatus !== "running") {
        assert.strictEqual(
          lastStatus,
          "error",
          `expected terminal error status, got ${lastStatus}`,
        );
        break;
      }
      await sleep(250);
    }
    assert.strictEqual(lastStatus, "error", "agent remained running past the inspect deadline");
  }

  assert.notStrictEqual(
    run.exitCode,
    0,
    `invalid model unexpectedly exited zero\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
  );
  assert.match(output, /error|failed/i, "invalid model output should clearly report failure");
  assert.doesNotMatch(output, /\bcompleted\b/i, "invalid model output must not report completion");
  console.log("✓ invalid OpenCode model terminates in an error state\n");
} finally {
  await ctx.stop();
}

console.log("=== OpenCode invalid model regression passed ===");
