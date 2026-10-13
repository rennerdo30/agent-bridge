import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
import { startUi, type UiOptions } from "../src/cli/ui.js";
import { readDashboardInfo } from "../src/cli/dashboard.js";

const cli = join(import.meta.dirname, "../plugins/codex/dist/cli.mjs");
let env: TestEnv, nodes: BridgeNode[], children: ChildProcess[], owned: Map<number, string>;
let startupEvidence: Array<Array<{ phase: string; code?: string | number; stage?: string; elapsedMs: number; count: number }>>;
let dashboards: Array<() => Promise<void>>;
beforeEach(() => {
  env = makeEnv(); nodes = []; children = []; owned = new Map();
  startupEvidence = [];
  dashboards = [];
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
  // Fixture-only fixed categories. No raw stderr, commands, peer names, paths,
  // authentication material or request/accepted content enters this evidence.
  if (startupEvidence.length) process.stderr.write("AB325 fixture startup evidence " + JSON.stringify(startupEvidence) + "\n");
  for (const close of dashboards) await close();
  await Promise.all(nodes.map(node => node.stop()));
  for (const child of children) { if (child.exitCode === null && child.signalCode === null) { const closed = once(child, "close"); child.kill(); await closed; } }
  for (const pid of owned.keys()) await stopOwned(pid);
  await env.cleanup();
});
function fixtureStartupLogger(): typeof nullLogger {
  const evidence: typeof startupEvidence[number] = []; startupEvidence.push(evidence);
  const started = performance.now();
  const record = (phase: string, code?: string | number, stage?: string) => {
    const previous = evidence.find(event => event.phase === phase && event.code === code && event.stage === stage);
    if (previous) { previous.count++; previous.elapsedMs = Math.round(performance.now() - started); }
    else evidence.push({ phase, ...(code === undefined ? {} : { code }), ...(stage ? { stage } : {}), elapsedMs: Math.round(performance.now() - started), count: 1 });
  };
  const fixtureLog: typeof nullLogger = { ...nullLogger, child: () => fixtureLog,
    debug: (message, data) => { if (message === "connect attempt failed" && ["ENOENT", "ECONNREFUSED", "ETIMEDOUT", "EUNSAFESOCKETDIR"].includes(String(data?.code))) record("discovery", String(data!.code)); },
    info: (message, data) => {
      if (message === "connected to broker") record("authenticated_ready");
      else if (message === "daemon creation observation; authenticated readiness still required" && ["created", "unknown", "unavailable"].includes(String(data?.kind))) {
        record("creation_" + String(data!.kind), Number.isSafeInteger(data?.errorCode) ? Number(data!.errorCode) : undefined,
          ["read", "startup", "create"].includes(String(data?.stage)) ? String(data!.stage) : undefined);
      }
    } };
  return fixtureLog;
}
function node(name: string, launch?: NonNullable<ConstructorParameters<typeof BridgeNode>[0]["daemon"]>["launch"]) {
  const n = new BridgeNode({ pipePath: env.pipe, dbPath: env.db, token: loadOrCreateToken(env.home), name, agent: "codex", cwd: env.home, autoWake: false, log: fixtureStartupLogger(),
    daemon: { cli, launch } });
  nodes.push(n); return n;
}
async function port() {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const value = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return value;
}
async function dashboard(options: Pick<UiOptions, "brokerDaemon" | "embeddedCompatibility"> = {}) {
  const ui = await startUi({ home: env.home, pipe: env.pipe, port: 0, log: fixtureStartupLogger(), ...options }); dashboards.push(ui.close);
  const visit = await fetch(ui.url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
  const cookie = visit.headers.get("set-cookie")!.split(";")[0]!;
  return dashboardSender(ui.url, cookie);
}
function dashboardSender(url: string, cookie: string) {
  const origin = new URL(url).origin;
  return (body: string, extra: Record<string, unknown> = {}) => fetch(origin + "/api/send", { method: "POST", signal: AbortSignal.timeout(10_000),
    headers: { cookie, "x-agent-bridge": "1", "content-type": "application/json" }, body: JSON.stringify({ to: "ui-retained", body, ...extra }) });
}
function copyFixtureRuntime(source: string, target: string): void {
  // Node's native cpSync has Windows Unicode regressions (nodejs/node#59636).
  // Set up the fixture with ordinary file APIs, then prove every copied byte.
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name), to = join(target, entry.name);
    if (entry.isDirectory()) copyFixtureRuntime(from, to);
    else {
      expect(entry.isFile(), "fixture runtime must contain regular files only").toBe(true);
      copyFileSync(from, to);
      expect(readFileSync(to).equals(readFileSync(from)), "fixture runtime bytes must match hosted bundle").toBe(true);
    }
  }
}

