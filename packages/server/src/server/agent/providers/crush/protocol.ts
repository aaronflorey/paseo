import { z } from "zod";

const LooseObject = z.object({}).passthrough();

export const CrushVersionInfoSchema = z
  .object({
    version: z.string(),
    commit: z.string().optional(),
    build_id: z.string().optional(),
    go_version: z.string().optional(),
    platform: z.string().optional(),
  })
  .passthrough();

export const CrushWorkspaceSchema = z
  .object({
    id: z.string(),
    path: z.string(),
    yolo: z.boolean().optional(),
    version: z.string().optional(),
    config: LooseObject.optional(),
    env: z.array(z.string()).optional(),
  })
  .passthrough();

export const CrushTodoSchema = z
  .object({
    content: z.string(),
    status: z.string(),
    active_form: z.string().optional(),
  })
  .passthrough();

export const CrushSessionSchema = z
  .object({
    id: z.string(),
    parent_session_id: z.string().default(""),
    title: z.string().default(""),
    message_count: z.number().default(0),
    prompt_tokens: z.number().default(0),
    completion_tokens: z.number().default(0),
    summary_message_id: z.string().default(""),
    cost: z.number().default(0),
    todos: z.array(CrushTodoSchema).optional(),
    created_at: z.number(),
    updated_at: z.number(),
    is_busy: z.boolean().optional(),
    attached_clients: z.number().optional(),
  })
  .passthrough();

const CrushReasoningPartSchema = z.object({
  type: z.literal("reasoning"),
  data: z
    .object({
      thinking: z.string(),
      signature: z.string().optional(),
      started_at: z.number().optional(),
      finished_at: z.number().optional(),
    })
    .passthrough(),
});

const CrushTextPartSchema = z.object({
  type: z.literal("text"),
  data: z.object({ text: z.string() }).passthrough(),
});

const CrushToolCallPartSchema = z.object({
  type: z.literal("tool_call"),
  data: z
    .object({
      id: z.string(),
      name: z.string(),
      input: z.string().default(""),
      type: z.string().optional(),
      finished: z.boolean().optional(),
    })
    .passthrough(),
});

const CrushToolResultPartSchema = z.object({
  type: z.literal("tool_result"),
  data: z
    .object({
      tool_call_id: z.string(),
      name: z.string().default(""),
      content: z.string().default(""),
      data: z.string().optional(),
      mime_type: z.string().optional(),
      metadata: z.string().optional(),
      is_error: z.boolean().default(false),
    })
    .passthrough(),
});

const CrushFinishPartSchema = z.object({
  type: z.literal("finish"),
  data: z
    .object({
      reason: z.string(),
      time: z.number(),
      message: z.string().optional(),
      details: z.string().optional(),
    })
    .passthrough(),
});

const CrushShellPartSchema = z.object({
  type: z.literal("shell_command"),
  data: z
    .object({
      command: z.string(),
      output: z.string(),
      exit_code: z.number(),
    })
    .passthrough(),
});

const CrushOtherPartSchema = z
  .object({
    type: z.string(),
    data: z.unknown(),
  })
  .passthrough()
  .refine(
    (part) =>
      !["reasoning", "text", "tool_call", "tool_result", "finish", "shell_command"].includes(
        part.type,
      ),
    { message: "Known Crush message part is missing required fields" },
  );

export const CrushMessagePartSchema = z.union([
  CrushReasoningPartSchema,
  CrushTextPartSchema,
  CrushToolCallPartSchema,
  CrushToolResultPartSchema,
  CrushFinishPartSchema,
  CrushShellPartSchema,
  CrushOtherPartSchema,
]);

export const CrushMessageSchema = z
  .object({
    id: z.string(),
    role: z.enum(["assistant", "user", "system", "tool"]),
    session_id: z.string(),
    parts: z.array(CrushMessagePartSchema),
    model: z.string().default(""),
    provider: z.string().default(""),
    created_at: z.number(),
    updated_at: z.number(),
  })
  .passthrough();

