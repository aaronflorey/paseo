import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Logger } from "pino";

import type { ManagedProcessRegistry } from "../../managed-processes/managed-processes.js";
import {
  type AgentCapabilityFlags,
  type AgentClient,
  type AgentLaunchContext,
  type AgentMode,
  type AgentModelDefinition,
  type AgentPermissionRequest,
  type AgentPermissionResponse,
  type AgentPersistenceHandle,
  type AgentPromptInput,
  type AgentRunOptions,
  type AgentRunResult,
  type AgentRuntimeInfo,
  type AgentSession,
  type AgentSessionConfig,
  type AgentSlashCommand,
  type AgentStreamEvent,
  type FetchCatalogOptions,
  type ImportableProviderSession,
  type ImportProviderSessionContext,
  type ImportProviderSessionInput,
  type ListImportableSessionsOptions,
  type ProviderCatalog,
} from "../agent-sdk-types.js";
import { importSessionFromPersistence } from "../provider-session-import.js";
import { renderPromptAttachmentAsText } from "../prompt-attachments.js";
import {
  checkProviderLaunchAvailable,
  resolveProviderLaunch,
  type ProviderRuntimeSettings,
} from "../provider-launch-config.js";
import { appendOrReplaceGrowingAssistantMessage, runProviderTurn } from "./provider-runner.js";
import {
  buildBinaryDiagnosticRows,
  buildCommandResolutionDiagnosticRows,
  formatProviderDiagnostic,
  formatProviderDiagnosticError,
} from "./diagnostic-utils.js";
import {
  buildCrushQuestionResponses,
  createCrushTranslationState,
  translateCrushEvent,
  translateCrushHistoryMessage,
  type CrushTranslationState,
} from "./crush/event-translator.js";
import {
  CrushHttpClient,
  CrushHttpError,
  type CrushAttachment,
  type CrushEventStream,
} from "./crush/http-client.js";
import type {
  CrushEventEnvelope,
  CrushPermissionRequest,
  CrushQuestionRequest,
  CrushWorkspace,
} from "./crush/protocol.js";
import {
  CrushServerManager,
  type CrushServerAcquisition,
  type CrushServerManagerLike,
} from "./crush/server-manager.js";

const PROVIDER = "crush";
const CRUSH_BINARY = "crush";
const GLOBAL_CATALOG_DIR = path.join(tmpdir(), `paseo-crush-catalog-${process.pid}`);
const workspaceInitialization = new Map<string, Promise<void>>();

export const CRUSH_MODES: AgentMode[] = [
  {
    id: "ask",
    label: "Always Ask",
    description: "Ask before permission-gated write and execution tools",
    icon: "ShieldCheck",
    colorTier: "safe",
  },
  {
    id: "full",
    label: "Full Access",
    description: "Skip Crush tool permission prompts",
    icon: "ShieldOff",
    colorTier: "dangerous",
  },
];

export const CRUSH_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsSessionListing: true,
  supportsDynamicModes: true,
  supportsMcpServers: false,
  supportsNativePaseoTools: false,
  supportsSessionRoutedPaseoTools: false,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
  supportsRewindConversation: false,
  supportsRewindFiles: false,
  supportsRewindBoth: false,
};

interface CrushAgentClientDeps {
  serverManager?: CrushServerManagerLike;
  managedProcesses?: ManagedProcessRegistry;
  createHttpClient?: (url: string, logger: Logger) => CrushHttpClient;
}

interface OpenCrushWorkspace {
  acquisition: CrushServerAcquisition;
  client: CrushHttpClient;
  workspace: CrushWorkspace;
  clientId: string;
  events: CrushEventStream;
  queuedEvents: CrushEventEnvelope[];
  setEventConsumer(
    consumer: (event: CrushEventEnvelope) => void | Promise<void>,
    onDisconnect: (error: unknown) => void | Promise<void>,
  ): Promise<void>;
  close(): Promise<void>;
}

export class CrushAgentClient implements AgentClient {
  readonly provider = PROVIDER;
  readonly capabilities = CRUSH_CAPABILITIES;

  private readonly logger: Logger;
  private readonly runtimeSettings?: ProviderRuntimeSettings;
  private readonly serverManager: CrushServerManagerLike;
  private readonly createHttpClient: (url: string, logger: Logger) => CrushHttpClient;

