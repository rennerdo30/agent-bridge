import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { delegateToOpencode, opencodeV2 } from "../src/core/delegate.js";
import { delegateToOpencodeServed } from "../src/core/opencode-served.js";
import { nullLogger } from "../src/core/logger.js";
import { parseOpencodeModelCosts, readOpencodeModelCosts, readUsage } from "../src/core/usage.js";
import { listOpencodeModels } from "../src/core/opencode-models.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
function cli(major: number) {
  const root = process.env.AGENT_BRIDGE_TEST_ROOT!;
  mkdirSync(root, { recursive: true });
  const cwd = mkdtempSync(join(root, "opencode-v2-"));
  dirs.push(cwd);
  const script = join(cwd, "fake.mjs");
  writeFileSync(script, `#!/usr/bin/env node
import { appendFileSync, existsSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
const args = process.argv.slice(2);
const record = (value) => appendFileSync(new URL("calls.jsonl", import.meta.url), JSON.stringify(value) + "\\n");
if (args[0] === "--version") {
  record({ probe: true });
  const failure = new URL("version-failure-once", import.meta.url);
  if (existsSync(failure)) { unlinkSync(failure); console.error("probe unavailable"); process.exit(1); }
  console.log("opencode v${major}.0.24"); process.exit(0);
}
if (args.some(a => ["--dir", "--pure", ${major === 2 ? '"--variant", "--verbose"' : '"--standalone"'}].includes(a))) { console.error("Unrecognized flag"); process.exit(1); }
if (args[0] === "api") { record({ args }); console.log(JSON.stringify({data:[{providerID:"provider",id:"free",cost:[{input:0,output:0}]}]})); process.exit(0); }
if (args[0] === "models") { record({args}); console.log("provider/model"); process.exit(0); }
if (args[0] === "stats") { record({args}); console.log(${major === 2 ? 'JSON.stringify({cost:0.125,tokens:{input:12,output:3}})' : '"Total Cost $0.125 Input 12 Output 3"'}); process.exit(0); }
if (args[0] === "run") {
  let prompt = "";
  process.stdin.on("data", chunk => prompt += chunk);
  process.stdin.on("end", () => {
    record({args, cwd:process.cwd(), pwd:process.env.PWD, config:process.env.OPENCODE_CONFIG_CONTENT, prompt});
    console.log(JSON.stringify({type:"text",sessionID:"same-session",part:{messageID:"m",text:"done"}}));
  });
} else if (args[0] === "serve") {
  let events;
  const emit = (type, data) => events.write("data: " + JSON.stringify({id:type, type, data:{sessionID:"ses_test",...data}}) + "\\n\\n");
  const server = createServer(async (req,res) => {
    const path = req.url;
    if (path === "/api/event") { events=res; res.writeHead(200,{"content-type":"text/event-stream"}); res.write(": connected\\n\\n"); return; }
    let text=""; for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : null;
    record({path,body,auth:req.headers.authorization,cwd:process.cwd()});
    if (path === "/api/session") { res.end(JSON.stringify({data:{id:"ses_test"}})); return; }
    if (path.endsWith("/prompt")) setTimeout(() => emit("permission.asked",{id:"per_test",action:"bash",resources:["echo hello"]}),10);
    if (path.endsWith("/reply")) setTimeout(() => {
      emit("session.text.ended",{assistantMessageID:"msg_test",ordinal:0,text:"done"});
      emit("session.execution.succeeded",{});
    },10);
    res.end(JSON.stringify({data:{}}));
  });
  server.listen(0,"127.0.0.1",()=>console.log("server listening on http://127.0.0.1:"+server.address().port));
}
`);
  const bin = process.platform === "win32" ? join(cwd, "opencode.cmd") : script;
  if (process.platform === "win32") writeFileSync(bin, '@ECHO off\r\n"%dp0%\\fake.mjs" %*\r\n');
  else chmodSync(script, 0o755);
  return { cwd, bin, calls: () => readFileSync(join(cwd, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)) };
}

it.each([1, 2])("uses process cwd and resumes with portable flags on OpenCode %i", async major => {
  const fixture = cli(major);
  const base = { ...fixture, prompt: "trivial prompt", model: "provider/model", effort: "low", timeoutSec: 10, log: nullLogger };
  const first = await delegateToOpencode({ ...base, autoApprove: true });
  await delegateToOpencode({ ...base, sessionId: first.sessionId, autoApprove: false });
  const calls = fixture.calls();
  expect(calls.filter(c => c.probe)).toHaveLength(1);
  const runs = calls.filter(c => c.args?.[0] === "run");
  expect(runs[0]).toMatchObject({ cwd: fixture.cwd, pwd: fixture.cwd, prompt: base.prompt });
  expect(runs[0].args).toEqual(expect.arrayContaining(["--format", "json", "--auto", "-m", major === 2 ? "provider/model#low" : "provider/model"]));
  expect(runs[1].args).toEqual(expect.arrayContaining(["-s", "same-session"]));
  expect(runs[1].args).not.toContain("--auto");
  expect(JSON.parse(runs[1].config).permission.bash).toBe("ask");
  expect(runs[0].args.includes("--standalone")).toBe(major === 2);
  expect(runs[0].args.includes("--variant")).toBe(major === 1);
});

