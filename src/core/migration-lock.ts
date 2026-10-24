import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync, writeFileSync, fstatSync, lstatSync } from "node:fs";
import { storageAdmissionRemaining } from "./storage-admission.js";
import { processIdentity, recordedOwnerLiveness } from "./process-identity.js";
import { ownerGone as bootOwnerGone } from "./boot-time.js";

/**
 * Whether the lock file's owner is provably gone: no such process, or (AB-218) the PID now belongs to a different
 * process (identity mismatch, or for identity-less older locks a process started after the lock was written).
 * Unreadable or unverifiable owners count as alive, unless the lock was written before the current boot (no process
 * survives a reboot). `null` when the file vanished.
 */
function lockOwnerGone(path: string, verdicts: Map<string, boolean>): boolean | null {
  let text: string, writtenAt: number;
  try { text = readFileSync(path, "utf8"); writtenAt = statSync(path).mtimeMs; }
  catch { return null; }
  let owner: { pid?: unknown; identity?: unknown };
  try { owner = JSON.parse(text); } catch { return false; /* An opening writer has not published its PID yet. */ }
  const pid = Number(owner.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  // EPERM or an unreadable start time is unknown: gone only when the lock predates the current boot (AB-256).
  try { process.kill(pid, 0); }
  catch (error) { return bootOwnerGone({ alive: (error as NodeJS.ErrnoException).code === "ESRCH" ? false : undefined, recordedAt: writtenAt }); }
  // The process identity probe is slow (PowerShell on Windows) and a live owner's identity does not change while
  // we wait: probe each distinct owner record once per acquisition.
  let gone = verdicts.get(text);
  if (gone === undefined) verdicts.set(text, gone = bootOwnerGone({ alive: recordedOwnerLiveness(pid, typeof owner.identity === "string" ? owner.identity : undefined, writtenAt), recordedAt: writtenAt }));
  return gone;
}

/** Serialize snapshot creation as well as DDL. Never expire a living writer by age. */
export function migrationLock(file: string): () => void {
  const admitted = storageAdmissionRemaining() !== undefined;
  if (file === ":memory:") return () => {};
  const path = `${file}.migration-lock`, recovery = `${path}.recovery`;
  const identity = processIdentity(process.pid);
  const owner = JSON.stringify({ pid: process.pid, nonce: randomUUID(), ...(identity ? { identity } : {}) });
  const until = admitted ? Infinity : Date.now() + 5_000;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const verdicts = new Map<string, boolean>();
  for (;;) {
    storageAdmissionRemaining();
    try {
      const fd = openSync(path, "wx", 0o600);
      const held=fstatSync(fd);
      try { storageAdmissionRemaining(); writeFileSync(fd, owner); storageAdmissionRemaining(); }
      catch (error) { closeSync(fd);let current;try{current=lstatSync(path);}catch{}if(current&&current.dev===held.dev&&current.ino===held.ino)rmSync(path);throw error; }
      closeSync(fd);
      return () => { if (readFileSync(path, "utf8") === owner) rmSync(path); };
    } catch (error) {
      if (!["EEXIST", "EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    // Admission never starts the legacy independent wait or owner probe. The
    // original caller may refuse busy, retaining the existing writer's lock.
    storageAdmissionRemaining();
    if(admitted)throw Object.assign(new Error('History migration lock busy within original admission'),{code:'EBUSY'});
    // Only dead writers need recovery. A separate exclusive file serializes recoverers.
    let recoveryFd: number | undefined;
    try {
      if (existsSync(path) && lockOwnerGone(path, verdicts)) {
        recoveryFd = openSync(recovery, "wx", 0o600);
        if (existsSync(path) && lockOwnerGone(path, verdicts)) rmSync(path);
      }
    } catch (error) {
      if (!["EEXIST", "ENOENT", "EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    } finally { if (recoveryFd !== undefined) { closeSync(recoveryFd); rmSync(recovery); } }
    if (Date.now() >= until) throw Object.assign(new Error("another session is migrating this store; waiting for its protected snapshot and commit"), { code: "EBUSY" });
    Atomics.wait(pause, 0, 0, 20);
  }
}
