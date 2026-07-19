import { describe, expect, test, vi } from "vitest";

import { TestOpenCodeClient } from "./test-utils/test-opencode-harness.js";
import { OpenCodeGlobalEventHub } from "./global-event-hub.js";

describe("OpenCodeGlobalEventHub", () => {
  test("uses one global stream per server and fans events out to every subscriber", async () => {
    const hub = new OpenCodeGlobalEventHub();
    const firstClient = new TestOpenCodeClient();
    const secondClient = new TestOpenCodeClient();
    const firstListener = vi.fn(async () => {});
    const secondListener = vi.fn(async () => {});
    const first = hub.subscribe({
      serverUrl: "http://127.0.0.1:4001",
      client: firstClient.asSdkClient(),
      onEvent: firstListener,
      onEnd: () => {},
    });
    const second = hub.subscribe({
      serverUrl: "http://127.0.0.1:4001",
      client: secondClient.asSdkClient(),
      onEvent: secondListener,
      onEnd: () => {},
    });
    await Promise.all([first.ready, second.ready]);

    firstClient.emitEvent({ type: "server.connected", properties: {} });
    await vi.waitFor(() => expect(firstListener).toHaveBeenCalledTimes(1));
    expect(secondListener).toHaveBeenCalledTimes(1);
    expect(firstClient.calls.globalEvent).toHaveLength(1);
    expect(secondClient.calls.globalEvent).toHaveLength(0);

    await Promise.all([first.close(), second.close()]);
  });
});
