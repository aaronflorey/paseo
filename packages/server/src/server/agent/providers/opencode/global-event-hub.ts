import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";

const OPENCODE_GLOBAL_EVENT_LISTENER_BACKLOG_LIMIT = 1_024;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export interface OpenCodeGlobalEventSubscription {
  ready: Promise<void>;
  done: Promise<void>;
  close(): Promise<void>;
}

interface OpenCodeGlobalEventListener {
  ready: Deferred<void>;
  done: Deferred<void>;
  closed: boolean;
  eventChain: Promise<void>;
  pendingEvents: number;
  acceptsEvent: (rawEvent: unknown) => boolean;
  onEvent: (rawEvent: unknown, eventCount: number) => Promise<void>;
  onEnd: (error: unknown) => Promise<void> | void;
}

class OpenCodeGlobalEventGeneration {
  private readonly abortController = new AbortController();
  private readonly finished = createDeferred<void>();
  private readonly listeners = new Set<OpenCodeGlobalEventListener>();
  private ready = false;
  private closed = false;

  constructor(
    private readonly client: OpencodeClient,
    private readonly onClosed: () => void,
  ) {
    void this.run();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  subscribe(options: {
    acceptsEvent?: OpenCodeGlobalEventListener["acceptsEvent"];
    onEvent: OpenCodeGlobalEventListener["onEvent"];
    onEnd: OpenCodeGlobalEventListener["onEnd"];
  }): OpenCodeGlobalEventSubscription {
    const listener: OpenCodeGlobalEventListener = {
      ready: createDeferred<void>(),
      done: createDeferred<void>(),
      closed: false,
      eventChain: Promise.resolve(),
      pendingEvents: 0,
      acceptsEvent: options.acceptsEvent ?? (() => true),
      onEvent: options.onEvent,
      onEnd: options.onEnd,
    };
    this.listeners.add(listener);
    if (this.ready) {
      listener.ready.resolve();
    }
    return {
      ready: listener.ready.promise,
      done: listener.done.promise,
      close: async () => {
        if (listener.closed) {
          return listener.done.promise;
        }
        listener.closed = true;
        this.listeners.delete(listener);
        listener.ready.resolve();
        if (this.listeners.size === 0) {
          this.abortController.abort();
          await this.finished.promise;
        }
        listener.done.resolve();
        await listener.done.promise;
      },
    };
  }

  private async run(): Promise<void> {
    let terminalError: unknown = null;
    try {
      const result = await this.client.global.event({
        signal: this.abortController.signal,
        sseMaxRetryAttempts: 0,
      });
      this.ready = true;
      for (const listener of this.listeners) {
        listener.ready.resolve();
      }

      let eventCount = 0;
      for await (const rawEvent of result.stream) {
        if (this.abortController.signal.aborted) {
          break;
        }
        eventCount += 1;
        for (const listener of this.listeners) {
          this.enqueueEvent(listener, rawEvent, eventCount);
        }
      }
      await Promise.all(Array.from(this.listeners, (listener) => listener.eventChain));
      if (!this.abortController.signal.aborted) {
        terminalError = new Error(
          "OpenCode event stream ended before the session reached a terminal state",
        );
      }
    } catch (error) {
      if (!this.abortController.signal.aborted) {
        terminalError = error;
      }
    } finally {
      this.closed = true;
      const listeners = Array.from(this.listeners);
      this.listeners.clear();
      try {
        await Promise.all(
          listeners.map((listener) =>
            this.endListener(listener, terminalError).catch(() => undefined),
          ),
        );
      } finally {
        this.onClosed();
        this.finished.resolve();
      }
    }
  }

  private enqueueEvent(
    listener: OpenCodeGlobalEventListener,
    rawEvent: unknown,
    eventCount: number,
  ): void {
    if (listener.closed) {
      return;
    }
    try {
      if (!listener.acceptsEvent(rawEvent)) {
        return;
      }
    } catch (error) {
      this.listeners.delete(listener);
      void this.endListener(listener, error);
      if (this.listeners.size === 0) {
        this.abortController.abort();
      }
      return;
    }
    if (listener.pendingEvents >= OPENCODE_GLOBAL_EVENT_LISTENER_BACKLOG_LIMIT) {
      this.listeners.delete(listener);
      void this.endListener(
        listener,
        new Error(
          `OpenCode event subscriber exceeded the ${OPENCODE_GLOBAL_EVENT_LISTENER_BACKLOG_LIMIT}-event backlog limit`,
        ),
      );
      if (this.listeners.size === 0) {
        this.abortController.abort();
      }
      return;
    }

    listener.pendingEvents += 1;
    listener.eventChain = listener.eventChain
      .then(() => this.deliverEvent(listener, rawEvent, eventCount))
      .finally(() => {
        listener.pendingEvents = Math.max(0, listener.pendingEvents - 1);
      });
  }

  private async deliverEvent(
    listener: OpenCodeGlobalEventListener,
    rawEvent: unknown,
    eventCount: number,
  ): Promise<void> {
    if (listener.closed) {
      return;
    }
    try {
      await listener.onEvent(rawEvent, eventCount);
    } catch (error) {
      this.listeners.delete(listener);
      await this.endListener(listener, error);
      if (this.listeners.size === 0) {
        this.abortController.abort();
      }
    }
  }

  private async endListener(listener: OpenCodeGlobalEventListener, error: unknown): Promise<void> {
    if (listener.closed) {
      return;
    }
    listener.closed = true;
    if (!this.ready && error) {
      listener.ready.reject(error);
    } else {
      listener.ready.resolve();
    }
    if (error) {
      try {
        await listener.onEnd(error);
      } catch {
        // A subscriber's teardown must not terminate the shared stream for the
        // remaining OpenCode sessions.
      } finally {
        listener.done.resolve();
      }
      return;
    }
    listener.done.resolve();
  }
}

export class OpenCodeGlobalEventHub {
  private readonly generations = new Map<string | OpencodeClient, OpenCodeGlobalEventGeneration>();

  subscribe(options: {
    serverUrl?: string;
    client: OpencodeClient;
    acceptsEvent?: OpenCodeGlobalEventListener["acceptsEvent"];
    onEvent: OpenCodeGlobalEventListener["onEvent"];
    onEnd: OpenCodeGlobalEventListener["onEnd"];
  }): OpenCodeGlobalEventSubscription {
    const key = options.serverUrl ?? options.client;
    let generation = this.generations.get(key);
    if (!generation || generation.isClosed) {
      generation = new OpenCodeGlobalEventGeneration(options.client, () => {
        if (this.generations.get(key) === generation) {
          this.generations.delete(key);
        }
      });
      this.generations.set(key, generation);
    }
    return generation.subscribe(options);
  }
}

export const openCodeGlobalEventHub = new OpenCodeGlobalEventHub();
