import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BridgeNode } from "../src/core/node.js";
import { nullLogger } from "../src/core/logger.js";
import { inspectClaudeLaunch } from "../src/core/procinfo.js";
import { startServer } from "../src/mcp/server.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

// Exercise the real MCP server/tools and real broker RPCs without owning test-runner stdio.
let serverTransport: InMemoryTransport, clientTransport: InMemoryTransport;
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {
  constructor() { return serverTransport; }
} }));
vi.mock("../src/core/procinfo.js", async original => ({
  ...await original<typeof import("../src/core/procinfo.js")>(), inspectClaudeLaunch: vi.fn(),
}));
vi.mock("../src/core/config.js", async original => ({
  ...await original<typeof import("../src/core/config.js")>(), watchConfig: vi.fn(() => () => {}),
}));
vi.mock("../src/mcp/rewake.js", async original => ({
  ...await original<typeof import("../src/mcp/rewake.js")>(), RewakeEndpoint: class {
    async start() { throw new Error("fixture has no wake endpoint"); }
  },
}));
vi.mock("../src/mcp/job-runner-errors.js", async original => ({
  ...await original<typeof import("../src/mcp/job-runner-errors.js")>(), guardServerErrors: vi.fn(),
}));
vi.mock("../src/core/logger.js", async original => {
  const actual = await original<typeof import("../src/core/logger.js")>();
  return { ...actual, createLogger: () => actual.nullLogger };
});
const launch = { print: true, interactive: false, channel: true };
let env: TestEnv, client: Client, serverNode: BridgeNode | undefined;
let exits: ReturnType<typeof vi.spyOn>;
let listeners: Map<string, Function[]>;
beforeEach(() => {
  env = makeEnv();
  for (const [key, value] of Object.entries({ AGENT_BRIDGE_HOME: env.home, CLAUDE_PROJECT_DIR: env.home,
    AGENT_BRIDGE_NAME: "startup", AGENT_BRIDGE_AGENT: "claude", AGENT_BRIDGE_DASHBOARD: "off", AGENT_BRIDGE_JOB_RUNNER: "0",
    AGENT_BRIDGE_AUTO_WAKE: "off", AGENT_BRIDGE_WAKE_ON_DIRECT: "on", AGENT_BRIDGE_DELIVERY: "auto" })) vi.stubEnv(key, value);
  const [local, remote] = InMemoryTransport.createLinkedPair();
  serverTransport = remote;
  client = new Client({ name: "startup-test", version: "1" });
  clientTransport = local;
  exits = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  listeners = new Map(["SIGINT", "SIGTERM", "end"].map(event => [event,
    [...(event === "end" ? process.stdin : process).listeners(event)]]));
  const connect = BridgeNode.prototype.ensureConnected;
  vi.spyOn(BridgeNode.prototype, "ensureConnected").mockImplementation(function (this: BridgeNode) {
    if (this.name === "startup") serverNode = this;
    return connect.call(this);
  });
});
afterEach(async () => {
  // Invoke only this server's own shutdown listener, which clears its interval and resources.
  const shutdown = process.listeners("SIGTERM").find(fn => !listeners.get("SIGTERM")!.includes(fn));
  const previousExits = exits.mock.calls.length;
  shutdown?.("SIGTERM");
  if (shutdown) await until(() => exits.mock.calls.length > previousExits);
  await client.close();
  await serverNode?.stop(); serverNode = undefined;
  for (const [event, previous] of listeners) {
    const target = event === "end" ? process.stdin : process;
    for (const fn of target.listeners(event)) if (!previous.includes(fn)) target.removeListener(event, fn as never);
  }
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await env.cleanup();
});

it.each([
  { failure: "timeout", recovery: "update" },
  { failure: "rejection", recovery: "update" },
  { failure: "rejection", recovery: "connect" },
])("keeps startup alive after an updatePeer $failure and carries policy on the next $recovery", async ({ failure, recovery }) => {
  const host = env.node("host"); await host.start();
  let finishLaunch!: () => void;
  vi.mocked(inspectClaudeLaunch).mockImplementation(() => new Promise(resolve => {
    finishLaunch = () => resolve(launch);
  }));
  const warn = vi.spyOn(nullLogger, "warn");
  let entered = false, release!: () => void;
  const stalled = new Promise<void>(resolve => { release = resolve; });
  const broker = (host as any).broker, original = broker.handlers.updatePeer;
  let calls = 0;
  broker.handlers.updatePeer = async (connection: any, args: unknown) => {
    if (connection.peer?.name === "startup") {
      calls++;
      if (calls === 1) {
        entered = true;
        if (failure === "timeout") await stalled;
        throw new Error("fixture refused startup update");
      }
    }
    return original(connection, args);
  };
  const starting = startServer(["--agent=claude"]);
  // Attach the rejection handler immediately so the regression reports as an assertion failure.
  const outcome = starting.then(() => "started", error => String(error));
  try {
    await until(() => Boolean(finishLaunch));
    await client.connect(clientTransport);
    const early = await client.callTool({ name: "peers", arguments: {} });
    expect(early.isError).not.toBe(true);
    expect(serverNode?.isConnected).toBe(true);
    finishLaunch();
    await until(() => entered);
    expect((await client.callTool({ name: "peers", arguments: {} })).isError).not.toBe(true);
    expect(await outcome).toBe("started");
    expect(warn).toHaveBeenCalledWith(
      "startup wake policy update failed; retained locally for the next peer update or connection",
      { err: failure === "timeout" ? "broker request timed out: updatePeer" : "fixture refused startup update" });
    expect(exits).not.toHaveBeenCalled();
    expect(calls).toBe(1); // No retry loop after the failed RPC.
    expect((await host.peers()).find(peer => peer.name === "startup")?.wakeAvailable).toBe(false);
    release();
    if (recovery === "update") {
      await serverNode!.setAutoWake(true); // An ordinary update carries the retained policy.
      expect(calls).toBe(2);
    } else {
      const reconnected = new Promise<void>(resolve => serverNode!.once("connected", () => resolve()));
      (serverNode as any).client.close();
      await reconnected; // The existing reconnect/hello path carries the policy without another update.
      expect(calls).toBe(1);
    }
    expect((await host.peers()).find(peer => peer.name === "startup")).toMatchObject({
      wakeOnDirect: true, wakeAvailable: true, autoWake: recovery === "update",
    });
    expect((await client.callTool({ name: "peers", arguments: {} })).isError).not.toBe(true);
  } finally { release(); warn.mockRestore(); }
});

it("still exits through main for a fatal launch inspection error", async () => {
  vi.mocked(inspectClaudeLaunch).mockRejectedValue(new Error("fatal launch inspection"));
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  await import("../src/mcp/main.js");
  await until(() => exits.mock.calls.length > 0);
  expect(exits).toHaveBeenCalledWith(1);
  expect(stderr.mock.calls.map(call => String(call[0])).join("")).toContain("fatal launch inspection");
});
