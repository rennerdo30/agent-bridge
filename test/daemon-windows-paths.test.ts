import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, renameSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertWindowsLifecyclePathProof, pendingWindowsLifecycleVerifications, verifyWindowsLifecyclePaths } from "../src/core/lifecycle-windows.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { await until(() => pendingWindowsLifecycleVerifications() === 0); await env.cleanup(); });
// The static fixture changes ACLs ONLY on newly created paths inside its exact owned temp home.
// It never inspects or repairs the real user-profile ACL. The production verifier is read-only.
const PREPARE = String.raw`
$ErrorActionPreference='Stop'
try {
  $r=[Console]::In.ReadToEnd() | ConvertFrom-Json
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $foreign=New-Object Security.Principal.SecurityIdentifier('S-1-5-11')
  $allow=[Security.AccessControl.AccessControlType]::Allow
  $none=[Security.AccessControl.InheritanceFlags]::None
  function CreatePrivate([string]$path) {
    if([IO.Directory]::Exists($path)) { throw 'fixture exists' }
    $acl=New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false)
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl',$none,'None',$allow)))
    [void][IO.Directory]::CreateDirectory($path,$acl)
  }
  $ancestor=[IO.Path]::Combine([string]$r.root,'ancestor'); CreatePrivate $ancestor
  $fixtureHome=[IO.Path]::Combine($ancestor,'home'); CreatePrivate $fixtureHome
  $dir=[IO.Path]::Combine($fixtureHome,'.core-lifecycle'); CreatePrivate $dir
  foreach($name in @('receipts.sqlite','receipts.sqlite-journal')) {
    $path=[IO.Path]::Combine($dir,$name)
    $stream=New-Object IO.FileStream($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    $stream.Dispose()
    $acl=New-Object Security.AccessControl.FileSecurity
    $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false)
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl',$allow)))
    [IO.File]::SetAccessControl($path,$acl)
  }
  $acl=[IO.Directory]::GetAccessControl($ancestor)
  $grant=if($r.ancestorGrant -eq 'benign') { 'CreateDirectories,ReadAndExecute' } else { [string]$r.ancestorGrant }
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($foreign,$grant,$none,'None',$allow)))
  [IO.Directory]::SetAccessControl($ancestor,$acl)
  if($r.homeGrant -ne 'none') {
    $acl=[IO.Directory]::GetAccessControl($fixtureHome)
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($foreign,[string]$r.homeGrant,$none,'None',$allow)))
    [IO.Directory]::SetAccessControl($fixtureHome,$acl)
  }
  if($r.targetGrant -ne 'none') {
    $path=[IO.Path]::Combine($dir,'receipts.sqlite')
    $acl=[IO.File]::GetAccessControl($path)
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($foreign,[string]$r.targetGrant,$allow)))
    [IO.File]::SetAccessControl($path,$acl)
  }
  [Console]::WriteLine('fixture_ready')
} catch { [Console]::WriteLine('fixture_failed'); exit 1 }
`;
async function prepare(ancestorGrant = "benign", homeGrant = "none", targetGrant = "none") {
  const bin = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const child = spawn(bin, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(PREPARE, "utf16le").toString("base64")], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  let output = ""; child.stdout.on("data", bytes => { output += String(bytes); });
  child.stdin.end(JSON.stringify({ root: env.home, ancestorGrant, homeGrant, targetGrant }));
  await new Promise<void>((resolve, reject) => { child.once("error", () => reject(new Error("Owned ACL fixture unavailable"))); child.once("close", code => code === 0 && output.trim() === "fixture_ready" ? resolve() : reject(new Error("Owned ACL fixture setup failed"))); });
  return join(env.home, "ancestor", "home");
}
describe.skipIf(process.platform !== "win32")("Windows phase-local path observation (not SQLite/role/durability acceptance)", () => {
  it("permits owned profile-like ancestor sibling creation but enforces strict current-SID target protection", async () => {
    const home = await prepare(), owner = randomUUID();
    const before = lstatSync(join(home, ".core-lifecycle", "receipts.sqlite"), { bigint: true });
    const started = performance.now();
    const proof = await verifyWindowsLifecyclePaths(home, owner, "admission", "established", started + 1000);
    assertWindowsLifecyclePathProof(proof, home, owner, "admission", "established");
    expect(performance.now() - started).toBeLessThan(1000);
    const after = lstatSync(join(home, ".core-lifecycle", "receipts.sqlite"), { bigint: true });
    expect([after.dev, after.ino, after.birthtimeNs, after.mtimeNs, after.size]).toEqual([before.dev, before.ino, before.birthtimeNs, before.mtimeNs, before.size]);
    expect(() => assertWindowsLifecyclePathProof({ ...proof }, home, owner, "admission", "established")).toThrow("unavailable");
    expect(() => assertWindowsLifecyclePathProof(proof, home, randomUUID(), "admission", "established")).toThrow("unavailable");
  });
  it.each(["Modify", "Write", "DeleteSubdirectoriesAndFiles", "ChangePermissions", "TakeOwnership", "WriteAttributes", "WriteExtendedAttributes"])("refuses individual constituent ancestor control rights: %s", async grant => {
    const home = await prepare(grant);
    await expect(verifyWindowsLifecyclePaths(home, randomUUID(), "prepare", "established", performance.now() + 5000)).rejects.toMatchObject({ reason: "unsafe_acl" });
  });
  it.each([["CreateDirectories", "none"], ["WriteData", "none"], ["none", "Read"]])("does not reuse the ancestor exception for home or target grants (%s,%s)", async (homeGrant, targetGrant) => {
    const home = await prepare("benign", homeGrant, targetGrant);
    await expect(verifyWindowsLifecyclePaths(home, randomUUID(), "prepare", "established", performance.now() + 5000)).rejects.toMatchObject({ reason: "unsafe_acl" });
  });
  it("missing/changed identity and expiry never produce a usable phase proof; a late helper remains registered until exit", async () => {
    const home = await prepare(), owner = randomUUID();
    const proof = await verifyWindowsLifecyclePaths(home, owner, "prepare", "established", performance.now() + 5000);
    const journal = join(home, ".core-lifecycle", "receipts.sqlite-journal"); renameSync(journal, journal + ".retained");
    expect(() => assertWindowsLifecyclePathProof(proof, home, owner, "prepare", "established")).toThrow("unsafe_path");
    await expect(verifyWindowsLifecyclePaths(home, owner, "prepare", "established", performance.now() + 5000)).rejects.toMatchObject({ reason: "unsafe_path" });
    renameSync(journal + ".retained", journal);
    await expect(verifyWindowsLifecyclePaths(home, owner, "admission", "established", performance.now() - 1)).rejects.toMatchObject({ reason: "budget" });
    expect(pendingWindowsLifecycleVerifications()).toBe(0);
    await expect(verifyWindowsLifecyclePaths(home, owner, "admission", "established", performance.now() + 1)).rejects.toMatchObject({ reason: "budget" });
    expect(pendingWindowsLifecycleVerifications()).toBe(1);
    await expect(verifyWindowsLifecyclePaths(home, owner, "prepare", "established", performance.now() + 5000)).rejects.toMatchObject({ reason: "unavailable" });
    await until(() => pendingWindowsLifecycleVerifications() === 0);
  });
});
