import { useEffect, useState } from "react";
import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";

export const OPENCODE_STALL_THRESHOLD_MS = 10 * 60_000;
const STALL_CLOCK_INTERVAL_MS = 60_000;

type ActivityTimestamp = Date | string | number | null | undefined;

export interface OpenCodeStallInput {
  provider: string | null | undefined;
  status: AgentLifecycleStatus;
  lastActivityAt: ActivityTimestamp;
  childActivityAt?: readonly ActivityTimestamp[];
  isWaitingForInput?: boolean;
  nowMs?: number;
}

export interface OpenCodeStallState {
  possiblyStalled: boolean;
  inactiveMinutes: number | null;
}

function toTimestampMs(value: ActivityTimestamp): number | null {
  if (value == null) return null;
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function deriveOpenCodeStallState(input: OpenCodeStallInput): OpenCodeStallState {
  let effectiveLastActivityAtMs = toTimestampMs(input.lastActivityAt);
  for (const childTimestamp of input.childActivityAt ?? []) {
    const childActivityAtMs = toTimestampMs(childTimestamp);
    if (
      childActivityAtMs !== null &&
      (effectiveLastActivityAtMs === null || childActivityAtMs > effectiveLastActivityAtMs)
    ) {
      effectiveLastActivityAtMs = childActivityAtMs;
    }
  }

  if (
    input.provider !== "opencode" ||
    input.status !== "running" ||
    input.isWaitingForInput === true ||
    effectiveLastActivityAtMs === null
  ) {
    return { possiblyStalled: false, inactiveMinutes: null };
  }

  const inactiveMs = Math.max(0, (input.nowMs ?? Date.now()) - effectiveLastActivityAtMs);
  return {
    possiblyStalled: inactiveMs >= OPENCODE_STALL_THRESHOLD_MS,
    inactiveMinutes: Math.floor(inactiveMs / 60_000),
  };
}

export function useOpenCodeStallClock(enabled: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    const interval = setInterval(() => setNowMs(Date.now()), STALL_CLOCK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [enabled]);

  return enabled ? Math.max(nowMs, Date.now()) : nowMs;
}
