import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  OPENCODE_SESSION_ROUTING_PLUGIN_SOURCE,
  resolveOpenCodeSharedServerEnv,
} from "./session-routing-plugin.js";
import {
  OPENCODE_SESSION_CONTEXT_TOKEN_ENV,
  OPENCODE_SESSION_CONTEXT_URL_ENV,
  OPENCODE_SESSION_ID_TOOL_ARGUMENT,
  openCodeSessionContextBridge,
} from "./session-context.js";

const temporaryDirectories: string[] = [];
const originalFetch = globalThis.fetch;
const originalContextUrl = process.env[OPENCODE_SESSION_CONTEXT_URL_ENV];
const originalContextToken = process.env[OPENCODE_SESSION_CONTEXT_TOKEN_ENV];
let moduleSequence = 0;

interface SessionRoutingHooks {
  "tool.execute.before": (
    input: { tool: string; sessionID: string },
    output: { args?: unknown },
  ) => Promise<void>;
  "shell.env": (
    input: { sessionID?: string },
    output: { env: Record<string, unknown> },
  ) => Promise<void>;
}

function setEnvironmentValue(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function createResponse(status: number, body: unknown = null): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
}

async function loadSessionRoutingHooks(options?: {
  contextUrl?: string;
  contextToken?: string;
}): Promise<SessionRoutingHooks> {
  setEnvironmentValue(OPENCODE_SESSION_CONTEXT_URL_ENV, options?.contextUrl);
  setEnvironmentValue(OPENCODE_SESSION_CONTEXT_TOKEN_ENV, options?.contextToken);

  const directory = await mkdtemp(path.join(os.tmpdir(), "paseo-opencode-routing-module-"));
  temporaryDirectories.push(directory);
  const modulePath = path.join(directory, `session-routing-${moduleSequence}.mjs`);
  moduleSequence += 1;
  await writeFile(modulePath, OPENCODE_SESSION_ROUTING_PLUGIN_SOURCE, "utf8");
  const moduleUrl = `${pathToFileURL(modulePath).href}?test=${moduleSequence}`;
  const imported = (await import(moduleUrl)) as {
    PaseoSessionRoutingPlugin?: unknown;
  };
  if (typeof imported.PaseoSessionRoutingPlugin !== "function") {
    throw new Error("Generated session-routing plugin did not export its factory");
  }
  return (await imported.PaseoSessionRoutingPlugin()) as SessionRoutingHooks;
}

afterEach(async () => {
  await openCodeSessionContextBridge.close();
  globalThis.fetch = originalFetch;
  setEnvironmentValue(OPENCODE_SESSION_CONTEXT_URL_ENV, originalContextUrl);
  setEnvironmentValue(OPENCODE_SESSION_CONTEXT_TOKEN_ENV, originalContextToken);
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("resolveOpenCodeSharedServerEnv", () => {
  test("preserves inline config and adds the Paseo session-routing plugin", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "paseo-opencode-routing-"));
    temporaryDirectories.push(homeDir);
    const existingPlugin = pathToFileURL(path.join(homeDir, "existing.js")).href;

    const env = await resolveOpenCodeSharedServerEnv({
      homeDir,
      configContent: JSON.stringify({ theme: "system", plugin: [existingPlugin] }),
    });

    expect(env.PASEO_OPENCODE_SESSION_CONTEXT_URL).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/session-context$/,
    );
    expect(env.PASEO_OPENCODE_SESSION_CONTEXT_TOKEN).toBeTruthy();
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
    const routingPlugin = pathToFileURL(path.join(homeDir, "paseo-session-routing-plugin.js")).href;
    expect(config).toEqual({
      theme: "system",
      plugin: [existingPlugin, routingPlugin],
    });
    expect(await readFile(path.join(homeDir, "paseo-session-routing-plugin.js"), "utf8")).toBe(
      OPENCODE_SESSION_ROUTING_PLUGIN_SOURCE,
    );
  });

  test("rejects invalid inline config instead of replacing it", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "paseo-opencode-routing-"));
    temporaryDirectories.push(homeDir);

    await expect(
      resolveOpenCodeSharedServerEnv({ homeDir, configContent: "{invalid" }),
    ).rejects.toThrow("OPENCODE_CONFIG_CONTENT must be valid JSON");
  });
});

