import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, loadConfig } from "../src/core/config.js";
import { BridgeNode, type BridgeNodeOptions } from "../src/core/node.js";
import { BridgeClient } from "../src/core/client.js";
import { PROTOCOL_VERSION } from "../src/core/constants.js";
import { nullLogger } from "../src/core/logger.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { startUi } from "../src/cli/ui.js";
import type { DashboardHostOptions } from "../src/cli/dashboard.js";
import { makeEnv, type TestEnv } from "./helpers.js";

// Stop production hosts at their actual constructor, before session handlers or transports start.
const interception = vi.hoisted(() => ({ capture: null as ((opts: BridgeNodeOptions) => never) | null,
  dashboard: null as ((opts: DashboardHostOptions) => never) | null, stop: new Error("constructor captured") }));
vi.mock("../src/core/node.js", async original => {
  const actual = await original<typeof import("../src/core/node.js")>();
  return { ...actual, BridgeNode: class extends actual.BridgeNode {
    constructor(opts: BridgeNodeOptions) {
      if (interception.capture) interception.capture(opts);
      super(opts);
    }
  } };
});
vi.mock("../src/cli/dashboard.js", async original => {
  const actual = await original<typeof import("../src/cli/dashboard.js")>();
  return { ...actual, DashboardController: class extends actual.DashboardController {
    constructor(opts: DashboardHostOptions) {
      if (interception.dashboard) interception.dashboard(opts);
      super(opts);
    }
  } };
});

let env: TestEnv;
let ui: Awaited<ReturnType<typeof startUi>> | undefined;
const nodes: BridgeNode[] = [];
beforeEach(() => {
  env = makeEnv();
  vi.stubEnv("AGENT_BRIDGE_HOME", env.home);
  vi.stubEnv("AGENT_BRIDGE_PIPE", env.pipe);
  vi.stubEnv("CLAUDE_PROJECT_DIR", env.home);
  vi.stubEnv("AGENT_BRIDGE_DAEMON", undefined);
});
afterEach(async () => {
  interception.capture = null;
  interception.dashboard = null;
  await ui?.close(); ui = undefined;
  await Promise.all(nodes.splice(0).map(node => node.stop()));
  await env.cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function configure(value: unknown): void {
  writeFileSync(join(env.home, "config.json"), JSON.stringify(value));
}
function node(daemon?: BridgeNodeOptions["daemon"]): BridgeNode {
  const result = new BridgeNode({ pipePath: env.pipe, dbPath: env.db, token: loadOrCreateToken(env.home),
    agent: "other", name: "activation-test", cwd: env.home, autoWake: false, log: nullLogger, daemon });
  nodes.push(result);
  return result;
}

describe("daemon activation contract", () => {
  it.each([
    [{}, undefined, false],
    [{ daemon: { enabled: false } }, undefined, false],
    [{ daemon: { enabled: true } }, undefined, true],
    [{}, "1", true],
    [{ daemon: { enabled: true } }, "0", false],
    [{ daemon: { enabled: false } }, "1", true],
    [{ daemon: { enabled: "true" } }, undefined, false],
    [{ daemon: { enabled: true } }, "false", true],
    [{}, "true", false],
    [{ daemon: { enabled: true }, codex: { daemon: { enabled: false } } }, undefined, false],
  ])("resolves config %j with env %s to %s", (config, override, enabled) => {
    configure(config);
    expect(DEFAULT_CONFIG.daemon.enabled).toBe(false);
    expect(loadConfig(env.home, "codex", nullLogger, { AGENT_BRIDGE_DAEMON: override }).daemon.enabled).toBe(enabled);
  });

  it.each(["default", "false"])("%s activation uses the embedded broker", async mode => {
    if (mode === "false") configure({ daemon: { enabled: false } });
    const cfg = loadConfig(env.home, "other", nullLogger);
    const launch = vi.fn<NonNullable<NonNullable<BridgeNodeOptions["daemon"]>["launch"]>>();
    const host = node(cfg.daemon.enabled ? { cli: "unused", launch } : undefined);
    await host.start();
    expect(host.isBroker).toBe(true);
    expect(host.isConnected).toBe(true);
    expect(launch).not.toHaveBeenCalled();
    expect((await host.peers()).some(peer => peer.name === host.name)).toBe(true);
  });

  it.each(["config", "env"])("%s opt-in enters the existing daemon launch path", async mode => {
    if (mode === "config") configure({ daemon: { enabled: true } });
    else vi.stubEnv("AGENT_BRIDGE_DAEMON", "1");
    // Replace only process creation: readiness still uses the real authenticated broker connection.
    const daemonHost = env.node("fixture-daemon", "other");
    const launch = vi.fn(async () => { await daemonHost.start(); return { kind: "created" as const }; });
    const cfg = loadConfig(env.home, "other", nullLogger);
    const client = node(cfg.daemon.enabled ? { cli: "fixture-cli.mjs", launch } : undefined);
    await client.start();
    expect(launch).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ cli: "fixture-cli.mjs", home: env.home, pipe: env.pipe }));
    expect(client.isBroker).toBe(false);
    expect(client.isConnected).toBe(true);
  });

  it("the CLI UI can host by default without a daemon or compatibility flag", async () => {
    ui = await startUi({ home: env.home, pipe: env.pipe, port: 0, log: nullLogger });
    const first = await fetch(ui.url, { redirect: "manual" });
    const cookie = first.headers.get("set-cookie")!.split(";")[0]!;
    const response = await fetch(new URL("/api/send", ui.url), { method: "POST",
      headers: { cookie, "x-agent-bridge": "1", "content-type": "application/json" },
      body: JSON.stringify({ to: "codex-offline-fixture", body: "queued by the default UI host" }) });
    expect(response.status).toBe(200);
    const client = await BridgeClient.connect(env.pipe, nullLogger);
    try {
      expect((await client.request("ping", {})).brokerPid).toBe(process.pid);
      await client.request("auth", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(env.home) });
      expect((await client.request("peers", {})).length).toBeGreaterThan(0);
    } finally { client.close(); }
  });
});

