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

export type OpencodeNativeToolKind = "remove" | "mutation" | "safe" | "unknown-native" | "other";
export interface OpencodeNativeGateReport {
  contract: number;
  access: string;
  hooks: string[];
  inventory: string[] | null;
}

/**
 * Serialized into the plugin too. Keep it free of module closures/imports. Anything that looks like an OpenCode
 * native tool but is not on the known list is "unknown-native": the gate never lets it through unchecked in
 * read or ask mode.
 */
export function classifyOpencodeNativeTool(id: unknown): OpencodeNativeToolKind {
  if (typeof id !== "string" || !id) return "unknown-native";
  const known: Record<string, OpencodeNativeToolKind> = {
    opencode_worktree_remove: "remove",
    opencode_worktree_create: "mutation",
    opencode_session_move: "mutation",
    opencode_session_rename: "mutation",
    opencode_worktree_list: "safe",
  };
  if (Object.prototype.hasOwnProperty.call(known, id)) return known[id]!;
  const native = /^opencode[_.:/-]/i.test(id) || /^(?:worktree|session)s?(?:[_.:/-]|$)/i.test(id);
  if (!native) return "other";
  // A renamed or new removal tool is still removal: unavailable in every delegated mode.
  if (/worktree/i.test(id) && /remove|delete|prune|destroy|clean|reset/i.test(id)) return "remove";
  return "unknown-native";
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
    if (access === "edit") return;
    if (access !== "ask") throw new Error(`agent-bridge: ${event.tool} is denied in read mode.`);
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

/** Why a gate report does not prove enforcement for this access, or null when it does. */
export function opencodeNativeGateReportError(report: unknown, access: OpencodeNativeAccess): string | null {
  if (!report || typeof report !== "object") return "reported no enforcement contract";
  const r = report as Partial<OpencodeNativeGateReport>;
  if (r.contract !== OPENCODE_NATIVE_GATE_CONTRACT) return `reported unsupported contract ${JSON.stringify(r.contract)}`;
  if (r.access !== access) return `was installed for ${JSON.stringify(r.access)} instead of ${JSON.stringify(access)}`;
  if (!Array.isArray(r.hooks) || OPENCODE_NATIVE_GATE_HOOKS.some(h => !r.hooks!.includes(h))) return "did not register its enforcement hooks";
  if (access === "edit") return null;
  if (!Array.isArray(r.inventory) || !r.inventory.every(id => typeof id === "string")) return "could not read the native tool inventory";
  const missing = OPENCODE_NATIVE_GATED_TOOLS.filter(id => !r.inventory!.includes(id));
  if (missing.length) return `found a native tool inventory without ${missing.join(", ")}; the native tool API is unknown`;
  return null;
}

/** OpenCode accepts local plugin directories. No dependency install or interactive config mutation. */
export function createOpencodeNativeToolPlugin(access: OpencodeNativeAccess): { directory: string; report(): unknown; dispose(): void } {
  const directory = mkdtempSync(join(tmpdir(), "agent-bridge-opencode-gate-"));
  const manifest = join(directory, "package.json");
  const entry = join(directory, "index.js");
  const reportFile = join(directory, GATE_REPORT_FILE);
  writeFileSync(manifest, JSON.stringify({ name: OPENCODE_NATIVE_GATE_ID, type: "module", main: "index.js" }));
  writeFileSync(entry, `import { writeFileSync } from "node:fs";
export default { id: ${JSON.stringify(OPENCODE_NATIVE_GATE_ID)}, setup: async ctx => {
  const report = await (${installOpencodeNativeToolGate.toString()})(ctx, ${JSON.stringify(access)}, (${classifyOpencodeNativeTool.toString()}));
  writeFileSync(new URL(${JSON.stringify(`./${GATE_REPORT_FILE}`)}, import.meta.url), JSON.stringify(report));
} };
`);
  return { directory, report() {
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
 * A suffixed 2.x build may contain native tools before its release number says so: it gets the native gate.
 */
export function parseOpencodeVersion(output: string): { api: OpencodeApi; version: string | null } {
  const found = new Map<string, RegExpExecArray>();
  for (const line of output.split(/\r?\n/)) {
    const match = VERSION_LINE_RE.exec(line);
    if (match) found.set(match.slice(1, 6).join("|"), match);
  }
  if (found.size !== 1) return { api: "unknown", version: null };
  const match = [...found.values()][0]!;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const version = `${major}.${minor}.${patch}${match[4] ?? ""}${match[5] ?? ""}`;
  if (![major, minor, patch].every(Number.isSafeInteger)) return { api: "unknown", version: null };
  if (major < 2) return { api: "v1", version };
  if (major > 2) return { api: "unknown", version };
  return { api: minor > 0 || patch >= 27 || match[4] || match[5] ? "v2-native" : "v2", version };
}

export function hasOpencodeNativeTools(version: string): boolean {
  return parseOpencodeVersion(version).api === "v2-native";
}

export function unknownOpencodeVersionMessage(output: string): string {
  const shown = output.trim().replace(/\s+/g, " ").slice(0, 120) || "(empty)";
  return `Unrecognized opencode version output "${shown}"; refusing the delegated opencode job because its native worktree/session tools cannot be proven gated. Use a released opencode version.`;
}
