import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { ProcessTerminator } from "../../../../utils/tree-kill.js";
import { CrushServerManager } from "./server-manager.js";

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  exit(code = 0): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.emit("exit", code, null);
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

interface ManagerRuntime {
  manager: CrushServerManager;
  children: FakeChildProcess[];
  launched: Array<{ command: string; args: string[] }>;
  terminated: number[];
  setMissingRoutes(value: boolean): void;
  setControlFailure(value: boolean): void;
}

function createManager(): ManagerRuntime {
  const children: FakeChildProcess[] = [];
  const launched: Array<{ command: string; args: string[] }> = [];
  const terminated: number[] = [];
  let nextPort = 4701;
  let missingRoutes = false;
  let controlFailure = false;
  const terminateProcess: ProcessTerminator = vi.fn(async (child) => {
    const fake = child as FakeChildProcess;
    terminated.push(fake.pid);
    fake.exit();
    return "terminated";
  });
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/control")) {
      if (controlFailure) return new Response("failed", { status: 500 });
      children.at(-1)?.exit();
      return new Response(null, { status: 200 });
    }
    if (init?.method === "OPTIONS") {
      return new Response(null, { status: missingRoutes ? 404 : 405 });
    }
    if (url.endsWith("/v1/version")) {
      return Response.json({ version: "v0.85.0" });
    }
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  const manager = new CrushServerManager({
    logger: createTestLogger(),
    portAllocator: async () => nextPort++,
    resolveCommandPrefix: async () => ({ command: "crush-custom", args: ["--profile", "paseo"] }),
    spawnServerProcess: (command, args) => {
      launched.push({ command, args });
      const child = new FakeChildProcess(10_000 + children.length);
      children.push(child);
      return child as unknown as ChildProcess;
    },
    terminateProcess,
    fetchImpl,
  });
  return {
    manager,
    children,
    launched,
    terminated,
    setMissingRoutes: (value) => {
      missingRoutes = value;
    },
    setControlFailure: (value) => {
      controlFailure = value;
    },
  };
}

describe("CrushServerManager", () => {
  test("single-flights startup and reuses the active server generation", async () => {
    const runtime = createManager();

    const [first, second] = await Promise.all([
      runtime.manager.acquireCurrent(),
      runtime.manager.acquireCurrent(),
    ]);
    const forced = await runtime.manager.acquireNew();

    expect(first.server.url).toBe("http://127.0.0.1:4701");
    expect(second.server.url).toBe(first.server.url);
    expect(forced.server.url).toBe(first.server.url);
    expect(runtime.launched).toEqual([
      {
        command: "crush-custom",
        args: ["--profile", "paseo", "server", "--host", "tcp://127.0.0.1:4701"],
      },
    ]);

    await first.release();
    await second.release();
    await forced.release();
    expect(runtime.children[0].exitCode).toBe(0);
  });

  test("starts a fresh generation after Crush exits automatically", async () => {
    const runtime = createManager();
    const first = await runtime.manager.acquireCurrent();
    runtime.children[0].exit();

    const resumed = await runtime.manager.acquireCurrent();

    expect(resumed.server.url).toBe("http://127.0.0.1:4702");
    expect(runtime.launched).toHaveLength(2);
    await first.release();
    await resumed.release();
  });

  test("fails fast with an upgrade diagnostic when required routes are absent", async () => {
    const runtime = createManager();
    runtime.setMissingRoutes(true);

    await expect(runtime.manager.acquireCurrent()).rejects.toThrow(
      /missing required API route.*update Crush/iu,
    );
    expect(runtime.children[0].exitCode).toBe(0);
  });

  test("falls back to process-tree termination when graceful control fails", async () => {
    const runtime = createManager();
    runtime.setControlFailure(true);
    const acquisition = await runtime.manager.acquireCurrent();

    await acquisition.release();

    expect(runtime.terminated).toEqual([10_000]);
  });
});
