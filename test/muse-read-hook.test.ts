import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// AB-384: the handoff restore (DPAPI/CIM PowerShell, up to 15 s) and the endpoint
// round trip must not decide known reads. Simulate both as slow or absent.
const slow = vi.hoisted(() => ({ restoreMs: 400, restored: false }));
vi.mock("../src/core/muse-context.js", async original => ({
  ...await original<typeof import("../src/core/muse-context.js")>(),
  restoreMuseContext: vi.fn(async (env: NodeJS.ProcessEnv = process.env) => {
    await new Promise(resolve => setTimeout(resolve, slow.restoreMs));
    if (!slow.restored) { delete env.AGENT_BRIDGE_MUSE_ACCESS; env.AGENT_BRIDGE_INTERNAL = "1"; }
    return slow.restored;
  }),
  // No Bridge endpoint is reachable: the host (and so the broker) is absent.
  museHostPid: vi.fn(async () => null),
}));

const { restoreMuseContext } = await import("../src/core/muse-context.js");
const { runMuseHook } = await import("../src/cli/muse-hook.js");

async function preToolUse(input: Record<string, unknown>): Promise<{ output: Record<string, any>; ms: number }> {
  const stdin = Object.getOwnPropertyDescriptor(process, "stdin")!;
  Object.defineProperty(process, "stdin", { configurable: true, value: Readable.from([JSON.stringify(input)]) });
  let written = "";
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => { written += String(chunk); return true; });
  const started = performance.now();
  try { await runMuseHook("PreToolUse"); }
  finally { write.mockRestore(); Object.defineProperty(process, "stdin", stdin); }
  return { output: JSON.parse(written), ms: performance.now() - started };
}

const denied = (reason?: string) => ({ hookSpecificOutput: { permissionDecision: "deny", ...(reason ? { permissionDecisionReason: reason } : {}) } });

describe("Muse read-mode PreToolUse with a slow or absent Bridge (AB-384)", () => {
  beforeEach(() => {
    vi.mocked(restoreMuseContext).mockClear();
    vi.stubEnv("AGENT_BRIDGE_INTERNAL", "1");
    vi.stubEnv("AGENT_BRIDGE_MUSE_ACCESS", "read");
    vi.stubEnv("MUSE_SESSION_ID", "read-root");
    vi.stubEnv("MUSE_THREAD_ID", "read-root");
    slow.restored = false;
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it.each(["read_file", "list_dir", "grep_search", "glob", "mcp__plugin_agent_bridge_bridge__health", "mcp__plugin_agent_bridge_bridge__peers"])("allows %s locally within 100 ms without the handoff or endpoint", async tool => {
    const { output, ms } = await preToolUse({ tool_name: tool, tool_input: { path: "package.json" } });
    expect(output).toEqual({});
    expect(ms).toBeLessThan(100);
    expect(restoreMuseContext).not.toHaveBeenCalled();
  });

  it("still denies mutations when the handoff cannot be authenticated", async () => {
    for (const tool of ["write_file", "edit_file", "powershell", "bash", "shell"]) {
      expect((await preToolUse({ tool_name: tool })).output).toMatchObject(denied("agent-bridge permission gate unavailable"));
    }
  });

  it("denies mutations by read policy once the handoff is authenticated, even with no endpoint", async () => {
    slow.restored = true;
    for (const tool of ["write_file", "powershell"]) {
      expect((await preToolUse({ tool_name: tool })).output).toMatchObject(denied("agent-bridge read access forbids this tool"));
    }
  });

  it("fails closed for unknown and mutating Bridge tools", async () => {
    for (const input of [{}, { tool_name: "" }, { tool_name: "mcp__other_server__delete_everything" }, { tool_name: "durable_muse_tool" }, { tool_name: "mcp__plugin_agent_bridge_bridge__send" }, { tool_name: "mcp__plugin_agent_bridge_bridge__spawn_codex" }]) {
      expect((await preToolUse(input)).output).toMatchObject(denied());
    }
  });

  it("keeps native children away from root Bridge tools, including read-only ones", async () => {
    vi.stubEnv("MUSE_THREAD_ID", "native-child");
    expect((await preToolUse({ tool_name: "mcp__plugin_agent_bridge_bridge__health" })).output).toMatchObject(denied());
    expect((await preToolUse({ tool_name: "read_file" })).output).toEqual({});
  });
});
