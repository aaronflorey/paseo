import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { describe, expect, it, vi } from "vitest";

import { OpenCodeProjectInstanceLeaseCoordinator } from "./project-instance-leases.js";

function createClient(dispose: () => Promise<{ data?: unknown; error?: unknown }>) {
  return {
    instance: { dispose },
  } as unknown as Pick<OpencodeClient, "instance">;
}

describe("OpenCodeProjectInstanceLeaseCoordinator", () => {
  const serverGeneration = {};

  it("disposes a directory only after its final active lease closes", async () => {
    const dispose = vi.fn().mockResolvedValue({ data: true });
    const coordinator = new OpenCodeProjectInstanceLeaseCoordinator(() => undefined);
    const client = createClient(dispose);
    const first = await coordinator.acquire({
      serverGeneration,
      directory: "/workspace/a",
      client,
    });
    const second = await coordinator.acquire({
      serverGeneration,
      directory: "/workspace/a",
      client,
    });

    await first.release();
    expect(dispose).not.toHaveBeenCalled();
    await second.release();
    expect(dispose).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledWith({ directory: "/workspace/a" });
  });

  it("shares leases across lexically equivalent directory spellings", async () => {
    const dispose = vi.fn().mockResolvedValue({ data: true });
    const coordinator = new OpenCodeProjectInstanceLeaseCoordinator(() => undefined);
    const client = createClient(dispose);
    const first = await coordinator.acquire({
      serverGeneration,
      directory: "/workspace/a/",
      client,
    });
    const second = await coordinator.acquire({
      serverGeneration,
      directory: "/workspace/./a",
      client,
    });

    await first.release();
    expect(dispose).not.toHaveBeenCalled();
    await second.release();
    expect(dispose).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledWith({ directory: "/workspace/./a" });
  });

  it("isolates the same directory across shared-server generations", async () => {
    const disposeFirst = vi.fn().mockResolvedValue({ data: true });
    const disposeSecond = vi.fn().mockResolvedValue({ data: true });
    const coordinator = new OpenCodeProjectInstanceLeaseCoordinator(() => undefined);
    const first = await coordinator.acquire({
      serverGeneration: {},
      directory: "/workspace/a",
      client: createClient(disposeFirst),
    });
    const second = await coordinator.acquire({
      serverGeneration: {},
      directory: "/workspace/a",
      client: createClient(disposeSecond),
    });

    await first.release();
    expect(disposeFirst).toHaveBeenCalledOnce();
    expect(disposeSecond).not.toHaveBeenCalled();
    await second.release();
    expect(disposeSecond).toHaveBeenCalledOnce();
  });

  it("reloads project A config without disturbing active project B", async () => {
    const configSource = new Map([
      ["/workspace/a", "a-v1"],
      ["/workspace/b", "b-v1"],
    ]);
    const configCache = new Map<string, string>();
    const readConfig = (directory: string) => {
      const cached = configCache.get(directory);
      if (cached) return cached;
      const loaded = configSource.get(directory) ?? "missing";
      configCache.set(directory, loaded);
      return loaded;
    };
    const dispose = vi.fn(async ({ directory }: { directory: string }) => {
      configCache.delete(directory);
      return { data: true };
    });
    const coordinator = new OpenCodeProjectInstanceLeaseCoordinator(() => undefined);
    const client = createClient(dispose);
    const projectA = await coordinator.acquire({
      serverGeneration,
      directory: "/workspace/a",
      client,
    });
    const projectB = await coordinator.acquire({
      serverGeneration,
      directory: "/workspace/b",
      client,
    });
    expect(readConfig("/workspace/a")).toBe("a-v1");
    expect(readConfig("/workspace/b")).toBe("b-v1");
    configSource.set("/workspace/a", "a-v2");

    await projectA.release();
    expect(dispose).toHaveBeenCalledWith({ directory: "/workspace/a" });
    expect(dispose).not.toHaveBeenCalledWith({ directory: "/workspace/b" });
    expect(readConfig("/workspace/a")).toBe("a-v2");
    expect(readConfig("/workspace/b")).toBe("b-v1");
    const reopenedA = await coordinator.acquire({
      serverGeneration,
      directory: "/workspace/a",
      client,
    });
    expect(readConfig("/workspace/a")).toBe("a-v2");
    await reopenedA.release();
    await projectB.release();
    expect(dispose).toHaveBeenCalledWith({ directory: "/workspace/b" });
  });

  it("retries a failed disposal before reopening the project", async () => {
    const dispose = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary disposal failure"))
      .mockResolvedValue({ data: true });
    const errors: unknown[] = [];
    const coordinator = new OpenCodeProjectInstanceLeaseCoordinator((error) => errors.push(error));
    const client = createClient(dispose);
    const first = await coordinator.acquire({
      serverGeneration,
      directory: "/workspace/a",
      client,
    });

    await first.release();
    expect(errors).toHaveLength(1);
    const reopened = await coordinator.acquire({
      serverGeneration,
      directory: "/workspace/a",
      client,
    });
    expect(dispose).toHaveBeenCalledTimes(2);
    await reopened.release();
  });

  it("serializes a dirty-project retry across concurrent acquisitions", async () => {
    let resolveRetry: (() => void) | null = null;
    const retry = new Promise<void>((resolve) => {
      resolveRetry = resolve;
    });
    const dispose = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary disposal failure"))
      .mockImplementationOnce(async () => {
        await retry;
        return { data: true };
      })
      .mockResolvedValue({ data: true });
    const coordinator = new OpenCodeProjectInstanceLeaseCoordinator(() => undefined);
    const client = createClient(dispose);
    const first = await coordinator.acquire({
      serverGeneration,
      directory: "/workspace/a",
      client,
    });
    await first.release();

    const acquisitionA = coordinator.acquire({
      serverGeneration,
      directory: "/workspace/a",
      client,
    });
    const acquisitionB = coordinator.acquire({
      serverGeneration,
      directory: "/workspace/a",
      client,
    });
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(2));
    resolveRetry?.();
    const [reopenedA, reopenedB] = await Promise.all([acquisitionA, acquisitionB]);
    expect(dispose).toHaveBeenCalledTimes(2);
    await reopenedA.release();
    await reopenedB.release();
  });

  it("fails explicitly when a dirty project cannot be refreshed", async () => {
    const dispose = vi.fn().mockRejectedValue(new Error("permanent disposal failure"));
    const coordinator = new OpenCodeProjectInstanceLeaseCoordinator(() => undefined);
    const client = createClient(dispose);
    const first = await coordinator.acquire({
      serverGeneration,
      directory: "/workspace/a",
      client,
    });
    await first.release();

    await expect(
      coordinator.acquire({
        serverGeneration,
        directory: "/workspace/a",
        client,
      }),
    ).rejects.toThrow("OpenCode project configuration could not be refreshed");
  });
});
