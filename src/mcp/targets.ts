import { z } from "zod";
import { CLAUDE_PERMISSION_MODES, CODEX_SANDBOXES, type BridgeConfig, type ClaudePermissionMode, type CodexSandbox } from "../core/config.js";
import { delegateToClaude, delegateToCodex, delegateToOpencode, type DelegateRequest, type DelegateResult } from "../core/delegate.js";
import type { CodingAgent } from "../core/protocol.js";

/** Generic access level; each target maps it to its own permission vocabulary. */
export type Access = "read" | "edit";
export const ACCESS_LEVELS: readonly Access[] = ["read", "edit"];

/** Target-specific options accepted by ask_<agent> / spawn_<agent> on top of the common ones. */
export interface TargetArgs {
  access?: Access;
  sandbox?: string;
  permission_mode?: string;
  auto_approve?: boolean;
}

export interface DelegationTarget {
  title: string;
  modelExample: string;
  defaultModel: (cfg: BridgeConfig) => string | null;
  /** Extra zod fields for the tool schema. */
  schema: Record<string, z.ZodTypeAny>;
  permissionNote: (cfg: BridgeConfig) => string;
  run: (cfg: BridgeConfig, base: DelegateRequest, args: TargetArgs) => Promise<DelegateResult>;
}

const CODEX_SANDBOX_FOR: Record<Access, CodexSandbox> = { read: "read-only", edit: "workspace-write" };
/** "read" = manual mode plus a deny list for editing and shell tools (see delegate.ts). */
const CLAUDE_MODE_FOR: Record<Access, ClaudePermissionMode> = { read: "manual", edit: "acceptEdits" };
const OPENCODE_AUTO_FOR: Record<Access, boolean> = { read: false, edit: true };

/** How to run each coding agent headlessly. Adding an agent means adding one entry here. */
export const DELEGATION_TARGETS: Record<CodingAgent, DelegationTarget> = {
  codex: {
    title: "OpenAI Codex",
    modelExample: '"gpt-6-sol"',
    defaultModel: (cfg) => cfg.codexModel,
    schema: { sandbox: z.enum(CODEX_SANDBOXES as [string, ...string[]]).optional().describe("Overrides access with an exact Codex sandbox mode") },
    permissionNote: (cfg) => `Codex runs in the "${cfg.codexSandbox}" sandbox unless you pass access or sandbox.`,
    run: (cfg, base, a) =>
      delegateToCodex({
        ...base,
        bin: cfg.codexBin,
        sandbox: (a.sandbox as CodexSandbox | undefined) ?? (a.access ? CODEX_SANDBOX_FOR[a.access] : cfg.codexSandbox),
      }),
  },
  claude: {
    title: "Claude Code",
    modelExample: '"opus", "sonnet" or a full model id',
    defaultModel: (cfg) => cfg.claudeModel,
    schema: { permission_mode: z.enum(CLAUDE_PERMISSION_MODES as [string, ...string[]]).optional().describe("Overrides access with an exact Claude permission mode") },
    permissionNote: (cfg) => `Claude runs with permission mode "${cfg.claudePermissionMode}" unless you pass access or permission_mode.`,
    run: (cfg, base, a) =>
      delegateToClaude({
        ...base,
        bin: cfg.claudeBin,
        permissionMode: (a.permission_mode as ClaudePermissionMode | undefined) ?? (a.access ? CLAUDE_MODE_FOR[a.access] : cfg.claudePermissionMode),
      }),
  },
  opencode: {
    title: "opencode",
    modelExample: '"provider/model", e.g. "anthropic/claude-sonnet-5" or "opencode/muse-spark-1.3-contributor-free"',
    defaultModel: (cfg) => cfg.opencodeModel,
    schema: { auto_approve: z.boolean().optional().describe("Overrides access: auto-approve every opencode permission request (opencode run --auto)") },
    permissionNote: (cfg) =>
      cfg.opencodeAutoApprove
        ? "opencode auto-approves permission requests unless you pass access=read or auto_approve=false."
        : "Headless opencode rejects every permission request (edits, commands) unless you pass access=edit or auto_approve=true.",
    run: (cfg, base, a) =>
      delegateToOpencode({
        ...base,
        bin: cfg.opencodeBin,
        autoApprove: a.auto_approve ?? (a.access ? OPENCODE_AUTO_FOR[a.access] : cfg.opencodeAutoApprove),
      }),
  },
};
