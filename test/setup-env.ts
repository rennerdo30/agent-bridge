import { vi } from "vitest";

// Unit and integration tests inspect commands, never display desktop notifications on the developer's PC.
vi.mock("../src/core/notifications.js", async (original) => ({
  ...await original<typeof import("../src/core/notifications.js")>(),
  notifyJobEvent: vi.fn(),
}));

/**
 * When the suite runs inside an agent-bridge subagent, these point at that subagent's real parent session:
 * fake subagents started by the tests would then message it ("ping from opencode"). Tests start clean.
 * Spelled out here on purpose: importing src/ from a setup file would load modules before tests mock them.
 * Keep in sync with PARENT_*_ENV (src/core/parent-link.ts) and DELEGATE_DEPTH_ENV (src/core/delegate.ts).
 */
const INHERITED_LINK_ENV = ["AGENT_BRIDGE_PARENT_URL", "AGENT_BRIDGE_PARENT_TOKEN", "AGENT_BRIDGE_PARENT_NAME", "AGENT_BRIDGE_DELEGATE_DEPTH"];

for (const name of INHERITED_LINK_ENV) delete process.env[name];
