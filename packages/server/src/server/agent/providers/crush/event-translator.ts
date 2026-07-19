import type {
  AgentMetadata,
  AgentPermissionRequest,
  AgentStreamEvent,
  AgentTimelineItem,
  ToolCallDetail,
} from "../../agent-sdk-types.js";
import type {
  CrushEventEnvelope,
  CrushMessage,
  CrushMessagePart,
  CrushPermissionRequest,
  CrushQuestionRequest,
  CrushRunComplete,
  CrushSession,
} from "./protocol.js";

const PROVIDER = "crush";

interface TrackedToolCall {
  name: string;
  input: unknown;
  detail: ToolCallDetail;
}

export interface CrushTranslationState {
  sessionId: string;
  activeRunId: string | null;
  activeTurnId: string | null;
  activeTurnStarted: boolean;
  suppressUserText: string | null;
  lastAssistantText: Map<string, string>;
  lastReasoningText: Map<string, string>;
  messageFingerprints: Map<string, string>;
  partFingerprints: Map<string, string>;
  toolCalls: Map<string, TrackedToolCall>;
  lastTodosFingerprint: string | null;
}

export function createCrushTranslationState(sessionId: string): CrushTranslationState {
  return {
    sessionId,
    activeRunId: null,
    activeTurnId: null,
    activeTurnStarted: false,
    suppressUserText: null,
    lastAssistantText: new Map(),
    lastReasoningText: new Map(),
    messageFingerprints: new Map(),
    partFingerprints: new Map(),
    toolCalls: new Map(),
    lastTodosFingerprint: null,
  };
}

export function translateCrushEvent(
  envelope: CrushEventEnvelope,
  state: CrushTranslationState,
): AgentStreamEvent[] {
  if (!envelope.event) return [];
  const payload = envelope.event.payload;
  switch (envelope.type) {
    case "message":
      return translateCrushMessage(payload as CrushMessage, state);
    case "session":
      return translateCrushSession(payload as CrushSession, state);
    case "permission_request": {
      const request = payload as CrushPermissionRequest;
      if (request.session_id !== state.sessionId) return [];
      return [
        withTurn(state, {
          type: "permission_requested",
          provider: PROVIDER,
          request: mapCrushPermissionRequest(request),
        }),
      ];
    }
    case "question_batch_request": {
      const request = payload as CrushQuestionRequest;
      if (request.session_id !== state.sessionId) return [];
      return [
        withTurn(state, {
          type: "permission_requested",
          provider: PROVIDER,
          request: mapCrushQuestionRequest(request),
        }),
      ];
    }
    case "permission_notification":
    case "question_batch_notification":
      // Notifications do not carry a session id. The session correlates them
      // against its pending native requests before translating them.
      return [];
    case "run_complete":
      return translateRunComplete(payload as CrushRunComplete, state);
    case "agent_event": {
      const event = payload as {
        type: string;
        session_id?: string;
        run_id?: string;
        error?: string;
      };
      if (event.type !== "error" || event.session_id !== state.sessionId || !event.error) return [];
      if (!state.activeRunId || event.run_id !== state.activeRunId) return [];
      return [
        withTurn(state, {
          type: "timeline",
          provider: PROVIDER,
          item: { type: "error", message: event.error },
        }),
      ];
    }
    default:
      return [];
  }
}

export function translateCrushHistoryMessage(
  message: CrushMessage,
  state = createCrushTranslationState(message.session_id),
): AgentStreamEvent[] {
  return translateCrushMessage(message, state, true);
}

function translateCrushMessage(
  message: CrushMessage,
  state: CrushTranslationState,
  history = false,
): AgentStreamEvent[] {
  if (message.session_id !== state.sessionId) return [];
  const fingerprint = JSON.stringify(message);
  if (!history && state.messageFingerprints.get(message.id) === fingerprint) return [];
  state.messageFingerprints.set(message.id, fingerprint);
  const timestamp = unixTimestamp(message.updated_at || message.created_at);
  if (message.role === "user") return translateCrushUserMessage(message, state, history, timestamp);
  if (message.role === "system") return [];
  return translateCrushAssistantMessage(message, state, history, timestamp);
}

function translateCrushUserMessage(
  message: CrushMessage,
  state: CrushTranslationState,
  history: boolean,
  timestamp: string | undefined,
): AgentStreamEvent[] {
  const text = collectPartText(message);
  if (
    !history &&
    state.suppressUserText !== null &&
    text.trim() === state.suppressUserText.trim()
  ) {
    state.suppressUserText = null;
    return [];
  }
  return text
    ? [timeline(state, { type: "user_message", text, messageId: message.id }, timestamp)]
    : [];
}

