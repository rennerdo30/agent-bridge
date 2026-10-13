import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertLifecycleServingCapability, type LifecycleServingCapability } from "./broker.js";

type Phase = "admission" | "prepare" | "write";
type Scope = "home" | "established";
type Reason = "unsafe_path" | "unsafe_acl" | "unsupported_fs" | "unavailable" | "budget";
const RULES = ["foreign_owner", "foreign_write", "current_deny", "unprotected", "no_owner_full"] as const;
const ROLES = ["home", "ancestor", "directory", "file", "journal"] as const;
const OWNER_CLASSES = ["current", "system", "administrators", "trusted_installer", "other", "unknown"] as const;
type Diagnostic = { rule: typeof RULES[number]; role: typeof ROLES[number]; ancestorDepth: number; ownerClass: typeof OWNER_CLASSES[number] };
export class WindowsLifecyclePathUnavailable extends Error {
  readonly rule?: Diagnostic["rule"];
  readonly role?: Diagnostic["role"];
  readonly ancestorDepth?: number;
  readonly ownerClass?: Diagnostic["ownerClass"];
  constructor(readonly reason: Reason, diagnostic?: Diagnostic) {
    super(`Core lifecycle path verification unavailable: ${reason}.`);
    if (diagnostic) { this.rule = diagnostic.rule; this.role = diagnostic.role; this.ancestorDepth = diagnostic.ancestorDepth; this.ownerClass = diagnostic.ownerClass; }
  }
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
$aclRule=$null; $aclRole=$null; $aclDepth=$null; $aclOwnerClass='unknown'
function Refuse([string]$code,[string]$rule='',[string]$role='',[int]$depth=0,[string]$ownerClass='unknown') {
  if($code -eq 'unsafe_acl') { $script:aclRule=$rule; $script:aclRole=$role; $script:aclDepth=$depth; $script:aclOwnerClass=$ownerClass }
  throw $code
}
try {
  $raw=[Console]::In.ReadToEnd()
  if($raw.Length -gt 32768) { Refuse 'unavailable' }
  $r=$raw | ConvertFrom-Json
  $nonce=[string]$r.nonce
  if($r.schema -ne 1 -or $nonce -notmatch '^[0-9a-f-]{36}$' -or $r.scope -notin @('home','established')) { Refuse 'unavailable' }
  $lifecycleHome=[IO.Path]::GetFullPath([string]$r.home)
  if($lifecycleHome -notmatch '^[A-Za-z]:\\' -or $lifecycleHome.Length -gt 4096) { Refuse 'unsafe_path' }
  $drive=New-Object IO.DriveInfo([IO.Path]::GetPathRoot($lifecycleHome))
  if($drive.DriveType -ne [IO.DriveType]::Fixed -or $drive.DriveFormat -notin @('NTFS','ReFS')) { Refuse 'unsupported_fs' }
  $id=[Security.Principal.WindowsIdentity]::GetCurrent()
  $sid=$id.User.Value
  $token=@{}; $token[$sid]=$true
  foreach($group in $id.Groups) { $token[$group.Value]=$true }
  $privileged=@('S-1-5-18','S-1-5-32-544')
  # Owner policy only. Never widen the separate unchanged ACE exemptions.
  $ancestorOwners=@('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  $rights=[Security.AccessControl.FileSystemRights]
  $ancestorMask=[int]$rights::Delete -bor [int]$rights::DeleteSubdirectoriesAndFiles -bor [int]$rights::ChangePermissions -bor [int]$rights::TakeOwnership -bor [int]$rights::WriteAttributes -bor [int]$rights::WriteExtendedAttributes
  $homeMask=$ancestorMask -bor [int]$rights::WriteData -bor [int]$rights::AppendData
  function Inspect([string]$path,[bool]$directory,[bool]$target,[int]$mask,[string]$role,[int]$depth) {
    $attributes=[IO.File]::GetAttributes($path)
    if(($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or ((($attributes -band [IO.FileAttributes]::Directory) -ne 0) -ne $directory)) { Refuse 'unsafe_path' }
    if($directory) { $acl=[IO.Directory]::GetAccessControl($path) } else { $acl=[IO.File]::GetAccessControl($path) }
    $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    $ownerClass=if($owner -eq $sid) { 'current' } elseif($owner -eq 'S-1-5-18') { 'system' } elseif($owner -eq 'S-1-5-32-544') { 'administrators' } elseif($owner -eq $ancestorOwners[2]) { 'trusted_installer' } elseif($owner) { 'other' } else { 'unknown' }
    if($target) {
      if($owner -ne $sid) { Refuse 'unsafe_acl' 'foreign_owner' $role $depth $ownerClass }
      if(-not $acl.AreAccessRulesProtected) { Refuse 'unsafe_acl' 'unprotected' $role $depth $ownerClass }
    } elseif(($role -eq 'home' -and $owner -ne $sid) -or ($role -eq 'ancestor' -and $owner -ne $sid -and $owner -notin $ancestorOwners)) { Refuse 'unsafe_acl' 'foreign_owner' $role $depth $ownerClass }
    $rules=$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
    if($rules.Count -gt 128) { Refuse 'unavailable' }
    $ownerFull=$false
    foreach($ace in $rules) {
      $who=$ace.IdentityReference.Value
      $bits=[int]$ace.FileSystemRights
      $applies=($ace.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0
      if($ace.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) {
        # Protected target means the entire DACL is current-SID-only, including read grants.
        if($target -and $who -ne $sid) { Refuse 'unsafe_acl' 'unprotected' $role $depth $ownerClass }
        if($applies -and $who -ne $sid -and $who -notin $privileged -and ($bits -band $mask) -ne 0) { Refuse 'unsafe_acl' 'foreign_write' $role $depth $ownerClass }
        if($applies -and $who -eq $sid -and ($bits -band [int]$rights::FullControl) -eq [int]$rights::FullControl) { $ownerFull=$true }
      } elseif($applies -and $token.ContainsKey($who) -and ($bits -band $mask) -ne 0) { Refuse 'unsafe_acl' 'current_deny' $role $depth $ownerClass }
    }
    if($target -and -not $ownerFull) { Refuse 'unsafe_acl' 'no_owner_full' $role $depth $ownerClass }
  }
  $at=$lifecycleHome; $depth=0
  for(;;) {
    if(++$depth -gt 128) { Refuse 'unsafe_path' }
    if($at -eq $lifecycleHome) { Inspect $at $true $false $homeMask 'home' $depth } else { Inspect $at $true $false $ancestorMask 'ancestor' $depth }
    $parent=[IO.Directory]::GetParent($at)
    if($null -eq $parent) { break }
    $at=$parent.FullName
  }
  if($r.scope -eq 'established') {
    $dir=[IO.Path]::Combine($lifecycleHome,'.core-lifecycle')
    Inspect $dir $true $true $homeMask 'directory' 0
    Inspect ([IO.Path]::Combine($dir,'receipts.sqlite')) $false $true $homeMask 'file' 0
    Inspect ([IO.Path]::Combine($dir,'receipts.sqlite-journal')) $false $true $homeMask 'journal' 0
  }
  @{schema=1;nonce=$nonce;status='verified';filesystem=$drive.DriveFormat} | ConvertTo-Json -Compress
} catch {
  $code=[string]$_.Exception.Message
  if($code -notin @('unsafe_path','unsafe_acl','unsupported_fs')) { $code='unavailable' }
  $response=@{schema=1;nonce=$nonce;status=$code}
  if($code -eq 'unsafe_acl') { $response.rule=$aclRule; $response.role=$aclRole; $response.ancestorDepth=$aclDepth; $response.ownerClass=$aclOwnerClass }
  $response | ConvertTo-Json -Compress
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

const OWN_IDENTITY = String.raw`
$ErrorActionPreference='Stop'; $nonce=''
try {
  $raw=[Console]::In.ReadToEnd(); if($raw.Length -gt 512) { throw 'unknown' }
  $r=$raw | ConvertFrom-Json; $nonce=[string]$r.nonce
  if($r.schema -ne 1 -or $nonce -notmatch '^[0-9a-f-]{36}$' -or [int]$r.pid -le 0) { throw 'unknown' }
  $process=Get-Process -Id ([int]$r.pid) -ErrorAction Stop
  @{schema=1;nonce=$nonce;status='verified';pid=[int]$process.Id;creationTicks=$process.StartTime.ToUniversalTime().Ticks.ToString()} | ConvertTo-Json -Compress
} catch { @{schema=1;nonce=$nonce;status='unknown'} | ConvertTo-Json -Compress }
`;

/** Bootstrap-only observer. Original remaining budget; no generic fresh5s process
 * query. Registration precedes spawn and survives expiry until actual child close. */
export async function readOwnWindowsLifecycleIdentity(capability: LifecycleServingCapability, deadline: number): Promise<string> {
  const initial = assertLifecycleServingCapability(capability, "prepare");
  const current = () => {
    const actual = assertLifecycleServingCapability(capability, "prepare");
    if (!Number.isFinite(deadline) || performance.now() >= deadline) throw new WindowsLifecyclePathUnavailable("budget");
    if (process.platform !== "win32" ||
      actual.ownerInstance !== initial.ownerInstance || actual.generation !== initial.generation || actual.home !== initial.home)
      throw new WindowsLifecyclePathUnavailable("unavailable");
  };
  current(); if (pending.size) throw new WindowsLifecyclePathUnavailable("unavailable");
  const nonce = randomUUID(), registration = { capability, owner: initial.ownerInstance, generation: initial.generation, nonce,
    child: undefined as ReturnType<typeof spawn> | undefined,
    state: "not_attempted" as "not_attempted" | "attempted_unconfirmed" | "child_known" | "closed" };
  pending.add(registration);
  return new Promise((resolve, reject) => {
    let settled = false, output = "";
    const refuse = (reason: "unavailable" | "budget") => { if (!settled) { settled = true; clearTimeout(timer); reject(new WindowsLifecyclePathUnavailable(reason)); } };
    const timer = setTimeout(() => refuse("budget"), Math.max(0, deadline - performance.now()));
    try {
      current();
      const bin = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(OWN_IDENTITY, "utf16le").toString("base64")];
      registration.state = "attempted_unconfirmed"; // BEFORE native entry; catch/undefined PID never proves no attempt.
      const child = registration.child = spawn(bin, args,
        { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
      registration.state = "child_known";
      child.on("error", () => refuse("unavailable")); child.stdin!.on("error", () => refuse("unavailable")); child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => { if (!settled) { output += chunk; if (Buffer.byteLength(output) > 512) refuse("unavailable"); } });
      child.once("close", code => {
        registration.state = "closed"; pending.delete(registration); if (settled) return;
        try {
          current(); const response: unknown = JSON.parse(output);
          if (!response || typeof response !== "object") return refuse("unavailable");
          const value = response as Record<string, unknown>;
          if (code !== 0 || Object.keys(value).length !== 5 || Object.keys(value).some(key => !["schema", "nonce", "status", "pid", "creationTicks"].includes(key)) ||
            value.schema !== 1 || value.nonce !== nonce || value.status !== "verified" || value.pid !== process.pid ||
            typeof value.creationTicks !== "string" || !/^[1-9]\d{0,127}$/.test(value.creationTicks)) return refuse("unavailable");
          settled = true; clearTimeout(timer); resolve(value.creationTicks);
        } catch { refuse("unavailable"); }
      });
      child.stdin!.end(JSON.stringify({ schema: 1, nonce, pid: process.pid })); child.unref();
    } catch (error) {
      // ONLY source-proven refusal before native spawn entry can retire this exact
      // not-attempted registration. Unknown attempts/known children await real close.
      if (registration.state === "not_attempted" && registration.capability === capability && registration.owner === initial.ownerInstance &&
        registration.generation === initial.generation && registration.nonce === nonce) pending.delete(registration);
      refuse(error instanceof WindowsLifecyclePathUnavailable && error.reason === "budget" ? "budget" : "unavailable");
    }
  });
}

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
    const refuse = (reason: Reason, diagnostic?: Diagnostic) => { if (!settled) { settled = true; clearTimeout(timer); no(new WindowsLifecyclePathUnavailable(reason, diagnostic)); } };
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
        const keys = Object.keys(r);
        if (r.status !== "verified") {
          if (r.status === "unsafe_acl") {
            if (keys.length !== 7 || keys.some(key => !["schema", "nonce", "status", "rule", "role", "ancestorDepth", "ownerClass"].includes(key)) ||
              !RULES.includes(r.rule as Diagnostic["rule"]) || !ROLES.includes(r.role as Diagnostic["role"]) ||
              !OWNER_CLASSES.includes(r.ownerClass as Diagnostic["ownerClass"]) ||
              typeof r.ancestorDepth !== "number" || !Number.isSafeInteger(r.ancestorDepth) || r.ancestorDepth < 0 || r.ancestorDepth > 128) return refuse("unavailable");
            return refuse("unsafe_acl", { rule: r.rule as Diagnostic["rule"], role: r.role as Diagnostic["role"], ancestorDepth: r.ancestorDepth, ownerClass: r.ownerClass as Diagnostic["ownerClass"] });
          }
          if (keys.length !== 3 || keys.some(key => !["schema", "nonce", "status"].includes(key))) return refuse("unavailable");
          return refuse(["unsafe_path", "unsupported_fs"].includes(String(r.status)) ? r.status as Reason : "unavailable");
        }
        if (keys.length !== 4 || keys.some(key => !["schema", "nonce", "status", "filesystem"].includes(key))) return refuse("unavailable");
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

export interface WindowsLifecycleCreation { readonly __creation?: never }
const creations = new WeakMap<WindowsLifecycleCreation, { capability: LifecycleServingCapability; proof: WindowsLifecyclePathProof;
  home: string; owner: string; generation: number; paths: Snapshot }>();

// Only an exclusively source-created directory is protected. Files are created with
// .NET CreateNew (wx semantics) and their restrictive DACL at the actual creation.
// No existing file, HOME or ancestor ACL is adopted/repaired. No arbitrary commands.
const CREATE_NEW = String.raw`
$ErrorActionPreference='Stop'; $nonce=''
try {
  $raw=[Console]::In.ReadToEnd(); if($raw.Length -gt 8192) { throw 'unavailable' }
  $r=$raw | ConvertFrom-Json; $nonce=[string]$r.nonce
  if($r.schema -ne 1 -or $nonce -notmatch '^[0-9a-f-]{36}$') { throw 'unavailable' }
  $dir=[IO.Path]::Combine([IO.Path]::GetFullPath([string]$r.home),'.core-lifecycle')
  $attr=[IO.File]::GetAttributes($dir)
  if(($attr -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or ($attr -band [IO.FileAttributes]::Directory) -eq 0 -or
     [IO.Directory]::GetCreationTimeUtc($dir).Ticks.ToString() -ne [string]$r.creationTicks) { throw 'unavailable' }
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $allow=[Security.AccessControl.AccessControlType]::Allow
  $acl=New-Object Security.AccessControl.DirectorySecurity
  $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false)
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','None','None',$allow)))
  [IO.Directory]::SetAccessControl($dir,$acl)
  foreach($name in @('receipts.sqlite','receipts.sqlite-journal')) {
    $acl=New-Object Security.AccessControl.FileSecurity
    $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false)
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl',$allow)))
    $stream=New-Object IO.FileStream([IO.Path]::Combine($dir,$name),[IO.FileMode]::CreateNew,
      [Security.AccessControl.FileSystemRights]::FullControl,[IO.FileShare]::None,4096,[IO.FileOptions]::None,$acl)
    $stream.Dispose()
  }
  @{schema=1;nonce=$nonce;status='created'} | ConvertTo-Json -Compress
} catch { @{schema=1;nonce=$nonce;status='unknown'} | ConvertTo-Json -Compress }
`;

/** Boundary1 only: actual serving capability -> exclusive new objects -> fresh ACL
 * evidence. Neither this opaque result nor file existence grants admission/promotion. */
export async function createWindowsLifecycleObjects(capability: LifecycleServingCapability, deadline: number): Promise<WindowsLifecycleCreation> {
  try {
  const initial = assertLifecycleServingCapability(capability, "prepare");
  const expires = Math.min(deadline, performance.now() + PHASE_MS.prepare);
  const current = () => {
    const actual = assertLifecycleServingCapability(capability, "prepare");
    if (process.platform !== "win32" || pending.size || !Number.isFinite(expires) || performance.now() >= expires ||
      actual.home !== initial.home || actual.ownerInstance !== initial.ownerInstance || actual.generation !== initial.generation)
      throw new WindowsLifecyclePathUnavailable("unavailable");
    return actual;
  };
  current();
  const homeProof = await verifyWindowsLifecyclePaths(initial.home, initial.ownerInstance, "prepare", "home", expires);
  current(); assertWindowsLifecyclePathProof(homeProof, initial.home, initial.ownerInstance, "prepare", "home");
  const dir = join(initial.home, DIRECTORY);
  // Atomic exclusive mkdir; never recursive, never an existing interrupted object.
  try { current(); mkdirSync(dir); } catch { throw new WindowsLifecyclePathUnavailable("unavailable"); }
  const created = lstatSync(dir, { bigint: true });
  if (!created.isDirectory() || created.isSymbolicLink() || created.ino <= 0n) throw new WindowsLifecyclePathUnavailable("unsafe_path");
  const directoryIdentity = `${created.dev}:${created.ino}:${created.birthtimeNs}`;
  current(); assertWindowsLifecyclePathProof(homeProof, initial.home, initial.ownerInstance, "prepare", "home");
  const nonce = randomUUID(), bin = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(CREATE_NEW, "utf16le").toString("base64")],
      { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    const registration = {}; pending.add(registration); let settled = false, output = "";
    const refuse = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new WindowsLifecyclePathUnavailable("unavailable")); } };
    const timer = setTimeout(refuse, Math.max(0, expires - performance.now()));
    child.on("error", refuse); child.stdin!.on("error", refuse); child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => { if (!settled) { output += chunk; if (Buffer.byteLength(output) > 512) refuse(); } });
    child.once("close", code => {
      pending.delete(registration); if (settled) return;
      try {
        current(); const response: unknown = JSON.parse(output);
        if (!response || typeof response !== "object") return refuse();
        const value = response as Record<string, unknown>;
        if (code !== 0 || Object.keys(value).length !== 3 || Object.keys(value).some(key => !["schema", "nonce", "status"].includes(key)) ||
          value.schema !== 1 || value.nonce !== nonce || value.status !== "created") return refuse();
        settled = true; clearTimeout(timer); resolve();
      } catch { refuse(); }
    });
    child.stdin!.end(JSON.stringify({ schema: 1, nonce, home: initial.home, creationTicks: String(created.birthtimeNs / 100n + 621355968000000000n) }));
    child.unref();
  });
  current();
  const after = lstatSync(dir, { bigint: true });
  if (`${after.dev}:${after.ino}:${after.birthtimeNs}` !== directoryIdentity) throw new WindowsLifecyclePathUnavailable("unsafe_path");
  const identities = snapshot(initial.home, "established");
  const proof = await verifyWindowsLifecyclePaths(initial.home, initial.ownerInstance, "prepare", "established", expires);
  current(); assertWindowsLifecyclePathProof(proof, initial.home, initial.ownerInstance, "prepare", "established");
  if (!same(identities, snapshot(initial.home, "established"))) throw new WindowsLifecyclePathUnavailable("unsafe_path");
  const result = Object.freeze({});
  creations.set(result, { capability, proof, home: initial.home, owner: initial.ownerInstance, generation: initial.generation, paths: identities });
  return result;
  } catch (error) {
    if (error instanceof WindowsLifecyclePathUnavailable) throw error;
    throw new WindowsLifecyclePathUnavailable("unavailable");
  }
}

/** Immediate source-owned identity/capability/phase recheck for the next bounded SQL
 * action. No constructor/flag/copy can mint this exclusively-new-object provenance. */
export function assertWindowsLifecycleCreation(creation: WindowsLifecycleCreation, capability: LifecycleServingCapability): void {
  const record = creations.get(creation), actual = assertLifecycleServingCapability(capability, "prepare");
  if (!record || record.capability !== capability || actual.home !== record.home || actual.ownerInstance !== record.owner ||
    actual.generation !== record.generation) throw new WindowsLifecyclePathUnavailable("unavailable");
  assertWindowsLifecyclePathProof(record.proof, record.home, record.owner, "prepare", "established");
  try { if (!same(record.paths, snapshot(record.home, "established"))) throw new WindowsLifecyclePathUnavailable("unsafe_path"); }
  catch { throw new WindowsLifecyclePathUnavailable("unsafe_path"); }
}
