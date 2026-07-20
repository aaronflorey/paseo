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

  test("close drains the running callback, skips queued work, and leaves peers active", async () => {
    const hub = new OpenCodeGlobalEventHub();
    const firstClient = new TestOpenCodeClient();
    const secondClient = new TestOpenCodeClient();
    const firstEventStarted = createDeferred<void>();
    const releaseFirstEvent = createDeferred<void>();
    const firstListener = vi.fn(async () => {
      firstEventStarted.resolve();
      await releaseFirstEvent.promise;
    });
    const firstOnEnd = vi.fn();
    const secondListener = vi.fn(async () => {});
    const first = hub.subscribe({
      serverUrl: "http://127.0.0.1:4004",
      client: firstClient.asSdkClient(),
      onEvent: firstListener,
      onEnd: firstOnEnd,
    });
    const second = hub.subscribe({
      serverUrl: "http://127.0.0.1:4004",
      client: secondClient.asSdkClient(),
      onEvent: secondListener,
      onEnd: () => {},
    });
    await Promise.all([first.ready, second.ready]);

    firstClient.emitEvent({ type: "first" });
    await firstEventStarted.promise;
    firstClient.emitEvent({ type: "queued" });
    await vi.waitFor(() => expect(secondListener).toHaveBeenCalledTimes(2));

    let closeSettled = false;
    const firstClose = first.close().then(() => {
      closeSettled = true;
      return undefined;
    });
    const repeatedClose = first.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closeSettled).toBe(false);
    expect(firstListener).toHaveBeenCalledTimes(1);

    firstClient.emitEvent({ type: "peer-only" });
    await vi.waitFor(() => expect(secondListener).toHaveBeenCalledTimes(3));
    releaseFirstEvent.resolve();
    await Promise.all([firstClose, repeatedClose, first.done]);

    expect(firstListener).toHaveBeenCalledTimes(1);
    expect(firstOnEnd).not.toHaveBeenCalled();
    await second.close();
  });

  test("callback rejection drains once and does not end another subscriber", async () => {
    const hub = new OpenCodeGlobalEventHub();
    const firstClient = new TestOpenCodeClient();
    const secondClient = new TestOpenCodeClient();
    const callbackError = new Error("listener callback failed");
    const firstListener = vi.fn(async () => {
      throw callbackError;
    });
    const firstOnEnd = vi.fn();
    const secondListener = vi.fn(async () => {});
    const secondOnEnd = vi.fn();
    const first = hub.subscribe({
      serverUrl: "http://127.0.0.1:4005",
      client: firstClient.asSdkClient(),
      onEvent: firstListener,
      onEnd: firstOnEnd,
    });
    const second = hub.subscribe({
      serverUrl: "http://127.0.0.1:4005",
      client: secondClient.asSdkClient(),
      onEvent: secondListener,
      onEnd: secondOnEnd,
    });
    await Promise.all([first.ready, second.ready]);

    firstClient.emitEvent({ type: "failure" });
    await first.done;
    expect(firstOnEnd).toHaveBeenCalledTimes(1);
    expect(firstOnEnd).toHaveBeenCalledWith(callbackError);

    firstClient.emitEvent({ type: "peer-still-active" });
    await vi.waitFor(() => expect(secondListener).toHaveBeenCalledTimes(2));
    expect(firstListener).toHaveBeenCalledTimes(1);
    expect(secondOnEnd).not.toHaveBeenCalled();

    await first.close();
    expect(firstOnEnd).toHaveBeenCalledTimes(1);
    await second.close();
  });

  test("filter rejection terminates only that listener", async () => {
    const hub = new OpenCodeGlobalEventHub();
    const firstClient = new TestOpenCodeClient();
    const secondClient = new TestOpenCodeClient();
    const filterError = new Error("listener filter failed");
    const firstListener = vi.fn(async () => {});
    const firstOnEnd = vi.fn();
    const secondListener = vi.fn(async () => {});
    const first = hub.subscribe({
      serverUrl: "http://127.0.0.1:4006",
      client: firstClient.asSdkClient(),
      acceptsEvent: () => {
        throw filterError;
      },
      onEvent: firstListener,
      onEnd: firstOnEnd,
    });
    const second = hub.subscribe({
      serverUrl: "http://127.0.0.1:4006",
      client: secondClient.asSdkClient(),
      onEvent: secondListener,
      onEnd: () => {},
    });
    await Promise.all([first.ready, second.ready]);

    firstClient.emitEvent({ type: "filter-failure" });
    await first.done;
    expect(firstListener).not.toHaveBeenCalled();
    expect(firstOnEnd).toHaveBeenCalledTimes(1);
    expect(firstOnEnd).toHaveBeenCalledWith(filterError);
    await vi.waitFor(() => expect(secondListener).toHaveBeenCalledTimes(1));

    await second.close();
  });

  test("backlog detach drains the running callback and skips queued callbacks", async () => {
    const hub = new OpenCodeGlobalEventHub();
    const firstClient = new TestOpenCodeClient();
    const secondClient = new TestOpenCodeClient();
    const firstEventStarted = createDeferred<void>();
    const releaseFirstEvent = createDeferred<void>();
    const firstListener = vi.fn(async () => {
      firstEventStarted.resolve();
      await releaseFirstEvent.promise;
    });
    const firstOnEnd = vi.fn();
    const secondListener = vi.fn(async () => {});
    const first = hub.subscribe({
      serverUrl: "http://127.0.0.1:4007",
      client: firstClient.asSdkClient(),
      onEvent: firstListener,
      onEnd: firstOnEnd,
    });
    const second = hub.subscribe({
      serverUrl: "http://127.0.0.1:4007",
      client: secondClient.asSdkClient(),
      acceptsEvent: (rawEvent) =>
        typeof rawEvent === "object" &&
        rawEvent !== null &&
        "type" in rawEvent &&
        rawEvent.type === "marker",
      onEvent: secondListener,
      onEnd: () => {},
    });
    await Promise.all([first.ready, second.ready]);

    firstClient.emitEvent({ type: "first" });
    await firstEventStarted.promise;
    for (let index = 0; index < 1_025; index += 1) {
      firstClient.emitEvent({ type: "backlog", index });
    }
    firstClient.emitEvent({ type: "marker" });
    await vi.waitFor(() => expect(secondListener).toHaveBeenCalledTimes(1));

    releaseFirstEvent.resolve();
    await first.done;
    expect(firstListener).toHaveBeenCalledTimes(1);
    expect(firstOnEnd).toHaveBeenCalledTimes(1);
    expect(firstOnEnd.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ message: expect.stringContaining("backlog limit") }),
    );
    await second.close();
  });

  test("stream EOF settles ready and ends a listener once", async () => {
    const hub = new OpenCodeGlobalEventHub();
    const client = new TestOpenCodeClient();
    client.eventStream = (async function* () {})();
    const onEnd = vi.fn();
    const subscription = hub.subscribe({
      serverUrl: "http://127.0.0.1:4008",
      client: client.asSdkClient(),
      onEvent: async () => {},
      onEnd,
    });

    await subscription.ready;
    await subscription.done;
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        message: "OpenCode event stream ended before the session reached a terminal state",
      }),
    );
    await subscription.close();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  test("filters irrelevant events before they consume subscriber backlog", async () => {
    const hub = new OpenCodeGlobalEventHub();
    const client = new TestOpenCodeClient();
    const firstEventStarted = createDeferred<void>();
    const releaseFirstEvent = createDeferred<void>();
    const listener = vi.fn(async () => {
      if (listener.mock.calls.length === 1) {
        firstEventStarted.resolve();
        await releaseFirstEvent.promise;
      }
    });
    const onEnd = vi.fn();
    const subscription = hub.subscribe({
      serverUrl: "http://127.0.0.1:4003",
      client: client.asSdkClient(),
      acceptsEvent: (rawEvent) =>
        typeof rawEvent === "object" && rawEvent !== null && "deliver" in rawEvent,
      onEvent: listener,
      onEnd,
    });
    await subscription.ready;

    client.emitEvent({ type: "first", deliver: true });
    await firstEventStarted.promise;
    for (let index = 0; index < 1_025; index += 1) {
      client.emitEvent({ type: "irrelevant", index });
    }
    client.emitEvent({ type: "second", deliver: true });

    releaseFirstEvent.resolve();
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2));
    expect(onEnd).not.toHaveBeenCalled();

    await subscription.close();
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
