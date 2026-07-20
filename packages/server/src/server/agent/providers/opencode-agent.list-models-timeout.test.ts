import { afterEach, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";
import {
  TestOpenCodeClient,
  TestOpenCodeHarness,
} from "./opencode/test-utils/test-opencode-harness.js";

afterEach(() => {
  vi.useRealTimers();
});

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function accessibleProviderListResponse() {
  return {
    data: {
      connected: ["openai"],
      all: [{ id: "openai", name: "OpenAI", models: {} }],
    },
  };
}

test("allows a slow provider.list call to succeed instead of failing after 10 seconds", async () => {
  vi.useFakeTimers();

  const runtime = new TestOpenCodeHarness();
  const openCodeClient = new TestOpenCodeClient();
  let providerSignal: AbortSignal | undefined;
  openCodeClient.providerListImplementation = (_parameters, options) => {
    providerSignal = options?.signal;
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          data: {
            connected: ["zai"],
            all: [
              {
                id: "zai",
                name: "Z.AI",
                models: {
                  "glm-5.1": {
                    name: "GLM 5.1",
                    limit: { context: 128_000 },
                  },
                },
              },
            ],
          },
        });
      }, 15_000);
    });
  };
  runtime.enqueueClient(openCodeClient);

  const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
    serverManager: runtime,
    createClient: runtime.createClient,
  });
  const modelsPromise = client.fetchCatalog({
    scope: "workspace",
    cwd: "/tmp/opencode-models",
    force: false,
  });

  await vi.advanceTimersByTimeAsync(15_000);

  await expect(modelsPromise).resolves.toMatchObject({
    models: [
      {
        provider: "opencode",
        id: "zai/glm-5.1",
        label: "GLM 5.1",
      },
    ],
  });
  expect(openCodeClient.calls.providerList).toHaveLength(1);
  expect(providerSignal?.aborted).toBe(true);
});

test("keeps the catalog provider deadline at 30 seconds", async () => {
  vi.useFakeTimers();

  const runtime = new TestOpenCodeHarness();
  const openCodeClient = new TestOpenCodeClient();
  const providerCall = createDeferred<ReturnType<typeof accessibleProviderListResponse>>();
  let providerSignal: AbortSignal | undefined;
  openCodeClient.providerListImplementation = async (_parameters, options) => {
    providerSignal = options?.signal;
    return await providerCall.promise;
  };
  runtime.enqueueClient(openCodeClient);
  const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
    serverManager: runtime,
    createClient: runtime.createClient,
  });
  const catalogPromise = client.fetchCatalog({
    scope: "workspace",
    cwd: "/tmp/opencode-catalog-deadline",
    force: false,
  });
  let settled = false;
  void catalogPromise.then(
    () => {
      settled = true;
      return undefined;
    },
    () => {
      settled = true;
      return undefined;
    },
  );

  try {
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    expect(providerSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);

    await expect(catalogPromise).rejects.toThrow("OpenCode provider.list timed out after 30s");
    expect(providerSignal?.aborted).toBe(true);

    providerCall.reject(new Error("late catalog rejection"));
    await vi.advanceTimersByTimeAsync(0);
  } finally {
    providerCall.reject(new Error("catalog deadline test cleanup"));
    await vi.advanceTimersByTimeAsync(0);
    await catalogPromise.catch(() => undefined);
    await client.shutdown();
  }
});

