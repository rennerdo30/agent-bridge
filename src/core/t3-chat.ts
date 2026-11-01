import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * AB-481: deliver Bridge mail into the T3 Code chat a session runs in, as a visible chat message.
 *
 * - **Which chat:** T3 records the provider's own session id (Claude's session id, Codex's thread id) in
 *   `orchestration_v2_projection_provider_threads.payload_json` → `nativeThreadRef.nativeId`. Read from T3's
 *   local store read-only, in one short connection; only that table and `orchestration_v2_projection_threads`
 *   (to skip deleted and archived chats) are read. T3's auth tables, secrets and token files are never opened.
 * - **How:** T3's own CLI, `t3 thread send --json <thread> -` (message on stdin). T3's desktop app installs a
 *   launcher for its bundled CLI and hands its path to every agent as `T3CODE_CLI_PATH`, so the CLI always
 *   matches the running app. It signs itself in; Bridge never handles a T3 credential. A busy chat gets the
 *   message as its next turn (the CLI cannot steer); the send has no request id, so an unknown outcome is never
 *   retried automatically.
 */

const THREAD_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_ID = 512;
/** One send is a short local request; a hung CLI must not hold the session's delivery. */
export const T3_SEND_TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 64 * 1024;

export type T3SendOutcome =
  | { state: "accepted"; delivery: string; runId: string | null }
  /** Refused before T3 could have taken it (no CLI, bad input, the CLI could not start). */
  | { state: "failed"; reason: string }
  /** The CLI ran but gave no clear receipt: T3 may or may not have queued the message. */
  | { state: "unknown"; reason: string };

/** The T3 CLI launcher from T3CODE_CLI_PATH: an existing absolute file whose path is safe to quote for cmd.exe. */
export function t3CliFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const cli = env.T3CODE_CLI_PATH?.trim();
  if (!cli || !isAbsolute(cli) || /["%^&|<>!\r\n\0]/.test(cli)) return undefined;
  return existsSync(cli) ? cli : undefined;
}

/** T3's data directory, as T3 resolves it (T3CODE_HOME, else ~/.t3). */
export function t3HomeFromEnv(env: NodeJS.ProcessEnv, home: string): string {
  return env.T3CODE_HOME?.trim() || join(home, ".t3");
}

/** The T3 chat (thread id) this provider session runs in, or undefined (not a T3 chat, store busy or unknown). */
export function t3ChatForNativeSession(t3Home: string, nativeId: string): string | undefined {
  if (!nativeId || nativeId.length > MAX_ID) return undefined;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(realpathSync.native(join(t3Home, "userdata", "statev2.sqlite")), { readOnly: true, timeout: 25 });
    const rows = db.prepare(`SELECT p.thread_id AS thread_id FROM orchestration_v2_projection_provider_threads p
      JOIN orchestration_v2_projection_threads t ON t.thread_id = p.thread_id
      WHERE json_extract(p.payload_json, '$.nativeThreadRef.nativeId') = ? AND t.deleted_at IS NULL AND t.archived_at IS NULL
      ORDER BY p.updated_at DESC LIMIT 2`).all(nativeId) as { thread_id: unknown }[];
    const ids = [...new Set(rows.map((r) => r.thread_id).filter((v): v is string => typeof v === "string" && THREAD_ID.test(v)))];
    // A native session in two chats (a fork that kept its id) is not guessed.
    return ids.length === 1 ? ids[0] : undefined;
  } catch {
    return undefined;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

export type SpawnFn = typeof spawn;

/** Send one message to a T3 chat through T3's CLI. Never throws; never retries. */
export function t3SendMessage(cli: string, threadId: string, message: string,
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number; spawnFn?: SpawnFn; platform?: NodeJS.Platform } = {}): Promise<T3SendOutcome> {
  if (!THREAD_ID.test(threadId)) return Promise.resolve({ state: "failed", reason: "invalid thread id" });
  if (!message.trim()) return Promise.resolve({ state: "failed", reason: "empty message" });
  const platform = options.platform ?? process.platform;
  const run = options.spawnFn ?? spawn;
  const args = ["thread", "send", "--json", threadId, "-"];
  return new Promise((resolve) => {
    let child: ReturnType<SpawnFn>;
    try {
      // The launcher is a .cmd on Windows: it needs cmd.exe. Its path is checked (t3CliFromEnv) and quoted; the
      // thread id is checked above; the message goes through stdin, never through a command line.
      child = platform === "win32"
        ? run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${cli}" ${args.join(" ")}`], { env: options.env, windowsHide: true, windowsVerbatimArguments: true, stdio: ["pipe", "pipe", "pipe"] })
        : run(cli, args, { env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      resolve({ state: "failed", reason: `could not start the T3 CLI: ${(error as Error).message}` });
      return;
    }
    let out = "", settled = false;
    const finish = (outcome: T3SendOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      // Only this send's own child (by handle, never by name).
      try { child.kill(); } catch { /* gone */ }
      finish({ state: "unknown", reason: "the T3 CLI did not answer in time" });
    }, options.timeoutMs ?? T3_SEND_TIMEOUT_MS);
    timer.unref();
    child.stdout?.on("data", (chunk: Buffer) => { if (out.length < MAX_OUTPUT) out += chunk.toString("utf8"); });
    child.stderr?.resume();
    child.on("error", (error) => finish({ state: "failed", reason: `could not start the T3 CLI: ${error.message}` }));
    child.on("close", (code) => {
      const receipt = parseReceipt(out, threadId);
      if (code === 0 && receipt) finish({ state: "accepted", ...receipt });
      else finish({ state: "unknown", reason: code === 0 ? "the T3 CLI gave no receipt" : `the T3 CLI exited with ${code}` });
    });
    child.stdin?.on("error", () => { /* reported through close */ });
    child.stdin?.end(message, "utf8");
  });
}

function parseReceipt(out: string, threadId: string): { delivery: string; runId: string | null } | undefined {
  const line = out.trim().split(/\r?\n/).reverse().find((l) => l.startsWith("{"));
  if (!line) return undefined;
  try {
    const r = JSON.parse(line) as { threadId?: unknown; delivery?: unknown; runId?: unknown };
    if (r.threadId !== threadId || typeof r.delivery !== "string") return undefined;
    return { delivery: r.delivery, runId: typeof r.runId === "string" ? r.runId : null };
  } catch {
    return undefined;
  }
}
