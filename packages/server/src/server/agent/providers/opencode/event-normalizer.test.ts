import { describe, expect, it } from "vitest";

import { normalizeOpenCodeGlobalEvent } from "./event-normalizer.js";

describe("normalizeOpenCodeGlobalEvent", () => {
  it("unwraps the nested runtime sync envelope", () => {
    expect(
      normalizeOpenCodeGlobalEvent({
        directory: "/workspace/project",
        payload: {
          type: "sync",
          id: "outer-1",
          syncEvent: {
            type: "message.part.updated.1",
            id: "event-1",
            seq: 7,
            aggregateID: "session-1",
            data: {
              sessionID: "session-1",
              part: { id: "part-1", type: "reasoning" },
            },
          },
        },
      }),
    ).toEqual({
      directory: "/workspace/project",
      event: {
        id: "event-1",
        seq: 7,
        aggregateID: "session-1",
        type: "message.part.updated",
        properties: {
          sessionID: "session-1",
          part: { id: "part-1", type: "reasoning" },
        },
      },
    });
  });

  it("normalizes SDK flat sync events", () => {
    expect(
      normalizeOpenCodeGlobalEvent({
        directory: "/workspace/project",
        payload: {
          type: "sync",
          name: "session.next.reasoning.delta.1",
          id: "event-2",
          seq: 8,
          data: {
            sessionID: "session-1",
            reasoningID: "reasoning-1",
            delta: "thinking",
          },
        },
      })?.event,
    ).toEqual({
      id: "event-2",
      seq: 8,
      type: "session.next.reasoning.delta",
      properties: {
        sessionID: "session-1",
        reasoningID: "reasoning-1",
        delta: "thinking",
      },
    });
  });

  it("keeps legacy events unchanged", () => {
    const event = {
      id: "event-3",
      type: "message.part.delta",
      properties: {
        sessionID: "session-1",
        messageID: "message-1",
        partID: "part-1",
        field: "text",
        delta: "hello",
      },
    };
    expect(
      normalizeOpenCodeGlobalEvent({ directory: "/workspace/project", payload: event }),
    ).toEqual({ directory: "/workspace/project", event });
  });
});
