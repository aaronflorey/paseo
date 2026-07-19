import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { PaseoToolCatalog } from "../../tools/types.js";

export const OPENCODE_SESSION_ID_TOOL_ARGUMENT = "__paseoOpenCodeSessionId";
export const OPENCODE_SHARED_MCP_CALLER_ID = "opencode-shared";
export const OPENCODE_SESSION_ROUTING_MODE = "opencode-session";
export const OPENCODE_SESSION_CONTEXT_URL_ENV = "PASEO_OPENCODE_SESSION_CONTEXT_URL";
export const OPENCODE_SESSION_CONTEXT_TOKEN_ENV = "PASEO_OPENCODE_SESSION_CONTEXT_TOKEN";

export interface OpenCodeSessionContext {
  env: Readonly<Record<string, string>>;
  paseoTools?: PaseoToolCatalog;
}

export type OpenCodeSessionContextBindingKind = "direct" | "inherited";

interface OpenCodeSessionContextBinding {
  id: number;
  kind: OpenCodeSessionContextBindingKind;
  context: OpenCodeSessionContext;
}

export class OpenCodeSessionContextRegistry {
  private readonly bindingsBySessionId = new Map<string, OpenCodeSessionContextBinding[]>();
  private nextBindingId = 1;

  bind(
    sessionId: string,
    context: OpenCodeSessionContext,
    kind: OpenCodeSessionContextBindingKind = "direct",
  ): () => void {
    const binding: OpenCodeSessionContextBinding = {
      id: this.nextBindingId++,
      kind,
      context,
    };
    const bindings = this.bindingsBySessionId.get(sessionId) ?? [];
    bindings.push(binding);
    this.bindingsBySessionId.set(sessionId, bindings);

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const current = this.bindingsBySessionId.get(sessionId);
      if (!current) {
        return;
      }
      const next = current.filter((candidate) => candidate.id !== binding.id);
      if (next.length === 0) {
        this.bindingsBySessionId.delete(sessionId);
      } else {
        this.bindingsBySessionId.set(sessionId, next);
      }
    };
  }

  resolve(sessionId: string): OpenCodeSessionContext | undefined {
    const bindings = this.bindingsBySessionId.get(sessionId);
    if (!bindings || bindings.length === 0) {
      return undefined;
    }
    for (let index = bindings.length - 1; index >= 0; index -= 1) {
      const binding = bindings[index];
      if (binding?.kind === "direct") {
        return binding.context;
      }
    }
    return bindings.at(-1)?.context;
  }

  clear(): void {
    this.bindingsBySessionId.clear();
  }
}

export const openCodeSessionContextRegistry = new OpenCodeSessionContextRegistry();

export interface OpenCodeSessionContextBridgeInfo {
  url: string;
  token: string;
}

export class OpenCodeSessionContextBridge {
  private server: Server | null = null;
  private startPromise: Promise<OpenCodeSessionContextBridgeInfo> | null = null;
  private readonly token = randomUUID();

  constructor(private readonly registry: OpenCodeSessionContextRegistry) {}

  start(): Promise<OpenCodeSessionContextBridgeInfo> {
    if (this.startPromise) {
      return this.startPromise;
    }
    const startPromise = new Promise<OpenCodeSessionContextBridgeInfo>((resolve, reject) => {
      const server = createServer((request, response) => {
        const authorization = request.headers.authorization;
        if (authorization !== `Bearer ${this.token}`) {
          response.writeHead(401).end();
          return;
        }
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (request.method !== "GET" || url.pathname !== "/session-context") {
          response.writeHead(404).end();
          return;
        }
        const sessionId = url.searchParams.get("sessionId")?.trim();
        const context = sessionId ? this.registry.resolve(sessionId) : undefined;
        if (!context) {
          response.writeHead(404).end();
          return;
        }
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ env: context.env }));
      });
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        this.server = server;
        const address = server.address() as AddressInfo;
        resolve({
          url: `http://127.0.0.1:${address.port}/session-context`,
          token: this.token,
        });
      });
    });
    const trackedStartPromise = startPromise.catch((error) => {
      this.startPromise = null;
      throw error;
    });
    this.startPromise = trackedStartPromise;
    return trackedStartPromise;
  }

  async close(): Promise<void> {
    if (!this.server && this.startPromise) {
      await this.startPromise.catch(() => undefined);
    }
    const server = this.server;
    this.server = null;
    this.startPromise = null;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

export const openCodeSessionContextBridge = new OpenCodeSessionContextBridge(
  openCodeSessionContextRegistry,
);
