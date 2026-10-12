import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { loadMobileIdentity } from "../src/mobile/identity.js";

function descriptor(path: string) {
  const script = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $a=Get-Acl -LiteralPath ([Console]::In.ReadLine()); [pscustomobject]@{protected=$a.AreAccessRulesProtected; owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value; caller=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object {[pscustomobject]@{sid=$_.IdentityReference.Value; inherited=$_.IsInherited; allow=$_.AccessControlType -eq 'Allow'; rights=[int]$_.FileSystemRights}})} | ConvertTo-Json -Depth 4 -Compress";
  return JSON.parse(execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { encoding: "utf8", input: path + "\n", windowsHide: true }));
}

it.runIf(process.platform === "win32")("removes inherited ACLs from newly created identity key and state files", async () => {
  const home = mkdtempSync(join(tmpdir(), "ci-identity-"));
  const identity = await loadMobileIdentity(home, ["https://fixture.private.test:8443"]);
  for (const child of ["keys", "states"]) {
    const directory = join(home, "mobile-identity", child);
    for (const name of readdirSync(directory)) {
      const file = join(directory, name), acl = descriptor(file);
      expect(acl.protected).toBe(true);
      expect(acl.owner).toBe(acl.caller);
      expect(acl.rules).toHaveLength(1);
      expect(acl.rules[0]).toMatchObject({ sid: acl.caller, inherited: false, allow: true });
      if (child === "keys") expect(readFileSync(file)).toEqual(identity.key);
    }
  }
}, 30_000);

it.runIf(process.platform === "win32" && process.env.AGENT_BRIDGE_CI_WINDOWS === "1")("uses a protected runner-like fixture root and a fresh test home", () => {
  const root = process.env.AGENT_BRIDGE_TEST_ROOT!, acl = descriptor(root);
  expect(acl.protected).toBe(true);
  expect(acl.rules.every((rule: { inherited: boolean; allow: boolean }) => !rule.inherited && rule.allow)).toBe(true);
  expect(acl.rules.map((rule: { sid: string }) => rule.sid).sort()).toEqual([...new Set([acl.caller, "S-1-5-18", "S-1-5-32-544"])].sort());
  expect(process.env.AGENT_BRIDGE_HOME).toBe(join(root, "default-home"));
  expect(tmpdir()).toBe(join(root, "temp"));
  expect(process.env.CI).toBe("true");
});
