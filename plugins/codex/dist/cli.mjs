#!/usr/bin/env node
import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);

// src/cli/main.ts
import { join as join17 } from "node:path";

// src/core/client.ts
import { EventEmitter } from "node:events";
import { connect } from "node:net";

// src/core/constants.ts
import { homedir } from "node:os";
import { join } from "node:path";
var APP_NAME = "agent-bridge";
var APP_VERSION = "0.9.0";
var PROTOCOL_VERSION = 2;
var ENV = {
  home: "AGENT_BRIDGE_HOME",
  pipe: "AGENT_BRIDGE_PIPE",
  name: "AGENT_BRIDGE_NAME",
  agent: "AGENT_BRIDGE_AGENT",
  logLevel: "AGENT_BRIDGE_LOG_LEVEL",
  logConsole: "AGENT_BRIDGE_LOG_CONSOLE",
  autoWake: "AGENT_BRIDGE_AUTO_WAKE",
  maxHops: "AGENT_BRIDGE_MAX_HOPS",
  lingerSec: "AGENT_BRIDGE_LINGER_SEC",
  delivery: "AGENT_BRIDGE_DELIVERY",
  claudeBin: "AGENT_BRIDGE_CLAUDE_BIN",
  codexBin: "AGENT_BRIDGE_CODEX_BIN",
  opencodeBin: "AGENT_BRIDGE_OPENCODE_BIN",
  dashboard: "AGENT_BRIDGE_DASHBOARD"
};
var DEFAULT_HOME = join(homedir(), `.${APP_NAME}`);
var CONFIG_FILE_NAME = "config.json";
var DB_FILE_NAME = "bridge.db";
var LOG_DIR_NAME = "logs";
var LOG_FILE_NAME = `${APP_NAME}.log`;
var WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";
var SOCKET_FILE_NAME = "bridge.sock";
var ELECTION_RETRY_MIN_MS = 100;
var ELECTION_RETRY_MAX_MS = 600;
var ELECTION_MAX_ATTEMPTS = 20;
var CONNECT_TIMEOUT_MS = 2e3;
var REQUEST_TIMEOUT_MS = 1e4;
var MAX_FRAME_BYTES = 4 * 1024 * 1024;
var MAX_BODY_CHARS = 2e5;
var MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
var PURGE_INTERVAL_MS = 60 * 60 * 1e3;
var DEFAULT_MAX_HOPS = 6;
var MAX_JOB_TIMEOUT_SEC = 24 * 60 * 60;
var DEFAULT_CLAUDE_BIN = "claude";
var DEFAULT_CODEX_BIN = "codex";
var DEFAULT_OPENCODE_BIN = "opencode";
var DEFAULT_DASHBOARD_PORT = 4777;
var DEFAULT_LINGER_SEC = 300;

// src/core/protocol.ts
var AGENT_KINDS = ["claude", "codex", "opencode", "other"];
var CODING_AGENTS = ["claude", "codex", "opencode"];
var BROADCAST = "*";
var BridgeError = class extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "BridgeError";
  }
  code;
  details;
  toPayload() {
    return { code: this.code, message: this.message, ...this.details ? { details: this.details } : {} };
  }
};
var FrameDecoder = class {
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
  }
  maxBytes;
  buffer = "";
  push(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > this.maxBytes && !this.buffer.includes("\n")) {
      this.buffer = "";
      throw new BridgeError("too_large", "frame exceeds maximum size");
    }
    const frames = [];
    let nl;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      frames.push(JSON.parse(line));
    }
    return frames;
  }
};
function encodeFrame(frame) {
  return JSON.stringify(frame) + "\n";
}

// src/core/client.ts
var BridgeClient = class _BridgeClient extends EventEmitter {
  constructor(socket, log) {
    super();
    this.socket = socket;
    this.log = log;
    socket.setEncoding("utf8");
    const decoder = new FrameDecoder(MAX_FRAME_BYTES);
    socket.on("data", (chunk) => {
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch (err) {
        this.log.warn("undecodable frame from broker; disconnecting", { err });
        socket.destroy();
        return;
      }
      for (const f of frames) {
        if (f.t === "res") this.settle(f);
        else if (f.t === "evt") this.emit("event", f.ev, f.data);
      }
    });
    socket.on("error", (err) => this.log.debug("client socket error", { err: err.message }));
    socket.on("close", () => {
      this.closed = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("connection to broker closed"));
      }
      this.pending.clear();
      this.emit("close");
    });
  }
  socket;
  log;
  nextId = 1;
  pending = /* @__PURE__ */ new Map();
  closed = false;
  /** Connect to an existing broker. Rejects with the socket error (ENOENT/ECONNREFUSED if nobody listens). */
  static connect(pipePath, log, timeoutMs = CONNECT_TIMEOUT_MS) {
    return new Promise((resolve3, reject) => {
      const socket = connect(pipePath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(Object.assign(new Error("timed out connecting to broker"), { code: "ETIMEDOUT" }));
      }, timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.removeAllListeners("error");
        resolve3(new _BridgeClient(socket, log));
      });
      socket.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
  get isClosed() {
    return this.closed;
  }
  request(op, args, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (this.closed) return Promise.reject(new Error("connection to broker closed"));
    const id = this.nextId++;
    return new Promise((resolve3, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`broker request timed out: ${op}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve3, reject, timer });
      this.socket.write(encodeFrame({ t: "req", id, op, args }));
    });
  }
  close() {
    this.socket.end();
    this.socket.destroy();
  }
  settle(f) {
    const p = this.pending.get(f.id);
    if (!p) return;
    this.pending.delete(f.id);
    clearTimeout(p.timer);
    if (f.ok) p.resolve(f.result);
    else p.reject(new BridgeError(f.error.code, f.error.message, f.error.details));
  }
};

// src/core/messages.ts
var en = {
  "common.yes": "yes",
  "common.no": "no",
  "common.on": "on",
  "common.off": "off",
  "peers.self": 'You are "{name}" (broker: {broker}, auto-wake: {autoWake}, delivery: {delivery}, unread: {unread}).',
  "peers.header": "{count} other peer(s) online:",
  "peers.none": "No other peers are online. Messages you send to an offline peer name wait until it connects.",
  "peers.jobs": "Your running subagents ({count}):",
  "peers.job": "- {name} (model: {model}, running {duration}): {progress}",
  "jobs.started": 'Subagent {name} started. Keep working; its result will arrive as a message from "{name}" (or call wait_for_message with from="{name}").',
  "jobs.limit": "Too many subagents running (maximum {max}). Wait for one to finish or cancel one.",
  "jobs.cancelled": "Cancelled subagent {name}.",
  "jobs.unknown": "No running subagent named {name}.",
  "send.ok": "Message {id} sent (conversation {conversation}).",
  "send.delivered": "Delivered to: {names}.",
  "send.queued": "Recipient offline, queued for: {names}.",
  "send.waitHint": "Use wait_for_message to wait for the answer.",
  "inbox.empty": "No unread messages.",
  "wait.timeout": "No message arrived within {seconds} seconds.",
  "autoWake.on": "Auto-wake is on. Incoming peer messages will make this session continue (up to {maxHops} hops per conversation).",
  "autoWake.off": "Auto-wake is off. Peer messages are shown on your next prompt or tool use.",
  "delegate.done": "{agent} finished (session_id: {session}).",
  "peers.recent": "Recent subagents (message_subagent continues them):",
  "peers.recentJob": "- {name}: {status} {ago} ago, {session}",
  "delegate.followUp": 'Follow up with its full context: message_subagent(job="{job}", message=...).',
  "followUp.started": "Sent to {name}; it continues in its own session. Its answer will arrive as a message from {name}.",
  "followUp.queued": "{name} is still working; your message is queued and will be sent as soon as it finishes.",
  "followUp.unknown": "No subagent named {name}. Call peers to see running and recent subagents.",
  "followUp.no-session": "{name} has no session to continue (it failed before starting one). Start a new one with ask_* or spawn_*.",
  "followUp.busy": "Too many subagents running (maximum {max}). Wait for one to finish, then send the message again.",
  "delegate.empty": "(no answer text returned)",
  "err.ambiguous": "Several peers match; pick one of: {candidates}.",
  "err.unknownTarget": "Unknown recipient: {detail}",
  "err.tooLarge": "Message too large (maximum {max} characters).",
  "err.protocol": "agent-bridge version mismatch between peers: {detail}. Update all agent-bridge plugins to the same version.",
  "err.generic": "agent-bridge error: {detail}",
  "err.delegateNotFound": "Could not start the other agent: {detail}. Install it or set its path in the agent-bridge config.",
  "err.delegateTimeout": "The delegated agent did not finish in time: {detail}",
  "err.delegateDepth": "Delegation is not available inside a delegated session (prevents endless recursion).",
  "err.delegateFailed": "The delegated agent failed: {detail}",
  "err.delegatedSession": "This is a delegated headless session; peer messaging is disabled here.",
  "cli.usage": 'Usage: agent-bridge <command>\n\nCommands:\n  install [claude] [codex] [opencode] [--yes]   Install agent-bridge (all found tools by default)\n  update  [claude] [codex] [opencode] [--yes]   Update it\n  uninstall [claude] [codex] [opencode] [--yes] Remove it\n  smoke [claude] [codex] [opencode]              Check the real CLIs still work with agent-bridge\n  status                  Show the broker and the connected peers\n  send <to> <text>    Send a message as the "cli" peer\n  tail                Print messages addressed to "cli" as they arrive\n  ui [--port=N] [--no-open]  Open the web dashboard (sessions, runs, messages)\n  watch [name]            Follow a delegated run live (newest, or one whose name contains [name])\n  install-opencode        Install the opencode plugin and its @claude/@codex subagents\n  uninstall-opencode      Remove them again\n  paths                   Show data, log and pipe locations\n  help                    Show this help',
  "cli.opencode.noSource": "Could not find the opencode plugin files next to this CLI. Run it from an agent-bridge checkout or package.",
  "cli.opencode.installed": "Installed the agent-bridge opencode plugin into {dir}:",
  "cli.opencode.restart": "Restart opencode to load it. Requires Node.js 22.13+ on PATH.",
  "cli.opencode.removed": "Removed the agent-bridge opencode plugin from {dir}:",
  "cli.opencode.nothing": "The agent-bridge opencode plugin is not installed in {dir}.",
  "ask.unsupported": 'access "ask" is not available for {agent} here, so it ran read-only. (opencode always supports it; Codex needs the agent-bridge PermissionRequest hook trusted via /hooks; Claude is not supported yet.)',
  "smoke.missing": "{agent}: not installed, skipped.",
  "smoke.start": "{agent} {version}{note}: running\u2026",
  "smoke.untested": " (agent-bridge was tested with {tested})",
  "smoke.pass": "  PASS  {agent}: answer {answer}, session id {session}, resume {resume}",
  "smoke.fail": "  FAIL  {agent}: answer {answer}, session id {session}, resume {resume}",
  "smoke.error": "  FAIL  {agent}: {detail}",
  "installer.plan": "{tool}: these commands will run:",
  "installer.confirm": "Run them for {tool}? [y/N] ",
  "installer.skipped": "Skipped {tool}.",
  "installer.notFound": "{tool} is not installed (not found on PATH); skipping it.",
  "installer.codexNote": "  Note: close all Codex sessions first; afterwards trust the agent-bridge hooks once via /hooks in Codex.",
  "installer.opencodeCopy": "copy the agent-bridge plugin, skill and subagents into opencode's config folder",
  "installer.opencodeRemove": "remove the agent-bridge files from opencode's config folder",
  "installer.stepFailed": "  Command failed (exit code {code}); stopping for this tool.",
  "installer.done": "Done. Restart your agent sessions to load agent-bridge.",
  "installer.doneWithErrors": "Finished with {count} error(s); see above.",
  "cli.install.skipped": "  skipped (exists and was not created by agent-bridge): {path}",
  "cli.status.broker": "Broker: running (pid {pid}, protocol {protocol}) at {pipe}",
  "cli.status.noBroker": "Broker: not running (no agent with agent-bridge is active). Endpoint: {pipe}",
  "cli.status.peers": "Peers online: {count}",
  "cli.status.peer": "  {name}  [{agent}, {activity}, v{version}{outdated}]  since {since}  {cwd}",
  "cli.status.outdatedMark": " OUTDATED",
  "cli.status.outdated": "{count} session(s) run an older agent-bridge than {version}. Restart them (after finishing their current work) to load the update.",
  "cli.status.upToDate": "All sessions run agent-bridge {version}.",
  "cli.sent": "Sent message {id}.",
  "cli.tail.listening": 'Listening as "{name}". Press Ctrl+C to stop.',
  "dashboard.opened": "Opened the agent-bridge dashboard in the browser: {url}",
  "dashboard.failed": "The dashboard could not be started (see ~/.agent-bridge/logs/agent-bridge.log; the port may be in use). Set dashboardPort in ~/.agent-bridge/config.json to use another port.",
  "cli.ui.existing": "agent-bridge dashboard (hosted by a running agent session): {url}",
  "cli.ui.running": "agent-bridge dashboard: {url}\nOnly this link opens it (it contains a one-time secret). Press Ctrl+C to stop.",
  "cli.watch.none": "No delegated runs yet (run logs live in ~/.agent-bridge/runs).",
  "cli.watch.following": "Following {path} (Ctrl+C to stop)",
  "cli.paths": "Data:  {home}\nLogs:  {logs}\nStore: {db}\nPipe:  {pipe}",
  "cli.error": "Error: {detail}",
  "cli.unknownCommand": "Unknown command: {command}"
};

// src/core/i18n.ts
function t(key, params = {}) {
  const nf = new Intl.NumberFormat();
  return en[key].replace(/\{(\w+)\}/g, (match, name) => {
    const value = params[name];
    if (value === void 0) return match;
    return typeof value === "number" ? nf.format(value) : value;
  });
}
function formatDateTime(epochMs) {
  return new Intl.DateTimeFormat(void 0, { dateStyle: "short", timeStyle: "medium" }).format(new Date(epochMs));
}

// src/core/logger.ts
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join as join2 } from "node:path";
var LOG_LEVELS = ["debug", "info", "warn", "error", "silent"];
var LEVEL_RANK = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
var DEFAULT_FILE_LEVEL = "info";
var DEFAULT_CONSOLE_LEVEL = "warn";
var MAX_LOG_BYTES = 5 * 1024 * 1024;
function parseLevel(value, fallback) {
  const v = value?.trim().toLowerCase();
  return LOG_LEVELS.includes(v ?? "") ? v : fallback;
}
function serialize(data) {
  if (!data) return "";
  try {
    return " " + JSON.stringify(data, (_k, v) => v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v);
  } catch {
    return " [unserializable data]";
  }
}
function rotateIfNeeded(file) {
  try {
    if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.1`);
  } catch {
  }
}
function createLogger(opts) {
  const envLevel = process.env[ENV.logLevel];
  const sink = {
    fileLevel: opts.fileLevel ?? parseLevel(envLevel, DEFAULT_FILE_LEVEL),
    consoleLevel: opts.consoleLevel ?? parseLevel(process.env[ENV.logConsole] ?? envLevel, DEFAULT_CONSOLE_LEVEL),
    file: null
  };
  try {
    const dir = join2(opts.home, LOG_DIR_NAME);
    mkdirSync(dir, { recursive: true });
    sink.file = join2(dir, LOG_FILE_NAME);
    rotateIfNeeded(sink.file);
  } catch (err) {
    process.stderr.write(`[${opts.component}] cannot open log directory, logging to stderr only: ${String(err)}
`);
  }
  return makeLogger(sink, opts.component);
}
function makeLogger(sink, scope) {
  const write = (level, msg, data) => {
    const rank = LEVEL_RANK[level];
    const toFile = sink.file !== null && rank >= LEVEL_RANK[sink.fileLevel];
    const toConsole = rank >= LEVEL_RANK[sink.consoleLevel];
    if (!toFile && !toConsole) return;
    const line = `${(/* @__PURE__ */ new Date()).toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] pid=${process.pid} ${msg}${serialize(data)}
`;
    if (toFile) {
      try {
        appendFileSync(sink.file, line);
      } catch {
      }
    }
    if (toConsole) process.stderr.write(line);
  };
  return {
    debug: (m, d) => write("debug", m, d),
    info: (m, d) => write("info", m, d),
    warn: (m, d) => write("warn", m, d),
    error: (m, d) => write("error", m, d),
    child: (s) => makeLogger(sink, `${scope}:${s}`)
  };
}

// src/core/node.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { EventEmitter as EventEmitter2 } from "node:events";
import { unlinkSync } from "node:fs";

// src/core/broker.ts
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";

// src/core/store.ts
import { mkdirSync as mkdirSync2 } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
function agentQueueKey(agent) {
  return `agent:${agent}`;
}
var SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id              TEXT    NOT NULL,
  recipient       TEXT    NOT NULL,
  from_id         TEXT    NOT NULL,
  from_name       TEXT    NOT NULL,
  from_agent      TEXT    NOT NULL,
  to_target       TEXT    NOT NULL,
  conversation_id TEXT    NOT NULL,
  reply_to        TEXT,
  hop             INTEGER NOT NULL,
  body            TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  read_at         INTEGER,
  PRIMARY KEY (id, recipient)
);
CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages (recipient, read_at, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_id ON messages (id);
`;
function toMessage(r) {
  return {
    id: r.id,
    recipient: r.recipient,
    from: { id: r.from_id, name: r.from_name, agent: r.from_agent },
    to: r.to_target,
    conversationId: r.conversation_id,
    replyTo: r.reply_to,
    hop: r.hop,
    body: r.body,
    createdAt: r.created_at,
    readAt: r.read_at
  };
}
var MessageStore = class {
  constructor(file, log) {
    this.log = log;
    if (file !== ":memory:") mkdirSync2(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;");
    this.db.exec(SCHEMA);
    this.stmt = {
      insert: this.db.prepare(
        `INSERT INTO messages (id, recipient, from_id, from_name, from_agent, to_target, conversation_id, reply_to, hop, body, created_at, read_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      ),
      unread: this.db.prepare(
        `SELECT * FROM messages WHERE recipient = ? AND read_at IS NULL ORDER BY created_at ASC, id ASC LIMIT ?`
      ),
      markRead: this.db.prepare(`UPDATE messages SET read_at = ? WHERE id = ? AND recipient = ? AND read_at IS NULL`),
      claim: this.db.prepare(`UPDATE messages SET recipient = ? WHERE recipient = ? AND read_at IS NULL`),
      byId: this.db.prepare(`SELECT * FROM messages WHERE id = ? ORDER BY created_at ASC LIMIT 1`),
      purge: this.db.prepare(`DELETE FROM messages WHERE created_at < ?`)
    };
    log.debug("message store opened", { file });
  }
  log;
  db;
  stmt;
  insert(m) {
    this.stmt.insert.run(
      m.id,
      m.recipient,
      m.from.id,
      m.from.name,
      m.from.agent,
      m.to,
      m.conversationId,
      m.replyTo,
      m.hop,
      m.body,
      m.createdAt
    );
  }
  unread(recipient, limit) {
    return this.stmt.unread.all(recipient, limit).map(toMessage);
  }
  markRead(recipient, ids, at = Date.now()) {
    let changed = 0;
    for (const id of ids) changed += Number(this.stmt.markRead.run(at, id, recipient).changes);
    return changed;
  }
  /** Move messages waiting for "any <agent>" to a concrete peer name. */
  claim(fromKey, toName) {
    return Number(this.stmt.claim.run(toName, fromKey).changes);
  }
  byId(id) {
    const row = this.stmt.byId.get(id);
    return row ? toMessage(row) : null;
  }
  purgeOlderThan(cutoff) {
    const n = Number(this.stmt.purge.run(cutoff).changes);
    if (n > 0) this.log.info("purged expired messages", { count: n });
    return n;
  }
  close() {
    try {
      this.db.close();
    } catch (err) {
      this.log.warn("error closing message store", { err });
    }
  }
};

