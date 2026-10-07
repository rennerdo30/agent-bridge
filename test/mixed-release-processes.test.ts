import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { assertStoreUpgrade } from "../src/core/store-compatibility.js";
import { SQLITE_STORE_VERSION } from "../src/core/store.js";
import { until } from "./helpers.js";

const textOf = (result: any): string => result.content.map((part: any) => part.text ?? "").join("\n");

it("keeps real 14/16 MCP processes talking on SQLite7, then publishes SQLite8 after the old reader exits", async () => {
  expect(SQLITE_STORE_VERSION).toBe(8);
  const home = mkdtempSync(join(tmpdir(), "ab-real-mixed-"));
  const oldServer = join(home, "release14.mjs"), newServer = join(home, "release16.mjs");
  // Read the released artifact from Git, never from a live plugin cache or an install command.
  writeFileSync(oldServer, execFileSync("git", ["show", "v0.29.14:plugins/codex/dist/server.mjs"], { cwd: join(import.meta.dirname, ".."), maxBuffer: 20 * 1024 * 1024 }));
  const clients: Client[] = [];
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
    return client;
  };
  const schema = () => {
    const db = new DatabaseSync(join(home, "bridge.db"), { readOnly: true });
    try { return Number(db.prepare("PRAGMA user_version").get()!.user_version); } finally { db.close(); }
  };
  try {
    await build({ entryPoints: [join(import.meta.dirname, "../src/mcp/main.ts")], outfile: newServer, bundle: true, platform: "node", format: "esm", logLevel: "silent",
      banner: { js: "import { createRequire as __mixedRequire } from 'node:module'; const require = __mixedRequire(import.meta.url);" },
      plugins: [{ name: "release-version", setup(builder) {
        builder.onLoad({ filter: /[\\/]core[\\/]constants\.ts$/ }, (args) => ({ contents: readFileSync(args.path, "utf8").replace(/APP_VERSION = "[^"]+"/, 'APP_VERSION = "0.29.16"'), loader: "ts" }));
      } }],
    });
    const old = await start(oldServer, "old-release14", "codex");
    expect(old.getServerVersion()!.version).toBe("0.29.14");
    expect(schema()).toBe(7);
    const current = await start(newServer, "new-release16", "claude");
    expect(current.getServerVersion()!.version).toBe("0.29.16");
    const peers = textOf(await current.callTool({ name: "peers", arguments: {} }));
    expect(peers).toContain("old-release14");
    expect(peers).toContain("v0.29.14");
    expect(peers).toContain("retained code");
    expect(schema()).toBe(7);
    expect(() => assertStoreUpgrade(home, "sqlite", 7, 8)).toThrow("old-release14 (v0.29.14");
    await current.callTool({ name: "send", arguments: { to: "old-release14", message: "new-to-old protocol2" } });
    expect(textOf(await old.callTool({ name: "inbox", arguments: {} }))).toContain("new-to-old protocol2");
    await old.callTool({ name: "send", arguments: { to: "new-release16", message: "old-to-new protocol2" } });
    expect(textOf(await current.callTool({ name: "inbox", arguments: {} }))).toContain("old-to-new protocol2");
    expect(schema()).toBe(7);
    await old.close();
    await until(() => schema() === 8, 3_000);
    expect(textOf(await current.callTool({ name: "peers", arguments: {} }))).toContain("new-release16");
    const db = new DatabaseSync(join(home, "bridge.db"), { readOnly: true });
    try {
      expect(db.prepare("SELECT body FROM messages ORDER BY created_at").all().map((row) => row.body)).toEqual(["new-to-old protocol2", "old-to-new protocol2"]);
      expect(db.prepare("PRAGMA integrity_check").get()!.integrity_check).toBe("ok");
    } finally { db.close(); }
    const snapshots = readdirSync(join(home, ".migration-snapshots"));
    expect(snapshots).toHaveLength(1);
    const before = new DatabaseSync(join(home, ".migration-snapshots", snapshots[0]!), { readOnly: true });
    try {
      expect(before.prepare("PRAGMA user_version").get()!.user_version).toBe(7);
      expect(before.prepare("SELECT count(*) AS n FROM messages").get()!.n).toBe(2);
    } finally { before.close(); }
  } finally {
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
