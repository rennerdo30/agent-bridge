import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type OpencodeNativeAccess = "read" | "ask" | "edit";
export const OPENCODE_NATIVE_GATE_ID = "agent-bridge-native-tools";
export const OPENCODE_NATIVE_ACTION_PREFIX = "native.opencode.";

/** Serialized into a private, per-run plugin. Keep this function free of module closures/imports. */
export async function installOpencodeNativeToolGate(ctx: any, access: OpencodeNativeAccess): Promise<void> {
  const mutations = new Set(["opencode_worktree_create", "opencode_session_move", "opencode_session_rename"]);
  const prefix = "native.opencode.";
  // Force a fresh decision even if native config, --auto, or saved approvals would allow this action.
  await ctx.permission.hook("evaluate", (event: any) => {
    if (event.action.startsWith(prefix)) event.effect = "ask";
  });
  await ctx.tool.hook("execute.before", async (event: any) => {
    if (event.tool === "opencode_worktree_remove") {
      throw new Error("agent-bridge: native worktree removal is unavailable to delegated jobs; use Bridge cleanup.");
    }
    if (!mutations.has(event.tool)) return;
    if (access === "read") throw new Error(`agent-bridge: ${event.tool} is denied in read mode.`);
    if (access !== "ask") return;
    await ctx.permission.assert({
      sessionID: event.sessionID,
      agent: event.agent,
      action: prefix + event.tool.slice("opencode_".length),
      // The full target session and arguments must be reviewable; no per-server or saved grant.
      resources: [JSON.stringify(event.input)],
      save: [],
    });
  });
}

/** OpenCode accepts local plugin directories. No dependency install or interactive config mutation. */
export function createOpencodeNativeToolPlugin(access: OpencodeNativeAccess): { directory: string; dispose(): void } {
  const directory = mkdtempSync(join(tmpdir(), "agent-bridge-opencode-gate-"));
  const manifest = join(directory, "package.json");
  const entry = join(directory, "index.js");
  writeFileSync(manifest, JSON.stringify({ name: OPENCODE_NATIVE_GATE_ID, type: "module", main: "index.js" }));
  writeFileSync(entry, `export default { id: ${JSON.stringify(OPENCODE_NATIVE_GATE_ID)}, setup: async ctx => { await (${installOpencodeNativeToolGate.toString()})(ctx, ${JSON.stringify(access)}); } };\n`);
  return { directory, dispose() {
    // Only our two generated files, never recursive cleanup of a plugin path or its target.
    unlinkSync(entry);
    unlinkSync(manifest);
    rmdirSync(directory);
  } };
}

export function hasOpencodeNativeTools(version: string): boolean {
  const match = /(?:^|\s)(?:opencode\s+)?v?(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?(?:\s|$)/.exec(version.trim());
  return Boolean(match && (Number(match[1]) > 2 || Number(match[1]) === 2 &&
    (Number(match[2]) > 0 || Number(match[3]) >= 27)));
}