// src/core/token.ts
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync as mkdirSync3, openSync, readFileSync, writeSync, closeSync } from "node:fs";
import { dirname as dirname2, join as join3 } from "node:path";
var TOKEN_FILE_NAME = "token";
var TOKEN_BYTES = 32;
var OWNER_ONLY = 384;
function tokenPath(home) {
  return join3(home, TOKEN_FILE_NAME);
}
function loadOrCreateToken(home) {
  const file = tokenPath(home);
  mkdirSync3(dirname2(file), { recursive: true });
  try {
    const fd = openSync(file, "wx", OWNER_ONLY);
    try {
      writeSync(fd, randomBytes(TOKEN_BYTES).toString("hex"));
    } finally {
      closeSync(fd);
    }
    try {
      chmodSync(file, OWNER_ONLY);
    } catch {
    }
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
  const token = readFileSync(file, "utf8").trim();
  if (!token) throw new Error(`agent-bridge token file is empty: ${file}`);
  return token;
}
function tokensEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// src/core/broker.ts
var PEER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
var PENDING_DEFAULT_LIMIT = 50;
var PENDING_MAX_LIMIT = 500;
var NAME_SUFFIX_LIMIT = 100;
var UNAUTHENTICATED_OPS = /* @__PURE__ */ new Set(["hello", "auth", "ping"]);
var Broker = class {
  constructor(pipePath, store, log, token, now = Date.now) {
    this.pipePath = pipePath;
    this.store = store;
    this.log = log;
    this.token = token;
    this.now = now;
    this.handlers = {
      auth: (c, a) => {
        this.checkAuth(a.protocol, a.token);
        c.authed = true;
        return { brokerPid: process.pid };
      },
      hello: (c, a) => this.onHello(c, a),
      send: (c, a) => this.onSend(c, a),
      peers: () => this.livePeers(),
      ack: (c, a) => ({ acked: this.store.markRead(this.requirePeer(c).name, a.ids ?? [], this.now()) }),
      pending: (c, a) => this.store.unread(this.requirePeer(c).name, Math.min(Math.max(1, a.limit ?? PENDING_DEFAULT_LIMIT), PENDING_MAX_LIMIT)),
      updatePeer: (c, a) => this.onUpdatePeer(c, a),
      ping: () => ({ brokerPid: process.pid, protocol: PROTOCOL_VERSION })
    };
  }
  pipePath;
  store;
  log;
  token;
  now;
  server = null;
  conns = /* @__PURE__ */ new Set();
  purgeTimer = null;
  handlers;
  /** Bind the endpoint. Rejects with the socket error (EADDRINUSE when another broker owns it). */
  listen() {
    return new Promise((resolve3, reject) => {
      const server = createServer((socket) => this.accept(socket));
      const onError = (err) => {
        server.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        server.on("error", (err) => this.log.error("broker server error", { err }));
        this.server = server;
        this.purgeTimer = setInterval(() => this.purge(), PURGE_INTERVAL_MS);
        this.purgeTimer.unref();
        this.purge();
        this.log.info("broker listening", { pipe: this.pipePath });
        resolve3();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.pipePath);
    });
  }
  async close() {
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    for (const c of this.conns) c.socket.destroy();
    this.conns.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise((r) => server.close(() => r()));
    this.store.close();
    this.log.info("broker closed");
  }
  purge() {
    try {
      this.store.purgeOlderThan(this.now() - MESSAGE_TTL_MS);
    } catch (err) {
      this.log.warn("purge failed", { err });
    }
  }
  accept(socket) {
    const conn = { socket, peer: null, authed: false };
    this.conns.add(conn);
    socket.setEncoding("utf8");
    const decoder = new FrameDecoder(MAX_FRAME_BYTES);
    this.log.debug("connection accepted");
    socket.on("data", (chunk) => {
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch (err) {
        this.log.warn("dropping connection after undecodable frame", { err });
        socket.destroy();
        return;
      }
      for (const f of frames) {
        if (f.t === "req") void this.dispatch(conn, f);
        else this.log.debug("ignoring non-request frame from client", { t: f.t });
      }
    });
    socket.on("error", (err) => this.log.debug("connection error", { err: err.message }));
    socket.on("close", () => {
      this.conns.delete(conn);
      if (conn.peer) {
        this.log.info("peer left", { name: conn.peer.name, agent: conn.peer.agent });
        this.broadcastEvent("peer_left", conn.peer, conn);
      }
    });
  }
  async dispatch(conn, frame) {
    const handler = this.handlers[frame.op];
    try {
      if (!handler) throw new BridgeError("bad_request", `unknown op: ${String(frame.op)}`);
      if (!conn.authed && !UNAUTHENTICATED_OPS.has(frame.op)) throw new BridgeError("unauthorized", "authenticate first");
      this.log.debug("request", { op: frame.op, peer: conn.peer?.name });
      const result = await handler(conn, frame.args ?? {});
      this.write(conn, { t: "res", id: frame.id, ok: true, result });
    } catch (err) {
      const be = err instanceof BridgeError ? err : new BridgeError("internal", String(err?.message ?? err));
      if (be.code === "internal") this.log.error("request failed", { op: frame.op, err });
      else this.log.debug("request rejected", { op: frame.op, code: be.code, message: be.message });
      this.write(conn, { t: "res", id: frame.id, ok: false, error: be.toPayload() });
    }
  }
  write(conn, frame) {
    if (!conn.socket.destroyed) conn.socket.write(encodeFrame(frame));
  }
  emit(conn, ev, data) {
    const frame = { t: "evt", ev, data };
    this.write(conn, frame);
  }
  broadcastEvent(ev, data, except) {
    for (const c of this.conns) if (c !== except && c.peer) this.emit(c, ev, data);
  }
  requirePeer(conn) {
    if (!conn.peer) throw new BridgeError("not_registered", "send hello first");
    return conn.peer;
  }
  livePeers() {
    return [...this.conns].flatMap((c) => c.peer ? [c.peer] : []);
  }
  connByName(name) {
    for (const c of this.conns) if (c.peer?.name === name) return c;
    return void 0;
  }
  uniqueName(requested) {
    if (!this.connByName(requested)) return requested;
    for (let i = 2; i < NAME_SUFFIX_LIMIT; i++) {
      const candidate = `${requested}-${i}`;
      if (!this.connByName(candidate)) return candidate;
    }
    return `${requested}-${randomUUID().slice(0, 8)}`;
  }
  checkAuth(protocol, token) {
    if (protocol !== PROTOCOL_VERSION) {
      throw new BridgeError("protocol_mismatch", `broker speaks protocol ${PROTOCOL_VERSION}, client ${protocol}`, {
        brokerProtocol: PROTOCOL_VERSION
      });
    }
    if (typeof token !== "string" || !tokensEqual(token, this.token)) {
      this.log.warn("rejected connection with a wrong or missing token");
      throw new BridgeError("unauthorized", "wrong agent-bridge token");
    }
  }
  onHello(conn, args) {
    this.checkAuth(args.protocol, args.token);
    conn.authed = true;
    const p = args.peer;
    if (!p || !PEER_NAME_PATTERN.test(p.name ?? "") || !AGENT_KINDS.includes(p.agent)) {
      throw new BridgeError("bad_request", "invalid peer info");
    }
    if (conn.peer) throw new BridgeError("bad_request", "already registered");
    const name = this.uniqueName(p.name);
    const peer = {
      id: String(p.id),
      name,
      agent: p.agent,
      cwd: String(p.cwd ?? ""),
      pid: Number(p.pid),
      agentPid: p.agentPid ?? null,
      sessionId: p.sessionId ?? null,
      startedAt: Number(p.startedAt) || this.now(),
      autoWake: Boolean(p.autoWake),
      activity: p.activity === "busy" || p.activity === "idle" ? p.activity : null,
      version: typeof p.version === "string" ? p.version.slice(0, 32) : void 0
    };
    conn.peer = peer;
    const claimed = this.store.claim(agentQueueKey(peer.agent), peer.name);
    this.log.info("peer joined", { name, agent: peer.agent, cwd: peer.cwd, claimed });
    this.broadcastEvent("peer_joined", peer, conn);
    setImmediate(() => {
      for (const m of this.store.unread(peer.name, PENDING_MAX_LIMIT)) this.emit(conn, "message", m);
    });
    return { brokerPid: process.pid, name, peers: this.livePeers().filter((x) => x.id !== peer.id) };
  }
  onUpdatePeer(conn, args) {
    const peer = this.requirePeer(conn);
    if (args.sessionId !== void 0) peer.sessionId = args.sessionId;
    if (args.autoWake !== void 0) peer.autoWake = Boolean(args.autoWake);
    if (typeof args.cwd === "string" && args.cwd) peer.cwd = args.cwd;
    if (args.activity === "busy" || args.activity === "idle") peer.activity = args.activity;
    if (typeof args.name === "string" && args.name !== peer.name) {
      if (!PEER_NAME_PATTERN.test(args.name)) throw new BridgeError("bad_request", "invalid peer name");
      const old = peer.name;
      peer.name = this.uniqueName(args.name);
      this.log.info("peer renamed", { from: old, to: peer.name });
      setImmediate(() => {
        for (const m of this.store.unread(peer.name, PENDING_MAX_LIMIT)) this.emit(conn, "message", m);
      });
    }
    this.log.debug("peer updated", { name: peer.name, sessionId: peer.sessionId, autoWake: peer.autoWake, cwd: peer.cwd });
    return peer;
  }
  /** Turns a sender-supplied target into live connections and/or offline queue keys. */
  resolveTargets(to, sender) {
    const others = [...this.conns].filter((c) => c.peer && c.peer.id !== sender.id);
    if (to === BROADCAST) {
      if (others.length === 0) throw new BridgeError("unknown_target", "no other peers are online");
      return { live: others, queued: [] };
    }
    const exact = others.find((c) => c.peer.id === to || c.peer.name === to);
    if (exact) return { live: [exact], queued: [] };
    if (to === sender.name || to === sender.id) throw new BridgeError("bad_request", "cannot send a message to yourself");
    if (AGENT_KINDS.includes(to)) {
      const ofKind = others.filter((c) => c.peer.agent === to);
      if (ofKind.length === 1) return { live: ofKind, queued: [] };
      if (ofKind.length > 1) {
        throw new BridgeError("ambiguous_target", `several ${to} peers are online`, {
          candidates: ofKind.map((c) => c.peer.name)
        });
      }
      return { live: [], queued: [agentQueueKey(to)] };
    }
    if (!PEER_NAME_PATTERN.test(to)) throw new BridgeError("unknown_target", `invalid target: ${to}`);
    return { live: [], queued: [to] };
  }
  onSend(conn, args) {
    const sender = this.requirePeer(conn);
    const body = typeof args.body === "string" ? args.body : "";
    if (!body.trim()) throw new BridgeError("bad_request", "message body is empty");
    if (body.length > MAX_BODY_CHARS) throw new BridgeError("too_large", `message body exceeds ${MAX_BODY_CHARS} characters`);
    const to = String(args.to ?? "").trim();
    if (!to) throw new BridgeError("bad_request", "missing target");
    let conversationId = args.conversationId?.trim() || "";
    let hop = 0;
    const replyTo = args.replyTo?.trim() || null;
    if (replyTo) {
      const parent = this.store.byId(replyTo);
      if (parent) {
        hop = parent.hop + 1;
        conversationId ||= parent.conversationId;
      } else {
        this.log.debug("replyTo refers to an unknown message", { replyTo });
      }
    }
    conversationId ||= randomUUID();
    const { live, queued } = this.resolveTargets(to, sender);
    const id = randomUUID();
    const createdAt = this.now();
    const base = {
      id,
      from: { id: sender.id, name: sender.name, agent: sender.agent },
      to,
      conversationId,
      replyTo,
      hop,
      body,
      createdAt,
      readAt: null
    };
    const messages = [];
    for (const c of live) messages.push({ ...base, recipient: c.peer.name });
    for (const key of queued) messages.push({ ...base, recipient: key });
    for (const m of messages) this.store.insert(m);
    live.forEach((c, i) => this.emit(c, "message", messages[i]));
    this.log.info("message routed", {
      id,
      from: sender.name,
      to,
      hop,
      deliveredTo: live.map((c) => c.peer.name),
      queuedFor: queued
    });
    return { messages, deliveredTo: live.map((c) => c.peer.name), queuedFor: queued };
  }
};

// src/core/node.ts
var READ_ID_MEMORY = 2e3;
var jitter = () => ELECTION_RETRY_MIN_MS + Math.floor(Math.random() * (ELECTION_RETRY_MAX_MS - ELECTION_RETRY_MIN_MS));
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function errCode(err) {
  return String(err?.code ?? "");
}
var BridgeNode = class extends EventEmitter2 {
  constructor(opts) {
    super();
    this.opts = opts;
    this.currentName = opts.name;
    this.currentCwd = opts.cwd;
    this.autoWake = opts.autoWake;
    this.log = opts.log.child("node");
  }
  opts;
  id = randomUUID2();
  client = null;
  broker = null;
  stopping = false;
  electing = null;
  currentName;
  inbox = /* @__PURE__ */ new Map();
  readIds = /* @__PURE__ */ new Set();
  unflushedAcks = /* @__PURE__ */ new Set();
  sessionId = null;
  autoWake;
  currentCwd;
  lastSent = 0;
  /** Ids of messages this peer sent as new questions (not replies); replies to them are awaited. */
  asked = /* @__PURE__ */ new Set();
  activity = null;
  log;
  get name() {
    return this.currentName;
  }
  get isBroker() {
    return this.broker !== null;
  }
  get isConnected() {
    return this.client !== null && !this.client.isClosed;
  }
  get autoWakeEnabled() {
    return this.autoWake;
  }
  async start() {
    await this.ensureConnected();
  }
  async stop() {
    this.stopping = true;
    this.client?.close();
    this.client = null;
    if (this.broker) await this.broker.close();
    this.broker = null;
    this.log.info("bridge node stopped");
  }
  /** Connects (electing a broker if needed). Concurrent callers share one attempt. */
  ensureConnected() {
    if (this.isConnected) return Promise.resolve();
    this.electing ??= this.elect().finally(() => {
      this.electing = null;
    });
    return this.electing;
  }
  async elect() {
    for (let attempt = 1; attempt <= ELECTION_MAX_ATTEMPTS && !this.stopping; attempt++) {
      try {
        const client = await BridgeClient.connect(this.opts.pipePath, this.log.child("client"));
        await this.adopt(client);
        return;
      } catch (err) {
        if (err instanceof BridgeError && (err.code === "unauthorized" || err.code === "protocol_mismatch")) {
          this.log.error("broker refused this peer", { code: err.code, message: err.message });
          throw err;
        }
        const code = errCode(err);
        this.log.debug("connect attempt failed", { attempt, code, message: err.message });
        if (code !== "ENOENT" && code !== "ECONNREFUSED") {
          await sleep(jitter());
          continue;
        }
      }
      if (await this.tryBecomeBroker()) continue;
      await sleep(jitter());
    }
    throw new Error(`could not connect to or start the agent-bridge broker at ${this.opts.pipePath}`);
  }
  async tryBecomeBroker() {
    if (this.broker) return true;
    let store;
    try {
      store = new MessageStore(this.opts.dbPath, this.log.child("store"));
    } catch (err) {
      this.log.error("cannot open message store", { err, db: this.opts.dbPath });
      throw err;
    }
    const broker = new Broker(this.opts.pipePath, store, this.log.child("broker"), this.opts.token);
    try {
      await broker.listen();
      this.broker = broker;
      this.log.info("became broker", { pipe: this.opts.pipePath });
      return true;
    } catch (err) {
      store.close();
      const code = errCode(err);
      if (code === "EADDRINUSE" && (this.opts.platform ?? process.platform) !== "win32") {
        try {
          await BridgeClient.connect(this.opts.pipePath, this.log).then((c) => c.close());
          return false;
        } catch (probeErr) {
          if (errCode(probeErr) === "ECONNREFUSED") {
            this.log.warn("removing stale broker socket", { pipe: this.opts.pipePath });
            try {
              unlinkSync(this.opts.pipePath);
            } catch {
            }
          }
        }
      } else {
        this.log.debug("could not become broker", { code });
      }
      return false;
    }
  }
  async adopt(client) {
    client.on("event", (ev, data) => this.onEvent(ev, data));
    const hello = await client.request("hello", this.helloArgs()).catch((err) => {
      client.close();
      throw err;
    });
    this.afterHello(client, hello);
  }
  helloArgs() {
    return {
      protocol: PROTOCOL_VERSION,
      token: this.opts.token,
      peer: {
        id: this.id,
        name: this.currentName,
        agent: this.opts.agent,
        cwd: this.currentCwd,
        pid: process.pid,
        agentPid: process.ppid ?? null,
        sessionId: this.sessionId,
        startedAt: Date.now(),
        autoWake: this.autoWake,
        activity: this.activity,
        version: APP_VERSION
      }
    };
  }
  afterHello(client, hello) {
    this.client = client;
    this.currentName = hello.name;
    client.once("close", () => this.onClose(client));
    if (this.unflushedAcks.size > 0) {
      const ids = [...this.unflushedAcks];
      this.unflushedAcks.clear();
      client.request("ack", { ids }).catch((err) => {
        this.log.warn("flushing acks failed", { err: err.message });
        ids.forEach((id) => this.unflushedAcks.add(id));
      });
    }
    this.log.info("connected to broker", { name: hello.name, brokerPid: hello.brokerPid, isBroker: this.isBroker });
    this.emit("connected", { name: hello.name, isBroker: this.isBroker });
  }
  onClose(client) {
    if (this.client !== client) return;
    this.client = null;
    if (this.stopping) return;
    this.log.warn("lost connection to broker; re-electing");
    this.emit("disconnected");
    setTimeout(() => {
      this.ensureConnected().catch((err) => this.log.error("re-election failed", { err: err.message }));
    }, jitter()).unref();
  }
  onEvent(ev, data) {
    if (ev === "message") {
      const m = data;
      if (this.readIds.has(m.id) || this.inbox.has(m.id)) return;
      this.inbox.set(m.id, m);
      this.log.debug("message received", { id: m.id, from: m.from.name, hop: m.hop });
      this.emit("message", m);
    } else if (ev === "peer_joined" || ev === "peer_left") {
      this.emit(ev, data);
    }
  }
  async withClient(fn) {
    await this.ensureConnected();
    return fn(this.client);
  }
  send(args) {
    return this.withClient(async (c) => {
      const res = await c.request("send", args);
      this.lastSent = Date.now();
      if (!args.replyTo) for (const m of res.messages) this.asked.add(m.id);
      if (this.asked.size > READ_ID_MEMORY) this.asked.delete(this.asked.values().next().value);
      return res;
    });
  }
  /** A reply to a question this peer asked (so the answer should reach the agent even when it is idle). */
  isAwaitedReply(m) {
    return m.replyTo !== null && this.asked.has(m.replyTo);
  }
  /** When this peer last sent a message (0 = never); marks it as taking part in a conversation. */
  get lastSentAt() {
    return this.lastSent;
  }
  peers() {
    return this.withClient((c) => c.request("peers", {}));
  }
  /** Locally buffered unread messages, oldest first. */
  unread() {
    return [...this.inbox.values()].sort((a, b) => a.createdAt - b.createdAt);
  }
  /** Look up a message by id: one we still hold, or remembered as read. */
  hasSeen(id) {
    return this.inbox.has(id) || this.readIds.has(id);
  }
  get(id) {
    return this.inbox.get(id);
  }
  /**
   * Put a message into this peer's own inbox without going through the broker, e.g. the result of a
   * background subagent. It is handled exactly like a peer message (hooks, wait_for_message, channel).
   */
  deliverLocal(m) {
    this.onEvent("message", m);
  }
  /** Mark messages consumed locally and on the broker. */
  markRead(ids) {
    const real = ids.filter((id) => this.inbox.delete(id));
    for (const id of real) {
      this.readIds.add(id);
      if (this.readIds.size > READ_ID_MEMORY) this.readIds.delete(this.readIds.values().next().value);
    }
    if (real.length === 0) return;
    if (!this.isConnected) {
      real.forEach((id) => this.unflushedAcks.add(id));
      return;
    }
    this.client.request("ack", { ids: real }).catch((err) => {
      this.log.warn("ack failed; will retry after reconnect", { err: err.message });
      real.forEach((id) => this.unflushedAcks.add(id));
    });
  }
  /** Resolves with the next unread message (possibly one already waiting), or null on timeout. */
  waitForMessage(timeoutMs, predicate = () => true, signal) {
    const existing = this.unread().find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve3) => {
      const done = (m) => {
        clearTimeout(timer);
        this.off("message", onMessage);
        signal?.removeEventListener("abort", onAbort);
        resolve3(m);
      };
      const onMessage = (m) => {
        if (predicate(m)) done(m);
      };
      const onAbort = () => done(null);
      const timer = setTimeout(() => done(null), timeoutMs);
      this.on("message", onMessage);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  async setSessionId(sessionId) {
    if (sessionId === this.sessionId) return;
    this.sessionId = sessionId;
    if (this.isConnected) await this.client.request("updatePeer", { sessionId });
  }
  /** Report busy/idle to the broker so peers can see who is free. Only changes are sent. */
  setActivity(state) {
    if (state === this.activity) return;
    this.activity = state;
    if (this.isConnected) {
      this.client.request("updatePeer", { activity: state }).catch((err) => this.log.debug("activity update failed", { err: err.message }));
    }
  }
  async setAutoWake(enabled) {
    this.autoWake = enabled;
    if (this.isConnected) await this.client.request("updatePeer", { autoWake: enabled });
  }
  get currentSessionId() {
    return this.sessionId;
  }
  get cwd() {
    return this.currentCwd;
  }
  /**
   * Record the real project directory once the host tells us (hook input carries it). When a new
   * name is given, the peer is renamed as well.
   */
  async relocate(cwd, name) {
    if (cwd === this.currentCwd && (!name || name === this.currentName)) return;
    this.currentCwd = cwd;
    if (name) this.currentName = name;
    this.log.info("peer relocated", { cwd, name: this.currentName });
    if (this.isConnected) {
      const peer = await this.client.request("updatePeer", { cwd, ...name ? { name } : {} });
      this.currentName = peer.name;
    }
  }
};

// src/core/paths.ts
import { createHash } from "node:crypto";
import { join as join4, posix, resolve } from "node:path";
var PIPE_HASH_LENGTH = 12;
function resolveHome(env = process.env) {
  return resolve(env[ENV.home]?.trim() || DEFAULT_HOME);
}
function resolvePipePath(home, env = process.env, platform = process.platform) {
  const override = env[ENV.pipe]?.trim();
  if (override) return override;
  if (platform === "win32") {
    const hash = createHash("sha256").update(home.toLowerCase()).digest("hex").slice(0, PIPE_HASH_LENGTH);
    return `${WINDOWS_PIPE_PREFIX}${APP_NAME}-${hash}`;
  }
  return posix.join(home, SOCKET_FILE_NAME);
}
function resolveDbPath(home) {
  return join4(home, DB_FILE_NAME);
}

// src/mcp/format.ts
var TAG = "agent-bridge-message";
function escapeAttr(v) {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function neutralizeBody(body) {
  return body.replace(new RegExp(`</?${TAG}`, "gi"), (m) => m.replace("<", "&lt;"));
}
function formatMessage(m) {
  const attrs = {
    id: m.id,
    from: m.from.name,
    agent: m.from.agent,
    conversation: m.conversationId,
    hop: String(m.hop),
    sent: new Date(m.createdAt).toISOString()
  };
  if (m.replyTo) attrs.reply_to = m.replyTo;
  const a = Object.entries(attrs).map(([k, v]) => `${k}="${escapeAttr(v)}"`).join(" ");
  return `<${TAG} ${a}>
${neutralizeBody(m.body)}
</${TAG}>`;
}

// src/cli/installer.ts
import { spawn as spawn2 } from "node:child_process";
import { createInterface } from "node:readline/promises";

// src/core/delegate.ts
import { spawn } from "node:child_process";
import { existsSync, readFileSync as readFileSync2, realpathSync } from "node:fs";
import { delimiter, extname, isAbsolute, join as join5, win32 } from "node:path";

// src/core/progress.ts
var MAX_STATUS_CHARS = 140;
var MAX_SAY_CHARS = 160;
function txt(s, max = MAX_STATUS_CHARS) {
  return { text: clip(s, max), full: s.trim() };
}
function clip(s, max = MAX_STATUS_CHARS) {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}\u2026` : one;
}
function firstString(o, keys) {
  for (const k of keys) if (typeof o?.[k] === "string" && o[k]) return o[k];
  return null;
}
var INPUT_KEYS = ["command", "file_path", "filePath", "path", "pattern", "query", "url", "description"];
var EDIT_TOOLS = /^(edit|write|multiedit|patch|apply_patch|notebookedit)$/i;
var CMD_TOOLS = /^(bash|shell|powershell)$/i;
var READ_TOOLS = /^(read|grep|glob|list|ls|find)$/i;
function kindOfTool(name) {
  if (EDIT_TOOLS.test(name)) return "edit";
  if (CMD_TOOLS.test(name)) return "cmd";
  if (READ_TOOLS.test(name)) return "read";
  return "tool";
}
function say(text) {
  return text.trim() ? { kind: "say", text: `says: ${clip(text, MAX_SAY_CHARS)}`, full: `says: ${text.trim()}` } : null;
}
function describeCodexEvent(ev) {
  const item = ev?.item;
  if (ev?.type === "item.started" && item) {
    switch (item.type) {
      case "command_execution":
        return { kind: "cmd", ...txt(`running: ${item.command ?? ""}`), id: item.id };
      case "file_change": {
        const paths = (item.changes ?? []).map((c) => c?.path).filter(Boolean);
        return { kind: "edit", ...txt(`editing ${paths.join(", ") || "files"}`), id: item.id };
      }
      case "mcp_tool_call":
        return { kind: "tool", ...txt(`tool ${item.server ?? ""}.${item.tool ?? ""}`), id: item.id };
      case "web_search":
        return { kind: "tool", ...txt(`searching the web${item.query ? `: ${item.query}` : ""}`), id: item.id };
    }
  }
  if (ev?.type === "item.completed" && item?.type === "reasoning") return { kind: "think", text: "thinking" };
  if (ev?.type === "item.completed" && item?.type === "agent_message") return say(String(item.text ?? ""));
  return null;
}
function describeClaudeEvent(ev) {
  if (ev?.type !== "assistant") return null;
  const blocks = ev.message?.content ?? [];
  const tool = blocks.find((b) => b?.type === "tool_use");
  if (tool) {
    const detail = firstString(tool.input, INPUT_KEYS);
    return { kind: kindOfTool(String(tool.name)), ...txt(`${tool.name}${detail ? `: ${detail}` : ""}`), id: tool.id };
  }
  const text = blocks.filter((b) => b?.type === "text").map((b) => b.text).join(" ");
  if (text) return say(text);
  if (blocks.some((b) => b?.type === "thinking")) return { kind: "think", text: "thinking" };
  return null;
}
function describeOpencodeEvent(ev) {
  const part = ev?.part ?? {};
  if (ev?.type === "tool_use" || part.type === "tool") {
    const tool = String(part.tool ?? "tool");
    const detail = firstString(part.state?.input, INPUT_KEYS);
    return { kind: kindOfTool(tool), ...txt(`${tool}${detail ? `: ${detail}` : ""}`), id: part.id };
  }
  if (ev?.type === "text" || part.type === "text") return say(String(part.text ?? ""));
  if (ev?.type === "reasoning" || part.type === "reasoning") return { kind: "think", text: "thinking" };
  return null;
}
var DESCRIBERS = {
  codex: describeCodexEvent,
  claude: describeClaudeEvent,
  opencode: describeOpencodeEvent
};
function formatElapsed(ms) {
  const m = Math.floor(ms / 6e4);
  return m < 1 ? `${Math.round(ms / 1e3)}s` : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
function progressEventHandler(agent, onProgress, now = Date.now) {
  if (!onProgress) return void 0;
  const started = now();
  const seen = /* @__PURE__ */ new Set();
  const counts = { cmd: 0, edit: 0, read: 0, tool: 0, say: 0, think: 0 };
  let steps = 0;
  let last = "";
  return (ev) => {
    const step = DESCRIBERS[agent](ev);
    if (!step) return;
    if (step.id) {
      const key = `${step.kind}:${step.id}`;
      if (seen.has(key)) return;
      seen.add(key);
    }
    if (step.text === last) return;
    last = step.text;
    if (step.kind !== "think" && step.kind !== "say") steps++;
    counts[step.kind]++;
    const totals = [counts.cmd && `${counts.cmd} cmds`, counts.edit && `${counts.edit} edits`].filter(Boolean).join(", ");
    const where = steps ? ` \xB7 step ${steps}${totals ? ` (${totals})` : ""}` : "";
    const head = `${formatElapsed(now() - started)}${where} \xB7 `;
    onProgress(head + step.text, step.full ? head + step.full : void 0);
  };
}
function progressLineHandler(agent, onProgress) {
  const handle = progressEventHandler(agent, onProgress);
  if (!handle) return void 0;
  return (line) => {
    if (!line.startsWith("{")) return;
    try {
      handle(JSON.parse(line));
    } catch {
    }
  };
}

// src/core/delegate.ts
var DELEGATE_DEPTH_ENV = "AGENT_BRIDGE_DELEGATE_DEPTH";
var MAX_DELEGATE_DEPTH = 1;
var KILL_GRACE_MS = 3e3;
var MAX_CAPTURE_CHARS = 8 * 1024 * 1024;
var STDERR_TAIL_CHARS = 4e3;
var WINDOWS_SHIM_EXTS = /* @__PURE__ */ new Set([".cmd", ".bat"]);
var DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
function currentDelegateDepth(env = process.env) {
  const n = Number.parseInt(env[DELEGATE_DEPTH_ENV] ?? "0", 10);
  return Number.isInteger(n) && n > 0 ? n : 0;
}
var DelegateError = class extends Error {
  constructor(message, kind, stderrTail = "", partialStdout = "", sessionId = null) {
    super(message);
    this.kind = kind;
    this.stderrTail = stderrTail;
    this.partialStdout = partialStdout;
    this.sessionId = sessionId;
    this.name = "DelegateError";
  }
  kind;
  stderrTail;
  partialStdout;
  sessionId;
};
function resolveBinary(bin, env = process.env, platform = process.platform) {
  const isWin = platform === "win32";
  const exts = isWin ? (env.PATHEXT ?? DEFAULT_PATHEXT).split(";").filter(Boolean) : [""];
  const candidates = (base) => isWin && !extname(base) ? exts.map((e) => base + e.toLowerCase()) : [base];
  if (isAbsolute(bin) || bin.includes("/") || bin.includes("\\")) {
    return candidates(bin).find((c) => existsSync(c)) ?? null;
  }
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const c of candidates(join5(dir, bin))) if (existsSync(c)) return c;
  }
  return null;
}
function unwrapNpmShim(shimPath, readFile = (p) => readFileSync2(p, "utf8")) {
  let text;
  try {
    text = readFile(shimPath);
  } catch {
    return null;
  }
  const dir = win32.dirname(shimPath);
  const exe = /"%~?dp0%?\\([^"]+?\.exe)"\s+%\*/i.exec(text);
  if (exe) return { command: win32.join(dir, exe[1]), prefix: [] };
  const js = /"%~?dp0%?\\([^"]+?\.(?:c|m)?js)"\s+%\*/i.exec(text);
  if (js) return { command: process.execPath, prefix: [win32.join(dir, js[1])] };
  return null;
}
function runProcess(opts) {
  let resolved = resolveBinary(opts.bin, opts.env);
  if (!resolved) return Promise.reject(new DelegateError(`executable not found: ${opts.bin}`, "not_found"));
  let args = opts.args;
  let needsShell = process.platform === "win32" && WINDOWS_SHIM_EXTS.has(extname(resolved).toLowerCase());
  if (needsShell) {
    const target = unwrapNpmShim(resolved);
    if (target && existsSync(target.command) && target.prefix.every((p) => existsSync(p))) {
      opts.log.debug("unwrapped npm shim", { shim: resolved, command: target.command, prefix: target.prefix });
      resolved = target.command;
      args = [...target.prefix, ...args];
      needsShell = false;
    }
  }
  if (needsShell) {
    for (const a of args) {
      if (/[&|<>^%"\s]/.test(a)) return Promise.reject(new DelegateError(`unsafe argument for shell invocation: ${a}`, "failed"));
    }
  }
  opts.log.debug("spawning delegate", { bin: resolved, args, cwd: opts.cwd, shell: needsShell });
  return new Promise((resolve3, reject) => {
    const child = spawn(needsShell ? `"${resolved}"` : resolved, args, {
      cwd: opts.cwd,
      // Some CLIs (opencode) take their project folder from PWD rather than the real cwd; keep them in sync.
      env: { ...opts.env, PWD: opts.cwd },
      shell: needsShell,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const kill = () => {
      child.kill();
      setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
    };
    const timer = setTimeout(() => {
      kill();
      finish(() => reject(new DelegateError(`delegate timed out after ${Math.round(opts.timeoutMs / 1e3)}s`, "timeout", stderr.slice(-STDERR_TAIL_CHARS), stdout)));
    }, opts.timeoutMs);
    const onAbort = () => {
      kill();
      finish(() => reject(new DelegateError("delegate aborted", "aborted", "", stdout)));
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    let pending = "";
    child.stdout.setEncoding("utf8").on("data", (d) => {
      if (stdout.length < MAX_CAPTURE_CHARS) stdout += d;
      if (!opts.onLine) return;
      pending += d;
      let nl;
      while ((nl = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, nl).trim();
        pending = pending.slice(nl + 1);
        if (line) {
          try {
            opts.onLine(line);
          } catch {
          }
        }
      }
    });
    child.stderr.setEncoding("utf8").on("data", (d) => {
      stderr = (stderr + d).slice(-MAX_CAPTURE_CHARS);
    });
    child.on("error", (err) => finish(() => reject(new DelegateError(`failed to start ${opts.bin}: ${err.message}`, "failed"))));
    child.on("close", (code) => finish(() => resolve3({ code, stdout, stderr })));
    child.stdin.on("error", () => {
    });
    child.stdin.end(opts.stdin);
  });
}
var OPENCODE_CONFIG_CONTENT_ENV = "OPENCODE_CONFIG_CONTENT";
var CODEX_STRICT_APPROVALS = 'approvals_reviewer="user"';
var CODEX_RELAY_APPROVALS = 'approvals_reviewer="auto_review"';
var CODEX_ASK_POLICY = 'approval_policy="on-request"';
var CODEX_ASK_HINT = "(The workspace is read-only on purpose: when you need to change files or run a command the sandbox blocks, request escalated permissions for it. The user is asked and decides; if denied, stop and report.)";
var OPENCODE_READ_ONLY_PERMISSIONS = { edit: "ask", bash: "ask" };
function childEnv(extra = {}) {
  return { ...process.env, ...extra, [DELEGATE_DEPTH_ENV]: String(currentDelegateDepth() + 1) };
}
function checkDepth() {
  if (currentDelegateDepth() >= MAX_DELEGATE_DEPTH) {
    throw new DelegateError("delegation is disabled inside a delegated session (prevents recursive delegation)", "depth");
  }
}
function parseCodexJsonl(stdout) {
  let threadId = null;
  const messages = [];
  let error = null;
  let usage = null;
  for (const line of stdout.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    let ev;
    try {
      ev = JSON.parse(s);
    } catch {
      continue;
    }
    switch (ev.type) {
      case "thread.started":
        threadId = ev.thread_id ?? threadId;
        break;
      case "item.completed":
        if (ev.item?.type === "agent_message" && typeof ev.item.text === "string") messages.push(ev.item.text);
        break;
      case "turn.completed":
        usage = ev.usage ?? usage;
        error = null;
        break;
      case "turn.failed":
        error = ev.error?.message ?? "turn failed";
        break;
      case "error":
        error = ev.message ?? "error";
        break;
    }
  }
  return { threadId, text: messages.at(-1) ?? "", error, usage };
}
function realFolder(dir) {
  try {
    return realpathSync.native(dir);
  } catch {
    return dir;
  }
}
async function delegateToCodex(req) {
  checkDepth();
  req = { ...req, cwd: realFolder(req.cwd) };
  if (req.relayApprovals) req = { ...req, prompt: `${req.prompt}

${CODEX_ASK_HINT}` };
  const common = ["--json", "--skip-git-repo-check", ...req.model ? ["-m", req.model] : []];
  const strict = req.relayApprovals ? ["-c", CODEX_RELAY_APPROVALS, "-c", CODEX_ASK_POLICY] : ["-c", CODEX_STRICT_APPROVALS];
  const args = req.sessionId ? ["exec", "resume", ...common, ...strict, "-c", `sandbox_mode="${req.sandbox}"`, req.sessionId, "-"] : ["exec", ...common, ...strict, "-s", req.sandbox, "-C", req.cwd, "-"];
  const res = await withResumeHint("codex", (o) => parseCodexJsonl(o).threadId, () => runProcess({
    bin: req.bin,
    args,
    stdin: req.prompt,
    cwd: req.cwd,
    timeoutMs: req.timeoutSec * 1e3,
    env: childEnv(req.extraEnv),
    log: req.log,
    signal: req.signal,
    onLine: progressLineHandler("codex", req.onProgress)
  }));
  const parsed = parseCodexJsonl(res.stdout);
  const isError = res.code !== 0 || parsed.error !== null;
  if (isError && !parsed.text) {
    throw new DelegateError(parsed.error ?? `codex exited with code ${res.code}`, "failed", res.stderr.slice(-STDERR_TAIL_CHARS), "", parsed.threadId ?? req.sessionId ?? null);
  }
  req.log.info("codex delegate finished", { threadId: parsed.threadId, code: res.code, isError });
  return {
    sessionId: parsed.threadId ?? req.sessionId ?? null,
    text: parsed.text,
    isError,
    details: { exitCode: res.code, usage: parsed.usage, error: parsed.error }
  };
}
function parseClaudeJson(stdout) {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().startsWith("{"));
  const resultLine = [...lines].reverse().find((l) => l.includes('"type":"result"'));
  const candidate = resultLine ?? (stdout.indexOf("{") >= 0 ? stdout.slice(stdout.indexOf("{")) : null);
  if (!candidate) return null;
  try {
    const o = JSON.parse(candidate);
    return {
      sessionId: typeof o.session_id === "string" ? o.session_id : null,
      text: typeof o.result === "string" ? o.result : "",
      isError: Boolean(o.is_error) || o.subtype === "error",
      cost: o.total_cost_usd ?? null
    };
  } catch {
    return null;
  }
}
var CLAUDE_READ_ONLY_DENIED_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "PowerShell"];
var CLAUDE_READ_ONLY_MODES = /* @__PURE__ */ new Set(["default", "manual", "plan"]);
async function delegateToClaude(req) {
  checkDepth();
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", req.permissionMode];
  if (CLAUDE_READ_ONLY_MODES.has(req.permissionMode)) args.push("--disallowedTools", CLAUDE_READ_ONLY_DENIED_TOOLS.join(","));
  if (req.model) args.push("--model", req.model);
  if (req.sessionId) args.push("--resume", req.sessionId);
  const res = await withResumeHint("claude", (o) => claudeSessionFromStream(o), () => runProcess({
    bin: req.bin,
    args,
    stdin: req.prompt,
    cwd: req.cwd,
    timeoutMs: req.timeoutSec * 1e3,
    env: childEnv(req.extraEnv),
    log: req.log,
    signal: req.signal,
    onLine: progressLineHandler("claude", req.onProgress)
  }));
  const parsed = parseClaudeJson(res.stdout);
  if (!parsed) {
    throw new DelegateError(`claude exited with code ${res.code} without a JSON result`, "failed", (res.stderr || res.stdout).slice(-STDERR_TAIL_CHARS), "", claudeSessionFromStream(res.stdout) ?? req.sessionId ?? null);
  }
  req.log.info("claude delegate finished", { sessionId: parsed.sessionId, code: res.code, isError: parsed.isError });
  return {
    sessionId: parsed.sessionId ?? req.sessionId ?? null,
    text: parsed.text,
    isError: parsed.isError || res.code !== 0,
    details: { exitCode: res.code, costUsd: parsed.cost }
  };
}
function parseOpencodeJsonl(stdout) {
  let sessionId = null;
  const textByMessage = /* @__PURE__ */ new Map();
  let lastMessage = "";
  let error = null;
  let input = 0;
  let output = 0;
  let cost = 0;
  let sawUsage = false;
  for (const line of stdout.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    let ev;
    try {
      ev = JSON.parse(s);
    } catch {
      continue;
    }
    if (typeof ev.sessionID === "string") sessionId ??= ev.sessionID;
    if (ev.type === "step_finish" && ev.part?.tokens) {
      sawUsage = true;
      input += Number(ev.part.tokens.input) || 0;
      output += Number(ev.part.tokens.output) || 0;
      cost += Number(ev.part.cost) || 0;
    }
    if (ev.type === "text" && typeof ev.part?.text === "string") {
      const mid = String(ev.part.messageID ?? "");
      if (!textByMessage.has(mid)) textByMessage.set(mid, []);
      textByMessage.get(mid).push(ev.part.text);
      lastMessage = mid;
    } else if (ev.type === "error") {
      error = ev.error?.data?.message ?? ev.error?.message ?? ev.message ?? "opencode reported an error";
    }
  }
  const text = (textByMessage.get(lastMessage) ?? []).join("");
  return sawUsage ? { sessionId, text, error, usage: { input, output }, cost } : { sessionId, text, error };
}
async function delegateToOpencode(req) {
  checkDepth();
  const args = ["run", "--format", "json", "--dir", req.cwd];
  if (req.model) args.push("-m", req.model);
  if (req.sessionId) args.push("-s", req.sessionId);
  if (req.autoApprove) args.push("--auto");
  const env = childEnv(req.extraEnv);
  if (!req.autoApprove) env[OPENCODE_CONFIG_CONTENT_ENV] = JSON.stringify({ permission: OPENCODE_READ_ONLY_PERMISSIONS });
  const res = await withResumeHint("opencode", (o) => parseOpencodeJsonl(o).sessionId, () => runProcess({
    bin: req.bin,
    args,
    stdin: req.prompt,
    cwd: req.cwd,
    timeoutMs: req.timeoutSec * 1e3,
    env,
    log: req.log,
    signal: req.signal,
    onLine: progressLineHandler("opencode", req.onProgress)
  }));
  const parsed = parseOpencodeJsonl(res.stdout);
  const isError = res.code !== 0 || parsed.error !== null;
  if (isError && !parsed.text) {
    throw new DelegateError(parsed.error ?? `opencode exited with code ${res.code}`, "failed", res.stderr.slice(-STDERR_TAIL_CHARS), "", parsed.sessionId ?? req.sessionId ?? null);
  }
  req.log.info("opencode delegate finished", { sessionId: parsed.sessionId, code: res.code, isError });
  return { sessionId: parsed.sessionId ?? req.sessionId ?? null, text: parsed.text, isError, details: { exitCode: res.code, error: parsed.error, usage: parsed.usage ?? null, costUsd: parsed.cost || null } };
}
var checkDepthPublic = checkDepth;
var childEnvPublic = (extra = {}) => childEnv(extra);
function claudeSessionFromStream(stdout) {
  const m = /"session_id":"([^"]+)"/.exec(stdout);
  return m ? m[1] : null;
}
async function withResumeHint(agent, sessionOf, run2) {
  try {
    return await run2();
  } catch (err) {
    if (err instanceof DelegateError && !err.sessionId) err.sessionId = sessionOf(err.partialStdout);
    if (err instanceof DelegateError && err.kind === "timeout") {
      const id = err.sessionId;
      if (id) {
        throw new DelegateError(
          `${err.message}. The ${agent} session ${id} keeps its progress: call again with session_id="${id}" (and a longer timeout_sec, or use spawn_${agent}) to continue instead of starting over.`,
          "timeout",
          err.stderrTail,
          err.partialStdout,
          id
        );
      }
    }
    throw err;
  }
}

// src/cli/opencode-install.ts
import { copyFileSync, existsSync as existsSync2, mkdirSync as mkdirSync4, readdirSync, readFileSync as readFileSync3, rmSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { dirname as dirname3, join as join6, resolve as resolve2 } from "node:path";
import { fileURLToPath } from "node:url";
var INSTALL_MARKER = "agent-bridge";
var PLUGIN_FILE = "agent-bridge.js";
var SERVER_DIR = "agent-bridge";
var SERVER_FILE = "server.mjs";
var SKILL_REL = join6("skills", "agent-bridge", "SKILL.md");
var AGENTS_DIR = "agents";
function opencodeConfigDir(env = process.env) {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return join6(xdg || join6(homedir2(), ".config"), "opencode");
}
function pluginSourceDir(name, marker, fromFile = fileURLToPath(import.meta.url)) {
  let dir = dirname3(fromFile);
  for (let i = 0; i < 5; i++) {
    for (const candidate of [join6(dir, "plugins", name), join6(dir, "..", name)]) {
      if (existsSync2(join6(candidate, marker))) return resolve2(candidate);
    }
    dir = dirname3(dir);
  }
  return null;
}
var opencodeSourceDir = (from) => pluginSourceDir("opencode", join6("dist", PLUGIN_FILE), from);
function ownedByUs(path) {
  try {
    return readFileSync3(path, "utf8").includes(INSTALL_MARKER);
  } catch {
    return false;
  }
}
function copyAll(copies, configDir) {
  const res = { configDir, files: [], skipped: [] };
  for (const [from, to] of copies) {
    if (!existsSync2(from)) throw new Error(`missing build output: ${from} (run npm run build)`);
    if (existsSync2(to) && !ownedByUs(to)) {
      res.skipped.push(to);
      continue;
    }
    mkdirSync4(dirname3(to), { recursive: true });
    copyFileSync(from, to);
    res.files.push(to);
  }
  return res;
}
var AGENT_SOURCE_SUFFIX = ".agent.md";
function agentCopies(sourceDir, targetDir) {
  const dir = join6(sourceDir, AGENTS_DIR);
  if (!existsSync2(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(AGENT_SOURCE_SUFFIX)).map((f) => [join6(dir, f), join6(targetDir, AGENTS_DIR, f.slice(0, -AGENT_SOURCE_SUFFIX.length) + ".md")]);
}
function installOpencode(sourceDir, configDir = opencodeConfigDir()) {
  return copyAll(
    [
      [join6(sourceDir, "dist", PLUGIN_FILE), join6(configDir, "plugins", PLUGIN_FILE)],
      [join6(sourceDir, "dist", SERVER_FILE), join6(configDir, "plugins", SERVER_DIR, SERVER_FILE)],
      [join6(sourceDir, SKILL_REL), join6(configDir, SKILL_REL)],
      ...agentCopies(sourceDir, configDir)
    ],
    configDir
  );
}
function uninstallOpencode(configDir = opencodeConfigDir(), sourceDir = opencodeSourceDir()) {
  const targets = [join6(configDir, "plugins", PLUGIN_FILE), join6(configDir, "plugins", SERVER_DIR), join6(configDir, "skills", "agent-bridge")];
  if (sourceDir) targets.push(...agentCopies(sourceDir, configDir).map(([, to]) => to));
  return removeOwned(targets, configDir);
}
function removeOwned(targets, configDir) {
  const res = { configDir, files: [], skipped: [] };
  for (const p of targets) {
    if (!existsSync2(p)) continue;
    const isOurFile = p.endsWith(".md") || p.endsWith(".toml") ? ownedByUs(p) : true;
    if (!isOurFile) {
      res.skipped.push(p);
      continue;
    }
    rmSync(p, { recursive: true, force: true });
    res.files.push(p);
  }
  return res;
}

// src/cli/installer.ts
var MARKETPLACE_REPO = "rennerdo30/agent-bridge";
var MARKETPLACE_NAME = "agent-bridge";
var PLUGIN_ID = `agent-bridge@${MARKETPLACE_NAME}`;
var TOOLS = ["claude", "codex", "opencode"];
function planFor(tool, action) {
  if (tool === "claude") {
    switch (action) {
      case "install":
        return [
          // Adding an existing marketplace fails harmlessly; the update afterwards refreshes it.
          { kind: "command", bin: "claude", args: ["plugin", "marketplace", "add", MARKETPLACE_REPO], allowFailure: true },
          { kind: "command", bin: "claude", args: ["plugin", "marketplace", "update", MARKETPLACE_NAME] },
          { kind: "command", bin: "claude", args: ["plugin", "install", PLUGIN_ID] }
        ];
      case "update":
        return [
          { kind: "command", bin: "claude", args: ["plugin", "marketplace", "update", MARKETPLACE_NAME] },
          { kind: "command", bin: "claude", args: ["plugin", "update", PLUGIN_ID] }
        ];
      case "uninstall":
        return [{ kind: "command", bin: "claude", args: ["plugin", "uninstall", PLUGIN_ID] }];
    }
  }
  if (tool === "codex") {
    switch (action) {
      case "install":
        return [
          { kind: "command", bin: "codex", args: ["plugin", "marketplace", "add", MARKETPLACE_REPO], allowFailure: true },
          { kind: "command", bin: "codex", args: ["plugin", "marketplace", "upgrade", MARKETPLACE_NAME] },
          { kind: "command", bin: "codex", args: ["plugin", "add", PLUGIN_ID] }
        ];
      case "update":
        return [
          { kind: "command", bin: "codex", args: ["plugin", "marketplace", "upgrade", MARKETPLACE_NAME] },
          { kind: "command", bin: "codex", args: ["plugin", "add", PLUGIN_ID] }
        ];
      case "uninstall":
        return [{ kind: "command", bin: "codex", args: ["plugin", "remove", PLUGIN_ID] }];
    }
  }
  return [{ kind: "opencode", action }];
}
function describeStep(step) {
  if (step.kind === "command") return `${step.bin} ${step.args.join(" ")}`;
  return step.action === "uninstall" ? t("installer.opencodeRemove") : t("installer.opencodeCopy");
}
function runInherited(bin, args) {
  const resolved = resolveBinary(bin);
  if (!resolved) return Promise.resolve(127);
  const shim = /\.(cmd|bat)$/i.test(resolved) ? unwrapNpmShim(resolved) : null;
  const command = shim?.command ?? resolved;
  const fullArgs = [...shim?.prefix ?? [], ...args];
  return new Promise((resolve3) => {
    const child = spawn2(command, fullArgs, { stdio: "inherit", shell: false });
    child.on("error", () => resolve3(1));
    child.on("close", (code) => resolve3(code ?? 1));
  });
}
function ask(rl, question) {
  return new Promise((resolve3) => {
    const onClose = () => resolve3("");
    rl.once("close", onClose);
    rl.question(question).then(
      (a) => {
        rl.off("close", onClose);
        resolve3(a);
      },
      () => resolve3("")
    );
  });
}
async function runInstaller(opts) {
  const rl = opts.yes ? null : createInterface({ input: process.stdin, output: process.stdout });
  let failures = 0;
  try {
    for (const tool of opts.tools) {
      const bin = tool === "opencode" ? "opencode" : tool;
      if (!resolveBinary(bin)) {
        opts.out(t("installer.notFound", { tool }));
        continue;
      }
      const steps = planFor(tool, opts.action);
      opts.out(t("installer.plan", { tool }));
      for (const s of steps) opts.out(`  ${describeStep(s)}`);
      if (tool === "codex") opts.out(t("installer.codexNote"));
      if (rl) {
        const answer = (await ask(rl, t("installer.confirm", { tool }))).trim().toLowerCase();
        if (answer !== "y" && answer !== "yes") {
          opts.out(t("installer.skipped", { tool }));
          continue;
        }
      }
      for (const step of steps) {
        if (step.kind === "opencode") {
          const source = opencodeSourceDir();
          if (step.action === "uninstall") {
            const res = uninstallOpencode();
            for (const f of res.files) opts.out(`  - ${f}`);
          } else if (!source) {
            opts.out(t("cli.opencode.noSource"));
            failures++;
          } else {
            const res = installOpencode(source);
            for (const f of res.files) opts.out(`  + ${f}`);
            for (const f of res.skipped) opts.out(t("cli.install.skipped", { path: f }));
          }
          continue;
        }
        opts.out(`> ${describeStep(step)}`);
        const code = await runInherited(step.bin, step.args);
        if (code !== 0 && !step.allowFailure) {
          opts.out(t("installer.stepFailed", { code }));
          failures++;
          break;
        }
      }
    }
  } finally {
    rl?.close();
  }
  opts.out(failures ? t("installer.doneWithErrors", { count: failures }) : t("installer.done"));
  return failures ? 1 : 0;
}
function parseInstallerArgs(action, rest) {
  const picked = rest.filter((a) => TOOLS.includes(a));
  return picked.length ? picked : [...TOOLS];
}

// src/core/relay.ts
import { randomBytes as randomBytes2 } from "node:crypto";
import { createServer as createServer2 } from "node:http";
var RELAY_URL_ENV = "AGENT_BRIDGE_RELAY_URL";
var RELAY_TOKEN_ENV = "AGENT_BRIDGE_RELAY_TOKEN";
var RELAY_HOST = "127.0.0.1";
var RELAY_PATH = "/permission";
var MAX_REQUEST_BYTES = 256 * 1024;
var SECRET_BYTES = 24;
var PermissionRelay = class {
  constructor(handler, log) {
    this.handler = handler;
    this.log = log;
  }
  handler;
  log;
  server = null;
  secret = randomBytes2(SECRET_BYTES).toString("hex");
  url = "";
  async start() {
    this.server = createServer2((req, res) => {
      void this.handle(req).then(
        (body) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        },
        (err) => {
          this.log.warn("permission relay request failed", { err: err.message });
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ allow: false, message: "agent-bridge relay error" }));
        }
      );
    });
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 0;
    await new Promise((resolve3, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, RELAY_HOST, () => resolve3());
    });
    const { port } = this.server.address();
    this.url = `http://${RELAY_HOST}:${port}${RELAY_PATH}`;
    this.log.debug("permission relay listening", { url: this.url });
  }
  /** Environment variables that let a child process reach this relay. */
  childEnv() {
    return { [RELAY_URL_ENV]: this.url, [RELAY_TOKEN_ENV]: this.secret };
  }
  async stop() {
    const s = this.server;
    this.server = null;
    if (s) await new Promise((r) => s.close(() => r()));
  }
  async handle(req) {
    if (req.method !== "POST" || req.url !== RELAY_PATH) throw new Error("not found");
    const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!tokensEqual(auth, this.secret)) throw new Error("unauthorized");
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > MAX_REQUEST_BYTES) throw new Error("request too large");
    }
    const body = JSON.parse(raw);
    const request2 = {
      agent: String(body.agent ?? "subagent"),
      tool: String(body.tool ?? "unknown"),
      detail: String(body.detail ?? "").slice(0, 4e3),
      cwd: body.cwd ? String(body.cwd) : void 0
    };
    this.log.info("permission requested by subagent", { agent: request2.agent, tool: request2.tool });
    const decision = await this.handler(request2);
    this.log.info("permission decided", { tool: request2.tool, allow: decision.allow });
    return decision;
  }
};
async function askRelay(req, env = process.env) {
  const url = env[RELAY_URL_ENV];
  const token = env[RELAY_TOKEN_ENV];
  if (!url || !token) return { allow: false, message: "agent-bridge: no permission relay for this run" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(req)
    });
    const body = await res.json();
    return body.allow === true ? { allow: true } : { allow: false, message: body.message ?? "denied" };
  } catch (err) {
    return { allow: false, message: `agent-bridge: permission relay unreachable (${err.message})` };
  }
}

