import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AntigravityHooks } from "../src/mcp/antigravity-hooks.js";
import { postAntigravityHook } from "../src/cli/antigravity-hook.js";
import { antigravityAncestor } from "../src/core/procinfo.js";
import { buildHookResponse, confirmAntigravityStopDelivery } from "../src/mcp/hooks.js";
import { antigravityHookCommand, requireAntigravityPlugin } from "../src/core/antigravity-plugin.js";
import { grantAntigravityBridgeMcp, installAntigravity } from "../src/cli/antigravity-install.js";
import { execFileSync } from "node:child_process";
import { makeEnv } from "./helpers.js";
import type { ServerContext } from "../src/mcp/server.js";
import { mkdirSync, writeFileSync } from "node:fs";

vi.mock("../src/core/procinfo.js", () => ({ antigravityAncestor: vi.fn(async () => 12345) }));
vi.mock("../src/mcp/hooks.js", () => ({ buildHookResponse: vi.fn(), confirmAntigravityStopDelivery: vi.fn() }));
afterEach(() => vi.clearAllMocks());

describe("Antigravity native hook routing", () => {
  it("skips native process inspection for an internal server without an inbox", async () => {
    const hooks = new AntigravityHooks({ node: null, parent: null } as unknown as ServerContext);
    await hooks.start();
    expect(antigravityAncestor).not.toHaveBeenCalled();
    await hooks.stop();
  });
  it.each(["read", "ask", "edit"])("fails closed for malformed delegated %s tool input", async (access) => {
    const env = makeEnv();
    try {
      const output = execFileSync(process.execPath, [join(import.meta.dirname, "..", "plugins", "antigravity", "dist", "cli.mjs"), "antigravity-hook", "PreToolUse"], { input: "{", encoding: "utf8", env: { ...process.env, AGENT_BRIDGE_HOME: env.home, AGENT_BRIDGE_ANTIGRAVITY_ACCESS: access } });
      expect(JSON.parse(output)).toMatchObject({ decision: "deny" });
    } finally { await env.cleanup(); }
  });
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
      const backup = readdirSync(env.home).find((file) => file.startsWith("settings.json.backup-"))!;
      expect(readFileSync(join(env.home, backup), "utf8")).toBe(original);
      writeFileSync(settings, '{"permissions":{"allow":"invalid"}}');
      expect(() => grantAntigravityBridgeMcp(settings)).toThrow("preserved unchanged");
      expect(readFileSync(settings, "utf8")).toBe('{"permissions":{"allow":"invalid"}}');
    } finally { await env.cleanup(); }
  });
  it("authenticates mail, continues at Stop and isolates native children and replaced peers", async () => {
    const env = makeEnv();
    const setSessionId = vi.fn(async () => {}), ensureConnected = vi.fn(async () => {}), learnCwd = vi.fn(async () => {});
    const node = Object.assign(new EventEmitter(), { currentSessionId: "parent", setSessionId, ensureConnected });
    const hooks = new AntigravityHooks({ home: env.home, node, learnCwd } as unknown as ServerContext);
    try {
      await hooks.start();
      const reg = JSON.parse(readFileSync(join(env.home, "antigravity-hooks", "12345.json"), "utf8"));
      const call = (event: string, id = "parent", secret = reg.secret, extra: Record<string, unknown> = {}) => fetch(`http://127.0.0.1:${reg.port}/hook`, { method: "POST", headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify({ event, input: { conversationId: id, workspacePaths: [env.home], ...extra } }) });
      expect((await call("Stop", "parent", "wrong")).status).toBe(403);
      // PreToolUse learns session/cwd and confirms pending Stop mail without calling buildHookResponse (F1).
      expect(await (await call("PreToolUse", "parent", reg.secret)).json()).toEqual({});
      expect(setSessionId).toHaveBeenCalledWith("parent");
      expect(learnCwd).toHaveBeenCalledWith(env.home);
      expect(ensureConnected).toHaveBeenCalledTimes(1);
      expect(confirmAntigravityStopDelivery).toHaveBeenCalledTimes(1);
      expect(buildHookResponse).not.toHaveBeenCalled();
      // Zero-based invocationNum=0 on initial prompt -> Stop(executionNum=0) -> continuation invocationNum=1 sets stopHookActive:true.
      vi.mocked(buildHookResponse).mockResolvedValueOnce({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "new mail" } });
      expect(await (await call("PreInvocation", "parent", reg.secret, { invocationNum: 0 })).json()).toEqual({ injectSteps: [{ ephemeralMessage: "new mail" }] });
      expect(buildHookResponse).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sessionId: "parent", cwd: env.home, stopHookActive: false }));
      vi.mocked(buildHookResponse).mockResolvedValueOnce({ decision: "block", reason: "result arrived" });
      expect(await (await call("Stop", "parent", reg.secret, { executionNum: 0, terminationReason: "NO_TOOL_CALL" })).json()).toEqual({ decision: "continue", reason: "result arrived" });
      vi.mocked(buildHookResponse).mockResolvedValueOnce({});
      expect(await (await call("PreInvocation", "parent", reg.secret, { invocationNum: 1 })).json()).toEqual({});
      expect(buildHookResponse).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ event: "UserPromptSubmit", stopHookActive: true }));
      // If Stop continuation is not taken and a fresh turn starts at invocationNum=0, stopHookActive is false.
      vi.mocked(buildHookResponse).mockResolvedValueOnce({ decision: "block", reason: "second result" });
      expect(await (await call("Stop", "parent", reg.secret, { executionNum: 1, terminationReason: "NO_TOOL_CALL" })).json()).toEqual({ decision: "continue", reason: "second result" });
      vi.mocked(buildHookResponse).mockResolvedValueOnce({});
      expect(await (await call("PreInvocation", "parent", reg.secret, { invocationNum: 0 })).json()).toEqual({});
      expect(buildHookResponse).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ event: "UserPromptSubmit", stopHookActive: false }));
      // Repeated Stop at the same executionNum or with a cap terminationReason maps to StopFailure without continuing.
      vi.mocked(buildHookResponse).mockResolvedValueOnce({ decision: "block", reason: "third result" });
      expect(await (await call("Stop", "parent", reg.secret, { executionNum: 1, terminationReason: "NO_TOOL_CALL" })).json()).toEqual({ decision: "continue", reason: "third result" });
      expect(await (await call("Stop", "child")).json()).toEqual({});
      vi.mocked(buildHookResponse).mockResolvedValueOnce({});
      expect(await (await call("Stop", "parent", reg.secret, { executionNum: 1, terminationReason: "NO_TOOL_CALL" })).json()).toEqual({});
      expect(buildHookResponse).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ event: "StopFailure" }));
      vi.mocked(buildHookResponse).mockResolvedValueOnce({});
      expect(await (await call("Stop", "parent", reg.secret, { executionNum: 2, terminationReason: "MAX_FORCED_INVOCATIONS" })).json()).toEqual({});
      expect(buildHookResponse).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ event: "StopFailure" }));
      node.emit("replaced"); expect((await call("Stop")).status).toBe(403);
      writeFileSync(join(env.home, "antigravity-hooks", "12345.json"), '{"port":1,"secret":"replacement"}');
      node.emit("reclaimed"); vi.mocked(buildHookResponse).mockResolvedValue({});
      expect(JSON.parse(readFileSync(join(env.home, "antigravity-hooks", "12345.json"), "utf8"))).toEqual(reg);
      expect((await call("Stop")).status).toBe(200);
      vi.mocked(buildHookResponse).mockResolvedValueOnce({ decision: "block", reason: "held mail" });
      expect(await (await call("Stop", "parent", reg.secret, { executionNum: 3, terminationReason: "NO_TOOL_CALL" })).json()).toEqual({ decision: "continue", reason: "held mail" });
      vi.mocked(confirmAntigravityStopDelivery).mockClear();
      vi.mocked(antigravityAncestor).mockImplementationOnce((_start, signal) => new Promise((resolve) => {
        signal?.addEventListener("abort", () => resolve(null), { once: true });
      }));
      expect(await postAntigravityHook("PreToolUse", { conversationId: "parent", workspacePaths: [env.home] }, 50, env.home)).toEqual({});
      expect(confirmAntigravityStopDelivery).not.toHaveBeenCalled();
      expect(await postAntigravityHook("PreToolUse", { conversationId: "parent", workspacePaths: [env.home] }, 1_500, env.home)).toEqual({});
      expect(confirmAntigravityStopDelivery).toHaveBeenCalledTimes(1);
    } finally { await hooks.stop(); await env.cleanup(); }
  });
  it("rejects missing or disabled native permission gates before a CLI can run", async () => {
    const env = makeEnv(), source = join(env.home, "source"), target = join(env.home, "plugin");
    try {
      expect(() => requireAntigravityPlugin(target)).toThrow("install antigravity");
      mkdirSync(join(source, "dist"), { recursive: true });
      writeFileSync(join(source, "plugin.json"), '{"name":"agent-bridge"}');
      writeFileSync(join(source, "package.json"), '{"version":"0.1.0"}');
      for (const name of ["server.mjs", "worker.mjs", "cli.mjs", "history-worker.mjs"]) writeFileSync(join(source, "dist", name), "// fixture");
      installAntigravity(source, target); expect(() => requireAntigravityPlugin(target)).not.toThrow();
      const hooks = JSON.parse(readFileSync(join(target, "hooks.json"), "utf8")); hooks["agent-bridge"].enabled = false;
      writeFileSync(join(target, "hooks.json"), JSON.stringify(hooks));
      expect(() => requireAntigravityPlugin(target)).toThrow("enabled agent-bridge");
    } finally { await env.cleanup(); }
  });
});
