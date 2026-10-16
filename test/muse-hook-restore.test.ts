import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";

const context = vi.hoisted(() => ({
  restoreMuseContext: vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 30)); return true; }),
  museHostPid: vi.fn(async () => 123),
  museHookFile: vi.fn((_host: number, session: string) => session),
  readMusePrivateJson: vi.fn(),
}));
vi.mock("../src/core/muse-context.js", () => ({ ...context, MUSE_ACCESS_ENV: "AGENT_BRIDGE_MUSE_ACCESS" }));
vi.mock("../src/core/process-identity.js", () => ({ processIdentity: (pid: number) => `identity-${pid}` }));

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.clearAllMocks();
});
async function fixture() {
  vi.stubEnv("MUSE_SESSION_ID", "hook-root"); vi.stubEnv("MUSE_THREAD_ID", "hook-root");
  vi.stubEnv("AGENT_BRIDGE_INTERNAL", "1"); vi.stubEnv("AGENT_BRIDGE_MUSE_ACCESS", "read");
  let output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((part: any) => { output += String(part); return true; });
  let tool = "read_file";
  vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () { yield JSON.stringify({ tool_name: tool }); return undefined; });
  const events: string[] = [];
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer fixture-capability") { res.writeHead(403).end(); return; }
    let raw = ""; for await (const part of req) raw += part;
    const body = JSON.parse(raw); events.push(body.event);
    res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: body.event, additionalContext: `mail-${body.event}` } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address() as { port: number };
  context.readMusePrivateJson.mockReturnValue({ session: "hook-root", hostIdentity: "identity-123", pid: 456, identity: "identity-456", port: address.port, secret: "fixture-capability" });
  const call = async (event: string) => {
    tool = event === "PreToolUse" ? "write_file" : "read_file";
    // Each native hook is a fresh CLI, so module-local caches cannot make this pass.
    vi.resetModules(); const { runMuseHook } = await import("../src/cli/muse-hook.js");
    output = ""; expect(await runMuseHook(event)).toBe(0); return JSON.parse(output);
  };
  return { call, events };
}

describe("Muse callback restore overhead", () => {
  it("delivers five callbacks across fresh entry points without repeated host restore", async () => {
    const { call, events } = await fixture();
    const start = performance.now();
    for (const event of ["PostToolUse", "PostToolUse", "PreLLMCall", "PostToolUse", "Stop"]) {
      expect(await call(event)).toMatchObject({ hookSpecificOutput: { additionalContext: `mail-${event}` } });
    }
    const elapsedMs = +(performance.now() - start).toFixed(2);
    vi.mocked(process.stdout.write).mockRestore();
    console.error(JSON.stringify({ harness: "AB-386", at: new Date().toISOString(), calls: events.length, elapsedMs, restores: context.restoreMuseContext.mock.calls.length }));
    expect(context.restoreMuseContext).not.toHaveBeenCalled();
    expect(events).toEqual(["PostToolUse", "PostToolUse", "PreLLMCall", "PostToolUse", "Stop"]);
  });

  it("reauthenticates when the event changes to a permission decision and refuses a forged handoff", async () => {
    const { call, events } = await fixture();
    await call("PostToolUse");
    context.restoreMuseContext.mockResolvedValueOnce(false);
    expect(await call("PreToolUse")).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(context.restoreMuseContext).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["PostToolUse"]);
  });

  it("reads the current registration on every callback and rejects a replaced binding", async () => {
    const { call, events } = await fixture();
    await call("PostToolUse");
    context.readMusePrivateJson.mockReturnValue({ session: "hook-root", hostIdentity: "forged" });
    expect(await call("PreLLMCall")).toEqual({});
    expect(events).toEqual(["PostToolUse"]);
    expect(context.readMusePrivateJson).toHaveBeenCalledTimes(2);
  });
});
