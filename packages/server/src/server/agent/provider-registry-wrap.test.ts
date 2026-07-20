import { describe, expect, test } from "vitest";

import type {
  AgentClient,
  AgentCapabilityFlags,
  AgentCreateSessionOptions,
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentSessionConfig,
  AgentSession,
  AgentStreamEvent,
  AgentRuntimeInfo,
  FetchCatalogOptions,
  ImportedProviderSession,
  ImportProviderSessionContext,
  ImportProviderSessionInput,
} from "./agent-sdk-types.js";
import { __providerRegistryInternals, wrapSessionProvider } from "./provider-registry.js";

const AGENT_CLIENT_MEMBER_NAMES = [
  "provider",
  "capabilities",
  "createSession",
  "resumeSession",
  "fetchCatalog",
  "resolveDefaultModeId",
  "resolveCreateConfig",
  "isCreateConfigUnattended",
  "listCommands",
  "listFeatures",
  "listImportableSessions",
  "importSession",
  "isAvailable",
  "getDiagnostic",
  "archiveNativeSession",
  "unarchiveNativeSession",
  "shutdown",
] as const satisfies readonly (keyof AgentClient)[];

type MissingAgentClientMember = Exclude<
  keyof AgentClient,
  (typeof AGENT_CLIENT_MEMBER_NAMES)[number]
>;

const _allAgentClientMembersAreCovered: MissingAgentClientMember extends never ? true : never =
  true;

type OptionalAgentSessionMethodName = {
  [K in keyof AgentSession]-?: undefined extends AgentSession[K]
    ? NonNullable<AgentSession[K]> extends (...args: never[]) => unknown
      ? K
      : never
    : never;
}[keyof AgentSession];

const OPTIONAL_AGENT_SESSION_METHOD_NAMES = [
  "listCommands",
  "setModel",
  "setThinkingOption",
  "setFeature",
  "revertConversation",
  "revertFiles",
  "revertBoth",
  "tryHandleOutOfBand",
] as const satisfies readonly OptionalAgentSessionMethodName[];

type MissingOptionalAgentSessionMethod = Exclude<
  OptionalAgentSessionMethodName,
  (typeof OPTIONAL_AGENT_SESSION_METHOD_NAMES)[number]
>;

const _allOptionalAgentSessionMethodsAreCovered: MissingOptionalAgentSessionMethod extends never
  ? true
  : never = true;

const CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
  supportsRewindConversation: true,
  supportsRewindFiles: true,
  supportsRewindBoth: true,
};

const RUNTIME_INFO: AgentRuntimeInfo = {
  provider: "claude",
  sessionId: "session-1",
};

class FakeSession implements AgentSession {
  readonly provider = "claude";
  readonly id = "session-1";
  readonly capabilities = CAPABILITIES;
  readonly features = [];
  readonly recordedCalls: string[] = [];

  async run() {
    this.recordedCalls.push("run");
    return { timeline: [] };
  }

  async startTurn() {
    this.recordedCalls.push("startTurn");
    return { turnId: "turn-1" };
  }

  subscribe(_callback: (event: AgentStreamEvent) => void) {
    this.recordedCalls.push("subscribe");
    return () => {};
  }

  async *streamHistory() {
    this.recordedCalls.push("streamHistory");
    yield* emptyHistory();
  }

  async getRuntimeInfo() {
    this.recordedCalls.push("getRuntimeInfo");
    return RUNTIME_INFO;
  }

  async getAvailableModes() {
    this.recordedCalls.push("getAvailableModes");
    return [];
  }

  async getCurrentMode() {
    this.recordedCalls.push("getCurrentMode");
    return null;
  }

  async setMode(_modeId: string) {
    this.recordedCalls.push("setMode");
  }

  getPendingPermissions() {
    this.recordedCalls.push("getPendingPermissions");
    return [];
  }

  async respondToPermission() {
    this.recordedCalls.push("respondToPermission");
  }

  describePersistence() {
    this.recordedCalls.push("describePersistence");
    return null;
  }

  async interrupt() {
    this.recordedCalls.push("interrupt");
  }

  async close() {
    this.recordedCalls.push("close");
  }

  async listCommands() {
    this.recordedCalls.push("listCommands");
    return [];
  }

  async setModel() {
    this.recordedCalls.push("setModel");
  }

  async setThinkingOption() {
    this.recordedCalls.push("setThinkingOption");
  }

