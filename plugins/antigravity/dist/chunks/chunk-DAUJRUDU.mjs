import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  readRunnerState
} from "./chunk-R7W5ZPVW.mjs";
import {
  resolveDbPath
} from "./chunk-5YUMH7RA.mjs";
import {
  archiveDbPath
} from "./chunk-LGFTSWER.mjs";

// src/mcp/final-result.ts
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
var MAX_BACKOFF_MS = 3e4;
var MAX_DELIVERY_ATTEMPTS = 6;
var PERMANENT_DELIVERY_CODES = /* @__PURE__ */ new Set(["unauthorized", "not_found", "bad_request", "too_large", "forbidden"]);
async function deliverFinalResult(result, persist, send, wait, shutdown, alreadyStored) {
  if (result.delivered) return;
  let backoff = 1e3;
  for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS; attempt++) {
    try {
      persist(result);
      break;
    } catch {
      if (attempt === MAX_DELIVERY_ATTEMPTS - 1 || shutdown?.aborted) break;
      await wait(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }
  const markDelivered = () => {
    try {
      persist({ ...result, delivered: true });
    } catch {
    }
  };
  backoff = 1e3;
  for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS; attempt++) {
    try {
      let found = false;
      try {
        found = alreadyStored ? await alreadyStored(result.reportId) : false;
      } catch {
      }
      if (found) {
        markDelivered();
        return;
      }
      const receipt = await send(result.report, result.reportId);
      if (receipt?.stored) {
        markDelivered();
        return;
      }
    } catch (error) {
      if (PERMANENT_DELIVERY_CODES.has(error?.code ?? "")) return;
    }
    if (shutdown?.aborted || attempt === MAX_DELIVERY_ATTEMPTS - 1) return;
    await wait(backoff);
    if (shutdown?.aborted) return;
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
}
function resultDeliveryLabel(result, readReceipt) {
  if (!result?.report) return null;
  return readReceipt ? "delivered" : "result stored, not delivered";
}
function readStoredFinalResult(home, id) {
  const state = readRunnerState(home, id);
  return state && typeof state.report === "string" && typeof state.reportId === "string" ? { report: state.report, reportId: state.reportId, delivered: state.delivered === true } : null;
}
function readJobReport(home, job) {
  try {
    const stored = readStoredFinalResult(home, job.id);
    if (stored) return stored.report;
  } catch {
  }
  if (!job.reportId) return null;
  const path = resolveDbPath(home);
  for (const file of [path, archiveDbPath(path)]) {
    if (!existsSync(file)) continue;
    let db;
    try {
      db = new DatabaseSync(file, { readOnly: true, timeout: 50 });
      for (const table of ["messages", "archived_messages"]) {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) continue;
        const row = db.prepare(`SELECT body FROM ${table} WHERE id = ? LIMIT 1`).get(job.reportId);
        if (typeof row?.body === "string") return row.body;
      }
    } catch {
    } finally {
      db?.close();
    }
  }
  return null;
}

// src/mcp/job-runner-errors.ts
function guardRunnerErrors(log, events = process, stderr = process.stderr, label = { message: "unexpected runner callback failure; active turn kept running", fallback: "[job-runner] {event}; active turn kept running (error logging failed)" }) {
  let reporting = false;
  let fallbackAttempted = false;
  const report = (event, error) => {
    if (reporting) return;
    reporting = true;
    try {
      log.error(label.message, { event, error });
    } catch {
      if (!fallbackAttempted) {
        fallbackAttempted = true;
        try {
          stderr.write(`${label.fallback.replace("{event}", event)}
`);
        } catch {
        }
      }
    } finally {
      reporting = false;
    }
  };
  const rejection = (error) => report("unhandledRejection", error);
  const exception = (error, origin) => report(origin, error);
  const stderrError = () => {
    fallbackAttempted = true;
  };
  stderr.on("error", stderrError);
  events.on("unhandledRejection", rejection);
  events.on("uncaughtException", exception);
  return () => {
    events.off("unhandledRejection", rejection);
    events.off("uncaughtException", exception);
    stderr.off("error", stderrError);
  };
}
function guardServerErrors(log, events = process) {
  return guardRunnerErrors(log, events, process.stderr, { message: "unexpected background failure; MCP server kept running", fallback: "[agent-bridge] {event}; MCP server kept running (error logging failed)" });
}

export {
  PERMANENT_DELIVERY_CODES,
  deliverFinalResult,
  resultDeliveryLabel,
  readJobReport,
  guardRunnerErrors,
  guardServerErrors
};
