import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexDriveMappings, codexPathPrompt, codexPathReport } from "../src/core/codex-paths.js";
import { delegateToCodex } from "../src/core/delegate.js";
import { delegateToCodexAppServer } from "../src/core/codex-appserver.js";
import { nullLogger } from "../src/core/logger.js";
import { preferredDriveFixture } from "./preferred-drive-fixture.js";

describe("Codex drive aliases", () => {
  it("prefers verified E: display and preserves full-access prompt spellings", () => {
    const restore = preferredDriveFixture();
    try {
      const mappings = [{ alias: "E:\\", real: "Q:\\" }];
      const prompt = "Read E:/repo and write Q:/future.md";
      const text = codexPathPrompt(prompt, mappings, true);
      expect(text).toContain("Read E:/repo and write E:/future.md");
      expect(codexPathPrompt(text, mappings, true)).toBe(text);
      expect(codexPathReport(mappings)).toContain("preferred E:\\ (verified drive alias)");
      expect(codexPathReport(mappings)).not.toContain("Q:\\");
    } finally { restore(); }
  });
  it("replaces previous mapping notes without self-equations or duplicates", () => {
    const mappings = [{ alias: "E:\\", real: "Q:\\" }];
    const report = codexPathReport(mappings)!;
    const once = codexPathPrompt(`Write E:/new.md\n${report}`, mappings);
    expect(codexPathPrompt(once, mappings)).toBe(once);
    expect(once).not.toContain("Q:\\ = Q:\\");
    expect(once.match(/Windows drive aliases resolved/g)).toHaveLength(1);
    expect(codexPathPrompt("task\nWindows path mappings (same folders): Q:\\ = Q:\\.", [])).toBe("task");
    expect(codexPathReport([{ alias: "Q:\\", real: "q:\\" }])).toBeNull();
  });
  it("resolves referenced drive roots and rewrites even nonexistent report destinations", () => {
    const prompt = "Read E:/Development/repo and write e:\\Development\\new-report.md; keep D:/other";
    const mappings = codexDriveMappings(prompt, "win32", (p) => p === "E:\\" ? "D:\\" : p);
    expect(mappings).toEqual([{ alias: "E:\\", real: "D:\\" }]);
    const mapped = codexPathPrompt(prompt, mappings);
    expect(mapped).toContain("Read D:\\Development/repo");
    expect(mapped).toContain("write D:\\Development\\new-report.md");
    expect(mapped).toContain("E:\\ (physical drive D:\\)");
    expect(mapped).toContain("without requesting path confirmation");
    expect(codexPathReport(mappings)).toContain("E:\\");
  });

  it("supports subst roots pointing below a drive and namespaced native paths", () => {
    expect(codexDriveMappings("X:/repo", "win32", () => "\\\\?\\D:\\workspace")).toEqual([{ alias: "X:\\", real: "D:\\workspace\\" }]);
    expect(codexDriveMappings("X:/repo", "win32", () => "\\\\?\\UNC\\server\\share")).toEqual([{ alias: "X:\\", real: "\\\\server\\share\\" }]);
  });

  it("leaves unknown drives and non-Windows prompts unchanged", () => {
    const prompt = "E:/unknown";
    expect(codexDriveMappings(prompt, "win32", () => { throw new Error("missing"); })).toEqual([]);
    expect(codexDriveMappings(prompt, "linux")).toEqual([]);
    expect(codexPathPrompt(prompt, [])).toBe(prompt);
    expect(codexPathPrompt(`${prompt}\n `, [])).toBe(`${prompt}\n `);
    expect(codexPathReport([])).toBeNull();
  });

  it.skipIf(process.platform !== "win32")("runs exec and app-server in the real path for a temporary subst drive", async () => {
    const root = process.env.AGENT_BRIDGE_TEST_ROOT!;
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(join(root, "subst-"));
    const drive = ["Z:", "Y:", "X:", "W:"].find((d) => !existsSync(`${d}\\`));
    if (!drive) throw new Error("No unused drive for the subst regression test");
    const record = `const fs = require("node:fs"); const { createInterface } = require("node:readline"); const rl = createInterface({input:process.stdin}); const send = (m) => console.log(JSON.stringify(m)); rl.on("line", (s) => { const m=JSON.parse(s); fs.appendFileSync("requests.jsonl", s+"\\n"); if(m.id===undefined)return; let result={}; if(m.method==="thread/start")result={thread:{id:"thread"}}; if(m.method==="turn/start")result={turn:{id:"turn"}}; send({id:m.id,result}); if(m.method==="turn/start"){send({method:"item/completed",params:{turnId:"turn",item:{type:"agentMessage",text:"done"}}});send({method:"turn/completed",params:{turn:{id:"turn",status:"completed"}}});} });`;
    writeFileSync(join(dir, "app-server"), record);
    writeFileSync(join(dir, "exec"), `const fs = require("node:fs"); let input=""; process.stdin.on("data",d=>input+=d); process.stdin.on("end",()=>{fs.writeFileSync("prompt.txt",input); console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"done"}}));});`);
    let mapped = false;
    try {
      execFileSync("subst", [drive, dir]); mapped = true;
      const cwd = `${drive}\\`;
      const prompt = `Write ${drive}/new-report.md`;
      await delegateToCodex({ bin: process.execPath, cwd, prompt, sandbox: "read-only", timeoutSec: 10, log: nullLogger });
      // When the repo itself sits on a subst drive (E: for D:), the real path is reported on the backing drive.
      const tail = dir.slice(2);
      expect(readFileSync(join(dir, "prompt.txt"), "utf8")).toContain(`${tail}\\new-report.md`);
      await delegateToCodexAppServer({ bin: process.execPath, cwd, prompt, sandbox: "read-only", timeoutSec: 10, log: nullLogger });
      const calls = readFileSync(join(dir, "requests.jsonl"), "utf8").trim().split("\n").map((s) => JSON.parse(s));
      expect(calls.find((c) => c.method === "thread/start").params.cwd.slice(2)).toBe(tail);
      expect(calls.find((c) => c.method === "turn/start").params.input[0].text).toContain(`${tail}\\new-report.md`);
    } finally {
      if (mapped) execFileSync("subst", [drive, "/D"]);
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
