import { describe, expect, test } from "vitest";

import {
  buildCrushQuestionResponses,
  createCrushTranslationState,
  mapCrushPermissionRequest,
  mapCrushQuestionRequest,
  translateCrushEvent,
} from "./event-translator.js";
import {
  CrushPermissionRequestSchema,
  CrushQuestionRequestSchema,
  CrushMessageSchema,
  parseCrushEventEnvelope,
} from "./protocol.js";

function event(type: string, payload: unknown) {
  return parseCrushEventEnvelope({
    type,
    payload: { type: "updated", payload },
  });
}

function message(parts: unknown[], updatedAt = 10) {
  return {
    id: "message-1",
    role: "assistant",
    session_id: "session-1",
    parts,
    model: "model",
    provider: "provider",
    created_at: 1,
    updated_at: updatedAt,
  };
}

describe("Crush event translation", () => {
  test("validates known message parts while accepting future part types", () => {
    const base = {
      id: "message-1",
      role: "assistant",
      session_id: "session-1",
      model: "model",
      provider: "provider",
      created_at: 1,
      updated_at: 1,
    };
    expect(() =>
      CrushMessageSchema.parse({ ...base, parts: [{ type: "text", data: {} }] }),
    ).toThrow();
    expect(
      CrushMessageSchema.parse({
        ...base,
        parts: [{ type: "future_part", data: { future: true } }],
      }).parts,
    ).toEqual([{ type: "future_part", data: { future: true } }]);
  });

  test("deduplicates growing snapshots while preserving text and reasoning updates", () => {
    const state = createCrushTranslationState("session-1");
    state.activeRunId = "run-1";
    state.activeTurnId = "turn-1";

    const first = translateCrushEvent(
      event(
        "message",
        message([
          { type: "reasoning", data: { thinking: "Think" } },
          { type: "text", data: { text: "Hel" } },
          {
            type: "tool_call",
            data: { id: "call-1", name: "view", input: '{"path":"README.md"}' },
          },
        ]),
      ),
      state,
    );
    const second = translateCrushEvent(
      event(
        "message",
        message(
          [
            { type: "reasoning", data: { thinking: "Thinking" } },
            { type: "text", data: { text: "Hello" } },
            {
              type: "tool_call",
              data: { id: "call-1", name: "view", input: '{"path":"README.md"}' },
            },
          ],
          11,
        ),
      ),
      state,
    );

    expect(first).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "timeline",
          turnId: "turn-1",
          item: expect.objectContaining({ type: "assistant_message", text: "Hel" }),
        }),
        expect.objectContaining({
          item: expect.objectContaining({ type: "reasoning", text: "Think" }),
        }),
        expect.objectContaining({
          item: expect.objectContaining({
            type: "tool_call",
            callId: "call-1",
            detail: expect.objectContaining({ type: "read", filePath: "README.md" }),
          }),
        }),
      ]),
    );
    expect(second).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({ type: "assistant_message", text: "Hello" }),
      }),
      expect.objectContaining({
        item: expect.objectContaining({ type: "reasoning", text: "ing" }),
      }),
    ]);
  });

  test("maps tool results and reconciles the authoritative run completion", () => {
    const state = createCrushTranslationState("session-1");
    state.activeRunId = "run-1";
    state.activeTurnId = "turn-1";

    const toolEvents = translateCrushEvent(
      event(
        "message",
        message([
          {
            type: "tool_call",
            data: { id: "call-1", name: "bash", input: '{"command":"pwd"}', finished: true },
          },
          {
            type: "tool_result",
            data: {
              tool_call_id: "call-1",
              name: "bash",
              content: "/tmp/project",
              metadata: '{"output":"/tmp/project","exit_code":0}',
              is_error: false,
            },
          },
        ]),
      ),
      state,
    );
    const foreign = translateCrushEvent(
      event("run_complete", {
        session_id: "session-1",
        run_id: "another-run",
        message_id: "message-1",
        text: "wrong",
      }),
      state,
    );
    const complete = translateCrushEvent(
      event("run_complete", {
        session_id: "session-1",
        run_id: "run-1",
        message_id: "message-1",
        text: "final answer",
      }),
      state,
    );

    expect(toolEvents.at(-1)).toMatchObject({
      type: "timeline",
      item: {
        type: "tool_call",
        callId: "call-1",
        status: "completed",
        detail: { type: "shell", command: "pwd", output: "/tmp/project", exitCode: 0 },
      },
    });
    expect(foreign).toEqual([]);
    expect(complete).toEqual([
      expect.objectContaining({
        type: "timeline",
        item: expect.objectContaining({ type: "assistant_message", text: "final answer" }),
      }),
      { type: "turn_completed", provider: "crush", turnId: "turn-1" },
    ]);
    expect(state.activeRunId).toBe(null);
  });

  test("maps permission actions to Crush's three native choices", () => {
    const request = CrushPermissionRequestSchema.parse({
      id: "permission-1",
      session_id: "session-1",
      tool_call_id: "call-1",
      tool_name: "bash",
      description: "Run tests",
      action: "execute",
      params: { command: "npm test" },
      path: "/tmp/project",
    });

    expect(mapCrushPermissionRequest(request)).toMatchObject({
      id: "permission-1",
      kind: "tool",
      detail: { type: "shell", command: "npm test" },
      actions: [
        { id: "allow", behavior: "allow" },
        { id: "allow_session", behavior: "allow" },
        { id: "deny", behavior: "deny" },
      ],
    });
  });

  test("maps cancellation and errors only for the active caller-generated run id", () => {
    const canceledState = createCrushTranslationState("session-1");
    canceledState.activeRunId = "run-cancel";
    canceledState.activeTurnId = "turn-cancel";
    expect(
      translateCrushEvent(
        event("run_complete", {
          session_id: "session-1",
          run_id: "run-cancel",
          message_id: "message-cancel",
          cancelled: true,
        }),
        canceledState,
      ),
    ).toEqual([
      {
        type: "turn_canceled",
        provider: "crush",
        turnId: "turn-cancel",
        reason: "Canceled",
      },
    ]);

    const failedState = createCrushTranslationState("session-1");
    failedState.activeRunId = "run-fail";
    failedState.activeTurnId = "turn-fail";
    expect(
      translateCrushEvent(
        event("run_complete", {
          session_id: "session-1",
          run_id: "run-fail",
          message_id: "message-fail",
          error: "provider failed",
        }),
        failedState,
      ),
    ).toEqual([
      {
        type: "turn_failed",
        provider: "crush",
        turnId: "turn-fail",
        error: "provider failed",
      },
    ]);
  });

  test("round-trips duplicate question labels and structured answers", () => {
    const request = CrushQuestionRequestSchema.parse({
      id: "batch-1",
      session_id: "session-1",
      tool_call_id: "call-1",
      questions: [
        {
          id: "q1",
          type: "single_choice",
          label: "Choice",
          question: "Pick one",
          choices: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
        },
        {
          id: "q2",
          type: "multi_choice",
          label: "Choice",
          question: "Pick several",
          choices: [
            { id: "b", label: "B" },
            { id: "c", label: "C" },
          ],
        },
        { id: "q3", type: "yes_no", question: "Continue?" },
        { id: "q4", type: "free_text", question: "Why?", description: "Reason" },
      ],
    });

    expect(mapCrushQuestionRequest(request).input).toMatchObject({
      questions: [
        { header: "Choice", multiSelect: false },
        { header: "Choice 2", multiSelect: true },
        { header: "Question 3" },
        { header: "Question 4", allowOther: true },
      ],
    });
    expect(
      buildCrushQuestionResponses(request, {
        answers: {
          Choice: "A",
          "Choice 2": "B, C",
          "Question 3": "Yes",
          "Question 4": "Because",
        },
      }),
    ).toEqual([
      { request_id: "q1", selected_ids: ["a"] },
      { request_id: "q2", selected_ids: ["b", "c"] },
      { request_id: "q3", yes: true },
      { request_id: "q4", fill_in_text: "Because" },
    ]);
  });
});
