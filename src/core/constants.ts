import { homedir } from "node:os";
import { join } from "node:path";

/** Product identity. */
export const APP_NAME = "agent-bridge";
export const APP_VERSION = "0.29.1";

/** Wire protocol version; bump on incompatible changes to the broker protocol. */
export const PROTOCOL_VERSION = 2;

/** Environment variables understood by agent-bridge. */
export const ENV = {
  home: "AGENT_BRIDGE_HOME",
  pipe: "AGENT_BRIDGE_PIPE",
  name: "AGENT_BRIDGE_NAME",
  agent: "AGENT_BRIDGE_AGENT",
  logLevel: "AGENT_BRIDGE_LOG_LEVEL",
  logConsole: "AGENT_BRIDGE_LOG_CONSOLE",
  autoWake: "AGENT_BRIDGE_AUTO_WAKE",
  wakeOnDirect: "AGENT_BRIDGE_WAKE_ON_DIRECT",
  maxHops: "AGENT_BRIDGE_MAX_HOPS",
  maxJobs: "AGENT_BRIDGE_MAX_JOBS",
  maxDelegateDepth: "AGENT_BRIDGE_MAX_DELEGATE_DEPTH",
  autoApproveTools: "AGENT_BRIDGE_AUTO_APPROVE_TOOLS",
  lingerSec: "AGENT_BRIDGE_LINGER_SEC",
  delivery: "AGENT_BRIDGE_DELIVERY",
  claudeBin: "AGENT_BRIDGE_CLAUDE_BIN",
  codexBin: "AGENT_BRIDGE_CODEX_BIN",
  opencodeBin: "AGENT_BRIDGE_OPENCODE_BIN",
  dashboard: "AGENT_BRIDGE_DASHBOARD",
  /** "0": background subagents run inside the session's MCP server instead of detached job runners (they then end with it). */
  jobRunner: "AGENT_BRIDGE_JOB_RUNNER",
} as const;

export const DEFAULT_MAX_DELEGATE_DEPTH = 2;
export const MAX_DELEGATE_DEPTH_LIMIT = 3;
export const DELEGATION_METADATA_VERSION = 2;

/** Default data directory; holds the message store, logs and config. */
export const DEFAULT_HOME = join(homedir(), `.${APP_NAME}`);

export const CONFIG_FILE_NAME = "config.json";
export const DB_FILE_NAME = "bridge.db";
export const LOG_DIR_NAME = "logs";
export const LOG_FILE_NAME = `${APP_NAME}.log`;

/** Named pipe (Windows) / Unix socket file name used by the broker. */
export const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";
export const SOCKET_FILE_NAME = "bridge.sock";

/** Broker election and reconnect timing. */
export const ELECTION_RETRY_MIN_MS = 100;
export const ELECTION_RETRY_MAX_MS = 600;
export const ELECTION_MAX_ATTEMPTS = 20;
/** After a failed election, retry in the background with this backoff (doubling up to the cap). */
export const RECONNECT_BACKOFF_MIN_MS = 1_000;
export const RECONNECT_BACKOFF_MAX_MS = 30_000;
export const CONNECT_TIMEOUT_MS = 2_000;
export const REQUEST_TIMEOUT_MS = 10_000;

/** Largest single protocol frame accepted, to bound memory use. */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/** Largest message body accepted from an agent. */
export const MAX_BODY_CHARS = 200_000;

/** Undelivered messages older than this are purged by the broker. */
export const MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PURGE_INTERVAL_MS = 60 * 60 * 1000;
/**
 * Queued mail older than this is dropped when a peer claims its name: peer names are reused (they come
 * from the project folder), so a new session must not inherit an old one's stale backlog.
 */
export const QUEUED_MAIL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Loop protection: messages at or beyond this hop count never auto-wake an agent. */
export const DEFAULT_MAX_HOPS = 6;

/** Delegation (headless calls to the other CLI). */
/** ask_* default. Real implementation tasks take longer than 15 minutes; hosts background long calls anyway. */
export const DEFAULT_DELEGATE_TIMEOUT_SEC = 3_600;
export const MAX_DELEGATE_TIMEOUT_SEC = 3_600;
/** Background subagents have no practical limit; this cap only stops runaway processes. */
export const MAX_JOB_TIMEOUT_SEC = 24 * 60 * 60;
/** Subagent jobs of all sessions, kept across restarts so message_subagent can continue them (in the home folder; see jobs.ts). */
export const JOBS_FILE = "jobs.json";
export const DEFAULT_CLAUDE_BIN = "claude";
export const DEFAULT_CODEX_BIN = "codex";
export const DEFAULT_OPENCODE_BIN = "opencode";
/** Web dashboard (agent-bridge ui / started with the bridge). */
export const DEFAULT_DASHBOARD_PORT = 4777;

/**
 * Listen window: after a session sent a bridge message (or spawned a subagent), its Stop hook keeps the
 * turn open this long waiting for replies, so conversations continue without the user nudging.
 */
export const DEFAULT_LINGER_SEC = 300;
/** Longest a single Stop hook invocation waits; must stay below the hosts' hook timeouts (600s). */
export const STOP_WAIT_CAP_MS = 290_000;
/** Background subagents running at once per session, unless maxJobs / AGENT_BRIDGE_MAX_JOBS says otherwise. */
export const DEFAULT_MAX_JOBS = 8;
/** Upper bound for that setting (a typo must not start hundreds of CLIs). */
export const MAX_JOBS_LIMIT = 50;

/** wait_for_message tool limits. */
export const DEFAULT_WAIT_SEC = 110;
export const MAX_WAIT_SEC = 1_800;

/** Hook helpers: how long a hook may wait for the broker before giving up silently. */
export const HOOK_BROKER_TIMEOUT_MS = 1_500;

/** Maximum number of messages injected into a single hook response. */
export const HOOK_MAX_MESSAGES = 10;