// src/cli/permission-hook.ts
var MAX_DETAIL_CHARS = 4e3;
function describe(toolInput) {
  if (toolInput && typeof toolInput === "object") {
    const o = toolInput;
    if (typeof o.command === "string") return o.command;
    if (typeof o.file_path === "string") return o.file_path;
  }
  return JSON.stringify(toolInput ?? {}).slice(0, MAX_DETAIL_CHARS);
}
async function readStdin() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}
async function runPermissionHook() {
  if (!process.env[RELAY_URL_ENV]) return 0;
  let input = {};
  try {
    input = JSON.parse(await readStdin() || "{}");
  } catch {
  }
  const decision = await askRelay({
    agent: "codex",
    tool: String(input.tool_name ?? "unknown"),
    detail: describe(input.tool_input).slice(0, MAX_DETAIL_CHARS),
    cwd: typeof input.cwd === "string" ? input.cwd : void 0
  });
  const out2 = {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: decision.allow ? { behavior: "allow" } : { behavior: "deny", message: decision.message }
    }
  };
  process.stdout.write(JSON.stringify(out2));
  return 0;
}

// src/cli/rewake-hook.ts
import { readFileSync as readFileSync4 } from "node:fs";

// src/mcp/rewake.ts
import { randomBytes as randomBytes3 } from "node:crypto";
import { mkdirSync as mkdirSync5, rmSync as rmSync2, writeFileSync } from "node:fs";
import { createServer as createServer3 } from "node:http";
import { join as join7 } from "node:path";
var SESSIONS_DIR = "sessions";
var REWAKE_POLL_MS = 4 * 60 * 1e3;
function sessionFile(home, sessionId) {
  return join7(home, SESSIONS_DIR, `${sessionId.replace(/[^\w-]/g, "_")}.json`);
}

