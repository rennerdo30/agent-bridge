import { uptime } from "node:os";

const BOOT_MARGIN_MS = 60_000;

/**
 * No process survives a reboot, so a record or heartbeat written before this boot never belongs to a live
 * process. After a reboot Windows reuses low PIDs for protected system processes whose start time cannot be
 * read (EPERM), and zombies keep a PID without a readable identity; without this, such an owner would look
 * like an unidentified live one forever. A one-minute margin absorbs clock and uptime rounding.
 */
export function writtenBeforeBoot(at: number, now = Date.now(), upSeconds = uptime()): boolean {
  return Number.isFinite(at) && at > 0 && at < now - upSeconds * 1000 - BOOT_MARGIN_MS;
}

/**
 * Whether the owner of a lock, lease or runner record is gone. `alive` is the result of the module's own
 * liveness/identity check: false proves the owner gone, true proves it live. An unknown answer (EPERM, an
 * unreadable start time) proves it gone only when the owner's record/heartbeat predates the current boot;
 * a recent unknown owner is still treated as live.
 */
export function ownerGone({ alive, recordedAt }: { alive: boolean | undefined; recordedAt?: number }): boolean {
  if (alive !== undefined) return !alive;
  return recordedAt !== undefined && writtenBeforeBoot(recordedAt);
}
