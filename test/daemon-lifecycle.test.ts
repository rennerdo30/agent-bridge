import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeNode } from "../src/core/node.js";
import { BridgeClient } from "../src/core/client.js";
import { PROTOCOL_VERSION } from "../src/core/constants.js";
import { nullLogger } from "../src/core/logger.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { readProcessIdentity } from "../src/core/process-identity.js";
import { startWindowsJobScope, type WindowsJobScope } from "../src/core/windows-job-scope.js";
import { fixtureProcessGeneration, fixtureProcessExists } from "./fixture-process-generation.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

const cli = join(import.meta.dirname, "../plugins/codex/dist/cli.mjs");
let env: TestEnv, nodes: BridgeNode[], children: ChildProcess[], owned: Map<number, string>;
beforeEach(() => {
  env = makeEnv(); nodes = []; children = []; owned = new Map();
  writeFileSync(join(env.home, "config.json"), JSON.stringify({ dashboard: false }));
});
async function client(token = loadOrCreateToken(env.home)) {
  const c = await BridgeClient.connect(env.pipe, nullLogger);
  try { await c.request("auth", { protocol: PROTOCOL_VERSION, token }); return c; }
  catch (error) { c.close(); throw error; }
}
async function remember() {
  const c = await client();
  try {
    const ping = await c.request("ping", {}), identity = await readProcessIdentity(ping.brokerPid);
    expect(identity).toBeTruthy(); owned.set(ping.brokerPid, identity!); return ping.brokerPid;
  } finally { c.close(); }
}
async function stopOwned(pid: number) {
  const identity = owned.get(pid)!;
  if (await fixtureProcessGeneration(pid, identity, "fixture broker identity changed")) process.kill(pid, "SIGTERM");
  await until(() => !fixtureProcessExists(pid, "fixture broker visibility unknown"), 5_000);
  owned.delete(pid);
}
afterEach(async () => {
  await Promise.all(nodes.map(node => node.stop()));
  for (const child of children) { if (child.exitCode === null && child.signalCode === null) { const closed = once(child, "close"); child.kill(); await closed; } }
  for (const pid of owned.keys()) await stopOwned(pid);
  await env.cleanup();
});
function node(name: string, launch?: NonNullable<ConstructorParameters<typeof BridgeNode>[0]["daemon"]>["launch"]) {
  const n = new BridgeNode({ pipePath: env.pipe, dbPath: env.db, token: loadOrCreateToken(env.home), name, agent: "codex", cwd: env.home, autoWake: false, log: nullLogger,
    daemon: { cli, launch } });
  nodes.push(n); return n;
}
async function port() {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const value = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return value;
}

