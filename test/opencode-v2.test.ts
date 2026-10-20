import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { delegateToOpencode, opencodeV2 } from "../src/core/delegate.js";
import { delegateToOpencodeServed } from "../src/core/opencode-served.js";
import { nullLogger } from "../src/core/logger.js";
import { parseOpencodeModelCosts, readOpencodeModelCosts, readUsage } from "../src/core/usage.js";
import { listOpencodeModels } from "../src/core/opencode-models.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { readModels } from "../src/core/models.js";
import { answerHistory } from "../src/core/history-answer.js";
import type { HistoryResult } from "../src/core/history.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
function cli(major: number, exitOnStdinEnd = false) {
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
    // V2 reconciliation may emit text without a final step_finish; never use it as completion proof.
    if (${major === 1}) console.log(JSON.stringify({type:"step_finish",sessionID:"same-session",part:{messageID:"m",reason:"stop"}}));
  });
} else if (args[0] === "serve") {
  record({args, cwd:process.cwd(), pwd:process.env.PWD, config:process.env.OPENCODE_CONFIG_CONTENT});
  // V2 ties the private server's lifetime to its parent's stdin pipe.
  if (${exitOnStdinEnd}) {
    process.stdin.resume();
    process.stdin.on("end", () => setTimeout(() => process.exit(0), 50));
  }
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
    },${exitOnStdinEnd ? 200 : 10});
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

