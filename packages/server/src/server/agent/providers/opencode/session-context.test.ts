import { afterEach, describe, expect, test } from "vitest";

import { OpenCodeSessionContextBridge, OpenCodeSessionContextRegistry } from "./session-context.js";

const bridges: OpenCodeSessionContextBridge[] = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
});

describe("OpenCodeSessionContextRegistry", () => {
  test("prefers a direct binding and falls back to inherited context when it is released", () => {
    const registry = new OpenCodeSessionContextRegistry();
    const releaseInherited = registry.bind(
      "child-session",
      { env: { PASEO_AGENT_ID: "parent" } },
      "inherited",
    );
    const releaseDirect = registry.bind(
      "child-session",
      { env: { PASEO_AGENT_ID: "child" } },
      "direct",
    );

    expect(registry.resolve("child-session")?.env.PASEO_AGENT_ID).toBe("child");

    releaseDirect();
    expect(registry.resolve("child-session")?.env.PASEO_AGENT_ID).toBe("parent");

    releaseInherited();
    expect(registry.resolve("child-session")).toBeUndefined();
  });

  test("uses the newest binding within the same priority", () => {
    const registry = new OpenCodeSessionContextRegistry();
    registry.bind("session", { env: { PASEO_AGENT_ID: "first" } });
    const releaseLatest = registry.bind("session", { env: { PASEO_AGENT_ID: "latest" } });

    expect(registry.resolve("session")?.env.PASEO_AGENT_ID).toBe("latest");
    releaseLatest();
    expect(registry.resolve("session")?.env.PASEO_AGENT_ID).toBe("first");
  });
});

describe("OpenCodeSessionContextBridge", () => {
  test("returns only the environment for an authenticated bound session", async () => {
    const registry = new OpenCodeSessionContextRegistry();
    registry.bind("session-1", {
      env: { PASEO_AGENT_ID: "agent-1", CUSTOM_ENV: "value" },
    });
    const bridge = new OpenCodeSessionContextBridge(registry);
    bridges.push(bridge);
    const info = await bridge.start();
    const url = new URL(info.url);
    url.searchParams.set("sessionId", "session-1");

    const unauthorized = await fetch(url);
    expect(unauthorized.status).toBe(401);

    const response = await fetch(url, {
      headers: { authorization: `Bearer ${info.token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      env: { PASEO_AGENT_ID: "agent-1", CUSTOM_ENV: "value" },
    });
  });
});
