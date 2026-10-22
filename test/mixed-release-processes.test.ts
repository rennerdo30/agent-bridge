import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { closeMetadataDb } from "../src/core/metadata-db.js";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { APP_VERSION } from "../src/core/constants.js";
import { SQLITE_STORE_VERSION } from "../src/core/store.js";
import { until } from "./helpers.js";
import { readProcessIdentity } from "../src/core/process-identity.js";
import { fixtureProcessGeneration, signalFixtureProcess } from "./fixture-process-generation.js";
import { captureFixtureBroker } from "./fixture-teardown.js";

const textOf = (result: any): string => result.content.map((part: any) => part.text ?? "").join("\n");

it("refuses a shared-home older release before migration, preserves accepted bytes and upgrades only after coordinated shutdown", async () => {
  const home = mkdtempSync(join(tmpdir(), "ab-real-mixed-"));
  const oldServer = join(home, "release14.mjs"), newServer = join(home, "current-server.mjs");
  // Read the released artifact from Git, never from a live plugin cache or an install command.
  const oldArtifact = execFileSync("git", ["show", "v0.29.14:plugins/codex/dist/server.mjs"], { cwd: join(import.meta.dirname, ".."), maxBuffer: 20 * 1024 * 1024 });
  // This tagged release reads JSON4/SQLite7 but predates capability advertisement.
  expect(oldArtifact.toString("utf8")).not.toContain("storeCapabilities");
  expect(oldArtifact.toString("utf8")).not.toContain("storage-capabilities");
  writeFileSync(oldServer, oldArtifact);
  const clients: Client[] = [];
  const transports: StdioClientTransport[] = [];
  const daemonIdentities = new Map<number, string>();
  const owned: { name: string; pid: number; stderr: () => string }[] = [];
  const env = { ...process.env } as Record<string, string>;
  // Test workers must never inherit a delegated job's live supervisor link or runtime selector.
  for (const key of Object.keys(env)) if (key.startsWith("AGENT_BRIDGE_")) delete env[key];
  // No daemon override: refusal must precede demand-start with the real default.
  Object.assign(env, { AGENT_BRIDGE_HOME: home, AGENT_BRIDGE_DELIVERY: "hooks", AGENT_BRIDGE_DASHBOARD: "off", AGENT_BRIDGE_HISTORY_INGEST: "0", AGENT_BRIDGE_LOG_CONSOLE: "info", CLAUDE_PROJECT_DIR: home, CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex"), XDG_DATA_HOME: home });
  const start = async (file: string, name: string, agent: string) => {
    const client = new Client({ name: `test-${name}`, version: "1" });
    clients.push(client);
    const transport = new StdioClientTransport({ command: process.execPath, args: [file, `--agent=${agent}`], env: { ...env, AGENT_BRIDGE_NAME: name }, stderr: "pipe" });
    transports.push(transport);
    let errors = "";
    transport.stderr?.on("data", (chunk) => errors += chunk);
    const launch = transport.start.bind(transport);
    transport.start = async () => {
      await launch();
      if (transport.pid !== null) owned.push({ name, pid: transport.pid, stderr: () => errors });
    };
    try { await client.connect(transport); } catch (error) { throw new Error(`${name}: ${errors}`, { cause: error }); }
    return { client, transport, stderr: () => errors };
  };
  const exited = (pid: number): boolean => {
    try { process.kill(pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  };
  const schema = () => {
    const db = new DatabaseSync(join(home, "bridge.db"), { readOnly: true });
    try { return Number(db.prepare("PRAGMA user_version").get()!.user_version); } finally { db.close(); }
  };
  let failure: unknown;
  const daemonLog = () => readFileSync(join(home, "logs", "agent-bridge.log"), "utf8");
  const rememberDaemon = async (pid: number) => {
    const identity = await readProcessIdentity(pid); expect(identity).toBeTruthy(); daemonIdentities.set(pid, identity!);
  };
  const stopFixtureDaemon = async (pid: number) => {
    await signalFixtureProcess(pid, daemonIdentities.get(pid)!, "Mixed fixture daemon identity changed; no signal sent", "SIGTERM");
    await until(() => exited(pid), 3_000); daemonIdentities.delete(pid);
  };
  try {
    await build({ entryPoints: [join(import.meta.dirname, "../src/mcp/main.ts")], outfile: newServer, bundle: true, platform: "node", format: "esm", logLevel: "silent",
      banner: { js: "import { createRequire as __mixedRequire } from 'node:module'; const require = __mixedRequire(import.meta.url);" },
    });
    await build({ entryPoints: [join(import.meta.dirname, "../src/cli/main.ts")], outfile: join(home, "cli.mjs"), bundle: true, platform: "node", format: "esm", logLevel: "silent",
      banner: { js: "import { createRequire as __mixedRequire } from 'node:module'; const require = __mixedRequire(import.meta.url);" },
    });
    const { client: old, transport: oldTransport } = await start(oldServer, "old-release14", "codex");
    expect(old.getServerVersion()!.version).toBe("0.29.14");
    expect(oldTransport.pid).not.toBeNull(); expect(oldTransport.pid).toBeGreaterThan(0);
    expect(schema()).toBe(7);
    const accepted = ["accepted legacy bytes one", "accepted legacy bytes two"];
    for (const [index, body] of accepted.entries()) {
      const result = await old.callTool({ name: "send", arguments: { to: `offline-original-${index}`, message: body } });
      expect(result.isError).not.toBe(true);
    }
    const readRows = () => {
      const db = new DatabaseSync(join(home, "bridge.db"), { readOnly: true });
      try { return db.prepare("SELECT * FROM messages ORDER BY created_at,id").all(); } finally { db.close(); }
    };
    const originalRows = readRows(); expect(originalRows.map(row => row.body).sort()).toEqual([...accepted].sort());
    const protectedDir = join(home, ".migration-snapshots");
    const snapshots = () => existsSync(protectedDir) ? readdirSync(protectedDir).sort() : [];
    const originals = snapshots();
    await expect(start(newServer, "refused-current", "claude")).rejects.toThrow(/owner.coordinated shutdown/);
    expect(exited(oldTransport.pid!)).toBe(false);
    expect(textOf(await old.callTool({ name: "peers", arguments: {} }))).toContain("old-release14");
    expect(schema()).toBe(7); expect(readRows()).toEqual(originalRows); expect(snapshots()).toEqual(originals);
    const currentPids = owned.filter(child => child.name === "refused-current").map(child => child.pid);
    expect(currentPids).toHaveLength(1);
    for (const pid of currentPids) expect(daemonLog().split("\n").filter(line => line.includes(`pid=${pid} `)).join("\n")).not.toMatch(/broker listening|became broker|daemon creation/);
    await until(() => currentPids.every(exited), 3_000);
    // No broker handover, daemon replacement or old-protocol hello was requested.
    const oldPid = oldTransport.pid!;
    await old.close(); await until(() => exited(oldPid), 3_000);
    const { client: current, transport: currentTransport, stderr: currentLog } = await start(newServer, "current-release", "claude");
    expect(current.getServerVersion()!.version).toBe(APP_VERSION);
    expect(currentTransport.pid).not.toBeNull(); expect(currentTransport.pid).toBeGreaterThan(0);
    expect(currentTransport.pid).not.toBe(oldPid);
    const peers = textOf(await current.callTool({ name: "peers", arguments: {} }));
    expect(peers).toContain("current-release"); expect(peers).not.toContain("old-release14");
    expect(textOf(await current.callTool({ name: "inbox", arguments: {} }))).not.toContain("accepted legacy bytes");
    const currentPid = currentTransport.pid!;
    // Witness the actual current-process listener before inspecting its schema:
    // an early disk probe may precede the completed election after old.close().
    const health = await current.callTool({ name: "health", arguments: {} });
    expect(health.isError).not.toBe(true);
    const daemonPid = JSON.parse(textOf(health)).brokerPid as number;
    expect(daemonPid).not.toBe(currentPid); expect(JSON.parse(textOf(health))).toMatchObject({ brokerVersion: APP_VERSION });
    await rememberDaemon(daemonPid);
    await until(() => daemonLog().includes(`pid=${daemonPid} broker listening`), 3_000);
    const electionLog = daemonLog().split("\n").filter(line => line.includes(`pid=${daemonPid} `));
    const listener = electionLog.findIndex(line => line.includes("broker listening"));
    const admittedSchema = schema();
    // Only bridge.db schema snapshots count here; the AB-208 metadata tables take their own snapshot.
    const storeSnapshots = () => existsSync(protectedDir) ? readdirSync(protectedDir).filter(name => name.startsWith("bridge.db.backup-")) : [];
    expect(admittedSchema).toBe(SQLITE_STORE_VERSION);
    const backedUp = electionLog.findIndex(line => line.includes("backed up store before migration"));
    expect(backedUp).toBeGreaterThanOrEqual(0); expect(backedUp).toBeLessThan(listener);
    expect(electionLog[backedUp]).toContain('"version":7'); expect(storeSnapshots()).toHaveLength(1);
    const db = new DatabaseSync(join(home, "bridge.db"), { readOnly: true });
    try {
      expect(db.prepare("SELECT * FROM messages ORDER BY created_at,id").all()).toEqual(originalRows);
      expect(db.prepare("PRAGMA integrity_check").get()!.integrity_check).toBe("ok");
    } finally { db.close(); }
    await current.close();
    await until(() => exited(currentPid), 3_000);
    expect(await fixtureProcessGeneration(daemonPid, daemonIdentities.get(daemonPid)!, "Daemon did not outlive MCP")).toBe(true);
    expect(schema()).toBe(admittedSchema);
    // A fresh elected daemon, rather than MCP exit, creates the next schema admission opportunity.
    await stopFixtureDaemon(daemonPid);
    const { client: elected, transport: electedTransport } = await start(newServer, "current-release", "claude");
    expect(elected.getServerVersion()!.version).toBe(APP_VERSION);
    expect(electedTransport.pid).not.toBeNull(); expect(electedTransport.pid).toBeGreaterThan(0);
    await until(() => schema() === SQLITE_STORE_VERSION, 3_000);
    expect(textOf(await elected.callTool({ name: "peers", arguments: {} }))).toContain("current-release");
    const electedHealth = JSON.parse(textOf(await elected.callTool({ name: "health", arguments: {} })));
    expect(electedHealth).toMatchObject({ brokerVersion: APP_VERSION });
    expect(electedHealth.brokerPid).not.toBe(electedTransport.pid); await rememberDaemon(electedHealth.brokerPid);
    const upgraded = new DatabaseSync(join(home, "bridge.db"), { readOnly: true });
    try {
      expect(upgraded.prepare("SELECT * FROM messages ORDER BY created_at,id").all()).toEqual(originalRows);
      expect(upgraded.prepare("PRAGMA integrity_check").get()!.integrity_check).toBe("ok");
    } finally { upgraded.close(); }
    const backups = storeSnapshots();
    expect(backups).toHaveLength(1);
    const before = new DatabaseSync(join(home, ".migration-snapshots", backups[0]!), { readOnly: true });
    try {
      expect(before.prepare("PRAGMA user_version").get()!.user_version).toBe(7);
      expect(before.prepare("SELECT count(*) AS n FROM messages").get()!.n).toBe(2);
      expect(before.prepare("SELECT * FROM messages ORDER BY created_at,id").all()).toEqual(originalRows);
      expect(before.prepare("PRAGMA integrity_check").get()!.integrity_check).toBe("ok");
    } finally { before.close(); }
  } catch (error) {
    failure = error;
  } finally {
    const teardownErrors: unknown[] = [];
    const attempt = async (action: () => Promise<unknown>) => {
      try { await action(); } catch (error) { teardownErrors.push(error); }
    };
    const serverPids = [...new Set([...owned.map(child => child.pid), ...transports.flatMap(transport => transport.pid ? [transport.pid] : [])])];
    let stopBroker: (() => Promise<void>) | undefined;
    await attempt(async () => { stopBroker = await captureFixtureBroker(home, serverPids); });
    for (const client of clients) await attempt(() => client.close());
    for (const transport of transports) await attempt(() => transport.close());
    // Confirm every producer has exited BEFORE signalling the captured daemon:
    // transport.close() can return after SIGKILL while process exit is still pending.
    await attempt(() => until(() => serverPids.every(pid => exited(pid)), 3_000));
    if (!teardownErrors.length) {
      await attempt(async () => { await stopBroker?.(); });
      for (const pid of daemonIdentities.keys()) await attempt(() => stopFixtureDaemon(pid));
    }
    if (teardownErrors.length) failure = new AggregateError([failure, ...teardownErrors].filter(Boolean), "Fixture producer or daemon exit was not proven; retained.");
    // liveStorePeers reads the capability rows through this process's shared metadata connection.
    closeMetadataDb(home);
    if (!failure) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  if (failure) throw new Error(`Mixed-release fixture retained at ${home}\n${owned.map(child => `${child.name} (pid ${child.pid}): ${child.stderr()}`).join("\n")}\n${failure instanceof Error ? failure.stack : String(failure)}`, { cause: failure });
});
