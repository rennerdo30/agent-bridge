import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";

/** Serialize snapshot creation as well as DDL. Never expire a living writer by age. */
export function migrationLock(file: string): () => void {
  if (file === ":memory:") return () => {};
  const path = `${file}.migration-lock`, recovery = `${path}.recovery`;
  const owner = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  const until = Date.now() + 5_000;
  const pause = new Int32Array(new SharedArrayBuffer(4));
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
      let dead = false;
      if (existsSync(path)) try {
        const pid = JSON.parse(readFileSync(path, "utf8")).pid;
        if (Number.isSafeInteger(pid) && pid > 0) try { process.kill(pid, 0); }
        catch (error) { dead = (error as NodeJS.ErrnoException).code === "ESRCH"; }
      } catch { /* An opening writer has not published its PID yet. */ }
      if (dead) {
        recoveryFd = openSync(recovery, "wx", 0o600);
        if (existsSync(path)) {
          const pid = JSON.parse(readFileSync(path, "utf8")).pid;
          if (Number.isSafeInteger(pid) && pid > 0) try { process.kill(pid, 0); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") rmSync(path); }
        }
      }
    } catch (error) {
      if (!["EEXIST", "ENOENT", "EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    } finally { if (recoveryFd !== undefined) { closeSync(recoveryFd); rmSync(recovery); } }
    if (Date.now() >= until) throw Object.assign(new Error("another session is migrating this store; waiting for its protected snapshot and commit"), { code: "EBUSY" });
    Atomics.wait(pause, 0, 0, 20);
  }
}
