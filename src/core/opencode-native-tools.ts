import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type OpencodeNativeAccess = "read" | "ask" | "edit";
export const OPENCODE_NATIVE_GATE_ID = "agent-bridge-native-tools";
export const OPENCODE_NATIVE_ACTION_PREFIX = "native.opencode.";
/** Bumped whenever the plugin's report or hook contract changes; the Bridge refuses any other value. */
export const OPENCODE_NATIVE_GATE_CONTRACT = 1;
export const OPENCODE_NATIVE_GATE_HOOKS = ["permission.evaluate", "tool.execute.before"] as const;
/** Native identities the gate was proven against (AB-316 evidence); read/ask refuse an inventory without them. */
export const OPENCODE_NATIVE_GATED_TOOLS = ["opencode_worktree_create", "opencode_worktree_remove", "opencode_session_move", "opencode_session_rename"] as const;
const GATE_REPORT_FILE = "gate-report.json";

export type OpencodeNativeToolKind = "remove" | "mutation" | "safe" | "unknown" | "other";
export interface OpencodeNativeGateReport {
  contract: number;
  access: string;
  hooks: string[];
  inventory: string[] | null;
  /** Random per-job value from the generated entry; proves the report belongs to this run. */
  nonce?: string;
}

/**
 * Serialized into the plugin too. Keep it free of module closures/imports. Fail closed: only the explicitly known
 * identities below get their known treatment. Every other id (a native tool added by a later release, a renamed
 * removal tool, any MCP tool outside the Bridge routes) is "unknown" and needs a per-call gate approval in every
 * mode. Ids are matched exactly; no substring or prefix rule grants or denies anything.
 */
export function classifyOpencodeNativeTool(id: unknown): OpencodeNativeToolKind {
  if (typeof id !== "string" || !id) return "unknown";
  const known: Record<string, OpencodeNativeToolKind> = {
    // Known removal identity: unavailable to delegated jobs in every mode, edit included.
    opencode_worktree_remove: "remove",
    opencode_worktree_create: "mutation",
    opencode_session_move: "mutation",
    opencode_session_rename: "mutation",
    // Read-only natives in the proven 2.0.29 inventory. The MCP resource tools are not here: they forward to
    // configured MCP servers whose side effects the gate cannot see, so they stay unknown and gated.
    opencode_worktree_list: "safe",
    opencode_models: "safe",
    // Built-ins of the proven 2.0.29 inventory plus the Code Mode wrapper; opencode's own permission rules and the
    // delegated tool map govern them, and nested native calls reach this hook under their own ids.
    execute: "other", edit: "other", glob: "other", grep: "other", patch: "other", question: "other", read: "other",
    shell: "other", skill: "other", subagent: "other", webfetch: "other", websearch: "other", write: "other",
    // Bridge routes allowed in read-only runs (OPENCODE_READ_ONLY_TOOLS); a test keeps the two lists equal.
    bridge_send: "other", bridge_report_progress: "other", bridge_checklist: "other", bridge_peers: "other", bridge_health: "other",
    bridge_search_history: "other", bridge_get_conversation: "other", bridge_spawn: "other", bridge_ask: "other", bridge_message_subagent: "other", bridge_cancel_subagent: "other",
    bridge_pause_subagent: "other", bridge_resume_subagent: "other", bridge_inbox: "other", bridge_wait_for_message: "other",
  };
  return Object.prototype.hasOwnProperty.call(known, id) ? known[id]! : "unknown";
}

