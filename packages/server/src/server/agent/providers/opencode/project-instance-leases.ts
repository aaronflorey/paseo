import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { normalizePathForIdentity } from "../../../../utils/path.js";

interface ProjectInstanceLeaseState {
  active: number;
  pendingAcquires: number;
  dirty: boolean;
  transition: Promise<void>;
  dispose: () => Promise<void>;
}

export interface OpenCodeProjectInstanceLease {
  release(): Promise<void>;
}

export class OpenCodeProjectInstanceLeaseCoordinator {
  private readonly statesByGeneration = new Map<object, Map<string, ProjectInstanceLeaseState>>();

  constructor(private readonly onDisposeError: (error: unknown, directory: string) => void) {}

  async acquire(input: {
    serverGeneration: object;
    directory: string;
    client: Pick<OpencodeClient, "instance">;
  }): Promise<OpenCodeProjectInstanceLease> {
    const directory = input.directory;
    const directoryKey = normalizePathForIdentity(directory);
    let generationStates = this.statesByGeneration.get(input.serverGeneration);
    if (!generationStates) {
      generationStates = new Map();
      this.statesByGeneration.set(input.serverGeneration, generationStates);
    }
    let state = generationStates.get(directoryKey);
    const dispose = async () => {
      const response = await input.client.instance.dispose({ directory });
      if (response.error) {
        throw new Error(
          `OpenCode project instance disposal failed: ${JSON.stringify(response.error)}`,
        );
      }
    };
    if (!state) {
      state = {
        active: 0,
        pendingAcquires: 0,
        dirty: false,
        transition: Promise.resolve(),
        dispose,
      };
      generationStates.set(directoryKey, state);
    } else {
      state.dispose = dispose;
    }

    state.pendingAcquires += 1;
    const acquireTransition = state.transition.then(async () => {
      if (state.dirty && state.active === 0) {
        try {
          await state.dispose();
          state.dirty = false;
        } catch (error) {
          throw new Error(
            `OpenCode project configuration could not be refreshed for '${directory}'`,
            { cause: error },
          );
        }
      }
      state.active += 1;
      return undefined;
    });
    state.transition = acquireTransition.catch(() => undefined);
    try {
      await acquireTransition;
    } finally {
      state.pendingAcquires -= 1;
    }

    let releasePromise: Promise<void> | null = null;
    return {
      release: () => {
        if (releasePromise) {
          return releasePromise;
        }
        releasePromise = this.release(input.serverGeneration, directoryKey, state);
        return releasePromise;
      },
    };
  }

  clear(): void {
    this.statesByGeneration.clear();
  }

  private async release(
    serverGeneration: object,
    directory: string,
    state: ProjectInstanceLeaseState,
  ): Promise<void> {
    state.active = Math.max(0, state.active - 1);
    if (state.active > 0) {
      return;
    }
    const dispose = state.transition.then(async () => {
      if (state.active > 0) {
        return undefined;
      }
      try {
        await state.dispose();
        state.dirty = false;
      } catch (error) {
        state.dirty = true;
        this.onDisposeError(error, directory);
      }
      return undefined;
    });
    state.transition = dispose.catch(() => undefined);
    await state.transition;
    if (
      state.active === 0 &&
      state.pendingAcquires === 0 &&
      !state.dirty &&
      this.statesByGeneration.get(serverGeneration)?.get(directory) === state
    ) {
      const generationStates = this.statesByGeneration.get(serverGeneration);
      generationStates?.delete(directory);
      if (generationStates?.size === 0) {
        this.statesByGeneration.delete(serverGeneration);
      }
    }
  }
}
