#!/usr/bin/env node
import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);

// src/cli/main.ts
import { join as join5 } from "node:path";

// src/core/client.ts
import { EventEmitter } from "node:events";
import { connect } from "node:net";

// src/core/constants.ts
import { homedir } from "node:os";
import { join } from "node:path";
var APP_NAME = "agent-bridge";
var APP_VERSION = "0.3.0";
var PROTOCOL_VERSION = 1;
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
  opencodeBin: "AGENT_BRIDGE_OPENCODE_BIN"
};
var DEFAULT_HOME = join(homedir(), `.${APP_NAME}`);
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

// src/core/protocol.ts
var AGENT_KINDS = ["claude", "codex", "opencode", "other"];
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
  "peers.job": "- {name} (model: {model}, running {seconds}s): {progress}",
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
  "cli.usage": 'Usage: agent-bridge <command>\n\nCommands:\n  status              Show the broker and the connected peers\n  send <to> <text>    Send a message as the "cli" peer\n  tail                Print messages addressed to "cli" as they arrive\n  install-opencode        Install the opencode plugin and its @claude/@codex subagents\n  uninstall-opencode      Remove them again\n  paths                   Show data, log and pipe locations\n  help                    Show this help',
  "cli.opencode.noSource": "Could not find the opencode plugin files next to this CLI. Run it from an agent-bridge checkout or package.",
  "cli.opencode.installed": "Installed the agent-bridge opencode plugin into {dir}:",
  "cli.opencode.restart": "Restart opencode to load it. Requires Node.js 22.13+ on PATH.",
  "cli.opencode.removed": "Removed the agent-bridge opencode plugin from {dir}:",
  "cli.opencode.nothing": "The agent-bridge opencode plugin is not installed in {dir}.",
  "cli.install.skipped": "  skipped (exists and was not created by agent-bridge): {path}",
  "cli.status.broker": "Broker: running (pid {pid}, protocol {protocol}) at {pipe}",
  "cli.status.noBroker": "Broker: not running (no agent with agent-bridge is active). Endpoint: {pipe}",
  "cli.status.peers": "Peers online: {count}",
  "cli.status.peer": "  {name}  [{agent}, {activity}]  since {since}  {cwd}",
  "cli.sent": "Sent message {id}.",
  "cli.tail.listening": 'Listening as "{name}". Press Ctrl+C to stop.',
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

// src/core/broker.ts
var PEER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
var PENDING_DEFAULT_LIMIT = 50;
var PENDING_MAX_LIMIT = 500;
var NAME_SUFFIX_LIMIT = 100;
var Broker = class {
  constructor(pipePath, store, log, now = Date.now) {
    this.pipePath = pipePath;
    this.store = store;
    this.log = log;
    this.now = now;
    this.handlers = {
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
    const conn = { socket, peer: null };
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
  onHello(conn, args) {
    if (args.protocol !== PROTOCOL_VERSION) {
      throw new BridgeError("protocol_mismatch", `broker speaks protocol ${PROTOCOL_VERSION}, client ${args.protocol}`, {
        brokerProtocol: PROTOCOL_VERSION
      });
    }
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
    const broker = new Broker(this.opts.pipePath, store, this.log.child("broker"));
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
    const hello = await client.request("hello", {
      protocol: PROTOCOL_VERSION,
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
    });
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
      return res;
    });
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
import { join as join3, posix, resolve } from "node:path";
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
  return join3(home, DB_FILE_NAME);
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

// src/cli/opencode-install.ts
import { copyFileSync, existsSync, mkdirSync as mkdirSync3, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { dirname as dirname2, join as join4, resolve as resolve2 } from "node:path";
import { fileURLToPath } from "node:url";
var INSTALL_MARKER = "agent-bridge";
var PLUGIN_FILE = "agent-bridge.js";
var SERVER_DIR = "agent-bridge";
var SERVER_FILE = "server.mjs";
var SKILL_REL = join4("skills", "agent-bridge", "SKILL.md");
var AGENTS_DIR = "agents";
function opencodeConfigDir(env = process.env) {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return join4(xdg || join4(homedir2(), ".config"), "opencode");
}
function pluginSourceDir(name, marker, fromFile = fileURLToPath(import.meta.url)) {
  let dir = dirname2(fromFile);
  for (let i = 0; i < 5; i++) {
    for (const candidate of [join4(dir, "plugins", name), join4(dir, "..", name)]) {
      if (existsSync(join4(candidate, marker))) return resolve2(candidate);
    }
    dir = dirname2(dir);
  }
  return null;
}
var opencodeSourceDir = (from) => pluginSourceDir("opencode", join4("dist", PLUGIN_FILE), from);
function ownedByUs(path) {
  try {
    return readFileSync(path, "utf8").includes(INSTALL_MARKER);
  } catch {
    return false;
  }
}
function copyAll(copies, configDir) {
  const res = { configDir, files: [], skipped: [] };
  for (const [from, to] of copies) {
    if (!existsSync(from)) throw new Error(`missing build output: ${from} (run npm run build)`);
    if (existsSync(to) && !ownedByUs(to)) {
      res.skipped.push(to);
      continue;
    }
    mkdirSync3(dirname2(to), { recursive: true });
    copyFileSync(from, to);
    res.files.push(to);
  }
  return res;
}
function agentCopies(sourceDir, targetDir) {
  const dir = join4(sourceDir, AGENTS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((f) => [join4(dir, f), join4(targetDir, AGENTS_DIR, f)]);
}
function installOpencode(sourceDir, configDir = opencodeConfigDir()) {
  return copyAll(
    [
      [join4(sourceDir, "dist", PLUGIN_FILE), join4(configDir, "plugins", PLUGIN_FILE)],
      [join4(sourceDir, "dist", SERVER_FILE), join4(configDir, "plugins", SERVER_DIR, SERVER_FILE)],
      [join4(sourceDir, SKILL_REL), join4(configDir, SKILL_REL)],
      ...agentCopies(sourceDir, configDir)
    ],
    configDir
  );
}
function uninstallOpencode(configDir = opencodeConfigDir(), sourceDir = opencodeSourceDir()) {
  const targets = [join4(configDir, "plugins", PLUGIN_FILE), join4(configDir, "plugins", SERVER_DIR), join4(configDir, "skills", "agent-bridge")];
  if (sourceDir) targets.push(...agentCopies(sourceDir, configDir).map(([, to]) => to));
  return removeOwned(targets, configDir);
}
function removeOwned(targets, configDir) {
  const res = { configDir, files: [], skipped: [] };
  for (const p of targets) {
    if (!existsSync(p)) continue;
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
  const makeNode = () => new BridgeNode({ pipePath: pipe, dbPath: resolveDbPath(home), agent: "other", name: CLI_PEER_NAME, cwd: process.cwd(), autoWake: false, log });
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
        const peers = await client.request("peers", {});
        out(t("cli.status.broker", { pid: String(ping.brokerPid), protocol: String(ping.protocol), pipe }));
        out(t("cli.status.peers", { count: peers.length }));
        for (const p of peers) out(t("cli.status.peer", { name: p.name, agent: p.agent, activity: p.activity ?? "unknown", since: formatDateTime(p.startedAt), cwd: p.cwd }));
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
      out(t("cli.paths", { home, logs: join5(home, LOG_DIR_NAME), db: resolveDbPath(home), pipe }));
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
