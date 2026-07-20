import type { Event as OpenCodeEvent } from "@opencode-ai/sdk/v2/client";

export interface NormalizedOpenCodeGlobalEvent {
  directory: string | null;
  event: OpenCodeEvent;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stripSyncVersion(type: string): string {
  return type.replace(/\.\d+$/, "");
}

function normalizeSyncEvent(
  envelope: Record<string, unknown>,
  syncValue: Record<string, unknown>,
): OpenCodeEvent | null {
  const syncType = readString(syncValue.name) ?? readString(syncValue.type);
  if (!syncType || syncType === "sync") {
    return null;
  }
  const properties = readRecord(syncValue.data) ?? readRecord(syncValue.properties);
  if (!properties) {
    return null;
  }
  const normalized = {
    id: readString(syncValue.id) ?? readString(envelope.id) ?? undefined,
    type: stripSyncVersion(syncType),
    properties,
  } as OpenCodeEvent & Record<string, unknown>;
  if (syncValue.seq !== undefined) normalized.seq = syncValue.seq;
  if (syncValue.aggregateID !== undefined) normalized.aggregateID = syncValue.aggregateID;
  return normalized;
}

/**
 * OpenCode has shipped three global-event envelopes that Paseo still needs to
 * accept: legacy events, SDK-declared flat sync events, and a nested
 * `{ type: "sync", syncEvent }` runtime shape. Normalize all three before any
 * session routing so the rest of the adapter has one event contract.
 */
export function normalizeOpenCodeGlobalEvent(
  rawEvent: unknown,
): NormalizedOpenCodeGlobalEvent | null {
  const root = readRecord(rawEvent);
  if (!root) {
    return null;
  }
  const directory = readString(root.directory);
  const envelope = readRecord(root.payload) ?? root;
  const nestedSync = readRecord(envelope.syncEvent);
  if (nestedSync) {
    const event = normalizeSyncEvent(envelope, nestedSync);
    return event ? { directory, event } : null;
  }
  if (envelope.type === "sync") {
    const event = normalizeSyncEvent(envelope, envelope);
    return event ? { directory, event } : null;
  }
  if (typeof envelope.type !== "string" || !readRecord(envelope.properties)) {
    return null;
  }
  return { directory, event: envelope as unknown as OpenCodeEvent };
}
