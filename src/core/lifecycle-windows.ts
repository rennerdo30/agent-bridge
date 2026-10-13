import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

type Phase = "admission" | "prepare" | "write";
type Scope = "home" | "established";
type Reason = "unsafe_path" | "unsafe_acl" | "unsupported_fs" | "unavailable" | "budget";
export class WindowsLifecyclePathUnavailable extends Error {
  constructor(readonly reason: Reason) { super(`Core lifecycle path verification unavailable: ${reason}.`); }
}
export interface WindowsLifecyclePathProof { readonly nonce: string; readonly ownerInstance: string; readonly phase: Phase; readonly scope: Scope }
type Snapshot = Map<string, string>;
const proofs = new WeakMap<WindowsLifecyclePathProof, { paths: Snapshot; deadline: number; pid: number }>();
const pending = new Set<object>();
const PHASE_MS = { admission: 1000, prepare: 5000, write: 2000 } as const;
const DIRECTORY = ".core-lifecycle", FILE = "receipts.sqlite";

// Read-only OS observation. No repair, ACL write, SQL open/recovery, command interpolation,
// P/Invoke or native helper. Privileged administrative tampering is outside the reviewed model.
const INSPECT = String.raw`
$ErrorActionPreference='Stop'
$nonce=''
function Refuse([string]$code) { throw $code }
try {
  $raw=[Console]::In.ReadToEnd()
  if($raw.Length -gt 32768) { Refuse 'unavailable' }
  $r=$raw | ConvertFrom-Json
  $nonce=[string]$r.nonce
  if($r.schema -ne 1 -or $nonce -notmatch '^[0-9a-f-]{36}$' -or $r.scope -notin @('home','established')) { Refuse 'unavailable' }
  $home=[IO.Path]::GetFullPath([string]$r.home)
  if($home -notmatch '^[A-Za-z]:\\' -or $home.Length -gt 4096) { Refuse 'unsafe_path' }
  $drive=New-Object IO.DriveInfo([IO.Path]::GetPathRoot($home))
  if($drive.DriveType -ne [IO.DriveType]::Fixed -or $drive.DriveFormat -notin @('NTFS','ReFS')) { Refuse 'unsupported_fs' }
  $id=[Security.Principal.WindowsIdentity]::GetCurrent()
  $sid=$id.User.Value
  $token=@{}; $token[$sid]=$true
  foreach($group in $id.Groups) { $token[$group.Value]=$true }
  $privileged=@('S-1-5-18','S-1-5-32-544')
  $rights=[Security.AccessControl.FileSystemRights]
  $ancestorMask=[int]$rights::Delete -bor [int]$rights::DeleteSubdirectoriesAndFiles -bor [int]$rights::ChangePermissions -bor [int]$rights::TakeOwnership -bor [int]$rights::WriteAttributes -bor [int]$rights::WriteExtendedAttributes
  $homeMask=$ancestorMask -bor [int]$rights::WriteData -bor [int]$rights::AppendData
  function Inspect([string]$path,[bool]$directory,[bool]$target,[int]$mask) {
    $attributes=[IO.File]::GetAttributes($path)
    if(($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or ((($attributes -band [IO.FileAttributes]::Directory) -ne 0) -ne $directory)) { Refuse 'unsafe_path' }
    if($directory) { $acl=[IO.Directory]::GetAccessControl($path) } else { $acl=[IO.File]::GetAccessControl($path) }
    $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if($target) {
      if($owner -ne $sid -or -not $acl.AreAccessRulesProtected) { Refuse 'unsafe_acl' }
    } elseif($owner -ne $sid -and $owner -notin $privileged) { Refuse 'unsafe_acl' }
    $rules=$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
    if($rules.Count -gt 128) { Refuse 'unsafe_acl' }
    $ownerFull=$false
    foreach($ace in $rules) {
      $who=$ace.IdentityReference.Value
      $bits=[int]$ace.FileSystemRights
      $applies=($ace.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0
      if($ace.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) {
        if($target -and $who -ne $sid) { Refuse 'unsafe_acl' }
        if($applies -and $who -ne $sid -and $who -notin $privileged -and ($bits -band $mask) -ne 0) { Refuse 'unsafe_acl' }
        if($applies -and $who -eq $sid -and ($bits -band [int]$rights::FullControl) -eq [int]$rights::FullControl) { $ownerFull=$true }
      } elseif($applies -and $token.ContainsKey($who) -and ($bits -band $mask) -ne 0) { Refuse 'unsafe_acl' }
    }
    if($target -and -not $ownerFull) { Refuse 'unsafe_acl' }
  }
  $at=$home; $depth=0
  for(;;) {
    if(++$depth -gt 128) { Refuse 'unsafe_path' }
    if($at -eq $home) { Inspect $at $true $false $homeMask } else { Inspect $at $true $false $ancestorMask }
    $parent=[IO.Directory]::GetParent($at)
    if($null -eq $parent) { break }
    $at=$parent.FullName
  }
  if($r.scope -eq 'established') {
    $dir=[IO.Path]::Combine($home,'.core-lifecycle')
    Inspect $dir $true $true $homeMask
    Inspect ([IO.Path]::Combine($dir,'receipts.sqlite')) $false $true $homeMask
    Inspect ([IO.Path]::Combine($dir,'receipts.sqlite-journal')) $false $true $homeMask
  }
  @{schema=1;nonce=$nonce;status='verified';filesystem=$drive.DriveFormat} | ConvertTo-Json -Compress
} catch {
  $code=[string]$_.Exception.Message
  if($code -notin @('unsafe_path','unsafe_acl','unsupported_fs')) { $code='unavailable' }
  @{schema=1;nonce=$nonce;status=$code} | ConvertTo-Json -Compress
}
`;