describe.sequential("generated OpenCode session-routing plugin", () => {
  test("imports the exact generated source and scopes session IDs to Paseo tools", async () => {
    const hooks = await loadSessionRoutingHooks();
    expect(Object.keys(hooks).sort()).toEqual(["shell.env", "tool.execute.before"]);

    const colonArgs = { existing: "colon" };
    const underscoreArgs = { existing: "underscore" };
    const unrelatedArgs = { existing: "unrelated" };
    await hooks["tool.execute.before"](
      { tool: "paseo:read", sessionID: "session-colon" },
      { args: colonArgs },
    );
    await hooks["tool.execute.before"](
      { tool: "paseo_create_agent", sessionID: "session-underscore" },
      { args: underscoreArgs },
    );
    await hooks["tool.execute.before"](
      { tool: "bash", sessionID: "session-unrelated" },
      { args: unrelatedArgs },
    );

    expect(colonArgs).toEqual({
      existing: "colon",
      [OPENCODE_SESSION_ID_TOOL_ARGUMENT]: "session-colon",
    });
    expect(underscoreArgs).toEqual({
      existing: "underscore",
      [OPENCODE_SESSION_ID_TOOL_ARGUMENT]: "session-underscore",
    });
    expect(unrelatedArgs).toEqual({ existing: "unrelated" });

    for (const args of [undefined, null, "not-an-object"]) {
      await expect(
        hooks["tool.execute.before"](
          { tool: "paseo:read", sessionID: "session-without-args" },
          { args },
        ),
      ).resolves.toBeUndefined();
    }
  });

  test("scrubs bridge credentials and skips fetch without a session ID", async () => {
    const fetchStub = vi.fn<typeof fetch>();
    globalThis.fetch = fetchStub;
    const hooks = await loadSessionRoutingHooks({
      contextUrl: "http://127.0.0.1:43210/session-context",
      contextToken: "test-context-token",
    });
    const env: Record<string, unknown> = {
      KEEP: "yes",
      [OPENCODE_SESSION_CONTEXT_URL_ENV]: "remove-url",
      [OPENCODE_SESSION_CONTEXT_TOKEN_ENV]: "remove-token",
    };

    await hooks["shell.env"]({}, { env });

    expect(fetchStub).not.toHaveBeenCalled();
    expect(env).toEqual({ KEEP: "yes" });
  });

  test("fetches authenticated session context and merges valid environment", async () => {
    const fetchStub = vi.fn<typeof fetch>().mockResolvedValue(
      createResponse(200, {
        env: { PASEO_AGENT_ID: "agent-1", SHARED: "from-context" },
      }),
    );
    globalThis.fetch = fetchStub;
    const hooks = await loadSessionRoutingHooks({
      contextUrl: "http://127.0.0.1:43210/session-context?existing=kept",
      contextToken: "test-context-token",
    });
    const env: Record<string, unknown> = {
      SHARED: "original",
      [OPENCODE_SESSION_CONTEXT_URL_ENV]: "remove-url",
      [OPENCODE_SESSION_CONTEXT_TOKEN_ENV]: "remove-token",
    };

    await hooks["shell.env"]({ sessionID: "session id/1" }, { env });

    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [request, init] = fetchStub.mock.calls[0]!;
    expect(String(request)).toBe(
      "http://127.0.0.1:43210/session-context?existing=kept&sessionId=session+id%2F1",
    );
    expect(init).toEqual({ headers: { authorization: "Bearer test-context-token" } });
    expect(env).toEqual({ PASEO_AGENT_ID: "agent-1", SHARED: "from-context" });
  });

  test("treats 404 and malformed context payloads as scrubbed no-ops", async () => {
    const fetchStub = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createResponse(404))
      .mockResolvedValueOnce(createResponse(200, null))
      .mockResolvedValueOnce(createResponse(200, {}))
      .mockResolvedValueOnce(createResponse(200, { env: null }))
      .mockResolvedValueOnce(createResponse(200, { env: "invalid" }));
    globalThis.fetch = fetchStub;
    const hooks = await loadSessionRoutingHooks({
      contextUrl: "http://127.0.0.1:43210/session-context",
      contextToken: "test-context-token",
    });

    for (let index = 0; index < 5; index += 1) {
      const env: Record<string, unknown> = {
        KEEP: index,
        [OPENCODE_SESSION_CONTEXT_URL_ENV]: "remove-url",
        [OPENCODE_SESSION_CONTEXT_TOKEN_ENV]: "remove-token",
      };
      await hooks["shell.env"]({ sessionID: `session-${index}` }, { env });
      expect(env).toEqual({ KEEP: index });
    }
    expect(fetchStub).toHaveBeenCalledTimes(5);
  });

  test("scrubs credentials before HTTP and fetch failures", async () => {
    const fetchStub = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createResponse(503))
      .mockRejectedValueOnce(new Error("network unavailable"));
    globalThis.fetch = fetchStub;
    const hooks = await loadSessionRoutingHooks({
      contextUrl: "http://127.0.0.1:43210/session-context",
      contextToken: "test-context-token",
    });

    const httpEnv: Record<string, unknown> = {
      KEEP: "http",
      [OPENCODE_SESSION_CONTEXT_URL_ENV]: "remove-url",
      [OPENCODE_SESSION_CONTEXT_TOKEN_ENV]: "remove-token",
    };
    const httpError = await hooks["shell.env"]({ sessionID: "session-http" }, { env: httpEnv })
      .then(() => null)
      .catch((error: unknown) => error);
    expect(httpError).toBeInstanceOf(Error);
    expect((httpError as Error).message).toBe(
      "Paseo session context request failed with status 503",
    );
    expect((httpError as Error).message).not.toContain("test-context-token");
    expect(httpEnv).toEqual({ KEEP: "http" });

    const rejectedEnv: Record<string, unknown> = {
      KEEP: "rejected",
      [OPENCODE_SESSION_CONTEXT_URL_ENV]: "remove-url",
      [OPENCODE_SESSION_CONTEXT_TOKEN_ENV]: "remove-token",
    };
    await expect(
      hooks["shell.env"]({ sessionID: "session-rejected" }, { env: rejectedEnv }),
    ).rejects.toThrow("network unavailable");
    expect(rejectedEnv).toEqual({ KEEP: "rejected" });
  });
});