  constructor(
    logger: Logger,
    runtimeSettings?: ProviderRuntimeSettings,
    deps: CrushAgentClientDeps = {},
  ) {
    this.logger = logger.child({ module: "agent", provider: PROVIDER });
    this.runtimeSettings = runtimeSettings;
    this.serverManager =
      deps.serverManager ??
      CrushServerManager.getInstance(this.logger, runtimeSettings, {
        managedProcesses: deps.managedProcesses,
      });
    this.createHttpClient =
      deps.createHttpClient ?? ((url, clientLogger) => new CrushHttpClient(url, clientLogger));
  }

  async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
    options?: { persistSession?: boolean },
  ): Promise<AgentSession> {
    const normalized = this.assertConfig(config);
    const connection = await this.openWorkspace(normalized, launchContext);
    let nativeSessionId: string | null = null;
    try {
      await this.initializeWorkspace(connection, normalized);
      const nativeSession = await connection.client.createSession(
        connection.workspace.id,
        normalized.title?.trim() || "New Session",
      );
      nativeSessionId = nativeSession.id;
      await connection.client.setCurrentSession(
        connection.workspace.id,
        connection.clientId,
        nativeSession.id,
      );
      return await this.createAgentSession({
        config: normalized,
        connection,
        sessionId: nativeSession.id,
        persistSession: options?.persistSession !== false,
      });
    } catch (error) {
      if (nativeSessionId && options?.persistSession === false) {
        await connection.client
          .deleteSession(connection.workspace.id, nativeSessionId)
          .catch(() => undefined);
      }
      await connection.close();
      throw decorateCrushWorkspaceError(error);
    }
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const metadata = handle.metadata ?? {};
    const cwd = overrides?.cwd ?? (typeof metadata.cwd === "string" ? metadata.cwd : undefined);
    if (!cwd) throw new Error("Crush resume requires the original working directory");
    const config = this.assertConfig({
      ...(metadata as Partial<AgentSessionConfig>),
      ...overrides,
      provider: PROVIDER,
      cwd,
    });
    const sessionId = handle.nativeHandle ?? handle.sessionId;
    const connection = await this.openWorkspace(config, launchContext);
    try {
      await this.initializeWorkspace(connection, config);
      await connection.client.getSession(connection.workspace.id, sessionId);
      await connection.client.setCurrentSession(
        connection.workspace.id,
        connection.clientId,
        sessionId,
      );
      return await this.createAgentSession({
        config,
        connection,
        sessionId,
        persistSession: true,
      });
    } catch (error) {
      await connection.close();
      throw decorateCrushWorkspaceError(error);
    }
  }

  async fetchCatalog(options: FetchCatalogOptions): Promise<ProviderCatalog> {
    const cwd = options.scope === "workspace" ? options.cwd : GLOBAL_CATALOG_DIR;
    if (options.scope === "global") await mkdir(cwd, { recursive: true });
    return await this.withTemporaryWorkspace(cwd, async ({ client, workspace }) => {
      const providers = await client.listProviders(workspace.id);
      let activeModel: string | null = null;
      try {
        const config = await client.getWorkspaceConfig(workspace.id);
        const large = asRecord(asRecord(config.models).large);
        const provider = optionalString(large.provider);
        const model = optionalString(large.model);
        activeModel = provider && model ? `${provider}/${model}` : null;
      } catch (error) {
        this.logger.debug({ err: error }, "Could not resolve active Crush catalog model");
      }
      const models: AgentModelDefinition[] = providers.flatMap((provider) =>
        provider.models.map((model) => ({
          provider: PROVIDER,
          id: `${provider.id}/${model.id}`,
          label: model.name || model.id,
          description: provider.name,
          ...(activeModel === `${provider.id}/${model.id}` ? { isDefault: true } : {}),
          ...(model.context_window ? { contextWindowMaxTokens: model.context_window } : {}),
          metadata: {
            inferenceProvider: provider.id,
            modelId: model.id,
            supportsAttachments: model.supports_attachments === true,
            canReason: model.can_reason === true,
          },
        })),
      );
      return { models, modes: CRUSH_MODES };
    });
  }

  async listCommands(config: AgentSessionConfig): Promise<AgentSlashCommand[]> {
    const normalized = this.assertConfig(config);
    return await this.withTemporaryWorkspace(normalized.cwd, async ({ client, workspace }) =>
      (await client.listSkills(workspace.id))
        .filter((skill) => skill.user_invocable)
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          argumentHint: "[instructions]",
          kind: "skill" as const,
        })),
    );
  }

  async listImportableSessions(
    options?: ListImportableSessionsOptions,
  ): Promise<ImportableProviderSession[]> {
    if (!options?.cwd) return [];
    return await this.withTemporaryWorkspace(options.cwd, async ({ client, workspace }) => {
      const sessions = await client.listSessions(workspace.id);
      return sessions
        .filter((session) => !session.parent_session_id)
        .sort((a, b) => b.updated_at - a.updated_at)
        .slice(0, options.limit ?? 20)
        .map((session) => ({
          providerHandleId: session.id,
          cwd: options.cwd!,
          title: session.title || null,
          firstPromptPreview: null,
          lastPromptPreview: null,
          lastActivityAt: new Date(session.updated_at * 1000),
        }));
    });
  }

  async importSession(input: ImportProviderSessionInput, context: ImportProviderSessionContext) {
    return await importSessionFromPersistence({
      provider: PROVIDER,
      request: input,
      context,
      resumeSession: this.resumeSession.bind(this),
      config: { provider: PROVIDER, cwd: input.cwd },
    });
  }

  async isAvailable(): Promise<boolean> {
    try {
      const launch = await resolveProviderLaunch({
        commandConfig: this.runtimeSettings?.command,
        defaultBinary: CRUSH_BINARY,
      });
      return (await checkProviderLaunchAvailable(launch)).available;
    } catch {
      return false;
    }
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    try {
      const launch = await resolveProviderLaunch({
        commandConfig: this.runtimeSettings?.command,
        defaultBinary: CRUSH_BINARY,
      });
      const availability = await checkProviderLaunchAvailable(launch);
      return {
        diagnostic: formatProviderDiagnostic("Crush", [
          ...(await buildCommandResolutionDiagnosticRows(launch, {
            knownBinaryNames: [CRUSH_BINARY],
          })),
          ...(await buildBinaryDiagnosticRows(launch, availability)),
          { label: "Transport", value: "Paseo-managed loopback HTTP/SSE server" },
        ]),
      };
    } catch (error) {
      return { diagnostic: formatProviderDiagnosticError("Crush", error) };
    }
  }

  async shutdown(): Promise<void> {
    await this.serverManager.shutdown();
  }

  private async createAgentSession(input: {
    config: AgentSessionConfig;
    connection: OpenCrushWorkspace;
    sessionId: string;
    persistSession: boolean;
  }): Promise<CrushAgentSession> {
    const session = new CrushAgentSession({
      ...input,
      logger: this.logger,
    });
    await input.connection.setEventConsumer(
      (event) => session.consumeEvent(event),
      (error) => session.consumeTransportError(error),
    );
    return session;
  }

  private async initializeWorkspace(
    connection: OpenCrushWorkspace,
    config: AgentSessionConfig,
  ): Promise<void> {
    const initializationKey = `${connection.client.baseUrl}:${connection.workspace.id}`;
    const previousInitialization = workspaceInitialization.get(initializationKey);
    const initialization = (async () => {
      await previousInitialization;
      const agent = await connection.client.getAgent(connection.workspace.id);
      if (config.model) {
        await writeCrushModelConfig(connection.client, connection.workspace.id, config.model);
      }
      if (!agent.is_ready) {
        await connection.client.initializeAgent(connection.workspace.id);
      } else if (config.model) {
        await connection.client.updateAgent(connection.workspace.id);
      }
    })();
    workspaceInitialization.set(initializationKey, initialization);
    try {
      await initialization;
    } finally {
      if (workspaceInitialization.get(initializationKey) === initialization) {
        workspaceInitialization.delete(initializationKey);
      }
    }
    await connection.client.setPermissionsSkip(connection.workspace.id, config.modeId === "full");
    broadcastCrushWorkspaceMode(
      connection.workspace.path,
      config.modeId === "full" ? "full" : "ask",
    );
  }

  private async openWorkspace(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
  ): Promise<OpenCrushWorkspace> {
    let firstError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const acquisition =
        attempt === 0
          ? await this.serverManager.acquireCurrent()
          : await this.serverManager.acquireNew();
      const client = this.createHttpClient(acquisition.server.url, this.logger);
      const clientId = randomUUID();
      let workspace: CrushWorkspace | null = null;
      let events: CrushEventStream | null = null;
      try {
        workspace = await client.createWorkspace({
          path: config.cwd,
          clientId,
          yolo: config.modeId === "full",
          env: toCrushEnv(launchContext?.env),
        });
        const queuedEvents: CrushEventEnvelope[] = [];
        let consumer: ((event: CrushEventEnvelope) => void | Promise<void>) | null = null;
        let disconnectConsumer: ((error: unknown) => void | Promise<void>) | null = null;
        let disconnectError: unknown;
        let disconnectDelivered = false;
        events = client.openEvents(workspace.id, clientId, async (event) => {
          if (consumer) await consumer(event);
          else queuedEvents.push(event);
        });
        await events.ready;
        void events.done.catch(async (error) => {
          disconnectError = error;
          if (disconnectConsumer && !disconnectDelivered) {
            disconnectDelivered = true;
            await disconnectConsumer(error);
          }
        });
        const stableWorkspace = workspace;
        const stableEvents = events;
        return {
          acquisition,
          client,
          workspace: stableWorkspace,
          clientId,
          events: stableEvents,
          queuedEvents,
          setEventConsumer: async (nextConsumer, nextDisconnectConsumer) => {
            consumer = nextConsumer;
            disconnectConsumer = nextDisconnectConsumer;
            const pending = queuedEvents.splice(0);
            for (const event of pending) await nextConsumer(event);
            if (disconnectError && !disconnectDelivered) {
              disconnectDelivered = true;
              await nextDisconnectConsumer(disconnectError);
            }
          },
          close: async () => {
            await client.releaseWorkspace(stableWorkspace.id, clientId).catch(() => undefined);
            await stableEvents.close();
            await acquisition.release();
          },
        };
      } catch (error) {
        firstError ??= error;
        if (workspace) await client.releaseWorkspace(workspace.id, clientId).catch(() => undefined);
        await events?.close();
        await acquisition.release();
        if (attempt === 0 && isRetryableConnectionError(error)) continue;
        throw decorateCrushWorkspaceError(error);
      }
    }
    throw decorateCrushWorkspaceError(firstError);
  }

  private async withTemporaryWorkspace<T>(
    cwd: string,
    run: (connection: OpenCrushWorkspace) => Promise<T>,
  ): Promise<T> {
    const connection = await this.openWorkspace({ provider: PROVIDER, cwd, modeId: "ask" });
    try {
      return await run(connection);
    } finally {
      await connection.close();
    }
  }

  private assertConfig(config: AgentSessionConfig): AgentSessionConfig {
    if (config.provider !== PROVIDER) {
      throw new Error(`Crush client cannot create provider ${config.provider}`);
    }
    if (!config.cwd?.trim()) throw new Error("Crush requires a working directory");
    if (config.modeId && config.modeId !== "ask" && config.modeId !== "full") {
      throw new Error(`Unsupported Crush mode: ${config.modeId}`);
    }
    return { ...config, modeId: config.modeId ?? "ask" };
  }
}

