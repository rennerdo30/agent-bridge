import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

// OWNED NEW fixture HOME only, never a profile/ancestor ACL or production mint.
// One long-lived helper per test file. Its powershell.exe cold start is setup that
// runs once, before the tests (beforeAll), and is bounded by the hook timeout; on a
// loaded runner that start alone can exceed the per-home observer. The unchanged 5 s
// observer then covers each exclusive creation by the already running helper.
const HELPER = String.raw`
$ErrorActionPreference='Stop'
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
[Console]::Out.WriteLine('helper_ready'); [Console]::Out.Flush()
for(;;) {
  $line=[Console]::In.ReadLine(); if($null -eq $line) { break }
  $id=''
  try {
    $r=$line | ConvertFrom-Json; $id=[string]$r.id
    if($id -notmatch '^[0-9]{1,9}$') { $id=''; throw 'id' }
    if([IO.Directory]::Exists([string]$r.path)) { throw 'exists' }
    $acl=New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false)
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','None','None','Allow')))
    [void][IO.Directory]::CreateDirectory([string]$r.path,$acl)
    [Console]::Out.WriteLine("fixture_ready $id")
  } catch { [Console]::Out.WriteLine("fixture_unknown $id") }
  [Console]::Out.Flush()
}
`;
const HOME_OBSERVER_MS = 5000;

type Helper = { child: ChildProcess; closed: Promise<void>; exited: boolean; next: number;
  responses: Map<string, (ready: boolean) => void>; outstanding: Set<Promise<void>> };
let helper: Helper | undefined;

/** Starts the file's owned-home helper (setup, before the tests). Idempotent. */
export async function startOwnedHomeHelper(): Promise<void> {
  if (process.platform !== "win32") throw new Error("Owned home helper is Windows-specific");
  if (helper && !helper.exited) return;
  const bin = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const child = spawn(bin, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(HELPER, "utf16le").toString("base64")],
    { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  const current: Helper = { child, closed: new Promise<void>(resolve => child.once("close", () => resolve())), exited: false, next: 0,
    responses: new Map(), outstanding: new Set() };
  helper = current;
  let ready!: () => void, failed!: (error: Error) => void;
  const started = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
  let buffer = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at).trim(); buffer = buffer.slice(at + 1);
      if (line === "helper_ready") { ready(); continue; }
      const match = /^fixture_(ready|unknown) (\d{1,9})$/.exec(line);
      const settle = match ? current.responses.get(match[2]!) : undefined;
      if (settle) { current.responses.delete(match![2]!); settle(match![1] === "ready"); }
    }
  });
  child.once("error", () => failed(new Error("Owned home helper unavailable")));
  child.stdin!.on("error", () => { /* A dead helper is reported through its close. */ });
  void current.closed.then(() => {
    current.exited = true; failed(new Error("Owned home helper unavailable"));
    // An exited helper settles every request it never answered as not ready.
    for (const settle of current.responses.values()) settle(false);
    current.responses.clear();
  });
  await started;
}

/** Exclusively creates a NEW current-SID-only protected HOME through the running helper.
 * The 5 s observer covers only this creation. A timed-out request stays outstanding until
 * its actual answer or the helper's exit (see settledOwnedHomes). */
export async function createOwnedHome(path: string, failure: string): Promise<void> {
  const current = helper;
  if (!current || current.exited) throw new Error(failure);
  const id = String(++current.next);
  let answered!: (ready: boolean) => void;
  const answer = new Promise<boolean>(resolve => { answered = resolve; });
  current.responses.set(id, answered);
  const outstanding = answer.then(() => undefined);
  current.outstanding.add(outstanding); void outstanding.then(() => current.outstanding.delete(outstanding));
  current.child.stdin!.write(JSON.stringify({ id, path }) + "\n");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(failure)), HOME_OBSERVER_MS);
    void answer.then(ready => { clearTimeout(timer); ready ? resolve() : reject(new Error(failure)); });
  });
}

/** Waits for every creation request's actual answer. An observer timeout never grants cleanup. */
export async function settledOwnedHomes(): Promise<void> {
  if (helper) await Promise.all([...helper.outstanding]);
}

/** Ends the helper and waits for its actual exit. */
export async function stopOwnedHomeHelper(): Promise<void> {
  const current = helper; helper = undefined;
  if (!current) return;
  await Promise.all([...current.outstanding]);
  current.child.stdin!.end();
  await current.closed;
}