// src/cli/rewake-hook.ts
var EXIT_WAKE = 2;
var MAX_WAIT_MS = 7e3 * 1e3;
async function readStdin2() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}
async function runRewakeHook() {
  let sessionId = "";
  try {
    sessionId = String(JSON.parse(await readStdin2() || "{}").session_id ?? "");
  } catch {
    return 0;
  }
  if (!sessionId) return 0;
  let reg;
  try {
    reg = JSON.parse(readFileSync4(sessionFile(resolveHome(), sessionId), "utf8"));
  } catch {
    return 0;
  }
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    let res;
    try {
      res = await fetch(`http://127.0.0.1:${reg.port}/wait`, { headers: { authorization: `Bearer ${reg.secret}` } });
    } catch {
      return 0;
    }
    if (!res.ok) return 0;
    const { text, superseded } = await res.json();
    if (text) {
      process.stderr.write(text);
      return EXIT_WAKE;
    }
    if (superseded) return 0;
  }
  return 0;
}

// src/cli/watch.ts
import { closeSync as closeSync2, existsSync as existsSync3, openSync as openSync2, readdirSync as readdirSync3, readSync, statSync as statSync3 } from "node:fs";
import { join as join9 } from "node:path";

// src/core/runfeed.ts
import { appendFileSync as appendFileSync2, mkdirSync as mkdirSync6, readdirSync as readdirSync2, statSync as statSync2, unlinkSync as unlinkSync2 } from "node:fs";
import { join as join8 } from "node:path";
var RUNS_DIR_NAME = "runs";

