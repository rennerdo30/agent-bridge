import { fileURLToPath } from "node:url";

/** Run in Muse's hook process so its actual host stays the immediate parent. */
export async function runMusePluginHook(event) {
  process.argv = [process.execPath, fileURLToPath(new URL("../dist/cli.mjs", import.meta.url)), "muse-hook", event];
  try {
    await import("../dist/cli.mjs");
  } catch {
    process.stdout.write(JSON.stringify(event === "PreToolUse" ? {
      hookSpecificOutput: { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: "agent-bridge permission gate unavailable" },
    } : {}));
  }
}
