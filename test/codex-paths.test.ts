import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { codexDriveMappings, codexPathPrompt, codexPathReport, resolveCodexDriveMappings } from "../src/core/codex-paths.js";
import { delegateToCodex } from "../src/core/delegate.js";
import { delegateToCodexAppServer } from "../src/core/codex-appserver.js";
import { nullLogger } from "../src/core/logger.js";
import { preferredDriveFixture } from "./preferred-drive-fixture.js";
import { configurePathDisplay, refreshDriveAliases } from "../src/core/display-paths.js";

describe("Codex drive aliases", () => {
  it("keeps reports cached while native preparation revalidates newly created aliases", async () => {
    const roots: Record<string, string> = {};
    const canonical = vi.fn(async (path: string) => roots[path] ?? path);
    expect(codexDriveMappings("X:/report", "win32", canonical)).toEqual([]);
    expect(canonical).not.toHaveBeenCalled();
    await refreshDriveAliases("win32", canonical);
    expect(canonical).toHaveBeenCalledTimes(26);
    roots["X:\\"] = "C:\\new-worktree";
    expect(codexDriveMappings("X:/report", "win32", canonical)).toEqual([]);
    expect(canonical).toHaveBeenCalledTimes(26);
    expect(await resolveCodexDriveMappings("X:/report", "win32", canonical)).toEqual([{ alias: "X:\\", real: "C:\\new-worktree\\" }]);
    expect(canonical).toHaveBeenCalledTimes(27);
    delete roots["X:\\"];
    expect(await resolveCodexDriveMappings("X:/report", "win32", canonical)).toEqual([]);
  });

  it("rechecks requested roots after an older background probe finishes", async () => {
    let finish!: (path: string) => void;
    let created = false;
    const canonical = vi.fn((path: string) => {
      if (path !== "X:\\") return Promise.resolve(path);
      if (created) return Promise.resolve("C:\\new-worktree");
      return new Promise<string>((resolve) => { finish = resolve; });
    });
    expect(codexDriveMappings("X:/report", "win32", canonical)).toEqual([]);
    const refresh = refreshDriveAliases("win32", canonical);
    await Promise.resolve(); await Promise.resolve();
    created = true;
    const preparation = resolveCodexDriveMappings("X:/report", "win32", canonical);
    finish("X:\\");
    await refresh;
    expect(await preparation).toEqual([{ alias: "X:\\", real: "C:\\new-worktree\\" }]);
    expect(canonical.mock.calls.filter(([path]) => path === "X:\\")).toHaveLength(2);
  });
  it("shares discovered whole-drive mappings across notes and full-access prompts, with opt-out", async () => {
    const roots: Record<string, string> = { "X:\\": "C:\\", "Q:\\": "D:\\", "R:\\": "C:\\subfolder" };
    const restore = await preferredDriveFixture(roots), canonical = (path: string) => roots[path] ?? path;
    try {
      await refreshDriveAliases("win32", canonical);
      const mappings = codexDriveMappings("Read C:/repo and D:/report", "win32", canonical);
      expect(mappings).toEqual([{ alias: "Q:\\", real: "D:\\" }, { alias: "X:\\", real: "C:\\" }]);
      const prompt = "Read C:/repo and write D:/new.md";
      const formatted = codexPathPrompt(prompt, mappings, true);
      expect(formatted).toContain("Read X:/repo and write Q:/new.md");
      expect(codexPathPrompt(formatted, mappings, true)).toBe(formatted);
      expect(codexPathReport(mappings)).toContain("preferred Q:\\");
      expect(codexPathReport(mappings)).toContain("preferred X:\\");
      configurePathDisplay({ preferAlias: false });
      expect(codexPathPrompt(prompt, mappings, true)).toContain(prompt);
      expect(codexPathReport(mappings)).toContain("Alias display preference is disabled");
      expect(codexPathReport(mappings)).not.toContain("preferred");
    } finally { configurePathDisplay({ preferAlias: true }); restore(); }
  });
  it("prefers verified X: display and preserves full-access prompt spellings", async () => {
    const restore = await preferredDriveFixture();
    try {
      const mappings = [{ alias: "X:\\", real: "Q:\\" }];
      const prompt = "Read X:/repo and write Q:/future.md";
      const text = codexPathPrompt(prompt, mappings, true);
      expect(text).toContain("Read X:/repo and write X:/future.md");
      expect(codexPathPrompt(text, mappings, true)).toBe(text);
      expect(codexPathReport(mappings)).toContain("preferred X:\\ (verified drive alias)");
      expect(codexPathReport(mappings)).not.toContain("Q:\\");
    } finally { restore(); }
  });
  it("replaces previous mapping notes without self-equations or duplicates", () => {
    const mappings = [{ alias: "X:\\", real: "Q:\\" }];
    const report = codexPathReport(mappings)!;
    const once = codexPathPrompt(`Write X:/new.md\n${report}`, mappings);
    expect(codexPathPrompt(once, mappings)).toBe(once);
    expect(once).not.toContain("Q:\\ = Q:\\");
    expect(once.match(/Windows drive aliases resolved/g)).toHaveLength(1);
    expect(codexPathPrompt("task\nWindows path mappings (same folders): Q:\\ = Q:\\.", [])).toBe("task");
    expect(codexPathReport([{ alias: "Q:\\", real: "q:\\" }])).toBeNull();
  });
  it("resolves referenced drive roots and rewrites even nonexistent report destinations", async () => {
    const prompt = "Read E:/Development/repo and write e:\\Development\\new-report.md; keep D:/other";
    const canonical = (p: string) => p === "E:\\" ? "D:\\" : p;
    await refreshDriveAliases("win32", canonical);
    const mappings = codexDriveMappings(prompt, "win32", canonical);
    expect(mappings).toEqual([{ alias: "E:\\", real: "D:\\" }]);
    const mapped = codexPathPrompt(prompt, mappings);
    expect(mapped).toContain("Read D:\\Development/repo");
    expect(mapped).toContain("write D:\\Development\\new-report.md");
    expect(mapped).toContain("E:\\ (physical drive D:\\)");
    expect(mapped).toContain("without requesting path confirmation");
    expect(codexPathReport(mappings)).toContain("E:\\");
  });

  it("supports subst roots pointing below a drive and namespaced native paths", async () => {
    const folder = () => "\\\\?\\D:\\workspace", unc = () => "\\\\?\\UNC\\server\\share";
    await refreshDriveAliases("win32", folder); await refreshDriveAliases("win32", unc);
    expect(codexDriveMappings("X:/repo", "win32", folder)).toEqual([{ alias: "X:\\", real: "D:\\workspace\\" }]);
    expect(codexDriveMappings("X:/repo", "win32", unc)).toEqual([{ alias: "X:\\", real: "\\\\server\\share\\" }]);
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
