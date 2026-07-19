import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { writeFileAtomic } from "../../../atomic-file.js";
import {
  OPENCODE_SESSION_CONTEXT_TOKEN_ENV,
  OPENCODE_SESSION_CONTEXT_URL_ENV,
  OPENCODE_SESSION_ID_TOOL_ARGUMENT,
  openCodeSessionContextBridge,
} from "./session-context.js";

const PLUGIN_FILENAME = "paseo-session-routing-plugin.js";

export const OPENCODE_SESSION_ROUTING_PLUGIN_SOURCE = String.raw`
const SESSION_ID_ARGUMENT = ${JSON.stringify(OPENCODE_SESSION_ID_TOOL_ARGUMENT)}
const CONTEXT_URL_ENV = ${JSON.stringify(OPENCODE_SESSION_CONTEXT_URL_ENV)}
const CONTEXT_TOKEN_ENV = ${JSON.stringify(OPENCODE_SESSION_CONTEXT_TOKEN_ENV)}
const CONTEXT_URL = process.env[${JSON.stringify(OPENCODE_SESSION_CONTEXT_URL_ENV)}]
const CONTEXT_TOKEN = process.env[${JSON.stringify(OPENCODE_SESSION_CONTEXT_TOKEN_ENV)}]

const isPaseoTool = (tool) => tool.startsWith("paseo:") || tool.startsWith("paseo_")

export const PaseoSessionRoutingPlugin = async () => ({
  "tool.execute.before": async (input, output) => {
    if (isPaseoTool(input.tool) && output.args && typeof output.args === "object") {
      output.args[SESSION_ID_ARGUMENT] = input.sessionID
    }
  },
  "shell.env": async (input, output) => {
    delete output.env[CONTEXT_URL_ENV]
    delete output.env[CONTEXT_TOKEN_ENV]
    if (!CONTEXT_URL || !CONTEXT_TOKEN || !input.sessionID) return
    const url = new URL(CONTEXT_URL)
    url.searchParams.set("sessionId", input.sessionID)
    const response = await fetch(url, {
      headers: { authorization: "Bearer " + CONTEXT_TOKEN },
    })
    if (response.status === 404) return
    if (!response.ok) {
      throw new Error("Paseo session context request failed with status " + response.status)
    }
    const context = await response.json()
    if (context && context.env && typeof context.env === "object") {
      Object.assign(output.env, context.env)
    }
  },
})
`.trimStart();

export async function resolveOpenCodeSharedServerEnv(options: {
  homeDir: string;
  configContent?: string;
}): Promise<Record<string, string>> {
  const config = parseInlineConfig(options.configContent);
  const bridge = await openCodeSessionContextBridge.start();
  const pluginPath = path.join(options.homeDir, PLUGIN_FILENAME);
  await writeFileIfChanged(pluginPath, OPENCODE_SESSION_ROUTING_PLUGIN_SOURCE);

  const pluginUrl = pathToFileURL(pluginPath).href;
  const plugins = Array.isArray(config.plugin) ? config.plugin : [];
  if (!plugins.includes(pluginUrl)) {
    config.plugin = [...plugins, pluginUrl];
  }

  return {
    [OPENCODE_SESSION_CONTEXT_URL_ENV]: bridge.url,
    [OPENCODE_SESSION_CONTEXT_TOKEN_ENV]: bridge.token,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  };
}

function parseInlineConfig(content: string | undefined): Record<string, unknown> {
  if (!content?.trim()) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error("OpenCode OPENCODE_CONFIG_CONTENT must be valid JSON for Paseo integration", {
      cause: error,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OpenCode OPENCODE_CONFIG_CONTENT must contain a JSON object");
  }
  const config = parsed as Record<string, unknown>;
  if (config.plugin !== undefined && !Array.isArray(config.plugin)) {
    throw new Error("OpenCode OPENCODE_CONFIG_CONTENT plugin must be an array");
  }
  return config;
}

async function writeFileIfChanged(filePath: string, content: string): Promise<void> {
  try {
    if ((await readFile(filePath, "utf8")) === content) {
      return;
    }
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") {
      throw error;
    }
  }
  await writeFileAtomic(filePath, content);
}
