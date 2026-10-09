import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { processIdentity, recordedOwnerAlive } from "./process-identity.js";

/**
 * Whether the lock file's owner is provably gone: no such process, or (AB-218) the PID now belongs to a different
 * process (identity mismatch, or for identity-less older locks a process started after the lock was written).
 * Unreadable or unverifiable owners count as alive. `null` when the file vanished.
 */
function ownerGone(path: string, verdicts: Map<string, boolean>): boolean | null {
  let text: string, writtenAt: number;
  try { text = readFileSync(path, "utf8"); writtenAt = statSync(path).mtimeMs; }
  catch { return null; }
  let owner: { pid?: unknown; identity?: unknown };
  try { owner = JSON.parse(text); } catch { return false; /* An opening writer has not published its PID yet. */ }
  const pid = Number(owner.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try { process.kill(pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  // The process identity probe is slow (PowerShell on Windows) and a live owner's identity does not change while
  // we wait: probe each distinct owner record once per acquisition.
  let gone = verdicts.get(text);
  if (gone === undefined) verdicts.set(text, gone = !recordedOwnerAlive(pid, typeof owner.identity === "string" ? owner.identity : undefined, writtenAt));
  return gone;
}

/** Serialize snapshot creation as well as DDL. Never expire a living writer by age. */
export function migrationLock(file: string): () => void {
  if (file === ":memory:") return () => {};
  const path = `${file}.migration-lock`, recovery = `${path}.recovery`;
  const identity = processIdentity(process.pid);
  const owner = JSON.stringify({ pid: process.pid, nonce: randomUUID(), ...(identity ? { identity } : {}) });
  const until = Date.now() + 5_000;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const verdicts = new Map<string, boolean>();
  for (;;) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try { writeFileSync(fd, owner); }
      catch (error) { closeSync(fd); rmSync(path); throw error; }
      closeSync(fd);
      return () => { if (readFileSync(path, "utf8") === owner) rmSync(path); };
    } catch (error) {
      if (!["EEXIST", "EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    // Only dead writers need recovery. A separate exclusive file serializes recoverers.
    let recoveryFd: number | undefined;
    try {
      if (existsSync(path) && ownerGone(path, verdicts)) {
        recoveryFd = openSync(recovery, "wx", 0o600);
        if (existsSync(path) && ownerGone(path, verdicts)) rmSync(path);
      }
    } catch (error) {
      if (!["EEXIST", "ENOENT", "EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    } finally { if (recoveryFd !== undefined) { closeSync(recoveryFd); rmSync(recovery); } }
    if (Date.now() >= until) throw Object.assign(new Error("another session is migrating this store; waiting for its protected snapshot and commit"), { code: "EBUSY" });
    Atomics.wait(pause, 0, 0, 20);
  }
}