it.each([1, 2])("uses process cwd and resumes with the supported V%i transport", async major => {
  const fixture = cli(major);
  const base = { ...fixture, prompt: "trivial prompt", model: "provider/model", effort: "low", timeoutSec: 10, log: nullLogger };
  const first = await delegateToOpencode({ ...base, autoApprove: true });
  await delegateToOpencode({ ...base, sessionId: first.sessionId, autoApprove: false });
  const calls = fixture.calls();
  expect(calls.filter(c => c.probe)).toHaveLength(1);
  const runs = calls.filter(c => c.args?.[0] === "run");
  if (major === 2) {
    expect(runs).toHaveLength(0);
    const serves = calls.filter(c => c.args?.[0] === "serve");
    expect(serves).toHaveLength(2);
    expect(serves[0]).toMatchObject({ cwd: fixture.cwd, pwd: fixture.cwd });
    expect(serves[0].config).toBeUndefined();
    const readOnly = JSON.parse(serves[1].config);
    expect(readOnly.permission).toEqual({ edit: "deny", bash: "deny" });
    expect(readOnly.tools).toMatchObject({ "*_*": false, bridge_ask_muse: true, bridge_spawn_muse: true,
      bridge_ask_codex: true, bridge_spawn_claude: true, bridge_send: true });
    expect(readOnly.tools.unrelated_write).toBeUndefined();
    expect(calls.find(c => c.path?.endsWith("/model")).path).toBe("/api/session/ses_test/model");
    expect(calls.find(c => c.path?.endsWith("/model")).body.model).toEqual({ providerID: "provider", id: "model", variant: "low" });
    expect(calls.filter(c => c.path?.endsWith("/prompt")).map(c => c.body)).toEqual([{ text: base.prompt }, { text: base.prompt }]);
    return;
  }
  expect(runs[0]).toMatchObject({ cwd: fixture.cwd, pwd: fixture.cwd, prompt: base.prompt });
  expect(runs[0].args).toEqual(expect.arrayContaining(["--format", "json", "--auto", "-m", major === 2 ? "provider/model#low" : "provider/model"]));
  expect(runs[1].args).toEqual(expect.arrayContaining(["-s", "same-session"]));
  expect(runs[1].args).not.toContain("--auto");
  expect(JSON.parse(runs[1].config).permission.bash).toBe("deny");
  const readOnly = JSON.parse(runs[1].config);
  expect(readOnly.permission).toEqual({ edit: "deny", bash: "deny" });
  expect(readOnly.tools).toMatchObject({ "*_*": false, bridge_ask_muse: true, bridge_spawn_muse: true,
    bridge_ask_codex: true, bridge_spawn_claude: true, bridge_send: true });
  expect(readOnly.tools.unrelated_write).toBeUndefined();
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

it("keeps the private V2 server alive when it shuts down on stdin EOF", async () => {
  const fixture = cli(2, true);
  const result = await delegateToOpencodeServed({ ...fixture, prompt: "reply OK", model: "provider/model",
    timeoutSec: 10, log: nullLogger, permissions: null,
    onPermission: async () => ({ allow: false, message: "fixture declines" }) });
  expect(result).toMatchObject({ text: "done", sessionId: "ses_test", isError: false });
  expect(fixture.calls().some(c => c.path?.endsWith("/reply"))).toBe(true);
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

it("fails a served delegation clearly before starting its private server", async () => {
  const fixture = cli(2);
  writeFileSync(join(fixture.cwd, "version-failure-once"), "");
  await expect(delegateToOpencodeServed({ ...fixture, prompt: "test", timeoutSec: 5, log: nullLogger,
    onPermission: async () => ({ allow: false, message: "fixture declines" }) })).rejects.toMatchObject({ name: "DelegateError", kind: "failed", message: "Could not detect opencode version", stderrTail: expect.stringContaining("probe unavailable") });
  expect(fixture.calls().every(c => c.probe)).toBe(true);
});

it("degrades usage and model listing after a failed probe and retries rather than caching the error", async () => {
  const fixture = cli(2);
  const fail = () => writeFileSync(join(fixture.cwd, "version-failure-once"), "");
  const cfg = { ...DEFAULT_CONFIG, opencodeBin: fixture.bin };
  fail();
  expect(await readUsage("opencode", fixture.bin, fixture.cwd, nullLogger)).toMatchObject({
    lines: ["Could not read usage: Could not detect opencode version"], limits: [], maxUsedPercent: null,
  });
  fail();
  expect(await readModels("opencode", cfg, fixture.cwd, nullLogger, fixture.cwd)).toMatchObject({
    models: [], lines: ["Could not list opencode models: Could not detect opencode version"],
  });
  fail();
  await expect(readOpencodeModelCosts(fixture.bin, fixture.cwd, nullLogger)).rejects.toThrow("Could not detect opencode version");
  expect(fixture.calls().every(c => c.probe)).toBe(true);
  expect((await readModels("opencode", cfg, fixture.cwd, nullLogger, fixture.cwd)).models).toEqual(["provider/model"]);
  expect((await readUsage("opencode", fixture.bin, fixture.cwd, nullLogger)).lines[1]).toContain("Today: cost $0.125");
});

it("contains history-answer cost and runner probe failures without running a model", async () => {
  const fixture = cli(2);
  const cfg = { ...DEFAULT_CONFIG, opencodeBin: fixture.bin,
    historyAnswer: { ...DEFAULT_CONFIG.historyAnswer, preference: ["opencode" as const], opencodeModel: "provider/model" } };
  const result: HistoryResult = { engine: "fts5", hits: [{ id: "message:fixture", kind: "message", agent: "opencode", at: 1,
    snippet: "synthetic fixture", link: "", sourceLink: "/synthetic/fixture", message: null, job: null, run: null, session: null, cursor: null }] };
  const deps = { available: () => true,
    usage: async () => ({ agent: "opencode" as const, lines: [], limits: [], maxUsedPercent: null }),
    models: async () => ({ agent: "opencode" as const, models: ["provider/model"], defaultModel: null, lines: [] }) };
  writeFileSync(join(fixture.cwd, "version-failure-once"), "");
  expect(await answerHistory("fixture", result, cfg, fixture.cwd, nullLogger, deps)).toMatchObject({
    agent: null, error: "No configured cheap model is available with usable limits.",
  });
  writeFileSync(join(fixture.cwd, "version-failure-once"), "");
  const answer = await answerHistory("fixture", result, cfg, fixture.cwd, nullLogger, {
    ...deps, costs: async () => [{ id: "provider/model", input: 0, output: 0 }],
  });
  expect(answer).toMatchObject({ agent: "opencode", text: "", error: expect.stringContaining("History answer failed: DelegateError: Could not detect opencode version") });
  expect(fixture.calls().every(c => c.probe)).toBe(true);
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
