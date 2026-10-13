import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackupBackground } from "../src/core/backup-background.js";
import { listMessageBackups } from "../src/core/message-backups.js";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

let env: TestEnv, backup: BackupBackground | undefined, lock: DatabaseSync | undefined;
beforeEach(() => { env = makeEnv(); vi.stubEnv("AGENT_BRIDGE_AUTO_BACKUP", "1"); vi.stubEnv("AGENT_BRIDGE_BACKUP_INTERVAL_MS", "60000"); });
afterEach(async () => {
  backup?.pressure(false);
  if (lock?.isTransaction) lock.exec("ROLLBACK");
  lock?.close(); lock = undefined;
  await backup?.close(); backup = undefined;
  vi.restoreAllMocks(); vi.unstubAllEnvs(); await env.cleanup();
});
const deadline = () => performance.now() + 2000;
function sourceMail() {
  const db = new DatabaseSync(env.db);
  db.exec("CREATE TABLE messages(id TEXT PRIMARY KEY, body BLOB); INSERT INTO messages VALUES('accepted',X'0100ff');");
  db.close();
}
// Trigger the actual production fork without waiting for its unchanged 30-second startup timer.
function startOwnedCapture() {
  Reflect.get(backup!, "start").call(backup);
  const worker = Reflect.get(backup!, "worker");
  expect(worker).not.toBeNull(); return worker;
}

describe("owned automatic-backup settlement (not whole-core durability)", () => {
  it("quiesces and resumes the existing schedule without starting or cancelling a capture", async () => {
    backup = new BackupBackground(env.home, nullLogger);
    const due = Reflect.get(backup, "timerDueAt"); expect(due).toBeTypeOf("number");
    backup.quiesceLifecycleMaintenance();
    expect(Reflect.get(backup, "timer")).toBeNull(); expect(Reflect.get(backup, "resumeDueAt")).toBe(due);
    expect(await backup.settleLifecycleMaintenance(deadline())).toMatchObject({ settled: true, pendingWorkers: 0, unknown: false });
    backup.resumeLifecycleMaintenance();
    expect(Reflect.get(backup, "timer")).not.toBeNull();
    expect(Reflect.get(backup, "timerDueAt")).toBe(due);
    expect(backup.lifecycleOwnerManifest()).toMatchObject({ quiesced: false, settled: false, pendingWorkers: 0 });
  });
  it("timeout and second observer leave the same actual capture alive; completion preserves exact accepted bytes", async () => {
    sourceMail(); backup = new BackupBackground(env.home, nullLogger);
    const worker = startOwnedCapture();
    // Actual IPC pressure reaches the worker at its existing yielded capture checkpoints.
    backup.pressure(true);
    const send = vi.spyOn(worker, "send"), kill = vi.spyOn(worker, "kill");
    backup.quiesceLifecycleMaintenance();
    const pending = backup.settleLifecycleMaintenance(performance.now() + 20);
    expect(await backup.settleLifecycleMaintenance(deadline())).toMatchObject({ settled: false, pendingWorkers: 1 });
    expect(await pending).toMatchObject({ settled: false, pendingWorkers: 1, unknown: false });
    expect(Reflect.get(backup, "worker")).toBe(worker); expect(worker.exitCode).toBeNull();
    expect(send).not.toHaveBeenCalled(); expect(kill).not.toHaveBeenCalled();
    backup.pressure(false);
    expect(await backup.settleLifecycleMaintenance(deadline())).toMatchObject({ settled: true, pendingWorkers: 0, unknown: false });
    expect(worker.exitCode).toBe(0); expect(kill).not.toHaveBeenCalled();
    expect(send.mock.calls.some(call => (call[0] as { type?: string }).type === "stop")).toBe(false);
    const snapshots = listMessageBackups(env.home); expect(snapshots).toHaveLength(1);
    const copied = new DatabaseSync(join(snapshots[0]!.path, "bridge.messages.db"), { readOnly: true });
    const original = new DatabaseSync(env.db, { readOnly: true });
    try {
      expect(copied.prepare("SELECT id,body FROM messages").all()).toEqual(original.prepare("SELECT id,body FROM messages").all());
      expect(copied.prepare("SELECT body FROM messages WHERE id='accepted'").get()!.body).toEqual(new Uint8Array([1, 0, 255]));
    } finally { copied.close(); original.close(); }
    expect(Reflect.get(backup, "timer")).toBeNull();
    backup.resumeLifecycleMaintenance(); expect(Reflect.get(backup, "timer")).not.toBeNull();
  });
  it("an actual foreign coordination lock is not a successful owned checkpoint even when the worker exits zero", async () => {
    sourceMail(); lock = new DatabaseSync(join(env.home, "message-backup-lock.db")); lock.exec("BEGIN IMMEDIATE");
    backup = new BackupBackground(env.home, nullLogger); const worker = startOwnedCapture();
    backup.quiesceLifecycleMaintenance();
    expect(await backup.settleLifecycleMaintenance(deadline())).toMatchObject({ settled: false, pendingWorkers: 0, unknown: true });
    await until(() => worker.exitCode !== null); expect(worker.exitCode).toBe(0);
    expect(listMessageBackups(env.home)).toHaveLength(0);
    const original = new DatabaseSync(env.db, { readOnly: true });
    try { expect(original.prepare("SELECT body FROM messages WHERE id='accepted'").get()!.body).toEqual(new Uint8Array([1, 0, 255])); }
    finally { original.close(); }
    backup.resumeLifecycleMaintenance(); expect(backup.lifecycleOwnerManifest().unknown).toBe(true);
  });
});
