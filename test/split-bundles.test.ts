import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bundleDirectory } from "../src/core/bundle-directory.js";
import { pathToFileURL } from "node:url";
import { makeEnv, type TestEnv } from "./helpers.js";
import { codexHost } from "./helpers.js";
import { DatabaseSync } from "node:sqlite";
import { MessageStore } from "../src/core/store.js";
import { nullLogger } from "../src/core/logger.js";
import { historyDbPath, historyReady, migrateHistoryStore } from "../src/core/history-store.js";
let env: TestEnv;
beforeEach(() => { env=makeEnv(); });
afterEach(async () => { await env.cleanup(); });
it("finds executable siblings from entrypoints and shared chunks", () => {
  const dist=join(env.home,"dist");
  expect(bundleDirectory(pathToFileURL(join(dist,"chunks","shared.mjs")).href)).toBe(dist);
  expect(bundleDirectory(pathToFileURL(join(dist,"cli.mjs")).href)).toBe(dist);
});
it("indexes new messages through the compiled split-bundle background worker", async () => {
  writeFileSync(join(env.home,"config.json"),JSON.stringify({dashboard:false,autoWake:false,wakeOnDirect:false,network:{enabled:false}}));
  const server=join(import.meta.dirname,"../plugins/codex/dist/server.mjs"), transport=new StdioClientTransport({command:process.execPath,args:[server,"--agent=codex"],cwd:env.home,stderr:"pipe",env:{...process.env as Record<string,string>,AGENT_BRIDGE_HOME:env.home,AGENT_BRIDGE_PLUGIN_RUNTIME_HOME:env.home,AGENT_BRIDGE_NAME:"split-session",CLAUDE_PROJECT_DIR:env.home,CLAUDE_CONFIG_DIR:join(env.home,"claude"),CODEX_HOME:join(env.home,"codex"),XDG_DATA_HOME:join(env.home,"data"),ANTIGRAVITY_CLI_HOME:join(env.home,"agy")}});
  const client=new Client({name:"split-bundle-fixture",version:"1"});let errors="";transport.stderr?.on("data",b=>errors+=b);
  let history: DatabaseSync | undefined;
  let pinned: DatabaseSync | undefined, store: MessageStore | undefined;
  codexHost(client, env.home, "codex", "split-bundle-thread");
  const call=(name:string,args:Record<string,unknown>)=>client.callTool({name,arguments:args,_meta:{threadId:"split-bundle-thread"}});
  try {
    // Keep a reader on the pre-write WAL generation to force checkpoint
    // fallback during synthetic setup, before testing the compiled indexer.
    store = new MessageStore(env.db, nullLogger);
    pinned = new DatabaseSync(env.db);
    pinned.exec("BEGIN; SELECT count(*) FROM messages");
    const writer = new DatabaseSync(env.db);
    try { writer.exec("CREATE TABLE snapshot_fallback_witness(value TEXT); INSERT INTO snapshot_fallback_witness VALUES('retained')"); }
    finally { writer.close(); }
    // Checkpoint waits alone do not bound backup/copy/verification completion.
    // Await the actual migration while the synthetic reader remains pinned.
    await migrateHistoryStore(env.db, store.history.storageDatabase);
    expect(historyReady(store.history.storageDatabase)).toBe(true);
    store.close(); store = undefined;
    await client.connect(transport);await call("peers",{});
    history = new DatabaseSync(historyDbPath(env.db), { readOnly: true });
    expect(historyReady(history)).toBe(true);
    await call("send",{to:"offline-fixture",message:"compiled_background_needle"});
    await vi.waitFor(async()=>{const result=await call("search_history",{query:"compiled_background_needle"});const content=result.content as {type:string;text?:string}[];const text=content.find(c=>c.type==="text")?.text ?? "{}";expect(JSON.parse(text).hits).toHaveLength(1);},{timeout:10000,interval:100});
    expect(errors).not.toMatch(/Cannot find module|ERR_MODULE_NOT_FOUND|history worker failed|job archive worker failed/);
    pinned.exec("ROLLBACK");
    expect(pinned.prepare("SELECT value FROM snapshot_fallback_witness").get()).toEqual({value:"retained"});
  } finally {
    history?.close();
    try { await client.close(); }
    finally { pinned?.close(); store?.close(); }
  }
});