interface CrushAgentSessionOptions {
  config: AgentSessionConfig;
  connection: OpenCrushWorkspace;
  sessionId: string;
  persistSession: boolean;
  logger: Logger;
}

class CrushAgentSession implements AgentSession {
  readonly provider = PROVIDER;
  readonly capabilities = CRUSH_CAPABILITIES;
  readonly id: string;

  private readonly config: AgentSessionConfig;
  private readonly connection: OpenCrushWorkspace;
  private readonly persistSession: boolean;
  private readonly logger: Logger;
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private readonly state: CrushTranslationState;
  private readonly pendingPermissions = new Map<string, AgentPermissionRequest>();
  private readonly nativePermissions = new Map<string, CrushPermissionRequest>();
  private readonly nativeQuestions = new Map<string, CrushQuestionRequest>();
  private closed = false;
  private connectionError: Error | null = null;
  private ignoredSystemPromptNoticePending: boolean;

  constructor(options: CrushAgentSessionOptions) {
    this.config = options.config;
    this.connection = options.connection;
    this.persistSession = options.persistSession;
    this.logger = options.logger;
    this.id = options.sessionId;
    this.state = createCrushTranslationState(this.id);
    this.ignoredSystemPromptNoticePending = true;
    registerCrushWorkspaceSession(options.connection.workspace.path, this);
  }

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    return await runProviderTurn({
      prompt,
      runOptions: options,
      startTurn: (value, runOptions) => this.startTurn(value, runOptions),
      subscribe: (callback) => this.subscribe(callback),
      getSessionId: () => this.id,
      reduceFinalText: appendOrReplaceGrowingAssistantMessage,
    });
  }

  async startTurn(
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    this.assertOpen();
    if (this.state.activeRunId) throw new Error("A Crush turn is already active");
    const turnId = randomUUID();
    const built = await buildCrushPrompt(prompt, this.logger);
    const skill = await this.resolveSkillInvocation(prompt);
    if (skill) {
      built.attachments.push({
        file_path: skill.name,
        file_name: skill.name,
        mime_type: "text/markdown",
        content: skill.content,
      });
      built.prompt = skill.instructions || "Follow the attached skill.";
    }
    this.state.activeRunId = turnId;
    this.state.activeTurnId = turnId;
    this.state.activeTurnStarted = true;
    this.state.suppressUserText = built.prompt;
    this.emit({ type: "turn_started", provider: PROVIDER, turnId });
    this.emit({
      type: "timeline",
      provider: PROVIDER,
      turnId,
      item: {
        type: "user_message",
        text: buildUserTimelineText(prompt),
        ...(options?.messageId ? { messageId: options.messageId } : {}),
      },
    });
    if (this.ignoredSystemPromptNoticePending) {
      this.ignoredSystemPromptNoticePending = false;
      this.emit({
        type: "timeline",
        provider: PROVIDER,
        turnId,
        item: {
          type: "tool_call",
          callId: "crush-system-prompt-notice",
          name: "Crush instructions",
          status: "completed",
          error: null,
          detail: {
            type: "plain_text",
            label: "Paseo system prompt not applied",
            text: "Crush uses its native CRUSH.md/AGENTS.md and provider prompt configuration.",
            icon: "brain",
          },
        },
      });
    }
    try {
      await this.connection.client.sendPrompt(this.connection.workspace.id, {
        sessionId: this.id,
        runId: turnId,
        prompt: built.prompt,
        attachments: built.attachments,
      });
      return { turnId };
    } catch (error) {
      this.state.activeRunId = null;
      this.state.activeTurnId = null;
      this.state.activeTurnStarted = false;
      this.state.suppressUserText = null;
      throw error;
    }
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    callback({ type: "thread_started", sessionId: this.id, provider: PROVIDER });
    return () => this.subscribers.delete(callback);
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    const messages = await this.connection.client.listMessages(
      this.connection.workspace.id,
      this.id,
    );
    const historyState = createCrushTranslationState(this.id);
    for (const message of messages.sort((a, b) => a.created_at - b.created_at)) {
      for (const event of translateCrushHistoryMessage(message, historyState)) yield event;
    }
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    const agent = await this.connection.client.getAgent(this.connection.workspace.id);
    return {
      provider: PROVIDER,
      sessionId: this.id,
      model:
        agent.model_cfg.provider && agent.model_cfg.model
          ? `${agent.model_cfg.provider}/${agent.model_cfg.model}`
          : null,
      modeId: (await this.getCurrentMode()) ?? "ask",
      extra: {
        workspaceId: this.connection.workspace.id,
        crushVersion: this.connection.workspace.version,
      },
    };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return CRUSH_MODES;
  }

  async getCurrentMode(): Promise<string | null> {
    return (await this.connection.client.getPermissionsSkip(this.connection.workspace.id))
      ? "full"
      : "ask";
  }

  async setMode(modeId: string) {
    if (modeId !== "ask" && modeId !== "full") throw new Error(`Unsupported Crush mode: ${modeId}`);
    await this.connection.client.setPermissionsSkip(
      this.connection.workspace.id,
      modeId === "full",
    );
    this.config.modeId = modeId;
    broadcastCrushWorkspaceMode(this.connection.workspace.path, modeId);
    return {
      type: "warning" as const,
      message: "Crush permission mode is shared by all sessions in this directory",
    };
  }

  async setModel(modelId: string | null): Promise<void> {
    await setCrushModel(this.connection.client, this.connection.workspace.id, modelId);
    this.config.model = modelId ?? undefined;
    await this.emitModelChanged();
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return [...this.pendingPermissions.values()];
  }

  async respondToPermission(requestId: string, response: AgentPermissionResponse): Promise<void> {
    const nativePermission = this.nativePermissions.get(requestId);
    if (nativePermission) {
      const action = resolveCrushPermissionAction(response);
      await this.connection.client.resolvePermission(
        this.connection.workspace.id,
        nativePermission,
        action,
      );
    } else {
      const question = this.nativeQuestions.get(requestId);
      if (!question) throw new Error(`Unknown Crush permission request: ${requestId}`);
      if (response.behavior === "deny") {
        await this.connection.client.cancelQuestions(this.connection.workspace.id);
      } else {
        await this.connection.client.answerQuestions(
          this.connection.workspace.id,
          question,
          buildCrushQuestionResponses(question, response.updatedInput),
        );
      }
    }
    this.pendingPermissions.delete(requestId);
    this.nativePermissions.delete(requestId);
    this.nativeQuestions.delete(requestId);
  }

  describePersistence(): AgentPersistenceHandle {
    return {
      provider: PROVIDER,
      sessionId: this.id,
      nativeHandle: this.id,
      metadata: {
        provider: PROVIDER,
        cwd: this.config.cwd,
        ...(this.config.modeId ? { modeId: this.config.modeId } : {}),
        ...(this.config.model ? { model: this.config.model } : {}),
      },
    };
  }

  async interrupt(): Promise<void> {
    await Promise.allSettled([
      this.connection.client.cancelSession(this.connection.workspace.id, this.id),
      this.connection.client.clearQueuedPrompts(this.connection.workspace.id, this.id),
    ]);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    unregisterCrushWorkspaceSession(this.connection.workspace.path, this);
    if (this.state.activeRunId) await this.interrupt();
    if (!this.persistSession) {
      await this.connection.client
        .deleteSession(this.connection.workspace.id, this.id)
        .catch((error) =>
          this.logger.debug({ err: error }, "Failed to delete ephemeral Crush session"),
        );
    }
    await this.connection.client
      .setCurrentSession(this.connection.workspace.id, this.connection.clientId, "")
      .catch(() => undefined);
    await this.connection.close();
    this.subscribers.clear();
  }

  async listCommands(): Promise<AgentSlashCommand[]> {
    return (await this.connection.client.listSkills(this.connection.workspace.id))
      .filter((skill) => skill.user_invocable)
      .map((skill) => ({
        name: skill.name,
        description: skill.description,
        argumentHint: "[instructions]",
        kind: "skill" as const,
      }));
  }

  async consumeEvent(envelope: CrushEventEnvelope): Promise<void> {
    if (!envelope.event) return;
    if (envelope.type === "permission_request") {
      const native = envelope.event.payload as CrushPermissionRequest;
      if (native.session_id === this.id) this.nativePermissions.set(native.id, native);
    } else if (envelope.type === "question_batch_request") {
      const native = envelope.event.payload as CrushQuestionRequest;
      if (native.session_id === this.id) this.nativeQuestions.set(native.id, native);
    } else if (envelope.type === "permission_notification") {
      const notification = envelope.event.payload as {
        tool_call_id: string;
        granted: boolean;
        denied: boolean;
      };
      const match = [...this.nativePermissions.entries()].find(
        ([, request]) => request.tool_call_id === notification.tool_call_id,
      );
      if (match) {
        this.emit({
          type: "permission_resolved",
          provider: PROVIDER,
          ...(this.state.activeTurnId ? { turnId: this.state.activeTurnId } : {}),
          requestId: match[0],
          resolution: notification.denied ? { behavior: "deny" } : { behavior: "allow" },
        });
        this.pendingPermissions.delete(match[0]);
        this.nativePermissions.delete(match[0]);
      }
      return;
    } else if (envelope.type === "question_batch_notification") {
      const notification = envelope.event.payload as { batch_id: string };
      if (this.nativeQuestions.has(notification.batch_id)) {
        this.emit({
          type: "permission_resolved",
          provider: PROVIDER,
          ...(this.state.activeTurnId ? { turnId: this.state.activeTurnId } : {}),
          requestId: notification.batch_id,
          resolution: { behavior: "allow" },
        });
        this.pendingPermissions.delete(notification.batch_id);
        this.nativeQuestions.delete(notification.batch_id);
      }
      return;
    } else if (envelope.type === "config_changed") {
      await this.emitModelChanged();
    }
    for (const event of translateCrushEvent(envelope, this.state)) {
      if (event.type === "permission_requested") {
        this.pendingPermissions.set(event.request.id, event.request);
      }
      this.emit(event);
    }
  }

  emitSharedMode(modeId: string): void {
    this.config.modeId = modeId;
    this.emit({
      type: "mode_changed",
      provider: PROVIDER,
      currentModeId: modeId,
      availableModes: CRUSH_MODES,
    });
  }

  consumeTransportError(error: unknown): void {
    if (this.closed || this.connectionError) return;
    this.connectionError =
      error instanceof Error ? error : new Error(`Crush event stream failed: ${String(error)}`);
    if (!this.state.activeTurnId) return;
    this.emit({
      type: "turn_failed",
      provider: PROVIDER,
      turnId: this.state.activeTurnId,
      error: this.connectionError.message,
    });
    this.state.activeRunId = null;
    this.state.activeTurnId = null;
    this.state.activeTurnStarted = false;
    this.state.suppressUserText = null;
  }

  private async emitModelChanged(): Promise<void> {
    try {
      this.emit({
        type: "model_changed",
        provider: PROVIDER,
        runtimeInfo: await this.getRuntimeInfo(),
      });
    } catch (error) {
      this.logger.debug({ err: error }, "Failed to refresh Crush model after config change");
    }
  }

  private async resolveSkillInvocation(
    prompt: AgentPromptInput,
  ): Promise<{ name: string; content: string; instructions: string } | null> {
    if (typeof prompt !== "string") return null;
    const match = prompt.trim().match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/u);
    if (!match) return null;
    const name = match[1];
    const skill = (await this.connection.client.listSkills(this.connection.workspace.id)).find(
      (entry) => entry.user_invocable && entry.name === name,
    );
    if (!skill) return null;
    const read = await this.connection.client.readSkill(this.connection.workspace.id, skill.id);
    return {
      name: `${read.result.name || name}.md`,
      content: read.content,
      instructions: match[2]?.trim() ?? "",
    };
  }

  private emit(event: AgentStreamEvent): void {
    if (this.closed) return;
    for (const subscriber of this.subscribers) subscriber(event);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Crush session is closed");
    if (this.connectionError) {
      throw new Error(
        `The Crush server connection was lost. Resume this session to reconnect. ${this.connectionError.message}`,
        { cause: this.connectionError },
      );
    }
  }
}