// src/cli/watch.ts
var POLL_MS = 500;
var CHUNK = 64 * 1024;
var FINISHED = / finished after \d+s · /;
function findRunLog(home, filter) {
  const dir = join9(home, RUNS_DIR_NAME);
  if (!existsSync3(dir)) return null;
  const logs = readdirSync3(dir).filter((f) => f.endsWith(".log") && (!filter || f.includes(filter))).map((f) => ({ path: join9(dir, f), t: statSync3(join9(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  return logs[0]?.path ?? null;
}
async function watchRunLog(path, out2) {
  let offset = 0;
  let pending = "";
  for (; ; ) {
    const size = statSync3(path).size;
    if (size > offset) {
      const fd = openSync2(path, "r");
      try {
        const buf = Buffer.alloc(Math.min(CHUNK, size - offset));
        const n = readSync(fd, buf, 0, buf.length, offset);
        offset += n;
        pending += buf.subarray(0, n).toString("utf8");
      } finally {
        closeSync2(fd);
      }
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        out2(line);
        if (FINISHED.test(line)) return;
      }
      continue;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

// src/cli/dashboard.ts
import { randomBytes as randomBytes5 } from "node:crypto";
import { chmodSync as chmodSync2, readFileSync as readFileSync6, rmSync as rmSync3, writeFileSync as writeFileSync2 } from "node:fs";
import { request } from "node:http";
import { join as join11 } from "node:path";

// src/cli/ui.ts
import { randomBytes as randomBytes4 } from "node:crypto";
import { existsSync as existsSync4, readdirSync as readdirSync4, readFileSync as readFileSync5, statSync as statSync4 } from "node:fs";
import { createServer as createServer4 } from "node:http";
import { join as join10 } from "node:path";
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";

// src/cli/ui-page.ts
var UI_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agent-bridge</title>
<style>
:root {
  --bg: #f6f7f9; --panel: #ffffff; --text: #1d2330; --muted: #667085; --line: #e3e6eb;
  --accent: #3b5bdb; --ok: #2b8a3e; --warn: #b7791f; --bad: #c92a2a; --busy: #1971c2;
  --code-bg: #f1f3f5; --sel: #e7edff;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111418; --panel: #191d23; --text: #e6e8eb; --muted: #98a2b3; --line: #2a303a;
    --accent: #7b93ff; --ok: #51cf66; --warn: #fcc419; --bad: #ff6b6b; --busy: #4dabf7;
    --code-bg: #0d1014; --sel: #232b45;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { display: flex; align-items: center; gap: 12px; padding: 12px 20px; border-bottom: 1px solid var(--line); background: var(--panel); }
header h1 { font-size: 16px; margin: 0; }
header .status { color: var(--muted); font-size: 13px; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
main { display: grid; grid-template-columns: minmax(280px, 360px) 1fr; gap: 16px; padding: 16px 20px; min-height: calc(100vh - 53px); }
@media (max-width: 860px) { main { grid-template-columns: 1fr; } }
section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
section h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0; padding: 10px 14px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; }
.col { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
ul { list-style: none; margin: 0; padding: 0; }
li { padding: 9px 14px; border-bottom: 1px solid var(--line); }
li:last-child { border-bottom: 0; }
.name { font-weight: 600; }
.sub { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.tag { font-size: 11px; padding: 1px 6px; border-radius: 10px; border: 1px solid var(--line); color: var(--muted); margin-left: 6px; }
.tag.old { color: var(--bad); border-color: var(--bad); }
.run { cursor: pointer; }
.run:hover { background: var(--sel); }
.run.sel { background: var(--sel); box-shadow: inset 3px 0 0 var(--accent); }
.s-running { color: var(--busy); } .s-done { color: var(--ok); } .s-failed { color: var(--bad); } .s-interrupted { color: var(--warn); }
.empty { padding: 14px; color: var(--muted); }
#task { border-bottom: 1px solid var(--line); padding: 6px 14px; }
#task summary { cursor: pointer; }
#taskText { margin: 6px 0 0; max-height: 24vh; overflow: auto; white-space: pre-wrap; font: 12px/1.45 ui-monospace, Consolas, monospace; color: var(--muted); }
.chat { padding: 12px 14px; height: 56vh; overflow: auto; background: var(--code-bg); display: flex; flex-direction: column; gap: 6px; }
.chat .note { color: var(--muted); font-size: 12px; text-align: center; }
.chat .row { display: grid; grid-template-columns: 70px 1fr; gap: 8px; align-items: baseline; }
.chat .meta { color: var(--muted); font-size: 11px; white-space: nowrap; }
.chat .cmd { font: 12px/1.45 ui-monospace, "Cascadia Code", Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text); opacity: .85; }
.chat .cmd b { color: var(--accent); font-weight: 600; }
.chat .bubble { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 8px 12px; white-space: pre-wrap; overflow-wrap: anywhere; max-width: 92%; }
.chat .answer { border-color: var(--ok); box-shadow: inset 3px 0 0 var(--ok); }
.chat .answer::before { content: "Final answer"; display: block; font-size: 11px; color: var(--ok); margin-bottom: 4px; }
#logHead { padding: 10px 14px; border-bottom: 1px solid var(--line); }
.msg { display: grid; gap: 2px; }
.msg .body { white-space: pre-wrap; overflow-wrap: anywhere; }
#msgs { max-height: 38vh; overflow: auto; }
form { display: flex; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--line); flex-wrap: wrap; }
select, textarea, button { font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; }
textarea { flex: 1 1 260px; min-height: 38px; resize: vertical; }
button { background: var(--accent); color: #fff; border-color: var(--accent); cursor: pointer; }
button:disabled { opacity: .6; cursor: default; }
#sendInfo { width: 100%; color: var(--muted); font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>agent-bridge</h1>
  <span class="status" id="status">connecting\u2026</span>
</header>
<main>
  <div class="col">
    <section><h2>Sessions <span id="peerCount"></span></h2><ul id="peers"></ul></section>
    <section><h2>Delegated runs <span id="runCount"></span></h2><ul id="runs"></ul></section>
  </div>
  <div class="col">
    <section>
      <h2>Run <label class="sub"><input type="checkbox" id="follow" checked> follow</label></h2>
      <div id="logHead" class="sub">Select a run on the left.</div>
      <details id="task"><summary class="sub">Task</summary><pre id="taskText"></pre></details>
      <div id="log" class="chat"></div>
    </section>
    <section>
      <h2>Messages</h2>
      <ul id="msgs"></ul>
      <form id="send">
        <select id="to" aria-label="Recipient"></select>
        <textarea id="body" placeholder="Message to the session (sent as &quot;you&quot;)" aria-label="Message"></textarea>
        <button type="submit" id="sendBtn">Send</button>
        <div id="sendInfo"></div>
      </form>
    </section>
  </div>
</main>
<script>
const POLL_MS = 1500;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const time = (t) => new Date(t).toLocaleTimeString();
const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? s + "s" : s < 3600 ? Math.floor(s / 60) + "m" : Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m"; };
let selected = null, logOffset = 0, version = "", raw = "";

function renderPeers(peers) {
  $("peerCount").textContent = peers.length;
  $("peers").innerHTML = peers.length ? peers.map((p) => {
    const color = p.activity === "busy" ? "var(--busy)" : p.activity === "idle" ? "var(--ok)" : "var(--muted)";
    const old = p.version && p.version !== version ? '<span class="tag old">v' + esc(p.version) + " outdated</span>" : '<span class="tag">v' + esc(p.version ?? "?") + "</span>";
    return '<li><span class="dot" style="background:' + color + '"></span><span class="name">' + esc(p.name) + '</span><span class="tag">' + esc(p.agent) + "</span>" + old +
      '<div class="sub">' + esc(p.activity ?? "unknown") + " \xB7 up " + ago(p.startedAt) + " \xB7 " + esc(p.cwd) + "</div></li>";
  }).join("") : '<li class="empty">No sessions connected.</li>';
  const to = $("to"), current = to.value;
  const names = peers.filter((p) => p.name !== "you").map((p) => p.name);
  to.innerHTML = names.map((n) => "<option>" + esc(n) + "</option>").join("") + '<option value="*">* everyone</option>';
  if ([...names, "*"].includes(current)) to.value = current;
}

function renderRuns(runs) {
  $("runCount").textContent = runs.length;
  if (!selected && runs[0]) select(runs[0].name);
  $("runs").innerHTML = runs.length ? runs.map((r) =>
    '<li class="run' + (r.name === selected ? " sel" : "") + '" data-name="' + esc(r.name) + '">' +
    '<span class="name">' + esc(r.agent) + '</span> <span class="s-' + r.status + '">' + r.status + "</span>" +
    '<span class="sub"> \xB7 ' + time(r.startedAt) + " \xB7 updated " + ago(r.updatedAt) + " ago</span>" +
    '<div class="sub">' + esc(r.last) + "</div></li>").join("") : '<li class="empty">No delegated runs yet.</li>';
  const cur = runs.find((r) => r.name === selected);
  if (cur) $("logHead").innerHTML = '<span class="s-' + cur.status + '">' + cur.status + "</span> \xB7 " + esc(cur.header);
}

function renderMessages(msgs) {
  $("msgs").innerHTML = msgs.length ? msgs.map((m) =>
    '<li class="msg"><div class="sub"><b>' + esc(m.from_name) + "</b> \u2192 " + esc(m.recipients || m.to_target) + " \xB7 " + time(m.created_at) + (m.hop ? " \xB7 hop " + m.hop : "") + "</div>" +
    '<div class="body">' + esc(m.body) + "</div></li>").join("") : '<li class="empty">No messages yet.</li>';
}

async function poll() {
  try {
    const r = await fetch("/api/state");
    if (!r.ok) throw new Error(r.status === 403 ? "not authorized: open the link printed by agent-bridge ui" : "HTTP " + r.status);
    const s = await r.json();
    version = s.version;
    $("status").innerHTML = s.brokerPid
      ? '<span class="dot" style="background:var(--ok)"></span>bridge running \xB7 v' + esc(s.version)
      : '<span class="dot" style="background:var(--warn)"></span>no bridge running (start a session with agent-bridge)';
    renderPeers(s.peers); renderRuns(s.runs); renderMessages(s.messages);
    await pullLog();
  } catch (e) {
    $("status").innerHTML = '<span class="dot" style="background:var(--bad)"></span>' + esc(e.message);
  }
}

let pulling = false;
async function pullLog() {
  // One fetch at a time: overlapping pulls would append the same chunk twice.
  if (!selected || pulling) return;
  pulling = true;
  const run = selected;
  try {
    const r = await fetch("/api/runs/" + encodeURIComponent(run) + "?from=" + logOffset);
    if (!r.ok || run !== selected) return;
    const d = await r.json();
    if (run !== selected) return;
    applyLog(d);
  } finally {
    pulling = false;
  }
}

function applyLog(d) {
  if (d.text) {
    raw += d.text;
    // The log starts with the task (header, prompt, "---"); keep it folded away from the live steps.
    const m = /\\n *---\\n(?=\\d\\d:\\d\\d:\\d\\d started )/.exec(raw);
    const cut = m ? m.index : -1;
    $("taskText").textContent = (cut >= 0 ? raw.slice(0, cut) : raw).replace(/^ {9}/gm, "");
    renderChat(cut >= 0 ? raw.slice(cut + m[0].length) : "");
    if ($("follow").checked) $("log").scrollTop = $("log").scrollHeight;
  }
  logOffset = d.next;
}

/** Log entries: "HH:MM:SS text" plus indented continuation lines. */
function parseEntries(text) {
  const out = [];
  for (const line of text.split("\\n")) {
    const m = /^(\\d\\d:\\d\\d:\\d\\d) (.*)$/.exec(line);
    if (m) out.push({ time: m[1], text: m[2] });
    else if (out.length && line.trim()) out[out.length - 1].text += "\\n" + line.replace(/^ {9}/, "");
  }
  return out;
}

function renderChat(text) {
  const html = parseEntries(text).map((e) => {
    if (e.text.startsWith("answer: ")) return '<div class="bubble answer">' + esc(e.text.slice(8)) + "</div>";
    if (/^(started|still working|finished after)/.test(e.text)) return '<div class="note">' + esc(e.time + " \xB7 " + e.text) + "</div>";
    const parts = e.text.split(" \xB7 ");
    const body = parts.slice(parts[1] && parts[1].startsWith("step ") ? 2 : 1).join(" \xB7 ");
    const meta = esc(e.time) + "<br>" + esc(parts[0]);
    if (body.startsWith("says: ")) return '<div class="row"><span class="meta">' + meta + '</span><div class="bubble">' + esc(body.slice(6)) + "</div></div>";
    const i = body.indexOf(": ");
    const cmd = i > 0 && i < 24 ? "<b>" + esc(body.slice(0, i)) + "</b> " + esc(body.slice(i + 2)) : esc(body);
    return '<div class="row"><span class="meta">' + meta + '</span><div class="cmd">' + cmd + "</div></div>";
  }).join("");
  $("log").innerHTML = html || '<div class="note">Waiting for the first step\u2026</div>';
}

function select(name) {
  selected = name; logOffset = 0; raw = ""; $("log").innerHTML = ""; $("taskText").textContent = "";
  document.querySelectorAll(".run").forEach((el) => el.classList.toggle("sel", el.dataset.name === name));
  pullLog();
}

$("runs").addEventListener("click", (e) => { const li = e.target.closest(".run"); if (li) select(li.dataset.name); });

$("send").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = $("body").value.trim(), to = $("to").value;
  if (!body || !to) return;
  $("sendBtn").disabled = true;
  try {
    const r = await fetch("/api/send", { method: "POST", headers: { "content-type": "application/json", "x-agent-bridge": "1" }, body: JSON.stringify({ to, body }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
    $("sendInfo").textContent = d.deliveredTo?.length ? "Delivered to " + d.deliveredTo.join(", ") : "Queued for " + (d.queuedFor || []).join(", ");
    $("body").value = "";
    poll();
  } catch (err) {
    $("sendInfo").textContent = "Not sent: " + err.message;
  } finally {
    $("sendBtn").disabled = false;
  }
});

poll();
setInterval(poll, POLL_MS);
</script>
</body>
</html>
`;

// src/cli/ui.ts
var UI_HOST = "127.0.0.1";
var COOKIE = "ab_ui";
var SECRET_BYTES2 = 24;
var MAX_RUNS = 40;
var MAX_MESSAGES = 200;
var MAX_LOG_CHUNK = 512 * 1024;
var MAX_POST_BYTES = 256 * 1024;
var STALE_RUN_MS = 15e4;
var UI_PEER_NAME = "you";
var ALLOWED_HOSTS = /* @__PURE__ */ new Set([UI_HOST, "localhost"]);
var RUN_NAME = /^[\w.-]+\.log$/;
function summarizeRun(file, text, mtimeMs, now) {
  const lines = text.split("\n").filter(Boolean);
  const finished = [...lines].reverse().find((l) => / finished after \d+s · /.test(l));
  const last = (finished ?? lines.at(-1) ?? "").replace(/^\d\d:\d\d:\d\d /, "");
  const status = finished ? / · done$/.test(finished) ? "done" : "failed" : now - mtimeMs > STALE_RUN_MS ? "interrupted" : "running";
  const m = /^(\d{4})-(\d\d)-(\d\d)-(\d\d)-(\d\d)-(\d\d)-([a-z]+)-/.exec(file);
  const startedAt = m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : mtimeMs;
  return {
    name: file.replace(/\.log$/, ""),
    agent: m?.[7] ?? "agent",
    header: (lines[0] ?? "").replace(/^\d\d:\d\d:\d\d /, ""),
    startedAt,
    updatedAt: mtimeMs,
    status,
    last
  };
}
function listRuns(home, now = Date.now()) {
  const dir = join10(home, RUNS_DIR_NAME);
  if (!existsSync4(dir)) return [];
  return readdirSync4(dir).filter((f) => RUN_NAME.test(f)).map((f) => ({ f, st: statSync4(join10(dir, f)) })).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs).slice(0, MAX_RUNS).map(({ f, st }) => summarizeRun(f, readFileSync5(join10(dir, f), "utf8"), st.mtimeMs, now));
}
function recentMessages(dbPath) {
  if (!existsSync4(dbPath)) return [];
  const db = new DatabaseSync2(dbPath, { readOnly: true });
  try {
    const stmt = db.prepare(
      `SELECT id, from_name, from_agent, to_target, group_concat(recipient, ', ') AS recipients, body, created_at, hop, reply_to
       FROM messages GROUP BY id ORDER BY created_at DESC LIMIT ?`
    );
    return stmt.all(MAX_MESSAGES);
  } finally {
    db.close();
  }
}
async function brokerPeers(pipe, token, log) {
  let client = null;
  try {
    client = await BridgeClient.connect(pipe, log);
    const { brokerPid } = await client.request("auth", { protocol: PROTOCOL_VERSION, token });
    return { brokerPid, peers: await client.request("peers", {}) };
  } catch {
    return { brokerPid: null, peers: [] };
  } finally {
    client?.close();
  }
}
function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}
async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_POST_BYTES) throw new Error("request too large");
  }
  return JSON.parse(raw || "{}");
}
function cookieSecret(req) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]+)`).exec(String(req.headers.cookie ?? ""));
  return m?.[1] ?? "";
}
async function startUi(opts) {
  const secret = opts.secret ?? randomBytes4(SECRET_BYTES2).toString("hex");
  const token = loadOrCreateToken(opts.home);
  const dbPath = resolveDbPath(opts.home);
  let sender = null;
  const handle = async (req, res) => {
    const host = String(req.headers.host ?? "").replace(/:\d+$/, "");
    if (!ALLOWED_HOSTS.has(host)) return send(res, 403, { error: "forbidden host" });
    const url = new URL(req.url ?? "/", `http://${UI_HOST}`);
    const fromUrl = url.searchParams.get("t");
    if (url.pathname === "/" && fromUrl) {
      if (!tokensEqual(fromUrl, secret)) return send(res, 403, "Invalid or expired link. Restart `agent-bridge ui`.", "text/plain; charset=utf-8");
      res.writeHead(302, { location: "/", "set-cookie": `${COOKIE}=${secret}; HttpOnly; SameSite=Strict; Path=/` });
      return res.end();
    }
    if (!tokensEqual(cookieSecret(req), secret)) return send(res, 403, "Open the link printed by `agent-bridge ui`.", "text/plain; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, UI_PAGE, "text/html; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/api/state") {
      const { brokerPid, peers } = await brokerPeers(opts.pipe, token, opts.log);
      return send(res, 200, {
        version: APP_VERSION,
        brokerPid,
        peers,
        runs: listRuns(opts.home),
        messages: recentMessages(dbPath)
      });
    }
    const runMatch = /^\/api\/runs\/([\w.-]+)$/.exec(url.pathname);
    if (req.method === "GET" && runMatch) {
      const file = join10(opts.home, RUNS_DIR_NAME, `${runMatch[1]}.log`);
      if (!existsSync4(file)) return send(res, 404, { error: "no such run" });
      const from = Math.max(0, Number(url.searchParams.get("from")) || 0);
      const buf = readFileSync5(file);
      const end = Math.min(buf.length, from + MAX_LOG_CHUNK);
      return send(res, 200, { text: buf.subarray(from, end).toString("utf8"), next: end, size: buf.length });
    }
    if (req.method === "POST" && url.pathname === "/api/send") {
      if (req.headers["x-agent-bridge"] !== "1") return send(res, 403, { error: "missing header" });
      const body = await readJson(req);
      const to = String(body.to ?? "").trim();
      const text = String(body.body ?? "").trim();
      if (!to || !text) return send(res, 400, { error: "to and body are required" });
      if (!sender) {
        sender = new BridgeNode({ pipePath: opts.pipe, token, dbPath, agent: "other", name: UI_PEER_NAME, cwd: opts.home, autoWake: false, log: opts.log });
        await sender.start();
      }
      const r = await sender.send({ to, body: text });
      return send(res, 200, { id: r.messages[0]?.id, deliveredTo: r.deliveredTo, queuedFor: r.queuedFor });
    }
    return send(res, 404, { error: "not found" });
  };
  const server = createServer4((req, res) => {
    handle(req, res).catch((err) => {
      opts.log.warn("ui request failed", { err: err.message });
      if (!res.headersSent) send(res, 500, { error: String(err.message) });
    });
  });
  await new Promise((resolve3, reject) => {
    server.once("error", reject);
    server.listen(opts.port, UI_HOST, () => resolve3());
  });
  const { port } = server.address();
  return {
    url: `http://${UI_HOST}:${port}/?t=${secret}`,
    port,
    close: async () => {
      await sender?.stop();
      await new Promise((r) => server.close(() => r()));
    }
  };
}

// src/cli/dashboard.ts
var DASHBOARD_FILE = "dashboard.json";
var SECRET_BYTES3 = 24;
var PROBE_TIMEOUT_MS = 1500;
var OWNER_ONLY2 = 384;
function dashboardFile(home) {
  return join11(home, DASHBOARD_FILE);
}
function readDashboardInfo(home) {
  try {
    const d = JSON.parse(readFileSync6(dashboardFile(home), "utf8"));
    return typeof d.url === "string" && typeof d.port === "number" && typeof d.pid === "number" ? d : null;
  } catch {
    return null;
  }
}
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
function probeDashboard(port) {
  return new Promise((resolve3) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/state", timeout: PROBE_TIMEOUT_MS }, (res) => {
      res.resume();
      resolve3(res.statusCode === 403 || res.statusCode === 200);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve3(false));
    req.end();
  });
}
async function findRunningDashboard(home) {
  const info = readDashboardInfo(home);
  if (!info || !processAlive(info.pid)) return null;
  return await probeDashboard(info.port) ? info : null;
}
async function hostDashboard(opts) {
  const secret = randomBytes5(SECRET_BYTES3).toString("hex");
  const ui = await startUi({ ...opts, secret });
  const info = { url: ui.url, port: ui.port, pid: process.pid };
  const file = dashboardFile(opts.home);
  writeFileSync2(file, JSON.stringify(info, null, 2), { mode: OWNER_ONLY2 });
  try {
    chmodSync2(file, OWNER_ONLY2);
  } catch {
  }
  opts.log.info("dashboard started", { port: ui.port });
  return {
    info,
    close: async () => {
      await ui.close();
      if (readDashboardInfo(opts.home)?.pid === process.pid) rmSync3(file, { force: true });
    }
  };
}

// src/core/config.ts
import { readFileSync as readFileSync7 } from "node:fs";
import { basename, join as join12 } from "node:path";
var DELIVERY_MODES = ["auto", "channel", "hooks"];
var CODEX_SANDBOXES = ["read-only", "workspace-write", "danger-full-access"];
var CLAUDE_PERMISSION_MODES = ["default", "manual", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"];
var DEFAULT_CONFIG = {
  name: null,
  autoWake: false,
  maxHops: DEFAULT_MAX_HOPS,
  delivery: "auto",
  claudeBin: DEFAULT_CLAUDE_BIN,
  codexBin: DEFAULT_CODEX_BIN,
  codexSandbox: "read-only",
  claudePermissionMode: "default",
  lingerSec: DEFAULT_LINGER_SEC,
  codexModel: null,
  claudeModel: null,
  opencodeBin: DEFAULT_OPENCODE_BIN,
  opencodeModel: null,
  opencodeAutoApprove: false,
  dashboard: true,
  dashboardPort: DEFAULT_DASHBOARD_PORT
};
var TRUE_VALUES = /* @__PURE__ */ new Set(["1", "true", "yes", "on"]);
var FALSE_VALUES = /* @__PURE__ */ new Set(["0", "false", "no", "off"]);
function parseBool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v !== "string") return void 0;
  const s = v.trim().toLowerCase();
  if (TRUE_VALUES.has(s)) return true;
  if (FALSE_VALUES.has(s)) return false;
  return void 0;
}
function parseIntInRange(v, min, max) {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : void 0;
}
function oneOf(v, allowed) {
  return typeof v === "string" && allowed.includes(v) ? v : void 0;
}
var MAX_HOPS_LIMIT = 100;
var MAX_LINGER_SEC = 3600;
var MODEL_NAME_PATTERN = /^[^\s"'`&|<>^%$;()]{1,200}$/;
function modelName(v) {
  return typeof v === "string" && MODEL_NAME_PATTERN.test(v.trim()) ? v.trim() : void 0;
}
function loadConfig(home, agent, log, env = process.env) {
  let file = {};
  const path = join12(home, CONFIG_FILE_NAME);
  try {
    file = JSON.parse(readFileSync7(path, "utf8"));
    log.debug("config file loaded", { path });
  } catch (err) {
    if (err.code !== "ENOENT") log.warn("ignoring unreadable config file", { path, err: err.message });
  }
  const section = file[agent] ?? {};
  const pick = (key, envKey, parse) => {
    for (const v of [envKey ? env[envKey] : void 0, section[key], file[key]]) {
      if (v === void 0) continue;
      const parsed = parse(v);
      if (parsed !== void 0) return parsed;
      log.warn("ignoring invalid config value", { key, value: String(v) });
    }
    return void 0;
  };
  const str = (v) => typeof v === "string" && v.trim() ? v.trim() : void 0;
  const d = DEFAULT_CONFIG;
  const cfg = {
    name: pick("name", ENV.name, str) ?? d.name,
    autoWake: pick("autoWake", ENV.autoWake, parseBool) ?? d.autoWake,
    maxHops: pick("maxHops", ENV.maxHops, (v) => parseIntInRange(v, 0, MAX_HOPS_LIMIT)) ?? d.maxHops,
    delivery: pick("delivery", ENV.delivery, (v) => oneOf(v, DELIVERY_MODES)) ?? d.delivery,
    claudeBin: pick("claudeBin", ENV.claudeBin, str) ?? d.claudeBin,
    codexBin: pick("codexBin", ENV.codexBin, str) ?? d.codexBin,
    codexSandbox: pick("codexSandbox", null, (v) => oneOf(v, CODEX_SANDBOXES)) ?? d.codexSandbox,
    claudePermissionMode: pick("claudePermissionMode", null, (v) => oneOf(v, CLAUDE_PERMISSION_MODES)) ?? d.claudePermissionMode,
    lingerSec: pick("lingerSec", ENV.lingerSec, (v) => parseIntInRange(v, 0, MAX_LINGER_SEC)) ?? d.lingerSec,
    codexModel: pick("codexModel", null, modelName) ?? d.codexModel,
    claudeModel: pick("claudeModel", null, modelName) ?? d.claudeModel,
    opencodeBin: pick("opencodeBin", ENV.opencodeBin, str) ?? d.opencodeBin,
    opencodeModel: pick("opencodeModel", null, modelName) ?? d.opencodeModel,
    opencodeAutoApprove: pick("opencodeAutoApprove", null, parseBool) ?? d.opencodeAutoApprove,
    dashboard: pick("dashboard", ENV.dashboard, parseBool) ?? d.dashboard,
    dashboardPort: pick("dashboardPort", null, (v) => parseIntInRange(v, 1, 65535)) ?? d.dashboardPort
  };
  log.debug("effective config", { ...cfg });
  return cfg;
}

// src/cli/open.ts
import { spawn as spawn3 } from "node:child_process";
function openBrowser(url) {
  const [cmd, args] = process.platform === "win32" ? ["cmd.exe", ["/d", "/c", "start", '""', url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    const child = spawn3(cmd, args, { stdio: "ignore", detached: true, windowsHide: true, windowsVerbatimArguments: process.platform === "win32" });
    child.on("error", () => {
    });
    child.unref();
  } catch {
  }
}

// src/cli/reliability.ts
import { execFileSync } from "node:child_process";
import { existsSync as existsSync5, mkdtempSync, rmSync as rmSync4, writeFileSync as writeFileSync3 } from "node:fs";
import { tmpdir } from "node:os";
import { join as join15 } from "node:path";

// src/core/worktree.ts
import { mkdirSync as mkdirSync7 } from "node:fs";
import { basename as basename2, isAbsolute as isAbsolute2, join as join13, relative } from "node:path";
var GIT = "git";
var GIT_TIMEOUT_MS = 6e4;
var BRANCH_PREFIX = "agent-bridge/";
var COMMIT_IDENTITY = ["-c", "user.name=agent-bridge", "-c", "user.email=agent-bridge@localhost"];
var MAX_DIFFSTAT_CHARS = 4e3;
async function git(args, cwd, log) {
  const res = await runProcess({ bin: GIT, args, stdin: "", cwd, timeoutMs: GIT_TIMEOUT_MS, env: process.env, log });
  if (res.code !== 0) throw new Error(`git ${args[0]} failed: ${(res.stderr || res.stdout).trim().slice(0, 500)}`);
  return res.stdout.trimEnd();
}
async function createWorktree(opts) {
  let repoRoot;
  try {
    repoRoot = await git(["rev-parse", "--show-toplevel"], opts.cwd, opts.log);
  } catch {
    throw new Error(`worktree isolation needs a git repository, but ${opts.cwd} is not inside one`);
  }
  const base = await git(["rev-parse", "HEAD"], repoRoot, opts.log);
  const branch = `${BRANCH_PREFIX}${opts.jobId}`;
  const dir = join13(opts.home, "worktrees");
  mkdirSync7(dir, { recursive: true });
  const path = join13(dir, `${basename2(repoRoot)}-${opts.jobId}`);
  await git(["worktree", "add", "-b", branch, path, base], repoRoot, opts.log);
  const rel = relative(repoRoot, opts.cwd);
  const cwd = rel && !rel.startsWith("..") && !isAbsolute2(rel) ? join13(path, rel) : path;
  opts.log.info("worktree created", { repoRoot, path, branch });
  return { repoRoot, path, cwd, branch, base };
}
async function finishWorktree(wt, summary, log) {
  await git(["add", "-A"], wt.path, log);
  const status = await git(["status", "--porcelain"], wt.path, log);
  if (status) {
    const message = `agent-bridge: ${summary.replace(/\s+/g, " ").slice(0, 72)}`;
    await git([...COMMIT_IDENTITY, "commit", "-q", "--no-verify", "-m", message], wt.path, log);
  }
  const diffStat = await git(["diff", "--stat", `${wt.base}..${wt.branch}`], wt.repoRoot, log);
  return { changed: diffStat.length > 0, diffStat: diffStat.slice(0, MAX_DIFFSTAT_CHARS) };
}

// src/core/codex-trust.ts
import { readFileSync as readFileSync8 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join14 } from "node:path";
var PERMISSION_HOOK_STATE_KEY = 'hooks.state."agent-bridge@agent-bridge:plugin.json#hooks[0]:permission_request:0:0"';
function codexHome(env = process.env) {
  return env.CODEX_HOME?.trim() || join14(homedir3(), ".codex");
}
function codexPermissionHookTrusted(home = codexHome(), read = (p) => readFileSync8(p, "utf8")) {
  let text;
  try {
    text = read(join14(home, "config.toml"));
  } catch {
    return false;
  }
  const at = text.indexOf(`[${PERMISSION_HOOK_STATE_KEY}]`);
  if (at < 0) return false;
  const rest = text.slice(at).split(/\r?\n/).slice(1);
  for (const line of rest) {
    if (line.trim().startsWith("[")) break;
    if (/^\s*trusted_hash\s*=\s*"sha256:[0-9a-f]+"/.test(line)) return true;
  }
  return false;
}

// src/core/opencode-served.ts
import { spawn as spawn4 } from "node:child_process";
import { randomBytes as randomBytes6 } from "node:crypto";
import { extname as extname2 } from "node:path";
var SERVE_START_TIMEOUT_MS = 3e4;
var LISTEN_RE = /listening on (https?:\/\/[^\s]+)/i;
var SERVER_USER = "opencode";
var PASSWORD_BYTES = 24;
var MAX_DETAIL_CHARS2 = 4e3;
var ASK_PERMISSIONS = { edit: "ask", bash: "ask" };
var START_WATCHDOG_MS = 6e4;
function startServe(bin, cwd, env) {
  let resolved = resolveBinary(bin, env);
  if (!resolved) return Promise.reject(new DelegateError(`executable not found: ${bin}`, "not_found"));
  let prefix = [];
  if (process.platform === "win32" && [".cmd", ".bat"].includes(extname2(resolved).toLowerCase())) {
    const target = unwrapNpmShim(resolved);
    if (!target) return Promise.reject(new DelegateError(`cannot start ${bin} without a shell`, "failed"));
    resolved = target.command;
    prefix = target.prefix;
  }
  return new Promise((resolve3, reject) => {
    const child = spawn4(resolved, [...prefix, "serve", "--port", "0", "--hostname", "127.0.0.1"], {
      cwd,
      env: { ...env, PWD: cwd },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out2 = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new DelegateError("opencode serve did not start in time", "timeout", out2.slice(-2e3)));
    }, SERVE_START_TIMEOUT_MS);
    const onData = (d) => {
      out2 += d.toString();
      const m = LISTEN_RE.exec(out2);
      if (m) {
        clearTimeout(timer);
        resolve3({ child, url: m[1].replace(/\/+$/, "") });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new DelegateError(`failed to start opencode serve: ${err.message}`, "failed"));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new DelegateError(`opencode serve exited early (code ${code})`, "failed", out2.slice(-2e3)));
    });
  });
}
async function* sse(body) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
      if (!data) continue;
      try {
        yield JSON.parse(data);
      } catch {
      }
    }
  }
}
function permissionDetail(p) {
  const patterns = Array.isArray(p.patterns) ? p.patterns.join(", ") : "";
  const meta = p.metadata && typeof p.metadata === "object" ? p.metadata : {};
  const cmd = typeof meta.command === "string" ? meta.command : typeof meta.filepath === "string" ? meta.filepath : "";
  return (cmd || patterns || JSON.stringify(meta)).slice(0, MAX_DETAIL_CHARS2);
}
async function delegateToOpencodeServed(req) {
  checkDepthPublic();
  const password = randomBytes6(PASSWORD_BYTES).toString("hex");
  const env = childEnvPublic({
    ...req.extraEnv,
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_SERVER_USERNAME: SERVER_USER,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: ASK_PERMISSIONS })
  });
  const { child, url } = await startServe(req.bin, req.cwd, env);
  const auth = `Basic ${Buffer.from(`${SERVER_USER}:${password}`).toString("base64")}`;
  const q = `directory=${encodeURIComponent(req.cwd)}`;
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  req.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => ac.abort(), req.timeoutSec * 1e3);
  const api = async (method, path, body) => {
    const res = await fetch(`${url}${path}${path.includes("?") ? "&" : "?"}${q}`, {
      method,
      headers: { authorization: auth, "content-type": "application/json" },
      body: body === void 0 ? void 0 : JSON.stringify(body),
      signal: ac.signal
    });
    if (!res.ok) throw new DelegateError(`opencode API ${method} ${path} failed: HTTP ${res.status}`, "failed", await res.text().catch(() => ""));
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };
  let knownSession = req.sessionId ?? null;
  try {
    const sessionId = req.sessionId ?? (await api("POST", "/session", {})).id;
    knownSession = sessionId;
    const events = await fetch(`${url}/event?${q}`, { headers: { authorization: auth, accept: "text/event-stream" }, signal: ac.signal });
    if (!events.ok || !events.body) throw new DelegateError(`opencode event stream failed: HTTP ${events.status}`, "failed");
    const [providerID, ...rest] = (req.model ?? "").split("/");
    const body = { parts: [{ type: "text", text: req.prompt }] };
    if (req.model && rest.length) body.model = { providerID, modelID: rest.join("/") };
    await api("POST", `/session/${sessionId}/prompt_async`, body);
    let failure = null;
    const onEvent = progressEventHandler("opencode", req.onProgress);
    let alive = false;
    const watchdog = setTimeout(() => {
      if (alive) return;
      failure = "opencode did not start working on the prompt within 60 seconds (check the model id and the provider's login).";
      ac.abort();
    }, START_WATCHDOG_MS);
    try {
      for await (const ev of sse(events.body)) {
        const type = String(ev.type ?? "");
        const p = ev.properties ?? {};
        const mine = p.sessionID === sessionId || p.part?.sessionID === sessionId || p.info?.sessionID === sessionId;
        if (mine) alive = true;
        if (type === "session.error" && !p.sessionID) {
          failure = String(p.error?.data?.message ?? p.error?.message ?? "opencode reported an error");
          break;
        }
        if (type === "permission.asked" && p.sessionID === sessionId) {
          const decision = await req.onPermission({ agent: "opencode", tool: String(p.permission ?? "unknown"), detail: permissionDetail(p), cwd: req.cwd });
          await api("POST", `/permission/${p.id}/reply`, decision.allow ? { reply: "once" } : { reply: "reject", message: decision.message });
        } else if (type === "message.part.updated" && p.part?.sessionID === sessionId) {
          const part = p.part;
          const ready = part.type === "tool" && (part.state?.status === "running" || part.state?.status === "completed") || part.type === "text" && part.time?.end || part.type === "reasoning" && part.time?.end;
          if (ready) onEvent?.({ part });
        } else if (type === "session.error" && p.sessionID === sessionId) {
          failure = String(p.error?.data?.message ?? p.error?.message ?? "opencode session error");
          break;
        } else if (type === "session.idle" && p.sessionID === sessionId || type === "session.status" && p.sessionID === sessionId && p.status?.type === "idle") {
          break;
        }
      }
    } catch (err) {
      if (!failure) throw err;
    } finally {
      clearTimeout(watchdog);
    }
    if (failure && !alive) throw new DelegateError(failure, "failed", "", "", sessionId);
    const messages = await api("GET", `/session/${sessionId}/message`) ?? [];
    const last = [...messages].reverse().find((m) => m.info?.role === "assistant");
    const text = (last?.parts ?? []).filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("");
    if (failure && !text) throw new DelegateError(failure, "failed", "", "", sessionId);
    const tokens = last?.info?.tokens;
    return {
      sessionId,
      text,
      isError: failure !== null,
      details: {
        error: failure,
        usage: tokens ? { input: Number(tokens.input) || 0, output: Number(tokens.output) || 0 } : null,
        costUsd: typeof last?.info?.cost === "number" ? last.info.cost : null
      }
    };
  } catch (err) {
    if (ac.signal.aborted && !(err instanceof DelegateError)) {
      if (req.signal?.aborted) throw new DelegateError("delegate aborted", "aborted", "", "", knownSession);
      const hint = knownSession ? `. The opencode session ${knownSession} keeps its progress: call again with session_id="${knownSession}" (and a longer timeout_sec, or use spawn_opencode) to continue instead of starting over.` : "";
      throw new DelegateError(`delegate timed out after ${req.timeoutSec}s${hint}`, "timeout", "", "", knownSession);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener("abort", onAbort);
    ac.abort();
    child.kill();
  }
}