  async setFeature() {
    this.recordedCalls.push("setFeature");
  }

  async revertConversation() {
    this.recordedCalls.push("revertConversation");
  }

  async revertFiles() {
    this.recordedCalls.push("revertFiles");
  }

  async revertBoth() {
    this.recordedCalls.push("revertBoth");
  }

  tryHandleOutOfBand(_prompt: AgentPromptInput) {
    this.recordedCalls.push("tryHandleOutOfBand");
    return {
      run: async () => {
        this.recordedCalls.push("tryHandleOutOfBand.run");
      },
    };
  }
}

interface RecordedClientCall {
  method:
    | "createSession"
    | "resumeSession"
    | "listCommands"
    | "importSession"
    | "archiveNativeSession"
    | "unarchiveNativeSession"
    | "shutdown";
  args: unknown[];
  receiver: AgentClient;
}

class FakeClient implements AgentClient {
  readonly provider = "claude";
  readonly capabilities = CAPABILITIES;
  readonly session = new FakeSession();
  readonly recordedCalls: RecordedClientCall[] = [];
  readonly commands = [
    { name: "review", description: "Review changes", argumentHint: "", kind: "command" as const },
  ];
  readonly archiveResult = Promise.resolve();
  readonly unarchiveResult = Promise.resolve();
  readonly shutdownError = new Error("shutdown failed");
  readonly shutdownResult = Promise.reject(this.shutdownError);

  constructor() {
    void this.shutdownResult.catch(() => undefined);
  }

  async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
    options?: AgentCreateSessionOptions,
  ): Promise<AgentSession> {
    this.record("createSession", [config, launchContext, options]);
    return this.session;
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    this.record("resumeSession", [handle, overrides, launchContext]);
    return this.session;
  }

  async fetchCatalog(_options: FetchCatalogOptions) {
    return { models: [], modes: [] };
  }

  async listCommands(config: AgentSessionConfig) {
    this.record("listCommands", [config]);
    return this.commands;
  }

  async importSession(
    input: ImportProviderSessionInput,
    context: ImportProviderSessionContext,
  ): Promise<ImportedProviderSession> {
    this.record("importSession", [input, context]);
    return {
      session: this.session,
      config: context.config,
      persistence: { provider: this.provider, sessionId: "imported-session" },
      timeline: [],
    };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  archiveNativeSession(handle: AgentPersistenceHandle): Promise<void> {
    this.record("archiveNativeSession", [handle]);
    return this.archiveResult;
  }

  unarchiveNativeSession(handle: AgentPersistenceHandle): Promise<void> {
    this.record("unarchiveNativeSession", [handle]);
    return this.unarchiveResult;
  }

  shutdown(): Promise<void> {
    this.record("shutdown", []);
    return this.shutdownResult;
  }

  private record(method: RecordedClientCall["method"], args: unknown[]): void {
    this.recordedCalls.push({ method, args, receiver: this });
  }
}

async function* emptyHistory(): AsyncGenerator<AgentStreamEvent> {
  for (const event of [] as AgentStreamEvent[]) {
    yield event;
  }
}

describe("wrapSessionProvider", () => {
  test("forwards every optional AgentSession method", async () => {
    const session = new FakeSession();
    const wrapped = wrapSessionProvider("custom-claude", session);

    await wrapped.listCommands?.();
    await wrapped.setModel?.("sonnet");
    await wrapped.setThinkingOption?.("high");
    await wrapped.setFeature?.("feature-1", true);
    await wrapped.revertConversation?.({ messageId: "message-1" });
    await wrapped.revertFiles?.({ messageId: "message-1" });
    await wrapped.revertBoth?.({ messageId: "message-1" });
    const handler = wrapped.tryHandleOutOfBand?.("/compact");
    await handler?.run({ emit: () => {} });

    expect(session.recordedCalls).toEqual([
      "listCommands",
      "setModel",
      "setThinkingOption",
      "setFeature",
      "revertConversation",
      "revertFiles",
      "revertBoth",
      "tryHandleOutOfBand",
      "tryHandleOutOfBand.run",
    ]);
  });
});

