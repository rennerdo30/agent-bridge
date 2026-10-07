import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { delegateToAntigravity } from "../src/core/antigravity.js";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv } from "./helpers.js";

vi.mock("../src/core/antigravity-plugin.js", () => ({ requireAntigravityPlugin: vi.fn() }));

/** Real process/stdio and cancellation, with a local fake CLI and no provider calls. */
function fakeCli(home: string): string {
  const dir = join(home, "cli"); mkdirSync(dir);
  const file = join(dir, process.platform === "win32" ? "fake.cjs" : "agy");
  writeFileSync(file, `#!/usr/bin/env node
let input = ''; process.stdin.on('data', part => input += part);
process.stdin.on('end', () => {
  const prompt = JSON.parse(input).message.content;
  const previous = process.argv.indexOf('--conversation');
  const id = previous > -1 ? process.argv[previous + 1] : 'fake-session';
  const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
  emit({event:'init',conversation_id:id,init:{model:'fake-model'}});
  if (prompt === 'hang') { setInterval(() => {}, 1000); return; }
  emit({event:'step_update',step_update:{tool_name:'view_file',text_delta:'checking'}});
  emit({event:'result',result:{conversation_id:id,status:'SUCCESS',response:prompt,usage:{total_tokens:1}}});
});
`);
  if (process.platform !== "win32") { chmodSync(file, 0o755); return file; }
  const shim = join(dir, "agy.cmd"); writeFileSync(shim, '@echo off\nnode "%dp0%\\fake.cjs" %*\n'); return shim;
}

describe("Antigravity process protocol", () => {
  it("round trips literal prompts and resumes the same session through real stdin/stdout", async () => {
    const env = makeEnv();
    try {
      const bin = fakeCli(env.home), onSession = vi.fn(), onProgress = vi.fn(), onInfo = vi.fn();
      const base = { bin, cwd: env.home, access: "read" as const, timeoutSec: 5, log: nullLogger, onSession, onProgress, onInfo };
      const result = await delegateToAntigravity({ ...base, prompt: 'literal "quotes" $() and new\nline' });
      expect(result).toMatchObject({ sessionId: "fake-session", isError: false, text: 'literal "quotes" $() and new\nline' });
      expect(onSession).toHaveBeenCalledWith("fake-session");
      expect(onProgress).toHaveBeenCalledWith("tool: view_file");
      expect(onInfo).toHaveBeenCalledWith(expect.objectContaining({ model: "fake-model", permission: "read" }));
      expect(await delegateToAntigravity({ ...base, prompt: "continued", sessionId: result.sessionId })).toMatchObject({ sessionId: "fake-session", text: "continued" });
    } finally { await env.cleanup(); }
  });
  it("cancels the process tree and retains the early conversation id", async () => {
    const env = makeEnv();
    try {
      const controller = new AbortController();
      await expect(delegateToAntigravity({ bin: fakeCli(env.home), cwd: env.home, prompt: "hang", access: "read", timeoutSec: 5, log: nullLogger, signal: controller.signal, onSession: () => controller.abort() })).rejects.toMatchObject({ kind: "aborted", sessionId: "fake-session" });
    } finally { await env.cleanup(); }
  });
});
