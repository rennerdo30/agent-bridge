import type { Logger } from "./logger.js";

/** Tracker names: lowercase start, then lowercase/alphanumeric/dash, max 32 chars. */
export const TRACKER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** Longest summary/reason text kept in a formatted event; the rest is dropped. */
export const MAX_EVENT_TEXT_CHARS = 2000;

export interface WorkItemRef {
  tracker: string;
  id: string;
}

/**
 * Parses "<tracker>:<id>", splitting only on the FIRST colon so ids may
 * contain colons (e.g. "github:owner/repo#12").
 * Throws an Error with a clear message on invalid input.
 */
export function parseWorkItem(value: string): WorkItemRef {
  if (typeof value !== "string") {
    throw new Error(`invalid work item: expected a "<tracker>:<id>" string, got ${typeof value}`);
  }
  const idx = value.indexOf(":");
  if (idx === -1) {
    throw new Error(`invalid work item ${JSON.stringify(value)}: expected "<tracker>:<id>" with a colon separator`);
  }
  const tracker = value.slice(0, idx);
  const id = value.slice(idx + 1);
  if (!TRACKER_NAME_PATTERN.test(tracker)) {
    throw new Error(
      `invalid work item ${JSON.stringify(value)}: tracker ${JSON.stringify(tracker)} must match ${String(TRACKER_NAME_PATTERN)}`,
    );
  }
  if (id.length < 1 || id.length > 200) {
    throw new Error(`invalid work item ${JSON.stringify(value)}: id must be 1..200 characters`);
  }
  // Tracker CLIs get the id as a positional argument; a leading dash could be read as an option.
  if (id.startsWith("-")) {
    throw new Error(`invalid work item ${JSON.stringify(value)}: id must not start with "-"`);
  }
  if (/[\s\x00-\x1f\x7f]/.test(id)) {
    throw new Error(`invalid work item ${JSON.stringify(value)}: id must not contain whitespace or control characters`);
  }
  return { tracker, id };
}

export type WorkItemEvent =
  | { kind: "started"; job: string; agent: string; title?: string }
  | { kind: "finished"; job: string; agent: string; branch?: string; head?: string; summary?: string }
  | { kind: "failed"; job: string; agent: string; reason?: string };

export interface TrackerAdapter {
  readonly type: string;
  post(ref: WorkItemRef, event: WorkItemEvent): Promise<void>;
}

function truncateEventText(text: string): string {
  return text.length > MAX_EVENT_TEXT_CHARS ? text.slice(0, MAX_EVENT_TEXT_CHARS) : text;
}

/**
 * Plain markdown, English: one bold first line, then one short bullet per
 * present field. Summary/reason are truncated to MAX_EVENT_TEXT_CHARS.
 */
export function formatEvent(event: WorkItemEvent): string {
  switch (event.kind) {
    case "started": {
      const lines = [`**agent-bridge: job ${event.job} started**`, `- agent: ${event.agent}`];
      if (event.title !== undefined) lines.push(`- title: ${event.title}`);
      return lines.join("\n");
    }
    case "finished": {
      const lines = [`**agent-bridge: job ${event.job} finished**`, `- agent: ${event.agent}`];
      if (event.branch !== undefined) lines.push(`- branch: ${event.branch}`);
      if (event.head !== undefined) lines.push(`- head: ${event.head}`);
      if (event.summary !== undefined) lines.push(`- summary: ${truncateEventText(event.summary)}`);
      return lines.join("\n");
    }
    case "failed": {
      const lines = [`**agent-bridge: job ${event.job} failed**`, `- agent: ${event.agent}`];
      if (event.reason !== undefined) lines.push(`- reason: ${truncateEventText(event.reason)}`);
      return lines.join("\n");
    }
  }
}

/**
 * Posts an event to the adapter named by ref.tracker. Unknown trackers are
 * logged and skipped; adapter errors are logged and swallowed. Never throws.
 */
export async function notifyWorkItem(
  adapters: ReadonlyMap<string, TrackerAdapter>,
  ref: WorkItemRef,
  event: WorkItemEvent,
  log: Logger,
): Promise<void> {
  try {
    const adapter = adapters.get(ref.tracker);
    if (!adapter) {
      log.warn("ignoring work item event for unknown tracker", { tracker: ref.tracker, id: ref.id, job: event.job });
      return;
    }
    log.debug("posting work item event", { tracker: ref.tracker, id: ref.id, kind: event.kind, job: event.job });
    try {
      await adapter.post(ref, event);
    } catch (err) {
      log.warn("tracker adapter failed for work item event", {
        tracker: ref.tracker,
        id: ref.id,
        kind: event.kind,
        job: event.job,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  } catch (err) {
    // Logging itself must never break the job.
    try {
      log.warn("tracker notification failed for work item event", {
        tracker: ref.tracker,
        err: err instanceof Error ? err.message : String(err),
      });
    } catch {
      // Ignore logging failures.
    }
  }
}

export interface TrackerConfig {
  type: "pair-desk";
  command: string;
  timeoutMs?: number;
  argsPrefix?: string[];
}

const TRACKER_TIMEOUT_MIN_MS = 1000;
const TRACKER_TIMEOUT_MAX_MS = 120000;
const TRACKER_ARGS_PREFIX_MAX = 10;

/**
 * Validates the home-level `trackers` config record. Invalid entries are
 * skipped (with a warning when a logger is given); this function never throws.
 * Absent config means no trackers.
 */
export function parseTrackersConfig(raw: unknown, log?: Logger): Record<string, TrackerConfig> {
  const out: Record<string, TrackerConfig> = {};
  if (raw === undefined || raw === null) return out;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    log?.warn("ignoring invalid trackers config", {});
    return out;
  }
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const skip = (detail: string, extra?: Record<string, unknown>) =>
      log?.warn(`ignoring invalid tracker ${JSON.stringify(name)}: ${detail}`, { tracker: name, ...extra });
    if (!TRACKER_NAME_PATTERN.test(name)) {
      skip("name must match /^[a-z][a-z0-9-]{0,31}$/");
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      skip("entry must be an object");
      continue;
    }
    const rec = value as Record<string, unknown>;
    if (rec.type !== "pair-desk") {
      skip('only type "pair-desk" is supported', { type: typeof rec.type === "string" ? rec.type : undefined });
      continue;
    }
    if (typeof rec.command !== "string" || rec.command.trim().length === 0) {
      skip("command must be a non-empty string");
      continue;
    }
    let timeoutMs: number | undefined;
    if (rec.timeoutMs !== undefined) {
      if (
        typeof rec.timeoutMs !== "number" ||
        !Number.isInteger(rec.timeoutMs) ||
        rec.timeoutMs < TRACKER_TIMEOUT_MIN_MS ||
        rec.timeoutMs > TRACKER_TIMEOUT_MAX_MS
      ) {
        skip("timeoutMs must be an integer 1000..120000");
        continue;
      }
      timeoutMs = rec.timeoutMs;
    }
    let argsPrefix: string[] | undefined;
    if (rec.argsPrefix !== undefined) {
      if (
        !Array.isArray(rec.argsPrefix) ||
        rec.argsPrefix.length > TRACKER_ARGS_PREFIX_MAX ||
        !rec.argsPrefix.every((s) => typeof s === "string" && s.length > 0)
      ) {
        skip("argsPrefix must be an array of 0..10 non-empty strings");
        continue;
      }
      argsPrefix = [...(rec.argsPrefix as string[])];
    }
    out[name] = {
      type: "pair-desk",
      command: (rec.command as string).trim(),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(argsPrefix !== undefined ? { argsPrefix } : {}),
    };
  }
  return out;
}