test("context cache deadlines release limiter slots and abort upstream requests", async () => {
  vi.useFakeTimers();

  const runtime = new TestOpenCodeHarness();
  const stuckProviderCalls = Array.from({ length: 4 }, () =>
    createDeferred<ReturnType<typeof accessibleProviderListResponse>>(),
  );
  const abortSignals: AbortSignal[] = [];
  const stuckClients = stuckProviderCalls.map((call) => {
    const openCodeClient = new TestOpenCodeClient();
    openCodeClient.providerListImplementation = async (_parameters, options) => {
      if (options?.signal) {
        abortSignals.push(options.signal);
      }
      return await call.promise;
    };
    runtime.enqueueClient(openCodeClient);
    return openCodeClient;
  });
  const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
    serverManager: runtime,
    createClient: runtime.createClient,
  });
  const createPromises = stuckClients.map((_, index) =>
    client.createSession({ provider: "opencode", cwd: `/tmp/opencode-context-${index}` }),
  );
  let settledCreations = 0;
  for (const creation of createPromises) {
    void creation.then(
      () => {
        settledCreations += 1;
        return undefined;
      },
      () => {
        settledCreations += 1;
        return undefined;
      },
    );
  }
  await vi.advanceTimersByTimeAsync(0);
  const queuedClient = new TestOpenCodeClient();
  queuedClient.providerListResponse = accessibleProviderListResponse();
  runtime.enqueueClient(queuedClient);
  const queuedCatalog = client.fetchCatalog({
    scope: "workspace",
    cwd: "/tmp/opencode-context-queued",
    force: false,
  });

  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(stuckClients.map((stuckClient) => stuckClient.calls.providerList.length)).toEqual([
      1, 1, 1, 1,
    ]);
    expect(queuedClient.calls.providerList).toHaveLength(0);
    expect(queuedClient.calls.appAgents).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(settledCreations).toBe(4);
    await Promise.all(createPromises);
    await expect(queuedCatalog).resolves.toMatchObject({ models: [], modes: [] });
    expect(queuedClient.calls.providerList).toHaveLength(1);
    expect(queuedClient.calls.appAgents).toHaveLength(1);
    expect(abortSignals).toHaveLength(4);
    expect(abortSignals.every((signal) => signal.aborted)).toBe(true);

    for (const call of stuckProviderCalls) {
      call.reject(new Error("late provider rejection"));
    }
    await vi.advanceTimersByTimeAsync(0);

    const freshClient = new TestOpenCodeClient();
    freshClient.providerListResponse = accessibleProviderListResponse();
    runtime.enqueueClient(freshClient);
    await expect(
      client.fetchCatalog({
        scope: "workspace",
        cwd: "/tmp/opencode-context-fresh",
        force: false,
      }),
    ).resolves.toMatchObject({ models: [], modes: [] });
    expect(freshClient.calls.providerList).toHaveLength(1);
  } finally {
    for (const call of stuckProviderCalls) {
      call.reject(new Error("context test cleanup"));
    }
    await vi.advanceTimersByTimeAsync(0);
    const outcomes = await Promise.allSettled(createPromises);
    await Promise.all(
      outcomes.flatMap((outcome) =>
        outcome.status === "fulfilled" ? [outcome.value.close()] : [],
      ),
    );
    await queuedCatalog.catch(() => undefined);
    await client.shutdown();
  }
});

test("mode discovery deadlines release limiter slots and ignore late rejections", async () => {
  vi.useFakeTimers();

  const runtime = new TestOpenCodeHarness();
  const stuckAgentCalls = Array.from({ length: 4 }, () =>
    createDeferred<{ data: Array<{ name: string; mode: "primary" }> }>(),
  );
  const abortSignals: AbortSignal[] = [];
  const stuckClients = stuckAgentCalls.map((call) => {
    const openCodeClient = new TestOpenCodeClient();
    openCodeClient.appAgentsImplementation = async (_parameters, options) => {
      if (options?.signal) {
        abortSignals.push(options.signal);
      }
      return await call.promise;
    };
    runtime.enqueueClient(openCodeClient);
    return openCodeClient;
  });
  const freshClient = new TestOpenCodeClient();
  freshClient.appAgentsResponse = {
    data: [{ name: "review", mode: "primary", description: "Review changes" }],
  };
  runtime.enqueueClient(freshClient);
  const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
    serverManager: runtime,
    createClient: runtime.createClient,
  });
  const sessions = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      client.createSession({ provider: "opencode", cwd: `/tmp/opencode-modes-${index}` }),
    ),
  );
  const stuckModePromises = sessions.slice(0, 4).map((session) => session.getAvailableModes());
  let settledModeCalls = 0;
  for (const modes of stuckModePromises) {
    void modes.then(
      () => {
        settledModeCalls += 1;
        return undefined;
      },
      () => {
        settledModeCalls += 1;
        return undefined;
      },
    );
  }
  const freshModesPromise = sessions[4].getAvailableModes();

  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(stuckClients.map((stuckClient) => stuckClient.calls.appAgents.length)).toEqual([
      1, 1, 1, 1,
    ]);
    expect(freshClient.calls.appAgents).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(settledModeCalls).toBe(4);
    await expect(Promise.all(stuckModePromises)).resolves.toEqual([[], [], [], []]);
    await expect(freshModesPromise).resolves.toEqual([
      {
        id: "review",
        label: "Review",
        description: "Review changes",
        icon: "Bot",
      },
    ]);
    expect(freshClient.calls.appAgents).toHaveLength(1);
    expect(abortSignals).toHaveLength(4);
    expect(abortSignals.every((signal) => signal.aborted)).toBe(true);

    for (const call of stuckAgentCalls) {
      call.reject(new Error("late agent rejection"));
    }
    await vi.advanceTimersByTimeAsync(0);
    await expect(sessions[0].getAvailableModes()).resolves.toEqual([]);
    expect(stuckClients[0].calls.appAgents).toHaveLength(1);
  } finally {
    for (const call of stuckAgentCalls) {
      call.reject(new Error("mode test cleanup"));
    }
    await vi.advanceTimersByTimeAsync(0);
    await Promise.allSettled(stuckModePromises);
    await freshModesPromise.catch(() => undefined);
    await Promise.all(sessions.map((session) => session.close()));
    await client.shutdown();
  }
});

