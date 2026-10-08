import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { assertStoreUpgrade, liveStorePeers, refreshStorePeerIdentities } from "../src/core/store-compatibility.js";
import { APP_VERSION } from "../src/core/constants.js";
import { SQLITE_STORE_VERSION } from "../src/core/store.js";
import { until } from "./helpers.js";

const textOf = (result: any): string => result.content.map((part: any) => part.text ?? "").join("\n");

it("keeps released and current MCP processes talking until the older reader exits", async () => {
  const home = mkdtempSync(join(tmpdir(), "ab-real-mixed-"));
  const oldServer = join(home, "release14.mjs"), newServer = join(home, "current-server.mjs");
  // Read the released artifact from Git, never from a live plugin cache or an install command.
  const oldArtifact = execFileSync("git", ["show", "v0.29.14:plugins/codex/dist/server.mjs"], { cwd: join(import.meta.dirname, ".."), maxBuffer: 20 * 1024 * 1024 });
  // This tagged release reads JSON4/SQLite7 but predates capability advertisement.
  expect(oldArtifact.toString("utf8")).not.toContain("storeCapabilities");
  expect(oldArtifact.toString("utf8")).not.toContain("storage-capabilities");
  writeFileSync(oldServer, oldArtifact);
  const clients: Client[] = [];
  const owned: { name: string; pid: number; stderr: () => string }[] = [];
  const env = { ...process.env } as Record<string, string>;
  // Test workers must never inherit a delegated job's live supervisor link or runtime selector.
  for (const key of Object.keys(env)) if (key.startsWith("AGENT_BRIDGE_")) delete env[key];
  Object.assign(env, { AGENT_BRIDGE_HOME: home, AGENT_BRIDGE_DELIVERY: "hooks", AGENT_BRIDGE_DASHBOARD: "off", CLAUDE_PROJECT_DIR: home, CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex"), XDG_DATA_HOME: home });
  const start = async (file: string, name: string, agent: string) => {
    const client = new Client({ name: `test-${name}`, version: "1" });
    clients.push(client);
    const transport = new StdioClientTransport({ command: process.execPath, args: [file, `--agent=${agent}`], env: { ...env, AGENT_BRIDGE_NAME: name }, stderr: "pipe" });
    let errors = "";
    transport.stderr?.on("data", (chunk) => errors += chunk);
    try { await client.connect(transport); } catch (error) { throw new Error(`${name}: ${errors}`, { cause: error }); }
    if (transport.pid !== null) owned.push({ name, pid: transport.pid, stderr: () => errors });
    return { client, transport };
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
  try {
    await build({ entryPoints: [join(import.meta.dirname, "../src/mcp/main.ts")], outfile: newServer, bundle: true, platform: "node", format: "esm", logLevel: "silent",
      banner: { js: "import { createRequire as __mixedRequire } from 'node:module'; const require = __mixedRequire(import.meta.url);" },
    });
    const { client: old, transport: oldTransport } = await start(oldServer, "old-release14", "codex");
    expect(old.getServerVersion()!.version).toBe("0.29.14");
    expect(oldTransport.pid).not.toBeNull(); expect(oldTransport.pid).toBeGreaterThan(0);
    expect(schema()).toBe(7);
    const { client: current, transport: currentTransport } = await start(newServer, "current-release", "claude");
    expect(current.getServerVersion()!.version).toBe(APP_VERSION);
    expect(currentTransport.pid).not.toBeNull(); expect(currentTransport.pid).toBeGreaterThan(0);
    expect(currentTransport.pid).not.toBe(oldTransport.pid);
    const peers = textOf(await current.callTool({ name: "peers", arguments: {} }));
    expect(peers).toContain("old-release14");
    expect(peers).toContain("v0.29.14");
    expect(peers).toContain("retained code");
    expect(schema()).toBe(7);
    // The test worker has its own cache, independent of both real MCP children.
    // Prove the exact still-live old child before requiring its named diagnostic;
    // an unknown/failed OS identity query must never satisfy this assertion.
    await refreshStorePeerIdentities(home);
    expect(liveStorePeers(home).find(peer => peer.pid === oldTransport.pid)).toMatchObject({
      pid: oldTransport.pid, name: "old-release14", version: "0.29.14", explicit: false, json: 4, sqlite: 7,
    });
    expect(() => assertStoreUpgrade(home, "sqlite", 7, SQLITE_STORE_VERSION)).toThrow("old-release14 (v0.29.14");
    await current.callTool({ name: "send", arguments: { to: "old-release14", message: "new-to-old protocol2" } });
    expect(textOf(await old.callTool({ name: "inbox", arguments: {} }))).toContain("new-to-old protocol2");
    await old.callTool({ name: "send", arguments: { to: "current-release", message: "old-to-new protocol2" } });
    expect(textOf(await current.callTool({ name: "inbox", arguments: {} }))).toContain("old-to-new protocol2");
    expect(schema()).toBe(7);
    const oldPid = oldTransport.pid!, currentPid = currentTransport.pid!;
    await old.close();
    await until(() => exited(oldPid), 3_000);
    // The elected listener keeps its compatible schema until a later clean
    // election; a retained reader's exit never triggers a bulk hot-path upgrade.
    expect(schema()).toBe(7);
    expect(textOf(await current.callTool({ name: "peers", arguments: {} }))).toContain("current-release");
    const db = new DatabaseSync(join(home, "bridge.db"), { readOnly: true });
    try {
      expect(db.prepare("SELECT body FROM messages ORDER BY created_at").all().map((row) => row.body)).toEqual(["new-to-old protocol2", "old-to-new protocol2"]);
      expect(db.prepare("PRAGMA integrity_check").get()!.integrity_check).toBe("ok");
    } finally { db.close(); }
    await current.close();
    await until(() => exited(currentPid), 3_000);
    expect(schema()).toBe(7);
    const { client: elected, transport: electedTransport } = await start(newServer, "current-release", "claude");
    expect(elected.getServerVersion()!.version).toBe(APP_VERSION);
    expect(electedTransport.pid).not.toBeNull(); expect(electedTransport.pid).toBeGreaterThan(0);
    await until(() => schema() === SQLITE_STORE_VERSION, 3_000);
    expect(textOf(await elected.callTool({ name: "peers", arguments: {} }))).toContain("current-release");
    const upgraded = new DatabaseSync(join(home, "bridge.db"), { readOnly: true });
    try {
      expect(upgraded.prepare("SELECT body FROM messages ORDER BY created_at").all().map((row) => row.body)).toEqual(["new-to-old protocol2", "old-to-new protocol2"]);
      expect(upgraded.prepare("PRAGMA integrity_check").get()!.integrity_check).toBe("ok");
    } finally { upgraded.close(); }
    const snapshots = readdirSync(join(home, ".migration-snapshots"));
    expect(snapshots).toHaveLength(1);
    const before = new DatabaseSync(join(home, ".migration-snapshots", snapshots[0]!), { readOnly: true });
    try {
      expect(before.prepare("PRAGMA user_version").get()!.user_version).toBe(7);
      expect(before.prepare("SELECT count(*) AS n FROM messages").get()!.n).toBe(2);
      expect(before.prepare("SELECT body FROM messages ORDER BY created_at").all().map((row) => row.body)).toEqual(["new-to-old protocol2", "old-to-new protocol2"]);
      expect(before.prepare("PRAGMA integrity_check").get()!.integrity_check).toBe("ok");
    } finally { before.close(); }
  } catch (error) {
    failure = error;
  } finally {
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
    try { await until(() => owned.every(child => exited(child.pid)), 3_000); }
    catch (error) { failure = new AggregateError([failure, error].filter(Boolean), "Owned MCP child exit was not proven; fixture retained."); }
    if (!failure) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  if (failure) throw new Error(`Mixed-release fixture retained at ${home}\n${owned.map(child => `${child.name} (pid ${child.pid}): ${child.stderr()}`).join("\n")}\n${failure instanceof Error ? failure.stack : String(failure)}`, { cause: failure });
});
