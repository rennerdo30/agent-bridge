import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Broker, assertLifecycleServingCapability } from "../../src/core/broker.js";
import { BridgeClient } from "../../src/core/client.js";
import { PROTOCOL_VERSION } from "../../src/core/constants.js";
import { EndpointReservation } from "../../src/core/endpoint-reservation.js";
import { nullLogger } from "../../src/core/logger.js";
import { resolveDbPath, resolvePipePath } from "../../src/core/paths.js";
import { MessageStore } from "../../src/core/store.js";
import { readProcessIdentity } from "../../src/core/process-identity.js";
import type { TestEnv } from "../helpers.js";

// OWNED NEW fixture HOME only, never a profile/ancestor ACL or production mint.
const HOME = String.raw`
$ErrorActionPreference='Stop'
try {
  $r=[Console]::In.ReadToEnd() | ConvertFrom-Json
  if([IO.Directory]::Exists([string]$r.path)) { throw 'exists' }
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl=New-Object Security.AccessControl.DirectorySecurity
  $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false)
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','None','None','Allow')))
  [void][IO.Directory]::CreateDirectory([string]$r.path,$acl)
  [Console]::WriteLine('fixture_ready')
} catch { [Console]::WriteLine('fixture_unknown'); exit 1 }
`;
export async function createServingJournalFixture(env: TestEnv) {
  if (process.platform !== "win32") throw new Error("Owned serving journal fixture is Windows-specific");
  const home = join(env.home, "serving-home");
  const bin = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const child = spawn(bin, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(HOME, "utf16le").toString("base64")],
    { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  let output = "";
  child.stdout.on("data", bytes => { output += String(bytes); }); child.stdin.end(JSON.stringify({ path: home }));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Owned journal HOME fixture unavailable")), 5000);
      child.once("error", () => { clearTimeout(timer); reject(new Error("Owned journal HOME fixture unavailable")); });
      child.once("close", code => { clearTimeout(timer); code === 0 && output.trim() === "fixture_ready" ? resolve() : reject(new Error("Owned journal HOME fixture unavailable")); });
    });
  } finally { await closed; } // Timeout never grants cleanup or invents child exit.
  const endpoint = resolvePipePath(home, {}), reservation = await EndpointReservation.bind(endpoint);
  let broker: Broker | undefined;
  try {
    const store = new MessageStore(resolveDbPath(home), nullLogger), token = randomUUID();
    broker = new Broker(endpoint, store, nullLogger, token); broker.setHostingMode("daemon");
    await broker.listen(reservation);
    const client = await BridgeClient.connect(endpoint, nullLogger);
    try { await client.request("auth", { protocol: PROTOCOL_VERSION, token }); await client.request("ping", {}); }
    finally { client.close(); }
    const actual = assertLifecycleServingCapability(broker.lifecycleServingCapability("prepare", performance.now() + 5000), "prepare");
    const creationIdentity = await readProcessIdentity(process.pid);
    if (!creationIdentity) throw new Error("Owned journal fixture identity unavailable");
    const owner = { nonce: actual.ownerInstance, pid: process.pid, creationIdentity };
    return { home, broker, reservation, owner, async close() { await broker!.close(); await reservation.close(); } };
  } catch (error) { await broker?.close(); await reservation.close(); throw error; }
}
