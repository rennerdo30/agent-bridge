import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { ENV, LOG_DIR_NAME, LOG_FILE_NAME } from "./constants.js";

export const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const DEFAULT_FILE_LEVEL: LogLevel = "info";
const DEFAULT_CONSOLE_LEVEL: LogLevel = "warn";
const MAX_LOG_BYTES = 5 * 1024 * 1024;

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

interface Sink {
  fileLevel: LogLevel;
  consoleLevel: LogLevel;
  file: string | null;
}

function parseLevel(value: string | undefined, fallback: LogLevel): LogLevel {
  const v = value?.trim().toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(v ?? "") ? (v as LogLevel) : fallback;
}

function serialize(data: Record<string, unknown> | undefined): string {
  if (!data) return "";
  try {
    return " " + JSON.stringify(data, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v));
  } catch {
    return " [unserializable data]";
  }
}

function rotateIfNeeded(file: string): void {
  try {
    if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.1`);
  } catch {
    // File does not exist yet or cannot be rotated; appending will create or reuse it.
  }
}

/**
 * Logs go to a file and to stderr. stdout is never used: for stdio MCP servers it carries the protocol.
 */
export function createLogger(opts: { home: string; component: string; consoleLevel?: LogLevel; fileLevel?: LogLevel }): Logger {
  const envLevel = process.env[ENV.logLevel];
  const sink: Sink = {
    fileLevel: opts.fileLevel ?? parseLevel(envLevel, DEFAULT_FILE_LEVEL),
    consoleLevel: opts.consoleLevel ?? parseLevel(process.env[ENV.logConsole] ?? envLevel, DEFAULT_CONSOLE_LEVEL),
    file: null,
  };
  try {
    const dir = join(opts.home, LOG_DIR_NAME);
    mkdirSync(dir, { recursive: true });
    sink.file = join(dir, LOG_FILE_NAME);
    rotateIfNeeded(sink.file);
  } catch (err) {
    process.stderr.write(`[${opts.component}] cannot open log directory, logging to stderr only: ${String(err)}\n`);
  }
  return makeLogger(sink, opts.component);
}

function makeLogger(sink: Sink, scope: string): Logger {
  const write = (level: Exclude<LogLevel, "silent">, msg: string, data?: Record<string, unknown>) => {
    const rank = LEVEL_RANK[level];
    const toFile = sink.file !== null && rank >= LEVEL_RANK[sink.fileLevel];
    const toConsole = rank >= LEVEL_RANK[sink.consoleLevel];
    if (!toFile && !toConsole) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] pid=${process.pid} ${msg}${serialize(data)}\n`;
    if (toFile) {
      try {
        appendFileSync(sink.file as string, line);
      } catch {
        // Never let logging failures break the bridge.
      }
    }
    if (toConsole) process.stderr.write(line);
  };
  return {
    debug: (m, d) => write("debug", m, d),
    info: (m, d) => write("info", m, d),
    warn: (m, d) => write("warn", m, d),
    error: (m, d) => write("error", m, d),
    child: (s) => makeLogger(sink, `${scope}:${s}`),
  };
}

/** A logger that discards everything; handy in tests. */
export const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};
