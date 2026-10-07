import { randomUUID } from "node:crypto";
import { ResourceSlots } from "./resource-slots.js";

/** Bound expensive startup across coordinators and CLIs, separately from running-job limits. */
export const STARTUP_CAPACITY = 2;
export const STARTUP_RESOURCE = "delegate-startup";

export async function acquireStartup(home: string, signal: AbortSignal): Promise<() => void> {
  const slots = new ResourceSlots(home);
  const owner = { id: `startup-${randomUUID()}`, pid: process.pid };
  try { await slots.acquire(STARTUP_RESOURCE, STARTUP_CAPACITY, owner, signal); }
  catch (err) { slots.close(); throw err; }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { slots.release(owner, STARTUP_RESOURCE); } finally { slots.close(); }
  };
}