function snapshot(home: string, scope: Scope): Snapshot {
  const paths: Snapshot = new Map();
  const check = (path: string, directory: boolean) => {
    if (paths.size >= 128 && !paths.has(path)) throw new WindowsLifecyclePathUnavailable("unsafe_path");
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)) throw new WindowsLifecyclePathUnavailable("unsafe_path");
    paths.set(path, `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`);
  };
  for (let path = home; ; path = dirname(path)) {
    if (paths.size >= 128) throw new WindowsLifecyclePathUnavailable("unsafe_path");
    check(path, true); if (path === dirname(path)) break;
  }
  if (scope === "established") {
    const dir = join(home, DIRECTORY); check(dir, true); check(join(dir, FILE), false); check(join(dir, FILE + "-journal"), false);
  }
  return paths;
}
function same(a: Snapshot, b: Snapshot): boolean { return a.size === b.size && [...a].every(([path, identity]) => b.get(path) === identity); }
export function pendingWindowsLifecycleVerifications(): number { return pending.size; }

/** Fresh phase-local ACL/file observation only. It does NOT open SQLite or prove committed
 * lineage, a non-hot journal, directory-entry power-loss durability, or writable-role ownership. */
export async function verifyWindowsLifecyclePaths(home: string, ownerInstance: string, phase: Phase, scope: Scope, deadline: number): Promise<WindowsLifecyclePathProof> {
  const reject = (reason: Reason): never => { throw new WindowsLifecyclePathUnavailable(reason); };
  if (process.platform !== "win32" || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(ownerInstance) || !Object.hasOwn(PHASE_MS, phase) || !["home", "established"].includes(scope)) reject("unavailable");
  const started = performance.now(), expires = Math.min(deadline, started + PHASE_MS[phase]);
  if (!Number.isFinite(expires) || expires <= started) reject("budget");
  if (pending.size) reject("unavailable"); // A timed-out observer is not settled process/verification proof.
  let physicalHome: string, before: Snapshot;
  try { before = snapshot(home, scope); physicalHome = realpathSync.native(home); }
  catch { reject("unsafe_path"); }
  const nonce = randomUUID();
  const bin = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return new Promise((resolve, no) => {
    const child = spawn(bin, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(INSPECT, "utf16le").toString("base64")], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    const registration = {}; pending.add(registration);
    let output = "", settled = false;
    const refuse = (reason: Reason) => { if (!settled) { settled = true; clearTimeout(timer); no(new WindowsLifecyclePathUnavailable(reason)); } };
    const timer = setTimeout(() => refuse("budget"), Math.max(0, expires - performance.now()));
    child.on("error", () => refuse("unavailable")); child.stdin!.on("error", () => refuse("unavailable"));
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => { if (!settled) { output += chunk; if (Buffer.byteLength(output) > 4096) refuse("unavailable"); } });
    child.once("close", code => {
      pending.delete(registration);
      if (settled) return; // Late observation never grants eligibility or changes the expired caller.
      try {
        const response: unknown = JSON.parse(output);
        if (!response || typeof response !== "object") return refuse("unavailable");
        const r = response as Record<string, unknown>;
        if (code !== 0 || r.schema !== 1 || r.nonce !== nonce || performance.now() >= expires) return refuse("unavailable");
        if (r.status !== "verified") return refuse(["unsafe_path", "unsafe_acl", "unsupported_fs"].includes(String(r.status)) ? r.status as Reason : "unavailable");
        if (!["NTFS", "ReFS"].includes(String(r.filesystem)) || !same(before, snapshot(home, scope))) return refuse("unsafe_path");
        const proof = Object.freeze({ nonce, ownerInstance, phase, scope });
        proofs.set(proof, { paths: before, deadline: expires, pid: process.pid });
        settled = true; clearTimeout(timer); resolve(proof);
      } catch { refuse("unavailable"); }
    });
    child.stdin!.end(JSON.stringify({ schema: 1, nonce, home: physicalHome, scope }));
    child.unref();
  });
}

/** Immediate identity recheck for the following bounded SQL phase, never a cross-restart cache.
 * The separate committed lineage/hot-journal and all-store ownership guards remain mandatory. */
export function assertWindowsLifecyclePathProof(proof: WindowsLifecyclePathProof, home: string, ownerInstance: string, phase: Phase, scope: Scope): void {
  const known = proofs.get(proof);
  if (!known || known.pid !== process.pid || proof.ownerInstance !== ownerInstance || proof.phase !== phase || proof.scope !== scope || performance.now() >= known.deadline || pending.size) throw new WindowsLifecyclePathUnavailable("unavailable");
  try { if (!same(known.paths, snapshot(home, scope))) throw new WindowsLifecyclePathUnavailable("unsafe_path"); }
  catch { throw new WindowsLifecyclePathUnavailable("unsafe_path"); }
}