export const CrushProviderSchema = z
  .object({
    name: z.string(),
    id: z.string(),
    default_large_model_id: z.string().optional(),
    default_small_model_id: z.string().optional(),
    models: z
      .array(
        z
          .object({
            id: z.string(),
            name: z.string(),
            context_window: z.number().optional(),
            can_reason: z.boolean().optional(),
            reasoning_levels: z.array(z.string()).optional(),
            default_reasoning_effort: z.string().optional(),
            supports_attachments: z.boolean().optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

export const CrushSelectedModelSchema = z
  .object({
    provider: z.string(),
    model: z.string(),
  })
  .passthrough();

export const CrushAgentInfoSchema = z
  .object({
    is_busy: z.boolean(),
    is_ready: z.boolean(),
    model: z.object({ id: z.string().optional(), name: z.string().optional() }).passthrough(),
    model_cfg: CrushSelectedModelSchema,
  })
  .passthrough();

export const CrushPermissionRequestSchema = z
  .object({
    id: z.string(),
    session_id: z.string(),
    tool_call_id: z.string(),
    tool_name: z.string(),
    description: z.string().default(""),
    action: z.string().default(""),
    params: z.unknown(),
    path: z.string().default(""),
  })
  .passthrough();

export const CrushPermissionNotificationSchema = z
  .object({
    tool_call_id: z.string(),
    granted: z.boolean(),
    denied: z.boolean(),
  })
  .passthrough();

export const CrushQuestionRequestSchema = z
  .object({
    id: z.string(),
    session_id: z.string(),
    tool_call_id: z.string(),
    questions: z.array(
      z
        .object({
          id: z.string(),
          type: z.string(),
          label: z.string().optional(),
          question: z.string(),
          description: z.string().optional(),
          choices: z
            .array(
              z
                .object({
                  id: z.string(),
                  label: z.string(),
                  description: z.string().optional(),
                })
                .passthrough(),
            )
            .optional(),
        })
        .passthrough(),
    ),
    confirm_title: z.string().optional(),
    confirm_description: z.string().optional(),
  })
  .passthrough();

export const CrushQuestionNotificationSchema = z.object({ batch_id: z.string() }).passthrough();

export const CrushRunCompleteSchema = z
  .object({
    session_id: z.string(),
    run_id: z.string().optional(),
    message_id: z.string(),
    text: z.string().optional(),
    error: z.string().optional(),
    cancelled: z.boolean().optional(),
  })
  .passthrough();

export const CrushAgentEventSchema = z
  .object({
    type: z.string(),
    session_id: z.string().optional(),
    run_id: z.string().optional(),
    error: z.string().optional(),
    progress: z.string().optional(),
    done: z.boolean().optional(),
  })
  .passthrough();

export const CrushSkillInfoSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().default(""),
    label: z.string().default(""),
    source: z.string().default(""),
    user_invocable: z.boolean().default(false),
  })
  .passthrough();

export const CrushSkillReadResponseSchema = z
  .object({
    content: z.string(),
    result: z
      .object({
        name: z.string(),
        description: z.string().default(""),
        source: z.string().default(""),
        builtin: z.boolean().default(false),
      })
      .passthrough(),
  })
  .passthrough();

const innerEvent = <T extends z.ZodTypeAny>(payload: T) =>
  z.object({ type: z.enum(["created", "updated", "deleted"]), payload }).passthrough();

export const CrushEventEnvelopeSchema = z
  .object({
    type: z.string(),
    payload: z.unknown(),
  })
  .passthrough();

const EVENT_PAYLOAD_SCHEMAS: Record<string, z.ZodTypeAny> = {
  message: innerEvent(CrushMessageSchema),
  session: innerEvent(CrushSessionSchema),
  permission_request: innerEvent(CrushPermissionRequestSchema),
  permission_notification: innerEvent(CrushPermissionNotificationSchema),
  question_batch_request: innerEvent(CrushQuestionRequestSchema),
  question_batch_notification: innerEvent(CrushQuestionNotificationSchema),
  run_complete: innerEvent(CrushRunCompleteSchema),
  agent_event: innerEvent(CrushAgentEventSchema),
  config_changed: innerEvent(z.object({ workspace_id: z.string() }).passthrough()),
};

export interface CrushEventEnvelope {
  type: string;
  event: { type: "created" | "updated" | "deleted"; payload: unknown } | null;
}

export function parseCrushEventEnvelope(value: unknown): CrushEventEnvelope {
  const envelope = CrushEventEnvelopeSchema.parse(value);
  const schema = EVENT_PAYLOAD_SCHEMAS[envelope.type];
  if (!schema) {
    return { type: envelope.type, event: null };
  }
  return {
    type: envelope.type,
    event: schema.parse(envelope.payload) as CrushEventEnvelope["event"],
  };
}

export type CrushVersionInfo = z.infer<typeof CrushVersionInfoSchema>;
export type CrushWorkspace = z.infer<typeof CrushWorkspaceSchema>;
export type CrushSession = z.infer<typeof CrushSessionSchema>;
export type CrushMessage = z.infer<typeof CrushMessageSchema>;
export type CrushMessagePart = z.infer<typeof CrushMessagePartSchema>;
export type CrushProvider = z.infer<typeof CrushProviderSchema>;
export type CrushAgentInfo = z.infer<typeof CrushAgentInfoSchema>;
export type CrushPermissionRequest = z.infer<typeof CrushPermissionRequestSchema>;
export type CrushPermissionNotification = z.infer<typeof CrushPermissionNotificationSchema>;
export type CrushQuestionRequest = z.infer<typeof CrushQuestionRequestSchema>;
export type CrushQuestionNotification = z.infer<typeof CrushQuestionNotificationSchema>;
export type CrushRunComplete = z.infer<typeof CrushRunCompleteSchema>;
export type CrushSkillInfo = z.infer<typeof CrushSkillInfoSchema>;
