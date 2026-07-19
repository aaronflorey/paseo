import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { CrushAgentClient } from "./crush-agent.js";

describe("Crush server provider (real)", () => {
  let available = false;
  const client = new CrushAgentClient(createTestLogger());

  beforeAll(async () => {
    available = await client.isAvailable();
  });

  afterAll(async () => {
    await client.shutdown();
  });

  test("probes the installed server API and discovers native models", async (context) => {
    if (!available) context.skip();
    const cwd = mkdtempSync(path.join(os.tmpdir(), "paseo-crush-real-"));
    try {
      const catalog = await client.fetchCatalog({ scope: "workspace", cwd, force: true });
      expect(catalog.models.length).toBeGreaterThan(0);
      expect(catalog.models.every((model) => model.id.includes("/"))).toBe(true);
      const session = await client.createSession(
        { provider: "crush", cwd, modeId: "ask" },
        undefined,
        { persistSession: false },
      );
      expect((await session.getRuntimeInfo()).sessionId).toBe(session.id);
      await session.close();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 45_000);

  test("streams and resumes a native session when explicitly enabled", async (context) => {
    if (!available || process.env.RUN_CRUSH_REAL_E2E !== "1") context.skip();
    const cwd = mkdtempSync(path.join(os.tmpdir(), "paseo-crush-prompt-real-"));
    try {
      const session = await client.createSession({ provider: "crush", cwd, modeId: "full" });
      const handle = session.describePersistence();
      const result = await session.run("Reply with exactly CRUSH_PASEO_OK.");
      expect(result.finalText).toContain("CRUSH_PASEO_OK");
      await session.close();

      const resumed = await client.resumeSession(handle);
      const history = [];
      for await (const event of resumed.streamHistory()) history.push(event);
      expect(history.some((event) => event.type === "timeline")).toBe(true);
      await resumed.close();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 120_000);
});
