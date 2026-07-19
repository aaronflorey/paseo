import { once } from "node:events";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { CrushHttpClient } from "./http-client.js";

interface TestServer {
  url: string;
  close(): Promise<void>;
}

const servers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<TestServer> {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind TCP");
  const result = {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
  servers.push(result);
  return result;
}

describe("CrushHttpClient", () => {
  test("parses split SSE frames and ignores malformed events", async () => {
    let streamResponse: ServerResponse | null = null;
    const server = await listen((request, response) => {
      if (request.url?.includes("/events")) {
        streamResponse = response;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.flushHeaders();
      }
    });
    const client = new CrushHttpClient(server.url, createTestLogger());
    const events: unknown[] = [];
    const stream = client.openEvents("workspace-1", "client-1", (event) => events.push(event));
    await stream.ready;

    streamResponse?.write('data: {"type":"message","payload":{"type":"updated",');
    streamResponse?.write(
      '"payload":{"id":"m1","role":"assistant","session_id":"s1","parts":[{"type":"text","data":{"text":"Hi"}}],"model":"m","provider":"p","created_at":1,"updated_at":1}}}\r\n\r\n',
    );
    streamResponse?.write("data: not-json\n\n");

    await expect.poll(() => events.length).toBe(1);
    expect(events[0]).toMatchObject({
      type: "message",
      event: { payload: { id: "m1", parts: [{ type: "text", data: { text: "Hi" } }] } },
    });
    await stream.close();
  });

  test("includes the client UUID when selecting the native current session", async () => {
    let resolveObserved!: (value: { url?: string; body?: unknown }) => void;
    const observed = new Promise<{ url?: string; body?: unknown }>((resolve) => {
      resolveObserved = resolve;
    });
    const server = await listen((request, response) => {
      void captureJsonRequest(request, response).then(resolveObserved);
    });
    const client = new CrushHttpClient(server.url, createTestLogger());

    await client.setCurrentSession("workspace-1", "client-uuid", "session-1");

    await expect(observed).resolves.toEqual({
      url: "/v1/workspaces/workspace-1/current-session?client_id=client-uuid",
      body: { session_id: "session-1" },
    });
  });

  test("reports missing routes as an actionable Crush upgrade error", async () => {
    const server = await listen((_request, response) => {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
    });
    const client = new CrushHttpClient(server.url, createTestLogger());

    await expect(client.listSkills("workspace-1")).rejects.toThrow(
      /installed Crush server API is incompatible; update Crush/iu,
    );
    await expect(client.assertRequiredRoutes()).rejects.toThrow(/missing required API route/iu);
  });

  test("validates required response fields while accepting unknown ones", async () => {
    let valid = true;
    const server = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(valid ? { version: "v0.85.0", future: true } : { future: true }));
    });
    const client = new CrushHttpClient(server.url, createTestLogger());

    await expect(client.version()).resolves.toMatchObject({ version: "v0.85.0", future: true });
    valid = false;
    await expect(client.version()).rejects.toThrow();
  });
});

async function readRequestJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
}

function captureJsonRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<{ url?: string; body?: unknown }> {
  return readRequestJson(request).then((body) => {
    response.writeHead(200).end();
    return { url: request.url, body };
  });
}
