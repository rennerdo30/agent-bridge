import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * AB-427: Windows identities from the resident native host (OpenProcess + GetProcessTimes) instead of one
 * PowerShell launch per query. The PowerShell probes stay as the fallback, so every native reading is compared
 * with the PowerShell reading of the same process. Launches from process-identity.ts are recorded; the host
 * itself is spawned by a worker thread and is not part of this module's mocked child_process.
 */
const launches = vi.hoisted(() => [] as string[]);
vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  type Fn = ((...args: unknown[]) => unknown) & { [promisify.custom]?: (...args: unknown[]) => unknown };
  const record = (fn: Fn): Fn => {
    const wrapped: Fn = (...args) => { launches.push(String(args[0])); return fn(...args); };
    const custom = fn[promisify.custom];
    if (custom) wrapped[promisify.custom] = (...args) => { launches.push(String(args[0])); return custom(...args); };
    return wrapped;
  };
  return { ...actual, execFile: record(actual.execFile as Fn), execFileSync: record(actual.execFileSync as Fn) };
});

const windows = process.platform === "win32";
type Identity = typeof import("../src/core/process-identity.js");
type Native = typeof import("../src/core/windows-process-identity.js");
let identity: Identity, native: Native;
const children: ChildProcess[] = [];

beforeEach(async () => {
  vi.resetModules();
  identity = await import("../src/core/process-identity.js");
  native = await import("../src/core/windows-process-identity.js");
  launches.length = 0;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await native?.stopNativeIdentityHost();
  native?.resetNativeIdentityCooldown();
  for (const child of children.splice(0)) await stopChild(child);
});
afterAll(async () => { await native?.stopNativeIdentityHost(); });

/** A child this test starts and stops itself (its PID is recorded in `children`). */
async function startChild(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", "process.send('ready');setInterval(()=>{},1000)"], { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
  children.push(child);
  await new Promise<void>((resolve, reject) => { child.once("message", () => resolve()); child.once("error", reject); });
  return child;
}
async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill(); });
}

