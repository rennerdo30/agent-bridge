import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bundleDirectory } from "../src/core/bundle-directory.js";
import { pathToFileURL } from "node:url";
import { makeEnv, type TestEnv } from "./helpers.js";
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
  const call=(name:string,args:Record<string,unknown>)=>client.callTool({name,arguments:args,_meta:{threadId:"split-bundle-thread"}});
  try {
    await client.connect(transport);await call("peers",{});
    await call("send",{to:"offline-fixture",message:"compiled_background_needle"});
    await vi.waitFor(async()=>{const result=await call("search_history",{query:"compiled_background_needle"});const content=result.content as {type:string;text?:string}[];const text=content.find(c=>c.type==="text")?.text ?? "{}";expect(JSON.parse(text).hits).toHaveLength(1);},{timeout:10000,interval:100});
    expect(errors).not.toMatch(/Cannot find module|ERR_MODULE_NOT_FOUND|history worker failed|job archive worker failed/);
  } finally {await client.close();}
});
