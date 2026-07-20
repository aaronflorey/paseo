import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentHooksAreInstalled,
  installAgentHooks,
  resolveAgentHookConfigPath,
  uninstallAgentHooks,
} from "../agent-hook-installer.js";
import { opencodeAgentHookProvider } from "./opencode.js";
import { OPENCODE_PLUGIN_SOURCE } from "./opencode-plugin.js";

const temporaryDirs: string[] = [];
const originalTerminalId = process.env.PASEO_TERMINAL_ID;
const globalWithBun = globalThis as typeof globalThis & { Bun?: BunStub };
const originalBun = globalWithBun.Bun;
let moduleSequence = 0;

interface SpawnOptions {
  stdin: "ignore";
  stdout: "ignore";
  stderr: "ignore";
}

interface BunStub {
  spawn: (argv: string[], options: SpawnOptions) => { exited: Promise<unknown> };
}

interface TerminalActivityHooks {
  event: (input: { event: unknown }) => Promise<void>;
}

function setTerminalId(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.PASEO_TERMINAL_ID;
    return;
  }
  process.env.PASEO_TERMINAL_ID = value;
}

async function loadTerminalActivityHooks(): Promise<TerminalActivityHooks> {
  const directory = createTempDir("paseo-opencode-plugin-module-");
  const modulePath = join(directory, `terminal-activity-${moduleSequence}.mjs`);
  moduleSequence += 1;
  writeFileSync(modulePath, OPENCODE_PLUGIN_SOURCE, "utf8");
  const moduleUrl = `${pathToFileURL(modulePath).href}?test=${moduleSequence}`;
  const imported = (await import(moduleUrl)) as { default?: unknown };
  if (typeof imported.default !== "function") {
    throw new Error("Generated terminal-activity plugin did not export its factory");
  }
  return (await imported.default()) as TerminalActivityHooks;
}