describe("standalone demand-start broker", () => {
  it.each([false, true])("actual CLI ui authorized sends use a daemon before/after crash (mobile-configured=%s)", async mobile => {
    const selected = await port();
    if (mobile) writeFileSync(join(env.home, "config.json"), JSON.stringify({ dashboard: false, mobile: { enabled: true } }));
    const child = spawn(process.execPath, [cli, "ui", "--no-open", `--port=${selected}`], { cwd: env.home, windowsHide: true, stdio: "ignore",
      env: { ...process.env, AGENT_BRIDGE_HOME: env.home, AGENT_BRIDGE_PIPE: env.pipe, AGENT_BRIDGE_HISTORY_INGEST: "0" } }); children.push(child);
    let info: ReturnType<typeof readDashboardInfo> = null;
    await until(() => !!(info = readDashboardInfo(env.home)), 10_000);
    const visit = await fetch(info!.url, { redirect: "manual", signal: AbortSignal.timeout(10_000) }), cookie = visit.headers.get("set-cookie")!.split(";")[0]!;
    expect((await fetch(new URL("/api/send", info!.url), { method: "POST", signal: AbortSignal.timeout(10_000), headers: { "x-agent-bridge": "1", "content-type": "application/json" }, body: '{"to":"ui-retained","body":"unauthorized"}' })).status).toBe(403);
    const send = dashboardSender(info!.url, cookie);
    const replies = await Promise.all(Array.from({ length: 5 }, (_, index) => send(`before-crash-${index}`)));
    expect(replies.map(reply => reply.status)).toEqual([200, 200, 200, 200, 200]);
    const accepted = await replies[0]!.json() as { id: string }, first = await remember(); expect(first).not.toBe(child.pid);
    const status = await client(); try { expect(await status.request("coreStatus", {})).toMatchObject({ mode: "daemon", pid: first }); } finally { status.close(); }
    await stopOwned(first);
    // A configured mobile desktop was owned by the daemon; re-open the SAME
    // configured CLI path. The nonmobile desktop remains in the original CLI.
    if (mobile) {
      const next = spawn(process.execPath, [cli, "ui", "--no-open", `--port=${selected}`], { cwd: env.home, windowsHide: true, stdio: "ignore",
        env: { ...process.env, AGENT_BRIDGE_HOME: env.home, AGENT_BRIDGE_PIPE: env.pipe, AGENT_BRIDGE_HISTORY_INGEST: "0" } }); children.push(next);
      await until(() => { const current = readDashboardInfo(env.home); return !!current && current.pid !== first; }, 10_000);
      info = readDashboardInfo(env.home);
    }
    const after = await dashboardSender(info!.url, cookie)("after-crash"); expect(after.status).toBe(200);
    const nextPid = await remember(); expect(nextPid).not.toBe(first); expect(nextPid).not.toBe(child.pid);
    const recipient = node("ui-retained"); await recipient.start();
    await until(() => recipient.unread().some(message => message.id === accepted.id));
    expect(recipient.unread().find(message => message.id === accepted.id)!.body).toBe("before-crash-0");
  });
  it("default UI sender stays connect-only and HTTP data cannot opt into embedding", async () => {
    const send = await dashboard();
    expect((await send("connect-only", { embeddedCompatibility: true })).status).toBe(500);
    expect(existsSync(env.db)).toBe(false);
    await expect(client()).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("UI unknown creation remains in one retained node across authorized sends", async () => {
    const launch = vi.fn(async () => ({ kind: "unknown" as const })), send = await dashboard({ brokerDaemon: { cli, launch } });
    expect((await send("unconfirmed-1")).status).toBe(500);
    expect((await send("unconfirmed-2")).status).toBe(500);
    expect(launch).toHaveBeenCalledOnce(); expect(existsSync(env.db)).toBe(false);
  });
  it("UI definitive unavailable creation preserves explicit degraded compatibility only", async () => {
    const launch = vi.fn(async () => ({ kind: "unavailable" as const, reason: "windows_wmi_unavailable" as const }));
    const send = await dashboard({ brokerDaemon: { cli, launch } });
    expect((await send("degraded-ui")).status).toBe(200); expect(launch).toHaveBeenCalledOnce();
    const status = await client();
    try { expect(await status.request("coreStatus", {})).toMatchObject({ mode: "embedded_degraded", pid: process.pid, reason: "windows_wmi_unavailable" }); }
    finally { status.close(); }
  });
  it("UI authentication rejection never creates or degrades a competing broker", async () => {
    const host = env.node("existing-authority"); await host.start();
    const token = join(env.home, "token"), saved = join(env.home, "fixture-original-token"); renameSync(token, saved);
    writeFileSync(token, "wrong-fixture-token");
    const launch = vi.fn(async () => ({ kind: "unavailable" as const, reason: "windows_wmi_unavailable" as const }));
    try {
      const send = await dashboard({ brokerDaemon: { cli, launch } });
      expect((await send("rejected-ui")).status).toBe(500); expect(launch).not.toHaveBeenCalled(); expect(host.isBroker).toBe(true);
    } finally { writeFileSync(token, readFileSync(saved)); }
  });
  it("core status inspects an absent or serving daemon without demand start or peer registration", async () => {
    const inspect = () => JSON.parse(execFileSync(process.execPath, [cli, "core", "status"], { encoding: "utf8", windowsHide: true,
      env: { ...process.env, AGENT_BRIDGE_HOME: env.home, AGENT_BRIDGE_PIPE: env.pipe } }));
    expect(inspect()).toEqual({ available: false });
    expect(existsSync(join(env.home, "token"))).toBe(false);
    expect(existsSync(join(env.home, "logs"))).toBe(false);
    const a = node("status-main"); await a.start(); const pid = await remember();
    expect(inspect()).toMatchObject({ mode: "daemon", pid, version: "0.30.14", runningJobsEvidence: "legacy_registry_labels_not_execution" });
    expect((await a.peers()).map(peer => peer.name)).toEqual(["status-main"]);
    const token = join(env.home, "token"), retainedToken = join(env.home, "fixture-retained-token");
    renameSync(token, retainedToken);
    try {
      expect(inspect).toThrow("Core status authentication material is unavailable");
      expect(existsSync(token)).toBe(false);
      expect((await a.health()).brokerPid).toBe(pid);
    } finally { renameSync(retainedToken, token); }
  });
  it("ten concurrent starts share one broker, keep accepted mail and reject wrong credentials", async () => {
    const peers = Array.from({ length: 10 }, (_, i) => node(`daemon-${i}`));
    await Promise.all(peers.map(peer => peer.start()));
    // Inspect through an existing authenticated peer: a throwaway connection's
    // asynchronous close can still be counted by the next exact status sample.
    const pid = (await peers[0]!.health()).brokerPid;
    const identity = await readProcessIdentity(pid);
    expect(identity).toBeTruthy(); owned.set(pid, identity!); expect(pid).not.toBe(process.pid);
    const statusClient = await client();
    try { expect(await statusClient.request("coreStatus", {})).toMatchObject({ mode: "daemon", pid, version: "0.30.14", connectedClients: 11, runningJobsEvidence: "legacy_registry_labels_not_execution" }); }
    finally { statusClient.close(); }
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
    const c = await client();
    try { expect(await c.request("coreStatus", {})).toMatchObject({ mode: "embedded_degraded", reason: "windows_wmi_unavailable" }); }
    finally { c.close(); }
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
    const runtime = join(env.home, "runtime with spaces-日本"); copyFixtureRuntime(join(import.meta.dirname, "../plugins/codex/dist"), runtime);
    const parentCli = join(runtime, "cli.mjs");
    expect(existsSync(parentCli), "copied Unicode fixture entry must exist before parent launch").toBe(true);
    const gate = String.raw`
      process.send('ready');
      process.on('message', message => {
        const cli = process.argv[1];
        process.send({event:'path_check', matches:cli === message.cli, exists:require('node:fs').existsSync(cli)});
        const child = require('node:child_process').spawn(process.execPath,[cli,'tail'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
        let stderr = '';
        child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(0,4096); });
        child.on('error', error => process.send({event:'spawn_error',code:error.code}));
        child.on('exit', code => {
          process.send({event:'loader_check', codes:stderr.match(/\b(?:ERR_[A-Z_]+|MODULE_NOT_FOUND|SyntaxError|TypeError)\b/g) ?? [], namesCli:stderr.includes(cli), replacement:stderr.includes('\uFFFD')});
          process.send({event:'child_exit',code});
        });
      });
      setInterval(()=>{},1000);`;
    const parent = spawn(process.execPath, ["-e", gate, parentCli], { cwd: env.home, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { ...process.env, AGENT_BRIDGE_HOME: env.home, AGENT_BRIDGE_PIPE: env.pipe, AGENT_BRIDGE_DASHBOARD: "false", AGENT_BRIDGE_HISTORY_INGEST: "0" } });
    children.push(parent);
    const fixtureEvents: string[] = [];
    parent.on("message", message => {
      const event = message as { event?: string; code?: string | number; codes?: string[]; matches?: boolean; exists?: boolean; namesCli?: boolean; replacement?: boolean };
      if (event.event === "path_check") fixtureEvents.push(`argv_matches:${event.matches},file_exists:${event.exists}`);
      else if (event.event === "loader_check") fixtureEvents.push(...(event.codes ?? []), `error_names_cli:${event.namesCli},replacement_character:${event.replacement}`);
      else if (event.event === "spawn_error" || event.event === "child_exit") fixtureEvents.push(`${event.event}:${event.code}`);
    });
    let scope: WindowsJobScope | undefined;
    try {
      await once(parent, "message");
      if (process.platform === "win32") scope = await startWindowsJobScope(nullLogger, parent.pid!);
      parent.send({ cli: parentCli });
      let pid: number | undefined;
      for (const deadline = Date.now() + 10_000; !pid && Date.now() < deadline;) {
        try { pid = await remember(); }
        catch (error) {
          if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      const observations = () => {
        try { return readFileSync(join(env.home, "logs", "agent-bridge.log"), "utf8").split("\n")
          .filter(line => line.includes("daemon creation observation"))
          .map(line => line.slice(line.indexOf("daemon creation observation"))).join("\n"); }
        catch { return "no fixture creation observation"; }
      };
      expect(pid, observations() + "; fixture codes: " + fixtureEvents.join(",")).toBeDefined();
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
