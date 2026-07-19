import type { ChildProcess } from "node:child_process";
import net from "node:net";
import { tmpdir } from "node:os";
import type { Logger } from "pino";

import { findExecutable } from "../../../../executable-resolution/executable-resolution.js";
import { spawnProcess, type SpawnProcessOptions } from "../../../../utils/spawn.js";
import { terminateWithTreeKill, type ProcessTerminator } from "../../../../utils/tree-kill.js";
import type { ManagedProcessRegistry } from "../../../managed-processes/managed-processes.js";
import {
  createProviderEnvSpec,
  resolveProviderCommandPrefix,
  type ProviderRuntimeSettings,
} from "../../provider-launch-config.js";
import { CrushHttpClient, CrushHttpError } from "./http-client.js";

const STARTUP_TIMEOUT_MS = 30_000;
const STARTUP_POLL_MS = 100;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5_000;
const FORCE_SHUTDOWN_TIMEOUT_MS = 1_000;

export interface CrushServerAcquisition {
  server: { port: number; url: string };
  release(): Promise<void>;
}

export interface CrushServerManagerLike {
  acquireCurrent(): Promise<CrushServerAcquisition>;
  acquireNew(): Promise<CrushServerAcquisition>;
  shutdown(): Promise<void>;
}

interface CrushServerGeneration {
  process: ChildProcess;
  port: number;
  url: string;
  refCount: number;
  ready: Promise<void>;
  managedProcessId?: string;
  managedProcessRecord?: Promise<{ id: string } | null>;
  spawnError?: Error;
  stopPromise?: Promise<void>;
}

export interface CrushServerManagerOptions {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
  managedProcesses?: ManagedProcessRegistry;
  terminateProcess?: ProcessTerminator;
  portAllocator?: () => Promise<number>;
  resolveCommandPrefix?: () => Promise<{ command: string; args: string[] }>;
  spawnServerProcess?: (
    command: string,
    args: string[],
    options: SpawnProcessOptions,
  ) => ChildProcess;
  fetchImpl?: typeof fetch;
}

export class CrushServerManager implements CrushServerManagerLike {
  private static readonly instances = new Map<string, CrushServerManager>();
  private static exitHandlerRegistered = false;