test("uses a new server for explicit catalog refresh", async () => {
  const runtime = new TestOpenCodeHarness();
  const openCodeClient = new TestOpenCodeClient();
  openCodeClient.providerListResponse = {
    data: {
      connected: ["openai"],
      all: [{ id: "openai", name: "OpenAI", models: {} }],
    },
  };
  runtime.enqueueClient(openCodeClient);

  const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
    serverManager: runtime,
    createClient: runtime.createClient,
  });

  await client.fetchCatalog({ scope: "workspace", cwd: "/tmp/opencode-models", force: true });

  expect(runtime.acquisitions).toEqual([{ kind: "new", releaseCount: 1 }]);
});

test("includes models from api-source providers not in connected", async () => {
  // Providers with source "api" are managed by the OpenCode console/subscription.
  // They don't appear in `connected` but are fully usable.
  const runtime = new TestOpenCodeHarness();
  const openCodeClient = new TestOpenCodeClient();
  openCodeClient.providerListResponse = {
    data: {
      connected: [],
      all: [
        {
          id: "pi",
          name: "Pi",
          source: "api",
          models: {
            "pi-model-1": {
              name: "Pi Model 1",
              limit: { context: 200_000 },
            },
          },
        },
      ],
    },
  };
  runtime.enqueueClient(openCodeClient);

  const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
    serverManager: runtime,
    createClient: runtime.createClient,
  });
  const { models } = await client.fetchCatalog({
    scope: "workspace",
    cwd: "/tmp/opencode-models",
    force: false,
  });

  expect(models).toMatchObject([
    {
      provider: "opencode",
      id: "pi/pi-model-1",
      label: "Pi Model 1",
    },
  ]);
});

test("throws when no providers are accessible (neither connected nor api-source)", async () => {
  const runtime = new TestOpenCodeHarness();
  const openCodeClient = new TestOpenCodeClient();
  openCodeClient.providerListResponse = {
    data: {
      connected: [],
      all: [
        {
          id: "anthropic",
          name: "Anthropic",
          source: "env",
          models: {
            "claude-opus": { name: "Claude Opus", limit: { context: 1_000_000 } },
          },
        },
      ],
    },
  };
  runtime.enqueueClient(openCodeClient);

  const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
    serverManager: runtime,
    createClient: runtime.createClient,
  });

  await expect(
    client.fetchCatalog({ scope: "workspace", cwd: "/tmp/opencode-models", force: false }),
  ).rejects.toThrow("OpenCode has no connected providers");
});

test("does not throw when only api-source providers are present with no connected providers", async () => {
  const runtime = new TestOpenCodeHarness();
  const openCodeClient = new TestOpenCodeClient();
  openCodeClient.providerListResponse = {
    data: {
      connected: [],
      all: [
        {
          id: "pi",
          name: "Pi",
          source: "api",
          models: {
            "pi-model-1": { name: "Pi Model 1", limit: { context: 200_000 } },
          },
        },
      ],
    },
  };
  runtime.enqueueClient(openCodeClient);

  const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
    serverManager: runtime,
    createClient: runtime.createClient,
  });

  await expect(
    client.fetchCatalog({ scope: "workspace", cwd: "/tmp/opencode-models", force: false }),
  ).resolves.toMatchObject({
    models: [
      {
        provider: "opencode",
        id: "pi/pi-model-1",
        label: "Pi Model 1",
      },
    ],
  });
});