const crushWorkspaceSessions = new Map<string, Set<CrushAgentSession>>();

function registerCrushWorkspaceSession(cwd: string, session: CrushAgentSession): void {
  const sessions = crushWorkspaceSessions.get(cwd) ?? new Set<CrushAgentSession>();
  sessions.add(session);
  crushWorkspaceSessions.set(cwd, sessions);
}

function unregisterCrushWorkspaceSession(cwd: string, session: CrushAgentSession): void {
  const sessions = crushWorkspaceSessions.get(cwd);
  sessions?.delete(session);
  if (sessions?.size === 0) crushWorkspaceSessions.delete(cwd);
}

function broadcastCrushWorkspaceMode(cwd: string, modeId: string): void {
  for (const session of crushWorkspaceSessions.get(cwd) ?? []) session.emitSharedMode(modeId);
}

function resolveCrushPermissionAction(
  response: AgentPermissionResponse,
): "allow" | "allow_session" | "deny" {
  if (response.behavior === "deny") return "deny";
  if (response.selectedActionId === "allow_session") return "allow_session";
  return "allow";
}

async function setCrushModel(
  client: CrushHttpClient,
  workspaceId: string,
  modelId: string | null,
): Promise<void> {
  await writeCrushModelConfig(client, workspaceId, modelId);
  await client.updateAgent(workspaceId);
}