afterEach(() => {
  setTerminalId(originalTerminalId);
  if (originalBun === undefined) {
    delete globalWithBun.Bun;
  } else {
    globalWithBun.Bun = originalBun;
  }
  vi.restoreAllMocks();
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirs.push(dir);
  return dir;
}

describe("OpenCode terminal agent hooks", () => {
  it("installs a self-contained OpenCode plugin idempotently", () => {
    const configDir = createTempDir("paseo-opencode-config-");

    const firstInstall = installAgentHooks(opencodeAgentHookProvider, { configDir });
    const secondInstall = installAgentHooks(opencodeAgentHookProvider, { configDir });

    expect(firstInstall.configPath).toBe(join(configDir, "plugins", "paseo-terminal-activity.js"));
    expect(firstInstall.changed).toBe(true);
    expect(secondInstall.changed).toBe(false);
    expect(readFileSync(firstInstall.configPath, "utf8")).toBe(OPENCODE_PLUGIN_SOURCE);
    expect(agentHooksAreInstalled(opencodeAgentHookProvider, { configDir })).toBe(true);
  });

  it("writes the plugin that maps OpenCode bus events to paseo hook events", () => {
    const configDir = createTempDir("paseo-opencode-config-source-");
    const { configPath } = installAgentHooks(opencodeAgentHookProvider, { configDir });
    const source = readFileSync(configPath, "utf8");

    expect(source).toContain('busy: "session.status.busy"');
    expect(source).toContain('retry: "session.status.retry"');
    expect(source).toContain('idle: "session.status.idle"');
    expect(source).toContain('event?.type === "permission.asked"');
    expect(source).toContain('event?.type === "permission.replied"');
    expect(source).toContain('Bun.spawn(["paseo", "hooks", "opencode", event]');
    expect(source).toContain("PASEO_TERMINAL_ID");
  });

  it("uninstalls the OpenCode plugin file", () => {
    const configDir = createTempDir("paseo-opencode-config-uninstall-");
    const configPath = resolveAgentHookConfigPath(opencodeAgentHookProvider, { configDir });
    installAgentHooks(opencodeAgentHookProvider, { configDir });

    const result = uninstallAgentHooks(opencodeAgentHookProvider, { configDir });

    expect(result).toEqual({ configPath, changed: true });
    expect(existsSync(configPath)).toBe(false);
    expect(agentHooksAreInstalled(opencodeAgentHookProvider, { configDir })).toBe(false);
  });

  it("prefers OPENCODE_CONFIG_DIR over the XDG config home", () => {
    const homeDir = createTempDir("paseo-home-");
    const configDir = createTempDir("paseo-opencode-override-");
    const xdgConfigHome = createTempDir("paseo-xdg-config-");

    const configPath = resolveAgentHookConfigPath(opencodeAgentHookProvider, {
      env: { OPENCODE_CONFIG_DIR: configDir, XDG_CONFIG_HOME: xdgConfigHome },
      homeDir,
    });

    expect(configPath).toBe(join(configDir, "plugins", "paseo-terminal-activity.js"));
  });

  it("uses the XDG config home for the default OpenCode config dir", () => {
    const homeDir = createTempDir("paseo-home-");
    const xdgConfigHome = createTempDir("paseo-xdg-config-");

    const configPath = resolveAgentHookConfigPath(opencodeAgentHookProvider, {
      env: { XDG_CONFIG_HOME: xdgConfigHome },
      homeDir,
    });

    expect(configPath).toBe(
      join(xdgConfigHome, "opencode", "plugins", "paseo-terminal-activity.js"),
    );
  });

  it("falls back to the home .config OpenCode dir without an XDG config home", () => {
    const homeDir = createTempDir("paseo-home-");

    const configPath = resolveAgentHookConfigPath(opencodeAgentHookProvider, {
      env: {},
      homeDir,
    });

    expect(configPath).toBe(
      join(homeDir, ".config", "opencode", "plugins", "paseo-terminal-activity.js"),
    );
  });

  it.each([
    ["session.status.busy", "running"],
    ["session.status.retry", "running"],
    ["session.status.idle", "idle"],
    ["permission.asked", "needs-input"],
    ["permission.replied", "running"],
  ] as const)("maps %s to %s", async (event, state) => {
    await expect(
      opencodeAgentHookProvider.resolveActivity({
        event,
        input: { read: async () => null },
      }),
    ).resolves.toBe(state);
  });
});

describe.sequential("generated OpenCode terminal-activity plugin", () => {
  it("imports exact source and spawns one ignored-stdio hook per mapped event", async () => {
    setTerminalId("terminal-1");
    const spawn = vi
      .fn<BunStub["spawn"]>()
      .mockImplementation(() => ({ exited: Promise.resolve(0) }));
    globalWithBun.Bun = { spawn };
    const hooks = await loadTerminalActivityHooks();
    expect(Object.keys(hooks)).toEqual(["event"]);

    const mappedEvents = [
      [{ type: "session.status", properties: { status: { type: "busy" } } }, "session.status.busy"],
      [
        { type: "session.status", properties: { status: { type: "retry" } } },
        "session.status.retry",
      ],
      [{ type: "session.status", properties: { status: { type: "idle" } } }, "session.status.idle"],
      [{ type: "permission.asked" }, "permission.asked"],
      [{ type: "permission.replied" }, "permission.replied"],
    ] as const;

    for (const [event] of mappedEvents) {
      await hooks.event({ event });
    }

    const spawnOptions: SpawnOptions = {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    };
    expect(spawn.mock.calls).toEqual(
      mappedEvents.map(([, event]) => [["paseo", "hooks", "opencode", event], spawnOptions]),
    );
  });

  it("does not spawn without a terminal ID or for unmapped events", async () => {
    const spawn = vi
      .fn<BunStub["spawn"]>()
      .mockImplementation(() => ({ exited: Promise.resolve(0) }));
    globalWithBun.Bun = { spawn };
    const hooks = await loadTerminalActivityHooks();

    delete process.env.PASEO_TERMINAL_ID;
    await hooks.event({
      event: { type: "session.status", properties: { status: { type: "busy" } } },
    });

    setTerminalId("terminal-1");
    for (const event of [
      { type: "session.status", properties: { status: { type: "unknown" } } },
      { type: "permission.rejected" },
      { type: "server.connected" },
      null,
    ]) {
      await hooks.event({ event });
    }

    expect(spawn).not.toHaveBeenCalled();
  });

  it("swallows synchronous spawn failures", async () => {
    setTerminalId("terminal-1");
    const spawn = vi.fn<BunStub["spawn"]>(() => {
      throw new Error("spawn unavailable");
    });
    globalWithBun.Bun = { spawn };
    const hooks = await loadTerminalActivityHooks();

    await expect(hooks.event({ event: { type: "permission.asked" } })).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("swallows asynchronous child-exit failures", async () => {
    setTerminalId("terminal-1");
    const spawn = vi
      .fn<BunStub["spawn"]>()
      .mockImplementation(() => ({ exited: Promise.reject(new Error("child failed")) }));
    globalWithBun.Bun = { spawn };
    const hooks = await loadTerminalActivityHooks();

    await expect(hooks.event({ event: { type: "permission.replied" } })).resolves.toBeUndefined();
    await Promise.resolve();
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
