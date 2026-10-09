import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  messageBackupIfDue
} from "./chunks/chunk-JP5CDJME.mjs";
import "./chunks/chunk-ZI3EJK3N.mjs";
import "./chunks/chunk-P6KUA2PD.mjs";
import "./chunks/chunk-GWP4RZPO.mjs";
import "./chunks/chunk-HHAVWD7J.mjs";

// src/core/backup-worker.ts
import { constants, getPriority, setPriority } from "node:os";
import { setTimeout as pause } from "node:timers/promises";
var pending = false;
var stop = false;
var pauseUntil = 0;
var pressureSince = 0;
var started = false;
process.on("message", (message) => {
  if (message.type === "pressure") {
    pending = !!message.pending;
    pauseUntil = message.pauseUntil ?? 0;
  }
  if (message.type === "stop") stop = true;
  if (message.type === "start" && typeof message.home === "string" && !started) {
    started = true;
    void run(message.home);
  }
});
process.once("disconnect", () => {
  stop = true;
});
async function checkpoint() {
  for (; ; ) {
    if (stop) throw new Error("Automatic message backup stopped; incomplete snapshot preserved");
    if (!pending && Date.now() >= pauseUntil) {
      pressureSince = 0;
      break;
    }
    pressureSince ||= Date.now();
    if (Date.now() - pressureSince >= 5e3) throw new Error("Automatic message backup paused for sustained broker pressure; incomplete snapshot preserved");
    await pause(100);
  }
  await pause(5);
  if (stop) throw new Error("Automatic message backup stopped; incomplete snapshot preserved");
}
async function run(home) {
  try {
    setPriority(process.pid, constants.priority.PRIORITY_LOW);
    const priority = getPriority(process.pid);
    if (priority < constants.priority.PRIORITY_BELOW_NORMAL) throw new Error("Automatic message backup could not lower its process priority");
    const result = await messageBackupIfDue(home, { checkpoint });
    process.send?.({ ...result, priority }, () => process.disconnect?.());
  } catch (error) {
    process.send?.({ error: String(error) }, () => process.disconnect?.());
  }
}
