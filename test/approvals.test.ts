import { describe, expect, it } from "vitest";
import { hookRequest } from "../src/cli/permission-hook.js";
import { claudeForwardsPrompts, claudePermissionHookSettings } from "../src/core/delegate.js";
import { nullLogger } from "../src/core/logger.js";
import { OPENCODE_ASK_PERMISSIONS, opencodePermissionRequest } from "../src/core/opencode-served.js";
import { askRelay, PermissionRelay, type PermissionRequest } from "../src/core/relay.js";
import { opencodeEditAsks } from "../src/mcp/targets.js";

const approve = async () => ({ allow: true as const });

describe("Claude subagent permission prompts", () => {
  it("go to approve only in modes that may act, and only with someone to answer", () => {
    for (const mode of ["default", "manual", "plan"] as const) expect(claudeForwardsPrompts(mode, { approve, canApprove: true })).toBe(false);
    expect(claudeForwardsPrompts("acceptEdits", { approve, canApprove: true })).toBe(true);
    expect(claudeForwardsPrompts("auto", { approve, canApprove: true })).toBe(true);
    expect(claudeForwardsPrompts("acceptEdits", { approve, canApprove: false })).toBe(false);
    expect(claudeForwardsPrompts("acceptEdits", { approve })).toBe(false);
    expect(claudeForwardsPrompts("acceptEdits", { canApprove: true })).toBe(false);
  });

  it("are asked by a PermissionRequest command hook given through --settings", () => {
    const settings = JSON.parse(claudePermissionHookSettings("/p/dist/cli.mjs", "/bin/node"));
    expect(settings).toEqual({
      hooks: {
        PermissionRequest: [{ hooks: [{ type: "command", command: "/bin/node", args: ["/p/dist/cli.mjs", "permission-hook", "claude"], timeout: 900 }] }],
      },
    });
  });

  it("name MCP servers the way approve expects them (one allow per server)", () => {
    expect(hookRequest("claude", { tool_name: "mcp__plugin_x_desk__list_projects", tool_input: { a: 1 }, cwd: "/w" })).toEqual({
      agent: "claude",
      tool: "mcp:plugin_x_desk",
      detail: 'list_projects: {"a":1}',
      cwd: "/w",
    });
    expect(hookRequest("claude", { tool_name: "Bash", tool_input: { command: "git init x" } })).toEqual({ agent: "claude", tool: "Bash", detail: "git init x", cwd: undefined });
    // Codex requests keep their shape.
    expect(hookRequest("codex", { tool_name: "mcp__s__t", tool_input: { command: "ls" } }).tool).toBe("mcp__s__t");
  });

  it("reach the parent's decision through the relay, a denial with its reason", async () => {
    const seen: PermissionRequest[] = [];
    const relay = new PermissionRelay(async (r) => {
      seen.push(r);
      return r.tool === "mcp:desk" ? { allow: true } : { allow: false, message: "Denied by parent: no" };
    }, nullLogger);
    await relay.start();
    try {
      const env = relay.childEnv();
      expect(await askRelay(hookRequest("claude", { tool_name: "mcp__desk__list", tool_input: {} }), env)).toEqual({ allow: true });
      expect(await askRelay(hookRequest("claude", { tool_name: "Bash", tool_input: { command: "rm -rf x" } }), env)).toEqual({ allow: false, message: "Denied by parent: no" });
      expect(seen.map((r) => `${r.agent} ${r.tool}`)).toEqual(["claude mcp:desk", "claude Bash"]);
    } finally {
      await relay.stop();
    }
  });
});

describe("opencode subagent permission questions", () => {
  it("use served mode for edit runs with someone to answer, never for read or an explicit auto_approve", () => {
    const can = { approve, canApprove: true };
    expect(opencodeEditAsks(can, { access: "edit" })).toBe(true);
    expect(opencodeEditAsks(can, { access: "read" })).toBe(false);
    expect(opencodeEditAsks(can, {})).toBe(false);
    expect(opencodeEditAsks(can, { access: "edit", auto_approve: true })).toBe(false);
    expect(opencodeEditAsks(can, { access: "edit", auto_approve: false })).toBe(false);
    expect(opencodeEditAsks({ approve, canApprove: false }, { access: "edit" })).toBe(false);
    expect(opencodeEditAsks({ canApprove: true }, { access: "edit" })).toBe(false);
  });

  it("recognize MCP tools by their server prefix", () => {
    const servers = ["pair-desk", "pair", "my server"];
    expect(opencodePermissionRequest({ permission: "pair-desk_list_projects", patterns: ["*"] }, servers, "/w")).toEqual({
      agent: "opencode",
      tool: "mcp:pair-desk",
      detail: "pair-desk_list_projects: *",
      cwd: "/w",
    });
    expect(opencodePermissionRequest({ permission: "pair_x" }, servers, "/w").tool).toBe("mcp:pair");
    expect(opencodePermissionRequest({ permission: "my_server_go" }, servers, "/w").tool).toBe("mcp:my server");
    expect(opencodePermissionRequest({ permission: "external_directory", patterns: ["/tmp/x/*"] }, servers, "/w")).toEqual({
      agent: "opencode",
      tool: "external_directory",
      detail: "/tmp/x/*",
      cwd: "/w",
    });
    expect(opencodePermissionRequest({ permission: "bash", metadata: { command: "npm test" } }, [], "/w").detail).toBe("npm test");
  });

  it("ask mode still makes edits and commands ask", () => {
    expect(OPENCODE_ASK_PERMISSIONS).toEqual({ edit: "ask", bash: "ask" });
  });
});