/** Serialized into a private, per-run plugin. Keep this function free of module closures/imports. */
export async function installOpencodeNativeToolGate(
  ctx: any,
  access: OpencodeNativeAccess,
  classify: (id: unknown) => OpencodeNativeToolKind = classifyOpencodeNativeTool,
): Promise<OpencodeNativeGateReport> {
  const prefix = "native.opencode.";
  const shapeError = (what: string) => new Error(`agent-bridge: unexpected native ${what} hook shape; refusing the call.`);
  // The enforcement contract: without these entry points nothing below is enforced, so plugin setup fails.
  if (typeof ctx?.permission?.hook !== "function" || typeof ctx?.tool?.hook !== "function") {
    throw new Error("agent-bridge: OpenCode plugin API lacks permission/tool hooks; native tools cannot be gated.");
  }
  if (access === "ask" && typeof ctx.permission.assert !== "function") {
    throw new Error("agent-bridge: OpenCode plugin API lacks permission.assert; native tools cannot ask for approval.");
  }
  const hooks: string[] = [];
  // Force a fresh decision even if native config, --auto, or saved approvals would allow this action.
  await ctx.permission.hook("evaluate", (event: any) => {
    if (!event || typeof event !== "object") throw shapeError("permission");
    if (typeof event.action !== "string") {
      // Not provably unrelated to a native mutation: read denies, ask needs a decision, edit is unchanged.
      if (access === "read") event.effect = "deny";
      else if (access === "ask") event.effect = "ask";
      return;
    }
    if (event.action.startsWith(prefix)) event.effect = "ask";
  });
  hooks.push("permission.evaluate");
  await ctx.tool.hook("execute.before", async (event: any) => {
    // Without a tool identity the call could be a removal, so it is refused in every mode.
    if (!event || typeof event !== "object" || typeof event.tool !== "string" || !event.tool) throw shapeError("tool");
    const kind = classify(event.tool);
    if (kind === "remove") {
      throw new Error("agent-bridge: native worktree removal is unavailable to delegated jobs; use Bridge cleanup.");
    }
    if (kind === "other" || kind === "safe") return;
    // Known mutations keep their mode treatment; unknown ids need a fresh gate decision in every mode.
    if (kind === "mutation" && access === "edit") return;
    if (kind === "mutation" && access !== "ask") throw new Error(`agent-bridge: ${event.tool} is denied in read mode.`);
    if (typeof ctx.permission.assert !== "function") {
      throw new Error(`agent-bridge: ${event.tool} needs approval, but the OpenCode plugin API lacks permission.assert; refusing the call.`);
    }
    if (typeof event.sessionID !== "string" || !event.sessionID) throw shapeError("tool");
    let resource: string | undefined;
    try { resource = JSON.stringify(event.input === undefined ? null : event.input); } catch { throw shapeError("tool"); }
    if (typeof resource !== "string") throw shapeError("tool");
    await ctx.permission.assert({
      sessionID: event.sessionID,
      agent: event.agent,
      action: prefix + event.tool.replace(/^opencode_/, ""),
      // The full target session and arguments must be reviewable; no per-server or saved grant.
      resources: [resource],
      save: [],
    });
  });
  hooks.push("tool.execute.before");
  let inventory: string[] | null = null;
  try {
    if (typeof ctx.tool.list === "function") {
      const listed = await ctx.tool.list();
      if (Array.isArray(listed)) {
        const ids = listed.map((t: any) => typeof t === "string" ? t : t?.id);
        if (ids.every((id: unknown) => typeof id === "string" && id)) inventory = ids;
      }
    }
  } catch { inventory = null; }
  return { contract: 1, access, hooks, inventory };
}

/**
 * Why a gate report does not prove enforcement for this access, or null when it does. Extra inventory ids are
 * accepted but never trusted: the classifier treats every id it does not know as unknown, so each call is gated.
 */
export function opencodeNativeGateReportError(report: unknown, access: OpencodeNativeAccess, nonce?: string): string | null {
  if (!report || typeof report !== "object") return "reported no enforcement contract";
  const r = report as Partial<OpencodeNativeGateReport>;
  if (nonce !== undefined && r.nonce !== nonce) return "wrote a report that does not belong to this job";
  if (r.contract !== OPENCODE_NATIVE_GATE_CONTRACT) return `reported unsupported contract ${JSON.stringify(r.contract)}`;
  if (r.access !== access) return `was installed for ${JSON.stringify(r.access)} instead of ${JSON.stringify(access)}`;
  if (!Array.isArray(r.hooks) || OPENCODE_NATIVE_GATE_HOOKS.some(h => !r.hooks!.includes(h))) return "did not register its enforcement hooks";
  // Every mode, edit included: removal protection is only proven against this inventory.
  if (!Array.isArray(r.inventory) || !r.inventory.every(id => typeof id === "string")) return "could not read the native tool inventory";
  const missing = OPENCODE_NATIVE_GATED_TOOLS.filter(id => !r.inventory!.includes(id));
  if (missing.length) return `found a native tool inventory without ${missing.join(", ")}; the native tool API is unknown`;
  return null;
}

