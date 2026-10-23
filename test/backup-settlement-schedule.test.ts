import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { BackupBackground } from "../src/core/backup-background.js";
import { messageBackupIfDue } from "../src/core/message-backups.js";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv, type TestEnv } from "./helpers.js";

const transport = vi.hoisted(() => ({ path: "", starts: 0, builds: 0, worker: undefined as ChildProcess | undefined }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  // A controlled transport object, never a native process or a fallthrough.
  fork: (file: string) => {
    if (file !== transport.path || !transport.worker) throw new Error("Unexpected native worker request in offline fixture");
    transport.starts++; return transport.worker;
  },
}));
vi.mock("node:module", async original => ({ ...await original<typeof import("node:module")>(),
  createRequire: () => { transport.builds++; throw new Error("No build is permitted in the offline backup fixture"); },
}));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, existsSync: (file: unknown) => file === transport.path || fs.existsSync(file as string),
    statSync: (file: unknown) => file === transport.path ? { mtimeMs: Number.MAX_SAFE_INTEGER } : fs.statSync(file as string) };
});

let env: TestEnv | undefined, backup: BackupBackground | undefined;
let ownedTransport: (EventEmitter & { exitCode: number | null }) | undefined;
afterEach(async () => {
  // Dispose only this fixture's EventEmitter transport on an early assertion
  // failure. Nonzero cleanup is not a successful worker/settlement witness.
  if (ownedTransport?.exitCode === null) { ownedTransport.exitCode = 1; ownedTransport.emit("exit", 1, null); }
  await backup?.close(); backup = undefined;
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  await env?.cleanup(); env = undefined; transport.worker = undefined; ownedTransport = undefined;
});

it("keeps the exact accepted capture pending after observer expiry and verified copy until its actual owned exit", async () => {
  env = makeEnv(); transport.path = join(env.home, "backup-worker.mjs"); transport.starts = 0; transport.builds = 0;
  vi.stubEnv("AGENT_BRIDGE_TEST_ROOT", env.home); vi.stubEnv("AGENT_BRIDGE_AUTO_BACKUP", "1"); vi.stubEnv("AGENT_BRIDGE_BACKUP_INTERVAL_MS", "60000");
  const original = new DatabaseSync(env.db);
  original.exec("CREATE TABLE messages(id TEXT PRIMARY KEY,body BLOB); INSERT INTO messages VALUES('accepted',x'0100ff')"); original.close();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const send = vi.fn((_message: unknown, callback?: () => void) => callback?.()), kill = vi.fn();
  const worker = Object.assign(new EventEmitter(), { connected: true, exitCode: null as number | null, send, kill, unref: vi.fn() });
  ownedTransport = worker;
  transport.worker = worker as unknown as ChildProcess;
  backup = new BackupBackground(env.home, nullLogger); Reflect.get(backup, "start").call(backup);
  expect(transport.starts).toBe(1); expect(transport.builds).toBe(0);
  backup.pressure(true); backup.quiesceLifecycleMaintenance(); send.mockClear();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), suspended = new Promise<void>(resolve => { entered = resolve; });
  const copying = messageBackupIfDue(env.home, { checkpoint: async () => { entered(); await held; } });
  await suspended;
  try {
    const first = backup.settleLifecycleMaintenance(performance.now() + 20);
    expect(await backup.settleLifecycleMaintenance(performance.now() + 2000)).toMatchObject({ settled: false, pendingWorkers: 1 });
    await vi.advanceTimersByTimeAsync(21);
    expect(await first).toMatchObject({ settled: false, pendingWorkers: 1, unknown: false });
    expect(Reflect.get(backup, "worker")).toBe(worker); expect(send).not.toHaveBeenCalled(); expect(kill).not.toHaveBeenCalled();
    backup.pressure(false); release();
    const result = await copying; expect(result.path).toBeTypeOf("string"); worker.emit("message", result);
    expect(backup.lifecycleOwnerManifest()).toMatchObject({ settled: false, pendingWorkers: 1, unknown: false });
    const completion = backup.settleLifecycleMaintenance(performance.now() + 2000);
    await vi.advanceTimersByTimeAsync(2001); // IPC success is not exit/settlement proof.
    expect(await completion).toMatchObject({ settled: false, pendingWorkers: 1, unknown: false });
    expect(Reflect.get(backup, "worker")).toBe(worker); expect(kill).not.toHaveBeenCalled();
    worker.exitCode = 0; worker.emit("exit", 0, null);
    expect(await backup.settleLifecycleMaintenance(performance.now() + 2000)).toMatchObject({ settled: true, pendingWorkers: 0, unknown: false });
    expect(transport.starts).toBe(1); expect(send.mock.calls.some(call => (call[0] as { type?: string }).type === "stop")).toBe(false);
    const copied = new DatabaseSync(join(result.path!, "bridge.messages.db"), { readOnly: true }), source = new DatabaseSync(env.db, { readOnly: true });
    try {
      expect(copied.prepare("SELECT id,body FROM messages").all()).toEqual(source.prepare("SELECT id,body FROM messages").all());
      expect(copied.prepare("SELECT body FROM messages").get()!.body).toEqual(new Uint8Array([1, 0, 255]));
    } finally { copied.close(); source.close(); }
  } finally {
    release();
    try { await copying; } // Own accepted copy, even if a preceding assertion fails.
    finally { if (worker.exitCode === null) { worker.exitCode = 0; worker.emit("exit", 0, null); } }
  }
});
