import type { Logger } from "pino";
import { z } from "zod";
import {
  CrushAgentInfoSchema,
  type CrushEventEnvelope,
  CrushMessageSchema,
  CrushProviderSchema,
  type CrushQuestionRequest,
  CrushSelectedModelSchema,
  CrushSessionSchema,
  CrushSkillInfoSchema,
  CrushSkillReadResponseSchema,
  CrushVersionInfoSchema,
  CrushWorkspaceSchema,
  parseCrushEventEnvelope,
} from "./protocol.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface CrushAttachment {
  file_path: string;
  file_name: string;
  mime_type: string;
  content: string;
}

export interface CrushEventStream {
  ready: Promise<void>;
  done: Promise<void>;
  close(): Promise<void>;
}

export class CrushHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
  ) {
    super(message);
    this.name = "CrushHttpError";
  }
}

export class CrushHttpClient {
  constructor(
    readonly baseUrl: string,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async health(): Promise<void> {
    await this.request("/v1/health", { method: "GET" });
  }

  async version() {
    return await this.requestJson("/v1/version", CrushVersionInfoSchema);
  }

  async assertRequiredRoutes(): Promise<void> {
    const requiredPaths = [
      "/v1/workspaces",
      "/v1/workspaces/paseo-capability-probe/events",
      "/v1/workspaces/paseo-capability-probe/current-session",
      "/v1/workspaces/paseo-capability-probe/agent",
      "/v1/workspaces/paseo-capability-probe/agent/init",
      "/v1/workspaces/paseo-capability-probe/agent/update",
      "/v1/workspaces/paseo-capability-probe/agent/sessions/paseo-session-probe/cancel",
      "/v1/workspaces/paseo-capability-probe/agent/sessions/paseo-session-probe/prompts/clear",
      "/v1/workspaces/paseo-capability-probe/agent/default-small-model",
      "/v1/workspaces/paseo-capability-probe/sessions",
      "/v1/workspaces/paseo-capability-probe/sessions/paseo-session-probe",
      "/v1/workspaces/paseo-capability-probe/sessions/paseo-session-probe/messages",
      "/v1/workspaces/paseo-capability-probe/providers",
      "/v1/workspaces/paseo-capability-probe/config",
      "/v1/workspaces/paseo-capability-probe/config/model",
      "/v1/workspaces/paseo-capability-probe/config/remove",
      "/v1/workspaces/paseo-capability-probe/permissions/skip",
      "/v1/workspaces/paseo-capability-probe/permissions/grant",
      "/v1/workspaces/paseo-capability-probe/questions/answer",
      "/v1/workspaces/paseo-capability-probe/questions/cancel",
      "/v1/workspaces/paseo-capability-probe/skills",
      "/v1/workspaces/paseo-capability-probe/skills/read",
    ];
    for (const path of requiredPaths) {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "OPTIONS",
        signal: AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS),
      });
      if (response.status === 404) {
        throw new CrushHttpError(
          `Crush server is missing required API route ${path}. Update Crush to a v0.85-era or newer build.`,
          response.status,
          path,
        );
      }
    }
  }

  async shutdown(): Promise<void> {
    await this.request("/v1/control", {
      method: "POST",
      body: JSON.stringify({ command: "shutdown" }),
      headers: { "content-type": "application/json" },
    });
  }

  async createWorkspace(input: { path: string; clientId: string; yolo: boolean; env?: string[] }) {
    return await this.requestJson("/v1/workspaces", CrushWorkspaceSchema, {
      method: "POST",
      body: JSON.stringify({
        path: input.path,
        client_id: input.clientId,
        yolo: input.yolo,
        ...(input.env?.length ? { env: input.env } : {}),
      }),
    });
  }

  async releaseWorkspace(workspaceId: string, clientId: string): Promise<void> {
    await this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}?client_id=${encodeURIComponent(clientId)}`,
      { method: "DELETE" },
    );
  }

  openEvents(
    workspaceId: string,
    clientId: string,
    onEvent: (event: CrushEventEnvelope) => void | Promise<void>,
  ): CrushEventStream {
    const controller = new AbortController();
    const readyTimer = setTimeout(
      () => controller.abort(new Error("Crush event stream did not become ready")),
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    let readyResolve!: () => void;
    let readyReject!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    let readySettled = false;
    const done = this.consumeEvents(
      workspaceId,
      clientId,
      controller.signal,
      async (event) => {
        await onEvent(event);
      },
      () => {
        clearTimeout(readyTimer);
        readySettled = true;
        readyResolve();
      },
    ).catch((error) => {
      clearTimeout(readyTimer);
      if (!readySettled) {
        readySettled = true;
        readyReject(error);
      }
      if (controller.signal.aborted) {
        return;
      }
      throw error;
    });

    return {
      ready,
      done,
      close: async () => {
        controller.abort();
        await done.catch(() => undefined);
      },
    };
  }

  async initializeAgent(workspaceId: string): Promise<void> {
    await this.workspaceRequest(workspaceId, "/agent/init", {
      method: "POST",
      body: JSON.stringify({ interactive: false }),
    });
  }

  async updateAgent(workspaceId: string): Promise<void> {
    await this.workspaceRequest(workspaceId, "/agent/update", { method: "POST" });
  }

  async getAgent(workspaceId: string) {
    return await this.workspaceRequestJson(workspaceId, "/agent", CrushAgentInfoSchema);
  }

  async createSession(workspaceId: string, title: string) {
    return await this.workspaceRequestJson(workspaceId, "/sessions", CrushSessionSchema, {
      method: "POST",
      body: JSON.stringify({ title }),
    });
  }

  async getSession(workspaceId: string, sessionId: string) {
    return await this.workspaceRequestJson(
      workspaceId,
      `/sessions/${encodeURIComponent(sessionId)}`,
      CrushSessionSchema,
    );
  }

  async listSessions(workspaceId: string) {
    return await this.workspaceRequestJson(workspaceId, "/sessions", CrushSessionSchema.array());
  }

  async deleteSession(workspaceId: string, sessionId: string): Promise<void> {
    await this.workspaceRequest(workspaceId, `/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });
  }

  async listMessages(workspaceId: string, sessionId: string) {
    return await this.workspaceRequestJson(
      workspaceId,
      `/sessions/${encodeURIComponent(sessionId)}/messages`,
      CrushMessageSchema.array(),
    );
  }

  async setCurrentSession(workspaceId: string, clientId: string, sessionId: string): Promise<void> {
    await this.workspaceRequest(
      workspaceId,
      `/current-session?client_id=${encodeURIComponent(clientId)}`,
      {
        method: "POST",
        body: JSON.stringify({ session_id: sessionId }),
      },
    );
  }

  async sendPrompt(
    workspaceId: string,
    input: {
      sessionId: string;
      runId: string;
      prompt: string;
      attachments: CrushAttachment[];
    },
  ): Promise<void> {
    await this.workspaceRequest(workspaceId, "/agent", {
      method: "POST",
      body: JSON.stringify({
        session_id: input.sessionId,
        run_id: input.runId,
        prompt: input.prompt,
        ...(input.attachments.length > 0 ? { attachments: input.attachments } : {}),
      }),
    });
  }

  async cancelSession(workspaceId: string, sessionId: string): Promise<void> {
    await this.workspaceRequest(
      workspaceId,
      `/agent/sessions/${encodeURIComponent(sessionId)}/cancel`,
      { method: "POST" },
    );
  }

  async clearQueuedPrompts(workspaceId: string, sessionId: string): Promise<void> {
    await this.workspaceRequest(
      workspaceId,
      `/agent/sessions/${encodeURIComponent(sessionId)}/prompts/clear`,
      { method: "POST" },
    );
  }

  async getPermissionsSkip(workspaceId: string): Promise<boolean> {
    const result = await this.workspaceRequestJson(
      workspaceId,
      "/permissions/skip",
      zBooleanObject,
    );
    return result.skip;
  }

  async setPermissionsSkip(workspaceId: string, skip: boolean): Promise<void> {
    await this.workspaceRequest(workspaceId, "/permissions/skip", {
      method: "POST",
      body: JSON.stringify({ skip }),
    });
  }

  async resolvePermission(
    workspaceId: string,
    permission: Record<string, unknown>,
    action: "allow" | "allow_session" | "deny",
  ): Promise<boolean> {
    const response = await this.workspaceRequestJson(
      workspaceId,
      "/permissions/grant",
      zResolvedObject,
      {
        method: "POST",
        body: JSON.stringify({ permission, action }),
      },
    );
    return response.resolved;
  }

  async answerQuestions(
    workspaceId: string,
    request: CrushQuestionRequest,
    responses: Array<Record<string, unknown>>,
  ): Promise<boolean> {
    const result = await this.workspaceRequestJson(
      workspaceId,
      "/questions/answer",
      zResolvedObject,
      {
        method: "POST",
        body: JSON.stringify({ batch_request_id: request.id, responses }),
      },
    );
    return result.resolved;
  }

  async cancelQuestions(workspaceId: string): Promise<boolean> {
    const result = await this.workspaceRequestJson(
      workspaceId,
      "/questions/cancel",
      zResolvedObject,
      { method: "POST" },
    );
    return result.resolved;
  }

  async listProviders(workspaceId: string) {
    return await this.workspaceRequestJson(workspaceId, "/providers", CrushProviderSchema.array());
  }

  async getWorkspaceConfig(workspaceId: string): Promise<Record<string, unknown>> {
    return await this.workspaceRequestJson(workspaceId, "/config", zRecordObject);
  }

  async setModel(
    workspaceId: string,
    modelType: "large" | "small",
    model: { provider: string; model: string },
  ): Promise<void> {
    await this.workspaceRequest(workspaceId, "/config/model", {
      method: "POST",
      body: JSON.stringify({ scope: 1, model_type: modelType, model }),
    });
  }

  async removeConfig(workspaceId: string, key: string): Promise<void> {
    await this.workspaceRequest(workspaceId, "/config/remove", {
      method: "POST",
      body: JSON.stringify({ scope: 1, key }),
    });
  }

  async getDefaultSmallModel(workspaceId: string, providerId: string) {
    return await this.workspaceRequestJson(
      workspaceId,
      `/agent/default-small-model?provider_id=${encodeURIComponent(providerId)}`,
      CrushSelectedModelSchema,
    );
  }

  async listSkills(workspaceId: string) {
    return await this.workspaceRequestJson(workspaceId, "/skills", CrushSkillInfoSchema.array());
  }

  async readSkill(workspaceId: string, skillId: string) {
    return await this.workspaceRequestJson(
      workspaceId,
      "/skills/read",
      CrushSkillReadResponseSchema,
      { method: "POST", body: JSON.stringify({ skill_id: skillId }) },
    );
  }

  private async consumeEvents(
    workspaceId: string,
    clientId: string,
    signal: AbortSignal,
    onEvent: (event: CrushEventEnvelope) => Promise<void>,
    onReady: () => void,
  ): Promise<void> {
    const path = `/v1/workspaces/${encodeURIComponent(workspaceId)}/events?client_id=${encodeURIComponent(clientId)}`;
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: { accept: "text/event-stream" },
      signal,
    });
    if (!response.ok || !response.body) {
      throw await this.toHttpError(response, path);
    }
    onReady();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const boundary = buffer.search(/\r?\n\r?\n/u);
        if (boundary < 0) break;
        const block = buffer.slice(0, boundary);
        const separatorLength = buffer.startsWith("\r\n\r\n", boundary) ? 4 : 2;
        buffer = buffer.slice(boundary + separatorLength);
        const data = block
          .split(/\r?\n/u)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        try {
          await onEvent(parseCrushEventEnvelope(JSON.parse(data)));
        } catch (error) {
          this.logger.warn({ err: error, data }, "Ignoring malformed Crush SSE event");
        }
      }
    }
    if (!signal.aborted) throw new Error("Crush event stream closed unexpectedly");
  }

  private workspacePath(workspaceId: string, suffix: string): string {
    return `/v1/workspaces/${encodeURIComponent(workspaceId)}${suffix}`;
  }

  private async workspaceRequest(
    workspaceId: string,
    suffix: string,
    init: RequestInit = {},
  ): Promise<Response> {
    return await this.request(this.workspacePath(workspaceId, suffix), init);
  }

  private async workspaceRequestJson<T>(
    workspaceId: string,
    suffix: string,
    schema: z.ZodType<T>,
    init: RequestInit = {},
  ): Promise<T> {
    return await this.requestJson(this.workspacePath(workspaceId, suffix), schema, init);
  }

  private async requestJson<T>(
    path: string,
    schema: z.ZodType<T>,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await this.request(path, init);
    const value = await response.json();
    return schema.parse(value);
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
        signal: init.signal ?? controller.signal,
      });
      if (!response.ok) {
        throw await this.toHttpError(response, path);
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  private async toHttpError(response: Response, path: string): Promise<CrushHttpError> {
    const raw = await response.text().catch(() => "");
    let detail = raw.trim();
    try {
      const parsed = JSON.parse(raw) as { message?: unknown };
      if (typeof parsed.message === "string") detail = parsed.message;
    } catch {
      // Keep the plain response body.
    }
    const compatibilityHint =
      response.status === 404
        ? " The installed Crush server API is incompatible; update Crush to a v0.85-era or newer build."
        : "";
    return new CrushHttpError(
      `Crush request ${path} failed (${response.status})${detail ? `: ${detail}` : ""}.${compatibilityHint}`,
      response.status,
      path,
    );
  }
}

const zBooleanObject = z.object({ skip: z.boolean() }).passthrough();
const zResolvedObject = z.object({ resolved: z.boolean() }).passthrough();
const zRecordObject = z.record(z.string(), z.unknown());