function translateCrushAssistantMessage(
  message: CrushMessage,
  state: CrushTranslationState,
  history: boolean,
  timestamp: string | undefined,
): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];
  ensureTurnStarted(state, events, history);
  appendAssistantTextEvent(message, state, history, timestamp, events);
  appendReasoningEvent(message, state, history, timestamp, events);
  for (const part of message.parts) {
    const event = translateCrushMessagePart(part, message.id, state, history, timestamp);
    if (event) events.push(event);
  }
  return events;
}

function appendAssistantTextEvent(
  message: CrushMessage,
  state: CrushTranslationState,
  history: boolean,
  timestamp: string | undefined,
  events: AgentStreamEvent[],
): void {
  const assistantText = message.parts
    .filter((part) => part.type === "text")
    .map((part) => readStringRecord(part.data, "text"))
    .join("");
  if (!assistantText || (!history && state.lastAssistantText.get(message.id) === assistantText))
    return;
  state.lastAssistantText.set(message.id, assistantText);
  events.push(
    timeline(
      state,
      { type: "assistant_message", text: assistantText, messageId: message.id },
      timestamp,
    ),
  );
}

function appendReasoningEvent(
  message: CrushMessage,
  state: CrushTranslationState,
  history: boolean,
  timestamp: string | undefined,
  events: AgentStreamEvent[],
): void {
  const reasoningText = message.parts
    .filter((part) => part.type === "reasoning")
    .map((part) => readStringRecord(part.data, "thinking"))
    .join("");
  if (!reasoningText) return;
  const previous = history ? "" : (state.lastReasoningText.get(message.id) ?? "");
  const delta = reasoningText.startsWith(previous)
    ? reasoningText.slice(previous.length)
    : reasoningText;
  state.lastReasoningText.set(message.id, reasoningText);
  if (delta) events.push(timeline(state, { type: "reasoning", text: delta }, timestamp));
}

function translateCrushMessagePart(
  part: CrushMessagePart,
  messageId: string,
  state: CrushTranslationState,
  history: boolean,
  timestamp: string | undefined,
): AgentStreamEvent | null {
  switch (part.type) {
    case "tool_call":
      return translateToolCallPart(part, messageId, state, history, timestamp);
    case "tool_result":
      return translateToolResultPart(part, messageId, state, history, timestamp);
    case "shell_command":
      return translateShellPart(part, messageId, state, history, timestamp);
    default:
      return null;
  }
}

function translateToolCallPart(
  part: CrushMessagePart,
  messageId: string,
  state: CrushTranslationState,
  history: boolean,
  timestamp: string | undefined,
): AgentStreamEvent | null {
  const data = asRecord(part.data);
  const callId = readString(data.id);
  const name = readString(data.name) || "tool";
  const input = parseJson(readString(data.input));
  const detail = deriveToolDetail(name, input, null);
  state.toolCalls.set(callId, { name, input, detail });
  if (!history && !rememberChangedPart(state, `call:${messageId}:${callId}`, part)) return null;
  return timeline(
    state,
    {
      type: "tool_call",
      callId,
      name,
      status: data.finished === true ? "completed" : "running",
      detail,
      error: null,
    },
    timestamp,
  );
}

function translateToolResultPart(
  part: CrushMessagePart,
  messageId: string,
  state: CrushTranslationState,
  history: boolean,
  timestamp: string | undefined,
): AgentStreamEvent | null {
  const data = asRecord(part.data);
  const callId = readString(data.tool_call_id);
  const tracked = state.toolCalls.get(callId);
  const name = readString(data.name) || tracked?.name || "tool";
  const content = readString(data.content);
  const rawMetadata = readString(data.metadata);
  const output = rawMetadata ? (parseJson(rawMetadata) ?? content) : content;
  const detail = deriveToolDetail(name, tracked?.input ?? null, output);
  if (!history && !rememberChangedPart(state, `result:${messageId}:${callId}`, part)) return null;
  const item: AgentTimelineItem =
    data.is_error === true
      ? {
          type: "tool_call",
          callId,
          name,
          status: "failed",
          detail,
          error: content || "Crush tool failed",
        }
      : { type: "tool_call", callId, name, status: "completed", detail, error: null };
  return timeline(state, item, timestamp);
}

function translateShellPart(
  part: CrushMessagePart,
  messageId: string,
  state: CrushTranslationState,
  history: boolean,
  timestamp: string | undefined,
): AgentStreamEvent | null {
  const data = asRecord(part.data);
  if (!history && !rememberChangedPart(state, `shell:${messageId}`, part)) return null;
  const detail: ToolCallDetail = {
    type: "shell",
    command: readString(data.command),
    output: readString(data.output),
    exitCode: readNumber(data.exit_code),
  };
  const item: AgentTimelineItem =
    readNumber(data.exit_code) === 0
      ? {
          type: "tool_call",
          callId: `shell-${messageId}`,
          name: "shell",
          status: "completed",
          detail,
          error: null,
        }
      : {
          type: "tool_call",
          callId: `shell-${messageId}`,
          name: "shell",
          status: "failed",
          detail,
          error: readString(data.output),
        };
  return timeline(state, item, timestamp);
}

