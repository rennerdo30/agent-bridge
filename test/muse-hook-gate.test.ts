import { describe, expect, it } from "vitest";
import { musePreToolUseGate } from "../src/cli/muse-hook.js";

const write = { tool_name: "write_file" };
const read = { tool_name: "read_file" };
const bridge = { tool_name: "mcp__plugin_agent_bridge_bridge__send" };

describe("Muse PreToolUse local gate", () => {
  it("asks for mutations in ask mode so the native approval reaches the supervisor", () => {
    expect(musePreToolUseGate(write, "ask", false)).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" },
    });
    expect(musePreToolUseGate(read, "ask", false)).toBeNull();
  });

  it("denies mutations in read mode and allows reading tools", () => {
    expect(musePreToolUseGate(write, "read", false)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "agent-bridge read access forbids this tool" },
    });
    expect(musePreToolUseGate(read, "read", false)).toBeNull();
  });

  it("leaves edit mode to native approvals and blocks native children from bridge tools", () => {
    expect(musePreToolUseGate(write, "edit", false)).toBeNull();
    expect(musePreToolUseGate(write, undefined, false)).toBeNull();
    expect(musePreToolUseGate(bridge, "edit", true)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    // A root session calling its own bridge tools is not a native child call.
    expect(musePreToolUseGate(bridge, "read", false)).toBeNull();
  });
});
