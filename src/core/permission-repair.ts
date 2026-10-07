import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { dirname, join, parse, resolve, toNamespacedPath } from "node:path";
import { runProcess } from "./delegate.js";
import { writeJsonStore } from "./json-store.js";
import type { Logger } from "./logger.js";

/** Reject every link component, including internal links and junctions above the selected root. */
export function assertPhysicalPath(path: string): string {
  const target = resolve(path);
  const parts: string[] = [];
  for (let p = target; dirname(p) !== p; p = dirname(p)) parts.unshift(p);
  for (const p of parts) if (lstatSync(toNamespacedPath(p)).isSymbolicLink()) throw new Error(`Refusing permission changes through a link: ${p}`);
  return target;
}

export function permissionRepairPlan(path: string): { root: string; paths: string[]; skipped: string[] } {
  const root = assertPhysicalPath(path);
  if (root === parse(root).root || !lstatSync(root).isDirectory()) throw new Error("Select one physical folder, not a filesystem root.");
  const paths: string[] = [], skipped: string[] = [];
  const visit = (p: string) => {
    const stat = lstatSync(toNamespacedPath(p));
    if (stat.isSymbolicLink()) { skipped.push(p); return; }
    paths.push(p);
    if (stat.isDirectory()) for (const child of readdirSync(toNamespacedPath(p))) visit(join(p, child));
  };
  visit(root);
  return { root, paths, skipped };
}

// No recursive native operation: each literal path is rechecked before its own ACL operation.
// Restricted or unreadable paths fail visibly; this never elevates or switches accounts.
export const PERMISSION_REPAIR_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$results = @()
foreach ($path in $payload.paths) {
  try {
    $item = Get-Item -LiteralPath $path -Force
    for ($part = $item; $null -ne $part; $part = if ($part -is [System.IO.DirectoryInfo]) { $part.Parent } else { $part.Directory }) {
      if ($part.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Linked path refused' }
    }
    $acl = $item.GetAccessControl()
    $sddl = $acl.Sddl
    if ($payload.apply) {
      $acl.SetAccessRuleProtection($false, $false)
      foreach ($rule in @($acl.Access)) { if (-not $rule.IsInherited) { [void]$acl.RemoveAccessRuleSpecific($rule) } }
      $inherit = if ($item.PSIsContainer) { [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [System.Security.AccessControl.InheritanceFlags]::None }
      $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', $inherit, 'None', 'Allow'))
      $acl.SetOwner($sid)
      $item.SetAccessControl($acl)
    }
    $results += @{ path = $path; sddl = $sddl; ok = $true }
  } catch { $results += @{ path = $path; ok = $false; error = $_.Exception.Message } }
}
ConvertTo-Json -Depth 5 -Compress -InputObject @{ sid = $sid.Value; entries = $results }
`;

type RepairSnapshot = { sid: string; entries: { path: string; sddl?: string; ok: boolean; error?: string }[] };
export async function repairPermissions(opts: { path: string; home: string; apply: boolean; log: Logger }): Promise<{ plan: ReturnType<typeof permissionRepairPlan>; backup: string | null; result: RepairSnapshot | null }> {
  const plan = permissionRepairPlan(opts.path);
  if (!opts.apply) return { plan, backup: null, result: null };
  if (process.platform !== "win32") throw new Error("Permission repair is supported only on Windows.");
  const run = async (paths: string[], apply: boolean): Promise<RepairSnapshot> => {
    const result = await runProcess({ bin: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(PERMISSION_REPAIR_SCRIPT, "utf16le").toString("base64")], stdin: JSON.stringify({ paths, apply }), cwd: plan.root, timeoutMs: 180_000, env: process.env, log: opts.log, what: "permission repair" });
    if (result.code !== 0) throw new Error(`Permission repair failed: ${result.stderr}`);
    return JSON.parse(result.stdout) as RepairSnapshot;
  };
  const original = await run(plan.paths, false);
  const backup = join(opts.home, "permission-repairs", `${randomUUID()}.json`);
  writeJsonStore(backup, { contractVersion: 1, root: plan.root, at: Date.now(), ...original }, null);
  // Never change a path whose original descriptor could not be backed up.
  const repaired = await run(original.entries.filter((entry) => entry.ok).map((entry) => entry.path), true);
  repaired.entries.push(...original.entries.filter((entry) => !entry.ok));
  return { plan, backup, result: repaired };
}