function translateCrushSession(
  session: CrushSession,
  state: CrushTranslationState,
): AgentStreamEvent[] {
  if (session.id !== state.sessionId) return [];
  const fingerprint = JSON.stringify(session.todos ?? []);
  if (state.lastTodosFingerprint === fingerprint) return [];
  state.lastTodosFingerprint = fingerprint;
  if (!session.todos || session.todos.length === 0) return [];
  return [
    timeline(
      state,
      {
        type: "todo",
        items: session.todos.map((todo) => ({
          text: todo.active_form || todo.content,
          completed: todo.status === "completed",
        })),
      },
      unixTimestamp(session.updated_at),
    ),
  ];
}

function translateRunComplete(
  completion: CrushRunComplete,
  state: CrushTranslationState,
): AgentStreamEvent[] {
  if (completion.session_id !== state.sessionId) return [];
  if (!state.activeRunId || completion.run_id !== state.activeRunId) return [];
  const turnId = state.activeTurnId ?? completion.run_id;
  const events: AgentStreamEvent[] = [];
  if (completion.text && state.lastAssistantText.get(completion.message_id) !== completion.text) {
    state.lastAssistantText.set(completion.message_id, completion.text);
    events.push({
      type: "timeline",
      provider: PROVIDER,
      ...(turnId ? { turnId } : {}),
      item: {
        type: "assistant_message",
        text: completion.text,
        messageId: completion.message_id,
      },
    });
  }
  if (completion.cancelled) {
    events.push({
      type: "turn_canceled",
      provider: PROVIDER,
      ...(turnId ? { turnId } : {}),
      reason: "Canceled",
    });
  } else if (completion.error) {
    events.push({
      type: "turn_failed",
      provider: PROVIDER,
      ...(turnId ? { turnId } : {}),
      error: completion.error,
    });
  } else {
    events.push({
      type: "turn_completed",
      provider: PROVIDER,
      ...(turnId ? { turnId } : {}),
    });
  }
  state.activeRunId = null;
  state.activeTurnId = null;
  state.activeTurnStarted = false;
  state.suppressUserText = null;
  return events;
}

export function mapCrushPermissionRequest(request: CrushPermissionRequest): AgentPermissionRequest {
  const input = request.params;
  return {
    id: request.id,
    provider: PROVIDER,
    name: request.tool_name,
    kind: "tool",
    title: request.description || request.action || request.tool_name,
    description: request.path || undefined,
    input: asMetadata(input),
    detail: deriveToolDetail(request.tool_name, input, null),
    actions: [
      { id: "allow", label: "Allow once", behavior: "allow", variant: "primary" },
      {
        id: "allow_session",
        label: "Allow for session",
        behavior: "allow",
        variant: "secondary",
      },
      { id: "deny", label: "Deny", behavior: "deny", variant: "danger" },
    ],
    metadata: { crushPermission: request },
  };
}

export function mapCrushQuestionRequest(request: CrushQuestionRequest): AgentPermissionRequest {
  const headers = buildQuestionHeaders(request);
  const questions = request.questions.map((question, index) => {
    const header = headers[index];
    const isMulti = question.type === "multi_choice";
    const isFreeText = question.type === "free_text";
    const isYesNo = question.type === "yes_no";
    const options = isYesNo
      ? [{ label: "Yes" }, { label: "No" }]
      : (question.choices ?? []).map((choice) => {
          const option: { label: string; description?: string } = { label: choice.label };
          if (choice.description) option.description = choice.description;
          return option;
        });
    return {
      question: question.question,
      header,
      options,
      multiSelect: isMulti,
      allowOther: isFreeText,
      allowEmpty: false,
      ...(isFreeText ? { placeholder: question.description ?? "Type your answer" } : {}),
    };
  });
  return {
    id: request.id,
    provider: PROVIDER,
    name: "question",
    kind: "question",
    title: request.confirm_title || request.questions[0]?.question || "Question",
    description: request.confirm_description,
    input: { questions },
    metadata: { crushQuestion: request, headers },
  };
}

export function buildCrushQuestionResponses(
  request: CrushQuestionRequest,
  updatedInput: AgentMetadata | undefined,
): Array<Record<string, unknown>> {
  const answers = asRecord(updatedInput?.answers);
  const headers = buildQuestionHeaders(request);
  return request.questions.map((question, index) => {
    const answer = readString(answers[headers[index]]);
    if (question.type === "yes_no") {
      return { request_id: question.id, yes: /^yes$/iu.test(answer.trim()) };
    }
    if (question.type === "free_text") {
      return { request_id: question.id, fill_in_text: answer };
    }
    const labels = new Set(
      answer
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    );
    return {
      request_id: question.id,
      selected_ids: (question.choices ?? [])
        .filter((choice) => labels.has(choice.label))
        .map((choice) => choice.id),
    };
  });
}