/** OpenCode accepts local plugin directories. No dependency install or interactive config mutation. */
export function createOpencodeNativeToolPlugin(access: OpencodeNativeAccess): { directory: string; nonce: string; report(): unknown; dispose(): void } {
  const nonce = randomBytes(16).toString("hex");
  const directory = mkdtempSync(join(tmpdir(), "agent-bridge-opencode-gate-"));
  const manifest = join(directory, "package.json");
  const entry = join(directory, "index.js");
  const reportFile = join(directory, GATE_REPORT_FILE);
  writeFileSync(manifest, JSON.stringify({ name: OPENCODE_NATIVE_GATE_ID, type: "module", main: "index.js" }));
  writeFileSync(entry, `import { writeFileSync } from "node:fs";
export default { id: ${JSON.stringify(OPENCODE_NATIVE_GATE_ID)}, setup: async ctx => {
  const report = await (${installOpencodeNativeToolGate.toString()})(ctx, ${JSON.stringify(access)}, (${classifyOpencodeNativeTool.toString()}));
  writeFileSync(new URL(${JSON.stringify(`./${GATE_REPORT_FILE}`)}, import.meta.url), JSON.stringify({ ...report, nonce: ${JSON.stringify(nonce)} }));
} };
`);
  return { directory, nonce, report() {
    try { return JSON.parse(readFileSync(reportFile, "utf8")); } catch { return null; }
  }, dispose() {
    // Only our generated files, never recursive cleanup of a plugin path or its target.
    try { unlinkSync(reportFile); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    unlinkSync(entry);
    unlinkSync(manifest);
    rmdirSync(directory);
  } };
}

export type OpencodeApi = "v1" | "v2" | "v2-native" | "unknown";
const VERSION_LINE_RE = /^\s*(?:opencode\s+)?v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\s*$/i;

/**
 * Exactly one SemVer line (prerelease and build metadata included) is a known version; anything else is unknown.
 * The native gate is only proven for 2.0.27 and later 2.0.x releases (hooks observed firing on 2.0.29). Every
 * other 2.x that may carry native tools (2.1+, suffixed builds below 2.0.27, 2.0.27 prereleases) is unknown:
 * delegated jobs are refused until Bridge is updated for it. This is an accepted, documented limit.
 */
export function parseOpencodeVersion(output: string): { api: OpencodeApi; version: string | null } {
  const found = new Map<string, RegExpExecArray>();
  // Terminal color codes are presentation, not part of the version.
  // eslint-disable-next-line no-control-regex
  for (const line of output.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").split(/\r?\n/)) {
    const match = VERSION_LINE_RE.exec(line);
    if (match) found.set(match.slice(1, 6).join("|"), match);
  }
  if (found.size !== 1) return { api: "unknown", version: null };
  const match = [...found.values()][0]!;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const version = `${major}.${minor}.${patch}${match[4] ?? ""}${match[5] ?? ""}`;
  if (![major, minor, patch].every(Number.isSafeInteger)) return { api: "unknown", version: null };
  if (major < 2) return { api: "v1", version };
  if (major > 2 || minor > 0) return { api: "unknown", version };
  if (patch < 27) return { api: match[4] || match[5] ? "unknown" : "v2", version };
  if (patch === 27 && match[4]) return { api: "unknown", version };
  return { api: "v2-native", version };
}

export function hasOpencodeNativeTools(version: string): boolean {
  return parseOpencodeVersion(version).api === "v2-native";
}

export function unknownOpencodeVersionMessage(output: string): string {
  const { version } = parseOpencodeVersion(output);
  if (version) {
    return `opencode ${version} is outside the range agent-bridge's native tool gate is proven for (2.0.27 and later 2.0.x releases); refusing the delegated opencode job. Update agent-bridge for this opencode version.`;
  }
  const shown = output.trim().replace(/\s+/g, " ").slice(0, 120) || "(empty)";
  return `Unrecognized opencode version output "${shown}"; refusing the delegated opencode job because its native worktree/session tools cannot be proven gated. Use a released opencode version.`;
}
