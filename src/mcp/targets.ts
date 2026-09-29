import { z } from "zod";
import { CLAUDE_PERMISSION_MODES, CODEX_SANDBOXES, type BridgeConfig, type ClaudePermissionMode, type CodexSandbox } from "../core/config.js";
import { DelegateError, delegateToClaude, delegateToCodex, delegateToOpencode, type DelegateRequest, type DelegateResult } from "../core/delegate.js";
import { listOpencodeModels, resolveOpencodeModel } from "../core/opencode-models.js";
import { delegateToOpencodeServed } from "../core/opencode-served.js";
import { delegateToCodexAppServer } from "../core/codex-appserver.js";

/** Set to 1 to run Codex subagents with `codex exec` (no live messages) instead of `codex app-server`. */
export const CODEX_EXEC_ENV = "AGENT_BRIDGE_CODEX_EXEC";
import type { CodingAgent } from "../core/protocol.js";
import type { PermissionDecision, PermissionRequest } from "../core/relay.js";

/**
 * Generic access level; each target maps it to its own permission vocabulary.
 *  - read: look only
 *  - ask:  look; anything more is forwarded to the user in the parent session (where supported)
 *  - edit: may change files
 */
export type Access = "read" | "ask" | "edit";
export const ACCESS_LEVELS: readonly Access[] = ["read", "ask", "edit"];

/** Wiring for access "ask", prepared by the caller for one run. */
export interface RelayWiring {
  onPermission: (r: PermissionRequest) => Promise<PermissionDecision>;
  env: Record<string, string>;
  codexHookTrusted: boolean;
}

/** Target-specific options accepted by ask_<agent> / spawn_<agent> on top of the common ones. */
export interface TargetArgs {
  access?: Access;
  relay?: RelayWiring;
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

const CODEX_SANDBOX_FOR: Record<Access, CodexSandbox> = { read: "read-only", ask: "read-only", edit: "workspace-write" };
/** "read" = manual mode plus a deny list for editing and shell tools (see delegate.ts). "ask" is not forwarded for Claude yet. */
const CLAUDE_MODE_FOR: Record<Access, ClaudePermissionMode> = { read: "manual", ask: "manual", edit: "acceptEdits" };
const OPENCODE_AUTO_FOR: Record<Access, boolean> = { read: false, ask: false, edit: true };

/** Whether a target can forward permission requests in this setup (else "ask" behaves like "read"). */
export function supportsAsk(target: CodingAgent, relay: RelayWiring | undefined): boolean {
  if (!relay) return false;
  if (target === "opencode") return true;
  if (target === "codex") return relay.codexHookTrusted;
  return false;
}

/** How to run each coding agent headlessly. Adding an agent means adding one entry here. */
export const DELEGATION_TARGETS: Record<CodingAgent, DelegationTarget> = {
  codex: {
    title: "OpenAI Codex",
    modelExample: '"gpt-6-sol"',
    defaultModel: (cfg) => cfg.codexModel,
    schema: { sandbox: z.enum(CODEX_SANDBOXES as [string, ...string[]]).optional().describe("Overrides access with an exact Codex sandbox mode") },
    permissionNote: (cfg) => `Codex runs in the "${cfg.codexSandbox}" sandbox unless you pass access or sandbox.`,
    run: async (cfg, base, a) => {
      const sandbox = (a.sandbox as CodexSandbox | undefined) ?? (a.access ? CODEX_SANDBOX_FOR[a.access] : cfg.codexSandbox);
      const relay = a.access === "ask" && supportsAsk("codex", a.relay);
      // app-server lets messages reach the running subagent (turn/steer). "ask" runs keep exec: their
      // approvals go through the PermissionRequest hook, which is wired for exec.
      if (!relay && process.env[CODEX_EXEC_ENV] !== "1") {
        try {
          return await delegateToCodexAppServer({ ...base, bin: cfg.codexBin, sandbox });
        } catch (err) {
          // Older Codex without app-server (or one that cannot start it): the run never began, use exec.
          if (!(err instanceof DelegateError) || err.kind !== "failed" || err.sessionId) throw err;
          base.log.warn("codex app-server unavailable, using codex exec", { err: err.message });
        }
      }
      return delegateToCodex({
        ...base,
        bin: cfg.codexBin,
        sandbox,
        ...(relay ? { relayApprovals: true, extraEnv: { ...base.extraEnv, ...a.relay!.env } } : {}),
      });
    },
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
    run: async (cfg, base, a) => {
      // Resolve short or partial model names first: an unknown model must fail fast, not hang.
      let note: string | null = null;
      if (base.model) {
        const models = await listOpencodeModels(cfg.opencodeBin, base.cwd, base.log).catch(() => []);
        const r = resolveOpencodeModel(base.model, models);
        if ("error" in r) throw new DelegateError(r.error, "failed");
        base = { ...base, model: r.model };
        note = r.note;
      }
      const res =
        a.access === "ask" && a.auto_approve === undefined && supportsAsk("opencode", a.relay)
          ? await delegateToOpencodeServed({ ...base, bin: cfg.opencodeBin, onPermission: a.relay!.onPermission })
          : await delegateToOpencode({
              ...base,
              bin: cfg.opencodeBin,
              autoApprove: a.auto_approve ?? (a.access ? OPENCODE_AUTO_FOR[a.access] : cfg.opencodeAutoApprove),
            });
      return note ? { ...res, text: `(${note})\n\n${res.text}` } : res;
    },
  },
};