  private currentServer: CrushServerGeneration | null = null;
  private startPromise: Promise<CrushServerGeneration> | null = null;
  private readonly startingServers = new Set<CrushServerGeneration>();
  private shuttingDown = false;
  private readonly logger: Logger;
  private readonly runtimeSettings?: ProviderRuntimeSettings;
  private readonly managedProcesses?: ManagedProcessRegistry;
  private readonly terminateProcess: ProcessTerminator;
  private readonly portAllocator: () => Promise<number>;
  private readonly resolveCommandPrefix: () => Promise<{ command: string; args: string[] }>;
  private readonly spawnServerProcess: NonNullable<CrushServerManagerOptions["spawnServerProcess"]>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CrushServerManagerOptions) {
    this.logger = options.logger;
    this.runtimeSettings = options.runtimeSettings;
    this.managedProcesses = options.managedProcesses;
    this.terminateProcess = options.terminateProcess ?? terminateWithTreeKill;
    this.portAllocator = options.portAllocator ?? findAvailablePort;
    this.resolveCommandPrefix =
      options.resolveCommandPrefix ??
      (() => resolveProviderCommandPrefix(this.runtimeSettings?.command, resolveCrushBinary));
    this.spawnServerProcess = options.spawnServerProcess ?? spawnProcess;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  static getInstance(
    logger: Logger,
    runtimeSettings?: ProviderRuntimeSettings,
    options: Omit<CrushServerManagerOptions, "logger" | "runtimeSettings"> = {},
  ): CrushServerManager {
    const settingsKey = JSON.stringify(runtimeSettings ?? {});
    let instance = CrushServerManager.instances.get(settingsKey);
    if (!instance) {
      instance = new CrushServerManager({
        logger,
        runtimeSettings,
        ...options,
      });
      CrushServerManager.instances.set(settingsKey, instance);
      CrushServerManager.registerExitHandler();
    }
    return instance;
  }

  private static registerExitHandler(): void {
    if (CrushServerManager.exitHandlerRegistered) return;
    CrushServerManager.exitHandlerRegistered = true;
    const cleanup = () => {
      for (const instance of CrushServerManager.instances.values()) void instance.shutdown();
    };
    process.on("exit", cleanup);
    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);
  }

  async acquireCurrent(): Promise<CrushServerAcquisition> {
    const server = await this.getCurrentServer(false);
    return this.acquire(server);
  }

  async acquireNew(): Promise<CrushServerAcquisition> {
    const server = await this.getCurrentServer(true);
    return this.acquire(server);
  }

  private acquire(server: CrushServerGeneration): CrushServerAcquisition {
    server.refCount += 1;
    let releasePromise: Promise<void> | null = null;
    return {
      server: { port: server.port, url: server.url },
      release: async () => {
        releasePromise ??= this.release(server);
        await releasePromise;
      },
    };
  }

  private async release(server: CrushServerGeneration): Promise<void> {
    server.refCount = Math.max(0, server.refCount - 1);
    if (server.refCount > 0) return;
    if (this.currentServer === server) this.currentServer = null;
    await this.stopServer(server);
  }

  private async getCurrentServer(forceNew: boolean): Promise<CrushServerGeneration> {
    if (this.shuttingDown) throw new Error("Crush server manager is shutting down");
    if (this.startPromise) {
      const starting = await this.startPromise;
      await starting.ready;
      return starting;
    }

    const current = this.currentServer;
    if (!forceNew && current && this.isLive(current)) {
      try {
        await new CrushHttpClient(current.url, this.logger, this.fetchImpl).health();
        return current;
      } catch (error) {
        this.logger.debug({ err: error }, "Discarding unresponsive Crush server generation");
      }
    }
    if (forceNew && current && current.refCount > 0 && this.isLive(current)) {
      try {
        await new CrushHttpClient(current.url, this.logger, this.fetchImpl).health();
        return current;
      } catch (error) {
        this.logger.debug({ err: error }, "Replacing failed shared Crush server generation");
      }
    }
    if (current) {
      this.currentServer = null;
      await this.stopServer(current);
    }

    const start = this.startServer();
    this.startPromise = start;
    try {
      const server = await start;
      this.currentServer = server;
      await server.ready;
      return server;
    } finally {
      if (this.startPromise === start) this.startPromise = null;
    }
  }

  private async startServer(): Promise<CrushServerGeneration> {
    const port = await this.portAllocator();
    const url = `http://127.0.0.1:${port}`;
    const launch = await this.resolveCommandPrefix();
    if (this.shuttingDown) throw new Error("Crush server manager is shutting down");
    const args = [...launch.args, "server", "--host", `tcp://127.0.0.1:${port}`];
    const child = this.spawnServerProcess(launch.command, args, {
      cwd: tmpdir(),
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      ...createProviderEnvSpec({ runtimeSettings: this.runtimeSettings }),
    });
    const managedProcessRecord = this.recordManagedProcess(child, launch.command, args, port);
    const generation: CrushServerGeneration = {
      process: child,
      port,
      url,
      refCount: 0,
      ready: Promise.resolve(),
      managedProcessRecord,
    };
    this.startingServers.add(generation);
    void managedProcessRecord.then((record) => {
      if (record && generation.managedProcessRecord === managedProcessRecord) {
        generation.managedProcessId = record.id;
      }
      return undefined;
    });

    let stdout = "";
    let stderr = "";
    const append = (current: string, chunk: Buffer) => `${current}${chunk.toString()}`.slice(-8192);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
      this.logger.debug({ output: chunk.toString().trim() }, "Crush server stdout");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
      this.logger.debug({ output: chunk.toString().trim() }, "Crush server stderr");
    });
    child.on("exit", () => {
      this.startingServers.delete(generation);
      this.removeManagedRecord(generation);
      if (this.currentServer === generation) this.currentServer = null;
    });
    child.on("error", (error) => {
      generation.spawnError = error;
    });

    generation.ready = this.waitForHealth(generation, () => ({ stdout, stderr })).catch(
      async (error) => {
        if (this.currentServer === generation) this.currentServer = null;
        await this.stopServer(generation);
        throw error;
      },
    );
    void generation.ready.then(
      () => this.startingServers.delete(generation),
      () => this.startingServers.delete(generation),
    );
    return generation;
  }

  private async waitForHealth(
    generation: CrushServerGeneration,
    output: () => { stdout: string; stderr: string },
  ): Promise<void> {
    const client = new CrushHttpClient(generation.url, this.logger, this.fetchImpl);
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    let lastError: unknown;
    while (Date.now() < deadline) {
      if (generation.spawnError) {
        throw new Error(`Crush server failed to start: ${generation.spawnError.message}`, {
          cause: generation.spawnError,
        });
      }
      if (!this.isLive(generation)) {
        const captured = output();
        throw new Error(
          [
            `Crush server exited before becoming ready (code ${generation.process.exitCode ?? "unknown"})`,
            captured.stderr.trim() ? `stderr: ${captured.stderr.trim()}` : "",
            captured.stdout.trim() ? `stdout: ${captured.stdout.trim()}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }
      try {
        await client.health();
        await client.version();
        await client.assertRequiredRoutes();
        return;
      } catch (error) {
        if (error instanceof CrushHttpError && error.status === 404) throw error;
        lastError = error;
      }
      await delay(STARTUP_POLL_MS);
    }
    throw new Error(`Crush server startup timed out: ${toErrorMessage(lastError)}`);
  }

  private isLive(server: CrushServerGeneration): boolean {
    return server.process.exitCode === null && server.process.signalCode === null;
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const starting = this.startPromise ? await this.startPromise.catch(() => null) : null;
    const servers = new Set([
      ...(this.currentServer ? [this.currentServer] : []),
      ...(starting ? [starting] : []),
      ...this.startingServers,
    ]);
    await Promise.all([...servers].map((server) => this.stopServer(server)));
    this.currentServer = null;
    this.startingServers.clear();
    for (const [key, instance] of CrushServerManager.instances) {
      if (instance === this) CrushServerManager.instances.delete(key);
    }
  }

  private async stopServer(server: CrushServerGeneration): Promise<void> {
    server.stopPromise ??= this.stopServerOnce(server);
    await server.stopPromise;
  }

  private async stopServerOnce(server: CrushServerGeneration): Promise<void> {
    if (!this.isLive(server)) {
      this.removeManagedRecord(server);
      return;
    }
    try {
      await new CrushHttpClient(server.url, this.logger, this.fetchImpl).shutdown();
      if (await waitForExit(server.process, GRACEFUL_SHUTDOWN_TIMEOUT_MS)) {
        this.removeManagedRecord(server);
        return;
      }
    } catch (error) {
      this.logger.debug({ err: error }, "Crush graceful shutdown request failed");
    }
    const result = await this.terminateProcess(server.process, {
      gracefulTimeoutMs: GRACEFUL_SHUTDOWN_TIMEOUT_MS,
      forceTimeoutMs: FORCE_SHUTDOWN_TIMEOUT_MS,
      onForceSignal: () => this.logger.warn("Crush server did not stop; sending force signal"),
    });
    if (result === "kill-timeout")
      this.logger.warn("Crush server did not report exit after force signal");
    this.removeManagedRecord(server);
  }

  private async recordManagedProcess(
    child: ChildProcess,
    command: string,
    args: string[],
    port: number,
  ): Promise<{ id: string } | null> {
    if (!this.managedProcesses || !child.pid) return null;
    try {
      return await this.managedProcesses.record({
        owner: { provider: "crush", kind: "helper-server" },
        pid: child.pid,
        command,
        args,
        metadata: { port },
      });
    } catch (error) {
      this.logger.warn({ err: error, pid: child.pid }, "Failed to record Crush server process");
      return null;
    }
  }

  private removeManagedRecord(server: CrushServerGeneration): void {
    const id = server.managedProcessId;
    const pending = server.managedProcessRecord;
    server.managedProcessId = undefined;
    server.managedProcessRecord = undefined;
    if (id) {
      void this.managedProcesses
        ?.remove(id)
        .catch((error) =>
          this.logger.warn({ err: error, id }, "Failed to remove Crush process record"),
        );
    } else if (pending) {
      void pending
        .then((record) => record && this.managedProcesses?.remove(record.id))
        .catch((error) =>
          this.logger.warn({ err: error }, "Failed to remove pending Crush process record"),
        );
    }
  }
}

async function resolveCrushBinary(): Promise<string> {
  const found = await findExecutable("crush");
  if (!found) {
    throw new Error(
      "Crush binary not found. Install Crush and ensure `crush` is available in your shell PATH.",
    );
  }
  return found;
}

function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("Failed to allocate Crush server port"));
      });
    });
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  let timer: NodeJS.Timeout;
  let onExit: () => void;
  const exited = new Promise<boolean>((resolve) => {
    onExit = () => resolve(true);
    child.once("exit", onExit);
  });
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  return Promise.race([exited, timedOut]).finally(() => {
    clearTimeout(timer);
    child.off("exit", onExit);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}