it("forwards permissions over the v2 API and switches models on resume", async () => {
  const fixture = cli(2);
  const base = { ...fixture, prompt: "task", model: "provider/model", effort: "low", timeoutSec: 10, log: nullLogger,
    onPermission: async (req: any) => {
      expect(req).toMatchObject({ tool: "bash", detail: "echo hello", cwd: fixture.cwd });
      return { allow: false, message: "owner declined" };
    } };
  expect(await delegateToOpencodeServed(base)).toMatchObject({ text: "done", sessionId: "ses_test", isError: false });
  await delegateToOpencodeServed({ ...base, sessionId: "ses_test" });
  const calls = fixture.calls();
  expect(calls.find(c => c.path === "/api/session").body).toEqual({ location: { directory: fixture.cwd }, model: { providerID: "provider", id: "model", variant: "low" } });
  expect(calls.find(c => c.path?.endsWith("/reply")).body).toEqual({ decision: "reject", message: "owner declined" });
  expect(calls.find(c => c.path?.endsWith("/model")).body.model.variant).toBe("low");
  expect(calls.find(c => c.path?.endsWith("/prompt")).body).toEqual({ text: "task" });
  const mcp = new URL(calls.find(c => c.path?.startsWith("/api/mcp?")).path, "http://fixture");
  expect(mcp.searchParams.get("location[directory]")).toBe(fixture.cwd);
  expect(mcp.searchParams.has("directory")).toBe(false);
});

it.each([1, 2])("reads stats locally with V%i's output format", async major => {
  const fixture = cli(major);
  const report = await readUsage("opencode", fixture.bin, fixture.cwd, nullLogger);
  expect(report.lines[1]).toBe(`${major === 2 ? "Today" : "Last 24 hours"}: cost $0.125, 12 input tokens, 3 output tokens`);
  expect(fixture.calls().find(c => c.args?.[0] === "stats").args).toEqual(major === 2 ?
    ["stats", "--standalone", "--days", "1", "--json"] : ["stats", "--days", "1"]);
});

it("reads v2 model prices without the removed verbose flag", async () => {
  const fixture = cli(2);
  expect(await readOpencodeModelCosts(fixture.bin, fixture.cwd, nullLogger)).toEqual([{ id: "provider/free", input: 0, output: 0 }]);
  const args = fixture.calls().find(c => c.args).args;
  expect(args.slice(0, 3)).toEqual(["api", "--standalone", "GET"]);
  expect(new URL(args[3], "http://fixture").searchParams.get("location[directory]")).toBe(fixture.cwd);
});

it("rechecks a same-path upgraded executable before selecting V2 flags", async () => {
  const fixture = cli(1);
  expect(await opencodeV2(fixture.bin, fixture.cwd, nullLogger)).toBe(false);
  const script = join(fixture.cwd, "fake.mjs");
  writeFileSync(script, readFileSync(script, "utf8").replace('opencode v1.0.24', 'opencode v2.0.26'));
  expect(await opencodeV2(fixture.bin, fixture.cwd, nullLogger)).toBe(true);
  expect(fixture.calls().filter(c => c.probe)).toHaveLength(2);
});

it("does not retain a failed version probe or start a run with guessed V1 flags", async () => {
  const fixture = cli(2);
  writeFileSync(join(fixture.cwd, "version-failure-once"), "");
  await expect(delegateToOpencode({ ...fixture, prompt: "test", autoApprove: true, timeoutSec: 5, log: nullLogger })).rejects.toThrow("Could not detect opencode version");
  expect(fixture.calls().some(c => c.args?.[0] === "run")).toBe(false);
  expect(await opencodeV2(fixture.bin, fixture.cwd, nullLogger)).toBe(true);
  expect(fixture.calls().filter(c => c.probe)).toHaveLength(2);
});

it("lists v2 models with child configuration and caches per executable and directory", async () => {
  const first = cli(2), second = cli(1);
  expect(await listOpencodeModels(first.bin, first.cwd, nullLogger)).toEqual(["provider/model"]);
  await listOpencodeModels(first.bin, first.cwd, nullLogger);
  await listOpencodeModels(second.bin, second.cwd, nullLogger);
  expect(first.calls().filter(c => c.args?.[0] === "models").map(c => c.args)).toEqual([["models", "--standalone"]]);
  expect(second.calls().find(c => c.args?.[0] === "models").args).toEqual(["models"]);
});

it("does not classify paid context tiers or unknown prices as free", () => {
  expect(parseOpencodeModelCosts(JSON.stringify({data:[
    {providerID:"provider",id:"tiered",cost:[{input:0,output:0},{input:2,output:4,tier:{type:"context",size:100000}}]},
    {providerID:"provider",id:"unknown",cost:[]},
  ]}))).toEqual([{id:"provider/tiered",input:2,output:4}]);
});