/** Today's persisted format, read the way it was always read. */
function powershellTicks(pid: number): string {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`],
  { encoding: "utf8", windowsHide: true, timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
}

it.runIf(windows)("reads the exact PowerShell tick identity for this process and a child, sync and async", async () => {
  const child = await startChild();
  const expected = new Map([[process.pid, powershellTicks(process.pid)], [child.pid!, powershellTicks(child.pid!)]]);
  for (const ticks of expected.values()) expect(ticks).toMatch(/^\d+$/);
  expect(await native.nativeIdentityHostStarted()).toBe(true);
  launches.length = 0;
  for (const [pid, ticks] of expected) {
    expect(native.readNativeIdentitiesSync([pid], 5_000)?.get(pid)).toBe(ticks);
    expect((await native.readNativeIdentities([pid], 5_000))?.get(pid)).toBe(ticks);
    expect(identity.processIdentity(pid)).toBe(ticks);
    expect(await identity.readProcessIdentity(pid)).toBe(ticks);
    expect(identity.processStartMs(pid)).toBe(Number(BigInt(ticks) / 10_000n - 62_135_596_800_000n));
  }
  // Every read above came from the host: no PowerShell launch from process-identity.ts.
  expect(launches).toEqual([]);
});

it.runIf(windows)("answers a batch in one request, with exited, invalid and protected PIDs", async () => {
  const live = await startChild(), gone = await startChild();
  const deadPid = gone.pid!;
  await stopChild(gone);
  const liveTicks = powershellTicks(live.pid!), ownTicks = powershellTicks(process.pid);
  const legacyProtected = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "Get-Process -Id 4 -ErrorAction SilentlyContinue | ForEach-Object { try { [string]$_.StartTime.ToUniversalTime().Ticks } catch { '' } }"],
  { encoding: "utf8", windowsHide: true, timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  expect(await native.nativeIdentityHostStarted()).toBe(true);
  launches.length = 0;
  const pids = [process.pid, live.pid!, deadPid, 2147483647, 4];
  const sync = identity.readProcessIdentitiesSync(pids)!;
  const batch = await identity.readProcessIdentities(pids);
  expect(launches).toEqual([]);
  for (const result of [sync, batch]) {
    expect(result.get(process.pid)).toBe(ownTicks);
    expect(result.get(live.pid!)).toBe(liveTicks);
    expect(result.has(2147483647)).toBe(false);
    // A newly reused PID may legitimately appear; an exited process never does.
    try { process.kill(deadPid, 0); } catch { expect(result.has(deadPid)).toBe(false); }
  }
  // The System process is running. The synchronous batch lists it ("" when its times are unreadable); the
  // asynchronous batch, like Get-Process, leaves out an unreadable one. Native access may read more than
  // .NET's, never something different.
  expect(sync.has(4)).toBe(true);
  if (legacyProtected) expect(sync.get(4)).toBe(legacyProtected);
  expect(batch.get(4) ?? "").toBe(sync.get(4));
});

it.runIf(windows)("keeps the PowerShell probe while the host is cold, then reads natively", async () => {
  const ticks = powershellTicks(process.pid);
  launches.length = 0;
  expect(native.nativeIdentityHostReady()).toBe(false);
  // The first read must not wait for the host's start: it runs today's probe and warms the host.
  expect(identity.processIdentity(process.pid)).toBe(ticks);
  expect(launches).toEqual(["powershell.exe"]);
  expect(await native.nativeIdentityHostStarted()).toBe(true);
  const pid = native.nativeIdentityHostPid();
  expect(pid).toBeGreaterThan(0);
  launches.length = 0;
  expect(await identity.readProcessIdentity(process.pid)).toBe(ticks);
  expect(launches).toEqual([]);
});

it.runIf(windows)("falls back to PowerShell when the host cannot start, with the same result", async () => {
  // A host binary that does not exist: the start fails and the cooldown keeps native reads off.
  const ticks = powershellTicks(process.pid);
  vi.stubEnv("SystemRoot", "Z:\\agent-bridge-missing-windows-root");
  expect(await native.nativeIdentityHostStarted(10_000)).toBe(false);
  // PowerShell itself needs the real SystemRoot; the failed host stays off through its cooldown.
  vi.unstubAllEnvs();
  launches.length = 0;
  expect(identity.processIdentity(process.pid)).toBe(ticks);
  expect(await identity.readProcessIdentity(process.pid)).toBe(ticks);
  expect(identity.readProcessIdentitiesSync([process.pid])?.get(process.pid)).toBe(ticks);
  expect(launches.filter(file => file === "powershell.exe")).toHaveLength(3);
});

it.runIf(windows)("falls back to PowerShell when native reads are switched off", async () => {
  vi.stubEnv("AGENT_BRIDGE_NATIVE_PROCESS_IDENTITY", "0");
  const ticks = powershellTicks(process.pid);
  launches.length = 0;
  expect(await native.nativeIdentityHostStarted(1_000)).toBe(false);
  expect(await identity.readProcessIdentity(process.pid)).toBe(ticks);
  expect(launches).toEqual(["powershell.exe"]);
  expect(native.nativeIdentityHostPid()).toBeUndefined();
});

it.runIf(windows)("answers single reads in milliseconds once the host is ready (loose sanity bound)", async () => {
  const child = await startChild();
  expect(await native.nativeIdentityHostStarted()).toBe(true);
  launches.length = 0;
  const samples: number[] = [];
  for (let i = 0; i < 5; i++) {
    const started = performance.now();
    // A child PID: unlike this process's own identity, it is never cached.
    expect(identity.processIdentity(child.pid!)).toMatch(/^\d+$/);
    samples.push(performance.now() - started);
  }
  console.info("native identity read ms", samples.map(ms => ms.toFixed(2)));
  // Loose: one PowerShell launch alone takes hundreds of ms; this only proves no launch per read.
  expect(Math.max(...samples)).toBeLessThan(1_000);
  expect(launches).toEqual([]);
});

it("keeps EPERM unknown and ESRCH gone before any probe", async () => {
  const kill = vi.spyOn(process, "kill");
  kill.mockImplementation((() => { throw Object.assign(new Error("protected"), { code: "EPERM" }); }) as typeof process.kill);
  expect(identity.isProcessIdentityAlive(2_000_427, "638950000000000001")).toBeUndefined();
  expect(identity.recordedOwnerLiveness(2_000_427, "638950000000000001", Date.now())).toBeUndefined();
  kill.mockImplementation((() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); }) as typeof process.kill);
  expect(identity.isProcessIdentityAlive(2_000_427, "638950000000000001")).toBe(false);
  expect(identity.recordedOwnerLiveness(2_000_427, "638950000000000001", Date.now())).toBe(false);
  expect(launches).toEqual([]);
});

it.runIf(!windows)("reports nothing natively off Windows, so POSIX paths stay unchanged", () => {
  expect(native.readNativeIdentitiesSync([process.pid], 1_000)).toBeUndefined();
  expect(native.readNativeIdentities([process.pid], 1_000)).toBeUndefined();
});
