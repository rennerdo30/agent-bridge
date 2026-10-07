import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { protect } from "../network/pairing.js";

export const DASHBOARD_KEY_FILE = "dashboard-key";
const KEY_PATTERN = /^[0-9a-f]{48}$/;

/** Publish a complete, protected key atomically, including competing first starts. */
export function loadDashboardKey(home: string, legacy?: string, reset = false): string {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, DASHBOARD_KEY_FILE);
  if (reset || !existsSync(file)) {
    const temp = join(home, `.dashboard-key-${randomUUID()}`);
    let created = false;
    try {
      writeFileSync(temp, "", { flag: "wx", mode: 0o600 });
      created = true;
      protect(temp, 0o600);
      writeFileSync(temp, !reset && legacy && KEY_PATTERN.test(legacy) ? legacy : randomBytes(24).toString("hex"));
      if (reset) renameSync(temp, file);
      else {
        try { linkSync(temp, file); }
        catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
      }
    } finally { if (created && existsSync(temp)) unlinkSync(temp); }
  }
  protect(file, 0o600);
  const key = readFileSync(file, "utf8").trim();
  if (!KEY_PATTERN.test(key)) throw new Error("Invalid dashboard key file; run agent-bridge ui --reset-key to recover.");
  return key;
}

/** Request-time reload makes explicit reset invalidate cookies in every live host. */
export function currentDashboardKey(home: string): string {
  const key = readFileSync(join(home, DASHBOARD_KEY_FILE), "utf8").trim();
  if (!KEY_PATTERN.test(key)) throw new Error("Invalid dashboard key file");
  return key;
}
