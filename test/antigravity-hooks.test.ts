import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AntigravityHooks } from "../src/mcp/antigravity-hooks.js";
import { buildHookResponse } from "../src/mcp/hooks.js";
import { antigravityHookCommand, requireAntigravityPlugin } from "../src/core/antigravity-plugin.js";
import { grantAntigravityBridgeMcp, installAntigravity } from "../src/cli/antigravity-install.js";
import { execFileSync } from "node:child_process";
import { makeEnv } from "./helpers.js";
import type { ServerContext } from "../src/mcp/server.js";
import { mkdirSync, writeFileSync } from "node:fs";

vi.mock("../src/core/procinfo.js", () => ({ antigravityAncestor: vi.fn(async () => 12345) }));
vi.mock("../src/mcp/hooks.js", () => ({ buildHookResponse: vi.fn() }));
afterEach(() => vi.clearAllMocks());

describe("Antigravity native hook routing", () => {
  it("executes Windows hook paths containing spaces and apostrophes with JSON stdin", async () => {
    if (process.platform !== "win32") return;
    const env = makeEnv(), cli = join(env.home, "owner's gate file.mjs");
    try {
      writeFileSync(cli, "let raw=''; for await (const part of process.stdin) raw+=part; process.stdout.write(JSON.stringify({input:JSON.parse(raw),args:process.argv.slice(2)}));");
      const [bin, ...args] = antigravityHookCommand(cli, "PreToolUse").split(" ");
      const output = execFileSync(bin!, args, { input: JSON.stringify({ text: "literal quotes \" and Unicode \u03b1" }), encoding: "utf8", windowsHide: true, timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] });
      expect(JSON.parse(output)).toEqual({ input: { text: "literal quotes \" and Unicode \u03b1" }, args: ["antigravity-hook", "PreToolUse"] });
    } finally { await env.cleanup(); }
  });
  it("adds only the plugin MCP permission and retains the original native settings", async () => {
    const env = makeEnv(), settings = join(env.home, "settings.json");
    const original = '{"permissions":{"allow":["command(git)"],"deny":["write_file(.git/)"],"ask":["command(*)"]},"owner":{"keep":true}}';
    try {
      writeFileSync(settings, original); grantAntigravityBridgeMcp(settings);
      const updated = readFileSync(settings, "utf8"); grantAntigravityBridgeMcp(settings);
      expect(readFileSync(settings, "utf8")).toBe(updated);
      expect(JSON.parse(updated)).toEqual({ permissions: { allow: ["command(git)", "mcp(agent-bridge_agent-bridge/*)"], deny: ["write_file(.git/)"], ask: ["command(*)"] }, owner: { keep: true } });
      const { readdirSync } = await import("node:fs");
      const backup = readdirSync(join(env.home, "archive"))[0]!;
      expect(readFileSync(join(env.home, "archive", backup), "utf8")).toBe(original);
      writeFileSync(settings, '{"permissions":{"allow":"invalid"}}');
      expect(() => grantAntigravityBridgeMcp(settings)).toThrow("preserved unchanged");
      expect(readFileSync(settings, "utf8")).toBe('{"permissions":{"allow":"invalid"}}');
    } finally { await env.cleanup(); }
  });
  it("authenticates mail, continues at Stop and isolates native children and replaced peers", async () => {
    const env = makeEnv(), node = Object.assign(new EventEmitter(), { currentSessionId: "parent" });
    const hooks = new AntigravityHooks({ home: env.home, node } as unknown as ServerContext);
    try {
      await hooks.start();
      const reg = JSON.parse(readFileSync(join(env.home, "antigravity-hooks", "12345.json"), "utf8"));
      const call = (event: string, id = "parent", secret = reg.secret) => fetch(`http://127.0.0.1:${reg.port}/hook`, { method: "POST", headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify({ event, input: { conversationId: id, workspacePaths: [env.home] } }) });
      expect((await call("Stop", "parent", "wrong")).status).toBe(403);
      vi.mocked(buildHookResponse).mockResolvedValueOnce({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "new mail" } });
      expect(await (await call("PreInvocation")).json()).toEqual({ injectSteps: [{ ephemeralMessage: "new mail" }] });
      expect(buildHookResponse).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sessionId: "parent", cwd: env.home }));
      vi.mocked(buildHookResponse).mockResolvedValueOnce({ decision: "block", reason: "result arrived" });
      expect(await (await call("Stop")).json()).toEqual({ decision: "continue", reason: "result arrived" });
      expect(await (await call("Stop", "child")).json()).toEqual({});
      expect(buildHookResponse).toHaveBeenCalledTimes(2);
      node.emit("replaced"); expect((await call("Stop")).status).toBe(403);
      writeFileSync(join(env.home, "antigravity-hooks", "12345.json"), '{"port":1,"secret":"replacement"}');
      node.emit("reclaimed"); vi.mocked(buildHookResponse).mockResolvedValue({});
      expect(JSON.parse(readFileSync(join(env.home, "antigravity-hooks", "12345.json"), "utf8"))).toEqual(reg);
      expect((await call("Stop")).status).toBe(200);
    } finally { await hooks.stop(); await env.cleanup(); }
  });
  it("rejects missing or disabled native permission gates before a CLI can run", async () => {
    const env = makeEnv(), source = join(env.home, "source"), target = join(env.home, "plugin");
    try {
      expect(() => requireAntigravityPlugin(target)).toThrow("install antigravity");
      mkdirSync(join(source, "dist"), { recursive: true });
      writeFileSync(join(source, "plugin.json"), '{"name":"agent-bridge"}');
      for (const name of ["server.mjs", "cli.mjs"]) writeFileSync(join(source, "dist", name), "// fixture");
      installAntigravity(source, target); expect(() => requireAntigravityPlugin(target)).not.toThrow();
      const hooks = JSON.parse(readFileSync(join(target, "hooks.json"), "utf8")); hooks["agent-bridge"].enabled = false;
      writeFileSync(join(target, "hooks.json"), JSON.stringify(hooks));
      expect(() => requireAntigravityPlugin(target)).toThrow("enabled agent-bridge");
    } finally { await env.cleanup(); }
  });
});
