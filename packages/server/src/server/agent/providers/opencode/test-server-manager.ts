import type { OpenCodeServerAcquisition, OpenCodeServerManagerLike } from "./server-manager.js";
import { OpenCodeProjectInstanceLeaseCoordinator } from "./project-instance-leases.js";

export interface TestOpenCodeServerAcquisition {
  kind: "current" | "new" | "existing";
  env?: Record<string, string>;
  url?: string;
  released: boolean;
}

export class TestOpenCodeServerManager implements OpenCodeServerManagerLike {
  readonly projectInstanceLeases = new OpenCodeProjectInstanceLeaseCoordinator(() => undefined);
  readonly acquisitions: TestOpenCodeServerAcquisition[] = [];
  readonly server = { port: 1234, url: "http://127.0.0.1:1234", generation: {} as object };
  private readonly generationCleanups = new Map<object, Set<() => void>>();
  private readonly endedGenerations = new WeakSet<object>();

  registerGenerationCleanup(serverGeneration: object, cleanup: () => void): () => void {
    if (this.endedGenerations.has(serverGeneration)) {
      cleanup();
      return () => undefined;
    }
    const cleanups = this.generationCleanups.get(serverGeneration) ?? new Set();
    cleanups.add(cleanup);
    this.generationCleanups.set(serverGeneration, cleanups);
    return () => {
      cleanups.delete(cleanup);
    };
  }

  endGeneration(serverGeneration: object = this.server.generation): void {
    if (this.endedGenerations.has(serverGeneration)) {
      return;
    }
    this.endedGenerations.add(serverGeneration);
    const cleanups = this.generationCleanups.get(serverGeneration);
    this.generationCleanups.delete(serverGeneration);
    for (const cleanup of cleanups ?? []) {
      cleanup();
    }
  }

  rotateGeneration(): void {
    this.endGeneration();
    this.server.generation = {};
  }

  async acquireCurrent(): Promise<OpenCodeServerAcquisition> {
    return this.recordAcquisition({ kind: "current" });
  }

  async acquireNew(): Promise<OpenCodeServerAcquisition> {
    return this.recordAcquisition({ kind: "new" });
  }

  acquireExisting(url: string): OpenCodeServerAcquisition | null {
    return url === this.server.url ? this.recordAcquisition({ kind: "existing", url }) : null;
  }

  private recordAcquisition(input: {
    kind: TestOpenCodeServerAcquisition["kind"];
    env?: Record<string, string>;
    url?: string;
  }): OpenCodeServerAcquisition {
    const acquisition: TestOpenCodeServerAcquisition = {
      kind: input.kind,
      released: false,
      ...(input.env ? { env: input.env } : {}),
      ...(input.url ? { url: input.url } : {}),
    };
    this.acquisitions.push(acquisition);
    return {
      server: this.server,
      release: async () => {
        acquisition.released = true;
      },
    };
  }

  async shutdown(): Promise<void> {
    this.endGeneration();
    this.projectInstanceLeases.clear();
  }
}

export function createTestOpenCodeServerManager(): TestOpenCodeServerManager {
  return new TestOpenCodeServerManager();
}
