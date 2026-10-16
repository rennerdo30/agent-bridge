/**
 * Display text for approval questions (AB-417). Display only: nothing here decides, matches or remembers an approval.
 *
 * A supervisor must see every security-relevant argument of the request it approves, not just the command or path:
 * a sandbox-off, escalated, background or other-folder command must never read like an ordinary one. Such a request
 * gets a header line of markers before its command, for example:
 *
 *   [sandbox OFF] [background] [workdir: C:\other]
 *   npm test
 *
 * The header comes first so a long or multi-line command can never push it out of view. Any other argument still
 * shows, as a bounded `+args: {...}` at the end of that header line, so nothing is hidden silently. Marker values
 * and `+args` are escaped: they never contain a raw line break, a square bracket or a bidirectional control, so a
 * hostile path or reason cannot fake a new line, end a marker early or reorder the text. The command itself is
 * shown exactly as it will run.
 */

/** The longest marker value shown; a longer one is cut with its original length named. */
export const MAX_MARKER_VALUE_CHARS = 200;
/** The longest `+args` text shown; a longer one is cut with its original length named. */
export const MAX_EXTRA_ARGS_CHARS = 600;

/**
 * Line breaks, other control characters, brackets, quotes and bidirectional or invisible format characters.
 * Any of them makes a marker value print as an escaped JSON string.
 */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f[\]"\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;
const ESCAPE_AFTER_JSON = /[[\]\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\u007f-\u009f]/g;

