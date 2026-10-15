import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeClient } from "../src/core/client.js";
import { APP_VERSION, PROTOCOL_VERSION } from "../src/core/constants.js";
import { nullLogger } from "../src/core/logger.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { SHUTDOWN_DEADLINE_MS, watchParent } from "../src/mcp/server-lifecycle.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

/** AB-385: a retired stdio server must leave within this budget (graceful shutdown deadline plus process exit). */
const EXIT_BUDGET_MS = SHUTDOWN_DEADLINE_MS + 2_000;
const SERVER = join(import.meta.dirname, "..", "plugins", "claude", "dist", "server.mjs");

let env: TestEnv;
/** Only processes this test started; nothing else is ever signalled. */
const started: ChildProcess[] = [];
const clients: Client[] = [];
const rawClients: BridgeClient[] = [];

beforeEach(() => { env = makeEnv(); });
afterEach(async () => {
  for (const c of rawClients.splice(0)) c.close();
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  for (const child of started.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill();
  await env.cleanup();
});

function serverEnv(name: string): Record<string, string> {
  return { ...process.env, AGENT_BRIDGE_HOME: env.home, AGENT_BRIDGE_NAME: name, AGENT_BRIDGE_DELIVERY: "hooks", AGENT_BRIDGE_WAKE_ON_DIRECT: "off",
    AGENT_BRIDGE_AUTO_WAKE: "off", AGENT_BRIDGE_DASHBOARD: "off", AGENT_BRIDGE_DELEGATE_DEPTH: "0" } as Record<string, string>;
}
const logText = () => { try { return readFileSync(join(env.home, "logs", "agent-bridge.log"), "utf8"); } catch { return ""; } };
const logged = (pid: number, text: string) => logText().split(/\r?\n/).some((line) => line.includes(`pid=${pid} `) && line.includes(text));
const running = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function exitsWithin(pid: number, budgetMs: number): Promise<number> {
  const startedAt = Date.now();
  await until(() => !running(pid), budgetMs, 50);
  return Date.now() - startedAt;
}

describe.skipIf(!existsSync(SERVER))("AB-385 stale MCP servers exit", () => {
  it("exits within budget when stdin closes while it hosts the broker, and queued mail survives the handover", async () => {
    const child = spawn(process.execPath, [SERVER, "--agent=other"], { cwd: env.home, env: serverEnv("old-srv"), stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    started.push(child);
    child.stdout!.resume();
    const pid = child.pid!;
    await until(() => logged(pid, '"isBroker":true'), 30_000, 50);

    const watcher = env.node("watcher", "other");
    await watcher.start();
    expect(watcher.isBroker).toBe(false);
    await watcher.send({ to: "later", body: "queued before the reload" });

    // The host drops the server's stdin (a reload that does close it): the server must not linger as the broker.
    child.stdin!.end();
    const took = await exitsWithin(pid, EXIT_BUDGET_MS);
    expect(took).toBeLessThan(EXIT_BUDGET_MS);
    expect(logged(pid, '"reason":"stdin ended"')).toBe(true);

    // A remaining server takes the broker over; the queued mail is still delivered.
    await until(() => watcher.isConnected && watcher.isBroker, 10_000);
    const later = env.node("later", "other");
    await later.start();
    await until(() => later.unread().length === 1);
    expect(later.unread()[0]!.body).toBe("queued before the reload");
  });

  async function oldServerWithSession(sessionId: string) {
    const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER, "--agent=other"], cwd: env.home, env: serverEnv("old-srv"), stderr: "ignore" });
    const client = new Client({ name: "ab385", version: "1" });
    clients.push(client);
    await client.connect(transport);
    const pid = transport.pid!;
    await until(() => logged(pid, '"isBroker":true'), 30_000, 50);
    await client.callTool({ name: "hook_event", arguments: { event: "Stop", session_id: sessionId } });
    const watcher = env.node("watcher", "other");
    await watcher.start();
    let registered = false;
    const deadline = Date.now() + 5_000;
    while (!(registered = (await watcher.peers()).some((p) => p.name === "old-srv" && p.sessionId === sessionId)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(registered).toBe(true);
    return { pid, watcher };
  }

  /** Registers like a server of another plugin version for the same session (what /reload-plugins starts). */
  async function registerReplacement(sessionId: string, version: string): Promise<void> {
    const raw = await BridgeClient.connect(env.pipe, nullLogger);
    rawClients.push(raw);
    await raw.request("hello", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(env.home), peer: { id: `replacement-${version}`, name: "old-srv", agent: "other",
      cwd: env.home, pid: process.pid, agentPid: null, sessionId, startedAt: Date.now(), autoWake: false, version } });
  }

  it("an older server yields and exits when a newer version registers for its session, though its stdin stays open", async () => {
    const { pid, watcher } = await oldServerWithSession("session-ab385");
    await watcher.send({ to: "absent", body: "mail kept across the yield" });
    await registerReplacement("session-ab385", "999.0.0");
    const took = await exitsWithin(pid, EXIT_BUDGET_MS);
    expect(took).toBeLessThan(EXIT_BUDGET_MS);
    expect(logged(pid, "replaced by newer server v999.0.0")).toBe(true);
    await until(() => watcher.isConnected && watcher.isBroker, 10_000);
    const absent = env.node("absent", "other");
    await absent.start();
    await until(() => absent.unread().length === 1);
    expect(absent.unread()[0]!.body).toBe("mail kept across the yield");
  });

  it("a same-version replacement keeps the reclaim path: the server stays", async () => {
    const { pid } = await oldServerWithSession("session-same");
    await registerReplacement("session-same", APP_VERSION);
    await until(() => logged(pid, "replaced by a newer server of this session"), 10_000, 50);
    await new Promise((r) => setTimeout(r, 1_500));
    expect(running(pid)).toBe(true);
    expect(logged(pid, "shutting down")).toBe(false);
  });
});

describe("AB-385 parent watchdog against a real process", () => {
  it("reports a parent that has exited", async () => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore", windowsHide: true });
    started.push(child);
    const pid = child.pid!;
    await new Promise((r) => child.once("exit", r));
    const reasons: string[] = [];
    const stop = watchParent({ ppid: pid, identity: Promise.resolve(null), onGone: (r) => reasons.push(r), checkMs: 20, currentPpid: () => pid });
    try {
      await until(() => reasons.length > 0, 5_000);
      expect(reasons).toEqual([`parent ${pid} ended`]);
    } finally { stop(); }
  });
});
