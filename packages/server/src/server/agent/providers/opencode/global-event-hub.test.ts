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

  test("keeps fast subscribers moving while another subscriber is slow", async () => {
    const hub = new OpenCodeGlobalEventHub();
    const firstClient = new TestOpenCodeClient();
    const secondClient = new TestOpenCodeClient();
    const firstEventStarted = createDeferred<void>();
    const releaseFirstEvent = createDeferred<void>();
    const firstListener = vi.fn(async () => {
      if (firstListener.mock.calls.length === 1) {
        firstEventStarted.resolve();
        await releaseFirstEvent.promise;
      }
    });
    const secondListener = vi.fn(async () => {});
    const first = hub.subscribe({
      serverUrl: "http://127.0.0.1:4002",
      client: firstClient.asSdkClient(),
      onEvent: firstListener,
      onEnd: () => {},
    });
    const second = hub.subscribe({
      serverUrl: "http://127.0.0.1:4002",
      client: secondClient.asSdkClient(),
      onEvent: secondListener,
      onEnd: () => {},
    });
    await Promise.all([first.ready, second.ready]);

    firstClient.emitEvent({ type: "first" });
    await firstEventStarted.promise;
    firstClient.emitEvent({ type: "second" });

    await vi.waitFor(() => expect(secondListener).toHaveBeenCalledTimes(2));
    expect(firstListener).toHaveBeenCalledTimes(1);

    releaseFirstEvent.resolve();
    await vi.waitFor(() => expect(firstListener).toHaveBeenCalledTimes(2));
    await Promise.all([first.close(), second.close()]);
  });
});

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
