import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  protect
} from "./chunk-YAVVVLOG.mjs";

// src/cli/dashboard-key.ts
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
var DASHBOARD_KEY_FILE = "dashboard-key";
var KEY_PATTERN = /^[0-9a-f]{48}$/;
function loadDashboardKey(home, legacy, reset = false) {
  mkdirSync(home, { recursive: true, mode: 448 });
  const file = join(home, DASHBOARD_KEY_FILE);
  if (reset || !existsSync(file)) {
    const temp = join(home, `.dashboard-key-${randomUUID()}`);
    let created = false;
    try {
      writeFileSync(temp, "", { flag: "wx", mode: 384 });
      created = true;
      protect(temp, 384);
      writeFileSync(temp, !reset && legacy && KEY_PATTERN.test(legacy) ? legacy : randomBytes(24).toString("hex"));
      if (reset) renameSync(temp, file);
      else {
        try {
          linkSync(temp, file);
        } catch (err) {
          if (err.code !== "EEXIST") throw err;
        }
      }
    } finally {
      if (created && existsSync(temp)) unlinkSync(temp);
    }
  }
  protect(file, 384);
  const key = readFileSync(file, "utf8").trim();
  if (!KEY_PATTERN.test(key)) throw new Error("Invalid dashboard key file; run agent-bridge ui --reset-key to recover.");
  return key;
}
function currentDashboardKey(home) {
  const key = readFileSync(join(home, DASHBOARD_KEY_FILE), "utf8").trim();
  if (!KEY_PATTERN.test(key)) throw new Error("Invalid dashboard key file");
  return key;
}

export {
  loadDashboardKey,
  currentDashboardKey
};