describe("wrapClientProvider", () => {
  test("forwards create options and optional client lifecycle methods", async () => {
    const client = new FakeClient();
    const wrapped = __providerRegistryInternals.wrapClientProvider(
      "custom-claude",
      client,
      [],
      [],
      false,
    );
    const config: AgentSessionConfig = { provider: "custom-claude", cwd: "/workspace" };
    const launchContext: AgentLaunchContext = { agentId: "agent-1" };
    const options = { persistSession: false, opaque: Symbol("opaque-option") };
    const handle: AgentPersistenceHandle = {
      provider: "custom-claude",
      sessionId: "session-1",
      nativeHandle: "native-1",
    };
    const overrides: Partial<AgentSessionConfig> = {
      provider: "custom-claude",
      model: "sonnet",
    };
    const importInput: ImportProviderSessionInput = {
      providerHandleId: "native-import",
      cwd: "/workspace",
    };
    const importContext: ImportProviderSessionContext = {
      config,
      storedConfig: { ...config, title: "Imported session" },
      launchContext,
    };

    const session = await wrapped.createSession(config, launchContext, options);
    const resumed = await wrapped.resumeSession(handle, overrides, launchContext);
    const commands = await wrapped.listCommands?.(config);
    const imported = await wrapped.importSession?.(importInput, importContext);
    const archiveResult = wrapped.archiveNativeSession?.(handle);
    const unarchiveResult = wrapped.unarchiveNativeSession?.(handle);
    const shutdownResult = wrapped.shutdown?.();

    expect(session.provider).toBe("custom-claude");
    expect(resumed.provider).toBe("custom-claude");
    expect(commands).toBe(client.commands);
    expect(imported).toMatchObject({
      session: { provider: "custom-claude" },
      config: { provider: "custom-claude" },
      persistence: { provider: "custom-claude", sessionId: "imported-session" },
    });
    expect(archiveResult).toBe(client.archiveResult);
    expect(unarchiveResult).toBe(client.unarchiveResult);
    expect(shutdownResult).toBe(client.shutdownResult);
    await expect(shutdownResult).rejects.toBe(client.shutdownError);
    expect(client.recordedCalls).toEqual([
      {
        method: "createSession",
        args: [{ ...config, provider: "claude" }, launchContext, options],
        receiver: client,
      },
      {
        method: "resumeSession",
        args: [
          { ...handle, provider: "claude" },
          { ...overrides, provider: "claude" },
          launchContext,
        ],
        receiver: client,
      },
      {
        method: "listCommands",
        args: [{ ...config, provider: "claude" }],
        receiver: client,
      },
      {
        method: "importSession",
        args: [
          importInput,
          {
            ...importContext,
            config: { ...config, provider: "claude" },
            storedConfig: { ...importContext.storedConfig, provider: "claude" },
          },
        ],
        receiver: client,
      },
      {
        method: "archiveNativeSession",
        args: [{ ...handle, provider: "claude" }],
        receiver: client,
      },
      {
        method: "unarchiveNativeSession",
        args: [{ ...handle, provider: "claude" }],
        receiver: client,
      },
      { method: "shutdown", args: [], receiver: client },
    ]);
  });

  test("omits optional methods that the inner client does not implement", () => {
    const session = new FakeSession();
    const client: AgentClient = {
      provider: "claude",
      capabilities: CAPABILITIES,
      createSession: async () => session,
      resumeSession: async () => session,
      fetchCatalog: async () => ({ models: [], modes: [] }),
      isAvailable: async () => true,
    };
    const wrapped = __providerRegistryInternals.wrapClientProvider(
      "custom-claude",
      client,
      [],
      [],
      false,
    );

    expect({
      resolveDefaultModeId: wrapped.resolveDefaultModeId,
      resolveCreateConfig: wrapped.resolveCreateConfig,
      isCreateConfigUnattended: wrapped.isCreateConfigUnattended,
      listCommands: wrapped.listCommands,
      listFeatures: wrapped.listFeatures,
      listImportableSessions: wrapped.listImportableSessions,
      importSession: wrapped.importSession,
      getDiagnostic: wrapped.getDiagnostic,
      archiveNativeSession: wrapped.archiveNativeSession,
      unarchiveNativeSession: wrapped.unarchiveNativeSession,
      shutdown: wrapped.shutdown,
    }).toEqual({
      resolveDefaultModeId: undefined,
      resolveCreateConfig: undefined,
      isCreateConfigUnattended: undefined,
      listCommands: undefined,
      listFeatures: undefined,
      listImportableSessions: undefined,
      importSession: undefined,
      getDiagnostic: undefined,
      archiveNativeSession: undefined,
      unarchiveNativeSession: undefined,
      shutdown: undefined,
    });
  });
});
