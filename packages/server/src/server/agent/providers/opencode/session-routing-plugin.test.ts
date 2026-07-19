import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

import {
  OPENCODE_SESSION_ROUTING_PLUGIN_SOURCE,
  resolveOpenCodeSharedServerEnv,
} from "./session-routing-plugin.js";
import { openCodeSessionContextBridge } from "./session-context.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await openCodeSessionContextBridge.close();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("resolveOpenCodeSharedServerEnv", () => {
  test("preserves inline config and adds the Paseo session-routing plugin", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "paseo-opencode-routing-"));
    temporaryDirectories.push(homeDir);
    const existingPlugin = pathToFileURL(path.join(homeDir, "existing.js")).href;

    const env = await resolveOpenCodeSharedServerEnv({
      homeDir,
      configContent: JSON.stringify({ theme: "system", plugin: [existingPlugin] }),
    });

    expect(env.PASEO_OPENCODE_SESSION_CONTEXT_URL).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/session-context$/,
    );
    expect(env.PASEO_OPENCODE_SESSION_CONTEXT_TOKEN).toBeTruthy();
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
    const routingPlugin = pathToFileURL(path.join(homeDir, "paseo-session-routing-plugin.js")).href;
    expect(config).toEqual({
      theme: "system",
      plugin: [existingPlugin, routingPlugin],
    });
    expect(await readFile(path.join(homeDir, "paseo-session-routing-plugin.js"), "utf8")).toBe(
      OPENCODE_SESSION_ROUTING_PLUGIN_SOURCE,
    );
  });

  test("rejects invalid inline config instead of replacing it", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "paseo-opencode-routing-"));
    temporaryDirectories.push(homeDir);

    await expect(
      resolveOpenCodeSharedServerEnv({ homeDir, configContent: "{invalid" }),
    ).rejects.toThrow("OPENCODE_CONFIG_CONTENT must be valid JSON");
  });
});
