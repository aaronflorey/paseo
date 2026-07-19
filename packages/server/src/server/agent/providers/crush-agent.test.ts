import { once } from "node:events";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentStreamEvent } from "../agent-sdk-types.js";
import { CrushAgentClient } from "./crush-agent.js";
import type { CrushServerAcquisition, CrushServerManagerLike } from "./crush/server-manager.js";

interface NativeSession {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
}

interface FakeRequestContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  method: string;
  workspaceId: string;
  suffix: string;
}

class FakeCrushServer {
  readonly paths = new Map<string, string>();
  readonly sessions = new Map<string, NativeSession>();
  readonly messages = new Map<string, unknown[]>();
  readonly eventStreams = new Map<string, Set<ServerResponse>>();
  readonly deletedSessions: string[] = [];
  readonly prompts: Array<Record<string, unknown>> = [];
  readonly currentSessions: Array<{ clientId: string; sessionId: string }> = [];
  readonly initializedWorkspaces = new Set<string>();
  readonly skipPermissions = new Map<string, boolean>();
  readonly modelInitializationCalls: string[] = [];
  private server = http.createServer((request, response) => void this.handle(request, response));
  private nextWorkspace = 1;
  private nextSession = 1;
  url = "";

  async start(): Promise<void> {
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Fake Crush did not bind TCP");
    this.url = `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    for (const streams of this.eventStreams.values()) {
      for (const stream of streams) stream.end();
    }
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", this.url);
    const method = request.method ?? "GET";
    if (await this.handleWorkspaceCollection(request, response, url, method)) return;
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] !== "v1" || segments[1] !== "workspaces") {
      json(response, { message: "not found" }, 404);
      return;
    }
    const context: FakeRequestContext = {
      request,
      response,
      url,
      method,
      workspaceId: segments[2],
      suffix: `/${segments.slice(3).join("/")}`,
    };
    if (await this.handleWorkspaceLifecycle(context)) return;
    if (await this.handleAgentRoutes(context)) return;
    if (await this.handleSessionRoutes(context)) return;
    if (await this.handleSettingsAndCatalogRoutes(context)) return;
    json(response, { message: `unhandled ${method} ${url.pathname}` }, 404);
  }

  private async handleWorkspaceCollection(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    method: string,
  ): Promise<boolean> {
    if (method !== "POST" || url.pathname !== "/v1/workspaces") return false;
    const body = await readJson(request);
    const path = String(body.path);
    let id = this.paths.get(path);
    if (!id) {
      id = `workspace-${this.nextWorkspace++}`;
      this.paths.set(path, id);
    }
    json(response, workspace(id, path));
    return true;
  }

  private async handleWorkspaceLifecycle(context: FakeRequestContext): Promise<boolean> {
    const { request, response, url, method, workspaceId, suffix } = context;
    if (method === "GET" && suffix === "/events") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
      const streams = this.eventStreams.get(workspaceId) ?? new Set<ServerResponse>();
      streams.add(response);
      this.eventStreams.set(workspaceId, streams);
      request.on("close", () => streams.delete(response));
      return true;
    }
    if (method === "DELETE" && suffix === "/") {
      response.writeHead(200).end();
      return true;
    }
    if (suffix !== "/current-session" || method !== "POST") return false;
    const body = await readJson(request);
    this.currentSessions.push({
      clientId: url.searchParams.get("client_id") ?? "",
      sessionId: String(body.session_id),
    });
    response.writeHead(200).end();
    return true;
  }

  private async handleAgentRoutes(context: FakeRequestContext): Promise<boolean> {
    const { request, response, method, workspaceId, suffix } = context;
    if (suffix === "/agent" && method === "GET") {
      json(response, {
        is_busy: false,
        is_ready: this.initializedWorkspaces.has(workspaceId),
        model: { id: "claude-sonnet", name: "Claude Sonnet" },
        model_cfg: { provider: "anthropic", model: "claude-sonnet" },
      });
      return true;
    }
    if (suffix === "/agent/init" && method === "POST") {
      this.modelInitializationCalls.push("agent/init");
      this.initializedWorkspaces.add(workspaceId);
      response.writeHead(200).end();
      return true;
    }
    if (suffix === "/agent" && method === "POST") {
      const body = await readJson(request);
      this.acceptPrompt(workspaceId, body);
      response.writeHead(202).end();
      return true;
    }
    if (suffix === "/agent/update" && method === "POST") {
      this.modelInitializationCalls.push("agent/update");
      response.writeHead(200).end();
      return true;
    }
    if (suffix === "/agent/default-small-model" && method === "GET") {
      json(response, { provider: "anthropic", model: "claude-haiku" });
      return true;
    }
    if (suffix.includes("/agent/sessions/") && method === "POST") {
      response.writeHead(200).end();
      return true;
    }
    return false;
  }

  private async handleSessionRoutes(context: FakeRequestContext): Promise<boolean> {
    const { request, response, method, suffix } = context;
    if (suffix === "/sessions" && method === "POST") {
      const body = await readJson(request);
      const now = this.nextSession;
      const session = {
        id: `session-${this.nextSession++}`,
        title: String(body.title),
        created_at: now,
        updated_at: now,
      };
      this.sessions.set(session.id, session);
      this.messages.set(session.id, []);
      json(response, sessionResponse(session));
      return true;
    }
    if (suffix === "/sessions" && method === "GET") {
      json(response, [...this.sessions.values()].map(sessionResponse));
      return true;
    }
    const sessionMatch = suffix.match(/^\/sessions\/([^/]+)(?:\/messages)?$/u);
    if (!sessionMatch) return false;
    const sessionId = decodeURIComponent(sessionMatch[1]);
    if (method === "DELETE") {
      this.deletedSessions.push(sessionId);
      this.sessions.delete(sessionId);
      response.writeHead(200).end();
      return true;
    }
    if (method === "GET" && suffix.endsWith("/messages")) {
      json(response, this.messages.get(sessionId) ?? []);
      return true;
    }
    const session = this.sessions.get(sessionId);
    json(
      response,
      session ? sessionResponse(session) : { message: "session not found" },
      session ? 200 : 404,
    );
    return true;
  }

  private async handleSettingsAndCatalogRoutes(context: FakeRequestContext): Promise<boolean> {
    const { request, response, method, workspaceId, suffix } = context;
    if (suffix === "/permissions/skip") {
      if (method === "GET") {
        json(response, { skip: this.skipPermissions.get(workspaceId) ?? false });
        return true;
      }
      const body = await readJson(request);
      this.skipPermissions.set(workspaceId, body.skip === true);
      response.writeHead(200).end();
      return true;
    }
    if (suffix === "/providers" && method === "GET") {
      json(response, [
        {
          id: "anthropic",
          name: "Anthropic",
          models: [
            {
              id: "claude-sonnet",
              name: "Claude Sonnet",
              context_window: 200_000,
              can_reason: true,
              supports_attachments: true,
            },
          ],
        },
      ]);
      return true;
    }
    if (suffix === "/config" && method === "GET") {
      json(response, {
        models: { large: { provider: "anthropic", model: "claude-sonnet" } },
      });
      return true;
    }
    if (suffix === "/skills" && method === "GET") {
      json(response, [
        {
          id: "review",
          name: "review",
          description: "Review changes",
          label: "Review",
          source: "test",
          user_invocable: true,
        },
      ]);
      return true;
    }
    if (suffix === "/skills/read" && method === "POST") {
      json(response, {
        content: Buffer.from("# Review skill").toString("base64"),
        result: { name: "review", description: "Review changes", source: "test", builtin: false },
      });
      return true;
    }
    if (suffix === "/config/model" && method === "POST") {
      const body = await readJson(request);
      this.modelInitializationCalls.push(`config/model:${String(body.model_type)}`);
      response.writeHead(200).end();
      return true;
    }
    if (suffix === "/config/remove" && method === "POST") {
      response.writeHead(200).end();
      return true;
    }
    return false;
  }

  private acceptPrompt(workspaceId: string, body: Record<string, unknown>): void {
    this.prompts.push(body);
    const sessionId = String(body.session_id);
    const runId = String(body.run_id);
    const messageId = `assistant-${sessionId}-${runId}`;
    const nativeMessage = {
      id: messageId,
      role: "assistant",
      session_id: sessionId,
      parts: [{ type: "text", data: { text: "Hello from Crush" } }],
      model: "claude-sonnet",
      provider: "anthropic",
      created_at: 10,
      updated_at: 10,
    };
    this.messages.set(sessionId, [...(this.messages.get(sessionId) ?? []), nativeMessage]);
    setImmediate(() => {
      this.emit(workspaceId, "message", nativeMessage);
      this.emit(workspaceId, "run_complete", {
        session_id: sessionId,
        run_id: runId,
        message_id: messageId,
        text: "Hello from Crush",
      });
    });
  }

  private emit(workspaceId: string, type: string, payload: unknown): void {
    const data = JSON.stringify({ type, payload: { type: "updated", payload } });
    for (const stream of this.eventStreams.get(workspaceId) ?? []) {
      stream.write(`data: ${data}\n\n`);
    }
  }
}

class FakeServerManager implements CrushServerManagerLike {
  constructor(private readonly url: string) {}

  async acquireCurrent(): Promise<CrushServerAcquisition> {
    return this.acquire();
  }

  async acquireNew(): Promise<CrushServerAcquisition> {
    return this.acquire();
  }

  async shutdown(): Promise<void> {}

  private acquire(): CrushServerAcquisition {
    return {
      server: { url: this.url, port: Number(new URL(this.url).port) },
      release: async () => {},
    };
  }
}

const servers: FakeCrushServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function setup(): Promise<{ server: FakeCrushServer; client: CrushAgentClient }> {
  const server = new FakeCrushServer();
  await server.start();
  servers.push(server);
  return {
    server,
    client: new CrushAgentClient(createTestLogger(), undefined, {
      serverManager: new FakeServerManager(server.url),
    }),
  };
}

describe("CrushAgentClient", () => {
  test("configures an explicit model before initializing a fresh workspace agent", async () => {
    const { server, client } = await setup();
    const session = await client.createSession({
      provider: "crush",
      cwd: "/tmp/project-with-model",
      model: "anthropic/claude-sonnet",
    });

    expect(server.modelInitializationCalls).toEqual([
      "config/model:large",
      "config/model:small",
      "agent/init",
    ]);

    await session.close();
  });

  test("creates a native session, streams a run, persists, and resumes by cwd", async () => {
    const { server, client } = await setup();
    const session = await client.createSession({
      provider: "crush",
      cwd: "/tmp/project-a",
      title: "Paseo session",
      modeId: "ask",
    });
    const handle = session.describePersistence();

    const result = await session.run("Hello");

    expect(result.finalText).toBe("Hello from Crush");
    expect(server.prompts[0]).toMatchObject({
      session_id: session.id,
      prompt: "Hello",
      run_id: expect.any(String),
    });
    expect(server.currentSessions[0]).toMatchObject({
      clientId: expect.any(String),
      sessionId: session.id,
    });
    const skillResult = await session.run("/review focus on correctness");
    expect(skillResult.finalText).toBe("Hello from Crush");
    expect(server.prompts[1]).toMatchObject({
      prompt: "focus on correctness",
      attachments: [
        {
          file_name: "review.md",
          mime_type: "text/markdown",
          content: Buffer.from("# Review skill").toString("base64"),
        },
      ],
    });
    expect(handle).toMatchObject({ nativeHandle: session.id, metadata: { cwd: "/tmp/project-a" } });
    await session.close();

    const resumed = await client.resumeSession(handle);
    expect(resumed.id).toBe(session.id);
    expect((await resumed.getRuntimeInfo()).model).toBe("anthropic/claude-sonnet");
    await resumed.close();
    expect(server.deletedSessions).toEqual([]);
  });

  test("deletes ephemeral sessions before detaching and shares cwd mode changes", async () => {
    const { server, client } = await setup();
    const first = await client.createSession(
      { provider: "crush", cwd: "/tmp/project-a", modeId: "ask" },
      undefined,
      { persistSession: false },
    );
    const second = await client.createSession({
      provider: "crush",
      cwd: "/tmp/project-a",
      modeId: "ask",
    });
    const events: AgentStreamEvent[] = [];
    const unsubscribe = second.subscribe((event) => events.push(event));

    await first.setMode?.("full");

    expect(events).toContainEqual(
      expect.objectContaining({ type: "mode_changed", provider: "crush", currentModeId: "full" }),
    );
    await first.close();
    expect(server.deletedSessions).toEqual([first.id]);
    unsubscribe();
    await second.close();
  });

  test("discovers provider-qualified models, skills, imports, and separate cwd workspaces", async () => {
    const { server, client } = await setup();
    const first = await client.createSession({ provider: "crush", cwd: "/tmp/project-a" });
    const second = await client.createSession({ provider: "crush", cwd: "/tmp/project-b" });

    const catalog = await client.fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/project-a",
      force: false,
    });
    const commands = await client.listCommands({ provider: "crush", cwd: "/tmp/project-a" });
    const imports = await client.listImportableSessions({ cwd: "/tmp/project-a", limit: 10 });

    expect(catalog.models).toEqual([
      expect.objectContaining({ id: "anthropic/claude-sonnet", isDefault: true }),
    ]);
    expect(commands).toEqual([expect.objectContaining({ name: "review", kind: "skill" })]);
    expect(imports.map((candidate) => candidate.providerHandleId)).toContain(first.id);
    expect(await client.listImportableSessions()).toEqual([]);
    expect(server.paths.get("/tmp/project-a")).not.toBe(server.paths.get("/tmp/project-b"));

    await first.close();
    await second.close();
  });
});

function workspace(id: string, path: string) {
  return { id, path, version: "v0.85.0" };
}

function sessionResponse(session: NativeSession) {
  return {
    ...session,
    parent_session_id: "",
    message_count: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    summary_message_id: "",
    cost: 0,
    is_busy: false,
    attached_clients: 1,
  };
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
}

function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