// src/cli/reliability.ts
var RUN_TIMEOUT_SEC = 300;
var REPEATS = 3;
var CANCEL_AFTER_MS = 8e3;
var CANCEL_GRACE_MS = 1e4;
var BINS = { claude: DEFAULT_CLAUDE_BIN, codex: DEFAULT_CODEX_BIN, opencode: DEFAULT_OPENCODE_BIN };
function run(agent, prompt, cwd, access, log, signal) {
  const base = { prompt, cwd, sessionId: null, timeoutSec: RUN_TIMEOUT_SEC, log, signal };
  if (agent === "codex") return delegateToCodex({ ...base, bin: BINS.codex, sandbox: access === "edit" ? "workspace-write" : "read-only" });
  if (agent === "claude") return delegateToClaude({ ...base, bin: BINS.claude, permissionMode: access === "edit" ? "acceptEdits" : "default" });
  return delegateToOpencode({ ...base, bin: BINS.opencode, autoApprove: access === "edit" });
}
async function runAsk(agent, prompt, cwd, decide, log) {
  const base = { prompt, cwd, sessionId: null, timeoutSec: RUN_TIMEOUT_SEC, log };
  if (agent === "opencode") return delegateToOpencodeServed({ ...base, bin: BINS.opencode, onPermission: decide });
  if (agent === "codex") {
    if (!codexPermissionHookTrusted()) return null;
    const relay = new PermissionRelay(decide, log);
    await relay.start();
    try {
      return await delegateToCodex({ ...base, bin: BINS.codex, sandbox: "read-only", relayApprovals: true, extraEnv: relay.childEnv() });
    } finally {
      await relay.stop();
    }
  }
  return null;
}
async function timed(name, fn) {
  const start = Date.now();
  try {
    const r = await fn();
    return { name, ...r, ms: Date.now() - start };
  } catch (err) {
    return { name, pass: false, detail: String(err?.message ?? err).slice(0, 160), ms: Date.now() - start };
  }
}
function makeRepo() {
  const dir = mkdtempSync(join15(tmpdir(), "agent-bridge-rel-"));
  const git2 = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  git2("init", "-q");
  writeFileSync3(join15(dir, "README.md"), "reliability sandbox\n");
  git2("add", "README.md");
  git2("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
  return dir;
}
async function runReliability(opts) {
  const agents = opts.agents.filter((a) => resolveBinary(BINS[a]));
  const home = mkdtempSync(join15(tmpdir(), "agent-bridge-rel-home-"));
  const results = [];
  const record = (o) => {
    results.push(o);
    opts.out(`  ${o.pass ? "PASS" : "FAIL"}  ${o.name}  (${(o.ms / 1e3).toFixed(1)}s)  ${o.detail}`);
  };
  const repos = [];
  const repo = () => {
    const r = makeRepo();
    repos.push(r);
    return r;
  };
  try {
    for (const agent of agents) {
      opts.out(`${agent}:`);
      for (let i = 1; i <= REPEATS; i++) {
        const n = 10 + i;
        record(
          await timed(`${agent} answer #${i}`, async () => {
            const r = await run(agent, `Reply with only the number ${n * n}. That is ${n} squared.`, repo(), "read", opts.log);
            return { pass: r.text.includes(String(n * n)) && Boolean(r.sessionId), detail: `"${r.text.trim().slice(0, 40)}"` };
          })
        );
      }
      record(
        await timed(`${agent} read-only is enforced`, async () => {
          const dir = repo();
          await run(agent, "Create a file named should-not-exist.txt containing the word hi. Then reply done.", dir, "read", opts.log);
          const exists = existsSync5(join15(dir, "should-not-exist.txt"));
          return { pass: !exists, detail: exists ? "the file WAS created despite read-only access" : "no file created" };
        })
      );
      record(
        await timed(`${agent} edit in worktree`, async () => {
          const dir = repo();
          const wt = await createWorktree({ cwd: dir, home, jobId: `${agent}-${Date.now().toString(36)}`, log: opts.log });
          const steps = [];
          const base = { prompt: "Create a file named created.txt containing the word hello. Then reply done.", cwd: wt.cwd, sessionId: null, timeoutSec: RUN_TIMEOUT_SEC, log: opts.log, onProgress: (m) => steps.push(m) };
          const r = agent === "codex" ? await delegateToCodex({ ...base, bin: BINS.codex, sandbox: "workspace-write" }) : agent === "claude" ? await delegateToClaude({ ...base, bin: BINS.claude, permissionMode: "acceptEdits" }) : await delegateToOpencode({ ...base, bin: BINS.opencode, autoApprove: true });
          const outcome = await finishWorktree(wt, "reliability edit", opts.log);
          const leaked = existsSync5(join15(dir, "created.txt"));
          const pass = outcome.diffStat.includes("created.txt") && !leaked;
          return {
            pass,
            detail: leaked ? "file leaked into the working copy" : pass ? "created.txt committed on the worktree branch" : `no created.txt; steps: [${steps.join(" | ")}]; answer: "${r.text.trim().slice(0, 80)}"; diff: ${outcome.diffStat.split("\n").pop() ?? ""}`
          };
        })
      );
    }
    for (const agent of agents) {
      for (const allow of [false, true]) {
        const label = `${agent} ask -> ${allow ? "allow" : "deny"}`;
        const dir = repo();
        const asked = [];
        const outcome = await timed(label, async () => {
          const r = await runAsk(
            agent,
            "Create a file named asked.txt containing the word hi. Then reply done.",
            dir,
            async (req) => {
              asked.push(`${req.tool}: ${req.detail.slice(0, 60)}`);
              return allow ? { allow: true } : { allow: false, message: "Denied by the reliability test." };
            },
            opts.log
          );
          if (r === null) return { pass: true, detail: "SKIP (not available: see README, permission requests)" };
          const exists = existsSync5(join15(dir, "asked.txt"));
          return {
            pass: asked.length > 0 && exists === allow,
            detail: `asked ${asked.length}x [${asked.join(" | ")}], file ${exists ? "created" : "not created"}`
          };
        });
        record(outcome);
      }
    }
    if (agents.length > 1) {
      opts.out("parallel:");
      record(
        await timed(`parallel (${agents.join(", ")})`, async () => {
          const rs = await Promise.all(agents.map((a, i) => run(a, `Reply with only the word parallel${i}.`, repo(), "read", opts.log)));
          const ok = rs.map((r, i) => r.text.includes(`parallel${i}`));
          return { pass: ok.every(Boolean), detail: agents.map((a, i) => `${a}:${ok[i] ? "ok" : "bad"}`).join(" ") };
        })
      );
    }
    if (agents.includes("codex")) {
      opts.out("cancel:");
      record(
        await timed("codex cancel", async () => {
          const ac = new AbortController();
          const started = Date.now();
          setTimeout(() => ac.abort(), CANCEL_AFTER_MS);
          const p = run("codex", "Count slowly from 1 to 400, one number per line, thinking about each number.", repo(), "read", opts.log, ac.signal);
          const r = await p.then(
            () => "finished",
            (e) => String(e.message)
          );
          const took = Date.now() - started;
          return { pass: r.includes("aborted") && took < CANCEL_AFTER_MS + CANCEL_GRACE_MS, detail: `${r}, stopped after ${(took / 1e3).toFixed(1)}s` };
        })
      );
    }
  } finally {
    for (const r of repos) rmSync4(r, { recursive: true, force: true, maxRetries: 3 });
    rmSync4(home, { recursive: true, force: true, maxRetries: 3 });
  }
  const passed = results.filter((r) => r.pass).length;
  opts.out(`
${passed}/${results.length} passed`);
  return passed === results.length ? 0 : 1;
}

// src/cli/smoke.ts
import { mkdtempSync as mkdtempSync2, rmSync as rmSync5 } from "node:fs";
import { tmpdir as tmpdir2 } from "node:os";
import { join as join16 } from "node:path";
var TESTED_VERSIONS = {
  claude: "2.1.283",
  codex: "0.157.1",
  opencode: "1.18.32"
};
var SMOKE_TIMEOUT_SEC = 180;
var VERSION_TIMEOUT_MS = 3e4;
var EXPECTED = "AGENT_BRIDGE_OK";
var PROMPT = `Reply with exactly ${EXPECTED} and nothing else.`;
var RESUME_PROMPT = "What did you reply last time? Reply with exactly that word and nothing else.";
async function version(bin, log) {
  try {
    const res = await runProcess({ bin, args: ["--version"], stdin: "", cwd: process.cwd(), timeoutMs: VERSION_TIMEOUT_MS, env: process.env, log });
    return /\d+\.\d+\.\d+/.exec(res.stdout)?.[0] ?? "unknown";
  } catch {
    return "unknown";
  }
}
async function runSmoke(opts) {
  const dir = mkdtempSync2(join16(tmpdir2(), "agent-bridge-smoke-"));
  const bins = { claude: DEFAULT_CLAUDE_BIN, codex: DEFAULT_CODEX_BIN, opencode: DEFAULT_OPENCODE_BIN };
  let failures = 0;
  try {
    for (const agent of opts.agents) {
      const bin = bins[agent];
      if (!resolveBinary(bin)) {
        opts.out(t("smoke.missing", { agent }));
        continue;
      }
      const v = await version(bin, opts.log);
      const note = v === TESTED_VERSIONS[agent] ? "" : t("smoke.untested", { tested: TESTED_VERSIONS[agent] });
      opts.out(t("smoke.start", { agent, version: v, note }));
      const run2 = (prompt, sessionId) => {
        const base = { prompt, cwd: dir, sessionId, timeoutSec: SMOKE_TIMEOUT_SEC, log: opts.log };
        if (agent === "codex") return delegateToCodex({ ...base, bin, sandbox: "read-only" });
        if (agent === "claude") return delegateToClaude({ ...base, bin, permissionMode: "plan" });
        return delegateToOpencode({ ...base, bin, autoApprove: false });
      };
      try {
        const first = await run2(PROMPT, null);
        const okAnswer = first.text.includes(EXPECTED);
        const okSession = Boolean(first.sessionId);
        const second = okSession ? await run2(RESUME_PROMPT, first.sessionId) : null;
        const okResume = Boolean(second?.text.includes(EXPECTED));
        const passed = okAnswer && okSession && okResume;
        if (!passed) failures++;
        opts.out(
          t(passed ? "smoke.pass" : "smoke.fail", {
            agent,
            answer: okAnswer ? "ok" : `unexpected "${first.text.slice(0, 60)}"`,
            session: okSession ? "ok" : "missing",
            resume: okResume ? "ok" : second ? `unexpected "${second.text.slice(0, 60)}"` : "skipped"
          })
        );
      } catch (err) {
        failures++;
        opts.out(t("smoke.error", { agent, detail: String(err?.message ?? err) }));
      }
    }
  } finally {
    rmSync5(dir, { recursive: true, force: true });
  }
  return failures ? 1 : 0;
}

// src/cli/main.ts
var CLI_PEER_NAME = "cli";
var out = (s) => process.stdout.write(s + "\n");
function printResult(res) {
  for (const f of res.files) out(`  ${f}`);
  for (const f of res.skipped) out(t("cli.install.skipped", { path: f }));
}
async function main(argv) {
  const [command = "help", ...rest] = argv;
  const home = resolveHome();
  const pipe = resolvePipePath(home);
  const log = createLogger({ home, component: "cli" });
  const makeNode = () => new BridgeNode({ pipePath: pipe, token: loadOrCreateToken(home), dbPath: resolveDbPath(home), agent: "other", name: CLI_PEER_NAME, cwd: process.cwd(), autoWake: false, log });
  switch (command) {
    case "status": {
      let client;
      try {
        client = await BridgeClient.connect(pipe, log);
      } catch {
        out(t("cli.status.noBroker", { pipe }));
        return 0;
      }
      try {
        const ping = await client.request("ping", {});
        await client.request("auth", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(home) });
        const peers = await client.request("peers", {});
        out(t("cli.status.broker", { pid: String(ping.brokerPid), protocol: String(ping.protocol), pipe }));
        out(t("cli.status.peers", { count: peers.length }));
        const isOld = (v) => !v || v !== APP_VERSION;
        for (const p of peers) {
          out(t("cli.status.peer", { name: p.name, agent: p.agent, activity: p.activity ?? "unknown", version: p.version ?? "?", outdated: isOld(p.version) ? t("cli.status.outdatedMark") : "", since: formatDateTime(p.startedAt), cwd: p.cwd }));
        }
        const old = peers.filter((p) => isOld(p.version)).length;
        if (peers.length) out(old ? t("cli.status.outdated", { count: old, version: APP_VERSION }) : t("cli.status.upToDate", { version: APP_VERSION }));
      } finally {
        client.close();
      }
      return 0;
    }
    case "send": {
      const [to, ...words] = rest;
      if (!to || words.length === 0) {
        out(t("cli.usage"));
        return 2;
      }
      const node = makeNode();
      try {
        await node.start();
        const res = await node.send({ to, body: words.join(" ") });
        out(t("cli.sent", { id: res.messages[0].id }));
      } finally {
        await node.stop();
      }
      return 0;
    }
    case "tail": {
      const node = makeNode();
      node.on("message", (m) => {
        out(formatMessage(m));
        node.markRead([m.id]);
      });
      await node.start();
      out(t("cli.tail.listening", { name: node.name }));
      await new Promise((resolve3) => process.once("SIGINT", resolve3));
      await node.stop();
      return 0;
    }
    case "install":
    case "update":
    case "uninstall":
      return runInstaller({ action: command, tools: parseInstallerArgs(command, rest), yes: rest.includes("--yes") || rest.includes("-y"), out });
    case "ui": {
      const noOpen = rest.includes("--no-open");
      const running = await findRunningDashboard(home);
      if (running) {
        out(t("cli.ui.existing", { url: running.url }));
        if (!noOpen) openBrowser(running.url);
        return 0;
      }
      const portArg = rest.find((a) => a.startsWith("--port="))?.slice("--port=".length);
      const port = portArg ? Number(portArg) : loadConfig(home, "other", log).dashboardPort;
      const hosted = await hostDashboard({ home, pipe, port, log });
      out(t("cli.ui.running", { url: hosted.info.url }));
      if (!noOpen) openBrowser(hosted.info.url);
      await new Promise((resolve3) => process.once("SIGINT", resolve3));
      await hosted.close();
      return 0;
    }
    case "watch": {
      const logPath = findRunLog(home, rest[0]);
      if (!logPath) {
        out(t("cli.watch.none"));
        return 1;
      }
      out(t("cli.watch.following", { path: logPath }));
      await watchRunLog(logPath, out);
      return 0;
    }
    case "rewake-hook":
      return runRewakeHook();
    case "permission-hook":
      return runPermissionHook();
    case "reliability": {
      const picked = rest.filter((a) => CODING_AGENTS.includes(a));
      return runReliability({ agents: picked.length ? picked : [...CODING_AGENTS], out, log });
    }
    case "smoke": {
      const picked = rest.filter((a) => CODING_AGENTS.includes(a));
      return runSmoke({ agents: picked.length ? picked : [...CODING_AGENTS], out, log });
    }
    case "install-opencode": {
      const source = opencodeSourceDir();
      if (!source) {
        out(t("cli.opencode.noSource"));
        return 1;
      }
      const res = installOpencode(source);
      out(t("cli.opencode.installed", { dir: res.configDir }));
      printResult(res);
      out(t("cli.opencode.restart"));
      return 0;
    }
    case "uninstall-opencode": {
      const res = uninstallOpencode();
      out(res.files.length ? t("cli.opencode.removed", { dir: res.configDir }) : t("cli.opencode.nothing", { dir: res.configDir }));
      printResult(res);
      return 0;
    }
    case "paths":
      out(t("cli.paths", { home, logs: join17(home, LOG_DIR_NAME), db: resolveDbPath(home), pipe }));
      return 0;
    case "help":
    case "--help":
    case "-h":
      out(t("cli.usage"));
      return 0;
    default:
      out(t("cli.unknownCommand", { command }));
      out(t("cli.usage"));
      return 2;
  }
}
main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(t("cli.error", { detail: String(err?.message ?? err) }) + "\n");
    process.exit(1);
  }
);