async function writeCrushModelConfig(
  client: CrushHttpClient,
  workspaceId: string,
  modelId: string | null,
): Promise<void> {
  if (!modelId) {
    await client.removeConfig(workspaceId, "models.large");
    await client.removeConfig(workspaceId, "models.small");
    return;
  }
  const parsed = parseModelId(modelId);
  await client.setModel(workspaceId, "large", parsed);
  const small = await client.getDefaultSmallModel(workspaceId, parsed.provider);
  await client.setModel(workspaceId, "small", small);
}

function parseModelId(modelId: string): { provider: string; model: string } {
  const slash = modelId.indexOf("/");
  if (slash <= 0 || slash === modelId.length - 1) {
    throw new Error(`Crush model must use provider/model syntax: ${modelId}`);
  }
  return { provider: modelId.slice(0, slash), model: modelId.slice(slash + 1) };
}

async function buildCrushPrompt(
  prompt: AgentPromptInput,
  logger: Logger,
): Promise<{ prompt: string; attachments: CrushAttachment[] }> {
  if (typeof prompt === "string") return { prompt, attachments: [] };
  const text: string[] = [];
  const attachments: CrushAttachment[] = [];
  let ordinal = 0;
  for (const block of prompt) {
    if (block.type === "text") {
      text.push(block.text);
    } else if (block.type === "image") {
      ordinal += 1;
      const normalized = normalizeBase64(block.data);
      attachments.push({
        file_path: `paseo-image-${ordinal}`,
        file_name: `paseo-image-${ordinal}.${extensionForMime(block.mimeType)}`,
        mime_type: normalized.mimeType ?? block.mimeType,
        content: normalized.content,
      });
    } else if (block.type === "uploaded_file") {
      try {
        const content = await readFile(block.path);
        attachments.push({
          file_path: block.path,
          file_name: block.fileName,
          mime_type: block.mimeType,
          content: content.toString("base64"),
        });
      } catch (error) {
        logger.warn({ err: error, path: block.path }, "Failed to read Crush uploaded file");
        text.push(renderPromptAttachmentAsText(block));
      }
    } else {
      text.push(renderPromptAttachmentAsText(block));
    }
  }
  return {
    prompt: text.filter((part) => part.trim()).join("\n\n") || "Review the attached content.",
    attachments,
  };
}