describe("standalone demand-start broker", () => {
  it("ten concurrent starts share one broker, keep accepted mail and reject wrong credentials", async () => {
    const peers = Array.from({ length: 10 }, (_, i) => node(`daemon-${i}`));
    await Promise.all(peers.map(peer => peer.start()));
    const pid = await remember(); expect(pid).not.toBe(process.pid);
    expect(peers.every(peer => !peer.isBroker)).toBe(true);
    expect(await peers[0]!.peers()).toHaveLength(10);
    const ids = await Promise.all(peers.map(peer => peer.health().then(health => health.brokerPid)));
    expect(new Set(ids)).toEqual(new Set([pid]));
    const accepted = await peers[0]!.send({ to: "offline-retained", body: "accepted fixture bytes" });
    expect(accepted.messages[0]!.body).toBe("accepted fixture bytes");
    await expect(client("wrong-fixture-token")).rejects.toMatchObject({ code: "unauthorized" });
    for (const peer of peers) await peer.stop();
    const later = node("offline-retained"); await later.start();
    await until(() => later.unread().some(message => message.id === accepted.messages[0]!.id));
    expect((await later.health()).brokerPid).toBe(pid);
    expect(later.unread()[0]!.body).toBe("accepted fixture bytes");
    expect(existsSync(join(env.home, "state-core.db"))).toBe(false);
  });
  it("verified broker crash re-elects without losing accepted offline mail", async () => {
    const a = node("crash-client"); await a.start(); const first = await remember();
    const accepted = await a.send({ to: "after-crash", body: "retained across process loss" });
    expect(await fixtureProcessGeneration(first, owned.get(first)!, "wrong crash fixture")).toBe(true);
    const disconnected = once(a, "disconnected");
    process.kill(first, "SIGKILL");
    await disconnected;
    await until(() => !fixtureProcessExists(first, "crash visibility unknown")); owned.delete(first);
    await until(() => a.isConnected, 8_000); const next = await remember(); expect(next).not.toBe(first);
    const recipient = node("after-crash"); await recipient.start();
    await until(() => recipient.unread().some(message => message.id === accepted.messages[0]!.id));
    expect(recipient.unread()[0]!.body).toBe("retained across process loss");
  });
  it("preserves disabled dashboard startup, forced opening and atomic conflicting-port refusal", async () => {
    const a = node("dashboard-client"); await a.start(); await remember();
    expect(await a.ensureDashboard(false)).toBeNull();
    expect(existsSync(join(env.home, "dashboard.json"))).toBe(false);
    const selected = await port();
    const infos = await Promise.all(Array.from({ length: 5 }, () => a.ensureDashboard(true, selected)));
    expect(new Set(infos.map(info => info!.port))).toEqual(new Set([selected]));
    expect(new Set(infos.map(info => info!.pid)).size).toBe(1);
    await expect(a.ensureDashboard(true, await port())).rejects.toMatchObject({ code: "bad_request" });
    expect((await a.ensureDashboard(true, selected))!.port).toBe(selected);
    const c = await client();
    try { await expect(c.request("ensureDashboard", { force: "yes" as unknown as boolean, port: selected })).rejects.toMatchObject({ code: "bad_request" }); }
    finally { c.close(); }
  });
  it("only definitive unavailable creation allows honest degraded legacy hosting", async () => {
    const launch = vi.fn(async () => ({ kind: "unavailable" as const, reason: "windows_wmi_unavailable" as const }));
    const a = node("degraded", launch); await a.start();
    expect(a.isBroker).toBe(true); expect(a.hostingEvidence()).toEqual({ hostingMode: "embedded_degraded", reason: "windows_wmi_unavailable" });
    expect(launch).toHaveBeenCalledOnce();
    const b = node("later", launch); await b.start();
    expect(launch).toHaveBeenCalledOnce(); expect(b.isBroker).toBe(false);
    await b.send({ to: a.name, body: "legacy behavior preserved" }); await until(() => a.unread().length === 1);
  });
  it("ambiguous creation stays latched across reconnect attempts without embedded fallback", async () => {
    const launch = vi.fn(async () => ({ kind: "unknown" as const })), a = node("unconfirmed", launch);
    await expect(a.start()).rejects.toThrow("could not connect");
    await expect(a.ensureConnected()).rejects.toThrow("could not connect");
    expect(launch).toHaveBeenCalledOnce(); expect(a.isBroker).toBe(false);
    expect(existsSync(join(env.home, "state-core.db"))).toBe(false);
    const host = env.node("real-host"); await host.start(); await a.ensureConnected();
    expect(a.isBroker).toBe(false); expect(launch).toHaveBeenCalledOnce();
  });
  it("an authenticated discovery rejection never invokes creation or fallback", async () => {
    const host = env.node("existing"); await host.start();
    const launch = vi.fn(async () => ({ kind: "unavailable" as const, reason: "windows_wmi_unavailable" as const }));
    const a = new BridgeNode({ pipePath: env.pipe, dbPath: env.db, token: "wrong-fixture-token", name: "rejected", agent: "codex", cwd: env.home, autoWake: false, log: nullLogger, daemon: { cli, launch } }); nodes.push(a);
    await expect(a.start()).rejects.toMatchObject({ code: "unauthorized" });
    expect(launch).not.toHaveBeenCalled(); expect(a.isBroker).toBe(false); expect(host.isBroker).toBe(true);
  });
  it("parent exit and Windows prohibiting Job Object close leave the same authenticated daemon alive", async () => {
    const runtime = join(env.home, "runtime with spaces"); cpSync(join(import.meta.dirname, "../plugins/codex/dist"), runtime, { recursive: true });
    const parentCli = join(runtime, "cli.mjs");
    const gate = "process.send('ready');process.on('message',()=>{const child=require('node:child_process').spawn(process.execPath,[process.argv[1],'tail'],{windowsHide:true,stdio:'ignore'});child.on('error',()=>process.exit(1));});setInterval(()=>{},1000);";
    const parent = spawn(process.execPath, ["-e", gate, parentCli], { cwd: env.home, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { ...process.env, AGENT_BRIDGE_HOME: env.home, AGENT_BRIDGE_PIPE: env.pipe, AGENT_BRIDGE_DASHBOARD: "false", AGENT_BRIDGE_HISTORY_INGEST: "0" } });
    children.push(parent);
    let scope: WindowsJobScope | undefined;
    try {
      await once(parent, "message");
      if (process.platform === "win32") scope = await startWindowsJobScope(nullLogger, parent.pid!);
      parent.send("start");
      let pid: number | undefined;
      for (const deadline = Date.now() + 10_000; !pid && Date.now() < deadline;) {
        try { pid = await remember(); }
        catch (error) {
          if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      expect(pid).toBeDefined();
      const a = node("observer", async () => { throw new Error("observer must not launch the tested daemon"); });
      await a.start();
      expect((await a.health()).history).toBeNull();
      if (process.platform === "win32") {
        const bin = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        const actual = execFileSync(bin, ["-NoProfile", "-NonInteractive", "-Command", `(Invoke-CimMethod -InputObject (Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}') -MethodName GetOwnerSid).Sid`], { encoding: "utf8", windowsHide: true }).trim();
        const expected = execFileSync(bin, ["-NoProfile", "-NonInteractive", "-Command", "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value"], { encoding: "utf8", windowsHide: true }).trim();
        expect(actual).toBe(expected);
      }
      const closed = once(parent, "close");
      const scopeClosed = scope ? once(scope.guardian, "close") : undefined;
      if (scope) { const result = await scope.cleanup(); expect(result.stopped).not.toContain(pid); expect(result.remaining).toEqual([]); scope.detach(); parent.kill(); }
      else process.kill(-parent.pid!, "SIGKILL");
      await closed; await scopeClosed;
      expect((await a.health()).brokerPid).toBe(pid);
      await a.send({ to: "parent-exit-offline", body: "post-parent accepted" });
    } finally { scope?.detach(); }
  });
});
