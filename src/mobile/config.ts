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
export class MobileActivationFault extends Error {
  constructor(readonly category: "config_invalid" | "material_unavailable" | "tls_invalid" | "bind_invalid" | "source_unavailable" | "restart_required") { super(category); }
}
/** No shell interpolation, env credentials, or diagnostic output. Allow owner, SYSTEM and administrators only. */
export function windowsPrivateAcl(file: string): Promise<boolean> {
  return new Promise(resolve => {
    const script = "$ErrorActionPreference='Stop'; try { $a=Get-Acl -LiteralPath ([Console]::In.ReadLine()); $owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; $caller=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; if($owner -ne $caller){throw 'deny'}; foreach($r in $a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){ $sid=$r.IdentityReference.Value; if($r.AccessControlType -eq 'Allow' -and ([int]$r.FileSystemRights -band 1) -ne 0 -and $sid -notin @($caller,'S-1-5-18','S-1-5-32-544')){throw 'deny'} }; 'allow' } catch { 'deny'; exit 1 }";
    if (/[\r\n]/.test(file)) { resolve(false); return; }
    // A pwsh parent exports its incompatible module path. Let Windows PowerShell
    // select its own Security module; lookup/translation failures still deny.
    const env = { ...process.env }; for (const name of Object.keys(env)) if (name.toLowerCase() === "psmodulepath") delete env[name];
    const child = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { env, windowsHide: true, timeout: 3000, maxBuffer: 8192 }, (error, stdout) => resolve(!error && stdout.trim() === "allow"));
    child.stdin?.end(file + "\n");
  });
}
export interface MaterialPolicy { platform?: NodeJS.Platform; acl?: (file: string) => Promise<boolean> }
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
    if (platform === "win32" ? !await (policy.acl ?? windowsPrivateAcl)(file) : (before.mode & 0o077) !== 0 || typeof process.getuid === "function" && before.uid !== process.getuid()) throw new Error();
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
  } catch { throw new MobileActivationFault("material_unavailable"); }
  finally { await handle?.close().catch(() => {}); }
}