function buildUserTimelineText(prompt: AgentPromptInput): string {
  if (typeof prompt === "string") return prompt;
  return prompt
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "image") return "[Image]";
      return renderPromptAttachmentAsText(block);
    })
    .filter((value) => value.trim())
    .join("\n\n");
}

function normalizeBase64(value: string): { content: string; mimeType?: string } {
  const match = value.match(/^data:([^;,]+);base64,(.+)$/su);
  return match ? { mimeType: match[1], content: match[2] } : { content: value };
}

function extensionForMime(mimeType: string): string {
  return mimeType.split("/")[1]?.replace("jpeg", "jpg") || "bin";
}

function toCrushEnv(env: Record<string, string> | undefined): string[] | undefined {
  if (!env) return undefined;
  return Object.entries(env)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`);
}

function decorateCrushWorkspaceError(error: unknown): Error {
  if (
    error instanceof Error &&
    /lock|already.*use|resource temporarily unavailable/iu.test(error.message)
  ) {
    return new Error(
      `${error.message}\nCrush's workspace data directory is already in use. Close the other Crush instance for this directory and retry.`,
      { cause: error },
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

function isRetryableConnectionError(error: unknown): boolean {
  if (error instanceof CrushHttpError) return error.status >= 500;
  const message = error instanceof Error ? error.message : String(error);
  return /ECONNREFUSED|ECONNRESET|fetch failed|socket|aborted/iu.test(message);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