/** JSON text with brackets and invisible or bidirectional characters also written as \u escapes. */
function escapedJson(value: unknown): string {
  const json = JSON.stringify(value) ?? String(value);
  return json.replace(ESCAPE_AFTER_JSON, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…(${text.length} chars)` : text;
}

/** One marker value: plain when it is harmless text, else an escaped JSON string; always bounded. */
export function markerValue(value: unknown): string {
  if (typeof value === "string" && !UNSAFE.test(value) && value.trim() === value && value !== "") return cut(value, MAX_MARKER_VALUE_CHARS);
  // The escaped form is what gets cut, so no raw line break or bracket can survive the cut.
  return cut(escapedJson(value), MAX_MARKER_VALUE_CHARS);
}

/** `[label]` or `[label: value]`. */
export function marker(label: string, value?: unknown): string {
  return value === undefined ? `[${label}]` : `[${label}: ${markerValue(value)}]`;
}

/** `+args: {...}`, bounded and escaped; "" when there are no extra arguments. */
export function extraArgs(extra: Record<string, unknown>): string {
  if (!Object.keys(extra).length) return "";
  return `+args: ${cut(escapedJson(extra), MAX_EXTRA_ARGS_CHARS)}`;
}

/** The question text: the primary text alone, or the marker header line and then the primary text. */
export function withMarkers(primary: string, markers: string[], extra: Record<string, unknown> = {}): string {
  const header = [...markers, extraArgs(extra)].filter(Boolean).join(" ");
  return header ? `${header}\n${primary}` : primary;
}

/** True when the value asks for something: not absent, false, null or empty. */
function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false && value !== "" && !(Array.isArray(value) && !value.length)
    && !(typeof value === "object" && !Array.isArray(value) && !Object.keys(value as object).length);
}

/** Fields that name what the tool acts on; one of them is the primary text. */
const PRIMARY_FIELDS = ["command", "file_path", "notebook_path"] as const;
/**
 * Known fields left out of `+args`: the tool's own description of the command, and file contents or edit text,
 * whose size would make the question unreviewable. The full request stays the approval's identity.
 */
const SILENT_FIELDS = new Set(["description", "content", "old_string", "new_string", "edits", "new_source"]);

/**
 * Markers for the security-relevant arguments of a Claude or Codex tool call (PermissionRequest hook input), and
 * the fields it consumed. Claude Bash: dangerouslyDisableSandbox, run_in_background, timeout. Codex shell:
 * sandbox_permissions, with_escalated_permissions, justification, workdir, timeout_ms, prefix_rule,
 * additional_permissions.
 */
function toolMarkers(o: Record<string, unknown>): { markers: string[]; used: Set<string> } {
  const markers: string[] = [];
  const used = new Set<string>();
  const take = (key: string) => { used.add(key); return o[key]; };
  const sandboxOff = take("dangerouslyDisableSandbox");
  if (sandboxOff === true) markers.push(marker("sandbox OFF"));
  else if (present(sandboxOff)) markers.push(marker("sandbox OFF", sandboxOff));
  const permissions = take("sandbox_permissions");
  const escalatedFlag = take("with_escalated_permissions");
  const justification = take("justification");
  const escalated = escalatedFlag === true || permissions === "require_escalated";
  if (escalated) markers.push(present(justification) ? marker("escalated", justification) : marker("escalated"));
  if (present(permissions) && permissions !== "use_default" && permissions !== "require_escalated") markers.push(marker("sandbox permissions", permissions));
  if (present(escalatedFlag) && escalatedFlag !== true) markers.push(marker("with_escalated_permissions", escalatedFlag));
  if (!escalated && present(justification)) markers.push(marker("justification", justification));
  const extraPermissions = take("additional_permissions");
  if (present(extraPermissions)) markers.push(marker("extra permissions", extraPermissions));
  const workdir = take("workdir");
  if (present(workdir)) markers.push(marker("workdir", workdir));
  const background = take("run_in_background");
  if (background === true) markers.push(marker("background"));
  else if (present(background)) markers.push(marker("background", background));
  const rule = take("prefix_rule");
  if (present(rule)) markers.push(marker("proposed rule", rule));
  for (const key of ["timeout", "timeout_ms"]) {
    const value = take(key);
    if (present(value)) markers.push(marker("timeout", typeof value === "number" ? `${value} ms` : value));
  }
  return { markers, used };
}

/**
 * The question text for a Claude or Codex tool call. A call without a command or path shows its whole input as
 * JSON, as before; MCP tool calls keep that form (their arguments are the request).
 */
export function describeToolInput(toolInput: unknown): string {
  if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) return JSON.stringify(toolInput ?? {});
  const o = toolInput as Record<string, unknown>;
  const field = PRIMARY_FIELDS.find((key) => typeof o[key] === "string");
  if (!field) return JSON.stringify(toolInput);
  const { markers, used } = toolMarkers(o);
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(o)) {
    if (key === field || used.has(key) || SILENT_FIELDS.has(key)) continue;
    extra[key] = value;
  }
  return withMarkers(o[field] as string, markers, extra);
}

/** Same folder, ignoring slash direction, case and a trailing slash. */
function sameFolder(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/** Codex app-server fields that only route the request (thread, turn, ids, answer choices) or repeat the command. */
const CODEX_ROUTING_FIELDS = new Set(["threadId", "turnId", "itemId", "approvalId", "availableDecisions", "commandActions"]);

/**
 * The question text for a Codex app-server `item/commandExecution/requestApproval`: the command, with markers for a
 * network request (networkApprovalContext), proposed exec-policy or network-policy amendments, extra permissions,
 * a working folder other than the job's, and Codex's stated reason.
 */
export function codexCommandApprovalText(params: Record<string, unknown>, primary: string, jobCwd?: string): string {
  const markers: string[] = [];
  const used = new Set<string>(["command", ...CODEX_ROUTING_FIELDS]);
  const take = (key: string) => { used.add(key); return params[key]; };
  const network = take("networkApprovalContext");
  if (present(network)) {
    const n = network as Record<string, unknown>;
    const plain = typeof n === "object" && typeof n.host === "string" && Object.keys(n).every((k) => k === "host" || k === "protocol" || k === "port");
    markers.push(marker("network", plain ? `${typeof n.protocol === "string" ? `${n.protocol}://` : ""}${n.host}${n.port !== undefined ? `:${n.port}` : ""}` : network));
  }
  const execAmendment = take("proposedExecpolicyAmendment");
  if (present(execAmendment)) markers.push(marker("proposed exec rule", execAmendment));
  const networkAmendments = take("proposedNetworkPolicyAmendments");
  if (present(networkAmendments)) markers.push(marker("proposed network rule", networkAmendments));
  const extraPermissions = take("additionalPermissions");
  if (present(extraPermissions)) markers.push(marker("extra permissions", extraPermissions));
  const cwd = take("cwd");
  if (typeof cwd === "string" && cwd && !(jobCwd && sameFolder(cwd, jobCwd))) markers.push(marker("workdir", cwd));
  else if (present(cwd) && typeof cwd !== "string") markers.push(marker("workdir", cwd));
  const reason = take("reason");
  if (present(reason) && reason !== primary) markers.push(marker("reason", reason));
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) if (!used.has(key) && present(value)) extra[key] = value;
  return withMarkers(primary, markers, extra);
}

/**
 * The question text for a Codex app-server `item/fileChange/requestApproval`: the changed paths, with markers for a
 * requested write root for the rest of the session (grantRoot) and Codex's stated reason.
 */
export function codexFileChangeApprovalText(params: Record<string, unknown>, primary: string): string {
  const markers: string[] = [];
  const used = new Set<string>(CODEX_ROUTING_FIELDS);
  const take = (key: string) => { used.add(key); return params[key]; };
  const root = take("grantRoot");
  if (present(root)) markers.push(marker("grant write root", root));
  const reason = take("reason");
  if (present(reason) && reason !== primary) markers.push(marker("reason", reason));
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) if (!used.has(key) && present(value)) extra[key] = value;
  return withMarkers(primary, markers, extra);
}

/** opencode metadata fields that are the primary text, or the tool's own description or bulky change text. */
const OPENCODE_SILENT = new Set(["command", "filepath", "description", "diff", "content", "preview"]);

/**
 * The question text for an opencode `permission.asked` (not an MCP tool): the command or path, with markers for a
 * working folder or timeout, the patterns asked for when they differ from the command, and other metadata in `+args`.
 */
export function opencodePermissionText(p: Record<string, unknown>, primary: string): string {
  const meta = p.metadata && typeof p.metadata === "object" && !Array.isArray(p.metadata) ? p.metadata as Record<string, unknown> : {};
  const fromMeta = typeof meta.command === "string" || typeof meta.filepath === "string";
  if (!fromMeta) return primary;
  const markers: string[] = [];
  const used = new Set<string>(OPENCODE_SILENT);
  for (const key of ["workdir", "cwd"]) {
    used.add(key);
    if (present(meta[key])) markers.push(marker("workdir", meta[key]));
  }
  used.add("timeout");
  if (present(meta.timeout)) markers.push(marker("timeout", typeof meta.timeout === "number" ? `${meta.timeout} ms` : meta.timeout));
  const patterns = Array.isArray(p.patterns) ? p.patterns.map(String) : [];
  if (patterns.length && !(patterns.length === 1 && patterns[0] === primary)) markers.push(marker("patterns", patterns));
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) if (!used.has(key) && present(value)) extra[key] = value;
  return withMarkers(primary, markers, extra);
}
