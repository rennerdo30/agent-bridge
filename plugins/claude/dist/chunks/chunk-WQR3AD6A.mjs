import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  runProcess
} from "./chunk-7KRAJNI6.mjs";
import {
  writeJsonStore
} from "./chunk-OHCADHNH.mjs";

// src/core/permission-repair.ts
import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { dirname, join, parse, resolve, toNamespacedPath } from "node:path";
function assertPhysicalPath(path) {
  const target = resolve(path);
  const parts = [];
  for (let p = target; dirname(p) !== p; p = dirname(p)) parts.unshift(p);
  for (const p of parts) if (lstatSync(toNamespacedPath(p)).isSymbolicLink()) throw new Error(`Refusing permission changes through a link: ${p}`);
  return target;
}
function permissionRepairPlan(path) {
  const root = assertPhysicalPath(path);
  if (root === parse(root).root || !lstatSync(root).isDirectory()) throw new Error("Select one physical folder, not a filesystem root.");
  const paths = [], skipped = [];
  const visit = (p) => {
    const stat = lstatSync(toNamespacedPath(p));
    if (stat.isSymbolicLink()) {
      skipped.push(p);
      return;
    }
    paths.push(p);
    if (stat.isDirectory()) for (const child of readdirSync(toNamespacedPath(p))) visit(join(p, child));
  };
  visit(root);
  return { root, paths, skipped };
}
var PERMISSION_REPAIR_SCRIPT = String.raw`
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
      $item.SetAccessControl($acl)
    }
    $results += @{ path = $path; sddl = $sddl; ok = $true }
  } catch { $results += @{ path = $path; ok = $false; error = $_.Exception.Message } }
}
ConvertTo-Json -Depth 5 -Compress -InputObject @{ sid = $sid.Value; entries = $results }
`;
async function repairPermissions(opts) {
  const plan = permissionRepairPlan(opts.path);
  if (!opts.apply) return { plan, backup: null, result: null };
  if (process.platform !== "win32") throw new Error("Permission repair is supported only on Windows.");
  const run = async (paths, apply) => {
    const result = await runProcess({ bin: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(PERMISSION_REPAIR_SCRIPT, "utf16le").toString("base64")], stdin: JSON.stringify({ paths, apply }), cwd: plan.root, timeoutMs: 18e4, env: process.env, log: opts.log, what: "permission repair" });
    if (result.code !== 0) throw new Error(`Permission repair failed: ${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  const original = await run(plan.paths, false);
  const backup = join(opts.home, "permission-repairs", `${randomUUID()}.json`);
  writeJsonStore(backup, { contractVersion: 1, root: plan.root, at: Date.now(), ...original }, null);
  const repaired = await run(original.entries.filter((entry) => entry.ok).map((entry) => entry.path), true);
  repaired.entries.push(...original.entries.filter((entry) => !entry.ok));
  return { plan, backup, result: repaired };
}

export {
  assertPhysicalPath,
  permissionRepairPlan,
  repairPermissions
};
