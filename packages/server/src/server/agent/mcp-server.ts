import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import {
  getObjectShape,
  normalizeObjectSchema,
  type AnySchema,
  type ZodRawShapeCompat,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { z } from "zod";

import { OPENCODE_SESSION_ID_TOOL_ARGUMENT } from "./providers/opencode/session-context.js";
import { addModelVisibleStructuredContent } from "./tools/paseo-tool-serialization.js";
import { createPaseoToolCatalog, type PaseoToolHostDependencies } from "./tools/paseo-tools.js";
import type { PaseoToolCatalog, PaseoToolConfig, PaseoToolResult } from "./tools/types.js";

export type AgentMcpServerOptions = PaseoToolHostDependencies & {
  sessionCatalogResolver?: (sessionId: string) => PaseoToolCatalog | undefined;
};

type McpToolContext = RequestHandlerExtra<ServerRequest, ServerNotification>;

function toMcpToolResult(result: PaseoToolResult): CallToolResult {
  const modelVisibleResult = addModelVisibleStructuredContent(result);
  return {
    content: modelVisibleResult.content as CallToolResult["content"],
    ...(modelVisibleResult.structuredContent !== undefined
      ? {
          structuredContent:
            modelVisibleResult.structuredContent as CallToolResult["structuredContent"],
        }
      : {}),
    ...(modelVisibleResult.isError !== undefined ? { isError: modelVisibleResult.isError } : {}),
  };
}

export async function createAgentMcpServer(options: AgentMcpServerOptions): Promise<McpServer> {
  const { sessionCatalogResolver, ...hostDependencies } = options;
  const catalog = await createPaseoToolCatalog(hostDependencies);
  const server = new McpServer({
    name: "agent-mcp",
    version: "2.0.0",
  });

  for (const tool of catalog.tools.values()) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: sessionCatalogResolver
          ? createSessionRoutedInputSchema(tool.inputSchema)
          : tool.inputSchema,
      },
      async (args: unknown, context?: McpToolContext) => {
        if (!sessionCatalogResolver) {
          return toMcpToolResult(
            await catalog.executeTool(tool.name, args, { signal: context?.signal }),
          );
        }
        const { sessionId, input } = readSessionRoutedInput(args);
        const routedCatalog = sessionId ? sessionCatalogResolver(sessionId) : undefined;
        const routedTool = routedCatalog?.getTool(tool.name);
        if (!sessionId || !routedCatalog || !routedTool) {
          return toMcpToolResult({
            content: [
              {
                type: "text",
                text: !sessionId
                  ? "OpenCode session identity was missing from the Paseo tool call."
                  : `Paseo tool '${tool.name}' is unavailable for this OpenCode session.`,
              },
            ],
            isError: true,
          });
        }
        return toMcpToolResult(
          await routedCatalog.executeTool(tool.name, input, { signal: context?.signal }),
        );
      },
    );
  }

  return server;
}

function createSessionRoutedInputSchema(
  inputSchema: PaseoToolConfig["inputSchema"],
): z.ZodObject<z.ZodRawShape> {
  const normalized = normalizeObjectSchema(
    inputSchema as AnySchema | ZodRawShapeCompat | undefined,
  );
  const shape = getObjectShape(normalized);
  return z.object((shape ?? {}) as z.ZodRawShape).passthrough();
}

function readSessionRoutedInput(args: unknown): {
  sessionId: string | undefined;
  input: unknown;
} {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { sessionId: undefined, input: args };
  }
  const record = { ...(args as Record<string, unknown>) };
  const rawSessionId = record[OPENCODE_SESSION_ID_TOOL_ARGUMENT];
  delete record[OPENCODE_SESSION_ID_TOOL_ARGUMENT];
  return {
    sessionId:
      typeof rawSessionId === "string" && rawSessionId.trim() ? rawSessionId.trim() : undefined,
    input: record,
  };
}