function ensureTurnStarted(
  state: CrushTranslationState,
  events: AgentStreamEvent[],
  history: boolean,
): void {
  if (history || state.activeTurnStarted) return;
  state.activeTurnStarted = true;
  events.push({
    type: "turn_started",
    provider: PROVIDER,
    ...(state.activeTurnId ? { turnId: state.activeTurnId } : {}),
  });
}

function timeline(
  state: CrushTranslationState,
  item: AgentTimelineItem,
  timestamp?: string,
): AgentStreamEvent {
  return {
    type: "timeline",
    provider: PROVIDER,
    item,
    ...(state.activeTurnId ? { turnId: state.activeTurnId } : {}),
    ...(timestamp ? { timestamp } : {}),
  };
}

function withTurn<T extends AgentStreamEvent>(state: CrushTranslationState, event: T): T {
  return (state.activeTurnId ? { ...event, turnId: state.activeTurnId } : event) as T;
}

function rememberChangedPart(state: CrushTranslationState, key: string, part: unknown): boolean {
  const fingerprint = JSON.stringify(part);
  if (state.partFingerprints.get(key) === fingerprint) return false;
  state.partFingerprints.set(key, fingerprint);
  return true;
}

function buildQuestionHeaders(request: CrushQuestionRequest): string[] {
  const used = new Set<string>();
  return request.questions.map((question, index) => {
    const base = question.label?.trim() || `Question ${index + 1}`;
    let header = base;
    let suffix = 2;
    while (used.has(header)) {
      header = `${base} ${suffix}`;
      suffix += 1;
    }
    used.add(header);
    return header;
  });
}

function deriveToolDetail(name: string, input: unknown, output: unknown): ToolCallDetail {
  const normalized = name.toLowerCase();
  const args = asRecord(input);
  const result = asRecord(output);
  const outputText =
    typeof output === "string" ? output : readFirstString(result, ["output", "content", "result"]);
  if (["bash", "shell", "execute"].includes(normalized)) {
    return {
      type: "shell",
      command: readFirstString(args, ["command", "cmd"]),
      cwd: optionalString(args.cwd),
      ...(outputText ? { output: outputText } : {}),
      ...(typeof result.exit_code === "number" ? { exitCode: result.exit_code } : {}),
    };
  }
  if (["view", "read", "read_file"].includes(normalized)) {
    return {
      type: "read",
      filePath: readFirstString(args, ["file_path", "path"]),
      ...(outputText ? { content: outputText } : {}),
      ...(typeof args.offset === "number" ? { offset: args.offset } : {}),
      ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
    };
  }
  if (["edit", "multi_edit", "apply_patch"].includes(normalized)) {
    return {
      type: "edit",
      filePath: readFirstString(args, ["file_path", "path"]),
      oldString: optionalString(args.old_string),
      newString: optionalString(args.new_string),
      unifiedDiff: optionalString(result.diff) ?? optionalString(args.patch),
    };
  }
  if (["write", "write_file"].includes(normalized)) {
    return {
      type: "write",
      filePath: readFirstString(args, ["file_path", "path"]),
      content: optionalString(args.content),
    };
  }
  if (["grep", "glob", "search", "sourcegraph"].includes(normalized)) {
    return {
      type: "search",
      query: readFirstString(args, ["query", "pattern"]),
      toolName: mapSearchToolName(normalized),
      ...(outputText ? { content: outputText } : {}),
    };
  }
  if (["fetch", "download", "web_fetch"].includes(normalized)) {
    return {
      type: "fetch",
      url: readFirstString(args, ["url"]),
      ...(outputText ? { result: outputText } : {}),
    };
  }
  return { type: "unknown", input, output };
}

function mapSearchToolName(name: string): "glob" | "grep" | "search" {
  if (name === "glob") return "glob";
  if (name === "grep") return "grep";
  return "search";
}

function collectPartText(message: CrushMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => readStringRecord(part.data, "text"))
    .join("");
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asMetadata(value: unknown): AgentMetadata {
  const record = asRecord(value);
  return Object.keys(record).length > 0 ? record : { value };
}

function parseJson(value: string): unknown {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | undefined {
  const result = readString(value);
  return result || undefined;
}

function readNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function readStringRecord(value: unknown, key: string): string {
  return readString(asRecord(value)[key]);
}

function readFirstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = readString(record[key]);
    if (value) return value;
  }
  return "";
}

function unixTimestamp(seconds: number): string | undefined {
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return new Date(seconds * 1000).toISOString();
}
