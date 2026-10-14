import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AntigravityHooks } from "../src/mcp/antigravity-hooks.js";
import { antigravityAncestor, lookup } from "../src/core/procinfo.js";
import { buildHookResponse } from "../src/mcp/hooks.js";
import { antigravityHookCommand, antigravityRootSession, registerAntigravityRoot, requireAntigravityPlugin } from "../src/core/antigravity-plugin.js";
import { grantAntigravityBridgeMcp, installAntigravity } from "../src/cli/antigravity-install.js";
import { execFileSync } from "node:child_process";
import { makeEnv } from "./helpers.js";
import type { ServerContext } from "../src/mcp/server.js";
import { mkdirSync, writeFileSync } from "node:fs";

vi.mock("../src/core/procinfo.js", () => ({ antigravityAncestor: vi.fn(async () => 12345), lookup: vi.fn(async () => ({ pid: 12345, ppid: 1, cmdline: "agy" })) }));
vi.mock("../src/core/process-identity.js", () => ({ processIdentity: (pid: number) => pid === 12345 ? "native-generation" : "bridge-generation" }));
vi.mock("../src/mcp/hooks.js", () => ({ buildHookResponse: vi.fn() }));
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
  it("defers child-first and missing-ID hooks until the adapter proves the root, then retains its binding across reload", async () => {
    const env = makeEnv(), node = Object.assign(new EventEmitter(), { currentSessionId: null });
    const ctx = { home: env.home, node } as unknown as ServerContext;
    const hooks = new AntigravityHooks(ctx), next = new AntigravityHooks(ctx);
    let release: (() => void) | undefined;
    const file = join(env.home, "antigravity-hooks", "12345.json");
    const call = async (id?: string) => {
      const reg = JSON.parse(readFileSync(file, "utf8"));
      return fetch(`http://127.0.0.1:${reg.port}/hook`, { method: "POST", headers: { authorization: `Bearer ${reg.secret}` }, body: JSON.stringify({ event: "PreInvocation", input: { conversationId: id } }) });
    };
    try {
      vi.mocked(buildHookResponse).mockResolvedValue({});
      await hooks.start();
      expect(await (await call("child")).json()).toEqual({});
      expect(await (await call("parent")).json()).toEqual({});
      expect(buildHookResponse).not.toHaveBeenCalled();
      expect(node.currentSessionId).toBeNull();
      release = registerAntigravityRoot(env.home, 12345, "parent");
      expect(await (await call()).json()).toEqual({});
      expect(await (await call("child")).json()).toEqual({});
      expect(await (await call("parent")).json()).toEqual({});
      expect(buildHookResponse).toHaveBeenCalledTimes(1);
      expect(JSON.parse(readFileSync(file, "utf8")).conversationId).toBe("parent");
      release(); release = undefined;
      // A new generation restores from the exact native process's private predecessor record.
      await next.start();
      const newBytes = readFileSync(file, "utf8");
      await hooks.stop();
      expect(readFileSync(file, "utf8")).toBe(newBytes);
      expect(node.listenerCount("reclaimed")).toBe(1);
      expect(await (await call("child")).json()).toEqual({});
      expect(await (await call("parent")).json()).toEqual({});
      expect(buildHookResponse).toHaveBeenCalledTimes(2);
      await next.stop();
      expect(existsSync(file)).toBe(false);
      expect(node.listenerCount("reclaimed")).toBe(0);
      node.emit("reclaimed");
      expect(existsSync(file)).toBe(false);
    } finally { release?.(); await next.stop(); await hooks.stop(); await env.cleanup(); }
  });
  it("uses inspected resume arguments and ignores stale process generations", async () => {
    const env = makeEnv(), node = Object.assign(new EventEmitter(), { currentSessionId: null });
    const hooks = new AntigravityHooks({ home: env.home, node } as unknown as ServerContext);
    try {
      mkdirSync(join(env.home, "antigravity-hooks"));
      writeFileSync(join(env.home, "antigravity-hooks", "12345.json"), JSON.stringify({ conversationId: "wrong", hostIdentity: "previous-generation" }), { mode: 0o600 });
      vi.mocked(lookup).mockResolvedValueOnce({ pid: 12345, ppid: 1, cmdline: '"/owner path/agy" --model example --conversation "parent"' });
      vi.mocked(buildHookResponse).mockResolvedValue({});
      await hooks.start();
      const reg = JSON.parse(readFileSync(join(env.home, "antigravity-hooks", "12345.json"), "utf8"));
      const call = (conversationId: string) => fetch(`http://127.0.0.1:${reg.port}/hook`, { method: "POST", headers: { authorization: `Bearer ${reg.secret}` }, body: JSON.stringify({ event: "Stop", input: { conversationId } }) });
      expect(reg.conversationId).toBe("parent");
      expect(await (await call("wrong")).json()).toEqual({});
      expect(await (await call("parent")).json()).toEqual({});
      expect(buildHookResponse).toHaveBeenCalledTimes(1);
    } finally { await hooks.stop(); await env.cleanup(); }
  });
  it("replaces a crashed adapter's reused PID binding but preserves a different current generation on cleanup", async () => {
    const env = makeEnv(), file = join(env.home, "antigravity-hooks", "12345.session.json");
    let release: (() => void) | undefined;
    try {
      mkdirSync(join(env.home, "antigravity-hooks"));
      writeFileSync(file, JSON.stringify({ hostPid: 12345, hostIdentity: "dead-generation", conversationId: "old" }), { mode: 0o600 });
      expect(antigravityRootSession(env.home, 12345, "native-generation")).toBeNull();
      release = registerAntigravityRoot(env.home, 12345, "parent");
      expect(antigravityRootSession(env.home, 12345, "native-generation")).toBe("parent");
      expect(() => registerAntigravityRoot(env.home, 12345, "child")).toThrow();
      const replacement = { hostPid: 12345, hostIdentity: "native-generation", conversationId: "parent", generation: "replacement" };
      writeFileSync(file, JSON.stringify(replacement));
      release(); release = undefined;
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(replacement);
    } finally { release?.(); await env.cleanup(); }
  });
  it("aborts admitted requests when a peer is replaced and suppresses stale output", async () => {
    const env = makeEnv(), node = Object.assign(new EventEmitter(), { currentSessionId: "parent" });
    const hooks = new AntigravityHooks({ home: env.home, node } as unknown as ServerContext);
    let entered!: () => void;
    const admission = new Promise<void>(resolve => { entered = resolve; });
    try {
      vi.mocked(buildHookResponse).mockImplementationOnce(async (_ctx, input) => {
        entered();
        await new Promise<void>(resolve => input.signal!.addEventListener("abort", () => resolve(), { once: true }));
        return { decision: "block", reason: "stale mail" };
      });
      await hooks.start();
      const reg = JSON.parse(readFileSync(join(env.home, "antigravity-hooks", "12345.json"), "utf8"));
      const pending = fetch(`http://127.0.0.1:${reg.port}/hook`, { method: "POST", headers: { authorization: `Bearer ${reg.secret}` }, body: JSON.stringify({ event: "Stop", input: { conversationId: "parent" } }) });
      await admission; node.emit("replaced");
      expect(await (await pending).json()).toEqual({});
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