describe("production constructors", () => {
  it.each([
    [{}, undefined, false],
    [{ daemon: { enabled: false } }, undefined, false],
    [{ daemon: { enabled: true } }, undefined, true],
    [{}, "1", true],
    [{ daemon: { enabled: true } }, "0", false],
    [{ daemon: { enabled: false } }, "1", true],
  ])("MCP and CLI use config %j / env %s (daemon=%s)", async (config, override, enabled) => {
    configure(config);
    vi.stubEnv("AGENT_BRIDGE_DAEMON", override);
    const captured: BridgeNodeOptions[] = [];
    interception.capture = opts => { captured.push(opts); throw interception.stop; };
    const { startServer } = await import("../src/mcp/server.js");
    await expect(startServer(["--agent=other"])).rejects.toBe(interception.stop);
    expect(captured).toHaveLength(1);
    expect(Boolean(captured[0]!.daemon)).toBe(enabled);
    expect(captured[0]!.canHostBroker).not.toBe(false);

    // CLI is an executable entrypoint: capture its constructor and its normal error exit.
    vi.resetModules();
    const argv = process.argv;
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.argv = [process.execPath, "cli.mjs", "send", "some-peer", "fixture"];
    try {
      await import("../src/cli/main.js");
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    } finally { process.argv = argv; }
    expect(captured).toHaveLength(2);
    expect(Boolean(captured[1]!.daemon)).toBe(enabled);
    expect(captured[1]!.canHostBroker).not.toBe(false);
    for (const opts of captured) if (enabled) {
      expect(opts.daemon!.cli).toMatch(/cli\.mjs$/);
      expect(opts.daemon!.config?.().dashboardPort).toBe(DEFAULT_CONFIG.dashboardPort);
      expect(opts.daemon!.dashboard).toBeTypeOf("function");
    }

    // The CLI UI must receive the same selection through its dashboard controller.
    const dashboards: DashboardHostOptions[] = [];
    interception.dashboard = opts => { dashboards.push(opts); throw interception.stop; };
    exit.mockClear();
    vi.resetModules();
    process.argv = [process.execPath, "cli.mjs", "ui", "--no-open"];
    try {
      await import("../src/cli/main.js");
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    } finally { process.argv = argv; }
    expect(dashboards).toHaveLength(1);
    expect(Boolean(dashboards[0]!.brokerDaemon)).toBe(enabled);
    expect(dashboards[0]!.embeddedCompatibility).toBeUndefined();
  });
});
