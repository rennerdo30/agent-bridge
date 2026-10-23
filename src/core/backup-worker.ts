import { constants, getPriority, setPriority } from "node:os";
import { setTimeout as pause } from "node:timers/promises";
import { messageBackupIfDue } from "./message-backups.js";

let pending = false, stop = false, pauseUntil = 0, pressureSince = 0, started = false;
let progressNonce: string | undefined, progressStarted = 0, lastProgress = "", progressCount = 0;
function progress(phase: string): void {
  if (!progressNonce || lastProgress === phase || progressCount >= 32) return;
  lastProgress = phase; progressCount++;
  process.send?.({ type: "backupProgress", nonce: progressNonce, phase, elapsedMs: Math.max(0, Math.min(60000, Math.round(performance.now() - progressStarted))) }, () => {});
}
process.on("message", (message: { type?: string; pending?: boolean; pauseUntil?: number; home?: string; nonce?: string }) => {
  if (message.type === "pressure") { pending = !!message.pending; pauseUntil = message.pauseUntil ?? 0; }
  if (message.type === "stop") stop = true;
  if (message.type === "start" && typeof message.home === "string" && !started) {
    started = true; progressStarted = performance.now();
    if (typeof message.nonce === "string" && /^[a-f0-9-]{36}$/.test(message.nonce)) progressNonce = message.nonce;
    void run(message.home);
  }
});
process.once("disconnect", () => { stop = true; });

async function checkpoint(): Promise<void> {
  for (;;) {
    if (stop) throw new Error("Automatic message backup stopped; incomplete snapshot preserved");
    if (!pending && Date.now() >= pauseUntil) { pressureSince = 0; break; }
    progress("pressure-paused");
    pressureSince ||= Date.now();
    if (Date.now() - pressureSince >= 5_000) throw new Error("Automatic message backup paused for sustained broker pressure; incomplete snapshot preserved");
    await pause(100);
  }
  // Each capture/verification window is at most 64 rows or 256 KiB.
  progress("checkpoint-yield");
  await pause(5);
  if (stop) throw new Error("Automatic message backup stopped; incomplete snapshot preserved");
}

async function run(home: string): Promise<void> {
  try {
    progress("run-entered");
    setPriority(process.pid, constants.priority.PRIORITY_LOW);
    const priority = getPriority(process.pid);
    if (priority < constants.priority.PRIORITY_BELOW_NORMAL) throw new Error("Automatic message backup could not lower its process priority");
    progress("priority-lowered");
    const result = await messageBackupIfDue(home, { checkpoint });
    progress("result-ready");
    process.send?.({ ...result, priority }, () => process.disconnect?.());
  } catch (error) { process.send?.({ error: String(error) }, () => process.disconnect?.()); }
}
