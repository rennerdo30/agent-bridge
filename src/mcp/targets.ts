import { z } from "zod";
import { CLAUDE_PERMISSION_MODES, CODEX_SANDBOXES, type BridgeConfig } from "../core/config.js";
import { delegateToClaude, delegateToCodex, delegateToOpencode, type DelegateRequest, type DelegateResult } from "../core/delegate.js";
import type { CodingAgent } from "../core/protocol.js";

/** Target-specific options accepted by ask_<agent> / spawn_<agent> on top of the common ones. */
export interface TargetArgs {
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

/** How to run each coding agent headlessly. Adding an agent means adding one entry here. */
export const DELEGATION_TARGETS: Record<CodingAgent, DelegationTarget> = {
  codex: {
    title: "OpenAI Codex",
    modelExample: '"gpt-6-sol"',
    defaultModel: (cfg) => cfg.codexModel,
    schema: { sandbox: z.enum(CODEX_SANDBOXES as [string, ...string[]]).optional() },
    permissionNote: (cfg) => `Codex runs in the "${cfg.codexSandbox}" sandbox unless you pass sandbox.`,
    run: (cfg, base, a) =>
      delegateToCodex({ ...base, bin: cfg.codexBin, sandbox: (a.sandbox as BridgeConfig["codexSandbox"]) ?? cfg.codexSandbox }),
  },
  claude: {
    title: "Claude Code",
    modelExample: '"opus", "sonnet" or a full model id',
    defaultModel: (cfg) => cfg.claudeModel,
    schema: { permission_mode: z.enum(CLAUDE_PERMISSION_MODES as [string, ...string[]]).optional() },
    permissionNote: (cfg) => `Claude runs with permission mode "${cfg.claudePermissionMode}" unless you pass permission_mode.`,
    run: (cfg, base, a) =>
      delegateToClaude({
        ...base,
        bin: cfg.claudeBin,
        permissionMode: (a.permission_mode as BridgeConfig["claudePermissionMode"]) ?? cfg.claudePermissionMode,
      }),
  },
  opencode: {
    title: "opencode",
    modelExample: '"provider/model", e.g. "anthropic/claude-sonnet-5" or "openai/gpt-6-sol"',
    defaultModel: (cfg) => cfg.opencodeModel,
    schema: { auto_approve: z.boolean().optional().describe("Auto-approve opencode permission requests (opencode run --auto)") },
    permissionNote: (cfg) =>
      cfg.opencodeAutoApprove
        ? "opencode auto-approves permission requests unless you pass auto_approve=false."
        : "Headless opencode rejects every permission request (edits, commands) unless you pass auto_approve=true.",
    run: (cfg, base, a) => delegateToOpencode({ ...base, bin: cfg.opencodeBin, autoApprove: a.auto_approve ?? cfg.opencodeAutoApprove }),
  },
};
