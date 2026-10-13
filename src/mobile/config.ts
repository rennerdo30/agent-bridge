import { z } from "zod";
import { isAbsolute, dirname, parse } from "node:path";
import { constants, promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { isIP } from "node:net";

const origin = z.string().max(512).refine(value => {
  try { const u = new URL(value); return u.protocol === "https:" && u.origin === value && !u.username && !u.password; } catch { return false; }
});
const path = z.string().max(4096).refine(isAbsolute);
const schema = z.object({ enabled: z.literal(true), pcId: z.string().min(1).max(128), origins: z.array(origin).min(1).max(8),
  listeners: z.array(z.union([
    z.object({ origin, bindAddress: z.string().min(1).max(253), port: z.number().int().min(1).max(65535), tls: z.literal("pinned") }).strict(),
    z.object({ origin, bindAddress: z.string().min(1).max(253), port: z.number().int().min(1).max(65535), certFile: path, keyFile: path }).strict(),
  ])).min(1).max(8),
  push: z.object({ provider: z.literal("expo"), materialRef: path, projectId: z.string().uuid(), environment: z.enum(["development", "production"]) }).strict().optional(),
}).strict().superRefine((config, ctx) => {
  if (new Set(config.origins).size !== config.origins.length || config.listeners.length !== config.origins.length || new Set(config.listeners.map(l => l.origin)).size !== config.origins.length) ctx.addIssue({ code: "custom", message: "origins" });
  for (const l of config.listeners) if (!config.origins.includes(l.origin) || Number(new URL(l.origin).port || 443) !== l.port || ["0.0.0.0", "::", "*"].includes(l.bindAddress)) ctx.addIssue({ code: "custom", message: "listener" });
});
export type EnabledMobileConfig = z.infer<typeof schema>;
export type MobileConfig = EnabledMobileConfig | { enabled: true; invalid: true };
/** Home top-level only. Absent/disabled remains absent, including in serialized defaults. */
export function parseMobileConfig(value: unknown): MobileConfig | undefined {
  if (value === undefined || value === null || typeof value === "object" && (value as { enabled?: unknown }).enabled === false) return undefined;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : { enabled: true, invalid: true };
}
export function privateAddress(address: string): boolean {
  if (isIP(address) === 4) { const [a, b] = address.split(".").map(Number); return a === 10 || a === 127 || a === 192 && b === 168 || a === 172 && b! >= 16 && b! <= 31 || a === 100 && b! >= 64 && b! <= 127; }
  return isIP(address) === 6 && (/^(fc|fd)/i.test(address) || address === "::1");
}
export const WINDOWS_PRIVATE_ACL_TIMEOUT_MS = 3000;
const aclOutcomes = ["allowed", "timeout", "process_failure", "lookup_failure", "permission_refused"] as const;
export interface PrivateAclDiagnostic { aclOutcome: typeof aclOutcomes[number]; aclElapsedMs: number }
export class MobileActivationFault extends Error {
  readonly aclDiagnostic?: Readonly<PrivateAclDiagnostic>;
  constructor(readonly category: "config_invalid" | "material_unavailable" | "tls_invalid" | "bind_invalid" | "source_unavailable" | "restart_required", aclDiagnostic?: PrivateAclDiagnostic) {
    super(category);
    // Copy only fixed categories and monotonic elapsed time, never a native error or output.
    if (aclDiagnostic && aclOutcomes.includes(aclDiagnostic.aclOutcome) && Number.isFinite(aclDiagnostic.aclElapsedMs) && aclDiagnostic.aclElapsedMs >= 0)
      this.aclDiagnostic = Object.freeze({ aclOutcome: aclDiagnostic.aclOutcome, aclElapsedMs: Math.floor(aclDiagnostic.aclElapsedMs) });
  }
}
/** No shell interpolation or native diagnostic output. Allow owner, SYSTEM and administrators only. */
export function windowsPrivateAcl(file: string, diagnostic?: (outcome: PrivateAclDiagnostic) => void): Promise<boolean> {
  const started = performance.now();
  return new Promise(resolve => {
    let finished = false;
    const finish = (aclOutcome: PrivateAclDiagnostic["aclOutcome"]) => {
      if (finished) return; finished = true;
      try { diagnostic?.({ aclOutcome, aclElapsedMs: Math.max(0, Math.floor(performance.now() - started)) }); } catch { /* Optional only. */ }
      resolve(aclOutcome === "allowed");
    };
    // Permission refusals are explicit; descriptor lookup/SID translation exceptions are separate.
    // Both still exit nonzero and deny. Never print paths, identities or PowerShell error details.
    const script = "$ErrorActionPreference='Stop'; try { $a=Get-Acl -LiteralPath ([Console]::In.ReadLine()); $owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; $caller=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; if($owner -ne $caller){'permission_refused'; exit 1}; foreach($r in $a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){ $sid=$r.IdentityReference.Value; if($r.AccessControlType -eq 'Allow' -and ([int]$r.FileSystemRights -band 1) -ne 0 -and $sid -notin @($caller,'S-1-5-18','S-1-5-32-544')){'permission_refused'; exit 1} }; 'allow' } catch { 'lookup_failure'; exit 1 }";
    if (/[\r\n]/.test(file)) { finish("permission_refused"); return; }
    // A pwsh parent exports its incompatible module path. Let Windows PowerShell
    // select its own Security module; lookup/translation failures still deny.
    const env = { ...process.env }; for (const name of Object.keys(env)) if (name.toLowerCase() === "psmodulepath") delete env[name];
    try {
      const child = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { env, windowsHide: true, timeout: WINDOWS_PRIVATE_ACL_TIMEOUT_MS, maxBuffer: 8192 }, (error, stdout) => {
        const output = stdout.trim();
        // killed alone is ambiguous: only SIGTERM at/past our bound identifies this timeout.
        if (error?.killed && error.code === null && error.signal === "SIGTERM" && performance.now() - started >= WINDOWS_PRIVATE_ACL_TIMEOUT_MS) finish("timeout");
        else if (error?.code === 1 && output === "lookup_failure") finish("lookup_failure");
        else if (error?.code === 1 && output === "permission_refused") finish("permission_refused");
        else finish(!error && output === "allow" ? "allowed" : "process_failure");
      });
      child.stdin?.end(file + "\n");
    } catch { finish("process_failure"); }
  });
}
export interface MaterialPolicy { platform?: NodeJS.Platform; acl?: (file: string) => Promise<boolean> }
/** Preserve the safe failed ACL category across material/identity wrappers. */
export async function requirePrivateAcl(file: string, policy: MaterialPolicy): Promise<void> {
  const started = performance.now(); let diagnostic: PrivateAclDiagnostic | undefined;
  try {
    const allowed = policy.acl ? await policy.acl(file) : await windowsPrivateAcl(file, value => { diagnostic = value; });
    if (allowed) return;
    diagnostic ??= { aclOutcome: "permission_refused", aclElapsedMs: performance.now() - started };
  } catch { diagnostic = { aclOutcome: "process_failure", aclElapsedMs: performance.now() - started }; }
  throw new MobileActivationFault("material_unavailable", diagnostic);
}
/** Read at explicit activation only. Reject links in the entire path and verify the opened file identity. */
export async function readPrivateMaterial(file: string, policy: MaterialPolicy = {}): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    if (!isAbsolute(file)) throw new Error();
    let component = file;
    while (component !== parse(component).root) { if ((await fs.lstat(component)).isSymbolicLink()) throw new Error(); component = dirname(component); }
    const before = await fs.lstat(file);
    if (!before.isFile() || before.size < 1 || before.size > 64 * 1024) throw new Error();
    const platform = policy.platform ?? process.platform;
    if (platform === "win32") await requirePrivateAcl(file, policy);
    else if ((before.mode & 0o077) !== 0 || typeof process.getuid === "function" && before.uid !== process.getuid()) throw new Error();
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.mode !== before.mode || opened.uid !== before.uid) throw new Error();
    component = file;
    while (component !== parse(component).root) { if ((await fs.lstat(component)).isSymbolicLink()) throw new Error(); component = dirname(component); }
    const content = Buffer.alloc(64 * 1024 + 1); let length = 0;
    while (length < content.length) { const read = await handle.read({ buffer: content, offset: length, length: content.length - length, position: length }); if (!read.bytesRead) break; length += read.bytesRead; }
    const after = await handle.stat();
    if (length > 64 * 1024 || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.mode !== opened.mode || after.uid !== opened.uid || length !== after.size) throw new Error();
    return content.subarray(0, length);
  } catch (error) { if (error instanceof MobileActivationFault) throw error; throw new MobileActivationFault("material_unavailable"); }
  finally { await handle?.close().catch(() => {}); }
}
