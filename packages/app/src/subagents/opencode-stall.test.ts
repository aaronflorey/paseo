// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  deriveOpenCodeStallState,
  OPENCODE_STALL_THRESHOLD_MS,
  useOpenCodeStallClock,
} from "./opencode-stall";

const START = new Date("2026-07-19T12:00:00.000Z");

describe("OpenCode passive stall warning", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  function state(overrides: Partial<Parameters<typeof deriveOpenCodeStallState>[0]> = {}) {
    return deriveOpenCodeStallState({
      provider: "opencode",
      status: "running",
      lastActivityAt: START.getTime() - OPENCODE_STALL_THRESHOLD_MS,
      ...overrides,
    });
  }

  it("appears exactly at the ten-minute boundary and recalculates in whole minutes", () => {
    expect(
      state({ lastActivityAt: START.getTime() - OPENCODE_STALL_THRESHOLD_MS + 1 }).possiblyStalled,
    ).toBe(false);
    expect(state()).toMatchObject({ possiblyStalled: true, inactiveMinutes: 10 });

    vi.advanceTimersByTime(60_000);
    expect(state()).toMatchObject({ possiblyStalled: true, inactiveMinutes: 11 });
  });

  it("clears immediately when translated activity advances", () => {
    expect(state()).toMatchObject({ possiblyStalled: true });
    expect(state({ lastActivityAt: Date.now() })).toMatchObject({
      possiblyStalled: false,
      inactiveMinutes: 0,
    });
  });

  it("suppresses warnings while permission or question input is pending", () => {
    expect(state({ isWaitingForInput: true })).toMatchObject({
      possiblyStalled: false,
      inactiveMinutes: null,
    });
  });

  it("uses active child activity as effective parent activity", () => {
    expect(state({ childActivityAt: [Date.now() - 30_000] })).toMatchObject({
      possiblyStalled: false,
      inactiveMinutes: 0,
    });
  });

  it("never warns for other providers or terminal statuses", () => {
    expect(state({ provider: "codex" }).possiblyStalled).toBe(false);
    expect(state({ status: "idle" }).possiblyStalled).toBe(false);
  });

  it("returns presentation data only, with no mutation or notification directive", () => {
    expect(Object.keys(state()).sort()).toEqual(["inactiveMinutes", "possiblyStalled"]);
  });

  it("recalculates the presentation clock once per minute", () => {
    const { result } = renderHook(() => useOpenCodeStallClock(true));
    expect(result.current).toBe(START.getTime());

    act(() => vi.advanceTimersByTime(59_999));
    expect(result.current).toBe(START.getTime());
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(START.getTime() + 60_000);
  });
});
